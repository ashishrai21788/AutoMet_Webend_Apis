/**
 * Payments over HTTP. The rules live in lib/payments/*; this file only authenticates, picks the business from the SIGNED-IN account (never
 * from the request body), validates the request shape, calls the service, and shapes the reply.
 *
 * Rider and driver (signed in, /api/v1/payments):
 *   GET  /methods                       which ways of paying this business has switched on
 *   POST /create                        rider: open the online payment for a completed ride { trip_id, idempotency_key }
 *   GET  /trip/:tripId                  rider or driver of the ride: the authoritative payment state (apps read this after a restart)
 *   POST /:paymentId/refresh            rider: ask the provider what happened (after returning from the payment screen)
 *   POST /cash/confirm                  driver: confirm the cash collected { trip_id, collected_minor?, idempotency_key }
 *   POST /cash/dispute                  rider or driver: dispute the collection { trip_id, reason }
 *   GET  /commission                    driver: what they owe in commission, from the ledger
 *   POST /commission/pay                driver: pay commission online { amount_minor, idempotency_key }
 *   POST /mock/simulate                 development only (mock gateway enabled, never production): { payment_id, scenario }
 * Provider (no sign-in; the signature is the authentication):
 *   POST /webhook/:provider             raw body, verified inside the service
 *
 * Dashboard (/api/admin/business, staff with payments.view or payments.manage; each change is audited):
 *   GET  /payments, GET /payments/:id, POST /payments/:id/refund, POST /payments/:id/cash/resolve,
 *   GET  /commission, POST /commission/drivers/:driverId/recover,
 *   POST /reconciliation/run, GET /reconciliation, POST /reconciliation/:id/resolve
 *
 * Amounts in and out are whole minor units (`..._minor`). A client can never send the amount to pay: it is the server's finalised fare.
 */
const crypto = require('crypto');
const { AdminAudit } = require('../models/adminModels');
const { Payment, PaymentRefund } = require('../models/paymentModels');
const { TripDetails } = require('../models/tripDetailsModel');
const { effectiveTenantId } = require('../lib/appTenant');
const svc = require('../lib/payments/service');
const cash = require('../lib/payments/cash');
const refunds = require('../lib/payments/refunds');
const recovery = require('../lib/payments/recovery');
const commission = require('../lib/payments/commission');
const reconcile = require('../lib/payments/reconcile');
const ledger = require('../lib/ledger');
const { tenantPayments, mockEnabled } = require('../lib/payments/config');
const { SCENARIOS } = require('../lib/payments/adapters/mock');

const ok = (res, data, status = 200) => res.status(status).json({ success: true, message: 'OK', data });
const fail = (res, status, message, code) => res.status(status).json({ success: false, message, error: code || undefined, data: null });

/** Known service errors become their own clean replies; anything else is a generic 500 that leaks nothing. */
const guard = (fn) => async (req, res) => {
  try { await fn(req, res); } catch (e) {
    if (e && e.status && e.code) return fail(res, e.status, e.message, e.code);
    console.error(`[payments] ${req.method} ${req.path}:`, e && e.message);
    return fail(res, 500, 'Something went wrong. Please try again.');
  }
};

const account = (req) => req.user || req.driver || null;
const tenantOf = (req) => effectiveTenantId(account(req));
const keyOf = (req) => String((req.body && req.body.idempotency_key) || req.get('Idempotency-Key') || '').trim() || null;
const isMinor = (n) => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;

/** What an app may see of a payment. The commission split is the driver's to see, not the rider's. */
function publicPayment(p, role) {
  if (!p) return null;
  const out = {
    payment_id: p.paymentId, trip_id: p.purpose === 'COMMISSION' ? null : p.tripId, purpose: p.purpose, method: p.method, status: p.status, refund_status: p.refundStatus,
    amount_minor: p.amountMinor, currency: p.currency, refunded_minor: p.refundedMinor || 0, cash_state: p.cashState || null, awaiting_verification: p.method === 'UPI' && (p.status === 'PENDING' || p.status === 'CREATED'),
    expires_at: p.expiresAt || null, created_at: p.createdAt, paid_at: p.succeededAt || null
  };
  if (role === 'driver' && p.commission) out.commission_minor = p.cash && p.cash.adjustedCommission ? p.cash.adjustedCommission.commissionMinor : p.commission.commissionMinor;
  return out;
}

// ---------------------------------------------------------------- rider and driver

exports.methods = guard(async (req, res) => {
  const tenantId = await tenantOf(req);
  const tenant = await svc.loadTenant(tenantId);
  const cfg = tenantPayments(tenant);
  const online = cfg.enabledMethods.includes('UPI') && !!cfg.provider;
  return ok(res, { methods: cfg.enabledMethods.filter((m) => m === 'CASH' || online), mock: online && cfg.provider === 'MOCK' && mockEnabled() });
});

exports.create = guard(async (req, res) => {
  const tripId = String((req.body && (req.body.trip_id || req.body.ride_id)) || '').trim();
  if (!tripId) return fail(res, 400, 'trip_id is required', 'BAD_REQUEST');
  const method = String((req.body && req.body.method) || 'UPI').toUpperCase();
  const r = await svc.createPayment({ tenantId: await tenantOf(req), tripId, riderId: req.authActorId, method, idempotencyKey: keyOf(req) });
  return ok(res, { payment: publicPayment(r.payment, 'user'), created: r.created, checkout: r.checkout || null }, r.created ? 201 : 200);
});

exports.forTrip = guard(async (req, res) => {
  const tenantId = await tenantOf(req);
  const trip = await TripDetails.findOne({ trip_id: String(req.params.tripId), tenant_id: tenantId }).lean();
  const mine = trip && (req.authRole === 'user' ? trip.user_id === req.authActorId : trip.driver_id === req.authActorId);
  if (!mine) return fail(res, 404, 'Ride not found', 'NOT_FOUND');
  const rows = ((await Payment.find({ tenantId, tripId: trip.trip_id, purpose: 'FARE' }).lean()) || []).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  const live = rows.find((p) => p.live) || rows[0] || null;
  return ok(res, { trip_payment_status: trip.payment_status || 'UNPAID', payment: publicPayment(live, req.authRole === 'driver' ? 'driver' : 'user'), attempts: rows.length });
});

exports.refresh = guard(async (req, res) => {
  const tenantId = await tenantOf(req);
  const own = await svc.find({ tenantId, paymentId: String(req.params.paymentId) });
  if (!own || own.riderId !== req.authActorId) return fail(res, 404, 'Payment not found', 'NOT_FOUND');
  return ok(res, { payment: publicPayment(await svc.refresh({ tenantId, paymentId: own.paymentId }), 'user') });
});

exports.confirmCash = guard(async (req, res) => {
  const b = req.body || {};
  const tripId = String(b.trip_id || b.ride_id || '').trim();
  if (!tripId) return fail(res, 400, 'trip_id is required', 'BAD_REQUEST');
  if (b.collected_minor != null && !isMinor(b.collected_minor)) return fail(res, 400, 'collected_minor must be whole minor units', 'BAD_AMOUNT');
  const r = await cash.confirmCash({ tenantId: await tenantOf(req), tripId, driverId: req.authActorId, collectedMinor: b.collected_minor == null ? undefined : b.collected_minor, idempotencyKey: keyOf(req) });
  return ok(res, { payment: publicPayment(r.payment, 'driver'), duplicate: r.duplicate, disputed: !!r.disputed }, r.duplicate || r.disputed ? 200 : 201);
});

exports.disputeCash = guard(async (req, res) => {
  const b = req.body || {};
  const by = req.authRole === 'driver' ? 'driver' : 'rider';
  const p = await cash.disputeCash({ tenantId: await tenantOf(req), tripId: String(b.trip_id || '').trim(), by, actorId: req.authActorId, reason: b.reason });
  return ok(res, { payment: publicPayment(p, by === 'driver' ? 'driver' : 'user') });
});

exports.commissionSummary = guard(async (req, res) => {
  const tenantId = await tenantOf(req);
  const s = await commission.summary({ tenantId, driverId: req.authActorId });
  const payable = await ledger.owedToDriver({ tenantId, driverId: req.authActorId });
  return ok(res, { accrued_minor: s.accruedMinor, collected_minor: s.collectedMinor, outstanding_minor: Math.max(0, s.outstandingMinor), payable_minor: payable, currency: 'INR' });
});

exports.payCommission = guard(async (req, res) => {
  const b = req.body || {};
  if (!isMinor(b.amount_minor)) return fail(res, 400, 'amount_minor must be whole minor units', 'BAD_AMOUNT');
  const r = await svc.createCommissionPayment({ tenantId: await tenantOf(req), driverId: req.authActorId, amountMinor: b.amount_minor, idempotencyKey: keyOf(req) });
  return ok(res, { payment: publicPayment(r.payment, 'driver'), created: r.created, checkout: r.checkout || null }, r.created ? 201 : 200);
});

exports.mockSimulate = guard(async (req, res) => {
  if (!mockEnabled()) return fail(res, 404, 'Not found', 'NOT_FOUND'); // as if the route did not exist
  const b = req.body || {};
  if (!SCENARIOS.includes(b.scenario)) return fail(res, 400, `scenario must be one of ${SCENARIOS.join(', ')}`, 'BAD_SCENARIO');
  const tenantId = await tenantOf(req);
  const own = await svc.find({ tenantId, paymentId: String(b.payment_id || '') });
  const mine = own && (own.purpose === 'COMMISSION' ? own.driverId === req.authActorId : own.riderId === req.authActorId);
  if (!mine) return fail(res, 404, 'Payment not found', 'NOT_FOUND');
  const r = await svc.simulate({ tenantId, paymentId: own.paymentId, scenario: b.scenario });
  return ok(res, { scenario: b.scenario, outcomes: r.replies.map((x) => x.outcome), payment: publicPayment(r.payment, req.authRole === 'driver' ? 'driver' : 'user') });
});

/** Provider callback. Authenticated by the provider's signature over the exact bytes received. */
exports.webhook = async (req, res) => {
  try {
    const raw = req.rawBody || Buffer.from(JSON.stringify(req.body || {}));
    const r = await svc.handleWebhook({ provider: String(req.params.provider || '').toUpperCase(), rawBody: raw, headers: req.headers });
    return res.status(r.httpStatus).json({ received: r.httpStatus === 200, outcome: r.outcome });
  } catch (e) {
    console.error('[payments webhook]', e && e.message);
    return res.status(500).json({ received: false });
  }
};

/** Scheduled upkeep for every business (see lib/payments/jobs.js). Protected by the scheduler secret in the route. */
exports.runJobs = guard(async (req, res) => ok(res, { businesses: await require('../lib/payments/jobs').runAll() }));

// ---------------------------------------------------------------- dashboard

const who = (req) => ({ id: req.admin.adminId, email: req.admin.email });
async function audit(req, action, targetType, targetId, meta) {
  try {
    await AdminAudit.create({ tenantId: req.business.tenantId, actorId: req.admin.adminId, actorEmail: req.admin.email, action, targetType, targetId, meta: meta || {}, ip: req.ip || null });
  } catch (e) { console.warn('[payments] audit write failed:', e.message); }
}

const adminView = (p) => ({
  ...publicPayment(p, 'driver'), tenant_id: p.tenantId, driver_id: p.driverId, rider_id: p.riderId, provider: p.provider, provider_order_id: p.providerOrderId, ledger_txn_id: p.ledgerTxnId,
  commission_snapshot: p.commission || null, cash: p.cash || null, flags: p.flags || [], history: p.history || [], refund: p.refund || null
});

exports.adminSettingsGet = guard(async (req, res) => {
  const { usableProviders, tenantPayments: read } = require('../lib/payments/config');
  const t = await svc.loadTenant(req.business.tenantId);
  const cfg = read(t);
  return ok(res, { enabledMethods: cfg.enabledMethods, provider: cfg.provider, merchantId: cfg.merchantId, commissionRecovery: cfg.commissionRecovery, paymentWindowMinutes: cfg.paymentWindowMinutes, availableProviders: usableProviders(), fundsFlow: cfg.fundsFlow });
});

exports.adminSettingsUpdate = guard(async (req, res) => {
  const { validateSettings } = require('../lib/payments/config');
  const { Tenant } = require('../models/adminModels');
  const { clearAppTenantCache } = require('../lib/appTenant');
  const { value, errors } = validateSettings(req.body);
  if (Object.keys(errors).length) return res.status(400).json({ success: false, message: 'Please fix the highlighted fields', errors, data: null });
  await req.data.update(Tenant, {}, { payments: value });
  clearAppTenantCache();
  await require('./configHistoryController').track(req, 'business.payment_settings_updated', { payments: value });
  await audit(req, 'payments.settings_updated', 'business', req.business.tenantId, { enabledMethods: value.enabledMethods, provider: value.provider, commissionRecovery: value.commissionRecovery });
  return ok(res, { ...value, availableProviders: require('../lib/payments/config').usableProviders() });
});

exports.adminList = guard(async (req, res) => {
  const tenantId = req.business.tenantId;
  const q = req.query || {};
  const filter = { tenantId };
  for (const [param, field] of [['status', 'status'], ['method', 'method'], ['driver_id', 'driverId'], ['trip_id', 'tripId'], ['refund_status', 'refundStatus'], ['purpose', 'purpose']]) if (q[param]) filter[field] = String(q[param]);
  const limit = Math.min(200, Math.max(1, parseInt(q.limit, 10) || 50));
  const rows = ((await Payment.find(filter).lean()) || []).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  const from = q.from ? new Date(q.from) : null; const to = q.to ? new Date(q.to) : null;
  const inRange = rows.filter((p) => (!from || new Date(p.createdAt) >= from) && (!to || new Date(p.createdAt) <= to));
  return ok(res, { items: inRange.slice(0, limit).map(adminView), total: inRange.length });
});

exports.adminGet = guard(async (req, res) => {
  const tenantId = req.business.tenantId;
  const p = await svc.find({ tenantId, paymentId: String(req.params.id) });
  if (!p) return fail(res, 404, 'Payment not found', 'NOT_FOUND');
  const refundRows = (await PaymentRefund.find({ tenantId, paymentId: p.paymentId }).lean()) || [];
  const txns = (await ledger.list({ tenantId })).filter((t) => t.paymentId === p.paymentId);
  return ok(res, { payment: adminView(p), refunds: refundRows, ledger: txns.map((t) => ({ txn_id: t.txnId, type: t.type, entries: t.entries, memo: t.memo, created_at: t.createdAt })) });
});

exports.adminRefund = guard(async (req, res) => {
  const b = req.body || {};
  if (!isMinor(b.amount_minor) || b.amount_minor < 1) return fail(res, 400, 'amount_minor must be whole, positive minor units', 'BAD_AMOUNT');
  const r = await refunds.requestRefund({ tenantId: req.business.tenantId, paymentId: String(req.params.id), amountMinor: b.amount_minor, reason: b.reason, requestedBy: `admin:${req.admin.adminId}`, idempotencyKey: keyOf(req) });
  if (!r.duplicate) await audit(req, 'payment.refund', 'payment', req.params.id, { amountMinor: b.amount_minor, reason: String(b.reason || '').slice(0, 200), refundId: r.refund.refundId, status: r.refund.status });
  return ok(res, { refund: r.refund, duplicate: r.duplicate }, r.duplicate ? 200 : 201);
});

exports.adminResolveCash = guard(async (req, res) => {
  const b = req.body || {};
  const p = await cash.resolveCash({ tenantId: req.business.tenantId, paymentId: String(req.params.id), adminId: req.admin.adminId, action: String(b.action || '').toUpperCase(), adjustedFareMinor: b.adjusted_fare_minor, reason: b.reason });
  await audit(req, 'payment.cash.resolved', 'payment', req.params.id, { action: String(b.action || '').toUpperCase(), adjustedFareMinor: b.adjusted_fare_minor == null ? null : b.adjusted_fare_minor, reason: String(b.reason || '').slice(0, 200) });
  return ok(res, { payment: adminView(p) });
});

exports.adminCommission = guard(async (req, res) => {
  const tenantId = req.business.tenantId;
  const drivers = new Set((await ledger.list({ tenantId })).map((t) => t.driverId).filter(Boolean));
  const rows = [];
  const totals = { accrued_minor: 0, collected_minor: 0, outstanding_minor: 0, payable_minor: 0 };
  for (const driverId of drivers) {
    const s = await commission.summary({ tenantId, driverId });
    const payable = await ledger.owedToDriver({ tenantId, driverId });
    rows.push({ driver_id: driverId, accrued_minor: s.accruedMinor, collected_minor: s.collectedMinor, outstanding_minor: s.outstandingMinor, payable_minor: payable });
    totals.accrued_minor += s.accruedMinor; totals.collected_minor += s.collectedMinor; totals.outstanding_minor += s.outstandingMinor; totals.payable_minor += payable;
  }
  return ok(res, { totals, drivers: rows.sort((a, b) => b.outstanding_minor - a.outstanding_minor), currency: 'INR' });
});

exports.adminRecover = guard(async (req, res) => {
  const r = await recovery.recoverCommission({ tenantId: req.business.tenantId, driverId: String(req.params.driverId), trigger: 'admin', createdBy: `admin:${req.admin.adminId}` });
  await audit(req, 'commission.recovered', 'driver', req.params.driverId, { recoveredMinor: r.recoveredMinor });
  return ok(res, { recovered_minor: r.recoveredMinor, duplicate: r.duplicate });
});

exports.adminReconcileRun = guard(async (req, res) => {
  const r = await reconcile.run({ tenantId: req.business.tenantId });
  await audit(req, 'reconciliation.run', 'reconciliation', crypto.randomBytes(4).toString('hex'), { found: r.discrepancies.length, new: r.newCount });
  return ok(res, r);
});

exports.adminReconcileList = guard(async (req, res) => {
  const status = req.query && req.query.status ? String(req.query.status).toUpperCase() : null;
  return ok(res, { items: await reconcile.list({ tenantId: req.business.tenantId, status: status === 'OPEN' || status === 'RESOLVED' ? status : null }) });
});

exports.adminReconcileResolve = guard(async (req, res) => {
  const row = await reconcile.resolve({ tenantId: req.business.tenantId, discrepancyId: String(req.params.id), adminId: req.admin.adminId, note: (req.body || {}).note });
  await audit(req, 'reconciliation.resolved', 'reconciliation', req.params.id, { note: String((req.body || {}).note || '').slice(0, 200), type: row.type });
  return ok(res, { finding: row });
});

exports.who = who;
exports.publicPayment = publicPayment;
