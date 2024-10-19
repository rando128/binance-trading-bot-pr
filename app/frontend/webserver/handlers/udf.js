const _ = require('lodash');
const { binance, mongo } = require('../../../helpers');
const {
  getCachedExchangeInfo
} = require('../../../cronjob/trailingTradeHelper/common');

const {
  getSymbolConfiguration
} = require('../../../cronjob/trailingTradeHelper/configuration');

// const {
//   getClosedTrades
// } = require('../../../cronjob/trailingTradeIndicator/steps');

const supportedResolutions = [
  '1',
  '3',
  '5',
  '15',
  '30',
  '60',
  '120',
  '180',
  '240',
  '360',
  '480',
  '720',
  '1D',
  '3D',
  '1W',
  '1M'
];
const RESOLUTIONS_INTERVALS_MAP = {
  1: '1m',
  3: '3m',
  5: '5m',
  15: '15m',
  30: '30m',
  60: '1h',
  120: '2h',
  180: '3h',
  240: '4h',
  360: '6h',
  480: '8h',
  720: '12h',
  D: '1d',
  '1D': '1d',
  '3D': '3d',
  W: '1w',
  '1W': '1w',
  M: '1M',
  '1M': '1M'
};

// const RESOLUTIONS_SECONDS_MAP = {
//   1: 60,
//   3: 180,
//   5: 300,
//   15: 900,
//   30: 1800,
//   60: 3600,
//   120: 7200,
//   240: 14400,
//   360: 21600,
//   480: 28800,
//   720: 43200,
//   '1D': 86400,
//   '3D': 259200,
//   '1W': 604800,
//   '1M': 2592000
// };

function priceScale(symbol) {
  let scale = 1;
  symbol.filters.forEach(filter => {
    if (filter.filterType === 'PRICE_FILTER') {
      scale = Math.round(1 / parseFloat(filter.tickSize));
    }
  });
  return scale;
}

const handleUDF = async (funcLogger, app) => {
  const logger = funcLogger.child({
    endpoint: '/udf'
  });

  const exchangeInfo = (await getCachedExchangeInfo(logger)) || {};
  let symbols = {};
  if (!_.isEmpty(exchangeInfo))
    symbols = exchangeInfo.symbols.map(symbol => ({
      symbol: symbol.symbol,
      ticker: symbol.symbol,
      name: symbol.symbol,
      full_name: symbol.symbol,
      description: `${symbol.baseAsset} / ${symbol.quoteAsset}`,
      exchange: 'BINANCE',
      listed_exchange: 'BINANCE',
      type: 'crypto',
      currency_code: symbol.quoteAsset,
      session: '24x7',
      timezone: 'Europe/Madrid',
      minmovement: 1,
      minmov: 1,
      minmovement2: 0,
      minmov2: 0,
      pricescale: priceScale(symbol),
      supported_resolutions: supportedResolutions,
      has_intraday: true,
      has_daily: true,
      has_weekly_and_monthly: true,
      data_status: 'streaming'
    }));

  // UDF symbols
  app.get('/symbols', async (req, res) => {
    const { symbol } = req.query;
    const symbolInfo =
      _.find(symbols, {
        symbol
      }) || {};
    res.send(symbolInfo);
  });

  // UDF time
  app.get('/time', (req, res) => {
    const time = Math.floor(Date.now() / 1000); // In seconds
    res.set('Content-Type', 'text/plain').send(time.toString());
  });

  // UDF config
  app.get('/config', async (req, res) =>
    res.send({
      exchanges: [
        {
          value: 'BINANCE',
          name: 'Binance',
          desc: 'Binance Exchange'
        }
      ],
      symbols_types: [
        {
          value: 'crypto',
          name: 'Cryptocurrency'
        }
      ],
      supported_resolutions: supportedResolutions,
      supports_search: true,
      supports_group_request: false,
      supports_marks: false,
      supports_timescale_marks: false,
      supports_time: true
    })
  );

  // UDF search - respond with the list of monitored coins
  app.get('/search', async (req, res) => {
    const trailingTradeCacheQuery = [
      {
        $match: {}
      },
      {
        $project: {
          _id: 0,
          symbol: '$symbol',
          full_name: '$symbol',
          description: '$sell.currentProfitPercentage',
          exchange: {
            $literal: 'binance'
          },
          type: {
            $literal: 'crypto'
          },
          sortField: '$symbol'
        }
      }
    ];
    const monitoredCoins = await mongo.aggregate(
      logger,
      'trailing-trade-cache',
      trailingTradeCacheQuery
    );
    return res.send(monitoredCoins);
  });

  // UDF history
  app.get('/history', async (req, res) => {
    const { symbol } = req.query;
    const { countback } = req.query;
    const to = req.query.to * 1000;

    const isInSymbols = _.find(symbols, { symbol }) || null;
    if (!isInSymbols) {
      logger.error(`Invalid symbol ${symbol}`);
      return res.status(500);
    }

    const interval = RESOLUTIONS_INTERVALS_MAP[req.query.resolution];
    if (!interval) {
      return res.send({ s: 'no_data', m: 'invalid resolution' });
    }

    const candles = await binance.client.candles({
      symbol,
      interval,
      endTime: to,
      limit: countback
    });

    if (candles.length === 0) {
      return res.send({ s: 'no_data', m: 'no candles' });
    }
    return res.send({
      s: 'ok',
      t: _.map(candles, v => Math.floor(v.openTime / 1000)),
      c: _.map(candles, v => parseFloat(v.close)),
      o: _.map(candles, v => parseFloat(v.open)),
      h: _.map(candles, v => parseFloat(v.high)),
      l: _.map(candles, v => parseFloat(v.low)),
      v: _.map(candles, v => parseFloat(v.volume))
    });
  });

  // UDF marks
  /*
  app.get('/marks', async (req, res) => {
    const { symbol } = req.query;

    // const databaseOpenOrders = await mongo.findAll(
    //     logger,
    //     'trailing-trade-grid-trade-orders',
    // 'trailing-trade-grid-trade-archive',//'trailing-trade-grid-trade-orders',//'trailing-trade-grid-trade-archive',
    //     {
    //         // key: {
    //         //     $regex: `(${symbol})-grid-trade-last-buy-order`
    //         // }
    //     }
    // );
    //
    // logger.warn(
    //     {databaseOpenOrders},
    //     `Retrieved ${symbol} grid trades`
    // );

    let allOrders;
    const databaseBuyOrders = await mongo.aggregate(
      logger,
      'trailing-trade-grid-trade-archive',
      [
        {
          $unwind: '$buy'
        },
        {
          $match: {
            $and: [{ symbol }, { 'buy.executed': true }]
          }
        },
        {
          $project: {
            _id: 0,
            id: '$buy.executedOrder.orderId',
            time: '$buy.executedOrder.transactTime',
            side: '$buy.executedOrder.side',
            price: '$buy.executedOrder.price'
          }
        }
      ]
    );
    const databaseSellOrders = await mongo.aggregate(
      logger,
      'trailing-trade-grid-trade-archive',
      [
        {
          $unwind: '$sell'
        },
        {
          $match: {
            $and: [{ symbol }, { 'sell.executed': true }]
          }
        },
        {
          $project: {
            _id: 0,
            id: '$sell.executedOrder.orderId',
            time: '$sell.executedOrder.transactTime',
            side: '$sell.executedOrder.side',
            price: '$sell.executedOrder.price'
          }
        }
      ]
    );

    const databaseStopLossOrders = await mongo.aggregate(
      logger,
      'trailing-trade-grid-trade-archive',
      [
        {
          $unwind: '$stopLoss'
        },
        {
          $match: {
            $and: [{ symbol }]
          }
        },
        {
          $project: {
            _id: 0,
            id: '$stopLoss.orderId',
            time: '$stopLoss.transactTime',
            side: '$stopLoss.side',
            price: '$stopLoss.fills.price',
            sell: '$stopLoss.timeInForce'
          }
        }
      ]
    );
    allOrders = databaseSellOrders.concat(
      databaseBuyOrders.concat(databaseStopLossOrders)
    );

    //TV bug: marks are offset one tick to the left - https://github.com/tradingview/charting_library/issues/410
    const interval = RESOLUTIONS_SECONDS_MAP[req.query.resolution];
    allOrders = {
      id: _.map(allOrders, 'id'),
      time: _.map(allOrders, v => v.time / 1000 - interval),
      color: _.map(allOrders, v => {
        if (v.side == 'BUY') return 'red';
        if (v.sell == 'GTC') return 'orange';
        return 'green';
      }),
      text: _.map(allOrders, v => {
          if (v.side === 'BUY' || v.sell == 'GTC') return `@${v.price}`;
          //if (v.sell == 'GTC') return `@${v.price} ${moment(v.time).tz('Europe/Madrid')}`;
          return `@${v.price} ${moment(v.time).tz('Europe/Madrid')}`
        }
      ),
      price: _.map(allOrders, 'price'),
      label: _.map(allOrders, (v) => { return (v.side === 'BUY') ? 'B': 'S'}),
      labelFontColor: _.map(allOrders, () => { return 'white'}),
      minSize: _.map(allOrders, () => { return 14}),
    };

    // const activeGridOrders = await mongo.findAll(
    //     logger,
    //     'trailing-trade-grid-trade',//'trailing-trade-grid-trade-orders',
    //     {
    //         key: symbol
    //         // key: {
    //         //     $regex: `(${symbols.join('|')})-grid-trade-last-buy-order`
    //         // }
    //     }
    // )
    // logger.warn(activeGridOrders)
    //
    // const currentGrid = await mongo.findAll(
    //     logger,
    //     'trailing-trade-grid-trade',
    //     {
    //         //     $match: {
    //         //         //'key': symbol,
    //         //         //'buy.executed': true,
    //         //     }
    //         // }
    //         // , {
    //         //     // $project: {
    //         //     //     'buy': 1
    //         //     // }
    //     }
    // )
    // logger.warn(currentGrid)

    res.send(allOrders);
  });
  */
  // Grids endpoints
  app.get('/grid_trades', async (req, res) => {
    const { symbol } = req.query;

    const symbolConfiguration = await getSymbolConfiguration(logger, symbol);

    const conservativeFactor =
      symbolConfiguration &&
      symbolConfiguration.sell &&
      symbolConfiguration.sell.conservativeMode.enabled
        ? symbolConfiguration.sell.conservativeMode.factor
        : 1;

    const archivedGrids = await mongo.findAll(
      logger,
      'trailing-trade-grid-trade-archive',
      {
        $or: [
          {
            // fully executed grids
            $and: [
              { symbol },
              { buyGridTradeExecuted: true },
              { sellGridTradeExecuted: true }
            ]
          },
          {
            // grids exited via stoploss - TODO: handle manually exited traded
            $and: [
              { symbol },
              { buyGridTradeExecuted: true },
              { sellGridTradeExecuted: false },
              { 'stopLoss.orderId': { $exists: true } }
            ]
          }
        ]
      }
    );
    const activeGrid = await mongo.findAll(
      logger,
      'trailing-trade-grid-trade',
      {
        key: symbol
      }
    );

    const allGrids = archivedGrids.concat(activeGrid);
    /*
    trade:
      side: buy, sell,
      isStopLoss
      price
      time
      scale
      lastBuyPrice (amount / qty )
      buy-> sellTriggerpercentage + nextBuyTriggerPercentage
     */

    const exchangeSymbol = symbols.filter(s => s.symbol === symbol)[0];
    const scale = exchangeSymbol.pricescale;

    const allTrades = [];
    allGrids.forEach(grid => {
      let qty = 0;
      let amount = 0;
      let sell;

      // sell or stoploss element if any
      if (grid.sell) {
        if (grid.sell[0].executed) sell = grid.sell[0].executedOrder;
        else if (grid.stopLossQuoteQty) sell = grid.stopLoss;
        if (sell)
          allTrades.push({
            time: sell.transactTime / 1000,
            side: 'SELL',
            price: grid.stopLossQuoteQty
              ? parseFloat(sell.fills[0].price)
              : parseFloat(sell.price),
            qty: sell.executedQty,
            stopLoss: grid.stopLossQuoteQty,
            scale
          });
      }

      // go over each buy element
      if (grid.buy)
        grid.buy.forEach((buy, b, buys) => {
          if (buy.executed) {
            qty += parseFloat(buy.executedOrder.executedQty);
            amount += parseFloat(buy.executedOrder.cummulativeQuoteQty);

            let sellTrigger = grid.sell[0].triggerPercentage;
            let buyTrigger =
              b < buys.length - 1 ? buys[b + 1].triggerPercentage : 0;
            let conservativeTrigger =
              sellTrigger * conservativeFactor ** (buys.length - 1);
            if (sell === undefined && symbolConfiguration.buy !== undefined) {
              // take live configuration for active grids
              buyTrigger =
                b < symbolConfiguration.buy.gridTrade.length - 1
                  ? symbolConfiguration.buy.gridTrade[b + 1].triggerPercentage
                  : 0;
              sellTrigger =
                symbolConfiguration.sell.gridTrade[0].triggerPercentage;
              conservativeTrigger =
                1 + (sellTrigger - 1) * conservativeFactor ** (buys.length - 1);
            }

            allTrades.push({
              time: buy.executedOrder.transactTime / 1000,
              side: 'BUY',
              price: parseFloat(buy.executedOrder.price),
              qty: parseFloat(buy.executedOrder.executedQty),
              sellTrigger: sellTrigger * scale,
              buyTrigger: buyTrigger * scale,
              conservativeTrigger: conservativeTrigger * scale,
              lastBuyPrice: amount / qty,
              totalQty: qty,
              scale
            });
          }
        });
    });

    allTrades.sort((a, b) => a.time - b.time);

    // eslint-disable-next-line array-callback-return
    allTrades.map((order, i, orders) => {
      // eslint-disable-next-line no-param-reassign
      order.from = order.time;
      // eslint-disable-next-line no-param-reassign
      order.to = i === orders.length - 1 ? null : orders[i + 1].time;
    });

    res.send(allTrades);
  });

  // Dashboard endpoints
  app.get('/current_grid', async (req, res) => {
    const { symbol } = req.query;

    const activeGrid = await mongo.findAll(logger, 'trailing-trade-cache', {
      symbol
    });

    function calculateBuyStats(transactionData) {
      // Extract gridTrade data for buy transactions
      const gridData = transactionData[0].symbolConfiguration.buy.gridTrade;
      const currentPrice = parseFloat(transactionData[0].lastCandle.close);

      // Filter out the executed buy transactions
      const buyTransactions = gridData.filter(tx => tx.executed);

      if (buyTransactions.length === 0) {
        return {
          lastBuyTimestamp: null,
          totalQuantity: 0,
          averagePrice: 0,
          gridDepth: null
        };
      }

      let totalQuantity = 0;
      let totalCummulativeQuoteQty = 0;
      let lastBuyTransaction = buyTransactions[0];

      // Loop through the executed buy transactions
      buyTransactions.forEach(tx => {
        const { executedOrder } = tx;
        const executedQty = parseFloat(executedOrder.executedQty);
        const cummulativeQuoteQty = parseFloat(
          executedOrder.cummulativeQuoteQty
        );

        totalQuantity += executedQty;
        totalCummulativeQuoteQty += cummulativeQuoteQty;

        // Update the last buy transaction if the current one is more recent
        if (
          executedOrder.transactTime >
          lastBuyTransaction.executedOrder.transactTime
        ) {
          lastBuyTransaction = tx;
        }
      });

      const averagePrice = totalCummulativeQuoteQty / totalQuantity;

      return {
        lastBuyTimestamp: lastBuyTransaction.executedOrder.transactTime,
        totalQuantity,
        totalCummulativeQuoteQty,
        averagePrice,
        currentPrice,
        gridDepth: lastBuyTransaction.executedOrder.currentGridTradeIndex + 1
      };
    }

    // eslint-disable-next-line no-shadow
    async function calculateProfits(symbol) {
      const totalProfit = (
        await mongo.aggregate(logger, 'trailing-trade-grid-trade-archive', [
          {
            $match: { symbol }
          },
          {
            $group: {
              ...{ _id: '$symbol', symbol: { $first: '$symbol' } },
              profit: { $sum: '$profit' },
              trades: { $sum: 1 }
            }
          },
          {
            $project: {
              ...{ symbol: 1 },
              profit: 1,
              trades: 1
            }
          }
        ])
      )[0] || {
        ...{ symbol },
        profit: 0,
        trades: 0
      };
      const lastProfit = (
        await mongo.aggregate(logger, 'trailing-trade-grid-trade-archive', [
          {
            $match: { symbol }
          },
          {
            $sort: { archivedAt: -1 }
          },
          {
            $limit: 1
          },
          {
            $project: {
              ...{ symbol: 1 },
              profit: 1,
              archivedAt: 1
            }
          }
        ])
      )[0] || {
        ...{ symbol },
        profit: 0,
        trades: 0
      };
      return {
        lastProfit: lastProfit.profit,
        lastTrade: lastProfit.archivedAt,
        profit: totalProfit.profit,
        trades: totalProfit.trades
      };
    }

    res.send({
      ...calculateBuyStats(activeGrid),
      ...(await calculateProfits(symbol))
    });
  });
};

module.exports = { handleUDF };
