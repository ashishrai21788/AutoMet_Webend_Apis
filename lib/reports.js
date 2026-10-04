/**
 * Business report over a set of trips. Pure: the controller loads the trips of one business for a date range and this
 * works out the numbers. Nothing is estimated beyond what the trip records hold; what the platform does not record
 * (payments received, commission, ratings) is reported as unavailable, never as a figure.
 */
const { groupOf } = require('./tripStatus');
const { dateKey } = require('./timeZone');

const ACCEPTED_STATUSES = ['ACCEPTED', 'DRIVER_ON_THE_WAY', 'ARRIVED', 'ON_GOING', 'COMPLETED', 'CANCELLED_BY_USER_AFTER_ACCEPTANCE'];
const round = (n, d = 2) => Math.round(n * 10 ** d) / 10 ** d;
const pct = (n, d) => (d > 0 ? round((n / d) * 100, 1) : 0);
const avg = (list) => (list.length ? round(list.reduce((a, b) => a + b, 0) / list.length) : null);
const minutesBetween = (a, b) => (a && b ? (new Date(b).getTime() - new Date(a).getTime()) / 60000 : null);
const positive = (n) => (typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : null);

function dayKeys(from, to, tz) {
  const keys = [];
  const seen = new Set();
  for (let t = new Date(from).getTime(); t <= new Date(to).getTime(); t += 12 * 3600000) {
    const k = dateKey(new Date(t), tz);
    if (!seen.has(k)) { seen.add(k); keys.push(k); }
  }
  return keys;
}

function buildReport({ trips = [], from, to, tz = 'UTC', driverNames = new Map(), categoryNames = new Map(), regionNames = new Map() }) {
  const total = trips.length;
  const by = { searching: 0, active: 0, completed: 0, cancelled: 0, unanswered: 0, other: 0 };
  for (const t of trips) by[groupOf(t.status)]++;
  const closed = total - by.searching - by.active; // trips that have reached an outcome
  const completed = trips.filter((t) => t.status === 'COMPLETED');

  const responseMin = trips.map((t) => minutesBetween(t.requested_at, t.responded_at)).filter((m) => m !== null && m >= 0);
  const tripMin = completed.map((t) => minutesBetween(t.started_at, t.completed_at)).filter((m) => m !== null && m >= 0);
  const distances = completed.map((t) => positive(t.distance_km)).filter((m) => m !== null);
  const fares = completed.map((t) => positive(t.fare)).filter((m) => m !== null);

  const grossFares = round(fares.reduce((a, b) => a + b, 0));
  const lineTotal = (t, key) => (t.fare_breakdown && typeof t.fare_breakdown[key] === 'number' ? t.fare_breakdown[key] : 0);
  const bookingFees = round(completed.reduce((s, t) => s + lineTotal(t, 'feesTotal'), 0));
  const taxes = round(completed.reduce((s, t) => s + lineTotal(t, 'taxesTotal'), 0));
  const estimated = completed.filter((t) => t.fare_basis !== 'ACTUAL').length;

  // series by day in the business's own time zone
  const days = new Map(dayKeys(from, to, tz).map((k) => [k, { date: k, requested: 0, completed: 0, cancelled: 0, unanswered: 0, fares: 0 }]));
  for (const t of trips) {
    const d = days.get(dateKey(t.requested_at, tz));
    if (!d) continue;
    d.requested++;
    const g = groupOf(t.status);
    if (g === 'completed') { d.completed++; d.fares = round(d.fares + (positive(t.fare) || 0)); }
    else if (g === 'cancelled') d.cancelled++;
    else if (g === 'unanswered') d.unanswered++;
  }

  const group = (keyOf, nameOf) => {
    const m = new Map();
    for (const t of trips) {
      const key = keyOf(t) || 'unknown';
      const row = m.get(key) || { id: key, name: nameOf(key), requested: 0, completed: 0, cancelled: 0, unanswered: 0, fares: 0 };
      row.requested++;
      const g = groupOf(t.status);
      if (g === 'completed') { row.completed++; row.fares = round(row.fares + (positive(t.fare) || 0)); }
      else if (g === 'cancelled') row.cancelled++;
      else if (g === 'unanswered') row.unanswered++;
      m.set(key, row);
    }
    return [...m.values()].sort((a, b) => b.completed - a.completed || b.requested - a.requested);
  };

  // per driver: requests offered, and what the driver did with them
  const driverRows = new Map();
  for (const t of trips) {
    if (!t.driver_id) continue;
    const r = driverRows.get(t.driver_id) || { id: t.driver_id, name: driverNames.get(t.driver_id) || t.driver_id, offered: 0, accepted: 0, declined: 0, noResponse: 0, completed: 0, cancelled: 0, fares: 0 };
    // only requests the driver could answer count: one still waiting, or cancelled by the rider before the driver answered, does not
    if (ACCEPTED_STATUSES.includes(t.status)) { r.offered++; r.accepted++; }
    else if (t.status === 'REJECTED' || t.status === 'REJECTED_WITH_REASON' || t.status === 'CANCELLED_BY_DRIVER') { r.offered++; r.declined++; } // a driver cancelling a request before accepting it is a decline
    else if (t.status === 'NO_RESPONSE') { r.offered++; r.noResponse++; }
    if (t.status === 'COMPLETED') { r.completed++; r.fares = round(r.fares + (positive(t.fare) || 0)); }
    if (t.status === 'CANCELLED_BY_USER_AFTER_ACCEPTANCE') r.cancelled++;
    driverRows.set(t.driver_id, r);
  }
  const drivers = [...driverRows.values()].filter((r) => r.offered > 0 || r.completed > 0).map((r) => ({ ...r, acceptanceRate: pct(r.accepted, r.offered) })).sort((a, b) => b.completed - a.completed || b.accepted - a.accepted);

  return {
    range: { from: new Date(from).toISOString(), to: new Date(to).toISOString(), timezone: tz },
    rides: {
      requested: total, completed: by.completed, cancelled: by.cancelled, cancelledByRiders: trips.filter((t) => t.status.startsWith('CANCELLED_BY_USER')).length, cancelledByDrivers: trips.filter((t) => t.status === 'CANCELLED_BY_DRIVER').length, noDriver: by.unanswered, stillOpen: by.searching + by.active,
      completionRate: pct(by.completed, closed), cancellationRate: pct(by.cancelled, closed), noDriverRate: pct(by.unanswered, closed),
      avgResponseMinutes: avg(responseMin), avgTripMinutes: avg(tripMin), avgDistanceKm: avg(distances), avgFare: avg(fares)
    },
    finance: {
      grossFares, bookingFees, taxes, completedTrips: completed.length, estimatedFares: estimated,
      basis: estimated === completed.length && completed.length > 0 ? 'estimates' : estimated === 0 ? 'final fares' : 'a mix of estimates and final fares',
      byPaymentMode: group((t) => (t.status === 'COMPLETED' ? t.payment_mode || 'UNKNOWN' : null), (k) => k).filter((r) => r.id !== 'unknown').map((r) => ({ mode: r.id, trips: r.completed, fares: r.fares })),
      // the platform does not hold these yet
      unavailable: ['payments received', 'platform commission', 'business and driver earnings', 'refunds']
    },
    byDay: [...days.values()],
    byCategory: group((t) => t.category_id, (k) => categoryNames.get(k) || (k === 'unknown' ? 'Not recorded' : k)),
    byRegion: group((t) => t.region_id, (k) => regionNames.get(k) || (k === 'unknown' ? 'Not recorded' : k)),
    drivers,
    statusGroups: Object.keys(by).map((g) => ({ group: g, trips: by[g] }))
  };
}

module.exports = { buildReport, dayKeys };
