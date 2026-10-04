const mongoose = require('mongoose');

/**
 * Problems drivers report from the driver app (collection `driver_issues_reports`, written by
 * POST /api/drivers/issues). The admin dashboard reads and triages them here. The schema is not strict so the documents
 * the driver app already created keep every field they have.
 */
const driverIssueSchema = new mongoose.Schema({
  tenantId: { type: String, default: null, index: true },
  /** who reported it: a driver (the original use) or a rider */
  reporterType: { type: String, enum: ['driver', 'rider'], default: 'driver' },
  driverId: { type: String, default: null, index: true },
  riderId: { type: String, default: null, index: true },
  /** the trip a rider is complaining about, when they chose one */
  tripId: { type: String, default: null },
  issueText: { type: String, default: '' },
  imageUrls: { type: [String], default: [] },
  status: { type: String, enum: ['issue submitted', 'under process', 'complete'], default: 'issue submitted', index: true },
  adminNotes: { type: String, default: null }, // the latest note (what the driver app shows)
  /** internal notes and status changes, oldest first */
  notes: { type: [{ at: Date, by: String, text: String, status: String }], default: [] },
  assignedTo: { type: String, default: null },
  resolvedAt: { type: Date, default: null },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
}, { collection: 'driver_issues_reports', strict: false });

const DriverIssue = mongoose.models.DriverIssue || mongoose.model('DriverIssue', driverIssueSchema);

module.exports = { DriverIssue };
