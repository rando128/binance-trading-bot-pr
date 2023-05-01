/* eslint-disable prefer-destructuring */
const _ = require('lodash');
const moment = require('moment');
const { cache, mongo } = require('../../../helpers');
const { getLastBuyPrice } = require('../../trailingTradeHelper/common');

/**
 * Flatten candle data
 *
 * @param {*} candles
 */
const flattenCandlesData = candles => {
  const openTime = [];
  const high = [];
  const low = [];
  const close = [];

  candles.forEach(candle => {
    openTime.push(+candle.openTime);
    high.push(+candle.high);
    low.push(+candle.low);
    close.push(+candle.close);
  });

  return {
    openTime,
    high,
    low,
    close
  };
};

/**
 * Determine the grid state for nextBestBuyAmount calculation
 * - isSingleSellGrid
 * - hasObviousManualTrade
 *
 */
const nextBestBuyAmountCalculationConditions = data => {
  const {
    symbolConfiguration: {
      buy: {
        currentGridTradeIndex: currentBuyGridTradeIndex,
        gridTrade: buyGridTrade
      },
      sell: {
        currentGridTradeIndex: currentSellGridTradeIndex,
        gridTrade: sellGridTrade
      }
    }
  } = data;

  // Find the first non-executed trade.
  //    -1 means all buy trades are executed.
  //    0 or more means the index of trades for first non-executed trade.
  const firstNonExecutedTradeIndex = buyGridTrade.findIndex(
    trade => trade.executed === false
  );
  // Find the first executed trade.
  //    -1 means no buy trade is executed.
  //    0 or more means the index of trades for first executed trade.
  const firstExecutedTradeIndex = buyGridTrade.findIndex(
    trade => trade.executed === true
  );
  const hasObviousManualTrade =
    // If there is non-executed trade and does not have executed trade
    (firstNonExecutedTradeIndex !== -1 && firstExecutedTradeIndex === -1) ||
    // Or there is non-executed trade and the non-executed trade index is lower than the executed trade index
    // or the index of current buy grid trade.
    // It usually happens when the last buy price is set manually.
    (firstNonExecutedTradeIndex !== -1 &&
      firstNonExecutedTradeIndex < firstExecutedTradeIndex) ||
    (firstNonExecutedTradeIndex !== -1 &&
      firstNonExecutedTradeIndex < currentBuyGridTradeIndex);

  // Check whether it's a single sell grid trade and whether it's executed.
  const isSingleSellGrid =
    currentSellGridTradeIndex >= 0 && sellGridTrade.length === 1;

  // Return true if there is no manual trade and it has executed single sell grid trade.
  // Store the manual trade and single trade status for the frontend
  return {
    hasObviousManualTrade,
    isSingleSellGrid
  };
};

/**
 * Calculate nextBestBuyAmount
 *
 * @param {*} currentPrice
 * @param {*} lastBuyPrice
 * @param {*} sellTrigger
 */
const calculateNextBestBuyAmount = (
  data,
  { currentPrice, lastBuyPrice, sellTrigger }
) => {
  const {
    symbolConfiguration: {
      buy: { gridTrade: buyGridTrade }
    }
  } = data;

  const { hasObviousManualTrade, isSingleSellGrid } =
    nextBestBuyAmountCalculationConditions(data);

  const totalBought = buyGridTrade
    .filter(trade => trade.executed)
    .map(order => ({
      cummulativeQuoteQty: parseFloat(order.executedOrder.cummulativeQuoteQty),
      executedQty: parseFloat(order.executedOrder.executedQty)
    }))
    .reduce(
      (acc, o) => {
        acc.amount += o.cummulativeQuoteQty;
        acc.qty += o.executedQty;
        return acc;
      },
      {
        amount: 0,
        qty: 0
      }
    );

  const buyTrigger = 1 + (currentPrice - lastBuyPrice) / lastBuyPrice;

  let amount = null;

  if (!hasObviousManualTrade && isSingleSellGrid) {
    amount =
      (totalBought.amount -
        totalBought.qty * buyTrigger * lastBuyPrice * sellTrigger) /
      (sellTrigger - 1);
  }

  const calculation = {
    currentPrice,
    lastBuyPrice,
    totalBoughtAmount: totalBought.amount,
    totalBoughtQty: totalBought.qty,
    buyTrigger,
    sellTrigger,
    hasObviousManualTrade,
    isSingleSellGrid
  };

  return { amount, calculation };
};

const applyConservativeSell = (
  _data,
  { conservativeFactor, sellTriggerPercentage, buyGridTradeDepth }
) => 1 + (sellTriggerPercentage - 1) * conservativeFactor ** buyGridTradeDepth;

/**
 * Compute Heikin ashi candles
 * @param {*} candles
 */
const getHeikinAshiCandles = ohlc => {
  const heikinAshi = [];
  for (let i = 0; i < ohlc.length; i += 1) {
    const candle = ohlc[i];
    const ha = {
      openTime: candle.openTime,
      open: 0,
      high: candle.high,
      low: candle.low,
      close: 0
    };

    if (i === 0) {
      ha.open = (candle.open + candle.close) / 2;
      ha.close = (candle.open + candle.high + candle.low + candle.close) / 4;
    } else {
      ha.open = (heikinAshi[i - 1].open + heikinAshi[i - 1].close) / 2;
      ha.close = (candle.open + candle.high + candle.low + candle.close) / 4;
    }

    heikinAshi.push(ha);
  }

  return heikinAshi;
}

/**
 * Determine Kagi trend line
 * @param {*} candles
 */
const getKagiTrend = (candles, period) => {

  const ohlc = candles.slice(-period);

  // Compute the True Range for each candle of the array
  const trueRange = [];
  for (let i = 0; i < ohlc.length; i += 1) {
    const candle = ohlc[i];
    let ntr = 0;

    if (i ===0) {
      ntr = Math.max(
        candle.high - candle.low,
        candle.high - candle.close,
        candle.close - candle.low
      );
    } else {
      ntr = Math.max(
        candle.high - candle.low,
        candle.high - ohlc[i - 1].close,
        ohlc[i - 1].close - candle.low
      );
    }
    trueRange.push(ntr);
  }

  // Compute SMA average of the True Range over the period
  let sum = 0;
  for (let i = 0; i < trueRange.length; i += 1) {
    sum += trueRange[i];
  }
  const atr = sum/trueRange.length;

  // Determine trend over the period
  let trend = ohlc[1].close > ohlc[0].close ? 1 : -1;
  let highestClose = trend > 0 ? ohlc[1].close : ohlc[0].close;
  let lowestClose = trend < 0 ? ohlc[1].close : ohlc[0].close;

  for (let i = 1; i < ohlc.length; i += 1) {

    if (trend === 1) {
      highestClose =
        ohlc[i].close > highestClose ? ohlc[i].close : highestClose;
      if (ohlc[i].close < highestClose - atr) trend = -1;
    }

    if (trend === -1) {
      lowestClose = ohlc[i].close < lowestClose ? ohlc[i].close : lowestClose;

      if (ohlc[i].close > lowestClose + atr) trend = 1;
    }
  }

  return trend * atr;
};

/**
 * Determine the grid state for nextBestBuyAmount calculation
 * - isSingleSellGrid
 * - hasObviousManualTrade
 *
 */
const nextBestBuyAmountCalculationConditions = data => {
  const {
    symbolConfiguration: {
      buy: {
        currentGridTradeIndex: currentBuyGridTradeIndex,
        gridTrade: buyGridTrade
      },
      sell: {
        currentGridTradeIndex: currentSellGridTradeIndex,
        gridTrade: sellGridTrade
      }
    }
  } = data;

  // Find the first non-executed trade.
  //    -1 means all buy trades are executed.
  //    0 or more means the index of trades for first non-executed trade.
  const firstNonExecutedTradeIndex = buyGridTrade.findIndex(
    trade => trade.executed === false
  );
  // Find the first executed trade.
  //    -1 means no buy trade is executed.
  //    0 or more means the index of trades for first executed trade.
  const firstExecutedTradeIndex = buyGridTrade.findIndex(
    trade => trade.executed === true
  );
  const hasObviousManualTrade =
    // If there is non-executed trade and does not have executed trade
    (firstNonExecutedTradeIndex !== -1 && firstExecutedTradeIndex === -1) ||
    // Or there is non-executed trade and the non-executed trade index is lower than the executed trade index
    // or the index of current buy grid trade.
    // It usually happens when the last buy price is set manually.
    (firstNonExecutedTradeIndex !== -1 &&
      firstNonExecutedTradeIndex < firstExecutedTradeIndex) ||
    (firstNonExecutedTradeIndex !== -1 &&
      firstNonExecutedTradeIndex < currentBuyGridTradeIndex);

  // Check whether it's a single sell grid trade and whether it's executed.
  const isSingleSellGrid =
    currentSellGridTradeIndex >= 0 && sellGridTrade.length === 1;

  // Return true if there is no manual trade and it has executed single sell grid trade.
  // Store the manual trade and single trade status for the frontend
  return {
    hasObviousManualTrade,
    isSingleSellGrid
  };
};

/**
 * Calculate nextBestBuyAmount
 *
 * @param {*} currentPrice
 * @param {*} lastBuyPrice
 * @param {*} sellTrigger
 */
const calculateNextBestBuyAmount = (
  data,
  { currentPrice, lastBuyPrice, sellTrigger }
) => {
  const {
    symbolConfiguration: {
      buy: { gridTrade: buyGridTrade }
    }
  } = data;

  const { hasObviousManualTrade, isSingleSellGrid } =
    nextBestBuyAmountCalculationConditions(data);

  const totalBought = buyGridTrade
    .filter(trade => trade.executed)
    .map(order => ({
      cummulativeQuoteQty: parseFloat(order.executedOrder.cummulativeQuoteQty),
      executedQty: parseFloat(order.executedOrder.executedQty)
    }))
    .reduce(
      (acc, o) => {
        acc.amount += o.cummulativeQuoteQty;
        acc.qty += o.executedQty;
        return acc;
      },
      {
        amount: 0,
        qty: 0
      }
    );

  const buyTrigger = 1 + (currentPrice - lastBuyPrice) / lastBuyPrice;

  let amount = null;

  if (!hasObviousManualTrade && isSingleSellGrid) {
    amount =
      (totalBought.amount -
        totalBought.qty * buyTrigger * lastBuyPrice * sellTrigger) /
      (sellTrigger - 1);
  }

  const calculation = {
    currentPrice,
    lastBuyPrice,
    totalBoughtAmount: totalBought.amount,
    totalBoughtQty: totalBought.qty,
    buyTrigger,
    sellTrigger,
    hasObviousManualTrade,
    isSingleSellGrid
  };

  return { amount, calculation };
};

const applyConservativeSell = (
  _data,
  { conservativeFactor, sellTriggerPercentage, buyGridTradeDepth }
) => 1 + (sellTriggerPercentage - 1) * conservativeFactor ** buyGridTradeDepth;

/**
 * Get symbol information, buy/sell indicators
 *
 * @param {*} logger
 * @param {*} rawData
 */
const execute = async (logger, rawData) => {
  const data = rawData;

  const {
    symbol,
    symbolInfo: {
      filterMinNotional: { minNotional }
    },
    symbolConfiguration: {
      candles: { limit: candlesLimit },
      buy: {
        currentGridTradeIndex: currentBuyGridTradeIndex,
        currentGridTrade: currentBuyGridTrade,
        gridTrade: buyGridTrade,
        athRestriction: {
          enabled: buyATHRestrictionEnabled,
          candles: {
            limit: buyATHRestrictionCandlesLimit,
            interval: buyATHRestrictionCandlesInterval
          },
          restrictionPercentage: buyATHRestrictionPercentage
        }
      },
      sell: {
        currentGridTrade: currentSellGridTrade,
        stopLoss: { maxLossPercentage: sellMaxLossPercentage },
        conservativeMode: {
          enabled: sellConservativeModeEnabled,
          factor: conservativeFactor
        }
      }
    },
    baseAssetBalance: { total: baseAssetTotalBalance },
    openOrders
  } = data;

  const candles = _.orderBy(
    await mongo.findAll(
      logger,
      'trailing-trade-candles',
      {
        key: `${symbol}`
      },
      {
        sort: {
          time: -1
        },
        limit: candlesLimit
      }
    ),
    ['time'],
    ['desc']
  );

  if (_.isEmpty(candles)) {
    data.saveToCache = false;
    return data;
  }

  // Flatten candles data to get lowest price
  const candlesData = flattenCandlesData(candles);

  // Get the lowest price
  const lowestPrice = _.min(candlesData.low);

  const highestPrice = _.max(candlesData.high);

  // Retrieve ATH candles
  let athPrice = null;

  if (buyATHRestrictionEnabled) {
    logger.info(
      {
        function: 'athCandles',
        buyATHRestrictionEnabled,
        buyATHRestrictionCandlesInterval,
        buyATHRestrictionCandlesLimit
      },
      'Retrieving ATH candles from MongoDB'
    );

    const athCandles = _.orderBy(
      await mongo.findAll(
        logger,
        'trailing-trade-ath-candles',
        {
          key: `${symbol}`
        },
        {
          sort: {
            time: -1
          },
          limit: buyATHRestrictionCandlesLimit
        }
      ),
      ['time'],
      ['desc']
    );

    // Flatten candles data to get ATH price
    const athCandlesData = flattenCandlesData(athCandles);

    // ATH (All The High) price
    athPrice = _.max(athCandlesData.high);
  } else {
    logger.info(
      {
        debug: true,
        function: 'athCandles',
        buyATHRestrictionEnabled,
        buyATHRestrictionCandlesInterval,
        buyATHRestrictionCandlesLimit
      },
      'ATH Restriction is disabled'
    );
  }

  const latestIndicators = {
    highestPrice,
    lowestPrice,
    athPrice
  };

  let cachedLatestCandle =
    JSON.parse(
      await cache.hget('trailing-trade-symbols', `${symbol}-latest-candle`)
    ) || {};

  if (_.isEmpty(cachedLatestCandle)) {
    cachedLatestCandle = {
      eventType: '24hrMiniTicker',
      eventTime: candles[0].time,
      symbol: candles[0].key,
      close: candles[0].close
    };
  }

  const cachedTradingView =
    JSON.parse(await cache.hget('trailing-trade-tradingview', `${symbol}`)) ||
    {};

  // Set trading view
  data.tradingView = cachedTradingView;

  // Set last candle
  data.lastCandle = cachedLatestCandle;
  // Merge indicator data
  data.indicators = {
    ...data.indicators,
    ...latestIndicators
  };

  // Get current price
  const currentPrice = parseFloat(cachedLatestCandle.close);

  // Get last buy price
  const lastBuyPriceDoc = await getLastBuyPrice(logger, symbol);
  const lastBuyPrice = _.get(lastBuyPriceDoc, 'lastBuyPrice', null);

  // #### Buy related variables
  // Set trigger price to be null which will prevent to buy.
  let buyTriggerPrice = null;
  let buyDifference = null;
  let buyLimitPrice = null;
  if (currentBuyGridTrade !== null) {
    const {
      triggerPercentage: buyTriggerPercentage,
      limitPercentage: buyLimitPercentage
    } = currentBuyGridTrade;

    // If grid trade index is 0 or last buy price is null, then use lowest price as trigger price.
    // If grid trade index is not 0 and last buy price is not null, then use last buy price
    const triggerPrice =
      currentBuyGridTradeIndex !== 0 && lastBuyPrice !== null
        ? lastBuyPrice
        : lowestPrice;

    buyTriggerPrice = triggerPrice * buyTriggerPercentage;
    buyDifference = (1 - currentPrice / buyTriggerPrice) * -100;
    buyLimitPrice = currentPrice * buyLimitPercentage;
  }

  let buyATHRestrictionPrice = null;
  if (buyATHRestrictionEnabled) {
    buyATHRestrictionPrice = athPrice * buyATHRestrictionPercentage;
  }
  // ##############################

  // #### Sell related variables
  // Set trigger price to be null which will prevent to sell.
  let sellTriggerPrice = null;
  let sellDifference = null;
  let sellLimitPrice = null;
  let sellConservativeModeApplicable = false;
  let triggerPercentage = null;
  let nextBestBuy = null;

  const lastExecutedBuyTradeIndex = _.findLastIndex(
    buyGridTrade,
    trade => trade.executed === true
  );

  if (lastBuyPrice > 0 && currentSellGridTrade !== null) {
    const {
      triggerPercentage: sellTriggerPercentage,
      limitPercentage: sellLimitPercentage
    } = currentSellGridTrade;

    sellConservativeModeApplicable =
      sellConservativeModeEnabled && lastExecutedBuyTradeIndex >= 1;

    triggerPercentage = sellConservativeModeApplicable
      ? applyConservativeSell(data, {
          conservativeFactor,
          sellTriggerPercentage,
          buyGridTradeDepth: lastExecutedBuyTradeIndex
        })
      : sellTriggerPercentage;

    sellTriggerPrice = lastBuyPrice * triggerPercentage;
    sellDifference = (1 - sellTriggerPrice / currentPrice) * 100;
    sellLimitPrice = currentPrice * sellLimitPercentage;
  }
  // ##############################

  // #### Next best buy related variables
  // Only for single sell grids without obvious manual buys.
  let nextBestBuyAmount = null;
  let nextBestBuyCalculation = null;

  if (lastBuyPrice > 0) {
    // If conservative mode is enabled, update the sell trigger for the next grid
    // We won't compute nextBestBuy for multi-grid sells
    const nextBestBuySellTriggerPercentage =
      currentSellGridTrade !== null
        ? currentSellGridTrade.triggerPercentage
        : null;

    const nextBestBuySellTrigger = sellConservativeModeEnabled
      ? applyConservativeSell(data, {
          conservativeFactor,
          sellTriggerPercentage: nextBestBuySellTriggerPercentage,
          buyGridTradeDepth: lastExecutedBuyTradeIndex + 1
        })
      : nextBestBuySellTriggerPercentage;

    nextBestBuy = calculateNextBestBuyAmount(data, {
      currentPrice,
      lastBuyPrice,
      sellTrigger: nextBestBuySellTrigger
    });

    nextBestBuyAmount = nextBestBuy.amount;
    nextBestBuyCalculation = nextBestBuy.calculation;
  }
  // ##############################

  // Get stop loss trigger price
  const sellStopLossTriggerPrice =
    lastBuyPrice > 0 ? lastBuyPrice * sellMaxLossPercentage : null;
  const sellStopLossDifference =
    lastBuyPrice > 0
      ? (1 - sellStopLossTriggerPrice / currentPrice) * 100
      : null;

  // Estimate value
  const baseAssetEstimatedValue = baseAssetTotalBalance * currentPrice;
  const isLessThanMinNotionalValue =
    baseAssetEstimatedValue < parseFloat(minNotional);

  const sellCurrentProfit =
    lastBuyPrice > 0
      ? (currentPrice - lastBuyPrice) * baseAssetTotalBalance
      : null;

  const sellCurrentProfitPercentage =
    lastBuyPrice > 0 ? (currentPrice / lastBuyPrice - 1) * 100 : null;

  // Reorganise open orders
  const newOpenOrders = openOrders.map(order => {
    const newOrder = order;
    newOrder.currentPrice = currentPrice;
    newOrder.updatedAt = moment(order.time).utc().toDate();

    if (order.type !== 'STOP_LOSS_LIMIT') {
      return newOrder;
    }

    if (order.side.toLowerCase() === 'buy') {
      newOrder.differenceToExecute =
        (1 - parseFloat(order.stopPrice / currentPrice)) * 100;

      newOrder.differenceToCancel =
        buyLimitPrice > 0
          ? (1 - parseFloat(order.stopPrice / buyLimitPrice)) * 100
          : null;
    }

    if (order.side.toLowerCase() === 'sell') {
      newOrder.differenceToExecute =
        (1 - parseFloat(order.stopPrice / currentPrice)) * 100;
      newOrder.differenceToCancel =
        sellLimitPrice > 0
          ? (1 - parseFloat(order.stopPrice / sellLimitPrice)) * 100
          : null;

      newOrder.minimumProfit = null;
      newOrder.minimumProfitPercentage = null;
      if (lastBuyPrice > 0) {
        newOrder.minimumProfit =
          (parseFloat(order.price) - lastBuyPrice) * parseFloat(order.origQty);
        newOrder.minimumProfitPercentage =
          (parseFloat(order.price) / lastBuyPrice - 1) * 100;
      }
    }
    return newOrder;
  });

  // Sell restriction if last 2 candles are bearish
  const heikinAshiCandles = getHeikinAshiCandles(_.reverse(candles));
  const heikinAshiUpTrend =
    heikinAshiCandles[candlesLimit - 1].close >
      heikinAshiCandles[candlesLimit - 1].open &&
    heikinAshiCandles[candlesLimit - 2].close >
      heikinAshiCandles[candlesLimit - 2].open;

  // Buy restriction on Kagi downtrend
  // computed on HeikinAshi of HeikinAsh to confirm the trend
  const doubleHeikinAshiCandles = getHeikinAshiCandles(heikinAshiCandles);
  const previousKagi =
    candles.length >= 10
      ? getKagiTrend(
          doubleHeikinAshiCandles.slice(0, doubleHeikinAshiCandles.length - 1),
          10
        )
      : null;
  const currentKagi =
    candles.length >= 10 ? getKagiTrend(doubleHeikinAshiCandles, 10) : null;

  const kagiUpTrend =
    previousKagi !== null && currentKagi !== null
      ? previousKagi > 0 && currentKagi > 0
      : null;

  // Populate data
  data.baseAssetBalance.estimatedValue = baseAssetEstimatedValue;
  data.baseAssetBalance.isLessThanMinNotionalValue = isLessThanMinNotionalValue;

  data.buy = {
    currentPrice,
    limitPrice: buyLimitPrice,
    highestPrice,
    lowestPrice,
    athPrice,
    athRestrictionPrice: buyATHRestrictionPrice,
    kagiRestriction: !kagiUpTrend,
    triggerPrice: buyTriggerPrice,
    difference: buyDifference,
    nextBestBuyAmount,
    nextBestBuyCalculation,
    openOrders: newOpenOrders?.filter(o => o.side.toLowerCase() === 'buy'),
    processMessage: _.get(data, 'buy.processMessage', ''),
    updatedAt: moment().utc().toDate()
  };

  data.sell = {
    currentPrice,
    limitPrice: sellLimitPrice,
    lastBuyPrice,
    triggerPrice: sellTriggerPrice,
    difference: sellDifference,
    stopLossTriggerPrice: sellStopLossTriggerPrice,
    stopLossDifference: sellStopLossDifference,
    currentProfit: sellCurrentProfit,
    currentProfitPercentage: sellCurrentProfitPercentage,
    conservativeModeApplicable: sellConservativeModeApplicable,
    triggerPercentage,
    heikinAshiRestriction: heikinAshiUpTrend,
    openOrders: newOpenOrders?.filter(o => o.side.toLowerCase() === 'sell'),
    processMessage: _.get(data, 'sell.processMessage', ''),
    updatedAt: moment().utc().toDate()
  };

  return data;
};

module.exports = { execute };
