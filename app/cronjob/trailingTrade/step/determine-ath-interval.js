const _ = require('lodash');
const { ObjectId } = require('mongodb');
const {
  saveSymbolConfiguration,
  getGlobalConfiguration
} = require('../../trailingTradeHelper/configuration');
const { mongo, cache } = require('../../../helpers');
const {
  setupATHCandlesWebsocket,
  syncATHCandles
} = require('../../../binance/ath-candles');

/**
 * Get last underwater timestamp from mongodb
 *
 * @param {*} logger
 * @param {*} symbol
 *
 */
const getLastUnderwaterTimestamp = async (logger, symbol) => {
  const cachedTimestamp = await cache.hget(
    'trailing-trade-common',
    `${symbol}-last-underwater-timestamp`
  );
  if (cachedTimestamp) return cachedTimestamp;

  const result = await mongo.findOne(logger, 'trailing-trade-symbols', {
    key: `${symbol}-last-underwater-timestamp`
  });

  const lastUnderwaterTimestamp = _.get(
    result,
    'lastUnderwaterTimestamp',
    null
  );

  await cache.hset(
    'trailing-trade-common',
    `${symbol}-last-underwater-timestamp`,
    lastUnderwaterTimestamp
  );

  return lastUnderwaterTimestamp;
};

/**
 * Save last underwater timestamp to mongodb
 *
 * @param {*} logger
 * @param {*} symbol
 * @param {*} param2
 */
const saveLastUnderwaterTimestamp = async (
  logger,
  symbol,
  { lastUnderwaterTimestamp }
) => {
  logger.info(
    { lastUnderwaterTimestamp, saveLog: false },
    'The last underwater timestamp has been saved.'
  );
  const result = await mongo.upsertOne(
    logger,
    'trailing-trade-symbols',
    { key: `${symbol}-last-underwater-timestamp` },
    {
      key: `${symbol}-last-underwater-timestamp`,
      lastUnderwaterTimestamp
    }
  );

  // Refresh configuration
  await cache.hset(
    'trailing-trade-common',
    `${symbol}-last-underwater-timestamp`,
    lastUnderwaterTimestamp
  );

  return result;
};

const removeLastUnderwaterTimestamp = async (logger, symbol) => {
  logger.info(
    { saveLog: false },
    'The last underwater timestamp has been removed.'
  );

  await mongo.deleteOne(logger, 'trailing-trade-symbols', {
    key: `${symbol}-last-underwater-timestamp`
  });

  // Refresh configuration
  await cache.hdel(
    'trailing-trade-common',
    `${symbol}-last-underwater-timestamp`
  );
};

/**
 * Update ATH interval symbol configuration if necessary
 *
 * @param {*} logger
 * @param {*} rawData
 */
const execute = async (logger, rawData) => {
  const data = rawData;

  const {
    symbol,
    symbolConfiguration,
    buy: { openOrders: buyOpenOrders },
    sell: { openOrders: sellOpenOrders },
    openOrders
  } = data;
  const { currentGridTradeIndex } = symbolConfiguration.buy;
  const { buy, sell } = symbolConfiguration;

  const lastUnderwaterTimestamp = await getLastUnderwaterTimestamp(
    logger,
    symbol
  );
  const defaultInterval = '5m';

  // Don't update if an order is in process
  if (
    (openOrders && openOrders.length > 0) ||
    (buyOpenOrders && buyOpenOrders.length > 0) ||
    (sellOpenOrders && sellOpenOrders.length > 0)
  ) {
    logger.info(
      { saveLog: true },
      `Skipping ATH interval update due to on going order`
    );
    return data;
  }
  let restart = false;

  // We are below the active second buy grid threshold
  if (data.buy.difference < 0 && currentGridTradeIndex === 1) {
    if (!lastUnderwaterTimestamp) {
      await saveLastUnderwaterTimestamp(logger, symbol, {
        lastUnderwaterTimestamp: `${new Date().getTime()}`
      });
      return data;
    }

    const now = new Date().getTime();
    const delta = (now - lastUnderwaterTimestamp) / (60 * 1000);

    let interval;
    if (delta < 15) interval = defaultInterval;
    else if (delta < 3 * 15) interval = '15m';
    else if (delta < 3 * 30) interval = '30m';
    else if (delta < 3 * 60) interval = '1h';
    else if (delta < 6 * 60) interval = '2h';
    else interval = '4h';

    if (symbolConfiguration.buy.athRestriction.candles.interval !== interval) {
      const newSymbolConfiguration = symbolConfiguration;
      // eslint-disable-next-line no-underscore-dangle
      newSymbolConfiguration._id = new ObjectId(
        // eslint-disable-next-line no-underscore-dangle
        `${newSymbolConfiguration._id}`
      ); // required for mongoDB to work

      newSymbolConfiguration.buy.athRestriction.candles.interval = interval;

      // We do not want to save executed/executedOrder as it will be processed in the configuration.
      buy.gridTrade = buy.gridTrade.map(b =>
        _.omit(b, 'executed', 'executedOrder')
      );
      sell.gridTrade = sell.gridTrade.map(b =>
        _.omit(b, 'executed', 'executedOrder')
      );

      newSymbolConfiguration.buy = _.omit(
        buy,
        'currentGridTradeIndex',
        'currentGridTrade'
      );
      newSymbolConfiguration.sell = _.omit(
        sell,
        'currentGridTradeIndex',
        'currentGridTrade'
      );

      await saveSymbolConfiguration(
        logger,
        symbol,
        newSymbolConfiguration,
        false
      );

      data.symbolConfiguration.buy.athRestriction.candles.interval = interval;

      restart = true;
      logger.info(
        { newSymbolConfiguration, saveLog: true },
        `The ATH interval has been updated to ${interval}`
      );
    }
  }

  // There is no active second buy grid anymore
  // Or we are not within the active second buy grid threshold
  if (
    (lastUnderwaterTimestamp !== null && currentGridTradeIndex !== 1) ||
    (lastUnderwaterTimestamp !== null && data.buy.difference >= 0)
  ) {
    await removeLastUnderwaterTimestamp(logger, symbol);

    if (
      symbolConfiguration.buy.athRestriction.candles.interval !==
      defaultInterval
    ) {
      const newSymbolConfiguration = symbolConfiguration;
      // eslint-disable-next-line no-underscore-dangle
      newSymbolConfiguration._id = new ObjectId(
        // eslint-disable-next-line no-underscore-dangle
        `${newSymbolConfiguration._id}`
      ); // required for mongoDB to work

      newSymbolConfiguration.buy.athRestriction.candles.interval =
        defaultInterval;

      // We do not want to save executed/executedOrder as it will be processed in the configuration.
      buy.gridTrade = buy.gridTrade.map(b =>
        _.omit(b, 'executed', 'executedOrder')
      );
      sell.gridTrade = sell.gridTrade.map(b =>
        _.omit(b, 'executed', 'executedOrder')
      );

      newSymbolConfiguration.buy = _.omit(
        buy,
        'currentGridTradeIndex',
        'currentGridTrade'
      );
      newSymbolConfiguration.sell = _.omit(
        sell,
        'currentGridTradeIndex',
        'currentGridTrade'
      );
      await saveSymbolConfiguration(
        logger,
        symbol,
        newSymbolConfiguration,
        false
      );
      restart = true;
      logger.info(
        { newSymbolConfiguration, saveLog: true },
        `The ATH interval has been restored to ${defaultInterval}`
      );
    }
  }

  if (restart) {
    // Get configuration
    const globalConfiguration = await getGlobalConfiguration(logger);

    // Retrieve list of monitoring symbols
    const { symbols } = globalConfiguration;

    // Candles & ATH candles should receive all monitoring symbols to create their connection from scratch
    // because they are grouped by symbols intervals and not by their names
    await Promise.all([setupATHCandlesWebsocket(logger, symbols)]);

    await syncATHCandles(logger, [symbol]);
  }
  return data;
};

module.exports = { execute };
