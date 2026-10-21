/**
 * The business's coupons (admin dashboard, Pricing). The dashboard sends and shows the currency's major unit; the server stores
 * whole minor units.
 *
 *   GET  /api/admin/business/coupons                      list with usage, paged (status, q)
 *   POST /api/admin/business/coupons                      create
 *   PUT  /api/admin/business/coupons/:id                  change (once redeemed, the discount rules are locked; it can still be switched off or extended)
 *   GET  /api/admin/business/coupons/:id/redemptions      who used it, on which ride, and the discount, paged
 */
const { Coupon, CouponRedemption } = require('../models/couponModel');
const { ServiceRegion, VehicleCategory } = require('../models/businessModels');
const { AdminAudit } = require('../models/adminModels');
const { digitsOf, toMinor } = require('../lib/riderInvoice');
const coupons = require('../lib/coupons');
const c = require('./fleet/common');

const currencyOf = (req) => (req.business.market && req.business.market.currency) || 'INR';

async function audit(req, action, id, meta) {
  try { await AdminAudit.create({ tenantId: req.business.tenantId, actorId: req.admin.adminId, actorEmail: req.admin.email, action, targetType: 'coupon', targetId: id, meta: meta || null, ip: req.ip || null }); } catch (e) { console.warn('[coupons] audit write failed:', e.message); }
}

const view = (x, digits) => ({
  id: x.couponId, code: x.code, title: x.title || '', description: x.description || '', type: x.type,
  value: x.type === 'FIXED' ? x.value / 10 ** digits : x.value, maxDiscount: x.maxDiscountMinor / 10 ** digits, minFare: x.minFareMinor / 10 ** digits,
  startsAt: x.startsAt, endsAt: x.endsAt, totalLimit: x.totalLimit, perUserLimit: x.perUserLimit, categoryIds: x.categoryIds || [], regionIds: x.regionIds || [],
  newUsersOnly: !!x.newUsersOnly, fundedBy: x.fundedBy || 'BUSINESS', active: !!x.active, redeemed: x.redeemed || 0,
  state: !x.active ? 'OFF' : new Date(x.endsAt) < new Date() ? 'EXPIRED' : new Date(x.startsAt) > new Date() ? 'SCHEDULED' : (x.totalLimit > 0 && x.redeemed >= x.totalLimit) ? 'USED_UP' : 'LIVE'
});

async function validate(req, body, digits, { partial = false, existing = null } = {}) {
  const errors = {}; const out = {};
  const b = body || {};
  if (!partial || b.code !== undefined) {
    const code = coupons.normalizeCode(b.code);
    if (!/^[A-Z0-9_-]{3,20}$/.test(code)) errors.code = 'Use 3 to 20 letters, digits, - or _';
    else out.code = code;
  }
  if (b.title !== undefined) out.title = String(b.title || '').trim().slice(0, 60);
  if (b.description !== undefined) out.description = String(b.description || '').trim().slice(0, 200);
  const type = b.type !== undefined ? String(b.type).toUpperCase() : existing && existing.type;
  if (!partial || b.type !== undefined) { if (!['PERCENT', 'FIXED'].includes(type)) errors.type = 'Choose percent or fixed amount'; else out.type = type; }
  if (!partial || b.value !== undefined) {
    const v = Number(b.value);
    if (type === 'PERCENT') { if (!Number.isFinite(v) || v <= 0 || v > 100) errors.value = 'Enter a percentage above 0 and up to 100'; else out.value = Math.round(v * 100) / 100; }
    else if (type === 'FIXED') { if (!Number.isFinite(v) || v <= 0 || v > 100000) errors.value = 'Enter an amount above 0'; else out.value = toMinor(v, digits); }
  }
  const money = (key, name) => { if (b[key] !== undefined) { const v = b[key] === '' || b[key] == null ? 0 : Number(b[key]); if (!Number.isFinite(v) || v < 0 || v > 1000000) errors[key] = 'Enter 0 or more'; else out[name] = toMinor(v, digits); } };
  money('maxDiscount', 'maxDiscountMinor'); money('minFare', 'minFareMinor');
  const whole = (key, max) => { if (b[key] !== undefined) { const v = b[key] === '' || b[key] == null ? 0 : Number(b[key]); if (!Number.isInteger(v) || v < 0 || v > max) errors[key] = `Enter a whole number, 0 to ${max} (0 means no limit)`; else out[key] = v; } };
  whole('totalLimit', 10000000); whole('perUserLimit', 1000);
  for (const k of ['startsAt', 'endsAt']) if (!partial || b[k] !== undefined) { const d = new Date(b[k]); if (Number.isNaN(d.getTime())) errors[k] = 'Choose a date'; else out[k] = d; }
  if (b.newUsersOnly !== undefined) out.newUsersOnly = !!b.newUsersOnly;
  if (b.active !== undefined) out.active = !!b.active;
  if (b.fundedBy !== undefined) { const f = String(b.fundedBy).toUpperCase(); if (!['BUSINESS', 'DRIVER'].includes(f)) errors.fundedBy = 'Choose who pays for it'; else out.fundedBy = f; }
  // restrictions must name this business's own categories and regions
  if (b.categoryIds !== undefined) {
    const ids = [...new Set((Array.isArray(b.categoryIds) ? b.categoryIds : []).map(String))];
    const own = new Set((await req.data.find(VehicleCategory, {})).map((x) => x.categoryId));
    if (ids.some((i) => !own.has(i))) errors.categoryIds = 'Choose your own vehicle categories'; else out.categoryIds = ids;
  }
  if (b.regionIds !== undefined) {
    const ids = [...new Set((Array.isArray(b.regionIds) ? b.regionIds : []).map(String))];
    const own = new Set((await req.data.find(ServiceRegion, {})).map((x) => x.regionId));
    if (ids.some((i) => !own.has(i))) errors.regionIds = 'Choose your own service areas'; else out.regionIds = ids;
  }
  const startsAt = out.startsAt || (existing && existing.startsAt); const endsAt = out.endsAt || (existing && existing.endsAt);
  if (startsAt && endsAt && new Date(endsAt) <= new Date(startsAt)) errors.endsAt = 'The end must be after the start';
  return { out, errors };
}

exports.list = c.handle(async (req, res) => {
  const { page, pageSize, skip } = c.pageParams(req.query);
  const digits = digitsOf(currencyOf(req));
  const filter = { tenantId: req.business.tenantId };
  const q = String(req.query.q || '').trim().toUpperCase().slice(0, 30);
  if (q) filter.code = { $regex: c.escapeRegex(q) };
  const [rows, total] = await Promise.all([
    Coupon.find(filter).sort({ createdAt: -1 }).skip(skip).limit(pageSize).lean(),
    Coupon.countDocuments(filter)
  ]);
  const wanted = String(req.query.state || '').toUpperCase();
  const items = rows.map((x) => view(x, digits)).filter((x) => !wanted || x.state === wanted);
  return c.ok(res, { items, total, page, pageSize, currency: currencyOf(req) });
});

exports.create = c.handle(async (req, res) => {
  const digits = digitsOf(currencyOf(req));
  const { out, errors } = await validate(req, req.body, digits);
  if (Object.keys(errors).length) return c.invalid(res, errors);
  const now = new Date();
  try {
    const doc = await Coupon.create({ tenantId: req.business.tenantId, couponId: c.newId('cp'), currency: currencyOf(req), perUserLimit: 1, totalLimit: 0, ...out, redeemed: 0, createdBy: req.admin.adminId, createdAt: now, updatedAt: now });
    await audit(req, 'coupon.created', doc.couponId, { code: out.code, type: out.type });
    return c.ok(res, view(doc.toObject ? doc.toObject() : doc, digits));
  } catch (e) {
    if (c.DUP(e)) return c.fail(res, 409, 'That code is already used by another coupon', { code: 'Already used' });
    throw e;
  }
});

exports.update = c.handle(async (req, res) => {
  const digits = digitsOf(currencyOf(req));
  const found = await Coupon.findOne({ tenantId: req.business.tenantId, couponId: String(req.params.id) }).lean();
  if (!found) return c.fail(res, 404, 'Coupon not found');
  const { out, errors } = await validate(req, req.body, digits, { partial: true, existing: found });
  // once someone has used it, the discount a rider was promised cannot change under them
  if (found.redeemed > 0) for (const k of ['code', 'type', 'value', 'maxDiscountMinor', 'minFareMinor', 'fundedBy']) if (k in out && String(out[k]) !== String(found[k])) errors[k === 'maxDiscountMinor' ? 'maxDiscount' : k === 'minFareMinor' ? 'minFare' : k] = 'Cannot be changed after the coupon has been used';
  if ('totalLimit' in out && out.totalLimit > 0 && out.totalLimit < found.redeemed) errors.totalLimit = `Already redeemed ${found.redeemed} times`;
  if (Object.keys(errors).length) return c.invalid(res, errors);
  try {
    const updated = await Coupon.findOneAndUpdate({ tenantId: req.business.tenantId, couponId: found.couponId }, { $set: { ...out, updatedAt: new Date() } }, { new: true });
    await audit(req, 'coupon.updated', found.couponId, { fields: Object.keys(out) });
    return c.ok(res, view(updated.toObject ? updated.toObject() : updated, digits));
  } catch (e) {
    if (c.DUP(e)) return c.fail(res, 409, 'That code is already used by another coupon', { code: 'Already used' });
    throw e;
  }
});

exports.redemptions = c.handle(async (req, res) => {
  const { page, pageSize, skip } = c.pageParams(req.query);
  const digits = digitsOf(currencyOf(req));
  const found = await Coupon.findOne({ tenantId: req.business.tenantId, couponId: String(req.params.id) }).lean();
  if (!found) return c.fail(res, 404, 'Coupon not found');
  await coupons.reconcile(req.business.tenantId, { couponId: found.couponId });
  const filter = { tenantId: req.business.tenantId, couponId: found.couponId };
  const [rows, total] = await Promise.all([CouponRedemption.find(filter).sort({ createdAt: -1 }).skip(skip).limit(pageSize).lean(), CouponRedemption.countDocuments(filter)]);
  return c.ok(res, { items: rows.map((r) => ({ id: r.redemptionId, userId: r.userId, tripId: r.tripId, discount: r.discountMinor / 10 ** digits, state: r.state, at: r.createdAt })), total, page, pageSize, currency: currencyOf(req) });
});
