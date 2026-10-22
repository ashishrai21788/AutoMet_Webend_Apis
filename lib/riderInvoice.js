/**
 * Rider invoices: one per completed trip (and one for the charge when a rider cancelled after a driver accepted).
 *
 *  - Issued once. The trip id is unique on the invoice, so asking again (or two completions racing) returns the same invoice.
 *  - A snapshot. The business name and tax details, the rider, driver and vehicle, the route and the fare lines are copied at
 *    issue time; editing a business, vehicle or fare rule later never changes it.
 *  - Money in whole minor units. The lines are checked to add up to the trip's fare; if a trip has no usable breakdown (older
 *    trips) the invoice carries one line, "Ride fare", for the fare that was charged.
 *  - Numbered per business and financial year (April to March): INV-2627-000001, never reused.
 */
const crypto = require('crypto');

const digitsOf = (currency) => {
  try { return new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits; } catch { return 2; }
};
const toMinor = (amount, digits) => Math.round((Number(amount) + Number.EPSILON) * 10 ** digits);

/** Indian financial year as "2627" for a date between 1 April 2026 and 31 March 2027. */
function financialYear(date) {
  const d = new Date(date);
  const y = d.getUTCFullYear() + (d.getUTCMonth() >= 3 ? 0 : -1);
  return `${String(y).slice(2)}${String(y + 1).slice(2)}`;
}

const maskPhone = (phone) => {
  const digits = String(phone || '').replace(/\D/g, '');
  return digits.length > 4 ? `${'*'.repeat(digits.length - 4)}${digits.slice(-4)}` : '';
};

const minutesBetween = (a, b) => (a && b ? Math.max(1, Math.round((new Date(b) - new Date(a)) / 60000)) : null);

/**
 * The invoice lines for a trip, in minor units, and whether they could be taken from the stored breakdown.
 * Lines: ride lines, fees, taxes (each only if it has an amount). Returns { lines, totalMinor }.
 */
function baseLinesFromTrip(trip, digits) {
  const fareMinor = toMinor(trip.fare, digits);
  const b = trip.fare_breakdown;
  if (b && Array.isArray(b.lines) && b.lines.length) {
    const lines = [];
    for (const l of b.lines) if (l && Number(l.amount)) lines.push({ label: String(l.label || 'Ride charge'), amountMinor: toMinor(l.amount, digits), kind: 'RIDE' });
    for (const l of b.fees || []) if (l && Number(l.amount)) lines.push({ label: String(l.label || 'Fee'), amountMinor: toMinor(l.amount, digits), kind: 'FEE' });
    for (const l of b.taxes || []) if (l && Number(l.amount)) lines.push({ label: String(l.label || 'Tax'), amountMinor: toMinor(l.amount, digits), kind: 'TAX' });
    // a discount is whatever remains negative between the lines and the stored total
    const sum = lines.reduce((s, l) => s + l.amountMinor, 0);
    if (sum === fareMinor && lines.length) return { lines, totalMinor: fareMinor };
    if (sum > fareMinor && lines.length) {
      lines.push({ label: trip.coupon && trip.coupon.code ? `Discount (${trip.coupon.code})` : 'Discount', amountMinor: fareMinor - sum, kind: 'DISCOUNT' });
      return { lines, totalMinor: fareMinor };
    }
  }
  // no usable breakdown: one honest line for what was charged
  return { lines: [{ label: 'Ride fare', amountMinor: fareMinor, kind: 'RIDE' }], totalMinor: fareMinor };
}

/**
 * The same plus the toll, when the trip has one: a line of its own (kind TOLL, no tax) and part of the total.
 * Returns { lines, totalMinor, tollMinor }; totalMinor is everything the rider paid.
 */
function linesFromTrip(trip, digits) {
  const base = baseLinesFromTrip(trip, digits);
  const toll = Math.max(0, Math.round(Number(trip && trip.toll_minor) || 0));
  if (!toll) return { ...base, tollMinor: 0 };
  return { lines: [...base.lines, { label: 'Toll', amountMinor: toll, kind: 'TOLL' }], totalMinor: base.totalMinor + toll, tollMinor: toll };
}

/**
 * Pure: builds the invoice document (without id and number). `type` is TRIP or CANCELLATION.
 */
function buildInvoiceDocument({ trip, tenant, rider, driver, vehicle, categoryName, type = 'TRIP', issuedAt = new Date() }) {
  const currency = trip.currency || (tenant && tenant.market && tenant.market.currency) || 'INR';
  const digits = digitsOf(currency);
  let lines; let totalMinor;
  if (type === 'CANCELLATION') {
    totalMinor = toMinor(trip.cancellation_fee, digits);
    lines = [{ label: 'Cancellation charge', amountMinor: totalMinor, kind: 'CANCELLATION' }];
  } else {
    ({ lines, totalMinor } = linesFromTrip(trip, digits));
  }
  const taxMinor = lines.filter((l) => l.kind === 'TAX').reduce((s, l) => s + l.amountMinor, 0);

  const bill = (tenant && tenant.billingDetails) || {};
  const business = {
    name: (tenant && tenant.name) || '',
    appName: (tenant && tenant.appName) || '',
    legalName: bill.legalName || (tenant && tenant.name) || '',
    gstin: bill.gstin || '',
    address: bill.address || '',
    stateCode: bill.stateCode || '',
    supportEmail: (tenant && tenant.supportEmail) || '',
    supportPhone: (tenant && tenant.supportPhone) || '',
    logoUrl: (tenant && tenant.logoUrl) || ''
  };
  const riderName = [rider && rider.firstName, rider && rider.lastName].filter(Boolean).join(' ').trim() || (rider && rider.fullName) || 'Rider';
  const driverName = driver ? ([driver.firstName, driver.lastName].filter(Boolean).join(' ').trim() || driver.fullName || '') : '';
  const veh = vehicle || {};

  return {
    type,
    tripId: trip.trip_id,
    userId: trip.user_id,
    driverId: trip.driver_id || null,
    issuedAt,
    currency,
    currencyDigits: digits,
    business,
    rider: { name: riderName, phoneMasked: maskPhone(rider && rider.phone) },
    driver: driver ? {
      name: driverName,
      vehicleNumber: veh.registrationNumber || driver.vehicleNumber || '',
      vehicleModel: [veh.make, veh.model].filter(Boolean).join(' ') || driver.vehicleModel || '',
      vehicleColour: veh.colour || driver.vehicleColor || '',
      rating: driver.rating != null && Number(driver.rating) > 0 ? Math.round(Number(driver.rating) * 10) / 10 : null,
      seats: Number(veh.seatingCapacity || driver.seatingCapacity) > 0 ? Number(veh.seatingCapacity || driver.seatingCapacity) : null,
      fuelType: veh.fuelType || driver.fuleType || ''
    } : null,
    trip: {
      rideType: categoryName || trip.vehicle_type || '',
      pickup: (trip.pickup && trip.pickup.address) || '',
      drop: (trip.drop && trip.drop.address) || '',
      distanceKm: trip.distance_km != null ? Number(trip.distance_km) : null,
      durationMin: minutesBetween(trip.started_at, trip.completed_at) || trip.estimated_duration_min || null,
      requestedAt: trip.requested_at || null,
      startedAt: trip.started_at || null,
      completedAt: trip.completed_at || trip.cancelled_at || null,
      status: type === 'CANCELLATION' ? 'CANCELLED' : 'COMPLETED',
      cancelledBy: type === 'CANCELLATION' ? (trip.cancelled_by || null) : null
    },
    lines,
    subtotalMinor: totalMinor - taxMinor,
    taxMinor,
    totalMinor,
    paymentMode: String(trip.payment_mode || 'CASH').toUpperCase()
  };
}

/** What the apps and the PDF read: the stored invoice with ids and internal fields removed. */
function toPublic(inv) {
  const o = typeof inv.toObject === 'function' ? inv.toObject() : { ...inv };
  const { _id, __v, tenantId, ...rest } = o;
  return rest;
}

/** Which invoice a trip is entitled to: a completed ride, or a charged cancellation. Null when it has none. */
function invoiceTypeFor(trip) {
  if (!trip) return null;
  if (trip.status === 'COMPLETED' && Number(trip.fare) >= 0 && trip.fare != null) return 'TRIP';
  if (String(trip.status || '').startsWith('CANCELLED') && Number(trip.cancellation_fee) > 0) return 'CANCELLATION';
  return null;
}

/**
 * Finds the trip's invoice or issues it (once). Safe to call on every read and on completion: a second call, or a second
 * process racing the first, returns the invoice that already exists.
 */
async function issueForTrip(trip, deps = {}) {
  const type = invoiceTypeFor(trip);
  if (!type) return null;
  const { RiderInvoice } = deps.RiderInvoice ? deps : require('../models/riderInvoiceModel');
  const existing = await RiderInvoice.findOne({ tripId: trip.trip_id });
  if (existing) return existing;

  const { createModel } = require('../models/dynamicModel');
  const { tenantForAccount } = require('./appTenant');
  const { forTenant } = require('./tenantData');
  const rider = await createModel('users').findOne({ userId: trip.user_id }).lean();
  const driver = trip.driver_id ? await createModel('drivers').findOne({ driverId: trip.driver_id }).lean() : null;
  // the business is the one the trip belongs to (its own tag), else the rider's
  const tenant = trip.tenant_id ? await require('./appTenant').tenantById(trip.tenant_id) : await tenantForAccount(rider || {});
  if (!tenant) return null;

  let vehicle = null; let categoryName = '';
  try {
    const { Vehicle, DriverVehicleAssignment } = require('../models/fleetModels');
    const { VehicleCategory } = require('../models/businessModels');
    const data = forTenant(tenant.tenantId);
    const assignment = driver ? await data.findOne(DriverVehicleAssignment, { driverId: driver.driverId, active: true }) : null;
    vehicle = assignment ? await data.findOne(Vehicle, { vehicleId: assignment.vehicleId }) : null;
    const cat = trip.category_id ? await data.findOne(VehicleCategory, { categoryId: trip.category_id }) : null;
    categoryName = cat ? cat.name : '';
  } catch (_) { /* the invoice is still issued without the vehicle details */ }

  const issuedAt = new Date();
  const doc = buildInvoiceDocument({ trip, tenant, rider, driver, vehicle, categoryName, type, issuedAt });
  const { PlatformCounter } = require('../models/platformBilling');
  const fy = financialYear(issuedAt);
  const counter = await PlatformCounter.findOneAndUpdate({ key: `rider_invoice:${tenant.tenantId}:${fy}` }, { $inc: { seq: 1 } }, { new: true, upsert: true });
  const invoiceNumber = `INV-${fy}-${String(counter.seq).padStart(6, '0')}`;
  try {
    return await RiderInvoice.create({ ...doc, tenantId: tenant.tenantId, invoiceId: `ri_${crypto.randomBytes(8).toString('hex')}`, invoiceNumber });
  } catch (e) {
    if (e && e.code === 11000) return RiderInvoice.findOne({ tripId: trip.trip_id }); // another request issued it first
    throw e;
  }
}

module.exports = { buildInvoiceDocument, issueForTrip, invoiceTypeFor, toPublic, financialYear, linesFromTrip, toMinor, digitsOf, maskPhone };
