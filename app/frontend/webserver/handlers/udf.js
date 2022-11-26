const _ = require('lodash');
const moment = require('moment');
const { binance, mongo } = require('../../../helpers');
const {
  getCachedExchangeInfo
} = require('../../../cronjob/trailingTradeHelper/common');
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

const RESOLUTIONS_SECONDS_MAP = {
  1: 60,
  3: 180,
  5: 300,
  15: 900,
  30: 1800,
  60: 3600,
  120: 7200,
  240: 14400,
  360: 21600,
  480: 28800,
  720: 43200,
  '1D': 86400,
  '3D': 259200,
  '1W': 604800,
  '1M': 2592000
};

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
      //throw new Error(`Invalid resolution ${req.query.resolution}`);
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
          if (v.side === 'BUY') return `@${v.price} ${moment(v.time).tz('Europe/Madrid')}`;
          if (v.sell == 'GTC') return `@${v.price} ${moment(v.time).tz('Europe/Madrid')}`;
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

  // Grids endpoints
  app.get('/grid_trades', async (req, res) => {
    const { symbol } = req.query;
    // TODO ADD FROM / TO

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
            price: '$buy.executedOrder.price',
            qty: '$buy.executedOrder.executedQty',
            amount: '$buy.executedOrder.cummulativeQuoteQty',
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
            price: '$sell.executedOrder.price',
            qty: '$sell.executedOrder.executedQty',
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
            sell: '$stopLoss.timeInForce',
            qty: '$stopLoss.executedQty',
          }
        }
      ]
    );

    const databaseActiveGridOrders = await mongo.aggregate(
      logger,
      'trailing-trade-grid-trade',
      [
        {
          $unwind: '$buy'
        },
        {
          $match: {
            $and: [{ 'buy.executedOrder.symbol': symbol }, { 'buy.executed': true }]
          }
        },
        {
          $project: {
            _id: 0,
            time: '$buy.executedOrder.transactTime',
            qty: '$buy.executedOrder.executedQty',
            amount: '$buy.executedOrder.cummulativeQuoteQty',
            price: '$buy.executedOrder.price',
            side: '$buy.executedOrder.side',
          }
        },
      ]
    );

    allOrders = databaseSellOrders.concat(
      databaseBuyOrders.concat(databaseStopLossOrders.concat(databaseActiveGridOrders))
    );

    allOrders.sort( (a,b) => {
      return a.time - b.time
    })

    //get symbol scale - TV uses ticks for long-position band
    const exchangeSymbol = symbols.filter( s => s.symbol === symbol)[0]

    let currentBuyIdx = 0

    allOrders.map( (order, i, orders) => {
      if (order.side === 'BUY') {
        const qty = orders.slice(currentBuyIdx, i + 1).reduce((acc, o) => acc + parseFloat(o.qty), 0);
        const amount = orders.slice(currentBuyIdx, i + 1).reduce((acc, o) => acc + parseFloat(o.amount), 0);
        order.lastBuyPrice = amount / qty;
        order.stopLoss = (order.sell == 'GTC');
      } else {
        currentBuyIdx = i + 1;
      }

      order.price = parseFloat(order.price);
      order.from = order.time / 1000;
      order.to = (i == orders.length - 1) ? null : orders[i+1].time / 1000;
      order.scale = exchangeSymbol.pricescale;
      return order;
    })

    allOrders.forEach(function(order) {
      delete order.id;
      //delete order.amount;
      delete order.time;
    });

    // logger.warn(
    //     {databaseOpenOrders},
    //     `Retrieved ${symbol} active trades`
    // );
    res.send(allOrders)

    // const grids = allTradeGrids.map(g => {
    //   console.log(g)
    //   const from = g.buy[0].executedOrder.transactTime;
    //   const to = g.sellGridTradeExecuted
    //     ? g.sell[0].executedOrder.transactTime
    //     : g.stopLoss.transactTime;
    //
    //   const price1 = parseFloat(g.buy[0].executedOrder.price);
    //   const limitPrice1 =
    //     (parseFloat(g.buy[0].limitPercentage) *
    //       parseFloat(g.buy[0].executedOrder.stopPrice)) /
    //     parseFloat(g.buy[0].stopPercentage);
    //   const triggerPrice1 = parseFloat(g.buy[0].executedOrder.stopPrice); // can't access original trigger point
    //   const triggerPercentage1 = parseFloat(g.buy[0].triggerPercentage);
    //   const limitPercentage1 = parseFloat(g.buy[0].limitPercentage);
    //
    //   let sellPrice = price1 * parseFloat(g.sell[0].triggerPercentage);
    //   let lastPrice = price1;
    //   const lastQty = parseFloat(g.buy[0].executedOrder.executedQty);
    //   const lastQuote = parseFloat(g.buy[0].executedOrder.cummulativeQuoteQty);
    //
    //   const hasGrid2 = g.buy.length >= 2;
    //   const isGrid2Executed = hasGrid2 ? g.buy[1].executed === true : false;
    //   const price2 =
    //     hasGrid2 && isGrid2Executed
    //       ? parseFloat(g.buy[1].executedOrder.price)
    //       : null;
    //   const limitPercentage2 = hasGrid2
    //     ? parseFloat(g.buy[1].limitPercentage)
    //     : null;
    //   const limitPrice2 =
    //     hasGrid2 && isGrid2Executed
    //       ? (parseFloat(g.buy[1].limitPercentage) *
    //           parseFloat(g.buy[1].executedOrder.stopPrice)) /
    //         parseFloat(g.buy[1].stopPercentage)
    //       : null;
    //   const triggerPrice2 = hasGrid2
    //     ? lastPrice * parseFloat(g.buy[1].triggerPercentage)
    //     : null;
    //   const triggerPercentage2 = hasGrid2
    //     ? parseFloat(g.buy[1].triggerPercentage)
    //     : null;
    //   sellPrice = triggerPrice2
    //     ? price2 * parseFloat(g.sell[0].triggerPercentage)
    //     : sellPrice;
    //
    //   lastPrice = (() => {
    //     if (hasGrid2 && isGrid2Executed)
    //       return (
    //         (lastQuote +
    //           parseFloat(g.buy[1].executedOrder.cummulativeQuoteQty)) /
    //         (lastQty + parseFloat(g.buy[1].executedOrder.executedQty))
    //       );
    //     if (hasGrid2) return lastPrice * g.buy[1].triggerPercentage;
    //     return null;
    //   })();
    //   // lastQty =
    //   //   hasGrid2 && isGrid2Executed
    //   //     ? parseFloat(g.buy[1].executedOrder.executedQty)
    //   //     : lastQty;
    //   // lastQuote =
    //   //   hasGrid2 && isGrid2Executed
    //   //     ? parseFloat(g.buy[1].executedOrder.cummulativeQuoteQty)
    //   //     : lastQuote;
    //
    //   const hasGrid3 = g.buy.length >= 3;
    //   const isGrid3Executed = hasGrid3 ? g.buy[2].executed === true : false;
    //   const price3 =
    //     hasGrid3 && isGrid3Executed
    //       ? parseFloat(g.buy[2].executedOrder.price)
    //       : null;
    //   const limitPercentage3 = hasGrid3
    //     ? parseFloat(g.buy[2].limitPercentage)
    //     : null;
    //   const limitPrice3 =
    //     hasGrid3 && isGrid3Executed
    //       ? (parseFloat(g.buy[2].limitPercentage) *
    //           parseFloat(g.buy[2].executedOrder.stopPrice)) /
    //         parseFloat(g.buy[2].stopPercentage)
    //       : null;
    //   const triggerPrice3 = hasGrid3
    //     ? lastPrice * parseFloat(g.buy[2].triggerPercentage)
    //     : null;
    //   const triggerPercentage3 = hasGrid3
    //     ? parseFloat(g.buy[2].triggerPercentage)
    //     : null;
    //   sellPrice = triggerPrice3
    //     ? price3 * parseFloat(g.sell[0].triggerPercentage)
    //     : sellPrice;
    //   // lastPrice =
    //   //   hasGrid3 & isGrid3Executed
    //   //     ? (lastQuote +
    //   //         parseFloat(g.buy[2].executedOrder.cummulativeQuoteQty)) /
    //   //       (lastQty + parseFloat(g.buy[2].executedOrder.executedQty))
    //   //     : hasGrid3
    //   //     ? lastPrice * g.buy[2].triggerPercentage
    //   //     : null;
    //   // lastQty =
    //   //   hasGrid3 & isGrid3Executed
    //   //     ? parseFloat(g.buy[2].executedOrder.executedQty)
    //   //     : lastQty;
    //   // lastQuote =
    //   //   hasGrid3 & isGrid3Executed
    //   //     ? parseFloat(g.buy[2].executedOrder.cummulativeQuoteQty)
    //   //     : lastQuote;
    //
    //   return {
    //     from,
    //     to,
    //
    //     buyGrids: g.buy.length,
    //     sellPrice,
    //     triggerPrice: [triggerPrice1, triggerPrice2, triggerPrice3].filter(
    //       e => e
    //     ),
    //     triggerPercentage: [
    //       triggerPercentage1,
    //       triggerPercentage2,
    //       triggerPercentage3
    //     ].filter(e => e),
    //     limitPrice: [limitPrice1, limitPrice2, limitPrice3].filter(e => e),
    //     limitPercentage: [
    //       limitPercentage1,
    //       limitPercentage2,
    //       limitPercentage3
    //     ].filter(e => e)
    //   };
    // });
    //
    // res.send(grids);
  });
};

module.exports = { handleUDF };
