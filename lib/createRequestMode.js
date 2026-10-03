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

function buildImmediateCreateResponse({ tripId, requestId, timeoutAt, estimate }) {
  const payload = {
    trip_id: tripId,
    request_id: requestId,
    status: 'REQUESTED',
    timeout_at: timeoutAt
  };
  const response = {
    success: true,
    message: 'Ride request sent',
    trip_id: tripId,
    request_id: requestId,
    status: 'REQUESTED',
    data: payload
  };
  if (estimate) {
    // Fare and trip size computed by the server (lib/fare.js), also at the top level for older clients.
    const fields = {
      fare: estimate.fare,
      currency: estimate.currency,
      distance_km: estimate.distance_km,
      estimated_duration_min: estimate.duration_min,
      fare_basis: estimate.fare_basis,
      payment_mode: 'CASH'
    };
    Object.assign(payload, fields);
    Object.assign(response, fields);
  }
  return response;
}

module.exports = {
  getCreateRequestMode,
  isImmediateCreateRequest,
  buildImmediateCreateResponse
};
