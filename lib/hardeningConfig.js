const { getRestEnforcementMode, getSocketEnforcementMode } = require('./authMiddleware');
const { getCreateRequestMode } = require('./createRequestMode');

function logHardeningConfig() {
  const restAuth = getRestEnforcementMode();
  const socketAuth = getSocketEnforcementMode();
  const createMode = getCreateRequestMode();
  const schedulerProtected = Boolean(process.env.SCHEDULER_SECRET);

  console.log('[hardening] REST auth:', restAuth);
  console.log('[hardening] Socket auth:', socketAuth);
  console.log('[hardening] create-request mode:', createMode);
  console.log('[hardening] check-timeouts protected:', schedulerProtected ? 'yes' : 'no (set SCHEDULER_SECRET)');
}

module.exports = { logHardeningConfig };
