const mongoose = require('../lib/db/mongoose');

/**
 * Coupons a business offers its riders. Money is whole minor units (paise, cents).
 *
 *  Coupon            the offer and its rules; \`redeemed\` counts the live (reserved or used) redemptions
 *  CouponUse         one counter per (coupon, rider) for the per-rider limit
 *  CouponRedemption  one row per booking that used a coupon, with the discount that booking got
 *
 * The limits are enforced with conditional counter updates ($inc only while below the limit), never by reading a count and
 * then writing, so two riders (or two taps) cannot both take the last redemption.
 */
const couponSchema = new mongoose.Schema({
  tenantId: { type: String, required: true, index: true },
  couponId: { type: String, required: true, unique: true },
  code: { type: String, required: true, trim: true, uppercase: true }, // unique inside one business
  title: { type: String, default: '', trim: true },
  description: { type: String, default: '', trim: true },
  type: { type: String, enum: ['PERCENT', 'FIXED'], required: true },
  value: { type: Number, required: true, min: 0 }, // PERCENT: 0-100 (two decimals); FIXED: minor units
  maxDiscountMinor: { type: Number, default: 0, min: 0 }, // 0: no cap (PERCENT)
  minFareMinor: { type: Number, default: 0, min: 0 },
  currency: { type: String, default: 'INR' },
  startsAt: { type: Date, required: true },
  endsAt: { type: Date, required: true },
  totalLimit: { type: Number, default: 0, min: 0 }, // 0: unlimited
  perUserLimit: { type: Number, default: 1, min: 0 }, // 0: unlimited
  categoryIds: { type: [String], default: [] }, // empty: every vehicle category
  regionIds: { type: [String], default: [] }, // empty: every service area
  newUsersOnly: { type: Boolean, default: false }, // only riders with no completed ride yet
  /** who pays for the discount: BUSINESS (the driver is still paid the full fare) or DRIVER (the driver earns on what the rider paid) */
  fundedBy: { type: String, enum: ['BUSINESS', 'DRIVER'], default: 'BUSINESS' },
  active: { type: Boolean, default: true },
  redeemed: { type: Number, default: 0, min: 0 },
  createdBy: { type: String, default: null },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
}, { collection: 'coupons' });
couponSchema.index({ tenantId: 1, code: 1 }, { unique: true });

const couponUseSchema = new mongoose.Schema({
  tenantId: { type: String, required: true },
  couponId: { type: String, required: true },
  userId: { type: String, required: true },
  count: { type: Number, default: 0, min: 0 }
}, { collection: 'coupon_uses' });
couponUseSchema.index({ tenantId: 1, couponId: 1, userId: 1 }, { unique: true });

const couponRedemptionSchema = new mongoose.Schema({
  tenantId: { type: String, required: true, index: true },
  redemptionId: { type: String, required: true, unique: true },
  couponId: { type: String, required: true, index: true },
  code: { type: String, required: true },
  userId: { type: String, required: true, index: true },
  tripId: { type: String, required: true },
  discountMinor: { type: Number, required: true, min: 0 },
  currency: { type: String, default: 'INR' },
  fundedBy: { type: String, default: 'BUSINESS' },
  /** RESERVED while the booking is open, REDEEMED once its ride was completed, RELEASED when the booking was cancelled or never happened (the use goes back) */
  state: { type: String, enum: ['RESERVED', 'REDEEMED', 'RELEASED'], default: 'RESERVED', index: true },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
}, { collection: 'coupon_redemptions' });
couponRedemptionSchema.index({ tenantId: 1, tripId: 1 }, { unique: true });

const Coupon = mongoose.models.Coupon || mongoose.model('Coupon', couponSchema);
const CouponUse = mongoose.models.CouponUse || mongoose.model('CouponUse', couponUseSchema);
const CouponRedemption = mongoose.models.CouponRedemption || mongoose.model('CouponRedemption', couponRedemptionSchema);

module.exports = { Coupon, CouponUse, CouponRedemption };
