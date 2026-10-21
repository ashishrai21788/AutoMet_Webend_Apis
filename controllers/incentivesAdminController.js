/**
 * The business's side of incentives, goals and manual adjustments (admin dashboard).
 *
 *   GET  /api/admin/business/incentives                  every incentive with how many drivers reached it and what was paid
 *   POST /api/admin/business/incentives                  create one
 *   PUT  /api/admin/business/incentives/:id              change one (once it has started only the name, text, end date and active flag)
 *   GET  /api/admin/business/adjustments?driverId        recent adjustments (and incentive credits), newest first
 *   POST /api/admin/business/adjustments                 add or take away money for a driver, with a reason
 *
 * Money is whole minor units on the server; the dashboard sends and shows the currency's major unit.
 */
const { Incentive, DriverAdjustment } = require('../models/driverLedgerModel');
const { AdminAudit } = require('../models/adminModels');
const { createModel } = require('../models/dynamicModel');
const { digitsOf, toMinor } = require('../lib/riderInvoice');
const c = require('./fleet/common');

const Driver = () => createModel('drivers');
const currencyOf = (req) => (req.business.market && req.business.market.currency) || 'INR';
const fullName = (d) => [d.firstName, d.lastName].filter(Boolean).join(' ').trim() || d.phone || d.driverId;

async function audit(req, action, id, meta) {
  try { await AdminAudit.create({ tenantId: req.business.tenantId, actorId: req.admin.adminId, actorEmail: req.admin.email, action, targetType: 'incentive', targetId: id, meta: meta || null, ip: req.ip || null }); } catch (e) { console.warn('[incentives] audit write failed:', e.message); }
}

function validate(body, digits, { partial = false } = {}) {
  const errors = {}; const out = {};
  const b = body || {};
  if (!partial || b.name !== undefined) { const n = String(b.name || '').trim(); if (n.length < 3 || n.length > 60) errors.name = 'Give it a name of 3 to 60 characters'; else out.name = n; }
  if (b.description !== undefined) { const d = String(b.description || '').trim(); if (d.length > 200) errors.description = 'At most 200 characters'; else out.description = d; }
  if (!partial || b.targetTrips !== undefined) { const t = Number(b.targetTrips); if (!Number.isInteger(t) || t < 1 || t > 1000) errors.targetTrips = 'Enter a whole number of trips, 1 to 1000'; else out.targetTrips = t; }
  if (!partial || b.bonus !== undefined) { const v = b.bonus === '' || b.bonus == null ? 0 : Number(b.bonus); if (!Number.isFinite(v) || v < 0 || v > 100000) errors.bonus = 'Enter 0 (a goal with no bonus) up to 100000'; else out.bonusMinor = toMinor(v, digits); }
  for (const k of ['startsAt', 'endsAt']) {
    if (!partial || b[k] !== undefined) { const d = new Date(b[k]); if (Number.isNaN(d.getTime())) errors[k] = 'Choose a date'; else out[k] = d; }
  }
  if (b.categoryId !== undefined) out.categoryId = b.categoryId ? String(b.categoryId) : null;
  if (b.active !== undefined) out.active = !!b.active;
  return { out, errors };
}

const view = (i, digits, stats = {}) => ({
  id: i.incentiveId, name: i.name, description: i.description || '', targetTrips: i.targetTrips, bonus: i.bonusMinor / 10 ** digits, bonusMinor: i.bonusMinor,
  startsAt: i.startsAt, endsAt: i.endsAt, categoryId: i.categoryId || null, active: !!i.active, goalOnly: !(i.bonusMinor > 0),
  started: new Date(i.startsAt) <= new Date(), ended: new Date(i.endsAt) < new Date(), reached: stats.count || 0, paid: (stats.minor || 0) / 10 ** digits
});

exports.list = c.handle(async (req, res) => {
  const digits = digitsOf(currencyOf(req));
  const [rows, credits] = await Promise.all([Incentive.find({ tenantId: req.business.tenantId }).sort({ endsAt: -1 }).lean(), DriverAdjustment.find({ tenantId: req.business.tenantId, kind: 'INCENTIVE' }).lean()]);
  const stats = new Map();
  for (const a of credits) { const s = stats.get(a.refId) || { count: 0, minor: 0 }; s.count += 1; s.minor += a.amountMinor; stats.set(a.refId, s); }
  return c.ok(res, { items: rows.map((i) => view(i, digits, stats.get(i.incentiveId))), currency: currencyOf(req) });
});

exports.create = c.handle(async (req, res) => {
  const digits = digitsOf(currencyOf(req));
  const { out, errors } = validate(req.body, digits);
  if (!errors.startsAt && !errors.endsAt && out.endsAt <= out.startsAt) errors.endsAt = 'The end must be after the start';
  if (Object.keys(errors).length) return c.invalid(res, errors);
  const now = new Date();
  const doc = await Incentive.create({ tenantId: req.business.tenantId, incentiveId: c.newId('inc'), description: '', categoryId: null, active: true, ...out, currency: currencyOf(req), createdBy: req.admin.adminId, createdAt: now, updatedAt: now });
  await audit(req, 'incentive.created', doc.incentiveId, { name: out.name, targetTrips: out.targetTrips, bonusMinor: out.bonusMinor });
  return c.ok(res, view(doc.toObject ? doc.toObject() : doc, digits));
});

exports.update = c.handle(async (req, res) => {
  const digits = digitsOf(currencyOf(req));
  const found = await Incentive.findOne({ tenantId: req.business.tenantId, incentiveId: String(req.params.id) }).lean();
  if (!found) return c.fail(res, 404, 'Incentive not found');
  const { out, errors } = validate(req.body, digits, { partial: true });
  const started = new Date(found.startsAt) <= new Date();
  if (started) for (const k of ['targetTrips', 'bonusMinor', 'startsAt', 'categoryId']) if (k in out && String(out[k]) !== String(found[k])) errors[k === 'bonusMinor' ? 'bonus' : k] = 'Cannot be changed once the incentive has started';
  const endsAt = out.endsAt || found.endsAt; const startsAt = out.startsAt || found.startsAt;
  if (new Date(endsAt) <= new Date(startsAt)) errors.endsAt = 'The end must be after the start';
  if (Object.keys(errors).length) return c.invalid(res, errors);
  const updated = await Incentive.findOneAndUpdate({ tenantId: req.business.tenantId, incentiveId: found.incentiveId }, { $set: { ...out, updatedAt: new Date() } }, { new: true });
  await audit(req, 'incentive.updated', found.incentiveId, { fields: Object.keys(out) });
  return c.ok(res, view(updated.toObject ? updated.toObject() : updated, digits));
});

exports.adjustments = c.handle(async (req, res) => {
  const digits = digitsOf(currencyOf(req));
  const filter = { tenantId: req.business.tenantId };
  if (req.query.driverId) filter.driverId = String(req.query.driverId);
  const rows = await DriverAdjustment.find(filter).sort({ at: -1 }).limit(100).lean();
  const people = rows.length ? await req.legacyData.find(Driver(), { driverId: { $in: [...new Set(rows.map((r) => r.driverId))] } }).select('driverId firstName lastName phone').lean() : [];
  const by = new Map(people.map((d) => [d.driverId, d]));
  return c.ok(res, { items: rows.map((r) => ({ id: r.adjustmentId, driverId: r.driverId, driverName: by.get(r.driverId) ? fullName(by.get(r.driverId)) : r.driverId, kind: r.kind, amount: r.amountMinor / 10 ** digits, title: r.title || '', reason: r.reason || '', at: r.at, by: r.createdBy })), currency: currencyOf(req) });
});

exports.addAdjustment = c.handle(async (req, res) => {
  const digits = digitsOf(currencyOf(req));
  const b = req.body || {};
  const errors = {};
  const amount = Number(b.amount);
  if (!Number.isFinite(amount) || amount === 0 || Math.abs(amount) > 100000) errors.amount = 'Enter an amount (negative to take away), up to 100000';
  const reason = String(b.reason || '').trim();
  if (reason.length < 5 || reason.length > 140) errors.reason = 'Give a reason of 5 to 140 characters. The driver sees it.';
  const driver = await req.legacyData.findOne(Driver(), { driverId: String(b.driverId || '') }).lean();
  if (!driver) errors.driverId = 'Choose one of your drivers';
  if (Object.keys(errors).length) return c.invalid(res, errors);
  const now = new Date();
  const doc = await DriverAdjustment.create({ tenantId: req.business.tenantId, adjustmentId: c.newId('adj'), driverId: driver.driverId, kind: 'ADJUSTMENT', amountMinor: toMinor(amount, digits), currency: currencyOf(req), title: '', reason, createdBy: req.admin.adminId, at: now, createdAt: now });
  await audit(req, 'adjustment.added', doc.adjustmentId, { driverId: driver.driverId, amountMinor: doc.amountMinor, reason });
  return c.ok(res, { id: doc.adjustmentId, driverId: driver.driverId, amount });
});
