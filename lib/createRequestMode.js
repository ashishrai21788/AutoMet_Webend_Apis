/**
 * CREATE_REQUEST_MODE controls create-request HTTP behavior.
 *   immediate — return REQUESTED immediately after FCM; client waits via FCM/poll (default)
 *   long_poll — removed in Phase 4; treated as immediate for backward-compatible env files
 */
const VALID = new Set(['immediate']);

function getCreateRequestMode() {
  const raw = String(process.env.CREATE_REQUEST_MODE || 'immediate').trim().toLowerCase();
  if (raw === 'long_poll') {
    console.warn('[hardening] CREATE_REQUEST_MODE=long_poll is deprecated; using immediate');
    return 'immediate';
  }
  return VALID.has(raw) ? raw : 'immediate';
}

function isImmediateCreateRequest() {
  return true;
}

function buildImmediateCreateResponse({ tripId, requestId, timeoutAt }) {
  const payload = {
    trip_id: tripId,
    request_id: requestId,
    status: 'REQUESTED',
    timeout_at: timeoutAt
  };
  return {
    success: true,
    message: 'Ride request sent',
    trip_id: tripId,
    request_id: requestId,
    status: 'REQUESTED',
    data: payload
  };
}

module.exports = {
  getCreateRequestMode,
  isImmediateCreateRequest,
  buildImmediateCreateResponse
};
