/**
 * Coupon rules, and the atomic reservation that keeps their limits honest.
 *
 *  evaluate()   pure: is this coupon usable for this ride, and what discount does it give. The discount is worked out here, on the
 *               server, from the ride's own total; a client never supplies an amount.
 *  reserve()    takes one use of the coupon for a booking. The total limit and the per-rider limit are conditional counter updates,
 *               so the last use can be taken by only one booking.
 *  reconcile()  gives uses back for bookings that were cancelled, rejected or never answered, and marks completed ones REDEEMED.
 *               It runs before any limit is checked, so every cancellation path (there are several) frees the use without each
 *               one having to remember to.
 *
 * The discount applies to the ride's total before the discount (fare + fees + taxes), as lib/fareRules.js does, and can never
 * take the total below zero.
 */
const crypto = require('crypto');
const { Coupon, CouponUse, CouponRedemption } = require('../models/couponModel');
const { TripDetails } = require('../models/tripDetailsModel');

const DEAD = ['REJECTED', 'NO_RESPONSE', 'CANCELLED_BY_USER', 'CANCELLED_BY_USER_AFTER_ACCEPTANCE', 'CANCELLED_BY_DRIVER'];

const REASONS = {
  NOT_FOUND: 'That coupon code is not valid.',
  INACTIVE: 'That coupon is not active.',
  NOT_STARTED: 'That coupon is not valid yet.',
  EXPIRED: 'That coupon has expired.',
  CATEGORY: 'That coupon does not apply to this ride type.',
  REGION: 'That coupon does not apply in this area.',
  MIN_FARE: 'This ride is below the minimum fare for that coupon.',
  NEW_USERS: 'That coupon is only for riders on their first ride.',
  TOTAL_LIMIT: 'That coupon has been fully redeemed.',
  USER_LIMIT: 'You have already used that coupon.',
  NO_DISCOUNT: 'That coupon gives no discount on this ride.'
};

const normalizeCode = (code) => String(code || '').trim().toUpperCase().replace(/\s+/g, '');

const fail = (code) => ({ ok: false, code, message: REASONS[code] });

/**
 * @param {object} coupon
 * @param {{ now?: Date, grossMinor: number, categoryId?: string|null, regionId?: string|null, completedRides?: number }} ctx
 * @returns {{ ok: true, discountMinor: number } | { ok: false, code: string, message: string }}
 */
function evaluate(coupon, ctx) {
  const now = ctx.now || new Date();
  if (!coupon) return fail('NOT_FOUND');
  if (!coupon.active) return fail('INACTIVE');
  if (new Date(coupon.startsAt) > now) return fail('NOT_STARTED');
  if (new Date(coupon.endsAt) < now) return fail('EXPIRED');
  if ((coupon.categoryIds || []).length && !(coupon.categoryIds || []).includes(ctx.categoryId)) return fail('CATEGORY');
  if ((coupon.regionIds || []).length && !(coupon.regionIds || []).includes(ctx.regionId)) return fail('REGION');
  if (coupon.minFareMinor > 0 && ctx.grossMinor < coupon.minFareMinor) return fail('MIN_FARE');
  if (coupon.newUsersOnly && (ctx.completedRides || 0) > 0) return fail('NEW_USERS');
  if (coupon.totalLimit > 0 && coupon.redeemed >= coupon.totalLimit) return fail('TOTAL_LIMIT');
  let discount = coupon.type === 'PERCENT' ? Math.round((ctx.grossMinor * Number(coupon.value)) / 100) : Math.round(Number(coupon.value));
  if (coupon.type === 'PERCENT' && coupon.maxDiscountMinor > 0) discount = Math.min(discount, coupon.maxDiscountMinor);
  discount = Math.min(discount, ctx.grossMinor); // never below a zero total
  if (!(discount > 0)) return fail('NO_DISCOUNT');
  return { ok: true, discountMinor: discount };
}

async function findByCode(tenantId, code) {
  const normalized = normalizeCode(code);
  if (!normalized) return null;
  return Coupon.findOne({ tenantId, code: normalized }).lean();
}

/**
 * Gives back the uses of this rider's (or this coupon's) bookings that did not happen, and marks the completed ones REDEEMED.
 */
async function reconcile(tenantId, { userId = null, couponId = null } = {}) {
  const filter = { tenantId, state: 'RESERVED' };
  if (userId) filter.userId = userId;
  if (couponId) filter.couponId = couponId;
  const open = await CouponRedemption.find(filter).lean();
  if (!open.length) return 0;
  const trips = await TripDetails.find({ trip_id: { $in: open.map((r) => r.tripId) } }).select('trip_id status').lean();
  const status = new Map(trips.map((t) => [t.trip_id, t.status]));
  let released = 0;
  for (const r of open) {
    const s = status.get(r.tripId);
    if (s === 'COMPLETED') {
      await CouponRedemption.findOneAndUpdate({ tenantId, redemptionId: r.redemptionId, state: 'RESERVED' }, { $set: { state: 'REDEEMED', updatedAt: new Date() } });
    } else if (s === undefined || DEAD.includes(s)) {
      const moved = await CouponRedemption.findOneAndUpdate({ tenantId, redemptionId: r.redemptionId, state: 'RESERVED' }, { $set: { state: 'RELEASED', updatedAt: new Date() } }, { new: true });
      if (moved) { // only the request that moved it gives the use back
        await Coupon.findOneAndUpdate({ tenantId, couponId: r.couponId, redeemed: { $gt: 0 } }, { $inc: { redeemed: -1 } });
        await CouponUse.findOneAndUpdate({ tenantId, couponId: r.couponId, userId: r.userId, count: { $gt: 0 } }, { $inc: { count: -1 } });
        released += 1;
      }
    }
  }
  return released;
}

/**
 * Takes one use for a booking. Returns { ok: true, redemption } or { ok: false, code, message }.
 * A booking that cannot be created afterwards must call release() so the use is not lost.
 */
async function reserve({ tenantId, coupon, userId, tripId, discountMinor, currency }) {
  const taken = await Coupon.findOneAndUpdate(
    coupon.totalLimit > 0 ? { tenantId, couponId: coupon.couponId, redeemed: { $lt: coupon.totalLimit } } : { tenantId, couponId: coupon.couponId },
    { $inc: { redeemed: 1 } }, { new: true }
  );
  if (!taken) return fail('TOTAL_LIMIT');
  if (coupon.perUserLimit > 0) {
    try {
      const use = await CouponUse.findOneAndUpdate({ tenantId, couponId: coupon.couponId, userId, count: { $lt: coupon.perUserLimit } }, { $inc: { count: 1 } }, { upsert: true, new: true });
      if (!use) throw Object.assign(new Error('limit'), { code: 11000 });
    } catch (e) {
      await Coupon.findOneAndUpdate({ tenantId, couponId: coupon.couponId, redeemed: { $gt: 0 } }, { $inc: { redeemed: -1 } });
      if (e && e.code === 11000) return fail('USER_LIMIT');
      throw e;
    }
  } else {
    await CouponUse.findOneAndUpdate({ tenantId, couponId: coupon.couponId, userId }, { $inc: { count: 1 } }, { upsert: true }).catch(() => {});
  }
  try {
    const now = new Date();
    const redemption = await CouponRedemption.create({
      tenantId, redemptionId: `cr_${crypto.randomBytes(8).toString('hex')}`, couponId: coupon.couponId, code: coupon.code, userId, tripId,
      discountMinor, currency: currency || coupon.currency, fundedBy: coupon.fundedBy || 'BUSINESS', state: 'RESERVED', createdAt: now, updatedAt: now
    });
    return { ok: true, redemption: redemption.toObject ? redemption.toObject() : redemption };
  } catch (e) {
    await giveBack(tenantId, coupon.couponId, userId);
    throw e;
  }
}

async function giveBack(tenantId, couponId, userId) {
  await Coupon.findOneAndUpdate({ tenantId, couponId, redeemed: { $gt: 0 } }, { $inc: { redeemed: -1 } });
  await CouponUse.findOneAndUpdate({ tenantId, couponId, userId, count: { $gt: 0 } }, { $inc: { count: -1 } });
}

/** Gives the use back when the booking could not be created after the use was taken. */
async function release({ tenantId, couponId, userId, tripId }) {
  const moved = await CouponRedemption.findOneAndUpdate({ tenantId, tripId, state: 'RESERVED' }, { $set: { state: 'RELEASED', updatedAt: new Date() } }, { new: true });
  if (moved) await giveBack(tenantId, couponId, userId);
}

/**
 * Works out the coupon for a ride being priced: the rider's completed rides (for new-user coupons) are read from the trips, and
 * uses held by dead bookings are given back first. Returns the evaluation plus the coupon.
 */
async function check({ tenantId, code, userId, grossMinor, categoryId, regionId, now = new Date() }) {
  const coupon = await findByCode(tenantId, code);
  if (!coupon) return { ...fail('NOT_FOUND'), coupon: null };
  await reconcile(tenantId, { couponId: coupon.couponId });
  const fresh = await Coupon.findOne({ tenantId, couponId: coupon.couponId }).lean();
  let completedRides = 0;
  if (fresh.newUsersOnly && userId) completedRides = (await TripDetails.find({ user_id: userId, status: 'COMPLETED' }).select('trip_id').limit(1).lean()).length;
  let usedByUser = 0;
  if (fresh.perUserLimit > 0 && userId) {
    const use = await CouponUse.findOne({ tenantId, couponId: fresh.couponId, userId }).lean();
    usedByUser = use ? use.count : 0;
  }
  if (fresh.perUserLimit > 0 && usedByUser >= fresh.perUserLimit && fresh.active) return { ...fail('USER_LIMIT'), coupon: fresh };
  return { ...evaluate(fresh, { now, grossMinor, categoryId, regionId, completedRides }), coupon: fresh };
}

module.exports = { evaluate, check, reserve, release, reconcile, findByCode, normalizeCode, REASONS, DEAD };
