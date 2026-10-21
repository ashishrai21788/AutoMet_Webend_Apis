/**
 * The driver app's Earnings screens (Overview, Analytics, Payouts & History), all from the business's own records.
 * Money is worked out in whole minor units (see lib/driverMoney.js) and sent as plain numbers in the currency's major unit
 * next to the minor value, so the app never does arithmetic on money.
 *
 *   GET  /api/v1/driver/earnings/overview?range=today|week|month
 *   GET  /api/v1/driver/earnings/analytics?range=...&trend=daily|weekly|monthly
 *   GET  /api/v1/driver/earnings/export.csv?range=...
 *   GET  /api/v1/driver/earnings/payouts                 balance, bank, open request, history
 *   GET  /api/v1/driver/earnings/payouts/transactions    earnings and payouts, newest first, paged
 *   PUT  /api/v1/driver/earnings/bank                    the bank account the business pays
 *   POST /api/v1/driver/earnings/payouts/withdraw        { amount }
 *   POST /api/v1/driver/earnings/payouts/:id/cancel
 */
const { TripDetails } = require('../models/tripDetailsModel');
const { DriverPayout } = require('../models/driverPayoutModel');
const { DriverAdjustment } = require('../models/driverLedgerModel');
const incentives = require('../lib/incentives');
const { VehicleCategory } = require('../models/businessModels');
const { DriverDutySession } = require('../models/driverDutySessionModel');
const { createModel } = require('../models/dynamicModel');
const { onlineSeconds } = require('../lib/dutyLog');
const { startOfDay } = require('./driverSummaryController');
const money = require('../lib/driverMoney');
const DT = require('../lib/driverTrips');
const { digitsOf, toMinor } = require('../lib/riderInvoice');
const c = require('./fleet/common');

const DAY_MS = DT.DAY_MS;
const RANGES = ['today', 'week', 'month'];
const pct = (a, b) => (b > 0 ? Math.round(((a - b) / b) * 100) : null);
const share = (part, whole) => (whole > 0 ? Math.round((part / whole) * 100) : 0);

const ctx = (req) => {
  const tz = (req.business.market && req.business.market.timezone) || 'Asia/Kolkata';
  const currency = (req.business.market && req.business.market.currency) || 'INR';
  return { tz, currency, digits: digitsOf(currency), now: new Date() };
};

const fmtMajor = (minor, digits) => minor / 10 ** digits;
const m = (minor, digits) => ({ minor, amount: fmtMajor(minor, digits) });

/** All completed trips for this driver (most recent 20000). */
async function completedTrips(req) {
  return TripDetails.find({ driver_id: req.ownDriver.driverId, status: 'COMPLETED' }).limit(20000).lean();
}

/** Incentives and admin adjustments for this driver. Bonuses already earned are credited first, so every figure includes them. */
async function ledger(req, completed) {
  const { currency } = ctx(req);
  try { await incentives.settle({ tenantId: req.business.tenantId, driverId: req.ownDriver.driverId, currency, completed }); } catch (e) { console.error('[incentives]', e && e.message); }
  return DriverAdjustment.find({ tenantId: req.business.tenantId, driverId: req.ownDriver.driverId }).limit(5000).lean();
}
const adjWithin = (a, from, to) => { const ms = new Date(a.at).getTime(); return (!from || ms >= from.getTime()) && (!to || ms < to.getTime()); };

const at = (t) => t.completed_at || t.cancelled_at || t.requested_at;
const within = (t, from, to) => { const x = at(t); if (!x) return false; const ms = new Date(x).getTime(); return (!from || ms >= from.getTime()) && (!to || ms < to.getTime()); };

function windowOf(range, now, tz) {
  const todayStart = startOfDay(now, tz);
  if (range === 'today') return { from: todayStart, to: new Date(todayStart.getTime() + DAY_MS), prevFrom: new Date(todayStart.getTime() - DAY_MS), prevTo: todayStart, label: 'Today', vs: 'yesterday', todayStart };
  if (range === 'month') { const from = new Date(todayStart.getTime() - 29 * DAY_MS); return { from, to: new Date(todayStart.getTime() + DAY_MS), prevFrom: new Date(from.getTime() - 30 * DAY_MS), prevTo: from, label: 'This Month', vs: 'last month', todayStart }; }
  const from = new Date(todayStart.getTime() - 6 * DAY_MS);
  return { from, to: new Date(todayStart.getTime() + DAY_MS), prevFrom: new Date(from.getTime() - 7 * DAY_MS), prevTo: from, label: 'This Week', vs: 'last week', todayStart };
}

const dateLabel = (d, tz, opts) => new Intl.DateTimeFormat('en-IN', { timeZone: tz, ...opts }).format(d);

/** Bars for a window: 3-hour slots for today, a bar per day otherwise. */
function bars(trips, win, tenant, tz, adj = []) {
  const out = [];
  if (win.label === 'Today') {
    for (let h = 0; h < 24; h += 3) {
      const from = new Date(win.from.getTime() + h * 3600 * 1000); const to = new Date(from.getTime() + 3 * 3600 * 1000);
      const rows = trips.filter((t) => within(t, from, to));
      out.push({ label: `${h % 12 === 0 ? 12 : h % 12}${h < 12 ? 'a' : 'p'}`, trips: rows.length, netMinor: money.totals(rows, tenant, adj.filter((a) => adjWithin(a, from, to))).totalMinor });
    }
    return out;
  }
  const days = Math.round((win.to.getTime() - win.from.getTime()) / DAY_MS);
  for (let i = 0; i < days; i++) {
    const from = new Date(win.from.getTime() + i * DAY_MS); const to = new Date(from.getTime() + DAY_MS);
    const rows = trips.filter((t) => within(t, from, to));
    const mid = new Date(from.getTime() + 12 * 3600 * 1000);
    out.push({ label: dateLabel(mid, tz, { weekday: 'short' }), sub: dateLabel(mid, tz, { day: '2-digit', month: 'short' }), trips: rows.length, netMinor: money.totals(rows, tenant, adj.filter((a) => adjWithin(a, from, to))).totalMinor });
  }
  return out;
}

const ratingOf = (rows) => {
  const stars = rows.map((t) => Number(t.rider_rating && t.rider_rating.stars)).filter((n) => n >= 1 && n <= 5);
  return stars.length ? { avg: Math.round((stars.reduce((a, b) => a + b, 0) / stars.length) * 10) / 10, count: stars.length, stars } : { avg: null, count: 0, stars: [] };
};

async function sessionsFor(req, from) {
  return DriverDutySession.find({ driverId: req.ownDriver.driverId, startedAt: { $gte: new Date(from.getTime() - DAY_MS) } }).lean();
}

async function overview(req, res) {
  const { tz, digits, now } = ctx(req);
  const range = RANGES.includes(String(req.query.range)) ? String(req.query.range) : 'week';
  const win = windowOf(range, now, tz);
  const all = await completedTrips(req);
  const adj = await ledger(req, all);
  const cur = all.filter((t) => within(t, win.from, win.to));
  const prev = all.filter((t) => within(t, win.prevFrom, win.prevTo));
  const a = money.totals(cur, req.business, adj.filter((x) => adjWithin(x, win.from, win.to))); const b = money.totals(prev, req.business, adj.filter((x) => adjWithin(x, win.prevFrom, win.prevTo)));
  const fresh = (await createModel('drivers').findOne({ driverId: req.ownDriver.driverId }).lean()) || req.ownDriver;
  const sessions = await sessionsFor(req, win.prevFrom);
  const onlineNow = onlineSeconds(sessions, fresh, win.from, now, now);
  const onlinePrev = onlineSeconds(sessions, fresh, win.prevFrom, win.prevTo, now);
  const avgNow = a.trips ? Math.round((a.netMinor + a.tipMinor) / a.trips) : 0; const avgPrev = b.trips ? Math.round((b.netMinor + b.tipMinor) / b.trips) : 0;
  const rNow = ratingOf(cur); const rPrev = ratingOf(prev);
  const barList = bars(cur, win, req.business, tz, adj);
  const peak = barList.reduce((best, x, i) => (x.netMinor > (barList[best] ? barList[best].netMinor : -1) ? i : best), 0);
  const change = pct(a.totalMinor, b.totalMinor);
  const offers = await incentives.offersFor({ tenantId: req.business.tenantId, driverId: req.ownDriver.driverId, now, completed: all });
  const bonusOffers = offers.filter((o) => !o.goal && !o.paid);
  const goal = offers.find((o) => o.goal) || null;
  const sett = money.settingsOf(req.business);
  return c.ok(res, {
    currency: ctx(req).currency, timezone: tz, range, rangeLabel: win.label, comparedWith: win.vs,
    total: { ...m(a.totalMinor, digits), previous: m(b.totalMinor, digits), changePercent: change },
    completedTrips: { value: a.trips, changePercent: pct(a.trips, b.trips) },
    onlineSeconds: { value: onlineNow, changePercent: pct(onlineNow, onlinePrev) },
    averagePerTrip: { ...m(avgNow, digits), changePercent: pct(avgNow, avgPrev) },
    rating: { value: rNow.avg, count: rNow.count, change: rNow.avg != null && rPrev.avg != null ? Math.round((rNow.avg - rPrev.avg) * 10) / 10 : null },
    bars: barList.map((x) => ({ label: x.label, sub: x.sub || null, trips: x.trips, ...m(x.netMinor, digits) })),
    peakIndex: barList.length && barList[peak].netMinor > 0 ? peak : null,
    message: change != null && change > 0 ? { title: "You're doing great!", text: `Your earnings are ${change}% higher than ${win.vs}.` } : null,
    incentives: { activeOffers: bonusOffers.length, bonusPotential: m(bonusOffers.reduce((s, o) => s + o.bonusMinor, 0), digits) },
    goal: goal ? { id: goal.id, name: goal.name, target: goal.targetTrips, progress: goal.progress, endsAt: goal.endsAt } : null,
    processingNote: sett.processingNote
  });
}

function trendSeries(all, kind, now, tz, tenant, digits, adj = []) {
  const todayStart = startOfDay(now, tz);
  const out = [];
  if (kind === 'monthly') {
    for (let i = 5; i >= 0; i--) {
      const anchor = new Date(todayStart.getTime() - i * 30 * DAY_MS);
      const from = new Date(anchor.getTime() - 29 * DAY_MS); const to = new Date(anchor.getTime() + DAY_MS);
      out.push({ label: dateLabel(from, tz, { month: 'short' }), sub: `${dateLabel(from, tz, { day: '2-digit', month: 'short' })} – ${dateLabel(anchor, tz, { day: '2-digit', month: 'short' })}`, from, to });
    }
  } else if (kind === 'weekly') {
    for (let i = 7; i >= 0; i--) {
      const end = new Date(todayStart.getTime() - i * 7 * DAY_MS); const from = new Date(end.getTime() - 6 * DAY_MS); const to = new Date(end.getTime() + DAY_MS);
      out.push({ label: dateLabel(from, tz, { day: '2-digit', month: 'short' }), sub: `${dateLabel(from, tz, { day: '2-digit', month: 'short' })} – ${dateLabel(end, tz, { day: '2-digit', month: 'short' })}`, from, to });
    }
  } else {
    for (let i = 6; i >= 0; i--) {
      const from = new Date(todayStart.getTime() - i * DAY_MS); const to = new Date(from.getTime() + DAY_MS); const mid = new Date(from.getTime() + 12 * 3600 * 1000);
      out.push({ label: dateLabel(mid, tz, { weekday: 'short' }), sub: dateLabel(mid, tz, { day: '2-digit', month: 'short' }), from, to });
    }
  }
  return out.map((p) => ({ label: p.label, sub: p.sub, ...m(money.totals(all.filter((t) => within(t, p.from, p.to)), tenant, adj.filter((x) => adjWithin(x, p.from, p.to))).totalMinor, digits) }));
}

async function analytics(req, res) {
  const { tz, digits, now, currency } = ctx(req);
  const range = RANGES.includes(String(req.query.range)) ? String(req.query.range) : 'week';
  const trend = ['daily', 'weekly', 'monthly'].includes(String(req.query.trend)) ? String(req.query.trend) : 'daily';
  const win = windowOf(range, now, tz);
  const all = await completedTrips(req);
  const adj = await ledger(req, all);
  const cur = all.filter((t) => within(t, win.from, win.to));
  const adjCur = adj.filter((x) => adjWithin(x, win.from, win.to));
  const a = money.totals(cur, req.business, adjCur);

  // what the passenger paid, the bonuses and tips on top, what the business kept, and any correction: they add up to the net
  const gross = a.fareMinor + a.incentiveMinor + a.tipMinor + Math.max(0, a.adjustMinor);
  const breakdown = [
    { key: 'fares', label: 'Trip Earnings', ...m(a.fareMinor, digits), percent: share(a.fareMinor, gross) },
    { key: 'incentives', label: 'Incentives & Bonuses', ...m(a.incentiveMinor, digits), percent: share(a.incentiveMinor, gross) },
    { key: 'tips', label: 'Tips', ...m(a.tipMinor, digits), percent: share(a.tipMinor, gross) },
    { key: 'fees', label: 'Platform Fees', ...m(-a.feeMinor, digits), percent: -share(a.feeMinor, gross) },
    { key: 'adjustments', label: 'Adjustments', ...m(a.adjustMinor, digits), percent: share(a.adjustMinor, gross) }
  ];
  // by ride type
  const categories = await req.data.find(VehicleCategory, {});
  const nameOf = new Map((categories || []).map((x) => [x.categoryId, x.name]));
  const typeMap = new Map();
  for (const t of cur) { const k = nameOf.get(t.category_id) || 'Other'; const x = money.tripMoney(t, req.business); typeMap.set(k, (typeMap.get(k) || 0) + x.netMinor + x.tipMinor); }
  const bonusMinor = a.incentiveMinor + a.adjustMinor;
  if (bonusMinor) typeMap.set('Bonuses & adjustments', bonusMinor);
  const byRideType = [...typeMap.entries()].map(([label, minor]) => ({ label, ...m(minor, digits), percent: share(minor, a.totalMinor) })).sort((x, y) => y.minor - x.minor);
  // by trip type: normal rides, surge rides, tips and bonuses
  const tripTypes = [['Normal Rides', a.normalNetMinor, true], ['Surge Rides', a.surgeNetMinor, true], ['Incentive Rides', a.incentiveMinor, true], ['Tips', a.tipMinor, false], ['Adjustments', a.adjustMinor, false]]
    .filter(([, v, always]) => always || v !== 0)
    .map(([label, minor]) => ({ label, ...m(minor, digits), percent: share(minor, a.totalMinor) }));
  // by payment method, always the same three rows as the design: online, cash collected, and wallet / others (bonuses and adjustments are paid by the business)
  const payMap = new Map([['UPI / Online', 0], ['Cash Collected', 0], ['Wallet / Others', 0]]);
  for (const t of cur) {
    const mode = String(t.payment_mode || 'CASH').toUpperCase();
    const label = mode === 'CASH' ? 'Cash Collected' : ['UPI', 'ONLINE', 'CARD', 'NETBANKING'].includes(mode) ? 'UPI / Online' : 'Wallet / Others';
    const x = money.tripMoney(t, req.business);
    payMap.set(label, payMap.get(label) + x.netMinor + x.tipMinor);
  }
  payMap.set('Wallet / Others', payMap.get('Wallet / Others') + bonusMinor);
  const byPayment = [...payMap.entries()].map(([label, minor]) => ({ label, ...m(minor, digits), percent: share(minor, a.totalMinor) }));

  // trips tab
  const taken = await TripDetails.find({ driver_id: req.ownDriver.driverId, status: { $in: DT.HISTORY_STATUSES } }).limit(20000).lean();
  const takenWin = taken.filter((t) => within(t, win.from, win.to));
  const cancelledByYou = takenWin.filter((t) => t.status === 'CANCELLED_BY_DRIVER').length;
  const cancelledByRider = takenWin.filter((t) => t.status === 'CANCELLED_BY_USER_AFTER_ACCEPTANCE').length;
  const km = cur.map((t) => Number(t.distance_km)).filter((n) => Number.isFinite(n));
  const mins = cur.map((t) => DT.durationMin(t)).filter((n) => Number.isFinite(n));
  const tripsTab = {
    completed: cur.length, cancelledByYou, cancelledByRider,
    totalKm: Math.round(km.reduce((s, x) => s + x, 0) * 10) / 10,
    avgKm: km.length ? Math.round((km.reduce((s, x) => s + x, 0) / km.length) * 10) / 10 : null,
    avgMinutes: mins.length ? Math.round(mins.reduce((s, x) => s + x, 0) / mins.length) : null
  };
  // time tab
  const fresh = (await createModel('drivers').findOne({ driverId: req.ownDriver.driverId }).lean()) || req.ownDriver;
  const sessions = await sessionsFor(req, win.from);
  const dayCount = Math.round((win.to.getTime() - win.from.getTime()) / DAY_MS);
  const perDay = [];
  for (let i = 0; i < dayCount; i++) {
    const from = new Date(win.from.getTime() + i * DAY_MS); const to = new Date(from.getTime() + DAY_MS);
    perDay.push({ label: dateLabel(new Date(from.getTime() + 12 * 3600 * 1000), tz, { weekday: 'short', day: '2-digit', month: 'short' }), seconds: onlineSeconds(sessions, fresh, from, to > now ? now : to, now) });
  }
  const onlineTotal = perDay.reduce((s, x) => s + x.seconds, 0);
  const timeTab = { totalSeconds: onlineTotal, perDay, averageSecondsPerDay: dayCount ? Math.round(onlineTotal / dayCount) : 0, earningsPerHour: onlineTotal >= 60 ? m(Math.round((a.totalMinor * 3600) / onlineTotal), digits) : null };
  // ratings tab
  const r = ratingOf(cur);
  const dist = [5, 4, 3, 2, 1].map((s) => ({ stars: s, count: r.stars.filter((x) => x === s).length }));
  const tagCount = new Map();
  for (const t of cur) for (const tag of (t.rider_rating && t.rider_rating.tags) || []) tagCount.set(tag, (tagCount.get(tag) || 0) + 1);
  const ratingsTab = { average: r.avg, count: r.count, distribution: dist, tags: [...tagCount.entries()].map(([tag, count]) => ({ tag, count })).sort((x, y) => y.count - x.count).slice(0, 8) };

  return c.ok(res, {
    currency, timezone: tz, range, rangeLabel: win.label,
    from: win.from.toISOString(), to: new Date(win.to.getTime() - 1).toISOString(),
    dateRange: `${dateLabel(win.from, tz, { day: '2-digit', month: 'short' })} – ${dateLabel(new Date(win.to.getTime() - 1), tz, { day: '2-digit', month: 'short', year: 'numeric' })}`,
    earnings: {
      breakdown, net: { label: 'Net Earnings', ...m(a.totalMinor, digits), note: 'After platform fees and adjustments', toWallet: true },
      total: m(a.fareMinor, digits),
      trend: { kind: trend, points: trendSeries(all, trend, now, tz, req.business, digits, adj) },
      byRideType, byTripType: tripTypes, byPaymentMethod: byPayment
    },
    trips: tripsTab, time: timeTab, ratings: ratingsTab
  });
}

const csvCell = (v) => { const s = String(v == null ? '' : v); const safe = /^[=+\-@\t\r]/.test(s) ? "'" + s : s; return /[",\n]/.test(safe) ? '"' + safe.replace(/"/g, '""') + '"' : safe; };

async function exportCsv(req, res) {
  const { tz, digits, now } = ctx(req);
  const range = RANGES.includes(String(req.query.range)) ? String(req.query.range) : 'week';
  const win = windowOf(range, now, tz);
  const allTrips = await completedTrips(req);
  const adjAll = await ledger(req, allTrips);
  const cur = allTrips.filter((t) => within(t, win.from, win.to)).sort((x, y) => new Date(at(x)) - new Date(at(y)));
  const lines = [['Date', 'Time', 'Trip ID', 'Payment', 'Fare', 'Platform fee', 'Tip', 'Your earnings'].join(',')];
  let net = 0; let fare = 0; let fee = 0; let tips = 0;
  for (const t of cur) {
    const x = money.tripMoney(t, req.business); net += x.netMinor + x.tipMinor; fare += x.fareMinor; fee += x.feeMinor; tips += x.tipMinor;
    lines.push([dateLabel(new Date(at(t)), tz, { day: '2-digit', month: 'short', year: 'numeric' }), dateLabel(new Date(at(t)), tz, { hour: '2-digit', minute: '2-digit', hour12: true }), t.trip_id, String(t.payment_mode || 'CASH').toUpperCase(), fmtMajor(x.fareMinor, digits).toFixed(digits), fmtMajor(x.feeMinor, digits).toFixed(digits), fmtMajor(x.tipMinor, digits).toFixed(digits), fmtMajor(x.netMinor + x.tipMinor, digits).toFixed(digits)].map(csvCell).join(','));
  }
  for (const a of adjAll.filter((x) => adjWithin(x, win.from, win.to)).sort((x, y) => new Date(x.at) - new Date(y.at))) {
    net += a.amountMinor;
    lines.push([dateLabel(new Date(a.at), tz, { day: '2-digit', month: 'short', year: 'numeric' }), dateLabel(new Date(a.at), tz, { hour: '2-digit', minute: '2-digit', hour12: true }), a.kind === 'INCENTIVE' ? 'Incentive bonus' : 'Adjustment', a.title || a.reason || '', '', '', '', fmtMajor(a.amountMinor, digits).toFixed(digits)].map(csvCell).join(','));
  }
  lines.push(['Total', '', `${cur.length} trips`, '', fmtMajor(fare, digits).toFixed(digits), fmtMajor(fee, digits).toFixed(digits), fmtMajor(tips, digits).toFixed(digits), fmtMajor(net, digits).toFixed(digits)].map(csvCell).join(','));
  res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="earnings-${range}.csv"`, 'Cache-Control': 'private, no-store' });
  return res.status(200).send('﻿' + lines.join('\r\n') + '\r\n');
}

/** GET /incentives: every open offer with the driver's progress, and what they have already been paid. */
async function incentivesList(req, res) {
  const { digits, now } = ctx(req);
  const all = await completedTrips(req);
  await ledger(req, all);
  const offers = await incentives.offersFor({ tenantId: req.business.tenantId, driverId: req.ownDriver.driverId, now, completed: all });
  return c.ok(res, { currency: ctx(req).currency, offers: offers.map((o) => ({ ...o, bonus: m(o.bonusMinor, digits) })) });
}

// ---------------------------------------------------------------------------------------------------------- payouts

const IFSC = /^[A-Z]{4}0[A-Z0-9]{6}$/;

const payoutView = (p, digits) => ({
  id: p.payoutId, status: p.status, ...m(p.amountMinor, digits), currency: p.currency, requestedAt: p.requestedAt, paidAt: p.paidAt || null,
  bank: [p.bankLabel, p.accountLast4 ? `••••${p.accountLast4}` : ''].filter(Boolean).join(' '), reference: p.reference || '', failureReason: p.failureReason || '',
  at: p.paidAt || p.failedAt || p.cancelledAt || p.processingAt || p.requestedAt
});

async function state(req) {
  const { digits, currency } = ctx(req);
  const all = await completedTrips(req);
  const [adj, payouts] = await Promise.all([ledger(req, all), DriverPayout.find({ tenantId: req.business.tenantId, driverId: req.ownDriver.driverId }).lean()]);
  const settings = money.settingsOf(req.business);
  const life = money.totals(all, req.business, adj);
  const bal = money.balanceOf(life, payouts, settings);
  return { digits, currency, all, adj, payouts, settings, life, bal };
}

async function payoutsSummary(req, res) {
  const s = await state(req);
  const { digits } = s;
  const fresh = (await createModel('drivers').findOne({ driverId: req.ownDriver.driverId }).lean()) || req.ownDriver;
  const bank = fresh.bankAccount || {};
  const hasBank = !!(bank.accountNumber && bank.ifscCode && bank.accountHolderName);
  const open = s.payouts.find((p) => p.open);
  const history = s.payouts.slice().sort((x, y) => new Date(y.requestedAt) - new Date(x.requestedAt));
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 50); const skip = Math.max(parseInt(req.query.skip, 10) || 0, 0);
  const statusFilter = ['PAID', 'FAILED', 'REQUESTED', 'PROCESSING', 'CANCELLED'].includes(String(req.query.status)) ? String(req.query.status) : null;
  const list = history.filter((p) => !statusFilter || p.status === statusFilter);
  return c.ok(res, {
    currency: s.currency,
    available: m(s.bal.availableMinor, digits),
    totalEarnings: m(s.life.totalMinor, digits),
    tipsEarned: m(s.life.tipMinor, digits),
    bonusesEarned: m(s.life.incentiveMinor + s.life.adjustMinor, digits),
    processingNote: s.settings.processingNote,
    paidOut: m(s.bal.paidMinor, digits),
    pending: m(s.bal.openMinor, digits),
    cashEarnings: m(s.life.cashNetMinor, digits),
    onlineEarnings: m(s.life.onlineNetMinor, digits),
    cashFeeOwed: m(s.life.cashFeeMinor, digits),
    minWithdrawal: m(s.settings.minWithdrawalMinor || 1, digits),
    cashWithdrawable: s.settings.cashWithdrawable,
    bank: { configured: hasBank, holder: hasBank ? bank.accountHolderName : '', bankName: bank.bankName || '', last4: hasBank ? money.last4(bank.accountNumber) : '', ifscMasked: hasBank ? String(bank.ifscCode).slice(0, 4) + '•••••••' : '' },
    openRequest: open ? payoutView(open, digits) : null,
    history: list.slice(skip, skip + limit).map((p) => payoutView(p, digits)),
    hasMore: skip + limit < list.length, nextSkip: skip + limit,
    support: { phone: req.business.supportPhone || '', email: req.business.supportEmail || '' }
  });
}

async function transactions(req, res) {
  const s = await state(req);
  const { tz } = ctx(req);
  const rows = [];
  for (const t of s.all) { const x = money.tripMoney(t, req.business); rows.push({ kind: 'EARNING', id: t.trip_id, at: at(t), ...m(x.netMinor, s.digits), title: x.cash ? 'Cash ride' : 'Online ride', sub: `Trip ${t.trip_id}`, mode: String(t.payment_mode || 'CASH').toUpperCase() }); }
  for (const t of s.all.filter((x) => Number(x.tip_minor) > 0)) rows.push({ kind: 'TIP', id: `tip_${t.trip_id}`, at: t.tip_at || at(t), ...m(Number(t.tip_minor), s.digits), title: 'Tip', sub: `Trip ${t.trip_id}`, mode: String(t.payment_mode || 'CASH').toUpperCase() });
  for (const a of s.adj) rows.push({ kind: a.kind, id: a.adjustmentId, at: a.at, ...m(a.amountMinor, s.digits), title: a.kind === 'INCENTIVE' ? 'Incentive bonus' : (a.amountMinor < 0 ? 'Adjustment (debit)' : 'Adjustment'), sub: a.title && a.kind === 'INCENTIVE' ? a.title : (a.reason || ''), mode: 'BANK' });
  for (const p of s.payouts.filter((x) => x.status === 'PAID')) rows.push({ kind: 'PAYOUT', id: p.payoutId, at: p.paidAt, ...m(-p.amountMinor, s.digits), title: 'Payout', sub: [p.bankLabel, p.accountLast4 ? `••••${p.accountLast4}` : '', p.reference].filter(Boolean).join('  '), mode: 'BANK' });
  rows.sort((x, y) => new Date(y.at) - new Date(x.at));
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 50); const skip = Math.max(parseInt(req.query.skip, 10) || 0, 0);
  return c.ok(res, { currency: s.currency, timezone: tz, items: rows.slice(skip, skip + limit), hasMore: skip + limit < rows.length, nextSkip: skip + limit });
}

async function saveBank(req, res) {
  const b = req.body || {};
  const holder = String(b.accountHolderName || '').trim().replace(/\s+/g, ' ');
  const number = String(b.accountNumber || '').replace(/\s+/g, '');
  const ifsc = String(b.ifscCode || '').trim().toUpperCase();
  const bankName = String(b.bankName || '').trim().slice(0, 60);
  const errors = {};
  if (holder.length < 2 || holder.length > 80) errors.accountHolderName = 'Enter the name on the account';
  if (!/^\d{9,18}$/.test(number)) errors.accountNumber = 'Enter 9 to 18 digits';
  if (!IFSC.test(ifsc)) errors.ifscCode = 'Enter a valid IFSC code, like HDFC0001234';
  if (bankName.length < 2) errors.bankName = 'Enter the bank name';
  if (Object.keys(errors).length) return c.invalid(res, errors);
  const open = await DriverPayout.findOne({ tenantId: req.business.tenantId, driverId: req.ownDriver.driverId, open: true }).lean();
  if (open) return c.fail(res, 409, 'You cannot change your bank account while a withdrawal is in progress.');
  await createModel('drivers').findOneAndUpdate({ driverId: req.ownDriver.driverId }, { $set: { bankAccount: { accountHolderName: holder, accountNumber: number, ifscCode: ifsc, bankName }, updatedAt: new Date() } });
  return c.ok(res, { configured: true, holder, bankName, last4: money.last4(number) });
}

async function withdraw(req, res) {
  const s = await state(req);
  const { digits, currency } = s;
  const amountMinor = toMinor(Number(req.body && req.body.amount), digits);
  if (!Number.isFinite(amountMinor) || amountMinor <= 0) return c.fail(res, 400, 'Enter an amount to withdraw.');
  const fresh = (await createModel('drivers').findOne({ driverId: req.ownDriver.driverId }).lean()) || req.ownDriver;
  const bank = fresh.bankAccount || {};
  if (!(bank.accountNumber && bank.ifscCode && bank.accountHolderName)) return c.fail(res, 409, 'Add your bank account first.');
  if (s.payouts.some((p) => p.open)) return c.fail(res, 409, 'You already have a withdrawal in progress.');
  const min = s.settings.minWithdrawalMinor || 1;
  if (amountMinor < min) return c.fail(res, 400, `The smallest withdrawal is ${fmtMajor(min, digits).toFixed(digits)}.`);
  if (amountMinor > s.bal.availableMinor) return c.fail(res, 400, 'That is more than your available balance.');
  const now = new Date();
  try {
    const doc = await DriverPayout.create({
      tenantId: req.business.tenantId, payoutId: c.newId('po'), driverId: req.ownDriver.driverId, amountMinor, currency, status: 'REQUESTED', open: true,
      bankLabel: bank.bankName || '', accountLast4: money.last4(bank.accountNumber), requestedAt: now, createdAt: now, updatedAt: now
    });
    return c.ok(res, payoutView(doc.toObject ? doc.toObject() : doc, digits));
  } catch (e) {
    if (c.DUP(e)) return c.fail(res, 409, 'You already have a withdrawal in progress.');
    throw e;
  }
}

async function cancelWithdrawal(req, res) {
  const now = new Date();
  const moved = await DriverPayout.findOneAndUpdate(
    { tenantId: req.business.tenantId, payoutId: String(req.params.id), driverId: req.ownDriver.driverId, status: 'REQUESTED' },
    { $set: { status: 'CANCELLED', open: false, cancelledAt: now, updatedAt: now } }, { new: true }
  );
  if (!moved) return c.fail(res, 409, 'This withdrawal can no longer be cancelled.');
  return c.ok(res, payoutView(moved.toObject ? moved.toObject() : moved, ctx(req).digits));
}

const safe = (fn) => async (req, res) => {
  try { return await fn(req, res); } catch (e) { console.error('[driver earnings]', e && e.stack ? e.stack : e); return c.fail(res, 500, 'Something went wrong. Please try again.'); }
};

module.exports = {
  overview: safe(overview), incentivesList: safe(incentivesList), analytics: safe(analytics), exportCsv: safe(exportCsv), payoutsSummary: safe(payoutsSummary),
  transactions: safe(transactions), saveBank: safe(saveBank), withdraw: safe(withdraw), cancelWithdrawal: safe(cancelWithdrawal)
};
