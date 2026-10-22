/**
 * Driver withdrawals, from the business's side (admin dashboard, Payouts). The business pays the driver outside the app (bank
 * transfer) and records it here with the bank's reference; the driver sees the result at once.
 *
 *   GET  /api/admin/business/payouts?status&q&page     the requests, with totals per status
 *   GET  /api/admin/business/payouts/:id               one request with the account to pay (full details; every view is audited)
 *   POST /api/admin/business/payouts/:id/start         REQUESTED -> PROCESSING
 *   POST /api/admin/business/payouts/:id/pay           REQUESTED|PROCESSING -> PAID   { reference }
 *   POST /api/admin/business/payouts/:id/fail          REQUESTED|PROCESSING -> FAILED { reason }   (the amount returns to the driver's balance)
 *   GET|PUT /api/admin/business/payout-settings        commission %, smallest withdrawal, whether cash earnings are withdrawable
 *
 * Every change is a single atomic update that names the status it expects, so two admins can never process the same request twice.
 */
const { DriverPayout } = require('../models/driverPayoutModel');
const { AdminAudit } = require('../models/adminModels');
const { createModel } = require('../models/dynamicModel');
const { Tenant } = require('../models/adminModels');
const { digitsOf, toMinor } = require('../lib/riderInvoice');
const money = require('../lib/driverMoney');
const { sendPushToDriver } = require('../lib/pushNotification');
const c = require('./fleet/common');

const Driver = () => createModel('drivers');
const STATUSES = ['REQUESTED', 'PROCESSING', 'PAID', 'FAILED', 'CANCELLED'];
const fullName = (d) => [d.firstName, d.lastName].filter(Boolean).join(' ').trim() || d.phone || d.driverId;

async function audit(req, action, id, meta) {
  try {
    await AdminAudit.create({ tenantId: req.business.tenantId, actorId: req.admin.adminId, actorEmail: req.admin.email, action, targetType: 'payout', targetId: id, meta: meta || null, ip: req.ip || null });
  } catch (e) { console.warn('[payouts] audit write failed:', e.message); }
}

const currencyOf = (req) => (req.business.market && req.business.market.currency) || 'INR';

function item(p, driver, digits) {
  return {
    id: p.payoutId, driverId: p.driverId, driverName: driver ? fullName(driver) : p.driverId, driverPhone: driver ? driver.phone : '',
    amount: p.amountMinor / 10 ** digits, amountMinor: p.amountMinor, currency: p.currency, status: p.status,
    bank: [p.bankLabel, p.accountLast4 ? `••••${p.accountLast4}` : ''].filter(Boolean).join(' '), reference: p.reference || '', failureReason: p.failureReason || '',
    requestedAt: p.requestedAt, processingAt: p.processingAt || null, paidAt: p.paidAt || null, failedAt: p.failedAt || null, cancelledAt: p.cancelledAt || null
  };
}

exports.list = c.handle(async (req, res) => {
  const { page, pageSize, skip } = c.pageParams(req.query);
  const digits = digitsOf(currencyOf(req));
  const base = { tenantId: req.business.tenantId };
  const filter = { ...base };
  const status = String(req.query.status || '').toUpperCase();
  if (status) { if (!STATUSES.includes(status)) return c.invalid(res, { status: 'Unknown status' }); filter.status = status; }
  const q = String(req.query.q || '').trim().slice(0, 60);
  if (q) {
    const drivers = await req.legacyData.find(Driver(), { $or: [{ firstName: { $regex: c.escapeRegex(q), $options: 'i' } }, { lastName: { $regex: c.escapeRegex(q), $options: 'i' } }, { phone: { $regex: c.escapeRegex(q), $options: 'i' } }, { driverId: q }] }).select('driverId').limit(200).lean();
    filter.$or = [{ driverId: { $in: drivers.map((d) => d.driverId) } }, { payoutId: q }, { reference: { $regex: c.escapeRegex(q), $options: 'i' } }];
  }
  const [rows, total, all] = await Promise.all([
    DriverPayout.find(filter).sort({ requestedAt: -1 }).skip(skip).limit(pageSize).lean(),
    DriverPayout.countDocuments(filter),
    DriverPayout.find(base).lean()
  ]);
  const people = rows.length ? await req.legacyData.find(Driver(), { driverId: { $in: [...new Set(rows.map((r) => r.driverId))] } }).select('driverId firstName lastName phone').lean() : [];
  const by = new Map(people.map((d) => [d.driverId, d]));
  const totals = {};
  for (const s of STATUSES) { const list = all.filter((p) => p.status === s); totals[s] = { count: list.length, amount: list.reduce((a, p) => a + p.amountMinor, 0) / 10 ** digits }; }
  return c.ok(res, { items: rows.map((r) => item(r, by.get(r.driverId), digits)), total, page, pageSize, totals, currency: currencyOf(req) });
});

async function load(req) {
  const p = await DriverPayout.findOne({ tenantId: req.business.tenantId, payoutId: String(req.params.id) }).lean();
  if (!p) return null;
  const driver = await req.legacyData.findOne(Driver(), { driverId: p.driverId }).lean();
  return { p, driver };
}

exports.get = c.handle(async (req, res) => {
  const found = await load(req);
  if (!found) return c.fail(res, 404, 'Payout not found');
  const digits = digitsOf(currencyOf(req));
  const bank = (found.driver && found.driver.bankAccount) || {};
  await audit(req, 'payout.viewed', found.p.payoutId, { driverId: found.p.driverId });
  return c.ok(res, {
    ...item(found.p, found.driver, digits),
    // the account to pay: as the driver has it now (it cannot change while a request is open)
    account: { holder: bank.accountHolderName || '', bankName: bank.bankName || '', accountNumber: bank.accountNumber || '', ifsc: bank.ifscCode || '' },
    note: found.p.note || ''
  });
});

async function move(req, res, { from, set, action, meta }) {
  const now = new Date();
  const moved = await DriverPayout.findOneAndUpdate(
    { tenantId: req.business.tenantId, payoutId: String(req.params.id), status: { $in: from } },
    { $set: { ...set, updatedAt: now, handledBy: req.admin.adminId } }, { new: true }
  );
  if (!moved) {
    const now1 = await DriverPayout.findOne({ tenantId: req.business.tenantId, payoutId: String(req.params.id) }).lean();
    return now1 ? c.fail(res, 409, `This payout is already ${now1.status.toLowerCase()}.`) : c.fail(res, 404, 'Payout not found');
  }
  await audit(req, action, moved.payoutId, { driverId: moved.driverId, amountMinor: moved.amountMinor, ...meta });
  if (moved.status === 'PAID' || moved.status === 'FAILED') {
    try {
      const dg = digitsOf(currencyOf(req));
      const shown = (moved.amountMinor / 10 ** dg).toFixed(dg);
      const sym = moved.currency === 'INR' ? '₹' : moved.currency + ' ';
      const where = [moved.bankLabel, moved.accountLast4 ? '••••' + moved.accountLast4 : ''].filter(Boolean).join(' ') || 'your bank account';
      await sendPushToDriver(moved.driverId, moved.status === 'PAID'
        ? { title: 'Payout sent', body: sym + shown + ' was sent to ' + where + '. Ref ' + moved.reference, channelId: 'driver_notifications', data: { type: 'PAYOUT', payout_id: moved.payoutId } }
        : { title: 'Payout could not be sent', body: sym + shown + ' is back in your balance. ' + moved.failureReason, channelId: 'driver_notifications', data: { type: 'PAYOUT', payout_id: moved.payoutId } });
    } catch (_) { /* the driver sees the result in the app either way */ }
  }
  const driver = await req.legacyData.findOne(Driver(), { driverId: moved.driverId }).lean();
  return c.ok(res, item(moved.toObject ? moved.toObject() : moved, driver, digitsOf(currencyOf(req))));
}

exports.start = c.handle((req, res) => move(req, res, { from: ['REQUESTED'], set: { status: 'PROCESSING', processingAt: new Date() }, action: 'payout.processing' }));

exports.pay = c.handle(async (req, res) => {
  const reference = String((req.body && req.body.reference) || '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._\-/]{3,39}$/.test(reference)) return c.invalid(res, { reference: 'Enter the bank reference (UTR), 4 to 40 letters or digits' });
  // the same bank reference can never settle two payouts
  const used = await DriverPayout.findOne({ tenantId: req.business.tenantId, reference, payoutId: { $ne: String(req.params.id) } }).lean();
  if (used) return c.fail(res, 409, 'That bank reference is already recorded on another payout.', { reference: 'Already used' });
  return move(req, res, { from: ['REQUESTED', 'PROCESSING'], set: { status: 'PAID', open: false, paidAt: new Date(), reference }, action: 'payout.paid', meta: { reference } });
});

exports.fail = c.handle(async (req, res) => {
  const reason = String((req.body && req.body.reason) || '').trim().slice(0, 140);
  if (reason.length < 3) return c.invalid(res, { reason: 'Tell the driver why it could not be paid' });
  return move(req, res, { from: ['REQUESTED', 'PROCESSING'], set: { status: 'FAILED', open: false, failedAt: new Date(), failureReason: reason }, action: 'payout.failed', meta: { reason } });
});

exports.getSettings = c.handle(async (req, res) => {
  const s = money.settingsOf(req.business);
  const digits = digitsOf(currencyOf(req));
  return c.ok(res, { commissionPercent: s.commissionPercent, minWithdrawal: s.minWithdrawalMinor / 10 ** digits, cashWithdrawable: s.cashWithdrawable, processingNote: s.processingNote, currency: currencyOf(req) });
});

exports.updateSettings = c.handle(async (req, res) => {
  const b = req.body || {};
  const digits = digitsOf(currencyOf(req));
  const errors = {};
  const pct = Number(b.commissionPercent);
  if (!Number.isFinite(pct) || pct < 0 || pct > 100) errors.commissionPercent = 'Enter 0 to 100';
  const min = b.minWithdrawal === '' || b.minWithdrawal == null ? 0 : Number(b.minWithdrawal);
  if (!Number.isFinite(min) || min < 0 || min > 1000000) errors.minWithdrawal = 'Enter 0 or more';
  if (Object.keys(errors).length) return c.invalid(res, errors);
  const note = String(b.processingNote || '').trim();
  if (note.length > 140) return c.invalid(res, { processingNote: 'At most 140 characters' });
  const value = { commissionPercent: Math.round(pct * 100) / 100, minWithdrawalMinor: toMinor(min, digits), cashWithdrawable: !!b.cashWithdrawable, processingNote: note };
  await req.data.update(Tenant, {}, { payoutSettings: value });
  await audit(req, 'payout.settings_updated', req.business.tenantId, value);
  await require('./configHistoryController').track(req, 'payout.settings_updated', { payoutSettings: value });
  return c.ok(res, { commissionPercent: value.commissionPercent, minWithdrawal: min, cashWithdrawable: value.cashWithdrawable, processingNote: note, currency: currencyOf(req) });
});
