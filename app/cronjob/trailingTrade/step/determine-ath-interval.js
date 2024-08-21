const _ = require('lodash');
const { ObjectId } = require('mongodb');
const {
  saveSymbolConfiguration
} = require('../../trailingTradeHelper/configuration');
const { mongo, cache } = require('../../../helpers');

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

  const { symbol, symbolConfiguration, buy } = data;
  const { currentGridTradeIndex } = symbolConfiguration.buy;

  const lastUnderwaterTimestamp = await getLastUnderwaterTimestamp(
    logger,
    symbol
  );

  // We are below the active second buy grid threshold
  if (buy.difference < 0 && currentGridTradeIndex === 1) {
    if (!lastUnderwaterTimestamp) {
      await saveLastUnderwaterTimestamp(logger, symbol, {
        lastUnderwaterTimestamp: `${new Date().getTime()}`
      });
      return data;
    }

    const now = new Date().getTime();
    const delta = (now - lastUnderwaterTimestamp) / (60 * 1000);

    let interval = '5m';
    if (delta < 3 * 15) interval = '15m';
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
      await saveSymbolConfiguration(logger, symbol, newSymbolConfiguration);

      logger.info(
        { newSymbolConfiguration, saveLog: true },
        `The ATH interval is been updated to ${interval}`
      );
    }
  }

  // There is no active second buy grid anymore
  // Or we are within the active second buy grid threshold
  if (
    (lastUnderwaterTimestamp !== null && currentGridTradeIndex !== 1) ||
    (lastUnderwaterTimestamp !== null && buy.difference >= 0)
  ) {
    await removeLastUnderwaterTimestamp(logger, symbol);

    const newSymbolConfiguration = symbolConfiguration;
    // eslint-disable-next-line no-underscore-dangle
    newSymbolConfiguration._id = new ObjectId(`${newSymbolConfiguration._id}`); // required for mongoDB to work
    newSymbolConfiguration.buy.athRestriction.candles.interval = '5m';
    await saveSymbolConfiguration(logger, symbol, newSymbolConfiguration);

    logger.info(
      { newSymbolConfiguration, saveLog: true },
      `The ATH interval has been restored to 5min`
    );
  }

  return data;
};

module.exports = { execute };
