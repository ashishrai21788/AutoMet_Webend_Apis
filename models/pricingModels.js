const mongoose = require('../lib/db/mongoose');

/**
 * Pricing drafts and versions.
 *
 *  FareRuleDraft   a fare rule change waiting to be published (a new or changed rule, or the removal of one). Live pricing keeps
 *                  reading the fare_rules collection only; a draft changes nothing until it is published.
 *  PricingVersion  a numbered, never-edited copy of every live fare rule, written each time live pricing changes (a publish, a
 *                  rollback, or a direct save). The first one is the pricing as it was just before the first recorded change.
 */
const fareRuleDraftSchema = new mongoose.Schema({
  tenantId: { type: String, required: true, index: true },
  draftId: { type: String, required: true, unique: true },
  categoryId: { type: String, required: true },
  regionId: { type: String, default: null },
  regionKey: { type: String, required: true }, // regionId or 'default'
  /** SAVE: the rule below should exist; DELETE: the live rule should be removed */
  op: { type: String, enum: ['SAVE', 'DELETE'], default: 'SAVE' },
  /** the validated rule fields (see lib/fareRules.validateFareRuleInput); null for DELETE */
  fields: { type: mongoose.Schema.Types.Mixed, default: null },
  currency: { type: String, default: 'INR' },
  /** the live rule's updatedAt when this draft was made, to notice when live pricing moved underneath it */
  baseUpdatedAt: { type: Date, default: null },
  createdBy: { type: String, default: null },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
}, { collection: 'fare_rule_drafts' });
fareRuleDraftSchema.index({ tenantId: 1, categoryId: 1, regionKey: 1 }, { unique: true });

const pricingVersionSchema = new mongoose.Schema({
  tenantId: { type: String, required: true, index: true },
  version: { type: Number, required: true, min: 1 },
  rules: { type: mongoose.Schema.Types.Mixed, required: true }, // every live rule at that moment (see lib/pricingDrafts.snapshotRules)
  /** how many rules were added, changed or removed against the version before */
  summary: { type: mongoose.Schema.Types.Mixed, default: null },
  /** baseline | publish | direct | rollback */
  source: { type: String, default: '' },
  note: { type: String, default: '' },
  rollbackOf: { type: Number, default: null },
  actorId: { type: String, default: null },
  actorEmail: { type: String, default: null },
  createdAt: { type: Date, default: Date.now }
}, { collection: 'pricing_versions' });
pricingVersionSchema.index({ tenantId: 1, version: 1 }, { unique: true });

/**
 * A publish set for a future time. Scheduling freezes the drafts into `items` (the drafts are cleared, so further edits make new
 * drafts); at `effectiveAt` the server applies them together and records a pricing version. Cancelling puts the items back as
 * drafts. Status: SCHEDULED, APPLYING (claimed by one server), DONE, FAILED (checked at apply time and refused, nothing applied), CANCELLED.
 */
const pricingScheduleSchema = new mongoose.Schema({
  tenantId: { type: String, required: true, index: true },
  scheduleId: { type: String, required: true, unique: true },
  effectiveAt: { type: Date, required: true },
  note: { type: String, default: '' },
  status: { type: String, enum: ['SCHEDULED', 'APPLYING', 'DONE', 'FAILED', 'CANCELLED'], default: 'SCHEDULED' },
  /** [{ op, categoryId, regionId, regionKey, fields, currency }] */
  items: { type: mongoose.Schema.Types.Mixed, required: true },
  summary: { type: mongoose.Schema.Types.Mixed, default: null },
  createdBy: { type: String, default: null },
  createdAt: { type: Date, default: Date.now },
  claimedAt: { type: Date, default: null },
  appliedAt: { type: Date, default: null },
  version: { type: Number, default: null }, // the pricing version it created
  failure: { type: String, default: '' }
}, { collection: 'pricing_schedules' });
pricingScheduleSchema.index({ status: 1, effectiveAt: 1 });

const FareRuleDraft = mongoose.models.FareRuleDraft || mongoose.model('FareRuleDraft', fareRuleDraftSchema);
const PricingVersion = mongoose.models.PricingVersion || mongoose.model('PricingVersion', pricingVersionSchema);
const PricingSchedule = mongoose.models.PricingSchedule || mongoose.model('PricingSchedule', pricingScheduleSchema);
module.exports = { FareRuleDraft, PricingVersion, PricingSchedule };
