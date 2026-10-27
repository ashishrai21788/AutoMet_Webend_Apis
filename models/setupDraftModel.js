const mongoose = require('../lib/db/mongoose');

/**
 * Region and category drafts. With a business's setup workflow on "draft", saving a region or category writes one of these instead of
 * changing the live record; live reads only the service_regions and vehicle_categories collections, so a draft changes nothing until
 * the drafts are published together.
 *
 *  entity          'region' or 'category'
 *  op              CREATE: a new record (one draft per new city for regions); UPDATE: changes to a live record (one draft per record,
 *                  a later edit is merged into it)
 *  payload         the validated fields (see lib/businessValidation); for a new region: state, city, zoneName, key, center, radiusKm
 *  baseUpdatedAt   the live record's updatedAt when an UPDATE draft was started, to notice when live moved underneath it
 */
const setupDraftSchema = new mongoose.Schema({
  tenantId: { type: String, required: true, index: true },
  draftId: { type: String, required: true, unique: true },
  entity: { type: String, enum: ['region', 'category'], required: true },
  op: { type: String, enum: ['CREATE', 'UPDATE'], required: true },
  targetId: { type: String, default: null },
  /** what is reserved by this draft, to refuse a second draft with the same name or zone (regions: key, categories: nameKey) */
  reserveKey: { type: String, default: null },
  payload: { type: mongoose.Schema.Types.Mixed, required: true },
  baseUpdatedAt: { type: Date, default: null },
  createdBy: { type: String, default: null },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
}, { collection: 'setup_drafts' });
setupDraftSchema.index({ tenantId: 1, entity: 1, targetId: 1 });

const SetupDraft = mongoose.models.SetupDraft || mongoose.model('SetupDraft', setupDraftSchema);

module.exports = { SetupDraft };
