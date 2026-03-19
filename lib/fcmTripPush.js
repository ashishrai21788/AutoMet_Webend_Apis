const { sendFCMNotification } = require('../config/firestore');

// Set to 0 to only require FCM token (no lastActive check). Set > 0 to require driver active within N minutes.
const DRIVER_INACTIVE_MAX_MINUTES = Number(process.env.DRIVER_INACTIVE_MAX_MINUTES) || 0;
const FCM_RETRY_ATTEMPTS = 2;
const FCM_RETRY_DELAY_MS = 2000;

const FCM_ERROR_INVALID_TOKEN = [
  'messaging/invalid-registration-token',
  'messaging/invalid-argument'
];
const FCM_ERROR_UNREGISTERED = [
  'messaging/registration-token-not-registered',
  'messaging/invalid-registration-token'
];
const FCM_ERROR_TRANSIENT = [
  'messaging/unavailable',
  'messaging/internal',
  'messaging/server-unavailable'
];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Get FCM token and last-active from driver document.
 * Supports drivers collection (fcmToken, lastActive). Optionally driver_devices if present.
 * @param {object} driver - Driver document (from drivers collection)
 * @returns {{ fcmToken: string|null, lastActive: Date|null }}
 */
function getDriverFcmInfo(driver) {
  if (!driver) return { fcmToken: null, lastActive: null };
  const rawToken = driver.fcmToken ?? driver.fcm_token ?? null;
  const fcmToken = (rawToken != null && typeof rawToken === 'string' && rawToken.trim())
    ? rawToken.trim()
    : null;
  const lastActive = driver.lastActive != null
    ? (driver.lastActive instanceof Date ? driver.lastActive : new Date(driver.lastActive))
    : null;
  return { fcmToken, lastActive };
}

/**
 * Validate that driver is reachable: FCM token present; optionally require lastActive within window.
 * When DRIVER_INACTIVE_MAX_MINUTES is 0 (default), only FCM token is required (driver isOnline is checked by caller).
 * @param {object} driver - Driver document from MongoDB
 * @returns {{ reachable: boolean, reason?: string }}
 */
function isDriverReachable(driver) {
  const { fcmToken, lastActive } = getDriverFcmInfo(driver);
  if (!fcmToken || fcmToken.length === 0) {
    return { reachable: false, reason: 'no_fcm_token' };
  }
  if (DRIVER_INACTIVE_MAX_MINUTES > 0 && lastActive != null) {
    const cutoff = new Date(Date.now() - DRIVER_INACTIVE_MAX_MINUTES * 60 * 1000);
    const lastActiveDate = lastActive instanceof Date ? lastActive : new Date(lastActive);
    if (lastActiveDate < cutoff) {
      return { reachable: false, reason: 'driver_inactive_too_long' };
    }
  }
  return { reachable: true };
}

/**
 * Check if FCM error indicates invalid/unregistered token (should clear token in DB).
 */
function isInvalidOrUnregisteredToken(errorCode) {
  if (!errorCode) return false;
  const code = String(errorCode);
  return FCM_ERROR_INVALID_TOKEN.some((c) => code.includes(c)) ||
    FCM_ERROR_UNREGISTERED.some((c) => code.includes(c));
}

/**
 * Check if error is transient (retry recommended).
 */
function isTransientError(errorCode) {
  if (!errorCode) return true;
  const code = String(errorCode);
  return FCM_ERROR_TRANSIENT.some((c) => code.includes(c));
}

/**
 * Send ride-request FCM with retry. On invalid/unregistered token, clear driver fcmToken.
 * @param {string} fcmToken
 * @param {string} tripId
 * @param {object} payload - pickup_address, drop_address, pickup_lat/lng, drop_lat/lng, ride_note
 * @param {object} options - { DriverModel, driverId } to clear token on failure
 * @returns {Promise<{ success: boolean, messageId?: string, pushStatus: 'DELIVERED'|'FAILED', error?: string, invalidToken?: boolean }>}
 */
async function sendRideRequestPushWithRetry(fcmToken, tripId, payload, options = {}) {
  const { DriverModel, driverId } = options;
  const fcmPayload = {
    title: 'New ride request',
    body: `${payload.pickup_address || ''} → ${payload.drop_address || ''}`.trim() || 'New ride request',
    channelId: 'driver_notifications',
    data: {
      type: 'RIDE_REQUEST',
      trip_id: tripId,
      pickup_address: String(payload.pickup_address || ''),
      drop_address: String(payload.drop_address || ''),
      pickup_lat: String(payload.pickup_lat ?? ''),
      pickup_lng: String(payload.pickup_lng ?? ''),
      drop_lat: String(payload.drop_lat ?? ''),
      drop_lng: String(payload.drop_lng ?? ''),
      ride_note: String(payload.ride_note || ''),
      rider_name: String(payload.rider_name || '')
    }
  };

  let lastResult;
  for (let attempt = 0; attempt <= FCM_RETRY_ATTEMPTS; attempt++) {
    lastResult = await sendFCMNotification(fcmToken, fcmPayload);
    if (lastResult.success) {
      return {
        success: true,
        messageId: lastResult.messageId,
        pushStatus: 'DELIVERED'
      };
    }
    const errorCode = lastResult.errorCode;
    if (isInvalidOrUnregisteredToken(errorCode)) {
      if (DriverModel && driverId) {
        try {
          await DriverModel.updateOne(
            { driverId },
            { $set: { fcmToken: null, updatedAt: new Date() } }
          );
        } catch (e) {
          if (process.env.NODE_ENV === 'development') console.warn('[FCM] Clear token update failed:', e.message);
        }
      }
      return {
        success: false,
        pushStatus: 'FAILED',
        error: lastResult.error,
        invalidToken: true
      };
    }
    if (attempt < FCM_RETRY_ATTEMPTS && isTransientError(errorCode)) {
      await sleep(FCM_RETRY_DELAY_MS);
      continue;
    }
    break;
  }

  return {
    success: false,
    pushStatus: 'FAILED',
    error: lastResult.error,
    invalidToken: false
  };
}

module.exports = {
  getDriverFcmInfo,
  isDriverReachable,
  sendRideRequestPushWithRetry,
  DRIVER_INACTIVE_MAX_MINUTES
};
