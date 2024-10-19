const moment = require('moment');
const {
  saveOverrideIndicatorAction
} = require('../../../cronjob/trailingTradeHelper/common');

const handleBalanceTransferExecute = async (logger, ws, payload) => {
  logger.info({ payload }, 'Start balance transfer execute');

  const {
    data: { balanceTransfer }
  } = payload;

  await saveOverrideIndicatorAction(
    logger,
    'global',
    {
      action: 'balance-transfer',
      params: balanceTransfer,
      actionAt: moment().toISOString(),
      triggeredBy: 'user'
    },
    'The balance transfer request received by the bot. Wait for executing the balance transfer.'
  );

  ws.send(
    JSON.stringify({
      result: true,
      type: 'balance-transfer-execute-result',
      message: 'The balance transfer request received.'
    })
  );
};

module.exports = { handleBalanceTransferExecute };
