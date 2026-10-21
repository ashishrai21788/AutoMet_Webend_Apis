/**
 * What the driver app's Ride History and Ride Details screens show, worked out from the business's own trip records.
 * Pure helpers (no database): the controller loads the rows and hands them in.
 */
const { earningsFor } = require('./driverEarnings');

const DAY_MS = 24 * 60 * 60 * 1000;
const COMPLETED = 'COMPLETED';
const CANCELLED = ['CANCELLED_BY_DRIVER', 'CANCELLED_BY_USER_AFTER_ACCEPTANCE'];
/** The rides a driver's history lists: finished ones and ones cancelled after the driver took them. */
const HISTORY_STATUSES = [COMPLETED, ...CANCELLED];
const RANGES = ['today', 'week', 'month', 'all'];

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const isCancelled = (t) => CANCELLED.includes(t.status);
/** When the ride "happened": it finished, was cancelled, or at least was asked for. */
const happenedAt = (t) => t.completed_at || t.cancelled_at || t.requested_at || t.created_at || null;

/** The day a moment falls on in a time zone, as YYYY-MM-DD. */
function dayKey(d, tz) {
  try { return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(d)); } catch (_) { return new Date(d).toISOString().slice(0, 10); }
}

/** { from, to, prevFrom, prevTo } for a range; `from` is null for "all". todayStart is midnight today in the business zone. */
function rangeBounds(range, now, todayStart) {
  if (range === 'today') return { from: todayStart, to: now, prevFrom: new Date(todayStart.getTime() - DAY_MS), prevTo: todayStart };
  if (range === 'week') { const from = new Date(todayStart.getTime() - 6 * DAY_MS); return { from, to: now, prevFrom: new Date(from.getTime() - 7 * DAY_MS), prevTo: from }; }
  if (range === 'month') { const from = new Date(todayStart.getTime() - 29 * DAY_MS); return { from, to: now, prevFrom: new Date(from.getTime() - 30 * DAY_MS), prevTo: from }; }
  return { from: null, to: now, prevFrom: null, prevTo: null };
}

const inWindow = (t, from, to) => {
  const at = happenedAt(t);
  if (!at) return false;
  const ms = new Date(at).getTime();
  return (!from || ms >= from.getTime()) && (!to || ms < to.getTime());
};

/** Earnings and counts for a set of history rows. */
function statsFor(rows, tenant) {
  const done = rows.filter((t) => t.status === COMPLETED);
  return {
    earnings: round2(done.reduce((s, t) => s + earningsFor(t, tenant).earnings, 0)),
    completed: done.length,
    cancelled: rows.filter(isCancelled).length
  };
}

/** Whole-number change against the previous period, or null when there was nothing to compare with. */
function changePercent(now, before) {
  const a = Number(now) || 0;
  const b = Number(before) || 0;
  if (b <= 0) return null;
  return Math.round(((a - b) / b) * 100);
}

const durationMin = (t) => (t.started_at && t.completed_at ? Math.max(1, Math.round((new Date(t.completed_at) - new Date(t.started_at)) / 60000)) : (t.estimated_duration_min != null ? Math.round(Number(t.estimated_duration_min)) : null));
const payMode = (t) => String(t.payment_mode || 'CASH').toUpperCase();

/** One row of the history list. `rider` is { name, rating } or null. */
function listRow(t, { tenant, tz, rider }) {
  const cancelled = isCancelled(t);
  const at = happenedAt(t);
  return {
    tripId: t.trip_id,
    status: cancelled ? 'CANCELLED' : 'COMPLETED',
    rawStatus: t.status,
    at,
    day: at ? dayKey(at, tz) : null,
    pickup: { name: (t.pickup && (t.pickup.name || t.pickup.title)) || '', address: (t.pickup && t.pickup.address) || '' },
    drop: { name: (t.drop && (t.drop.name || t.drop.title)) || '', address: (t.drop && t.drop.address) || '' },
    riderName: (rider && rider.name) || '',
    riderRating: (t.rider_rating && t.rider_rating.stars) || null,
    distanceKm: t.distance_km != null ? Number(t.distance_km) : null,
    durationMin: cancelled ? null : durationMin(t),
    paymentMode: payMode(t),
    earnings: cancelled ? 0 : earningsFor(t, tenant).earnings,
    cancelReason: cancelled ? (t.cancellation_reason || (t.cancelled_by === 'DRIVER' || t.status === 'CANCELLED_BY_DRIVER' ? 'Cancelled by you' : 'Cancelled by passenger')) : null
  };
}

/** A search box match: place names, rider name, date (as written on screen) or trip id. */
function matchesSearch(row, q, tz) {
  const needle = String(q || '').trim().toLowerCase();
  if (!needle) return true;
  const date = row.at ? new Date(row.at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: tz }).toLowerCase() : '';
  const hay = [row.pickup.name, row.pickup.address, row.drop.name, row.drop.address, row.riderName, row.tripId, date, row.day].join(' ').toLowerCase();
  return needle.split(/\s+/).every((w) => hay.includes(w));
}

/** The timeline the details screen draws, from the trip's own moments. Each step carries the minutes since the one before. */
function timelineOf(t) {
  const steps = [];
  const push = (label, at, prev, note) => {
    if (!at) return;
    const gap = prev ? Math.max(0, Math.round((new Date(at) - new Date(prev)) / 60000)) : 0;
    steps.push({ label, at, note: note || null, sincePreviousMin: gap });
  };
  push('Ride accepted', t.responded_at, null);
  push('Arrived at pickup', t.arrived_at, t.responded_at);
  push('Ride started', t.started_at, t.arrived_at || t.responded_at);
  if (t.status === COMPLETED) push('Ride completed', t.completed_at, t.started_at);
  else if (isCancelled(t)) push(t.status === 'CANCELLED_BY_DRIVER' ? 'Cancelled by you' : 'Cancelled by passenger', t.cancelled_at, steps.length ? steps[steps.length - 1].at : t.responded_at, t.cancellation_reason || null);
  return steps.map((s, i) => ({ label: s.label, at: s.at, note: s.note, tookMin: i === 0 ? null : s.sincePreviousMin }));
}

module.exports = { HISTORY_STATUSES, COMPLETED, CANCELLED, RANGES, isCancelled, happenedAt, dayKey, rangeBounds, inWindow, statsFor, changePercent, listRow, matchesSearch, timelineOf, durationMin, payMode, round2, DAY_MS };
