const mongoose = require('../lib/db/mongoose');

/**
 * A numbered, never-edited copy of a business's settings (see lib/configVersions.js). One is written every time one of the
 * tracked settings is saved, and when one is rolled back to. Rolling back never rewrites history: it applies an old copy and
 * records that as a new version.
 */
const configVersionSchema = new mongoose.Schema({
  tenantId: { type: String, required: true, index: true },
  version: { type: Number, required: true, min: 1 },
  /** the tracked settings as they were after this change (only the fields lib/configVersions.js knows about) */
  snapshot: { type: mongoose.Schema.Types.Mixed, required: true },
  /** the groups that differ from the version before (business, payout, tolls, appVersions, rideSettings) */
  changed: { type: [String], default: [] },
  /** the audit action that caused it, or 'baseline' for the settings as they were before the first tracked change */
  source: { type: String, default: '' },
  /** set when this version was made by rolling back: the version whose settings were applied */
  rollbackOf: { type: Number, default: null },
  actorId: { type: String, default: null },
  actorEmail: { type: String, default: null },
  createdAt: { type: Date, default: Date.now }
}, { collection: 'config_versions' });
configVersionSchema.index({ tenantId: 1, version: 1 }, { unique: true });

const ConfigVersion = mongoose.models.ConfigVersion || mongoose.model('ConfigVersion', configVersionSchema);
module.exports = { ConfigVersion };
