/**
 * The driver's own summary for the app's Home and Profile screens: today's trips and earnings, rating, acceptance,
 * the assigned vehicle and area, and what needs the driver's attention (documents rejected, expired or about to
 * expire). Everything is computed from the business's own records on the signed-in driver, never from the request.
 */
const { TripDetails } = require('../models/tripDetailsModel');
const { ServiceRegion, VehicleCategory } = require('../models/businessModels');
const { Vehicle, DriverVehicleAssignment, DriverDocument, VehicleDocument } = require('../models/fleetModels');
const { resolveRequirements, effectiveDocumentStatus } = require('../lib/verification');
const { checkDriverAvailable } = require('../lib/driverAvailability');
const { createModel } = require('../models/dynamicModel');
const c = require('./fleet/common');
const { DriverDutySession } = require('../models/driverDutySessionModel');
const { onlineSeconds } = require('../lib/dutyLog');
const { demandAround } = require('../lib/demand');
const { positionOf } = require('../lib/driverLocation');
const { effectiveTenantId } = require('../lib/appTenant');

const DAY_MS = 24 * 60 * 60 * 1000;
const EXPIRY_WARNING_DAYS = 30;
// the driver took the request: it moved past ACCEPTED, or the rider (or the driver) cancelled after that
const ACCEPTED_STATUSES = ['ACCEPTED', 'DRIVER_ON_THE_WAY', 'ARRIVED', 'ON_GOING', 'COMPLETED', 'CANCELLED_BY_USER_AFTER_ACCEPTANCE', 'CANCELLED_BY_DRIVER'];

/** Midnight (as a UTC instant) of the current day in an IANA time zone. */
function startOfDay(now, timeZone) {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
      .formatToParts(now).reduce((o, p) => { o[p.type] = p.value; return o; }, {});
    const sinceMidnight = (Number(parts.hour) * 3600 + Number(parts.minute) * 60 + Number(parts.second)) * 1000;
    return new Date(now.getTime() - sinceMidnight - (now.getTime() % 1000));
  } catch (_) {
    const d = new Date(now); d.setUTCHours(0, 0, 0, 0); return d;
  }
}

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

async function summary(req, res) {
  const driver = req.ownDriver;
  const now = new Date();
  const tz = (req.business.market && req.business.market.timezone) || 'Asia/Kolkata';
  const currency = (req.business.market && req.business.market.currency) || 'INR';
  const dayStart = startOfDay(now, tz);
  const weekStart = new Date(dayStart.getTime() - 6 * DAY_MS);
  const monthAgo = new Date(now.getTime() - 30 * DAY_MS);

  const fresh = (await createModel('drivers').findOne({ driverId: driver.driverId }).lean()) || driver;
  const [done, recent, assignment, region, sessions] = await Promise.all([
    TripDetails.find({ driver_id: driver.driverId, status: 'COMPLETED' }).sort({ completed_at: -1 }).limit(1000).lean(),
    TripDetails.find({ driver_id: driver.driverId, requested_at: { $gte: monthAgo } }).lean(),
    req.data.findOne(DriverVehicleAssignment, { driverId: driver.driverId, active: true }),
    fresh.operatingRegionId ? req.data.findOne(ServiceRegion, { regionId: fresh.operatingRegionId }) : null,
    DriverDutySession.find({ driverId: driver.driverId, startedAt: { $gte: new Date(weekStart.getTime() - DAY_MS) } }).lean()
  ]);

  const week = done.filter((t) => t.completed_at && new Date(t.completed_at) >= weekStart);
  const today = week.filter((t) => new Date(t.completed_at) >= dayStart);
  // what the driver earned (fares less the business's share), the same figure the Earnings screens show
  const adjAll = await require('../models/driverLedgerModel').DriverAdjustment.find({ tenantId: req.business.tenantId, driverId: driver.driverId }).lean();
  const adjIn = (from) => adjAll.filter((x) => new Date(x.at) >= from);
  const sum = (rows, from) => { const t = require('../lib/driverMoney').totals(rows, req.business, adjIn(from)); return t.totalMinor / 10 ** require('../lib/riderInvoice').digitsOf(currency); };
  // the rating is what riders gave on this driver's trips (stored on each trip, not kept as a counter that can drift)
  const stars = done.map((t) => Number((t.rider_rating && t.rider_rating.stars) || t['rider_rating.stars'])).filter((n) => n >= 1 && n <= 5);
  const average = stars.length ? Math.round((stars.reduce((a, b) => a + b, 0) / stars.length) * 10) / 10 : null;

  // acceptance over the last 30 days: of the requests this driver was offered, how many they took
  // a request the rider withdrew before any answer says nothing about the driver, so it is not counted either way
  const withdrawn = (t) => t.status === 'CANCELLED_BY_USER' || (t.cancel_stage === 'before_accept' && t.cancelled_by === 'USER');
  const answered = recent.filter((t) => t.status !== 'REQUESTED' && !withdrawn(t));
  const accepted = answered.filter((t) => ACCEPTED_STATUSES.includes(t.status));

  const vehicle = assignment ? await req.data.findOne(Vehicle, { vehicleId: assignment.vehicleId }) : null;
  const category = vehicle ? await req.data.findOne(VehicleCategory, { categoryId: vehicle.categoryId }) : null;

  // documents that need the driver's attention
  const requirements = resolveRequirements(req.business);
  const label = (list, type) => (list.find((r) => r.type === type) || {}).label || type;
  const alerts = [];
  const scan = (docs, list, subject) => {
    for (const d of docs) {
      const status = effectiveDocumentStatus(d, now);
      const base = { subject, type: d.type, label: label(list, d.type) };
      if (status === 'REJECTED') alerts.push({ ...base, kind: 'REJECTED', reason: d.rejectionReason || '' });
      else if (status === 'EXPIRED') alerts.push({ ...base, kind: 'EXPIRED', expiryDate: d.expiryDate || null });
      else if (status === 'APPROVED' && d.expiryDate) {
        const days = Math.ceil((new Date(`${d.expiryDate}T23:59:59Z`).getTime() - now.getTime()) / DAY_MS);
        if (days <= EXPIRY_WARNING_DAYS) alerts.push({ ...base, kind: 'EXPIRING', expiryDate: d.expiryDate, daysLeft: days });
      }
    }
  };
  scan(await req.data.find(DriverDocument, { driverId: driver.driverId }), requirements.driver, 'driver');
  if (vehicle) scan(await req.data.find(VehicleDocument, { vehicleId: vehicle.vehicleId }), requirements.vehicle, 'vehicle');

  // demand: riders with their app open near where this driver last was (null when the driver has no position yet)
  let demand = null;
  try {
    const position = positionOf(fresh);
    if (position) demand = await demandAround({ tenantId: await effectiveTenantId(fresh), position, now });
  } catch (e) { console.error('[driver demand]', e && e.message); }

  const availability = await checkDriverAvailable(fresh);
  const eligibility = availability.eligibility || { eligible: false, reasons: [] };
  const last = done[0] || null;

  return c.ok(res, {
    generatedAt: now.toISOString(),
    currency,
    driver: { driverId: driver.driverId, name: [fresh.firstName, fresh.lastName].filter(Boolean).join(' ').trim(), profilePhoto: /^https?:/.test(fresh.profilePhoto || '') && !/cdn.example.com/.test(fresh.profilePhoto) ? fresh.profilePhoto : null, online: !!fresh.isOnline },
    demand,
    support: { phone: req.business.supportPhone || '', email: req.business.supportEmail || '', name: req.business.name || '' },
    today: { trips: today.length, earnings: sum(today, dayStart), onlineSeconds: onlineSeconds(sessions, fresh, dayStart, now, now) },
    week: { trips: week.length, earnings: sum(week, weekStart), onlineSeconds: onlineSeconds(sessions, fresh, weekStart, now, now) },
    rating: { average: average != null ? average : (Number(fresh.rating) > 0 ? Number(fresh.rating) : null), ratedTrips: stars.length, totalRides: done.length },
    acceptance: { offered: answered.length, accepted: accepted.length, ratePercent: answered.length ? Math.round((accepted.length / answered.length) * 100) : null },
    vehicle: vehicle ? {
      vehicleId: vehicle.vehicleId, registrationNumber: vehicle.registrationNumber, make: vehicle.make || '', model: vehicle.model || '',
      colour: vehicle.colour || '', year: vehicle.year ?? null, categoryName: category ? category.name : '',
      seats: vehicle.passengerCapacity ?? (category ? category.passengerCapacity : null),
      status: vehicle.status, verificationStatus: vehicle.verificationStatus || 'INCOMPLETE'
    } : null,
    area: region ? { city: region.city, state: region.state, zoneName: region.zoneName } : null,
    account: { status: fresh.accountStatus || 'ACTIVE', verificationStatus: fresh.driverVerificationStatus || 'INCOMPLETE', eligible: !!eligibility.eligible },
    alerts,
    lastTrip: last ? {
      tripId: last.trip_id, fare: Number(last.fare) || 0, completedAt: last.completed_at,
      pickup: (last.pickup && last.pickup.address) || '', drop: (last.drop && last.drop.address) || ''
    } : null
  });
}

/** The day a moment falls on in the business time zone, as YYYY-MM-DD. */
const dayKey = (d, tz) => { try { return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(d)); } catch (_) { return new Date(d).toISOString().slice(0, 10); } };

/**
 * GET /api/v1/driver/summary/detail?days=30 : earnings, rides and online time for each of the last days (newest first), with
 * the totals for today, the last 7 days and the whole period, and the average fare.
 */
async function detail(req, res) {
  const driver = req.ownDriver;
  const now = new Date();
  const tz = (req.business.market && req.business.market.timezone) || 'Asia/Kolkata';
  const currency = (req.business.market && req.business.market.currency) || 'INR';
  const days = Math.min(Math.max(parseInt(req.query.days, 10) || 30, 1), 90);
  const todayStart = startOfDay(now, tz);
  const from = new Date(todayStart.getTime() - (days - 1) * DAY_MS);
  const [done, sessions, fresh] = await Promise.all([
    TripDetails.find({ driver_id: driver.driverId, status: 'COMPLETED', completed_at: { $gte: from } }).lean(),
    DriverDutySession.find({ driverId: driver.driverId, startedAt: { $gte: new Date(from.getTime() - DAY_MS) } }).lean(),
    createModel('drivers').findOne({ driverId: driver.driverId }).lean()
  ]);
  const rows = [];
  for (let i = 0; i < days; i++) {
    const start = new Date(todayStart.getTime() - i * DAY_MS);
    const end = i === 0 ? now : new Date(start.getTime() + DAY_MS);
    const trips = done.filter((t) => t.completed_at && new Date(t.completed_at) >= start && new Date(t.completed_at) < new Date(start.getTime() + DAY_MS));
    rows.push({ date: dayKey(new Date(start.getTime() + 60 * 60 * 1000), tz), rides: trips.length, earnings: round2(require('../lib/driverMoney').totals(trips, req.business).netMinor / 10 ** require('../lib/riderInvoice').digitsOf(currency)), onlineSeconds: onlineSeconds(sessions, fresh, start, end, now) });
  }
  const total = (list) => ({ rides: list.reduce((s, r) => s + r.rides, 0), earnings: round2(list.reduce((s, r) => s + r.earnings, 0)), onlineSeconds: list.reduce((s, r) => s + r.onlineSeconds, 0) });
  const avg = (t) => (t.rides ? round2(t.earnings / t.rides) : 0);
  const t0 = total(rows.slice(0, 1)); const t7 = total(rows.slice(0, 7)); const tAll = total(rows);
  return c.ok(res, { generatedAt: now.toISOString(), currency, timezone: tz, days, today: { ...t0, averageFare: avg(t0) }, week: { ...t7, averageFare: avg(t7) }, period: { ...tAll, averageFare: avg(tAll) }, daily: rows });
}

const DT = require('../lib/driverTrips');
const { earningsFor } = require('../lib/driverEarnings');

/** The riders behind a set of trips, by user id: { name, photo, phone }. */
async function ridersFor(rows) {
  const ids = [...new Set(rows.map((t) => t.user_id).filter(Boolean))];
  const out = {};
  if (!ids.length) return out;
  try {
    const docs = await createModel('users').find({ userId: { $in: ids } }).lean();
    for (const u of docs || []) {
      out[u.userId] = { name: [u.firstName, u.lastName].filter(Boolean).join(' ').trim() || u.fullName || '', photo: /^https?:/.test(u.profilePhoto || '') ? u.profilePhoto : null, phone: u.phone || '' };
    }
  } catch (e) { console.error('[driver trips riders]', e && e.message); }
  return out;
}

/**
 * GET /api/v1/driver/summary/trips : the driver's finished and cancelled rides, newest first, paged.
 *   range   today | week | month | all (default all): the period (week is the last 7 days, month the last 30)
 *   status  all | completed | cancelled (default all)
 *   q       search: a place, the rider, a date as written on screen, or a trip id
 *   payment all | cash | online
 *   sort    newest | oldest | earnings
 *   skip, limit  paging
 * Besides the rows it returns what the screen's headline cards need: totals for the period with the change against the
 * period before, the counts for the three tabs, and the totals of each day shown.
 */
async function trips(req, res) {
  const driver = req.ownDriver;
  const now = new Date();
  const tz = (req.business.market && req.business.market.timezone) || 'Asia/Kolkata';
  const currency = (req.business.market && req.business.market.currency) || 'INR';
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 50);
  const skip = Math.max(parseInt(req.query.skip, 10) || 0, 0);
  const range = DT.RANGES.includes(String(req.query.range)) ? String(req.query.range) : 'all';
  const status = ['completed', 'cancelled'].includes(String(req.query.status)) ? String(req.query.status) : 'all';
  const payment = ['cash', 'online'].includes(String(req.query.payment)) ? String(req.query.payment) : 'all';
  const sort = ['oldest', 'earnings'].includes(String(req.query.sort)) ? String(req.query.sort) : 'newest';
  const bounds = DT.rangeBounds(range, now, startOfDay(now, tz));

  // A week, month or day only needs the trips from the period before it on (for the comparison); reading the driver's whole history for that
  // grows with every ride they ever did. The database bound is wide on purpose (a trip with neither moment set is kept); the exact test
  // stays DT.inWindow below.
  const since = bounds.prevFrom || bounds.from;
  const query = { driver_id: driver.driverId, status: { $in: DT.HISTORY_STATUSES } };
  if (since) query.$or = [{ completed_at: { $gte: since } }, { cancelled_at: { $gte: since } }, { completed_at: null, cancelled_at: null }];
  const all = (await TripDetails.find(query).lean())
    .sort((x, y) => (new Date(DT.happenedAt(y) || 0) - new Date(DT.happenedAt(x) || 0)) || String(y.trip_id).localeCompare(String(x.trip_id)));
  const inRange = all.filter((t) => DT.inWindow(t, bounds.from, bounds.to));
  const before = bounds.prevFrom ? all.filter((t) => DT.inWindow(t, bounds.prevFrom, bounds.prevTo)) : [];

  const riders = await ridersFor(inRange);
  const rows = inRange.map((t) => DT.listRow(t, { tenant: req.business, tz, rider: riders[t.user_id] || null }));
  let shown = rows.filter((r) => (status === 'all' || (status === 'completed') === (r.status === 'COMPLETED'))
    && (payment === 'all' || (payment === 'cash') === (r.paymentMode === 'CASH'))
    && DT.matchesSearch(r, req.query.q, tz));
  if (sort === 'oldest') shown = shown.slice().reverse();
  else if (sort === 'earnings') shown = shown.slice().sort((x, y) => y.earnings - x.earnings);
  const page = shown.slice(skip, skip + limit);

  // headline cards: the whole period (not just the search), with the change against the one before it
  const now1 = DT.statsFor(inRange, req.business);
  const prev1 = DT.statsFor(before, req.business);
  const fresh = (await createModel('drivers').findOne({ driverId: driver.driverId }).lean()) || driver;
  const from = bounds.from || new Date(now.getTime() - 90 * DT.DAY_MS);
  const sessions = await DriverDutySession.find({ driverId: driver.driverId, startedAt: { $gte: new Date((bounds.prevFrom || from).getTime() - DT.DAY_MS) } }).lean();
  const onlineNow = onlineSeconds(sessions, fresh, from, now, now);
  const onlinePrev = bounds.prevFrom ? onlineSeconds(sessions, fresh, bounds.prevFrom, bounds.prevTo, now) : 0;
  const pct = bounds.prevFrom ? DT.changePercent : () => null;

  // each day's own totals, for the headers between the rows
  const days = {};
  for (const r of shown) {
    if (!r.day) continue;
    const d = days[r.day] || (days[r.day] = { rides: 0, earnings: 0 });
    d.rides += 1;
    d.earnings = DT.round2(d.earnings + r.earnings);
  }
  const dayTotals = {};
  for (const r of page) if (r.day) dayTotals[r.day] = days[r.day];

  return c.ok(res, {
    currency,
    timezone: tz,
    range,
    totals: {
      earnings: { value: now1.earnings, changePercent: pct(now1.earnings, prev1.earnings) },
      completed: { value: now1.completed, changePercent: pct(now1.completed, prev1.completed) },
      cancelled: { value: now1.cancelled, changePercent: pct(now1.cancelled, prev1.cancelled) },
      onlineSeconds: { value: onlineNow, changePercent: pct(onlineNow, onlinePrev) },
      comparedWith: bounds.prevFrom ? (range === 'today' ? 'yesterday' : range === 'week' ? 'last week' : 'last month') : null
    },
    counts: { all: rows.length, completed: now1.completed, cancelled: now1.cancelled },
    dayTotals,
    trips: page.map((r) => ({
      tripId: r.tripId, status: r.rawStatus, state: r.status, fare: r.earnings, earnings: r.earnings, requestedAt: r.at, completedAt: r.at, at: r.at, day: r.day,
      pickup: r.pickup.address || r.pickup.name, drop: r.drop.address || r.drop.name, pickupPlace: r.pickup, dropPlace: r.drop,
      distanceKm: r.distanceKm, durationMin: r.durationMin, paymentMode: r.paymentMode, rating: r.riderRating,
      riderName: r.riderName, cancelReason: r.cancelReason
    })),
    hasMore: skip + page.length < shown.length,
    nextSkip: skip + page.length
  });
}

/** One of this driver's finished or cancelled trips; null when the id is not theirs. */
async function ownTrip(req) {
  const id = String(req.params.tripId || '').trim();
  if (!id) return null;
  const trip = await TripDetails.findOne({ trip_id: id, driver_id: req.ownDriver.driverId }).lean();
  return trip && DT.HISTORY_STATUSES.includes(trip.status) ? trip : null;
}

const CALL_WINDOW_MS = 48 * 60 * 60 * 1000; // the rider's number is shown only while a lost item or a late payment may still need it

/** GET /api/v1/driver/summary/trips/:tripId : everything on the Ride Details screen for one finished or cancelled ride. */
async function tripDetail(req, res) {
  const t = await ownTrip(req);
  if (!t) return c.fail(res, 404, 'We could not find that ride.');
  const now = new Date();
  const tz = (req.business.market && req.business.market.timezone) || 'Asia/Kolkata';
  const currency = t.currency || (req.business.market && req.business.market.currency) || 'INR';
  const cancelled = DT.isCancelled(t);
  const riders = await ridersFor([t]);
  const rider = riders[t.user_id] || {};
  let riderTrips = null; let riderAvg = null;
  try {
    const extras = await require('../lib/rideOffer').offerExtras(t, null);
    riderTrips = extras.rider_trips === '' ? null : Number(extras.rider_trips);
    riderAvg = extras.rider_rating === '' ? null : Number(extras.rider_rating);
  } catch (_) { /* the screen simply leaves them out */ }
  let category = null;
  try { category = t.category_id ? await req.data.findOne(VehicleCategory, { categoryId: t.category_id }) : null; } catch (_) { /* optional */ }
  const earn = earningsFor(t, req.business);
  const endedAt = t.completed_at || t.cancelled_at || null;
  const recent = endedAt && now.getTime() - new Date(endedAt).getTime() <= CALL_WINDOW_MS;
  const pay = DT.payMode(t);
  return c.ok(res, {
    currency,
    timezone: tz,
    tripId: t.trip_id,
    status: cancelled ? 'CANCELLED' : 'COMPLETED',
    rawStatus: t.status,
    at: DT.happenedAt(t),
    earnings: cancelled ? 0 : earn.earnings,
    cancelReason: cancelled ? (t.cancellation_reason || (t.status === 'CANCELLED_BY_DRIVER' ? 'Cancelled by you' : 'Cancelled by passenger')) : null,
    cancellationFee: cancelled ? Number(t.cancellation_fee) || 0 : 0,
    pickup: { address: (t.pickup && t.pickup.address) || '', lat: t.pickup && t.pickup.lat, lng: t.pickup && t.pickup.lng, at: t.started_at || t.responded_at || null },
    drop: { address: (t.drop && t.drop.address) || '', lat: t.drop && t.drop.lat, lng: t.drop && t.drop.lng, at: t.completed_at || null },
    distanceKm: t.distance_km != null ? Number(t.distance_km) : null,
    durationMin: cancelled ? null : DT.durationMin(t),
    rideType: category ? category.name : '',
    rider: {
      name: rider.name || '', photo: rider.photo || null, trips: riderTrips, rating: riderAvg,
      ratedYou: (t.rider_rating && t.rider_rating.stars) || null,
      phone: recent ? rider.phone || '' : ''
    },
    trip: { rideType: category ? category.name : '', paymentMode: pay, status: cancelled ? 'Cancelled' : 'Completed', passengers: t.passengers != null ? Number(t.passengers) : 1 },
    fare: {
      lines: earn.lines.map((l) => ({ label: l.label, amount: l.amount, kind: l.kind })),
      passengerFare: earn.passenger_fare,
      // what the rider actually handed over, and the coupon amount the business pays the driver on top of it
      riderPaid: earn.rider_paid,
      couponCovered: earn.coupon_discount_funded || 0,
      platformFeePercent: earn.platform_fee_percent,
      platformFee: earn.platform_fee,
      earnings: earn.earnings,
      note: cancelled ? null : (pay === 'CASH' ? 'Collected in cash from the passenger.' : 'Amount will be credited to your wallet within 24 hours.')
    },
    timeline: DT.timelineOf(t),
    support: { phone: req.business.supportPhone || '', email: req.business.supportEmail || '', name: req.business.name || '' }
  });
}

/** GET /api/v1/driver/summary/trips/:tripId/receipt.pdf : the driver's earnings receipt for the ride. */
async function tripReceipt(req, res) {
  const t = await ownTrip(req);
  if (!t) return c.fail(res, 404, 'We could not find that ride.');
  const riders = await ridersFor([t]);
  const fresh = (await createModel('drivers').findOne({ driverId: req.ownDriver.driverId }).lean()) || req.ownDriver;
  const pdf = await require('../lib/driverReceiptPdf').renderDriverReceipt({
    business: { name: req.business.name || '', supportPhone: req.business.supportPhone || '', supportEmail: req.business.supportEmail || '' },
    trip: t, earnings: earningsFor(t, req.business), cancelled: DT.isCancelled(t),
    driverName: [fresh.firstName, fresh.lastName].filter(Boolean).join(' ').trim(),
    riderName: (riders[t.user_id] || {}).name || ''
  });
  res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': 'attachment; filename="receipt-' + t.trip_id + '.pdf"', 'Cache-Control': 'private, no-store' });
  return res.status(200).send(pdf);
}

/**
 * GET /api/v1/driver/summary/profile : everything the Profile screen shows that is not the document list (that comes
 * from the onboarding state): who the driver is, lifetime numbers, the vehicle with its picture, and how they are doing.
 */
async function profile(req, res) {
  const driver = req.ownDriver;
  const now = new Date();
  const monthAgo = new Date(now.getTime() - 30 * DAY_MS);
  const currency = (req.business.market && req.business.market.currency) || 'INR';
  const fresh = (await createModel('drivers').findOne({ driverId: driver.driverId }).lean()) || driver;
  const [done, recent, assignment, cancelledByDriver] = await Promise.all([
    TripDetails.find({ driver_id: driver.driverId, status: 'COMPLETED' }).limit(5000).lean(),
    TripDetails.find({ driver_id: driver.driverId, requested_at: { $gte: monthAgo } }).lean(),
    req.data.findOne(DriverVehicleAssignment, { driverId: driver.driverId, active: true }),
    TripDetails.countDocuments ? TripDetails.countDocuments({ driver_id: driver.driverId, status: 'CANCELLED_BY_DRIVER' }) : 0
  ]);
  const stars = done.map((t) => Number((t.rider_rating && t.rider_rating.stars) || t['rider_rating.stars'])).filter((n) => n >= 1 && n <= 5);
  const average = stars.length ? Math.round((stars.reduce((a, b) => a + b, 0) / stars.length) * 10) / 10 : (Number(fresh.rating) > 0 ? Number(fresh.rating) : null);
  const totalEarnings = round2(done.reduce((s, t) => s + require('../lib/driverEarnings').earningsFor(t, req.business).earnings, 0));
  const withdrawn = (t) => t.status === 'CANCELLED_BY_USER' || (t.cancel_stage === 'before_accept' && t.cancelled_by === 'USER');
  const answered = recent.filter((t) => t.status !== 'REQUESTED' && !withdrawn(t));
  const accepted = answered.filter((t) => ACCEPTED_STATUSES.includes(t.status));
  const tookRides = done.length + cancelledByDriver;
  const vehicle = assignment ? await req.data.findOne(Vehicle, { vehicleId: assignment.vehicleId }) : null;
  const category = vehicle ? await req.data.findOne(VehicleCategory, { categoryId: vehicle.categoryId }) : null;
  const created = fresh.createdAt ? new Date(fresh.createdAt) : null;
  const months = created ? Math.max(0, Math.floor((now.getTime() - created.getTime()) / (30.44 * DAY_MS))) : 0;
  const email = String(fresh.email || '');
  return c.ok(res, {
    currency,
    driver: {
      driverId: fresh.driverId,
      name: [fresh.firstName, fresh.lastName].filter(Boolean).join(' ').trim(),
      firstName: fresh.firstName || '',
      lastName: fresh.lastName || '',
      phone: fresh.phone || '',
      email: /@noreply\.invalid$/i.test(email) ? '' : email,
      photo: /^https?:/.test(fresh.profilePhoto || '') && !/cdn.example.com/.test(fresh.profilePhoto) ? fresh.profilePhoto : null,
      verified: fresh.driverVerificationStatus === 'APPROVED',
      verificationStatus: fresh.driverVerificationStatus || 'INCOMPLETE',
      online: !!fresh.isOnline,
      memberSince: created ? created.toISOString() : null,
      monthsWithUs: months
    },
    stats: { trips: done.length, rating: average, ratedTrips: stars.length, totalEarnings, monthsWithUs: months },
    performance: {
      rating: average,
      ratedTrips: stars.length,
      acceptance: { offered: answered.length, accepted: accepted.length, ratePercent: answered.length ? Math.round((accepted.length / answered.length) * 100) : null },
      completion: { completed: done.length, cancelledByYou: cancelledByDriver, ratePercent: tookRides ? Math.round((done.length / tookRides) * 100) : null },
      periodDays: 30
    },
    vehicle: vehicle ? {
      registrationNumber: vehicle.registrationNumber, make: vehicle.make || '', model: vehicle.model || '', colour: vehicle.colour || '', year: vehicle.year ?? null,
      fuelType: vehicle.fuelType || fresh.fuleType || '', categoryName: category ? category.name : '', imageUrl: category && /^https?:/.test(category.imageUrl || '') ? category.imageUrl : null,
      seats: vehicle.passengerCapacity ?? (category ? category.passengerCapacity : null), verificationStatus: vehicle.verificationStatus || 'INCOMPLETE'
    } : null,
    support: { phone: req.business.supportPhone || '', email: req.business.supportEmail || '', name: req.business.name || '' }
  });
}

const safe = (fn) => async (req, res) => {
  try {
    return await fn(req, res);
  } catch (e) {
    console.error('[driver summary]', e && e.message);
    return c.fail(res, 500, 'Something went wrong. Please try again.');
  }
};

module.exports = { summary: safe(summary), detail: safe(detail), trips: safe(trips), tripDetail: safe(tripDetail), profile: safe(profile), tripReceipt: safe(tripReceipt), startOfDay };
