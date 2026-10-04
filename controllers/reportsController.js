/**
 * Business reports and CSV exports. Numbers come from the business's own trip records, worked out on the server
 * (lib/reports.js); the browser never aggregates raw trips. Every export of personal data is written to the audit log.
 */
const { AdminAudit } = require('../models/adminModels');
const { ServiceRegion, VehicleCategory } = require('../models/businessModels');
const { TripDetails } = require('../models/tripDetailsModel');
const { createModel } = require('../models/dynamicModel');
const { tenantMatch } = require('../lib/tenantScope');
const { startOfDay, dateKey, DAY } = require('../lib/timeZone');
const { buildReport } = require('../lib/reports');
const { groupOf } = require('../lib/tripStatus');
const { toCsv, sendCsv } = require('../lib/csv');
const c = require('./fleet/common');

const Driver = () => createModel('drivers');
const User = () => createModel('users');
const MAX_TRIPS = 20000;
const MAX_DAYS = 92;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

const fullName = (u) => [u.firstName, u.lastName].filter(Boolean).join(' ').trim() || u.name || '';
const tzOf = (req) => (req.business.market && req.business.market.timezone) || 'UTC';

/**
 * The date range of a report. `from` and `to` are calendar days in the business's own time zone (YYYY-MM-DD, both
 * included); with none given it is the last 30 days. Returns { from, to } as instants, or { error }.
 */
function parseRange(query, tz, now = new Date()) {
  const to = query.to ? String(query.to) : dateKey(now, tz);
  if (!DAY_RE.test(to) || Number.isNaN(Date.parse(`${to}T00:00:00Z`))) return { error: { to: 'Use a date like 2026-10-04' } };
  const fromDay = query.from ? String(query.from) : dateKey(new Date(startOfDay(new Date(`${to}T12:00:00Z`), tz).getTime() - 29 * DAY), tz);
  if (!DAY_RE.test(fromDay) || Number.isNaN(Date.parse(`${fromDay}T00:00:00Z`))) return { error: { from: 'Use a date like 2026-10-04' } };
  const from = startOfDay(new Date(`${fromDay}T12:00:00Z`), tz);
  const end = new Date(startOfDay(new Date(`${to}T12:00:00Z`), tz).getTime() + DAY - 1);
  if (end < from) return { error: { to: 'The end date is before the start date' } };
  if (Math.round((end.getTime() - from.getTime()) / DAY) > MAX_DAYS) return { error: { from: `Choose a range of at most ${MAX_DAYS} days` } };
  return { from, to: end, fromDay, toDay: to };
}

function tripFilter(req, range) {
  const filter = { ...tenantMatch(req.business, 'tenant_id'), requested_at: { $gte: range.from, $lte: range.to } };
  for (const [param, field] of [['regionId', 'region_id'], ['categoryId', 'category_id'], ['driverId', 'driver_id']]) {
    const v = String(req.query[param] || '').trim();
    if (v) filter[field] = v;
  }
  return filter;
}

async function loadTrips(req, range, select) {
  const rows = await TripDetails.find(tripFilter(req, range)).select(select).sort({ requested_at: -1 }).limit(MAX_TRIPS + 1).lean();
  const partial = rows.length > MAX_TRIPS;
  return { rows: partial ? rows.slice(0, MAX_TRIPS) : rows, partial };
}

async function audit(req, action, meta) {
  try {
    await AdminAudit.create({ tenantId: req.business.tenantId, actorId: req.admin.adminId, actorEmail: req.admin.email, action, targetType: 'export', targetId: null, meta, ip: req.ip || null });
  } catch (e) {
    console.warn('[reports] audit write failed:', e.message);
  }
}

const REPORT_FIELDS = 'trip_id status requested_at responded_at started_at completed_at fare currency fare_basis payment_mode category_id region_id driver_id user_id distance_km fare_breakdown';

exports.summary = c.handle(async (req, res) => {
  const tz = tzOf(req);
  const range = parseRange(req.query, tz);
  if (range.error) return c.invalid(res, range.error);
  const { rows, partial } = await loadTrips(req, range, REPORT_FIELDS);

  const driverIds = [...new Set(rows.map((t) => t.driver_id).filter(Boolean))];
  const [drivers, categories, regions] = await Promise.all([
    driverIds.length ? req.legacyData.find(Driver(), { driverId: { $in: driverIds } }).select('driverId firstName lastName name phone').lean() : [],
    req.data.find(VehicleCategory).select('categoryId name').lean(),
    req.data.find(ServiceRegion).select('regionId city zoneName').lean()
  ]);
  const report = buildReport({
    trips: rows, from: range.from, to: range.to, tz,
    driverNames: new Map(drivers.map((d) => [d.driverId, fullName(d) || d.phone || d.driverId])),
    categoryNames: new Map(categories.map((x) => [x.categoryId, x.name])),
    regionNames: new Map(regions.map((r) => [r.regionId, `${r.city}${r.zoneName && r.zoneName !== 'All areas' ? ` · ${r.zoneName}` : ''}`]))
  });
  return c.ok(res, { ...report, currency: (req.business.market && req.business.market.currency) || null, fromDay: range.fromDay, toDay: range.toDay, partial, rowLimit: MAX_TRIPS });
});

// ---------------------------------------------------------------- exports

exports.tripsCsv = c.handle(async (req, res) => {
  const tz = tzOf(req);
  const range = parseRange(req.query, tz);
  if (range.error) return c.invalid(res, range.error);
  const statusGroup = String(req.query.statusGroup || '').trim();
  const { rows, partial } = await loadTrips(req, range, 'trip_id status requested_at responded_at started_at completed_at fare currency fare_basis payment_mode category_id region_id driver_id user_id distance_km pickup drop cancelled_by cancellation_reason');
  const kept = statusGroup ? rows.filter((t) => groupOf(t.status) === statusGroup) : rows;

  const userIds = [...new Set(kept.map((t) => t.user_id))];
  const driverIds = [...new Set(kept.map((t) => t.driver_id))];
  const [users, drivers, categories, regions] = await Promise.all([
    userIds.length ? req.legacyData.find(User(), { userId: { $in: userIds } }).select('userId firstName lastName phone').lean() : [],
    driverIds.length ? req.legacyData.find(Driver(), { driverId: { $in: driverIds } }).select('driverId firstName lastName name phone').lean() : [],
    req.data.find(VehicleCategory).select('categoryId name').lean(),
    req.data.find(ServiceRegion).select('regionId city zoneName').lean()
  ]);
  const userBy = new Map(users.map((u) => [u.userId, u]));
  const driverBy = new Map(drivers.map((d) => [d.driverId, d]));
  const catBy = new Map(categories.map((x) => [x.categoryId, x.name]));
  const regBy = new Map(regions.map((r) => [r.regionId, r.city]));

  const csv = toCsv(kept, [
    { header: 'Trip ID', value: (t) => t.trip_id }, { header: 'Requested at (UTC)', value: (t) => t.requested_at }, { header: 'Status', value: (t) => t.status },
    { header: 'Rider', value: (t) => (userBy.get(t.user_id) ? fullName(userBy.get(t.user_id)) : '') }, { header: 'Rider phone', value: (t) => (userBy.get(t.user_id) || {}).phone },
    { header: 'Driver', value: (t) => (driverBy.get(t.driver_id) ? fullName(driverBy.get(t.driver_id)) || driverBy.get(t.driver_id).phone : '') },
    { header: 'Category', value: (t) => catBy.get(t.category_id) || '' }, { header: 'Region', value: (t) => regBy.get(t.region_id) || '' },
    { header: 'Pickup', value: (t) => t.pickup && t.pickup.address }, { header: 'Destination', value: (t) => t.drop && t.drop.address },
    { header: 'Distance km', value: (t) => t.distance_km }, { header: 'Fare', value: (t) => t.fare }, { header: 'Currency', value: (t) => t.currency },
    { header: 'Fare basis', value: (t) => t.fare_basis }, { header: 'Payment mode', value: (t) => t.payment_mode },
    { header: 'Driver responded at (UTC)', value: (t) => t.responded_at }, { header: 'Started at (UTC)', value: (t) => t.started_at }, { header: 'Completed at (UTC)', value: (t) => t.completed_at },
    { header: 'Cancelled by', value: (t) => t.cancelled_by }, { header: 'Cancellation reason', value: (t) => t.cancellation_reason }
  ]);
  await audit(req, 'export.trips', { rows: kept.length, from: range.fromDay, to: range.toDay, statusGroup: statusGroup || undefined });
  res.set({ 'X-Row-Count': String(kept.length), 'X-Truncated': String(partial) });
  return sendCsv(res, `trips_${range.fromDay}_to_${range.toDay}.csv`, csv);
});

exports.ridersCsv = c.handle(async (req, res) => {
  const rows = await req.legacyData.find(User(), {}).select('userId firstName lastName phone email isPhoneVerified accountStatus createdAt lastActive').sort({ createdAt: -1 }).limit(MAX_TRIPS + 1).lean();
  const partial = rows.length > MAX_TRIPS;
  const kept = partial ? rows.slice(0, MAX_TRIPS) : rows;
  const trips = await TripDetails.find({ ...tenantMatch(req.business, 'tenant_id') }).select('user_id status').limit(MAX_TRIPS).lean();
  const counts = new Map();
  for (const t of trips) { const e = counts.get(t.user_id) || { total: 0, completed: 0 }; e.total++; if (t.status === 'COMPLETED') e.completed++; counts.set(t.user_id, e); }
  const csv = toCsv(kept, [
    { header: 'Rider ID', value: (u) => u.userId }, { header: 'Name', value: (u) => fullName(u) }, { header: 'Phone', value: (u) => u.phone }, { header: 'Email', value: (u) => u.email },
    { header: 'Phone verified', value: (u) => (u.isPhoneVerified ? 'Yes' : 'No') }, { header: 'Account status', value: (u) => u.accountStatus || 'ACTIVE' },
    { header: 'Joined (UTC)', value: (u) => u.createdAt }, { header: 'Last active (UTC)', value: (u) => u.lastActive },
    { header: 'Trips', value: (u) => (counts.get(u.userId) || { total: 0 }).total }, { header: 'Completed trips', value: (u) => (counts.get(u.userId) || { completed: 0 }).completed }
  ]);
  await audit(req, 'export.riders', { rows: kept.length });
  res.set({ 'X-Row-Count': String(kept.length), 'X-Truncated': String(partial) });
  return sendCsv(res, 'riders.csv', csv);
});

exports.driversCsv = c.handle(async (req, res) => {
  const rows = await req.legacyData.find(Driver(), {}).select('driverId firstName lastName name phone email accountStatus driverVerificationStatus verificationExpiresAt operatingRegionId eligibleCategoryId isOnline lastActive locationUpdatedAt createdAt').sort({ createdAt: -1 }).limit(MAX_TRIPS + 1).lean();
  const partial = rows.length > MAX_TRIPS;
  const kept = partial ? rows.slice(0, MAX_TRIPS) : rows;
  const [categories, regions] = await Promise.all([req.data.find(VehicleCategory).select('categoryId name').lean(), req.data.find(ServiceRegion).select('regionId city').lean()]);
  const catBy = new Map(categories.map((x) => [x.categoryId, x.name]));
  const regBy = new Map(regions.map((r) => [r.regionId, r.city]));
  const csv = toCsv(kept, [
    { header: 'Driver ID', value: (d) => d.driverId }, { header: 'Name', value: (d) => fullName(d) }, { header: 'Phone', value: (d) => d.phone }, { header: 'Email', value: (d) => (d.email && !/@(driver|placeholder)\./i.test(d.email) ? d.email : '') },
    { header: 'Account status', value: (d) => d.accountStatus || 'ACTIVE' }, { header: 'Verification', value: (d) => d.driverVerificationStatus || 'INCOMPLETE' },
    { header: 'Documents valid until (UTC)', value: (d) => d.verificationExpiresAt }, { header: 'Region', value: (d) => regBy.get(d.operatingRegionId) || '' },
    { header: 'Eligible category', value: (d) => catBy.get(d.eligibleCategoryId) || '' }, { header: 'Online', value: (d) => (d.isOnline ? 'Yes' : 'No') },
    { header: 'Last seen (UTC)', value: (d) => d.locationUpdatedAt || d.lastActive }, { header: 'Registered (UTC)', value: (d) => d.createdAt }
  ]);
  await audit(req, 'export.drivers', { rows: kept.length });
  res.set({ 'X-Row-Count': String(kept.length), 'X-Truncated': String(partial) });
  return sendCsv(res, 'drivers.csv', csv);
});

exports.helpers = { parseRange };
