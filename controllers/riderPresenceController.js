/**
 * POST /api/v1/rider/presence: the rider app reports where it is while the map is open (about once a minute). Only the
 * signed-in rider can report for themselves; the row is what drivers' "demand nearby" is counted from.
 */
const { createModel } = require('../models/dynamicModel');
const { RiderPresence } = require('../models/riderPresenceModel');
const { effectiveTenantId } = require('../lib/appTenant');

const num = (v) => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN);

async function report(req, res) {
  try {
    const userId = req.authActorId;
    if (!userId || req.authRole !== 'user') return res.status(403).json({ success: false, message: 'Sign in as a rider to share your position', data: null });
    const lat = num(req.body && req.body.lat);
    const lng = num(req.body && req.body.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      return res.status(400).json({ success: false, message: 'lat and lng are required', data: null });
    }
    const area = String((req.body && req.body.area) || '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 80);
    const user = await createModel('users').findOne({ userId }).lean();
    if (!user) return res.status(404).json({ success: false, message: 'Account not found', data: null });
    const tenantId = await effectiveTenantId(user);
    await RiderPresence.findOneAndUpdate(
      { userId },
      { $set: { tenantId: tenantId || null, lat, lng, area, lastSeen: new Date() } },
      { upsert: true, new: true }
    );
    return res.status(200).json({ success: true, message: 'OK', data: null });
  } catch (e) {
    console.error('[rider presence]', e && e.message);
    return res.status(500).json({ success: false, message: 'Could not save your position', data: null });
  }
}

module.exports = { report };
