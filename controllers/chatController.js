/**
 * Ride chat between a ride's rider and its driver. The server decides everything; the apps only show what it returns.
 *
 *   POST /api/v1/rides/chat/send   { trip_id, text, client_id? }      write a message (201; a repeat of the same client_id is 200)
 *   GET  /api/v1/rides/chat        ?trip_id=&after=<message id>&limit= the conversation, oldest first, with the unread count
 *   POST /api/v1/rides/chat/read   { trip_id }                          mark the other person's messages as read
 *   GET  /api/admin/business/trips/:id/chat                              the business's own staff read a trip's conversation
 *
 * Delivery: the other person's app is told live over the socket and by a push (FCM), so it arrives whether the app is open or not.
 * Both are best effort: a failure there never stops the message being stored and answered.
 *
 * Rules (lib/chat.js): only the trip's rider and driver; open from accept until the ride ends; 1 to 500 characters; 20 a minute;
 * a business can switch chat off (tenant.chatEnabled === false). An account of another business is refused.
 */
const crypto = require('crypto');
const { Tenant } = require('../models/adminModels');
const { TripDetails } = require('../models/tripDetailsModel');
const { ChatMessage } = require('../models/chatMessageModel');
const { createModel } = require('../models/dynamicModel');
const { tenantMatch } = require('../lib/tenantScope');
const { effectiveTenantId } = require('../lib/appTenant');
const rules = require('../lib/chat');
const socket = require('../config/socket');
const push = require('../lib/pushNotification');
const c = require('./fleet/common');

const newId = () => `cm_${crypto.randomBytes(8).toString('hex')}`;

// Two messages in the same millisecond would have no order. Each stamp is at least one millisecond after the last one this server made.
let lastStamp = 0;
const stamp = () => { lastStamp = Math.max(Date.now(), lastStamp + 1); return new Date(lastStamp); };
const READ_CAP = 1000;

const accountOf = (req) => req.user || req.driver || null;

/** Loads the trip and checks the caller is one of its two people in this trip's business. Sends the refusal itself and returns null. */
async function openTrip(req, res, tripId) {
  const id = String(tripId || '').trim();
  if (!id) { c.invalid(res, { trip_id: 'A trip is needed' }); return null; }
  const trip = await TripDetails.findOne({ trip_id: id }).lean();
  if (!trip) { c.fail(res, 404, 'Ride not found'); return null; }
  const who = rules.participantOf(trip, req.authRole, req.authActorId);
  if (!who) { c.fail(res, 403, 'You are not part of this ride'); return null; }
  const business = await effectiveTenantId(accountOf(req));
  if (trip.tenant_id && business && trip.tenant_id !== business) { c.fail(res, 403, 'You are not part of this ride'); return null; }
  return { trip, who };
}

async function enabledFor(trip) {
  if (!trip.tenant_id) return true;
  const tenant = await Tenant.findOne({ tenantId: trip.tenant_id }).lean();
  return !tenant || tenant.chatEnabled !== false;
}

const byTime = (a, b) => (new Date(a.createdAt) - new Date(b.createdAt)) || String(a.messageId).localeCompare(String(b.messageId));
const conversation = async (tripId) => (await ChatMessage.find({ tripId }).limit(READ_CAP).lean()).sort(byTime);

async function nameOf(role, id) {
  try {
    const doc = await createModel(role === 'rider' ? 'users' : 'drivers').findOne(role === 'rider' ? { userId: id } : { driverId: id }).select('firstName lastName name').lean();
    // the full name, the same as the chat header shows when the screen is opened from inside the app
    const full = doc && [doc.firstName, doc.lastName].filter((p) => typeof p === 'string' && /[\p{L}\p{N}]/u.test(p)).map((p) => p.trim()).join(' ');
    return full || (doc && doc.name) || (role === 'rider' ? 'Your rider' : 'Your driver');
  } catch (e) { return role === 'rider' ? 'Your rider' : 'Your driver'; }
}

/** Tells the other person's app. Never throws. */
async function notify({ trip, who, row }) {
  const toRider = who.otherRole === 'rider';
  const seenByThem = rules.publicMessage(row, who.otherRole);
  try { (toRider ? socket.emitToUser : socket.emitToDriver)(who.other, 'chat_message', { trip_id: trip.trip_id, message: seenByThem }); } catch (e) { console.warn('[chat] live delivery failed:', e.message); }
  try {
    const title = await nameOf(who.role, who.me);
    await (toRider ? push.sendPushToUser : push.sendPushToDriver)(who.other, {
      title, body: row.text.slice(0, 120), channelId: 'chat_messages', clickAction: 'OPEN_RIDE_CHAT', tag: `chat_${trip.trip_id}`,
      data: { type: 'chat_message', trip_id: trip.trip_id, message_id: row.messageId, sender_name: title }
    });
  } catch (e) { console.warn('[chat] push failed:', e.message); }
}

exports.send = c.handle(async (req, res) => {
  const opened = await openTrip(req, res, req.body && req.body.trip_id);
  if (!opened) return;
  const { trip, who } = opened;
  if (!(await enabledFor(trip))) return c.fail(res, 403, 'Chat is switched off for this service.', { code: 'CHAT_DISABLED' });
  if (!rules.isOpen(trip)) return c.fail(res, 409, 'Chat is available from when the driver accepts until the ride ends.', { code: 'CHAT_CLOSED' });
  const v = rules.validate(req.body && req.body.text);
  if (!v.ok) return c.invalid(res, { text: v.message });

  const sentClientId = req.body && req.body.client_id ? String(req.body.client_id).slice(0, 64) : null;
  const messageId = newId();
  const clientId = sentClientId || messageId;
  if (sentClientId) {
    const earlier = await ChatMessage.findOne({ tripId: trip.trip_id, senderId: who.me, clientId }).lean();
    if (earlier) return c.ok(res, { message: rules.publicMessage(earlier, who.role) });
  }
  const now = stamp();
  const recent = await ChatMessage.find({ tripId: trip.trip_id, senderId: who.me, createdAt: { $gte: new Date(now.getTime() - rules.RATE_WINDOW_MS) } }).limit(rules.RATE_LIMIT + 5).lean();
  if (rules.tooFast(recent, now)) return c.fail(res, 429, 'You are sending messages too fast. Wait a moment.', { code: 'CHAT_RATE_LIMIT' });

  let row;
  try {
    row = await ChatMessage.create({ tenantId: trip.tenant_id || null, messageId, tripId: trip.trip_id, senderRole: who.role, senderId: who.me, recipientId: who.other, text: v.text, clientId, createdAt: now, readAt: null });
  } catch (e) {
    if (e && e.code === 11000 && sentClientId) { // the same retry arrived twice at once
      const earlier = await ChatMessage.findOne({ tripId: trip.trip_id, senderId: who.me, clientId }).lean();
      if (earlier) return c.ok(res, { message: rules.publicMessage(earlier, who.role) });
    }
    throw e;
  }
  const plain = row.toObject ? row.toObject() : row;
  await notify({ trip, who, row: plain });
  return c.ok(res, { message: rules.publicMessage(plain, who.role) }, 201);
});

exports.list = c.handle(async (req, res) => {
  const opened = await openTrip(req, res, req.query && req.query.trip_id);
  if (!opened) return;
  const { trip, who } = opened;
  const all = await conversation(trip.trip_id);
  const unread = all.filter((m) => m.recipientId === who.me && !m.readAt).length;
  let shown = all;
  const after = req.query && req.query.after ? String(req.query.after) : '';
  if (after) { const i = all.findIndex((m) => m.messageId === after); if (i >= 0) shown = all.slice(i + 1); }
  const limit = Math.min(Math.max(parseInt(req.query && req.query.limit, 10) || 200, 1), 500);
  shown = shown.slice(-limit);
  return c.ok(res, { messages: shown.map((m) => rules.publicMessage(m, who.role)), unread, open: rules.isOpen(trip), enabled: await enabledFor(trip) });
});

exports.markRead = c.handle(async (req, res) => {
  const opened = await openTrip(req, res, req.body && req.body.trip_id);
  if (!opened) return;
  const { trip, who } = opened;
  const waiting = (await conversation(trip.trip_id)).filter((m) => m.recipientId === who.me && !m.readAt).slice(0, 200);
  const now = new Date();
  for (const m of waiting) await ChatMessage.findOneAndUpdate({ messageId: m.messageId, readAt: null }, { $set: { readAt: now } });
  if (waiting.length) {
    try { (who.otherRole === 'rider' ? socket.emitToUser : socket.emitToDriver)(who.other, 'chat_read', { trip_id: trip.trip_id, count: waiting.length }); } catch (e) { /* best effort */ }
  }
  return c.ok(res, { read: waiting.length });
});

/** The business's own staff, for disputes and safety. Another business's staff get a 404. */
exports.adminTripChat = c.handle(async (req, res) => {
  const trip = await TripDetails.findOne({ ...tenantMatch(req.business, 'tenant_id'), trip_id: String(req.params.id) }).lean();
  if (!trip) return c.fail(res, 404, 'Trip not found');
  const all = await conversation(trip.trip_id);
  return c.ok(res, { messages: all.map((m) => ({ ...rules.publicMessage(m, 'staff'), mine: false })), total: all.length });
});

// ---- the business's own switch ----
const { AdminAudit } = require('../models/adminModels');
const { clearAppTenantCache } = require('../lib/appTenant');
const configHistory = require('./configHistoryController');

/** GET /api/admin/business/chat-settings */
exports.getSettings = c.handle(async (req, res) => c.ok(res, { enabled: req.business.chatEnabled !== false }));

/** PUT /api/admin/business/chat-settings { enabled } */
exports.setSettings = c.handle(async (req, res) => {
  const wanted = req.body && req.body.enabled;
  if (typeof wanted !== 'boolean') return c.invalid(res, { enabled: 'Choose on or off' });
  const before = req.business.chatEnabled !== false;
  if (before === wanted) return c.ok(res, { enabled: wanted });
  await req.data.update(Tenant, {}, { chatEnabled: wanted });
  clearAppTenantCache();
  await configHistory.track(req, 'business.chat_settings_updated', { chatEnabled: wanted });
  try {
    await AdminAudit.create({ tenantId: req.business.tenantId, actorId: req.admin.adminId, actorEmail: req.admin.email, action: wanted ? 'chat.enabled' : 'chat.disabled', targetType: 'business', targetId: req.business.tenantId, meta: null, ip: req.ip || null });
  } catch (e) { console.warn('[chat] audit write failed:', e.message); }
  return c.ok(res, { enabled: wanted });
});
