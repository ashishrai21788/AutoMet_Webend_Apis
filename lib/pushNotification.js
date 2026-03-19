/**
 * Common push notification service.
 * Accepts ready-to-send payload and recipient (driver id, user id, or raw FCM token), resolves token if needed, and sends via FCM.
 */

const { createModel } = require('../models/dynamicModel');
const { sendFCMNotification } = require('../config/firestore');

/**
 * Resolve FCM token for a driver or user.
 * @param {'driver'|'user'} to - Recipient type
 * @param {string} id - driverId or userId
 * @returns {Promise<string|null>} FCM token or null
 */
async function getFcmToken(to, id) {
  if (!id || typeof id !== 'string' || !id.trim()) return null;
  const key = to === 'driver' ? 'driverId' : 'userId';
  const collection = to === 'driver' ? 'drivers' : 'users';
  const Model = createModel(collection);
  const doc = await Model.findOne({ [key]: id.trim() }).select('fcmToken').lean();
  if (!doc) return null;
  const token = doc.fcmToken ?? doc.fcm_token ?? null;
  if (token != null && typeof token === 'string' && token.trim()) return token.trim();
  return null;
}

/**
 * Send push notification to a driver, user, or raw token.
 * @param {object} options - Ready-to-send notification options
 * @param {'driver'|'user'|'token'} options.to - Recipient type: 'driver' | 'user' | 'token'
 * @param {string} [options.id] - driverId or userId (required when to is 'driver' or 'user')
 * @param {string} [options.token] - Raw FCM token (required when to is 'token')
 * @param {string} options.title - Notification title
 * @param {string} [options.body] - Notification body
 * @param {Record<string, string>} [options.data] - Data payload (values will be stringified if not strings)
 * @param {string} [options.channelId] - Android channel (default 'default')
 * @returns {Promise<{ success: true, messageId: string }|{ success: false, error: string }>}
 */
async function sendPush(options) {
  const { to, id, token: rawToken, title, body, data, channelId } = options || {};
  let fcmToken = null;
  if (to === 'token' && rawToken && typeof rawToken === 'string' && rawToken.trim()) {
    fcmToken = rawToken.trim();
  } else if ((to === 'driver' || to === 'user') && id) {
    fcmToken = await getFcmToken(to, id);
  }
  if (!fcmToken) {
    return { success: false, error: to === 'token' ? 'FCM token is required' : `No FCM token found for ${to}:${id}` };
  }
  const payload = {
    title: title || 'Notification',
    body: body || '',
    data: data && typeof data === 'object' ? data : undefined,
    channelId: channelId && typeof channelId === 'string' ? channelId.trim() : undefined
  };
  return sendFCMNotification(fcmToken, payload);
}

/**
 * Send push to a driver by driverId.
 * @param {string} driverId
 * @param {{ title: string, body?: string, data?: Record<string, string>, channelId?: string }} payload
 */
async function sendPushToDriver(driverId, payload) {
  return sendPush({ to: 'driver', id: driverId, ...payload });
}

/**
 * Send push to a user by userId.
 * @param {string} userId
 * @param {{ title: string, body?: string, data?: Record<string, string>, channelId?: string }} payload
 */
async function sendPushToUser(userId, payload) {
  return sendPush({ to: 'user', id: userId, ...payload });
}

/**
 * Send push to a device when you already have the FCM token.
 * @param {string} fcmToken
 * @param {{ title: string, body?: string, data?: Record<string, string>, channelId?: string }} payload
 */
async function sendPushByToken(fcmToken, payload) {
  return sendPush({ to: 'token', token: fcmToken, ...payload });
}

module.exports = {
  sendPush,
  sendPushToDriver,
  sendPushToUser,
  sendPushByToken,
  getFcmToken
};
