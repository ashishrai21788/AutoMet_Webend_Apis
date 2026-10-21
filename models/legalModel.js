const mongoose = require('../lib/db/mongoose');

/**
 * A business's legal documents (privacy policy, terms, location disclosure ...), versioned.
 *
 *  - One row per (business, type, version). A version is a DRAFT until it is published; a PUBLISHED version is never edited again
 *    (a correction is a new version), so what a rider or driver agreed to can always be shown exactly.
 *  - The document in force is the PUBLISHED one with the latest \`effectiveAt\` that is not in the future, so a new version can be
 *    published ahead of the date it starts to apply.
 *  - LegalAcceptance records who agreed to which version and when (unique, so repeating it changes nothing).
 */
const legalDocumentSchema = new mongoose.Schema({
  tenantId: { type: String, required: true, index: true },
  docId: { type: String, required: true, unique: true },
  type: { type: String, required: true },
  version: { type: Number, required: true, min: 1 },
  title: { type: String, required: true, trim: true },
  content: { type: String, default: '' }, // plain text: blank line between paragraphs, "# " heading, "- " bullet
  status: { type: String, enum: ['DRAFT', 'PUBLISHED'], default: 'DRAFT', index: true },
  effectiveAt: { type: Date, default: null },
  consentRequired: { type: Boolean, default: false },
  changeNote: { type: String, default: '', trim: true },
  publishedAt: { type: Date, default: null },
  publishedBy: { type: String, default: null },
  createdBy: { type: String, default: null },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
}, { collection: 'legal_documents' });
legalDocumentSchema.index({ tenantId: 1, type: 1, version: 1 }, { unique: true });

const legalAcceptanceSchema = new mongoose.Schema({
  tenantId: { type: String, required: true, index: true },
  role: { type: String, enum: ['rider', 'driver'], required: true },
  accountId: { type: String, required: true },
  type: { type: String, required: true },
  version: { type: Number, required: true },
  at: { type: Date, default: Date.now },
  ip: { type: String, default: null }
}, { collection: 'legal_acceptances' });
legalAcceptanceSchema.index({ tenantId: 1, role: 1, accountId: 1, type: 1, version: 1 }, { unique: true });

const LegalDocument = mongoose.models.LegalDocument || mongoose.model('LegalDocument', legalDocumentSchema);
const LegalAcceptance = mongoose.models.LegalAcceptance || mongoose.model('LegalAcceptance', legalAcceptanceSchema);

module.exports = { LegalDocument, LegalAcceptance };
