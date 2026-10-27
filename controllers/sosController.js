/**
 * SOS: a rider or driver on a ride presses Emergency. The business is told (the trip, both people, the vehicle, where they are) and the
 * business's staff acknowledge and resolve it from the dashboard. The apps only ever open the phone's dialler: the server never asks an
 * app to place a call, and the emergency number it returns is only what the dialler is opened with.
 *
 *   POST /api/v1/rides/sos                        { trip_id, lat?, lng?, accuracy? }   rider or driver (201 new, 200 an open one was updated)
 *   GET  /api/admin/business/sos                  ?status=open|resolved|all             the business's emergencies, open first
 *   POST /api/admin/business/sos/:id/acknowledge                                        staff have seen it
 *   POST /api/admin/business/sos/:id/resolve      { note? }                             closed, with what was done
 *
 * Rules (lib/sos.js): only the trip's own rider or driver, in their own business; during the ride or up to 30 minutes after it completes.
 * One open alert per person per trip: pressing again adds the new location and raises the count. A missing or bad location never stops
 * an alert from being recorded.
 */
const crypto = require('crypto');
const { Tenant, AdminAudit } = require('../models/adminModels');
const { TripDetails } = require('../models/tripDetailsModel');
const { SosAlert } = require('../models/sosModel');
const { Vehicle, DriverVehicleAssignment } = require('../models/fleetModels');
const { createModel } = require('../models/dynamicModel');
const { effectiveTenantId } = require('../lib/appTenant');
const { participantOf } = require('../lib/chat');
const { emergencyNumberFor } = require('../lib/emergency');
const rules = require('../lib/sos');
const c = require('./fleet/common');

const newId = () => `sos_${crypto.randomBytes(8).toString('hex')}`;
const accountOf = (req) => req.user || req.driver || null;
const OPEN = ['OPEN', 'ACKNOWLEDGED'];

async function personOf(role, id, tenantId) {
  try {
    const doc = await createModel(role === 'rider' ? 'users' : 'drivers').findOne(role === 'rider' ? { userId: id } : { driverId: id }).lean();
    return { name: rules.fullName(doc, null), phone: (doc && doc.phone) || null };
  } catch (e) { return { name: null, phone: null }; }
}

async function vehicleOf(driverId, tenantId) {
  try {
    const link = await DriverVehicleAssignment.findOne({ tenantId, driverId, active: true }).lean();
    const v = link ? await Vehicle.findOne({ tenantId, vehicleId: link.vehicleId }).lean() : null;
    return v ? [v.registrationNumber, [v.make, v.model].filter(Boolean).join(' ')].filter(Boolean).join(' · ') : null;
  } catch (e) { return null; }
}

exports.raise = c.handle(async (req, res) => {
  const id = String((req.body && req.body.trip_id) || '').trim();
  if (!id) return c.invalid(res, { trip_id: 'A trip is needed' });
  const trip = await TripDetails.findOne({ trip_id: id }).lean();
  if (!trip) return c.fail(res, 404, 'Ride not found');
  const who = participantOf(trip, req.authRole, req.authActorId);
  if (!who) return c.fail(res, 403, 'You are not part of this ride');
  const business = await effectiveTenantId(accountOf(req));
  if (trip.tenant_id && business && trip.tenant_id !== business) return c.fail(res, 403, 'You are not part of this ride');
  const tenantId = trip.tenant_id || business;
  if (!rules.canRaise(trip)) return c.fail(res, 409, 'An emergency can be raised during a ride, or shortly after it ends.', { code: 'SOS_NOT_AVAILABLE' });

  const tenant = await Tenant.findOne({ tenantId }).lean();
  const emergencyNumber = emergencyNumberFor(tenant && tenant.market && tenant.market.country);
  const now = new Date();
  const loc = rules.cleanLocation(req.body);
  const point = loc ? { ...loc, at: now } : null;

  const open = await SosAlert.findOne({ tenantId, tripId: trip.trip_id, raisedById: who.me, status: { $in: OPEN } }).lean();
  if (open) {
    const locations = [...(open.locations || []), ...(point ? [point] : [])].slice(-rules.MAX_LOCATIONS);
    await SosAlert.findOneAndUpdate({ sosId: open.sosId }, { $set: { presses: (open.presses || 1) + 1, locations, lastPressAt: now } });
    return c.ok(res, { sosId: open.sosId, status: open.status, emergencyNumber }, 200);
  }

  const [me, other, vehicle] = await Promise.all([
    personOf(who.role, who.me, tenantId), personOf(who.otherRole, who.other, tenantId),
    vehicleOf(who.role === 'driver' ? who.me : who.other, tenantId)
  ]);
  const row = await SosAlert.create({
    sosId: newId(), tenantId, tripId: trip.trip_id, raisedByRole: who.role, raisedById: who.me, raisedByName: me.name, raisedByPhone: me.phone,
    otherName: other.name, otherPhone: other.phone, vehicle,
    pickupAddress: (trip.pickup && trip.pickup.address) || null, dropAddress: (trip.drop && trip.drop.address) || null, tripStatus: trip.status,
    status: 'OPEN', presses: 1, locations: point ? [point] : [], lastPressAt: now, createdAt: now
  });
  console.warn(`[sos] ${who.role} ${who.me} raised an emergency on trip ${trip.trip_id} (${tenantId})`);
  return c.ok(res, { sosId: row.sosId, status: row.status, emergencyNumber }, 201);
});

// ---------------------------------------------------------------- staff

exports.list = c.handle(async (req, res) => {
  const wanted = ['open', 'resolved', 'all'].includes(req.query && req.query.status) ? req.query.status : 'open';
  const rows = await req.data.find(SosAlert).lean();
  const needing = rows.filter((r) => OPEN.includes(r.status));
  const rank = { OPEN: 0, ACKNOWLEDGED: 1, RESOLVED: 2 };
  const byUrgency = (a, b) => (rank[a.status] - rank[b.status]) || (new Date(b.createdAt) - new Date(a.createdAt));
  const chosen = wanted === 'open' ? needing : wanted === 'resolved' ? rows.filter((r) => r.status === 'RESOLVED') : rows;
  const items = chosen.sort(byUrgency).slice(0, 100).map(rules.publicAlert);
  return c.ok(res, { items, open: needing.length, unacknowledged: rows.filter((r) => r.status === 'OPEN').length });
});

async function audit(req, action, alert, meta) {
  try {
    await AdminAudit.create({
      tenantId: req.business.tenantId, actorId: req.admin.adminId, actorEmail: req.admin.email, action, targetType: 'sos',
      targetId: alert.sosId, meta: { tripId: alert.tripId, ...(meta || {}) }, ip: req.ip || null
    });
  } catch (e) { console.warn('[sos] audit write failed:', e.message); }
}

const who = (req) => ({ id: req.admin.adminId, email: req.admin.email });

exports.acknowledge = c.handle(async (req, res) => {
  const alert = await req.data.findOne(SosAlert, { sosId: req.params.id });
  if (!alert) return c.fail(res, 404, 'Emergency not found');
  if (alert.status !== 'OPEN') return c.fail(res, 409, alert.status === 'RESOLVED' ? 'This emergency is already resolved' : 'This emergency is already acknowledged');
  const updated = await req.data.update(SosAlert, { sosId: alert.sosId }, { status: 'ACKNOWLEDGED', acknowledgedBy: who(req), acknowledgedAt: new Date() });
  await audit(req, 'sos.acknowledged', alert);
  return c.ok(res, rules.publicAlert(updated || alert));
});

exports.resolve = c.handle(async (req, res) => {
  const note = typeof (req.body && req.body.note) === 'string' ? req.body.note.trim() : '';
  if (note.length > rules.NOTE_MAX) return c.invalid(res, { note: `Write ${rules.NOTE_MAX} characters at most` });
  const alert = await req.data.findOne(SosAlert, { sosId: req.params.id });
  if (!alert) return c.fail(res, 404, 'Emergency not found');
  if (alert.status === 'RESOLVED') return c.fail(res, 409, 'This emergency is already resolved');
  const updated = await req.data.update(SosAlert, { sosId: alert.sosId }, { status: 'RESOLVED', resolvedBy: who(req), resolvedAt: new Date(), resolution: note || null });
  await audit(req, 'sos.resolved', alert, note ? { note } : undefined);
  return c.ok(res, rules.publicAlert(updated || alert));
});
