const { slack, PubSub } = require('../../../helpers');
const {
  getAPILimit,
  transferAssets
} = require('../../trailingTradeHelper/common');

/**
 * Execute balance transfer
 *
 * @param {*} logger
 * @param {*} rawData
 */
const execute = async (logger, rawData) => {
  const data = rawData;

  const { action, overrideParams } = rawData;

  if (action !== 'balance-transfer') {
    logger.info(
      `Do not process balance transfer because action is not 'balance-transfer'.`
    );
    return data;
  }

  try {
    const transferResult = await transferAssets(logger, overrideParams);

    if (transferResult === false) {
      throw new Error('Failed to transfer assets');
    }
    PubSub.publish('frontend-notification', {
      type: 'success',
      title: `The balance transfer has been executed successfully. The account information will be updated soon.`
    });

    slack.sendMessage(
      `Balance Transfer Result:\n` +
        `- Result: \`\`\`${JSON.stringify('success', undefined, 2)}\`\`\``,
      { apiLimit: getAPILimit(logger) }
    );
  } catch (e) {
    logger.error(e, 'Execution failed.');
    PubSub.publish('frontend-notification', {
      type: 'error',
      title: `The balance transfer is failed to execute. Try again later.`
    });

    slack.sendMessage(`Balance Transfer Error:\n- Message: ${e.message}`, {
      apiLimit: getAPILimit(logger)
    });
  }

  return data;
};
module.exports = { execute };
