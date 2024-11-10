const {
  getLastBuyPriceFromAPI
} = require('../../../cronjob/trailingTradeHelper/common');

const handleLastBuyGetFromAPI = async (logger, ws, payload) => {
  logger.info({ payload }, 'Start last buy price get');

  const {
    data: { symbol }
  } = payload;

  const lastBuy = await getLastBuyPriceFromAPI(logger, symbol);

  ws.send(
    JSON.stringify({
      result: true,
      type: 'last-buy-get-result',
      lastBuyPriceFromAPI: lastBuy
    })
  );
};

module.exports = { handleLastBuyGetFromAPI };
