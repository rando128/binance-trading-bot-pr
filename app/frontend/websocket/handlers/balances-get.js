const {
  getSubAccountsBalance
} = require('../../../cronjob/trailingTradeHelper/common');

const handleBalancesGet = async (logger, ws, payload) => {
  logger.info({ payload }, 'Start balances get');

  // Get sub accounts balances
  const subAccountsBalance = await getSubAccountsBalance(logger);

  ws.send(
    JSON.stringify({
      result: true,
      type: 'balances-get-result',
      balanceTransfer: subAccountsBalance
    })
  );
};

module.exports = { handleBalancesGet };
