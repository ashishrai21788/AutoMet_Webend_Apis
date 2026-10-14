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
  const [done, recent, assignment, region] = await Promise.all([
    TripDetails.find({ driver_id: driver.driverId, status: 'COMPLETED' }).sort({ completed_at: -1 }).limit(1000).lean(),
    TripDetails.find({ driver_id: driver.driverId, requested_at: { $gte: monthAgo } }).lean(),
    req.data.findOne(DriverVehicleAssignment, { driverId: driver.driverId, active: true }),
    fresh.operatingRegionId ? req.data.findOne(ServiceRegion, { regionId: fresh.operatingRegionId }) : null
  ]);

  const week = done.filter((t) => t.completed_at && new Date(t.completed_at) >= weekStart);
  const today = week.filter((t) => new Date(t.completed_at) >= dayStart);
  const sum = (rows) => round2(rows.reduce((s, t) => s + (Number(t.fare) || 0), 0));
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

  const availability = await checkDriverAvailable(fresh);
  const eligibility = availability.eligibility || { eligible: false, reasons: [] };
  const last = done[0] || null;

  return c.ok(res, {
    generatedAt: now.toISOString(),
    currency,
    today: { trips: today.length, earnings: sum(today) },
    week: { trips: week.length, earnings: sum(week) },
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

const safe = (fn) => async (req, res) => {
  try {
    return await fn(req, res);
  } catch (e) {
    console.error('[driver summary]', e && e.message);
    return c.fail(res, 500, 'Something went wrong. Please try again.');
  }
};

module.exports = { summary: safe(summary), startOfDay };
