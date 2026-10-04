/**
 * Operations screens for one business: audit log, alerts, live statistics, riders and trips.
 * Everything is read through the business named by X-App-Id (req.business / req.data / req.legacyData), so a business
 * can only ever see its own records. Nothing here is a mock: what is not recorded yet is reported as not available.
 */
const { AdminAudit } = require('../models/adminModels');
const { ServiceRegion, VehicleCategory, FareRule } = require('../models/businessModels');
const { Vehicle, DriverVehicleAssignment, DriverDocument, VehicleDocument } = require('../models/fleetModels');
const { TripDetails } = require('../models/tripDetailsModel');
const TripEvent = require('../models/tripEventModel');
const { createModel } = require('../models/dynamicModel');
const { tenantMatch } = require('../lib/tenantScope');
const { ONGOING, CANCELLED, computeRates } = require('../lib/adminDashboard');
const { computeAlerts, summarize } = require('../lib/alerts');
const { computeSummary } = require('./fleet/availability');
const { driverEligibility } = require('../lib/eligibility');
const { presenceOf, positionOf, config: locationConfig } = require('../lib/driverLocation');
const { startOfDay, dateKey } = require('../lib/timeZone');
const c = require('./fleet/common');

const Driver = () => createModel('drivers');
const User = () => createModel('users');
const DAY = 24 * 60 * 60 * 1000;
const MAX_ROWS = 5000; // the most records one summary reads; beyond this it says the numbers are partial

const tripScope = (req) => tenantMatch(req.business, 'tenant_id');
const fullName = (u) => [u.firstName, u.lastName].filter(Boolean).join(' ').trim() || u.name || '';
const validDate = (v) => { const d = new Date(v); return Number.isNaN(d.getTime()) ? null : d; };

/** Trip statuses grouped the way an operator thinks about them. */
const STATUS_GROUPS = {
  searching: ['REQUESTED'],
  active: ONGOING,
  completed: ['COMPLETED'],
  cancelled: CANCELLED,
  unanswered: ['REJECTED', 'REJECTED_WITH_REASON', 'NO_RESPONSE']
};
const groupOf = (status) => Object.keys(STATUS_GROUPS).find((g) => STATUS_GROUPS[g].includes(status)) || 'other';

// ---------------------------------------------------------------- audit log

const SECRET_KEY = /pass(word)?|token|secret|authorization|url|link|key|number|otp/i;
/** What the log shows of an event's details: never secrets, document numbers or links. */
function safeMeta(meta) {
  if (!meta || typeof meta !== 'object') return null;
  const out = {};
  for (const [k, v] of Object.entries(meta)) {
    if (SECRET_KEY.test(k) || v === undefined || v === null || v === '') continue;
    out[k] = typeof v === 'object' ? JSON.stringify(v).slice(0, 200) : String(v).slice(0, 200);
  }
  return Object.keys(out).length ? out : null;
}

exports.audit = c.handle(async (req, res) => {
  const { page, pageSize, skip } = c.pageParams(req.query);
  const filter = { tenantId: req.business.tenantId };
  const q = String(req.query.q || '').trim().slice(0, 80);
  if (q) filter.$or = [{ actorEmail: { $regex: c.escapeRegex(q), $options: 'i' } }, { targetId: { $regex: c.escapeRegex(q), $options: 'i' } }, { action: { $regex: c.escapeRegex(q), $options: 'i' } }];
  const action = String(req.query.action || '').trim();
  if (action) filter.action = { $regex: `^${c.escapeRegex(action)}`, $options: 'i' };
  const targetType = String(req.query.targetType || '').trim();
  if (targetType) filter.targetType = targetType;
  const actor = String(req.query.actor || '').trim().toLowerCase();
  if (actor) filter.actorEmail = actor;
  const from = req.query.from ? validDate(req.query.from) : null;
  const to = req.query.to ? validDate(req.query.to) : null;
  if (req.query.from && !from) return c.invalid(res, { from: 'Enter a valid date' });
  if (req.query.to && !to) return c.invalid(res, { to: 'Enter a valid date' });
  if (from || to) filter.at = { ...(from ? { $gte: from } : {}), ...(to ? { $lte: to } : {}) };

  const [rows, total, recent] = await Promise.all([
    AdminAudit.find(filter).sort({ at: -1 }).skip(skip).limit(pageSize).lean(),
    AdminAudit.countDocuments(filter),
    AdminAudit.find({ tenantId: req.business.tenantId }).sort({ at: -1 }).limit(500).lean()
  ]);
  const items = rows.map((r) => ({
    id: String(r._id || `${r.at && new Date(r.at).getTime()}-${r.action}-${r.targetId}`), at: r.at, action: r.action, actorEmail: r.actorEmail || null,
    targetType: r.targetType || null, targetId: r.targetId || null, details: safeMeta(r.meta)
  }));
  return c.ok(res, {
    items, total, page, pageSize,
    // choices for the filters, taken from the most recent events
    facets: { actions: [...new Set(recent.map((r) => r.action))].sort(), targetTypes: [...new Set(recent.map((r) => r.targetType).filter(Boolean))].sort(), actors: [...new Set(recent.map((r) => r.actorEmail).filter(Boolean))].sort() }
  });
});

// ---------------------------------------------------------------- alerts

exports.alerts = c.handle(async (req, res) => {
  const [regions, categories, fareRules, drivers, vehicles, assignments, driverDocs, vehicleDocs] = await Promise.all([
    req.data.find(ServiceRegion).lean(), req.data.find(VehicleCategory).lean(), req.data.find(FareRule, { active: true }).lean(),
    req.legacyData.find(Driver(), {}).select('driverId firstName lastName name phone accountStatus driverVerificationStatus isOnline lastLocation locationUpdatedAt').limit(MAX_ROWS).lean(),
    req.data.find(Vehicle).select('vehicleId registrationNumber status').limit(MAX_ROWS).lean(),
    req.data.find(DriverVehicleAssignment, { active: true }).lean(),
    req.data.find(DriverDocument).select('docId driverId type expiryDate status submittedAt').limit(MAX_ROWS).lean(),
    req.data.find(VehicleDocument).select('docId vehicleId type expiryDate status submittedAt').limit(MAX_ROWS).lean()
  ]);
  const alerts = computeAlerts({
    tenant: req.business, regions, categories, fareRules, drivers, vehicles, driverDocs, vehicleDocs,
    assignedDriverIds: assignments.map((a) => a.driverId)
  });
  return c.ok(res, { alerts, counts: summarize(alerts), generatedAt: new Date().toISOString() });
});

// ---------------------------------------------------------------- live statistics

exports.stats = c.handle(async (req, res) => {
  const scope = tripScope(req);
  const now = new Date();
  const tz = (req.business.market && req.business.market.timezone) || 'UTC';
  const dayStart = startOfDay(now, tz); // "today" is the business's own calendar day, not the server's
  const weekStart = new Date(dayStart.getTime() - 6 * DAY + 0);

  const [availability, active, searching, requestedToday, completedToday, cancelledToday, completedRows, weekRows, riders, newRiders] = await Promise.all([
    computeSummary(req),
    TripDetails.countDocuments({ ...scope, status: { $in: ONGOING } }),
    TripDetails.countDocuments({ ...scope, status: { $in: STATUS_GROUPS.searching } }),
    TripDetails.countDocuments({ ...scope, requested_at: { $gte: dayStart } }),
    TripDetails.countDocuments({ ...scope, status: 'COMPLETED', completed_at: { $gte: dayStart } }),
    TripDetails.countDocuments({ ...scope, status: { $in: CANCELLED }, requested_at: { $gte: dayStart } }),
    TripDetails.find({ ...scope, status: 'COMPLETED', completed_at: { $gte: dayStart } }).select('fare currency').limit(MAX_ROWS).lean(),
    TripDetails.find({ ...scope, requested_at: { $gte: weekStart } }).select('status requested_at').limit(MAX_ROWS).lean(),
    req.legacyData.count(User(), {}),
    req.legacyData.count(User(), { createdAt: { $gte: weekStart } })
  ]);

  const revenueToday = completedRows.reduce((sum, t) => sum + (Number(t.fare) || 0), 0);
  const counts = {};
  const byDay = new Map();
  for (let i = 0; i < 7; i++) byDay.set(dateKey(new Date(weekStart.getTime() + i * DAY + 12 * 3600000), tz), { requested: 0, completed: 0, cancelled: 0 });
  for (const t of weekRows) {
    counts[t.status] = (counts[t.status] || 0) + 1;
    const bucket = byDay.get(dateKey(t.requested_at, tz));
    if (!bucket) continue;
    bucket.requested++;
    if (t.status === 'COMPLETED') bucket.completed++;
    if (CANCELLED.includes(t.status)) bucket.cancelled++;
  }
  const days = [...byDay.entries()].map(([key, v]) => ({ date: key, ...v }));

  return c.ok(res, {
    drivers: {
      total: availability.totalDrivers, activeAccounts: availability.activeAccounts, eligible: availability.eligible,
      online: availability.online, onlineEligible: availability.onlineEligible, onlineNotEligible: availability.onlineNotEligible,
      onlineLive: availability.onlineLive, onlineStale: availability.onlineStale, onlineNoSignal: availability.onlineNoSignal, partial: !!availability.truncated
    },
    trips: { active, searching, requestedToday, completedToday, cancelledToday, ...computeRates(counts), last7Days: days, partial: weekRows.length >= MAX_ROWS },
    revenue: { today: Math.round(revenueToday * 100) / 100, currency: (req.business.market && req.business.market.currency) || null, basis: 'completed trip fares today (estimates until the final fare is recorded)', partial: completedRows.length >= MAX_ROWS },
    riders: { total: riders, newThisWeek: newRiders },
    // honest about what the platform does not record yet
    notAvailable: ['payments', 'ratings']
  });
});

// ---------------------------------------------------------------- live map

const MAX_MAP_DRIVERS = 2000;
const MAP_TRIP_STATUSES = [...ONGOING, ...STATUS_GROUPS.searching];

/**
 * The picture for the live map: this business's online drivers with their last position and how fresh it is, its
 * active trips, and its service areas. Drivers that are online but have never sent a position (an older app version)
 * cannot be placed on a map; they are only counted.
 */
exports.liveMap = c.handle(async (req, res) => {
  const now = new Date();
  const cfg = locationConfig();
  const [drivers, assignments, vehicles, regions, trips] = await Promise.all([
    req.legacyData.find(Driver(), { isOnline: true })
      .select('driverId firstName lastName name phone accountStatus driverVerificationStatus verificationExpiresAt operatingRegionId eligibleCategoryId isOnline lastActive lastLocation locationUpdatedAt locationHeading locationSpeedKph locationRegionId')
      .limit(MAX_MAP_DRIVERS + 1).lean(),
    req.data.find(DriverVehicleAssignment, { active: true }).lean(),
    req.data.find(Vehicle).select('vehicleId registrationNumber make model categoryId status verificationStatus verificationExpiresAt operatingRegionId').lean(),
    req.data.find(ServiceRegion).lean(),
    TripDetails.find({ ...tripScope(req), status: { $in: MAP_TRIP_STATUSES } }).sort({ requested_at: -1 }).limit(500).lean()
  ]);
  const truncated = drivers.length > MAX_MAP_DRIVERS;
  const rows = truncated ? drivers.slice(0, MAX_MAP_DRIVERS) : drivers;
  const vehicleById = new Map(vehicles.map((v) => [v.vehicleId, v]));
  const vehicleByDriver = new Map(assignments.map((a) => [a.driverId, vehicleById.get(a.vehicleId) || null]));
  const regionById = new Map(regions.map((r) => [r.regionId, r]));
  const tripByDriver = new Map(trips.filter((t) => ONGOING.includes(t.status)).map((t) => [t.driver_id, t.trip_id]));

  const counts = { live: 0, stale: 0, noSignal: 0, eligibleLive: 0 };
  const mapped = [];
  for (const d of rows) {
    const p = presenceOf(d, now, cfg);
    const e = driverEligibility({ driver: d, vehicle: vehicleByDriver.get(d.driverId) || null, region: d.operatingRegionId ? regionById.get(d.operatingRegionId) || null : null });
    if (p.state === 'NO_SIGNAL') { counts.noSignal++; continue; }
    if (p.state === 'LIVE') { counts.live++; if (e.eligible) counts.eligibleLive++; } else counts.stale++;
    const pos = positionOf(d);
    const vehicle = vehicleByDriver.get(d.driverId) || null;
    const region = d.locationRegionId ? regionById.get(d.locationRegionId) : null;
    mapped.push({
      id: d.driverId, name: c.driverName(d), phone: d.phone || null, lat: pos.lat, lng: pos.lng, heading: d.locationHeading ?? null, speedKph: d.locationSpeedKph ?? null,
      presence: p.state, ageSeconds: p.ageSeconds, updatedAt: d.locationUpdatedAt, eligible: e.eligible, eligibilityReasons: e.reasons.map((r) => r.code),
      accountStatus: d.accountStatus || 'ACTIVE', categoryId: d.eligibleCategoryId || null, regionId: d.locationRegionId || null,
      regionName: region ? region.city : null,
      vehicle: vehicle ? { plate: vehicle.registrationNumber, label: [vehicle.make, vehicle.model].filter(Boolean).join(' ') } : null,
      currentTripId: tripByDriver.get(d.driverId) || null
    });
  }

  const activeTrips = trips.map((t) => ({
    id: t.trip_id, status: t.status, statusGroup: groupOf(t.status), requestedAt: t.requested_at, driverId: t.driver_id, riderId: t.user_id,
    pickup: t.pickup ? { address: t.pickup.address, lat: t.pickup.lat, lng: t.pickup.lng } : null,
    drop: t.drop ? { address: t.drop.address, lat: t.drop.lat, lng: t.drop.lng } : null,
    fare: t.fare ?? null, currency: t.currency || null
  }));

  return c.ok(res, {
    generatedAt: now.toISOString(), freshSeconds: cfg.freshSeconds, staleOfflineSeconds: cfg.staleOfflineSeconds, refreshSeconds: cfg.nextHeartbeatSeconds,
    drivers: mapped, trips: activeTrips,
    regions: regions.filter((r) => r.active && r.center && Number.isFinite(r.radiusKm)).map((r) => ({ id: r.regionId, name: `${r.city}${r.zoneName && r.zoneName !== 'All areas' ? ` · ${r.zoneName}` : ''}`, center: { lat: r.center.lat, lng: r.center.lng }, radiusKm: r.radiusKm })),
    counts: { ...counts, online: rows.length, activeTrips: trips.filter((t) => ONGOING.includes(t.status)).length, searching: trips.filter((t) => t.status === 'REQUESTED').length },
    partial: truncated
  });
});

// ---------------------------------------------------------------- riders

const RIDER_FIELDS = 'userId firstName lastName phone email isPhoneVerified accountStatus status createdAt lastLogin lastActive';

function riderItem(u, trips) {
  return {
    id: u.userId, name: fullName(u) || u.phone, phone: u.phone, email: u.email || '',
    phoneVerified: !!u.isPhoneVerified, accountStatus: u.accountStatus || u.status || 'ACTIVE',
    registeredAt: u.createdAt || null, lastActiveAt: u.lastActive || u.lastLogin || null, trips: trips || { total: 0, completed: 0, cancelled: 0 }
  };
}

async function tripCountsFor(req, userIds) {
  const out = new Map(userIds.map((id) => [id, { total: 0, completed: 0, cancelled: 0 }]));
  if (!userIds.length) return out;
  const rows = await TripDetails.find({ ...tripScope(req), user_id: { $in: userIds } }).select('user_id status').limit(MAX_ROWS).lean();
  for (const t of rows) {
    const e = out.get(t.user_id);
    if (!e) continue;
    e.total++;
    if (t.status === 'COMPLETED') e.completed++;
    if (CANCELLED.includes(t.status)) e.cancelled++;
  }
  return out;
}

exports.riders = c.handle(async (req, res) => {
  const { page, pageSize, skip } = c.pageParams(req.query);
  const filter = {};
  const q = String(req.query.q || '').trim().slice(0, 60);
  if (q) {
    const rx = { $regex: c.escapeRegex(q), $options: 'i' };
    filter.$or = [{ firstName: rx }, { lastName: rx }, { phone: rx }, { email: rx }, { userId: rx }];
  }
  const [rows, total] = await Promise.all([
    req.legacyData.find(User(), filter).select(RIDER_FIELDS).sort({ createdAt: -1 }).skip(skip).limit(pageSize).lean(),
    req.legacyData.count(User(), filter)
  ]);
  const counts = await tripCountsFor(req, rows.map((u) => u.userId));
  return c.ok(res, { items: rows.map((u) => riderItem(u, counts.get(u.userId))), total, page, pageSize });
});

exports.rider = c.handle(async (req, res) => {
  const user = await req.legacyData.findOne(User(), { userId: String(req.params.id) }).select(RIDER_FIELDS).lean();
  if (!user) return c.fail(res, 404, 'Rider not found');
  const [counts, trips] = await Promise.all([
    tripCountsFor(req, [user.userId]),
    TripDetails.find({ ...tripScope(req), user_id: user.userId }).sort({ requested_at: -1 }).limit(20).lean()
  ]);
  const driverIds = [...new Set(trips.map((t) => t.driver_id).filter(Boolean))];
  const drivers = driverIds.length ? await req.legacyData.find(Driver(), { driverId: { $in: driverIds } }).select('driverId firstName lastName name phone').lean() : [];
  const names = new Map(drivers.map((d) => [d.driverId, fullName(d) || d.phone || d.driverId]));
  return c.ok(res, { ...riderItem(user, counts.get(user.userId)), recentTrips: trips.map((t) => tripItem(t, { driverName: names.get(t.driver_id) })) });
});

// ---------------------------------------------------------------- trips

function tripItem(t, { riderName, riderPhone, driverName } = {}) {
  return {
    id: t.trip_id, requestedAt: t.requested_at, status: t.status, statusGroup: groupOf(t.status),
    rider: { id: t.user_id, name: riderName || null, phone: riderPhone || null },
    driver: { id: t.driver_id, name: driverName || null },
    pickup: t.pickup ? t.pickup.address : '', drop: t.drop ? t.drop.address : '',
    fare: t.fare ?? null, currency: t.currency || null, fareBasis: t.fare_basis || null, paymentMode: t.payment_mode || null,
    distanceKm: t.distance_km ?? null, regionId: t.region_id || null, categoryId: t.category_id || null,
    cancelledBy: t.cancelled_by || null
  };
}

exports.trips = c.handle(async (req, res) => {
  const { page, pageSize, skip } = c.pageParams(req.query);
  const filter = { ...tripScope(req) };
  const group = String(req.query.statusGroup || '').trim();
  if (group) {
    if (!STATUS_GROUPS[group]) return c.invalid(res, { statusGroup: 'Unknown status group' });
    filter.status = { $in: STATUS_GROUPS[group] };
  }
  const status = String(req.query.status || '').trim();
  if (status) filter.status = status;
  for (const [param, field] of [['riderId', 'user_id'], ['driverId', 'driver_id'], ['regionId', 'region_id'], ['categoryId', 'category_id']]) {
    const v = String(req.query[param] || '').trim();
    if (v) filter[field] = v;
  }
  const q = String(req.query.q || '').trim().slice(0, 60);
  if (q) filter.trip_id = { $regex: c.escapeRegex(q), $options: 'i' };
  const from = req.query.from ? validDate(req.query.from) : null;
  const to = req.query.to ? validDate(req.query.to) : null;
  if (req.query.from && !from) return c.invalid(res, { from: 'Enter a valid date' });
  if (req.query.to && !to) return c.invalid(res, { to: 'Enter a valid date' });
  if (from || to) filter.requested_at = { ...(from ? { $gte: from } : {}), ...(to ? { $lte: to } : {}) };

  const [rows, total] = await Promise.all([
    TripDetails.find(filter).sort({ requested_at: -1 }).skip(skip).limit(pageSize).lean(),
    TripDetails.countDocuments(filter)
  ]);
  const riderIds = [...new Set(rows.map((t) => t.user_id))];
  const driverIds = [...new Set(rows.map((t) => t.driver_id))];
  const [riders, drivers] = await Promise.all([
    riderIds.length ? req.legacyData.find(User(), { userId: { $in: riderIds } }).select('userId firstName lastName phone').lean() : [],
    driverIds.length ? req.legacyData.find(Driver(), { driverId: { $in: driverIds } }).select('driverId firstName lastName name phone').lean() : []
  ]);
  const riderBy = new Map(riders.map((u) => [u.userId, u]));
  const driverBy = new Map(drivers.map((d) => [d.driverId, d]));
  const items = rows.map((t) => {
    const r = riderBy.get(t.user_id);
    const d = driverBy.get(t.driver_id);
    return tripItem(t, { riderName: r ? fullName(r) || r.phone : null, riderPhone: r ? r.phone : null, driverName: d ? fullName(d) || d.phone : null });
  });
  return c.ok(res, { items, total, page, pageSize });
});

const STEPS = [
  ['requested_at', 'Ride requested'], ['responded_at', 'Driver responded'], ['driver_on_the_way_at', 'Driver on the way'],
  ['arrived_at', 'Driver arrived'], ['started_at', 'Trip started'], ['completed_at', 'Trip completed'], ['cancelled_at', 'Cancelled']
];

exports.trip = c.handle(async (req, res) => {
  const t = await TripDetails.findOne({ ...tripScope(req), trip_id: String(req.params.id) }).lean();
  if (!t) return c.fail(res, 404, 'Trip not found');
  const [rider, driver, region, category, events] = await Promise.all([
    req.legacyData.findOne(User(), { userId: t.user_id }).select('userId firstName lastName phone').lean(),
    req.legacyData.findOne(Driver(), { driverId: t.driver_id }).select('driverId firstName lastName name phone').lean(),
    t.region_id ? req.data.findOne(ServiceRegion, { regionId: t.region_id }).lean() : null,
    t.category_id ? req.data.findOne(VehicleCategory, { categoryId: t.category_id }).lean() : null,
    TripEvent.find({ trip_id: t.trip_id }).sort({ created_at: 1 }).limit(100).lean()
  ]);
  const base = tripItem(t, { riderName: rider ? fullName(rider) || rider.phone : null, riderPhone: rider ? rider.phone : null, driverName: driver ? fullName(driver) || driver.phone : null });
  return c.ok(res, {
    ...base,
    pickupPoint: t.pickup ? { lat: t.pickup.lat, lng: t.pickup.lng } : null,
    dropPoint: t.drop ? { lat: t.drop.lat, lng: t.drop.lng } : null,
    region: region ? { id: region.regionId, name: `${region.city}${region.zoneName && region.zoneName !== 'All areas' ? ` · ${region.zoneName}` : ''}` } : null,
    category: category ? { id: category.categoryId, name: category.name } : null,
    note: t.ride_note || '',
    fareDetail: { amount: t.fare ?? null, currency: t.currency || null, basis: t.fare_basis || null, source: t.fare_source || null, breakdown: t.fare_breakdown || null, estimatedDurationMin: t.estimated_duration_min ?? null },
    cancellation: t.cancelled_at || t.cancelled_by ? { by: t.cancelled_by || null, stage: t.cancel_stage || null, reason: t.cancellation_reason || '', at: t.cancelled_at || null } : null,
    rejectReason: t.reject_reason || '',
    timeline: STEPS.filter(([field]) => t[field]).map(([field, label]) => ({ label, at: t[field] })).sort((a, b) => new Date(a.at) - new Date(b.at)),
    events: events.map((e) => ({ event: e.event, at: e.created_at })),
    // not recorded by the platform yet
    payment: { status: null, available: false },
    rating: null
  });
});

exports.helpers = { safeMeta, STATUS_GROUPS, groupOf };
