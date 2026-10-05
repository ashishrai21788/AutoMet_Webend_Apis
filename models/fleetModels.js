const mongoose = require('../lib/db/mongoose');

/**
 * Driver and vehicle management. Every document carries `tenantId` (the business's appId) and every unique rule includes
 * it. Drivers themselves live in the existing `drivers` collection (models/dynamicModel.js); this file adds what the
 * dashboard needs around them. Nothing here is ever deleted: deactivation keeps the history.
 */

const storageSchema = new mongoose.Schema({
  key: { type: String, required: true }, // private storage key (never a public URL)
  mime: { type: String, required: true },
  size: { type: Number, required: true },
  originalName: { type: String, default: '' }
}, { _id: false });

const DOCUMENT_STATUSES = ['SUBMITTED', 'APPROVED', 'REJECTED'];

/** A replaced file, kept so earlier submissions stay on record (private storage keys, never public links). */
const previousFileSchema = new mongoose.Schema({
  key: String, mime: String, replacedAt: Date, status: String, rejectionReason: String
}, { _id: false });

/** A document a driver has submitted. One per type per driver; a resubmission replaces the file and returns to SUBMITTED. */
const driverDocumentSchema = new mongoose.Schema({
  tenantId: { type: String, required: true, index: true },
  docId: { type: String, required: true, unique: true },
  driverId: { type: String, required: true },
  type: { type: String, required: true },
  number: { type: String, default: '' },
  expiryDate: { type: Date, default: null },
  file: { type: storageSchema, required: true },
  status: { type: String, enum: DOCUMENT_STATUSES, default: 'SUBMITTED' },
  rejectionReason: { type: String, default: '' },
  submittedAt: { type: Date, default: Date.now },
  reviewedAt: { type: Date, default: null },
  reviewedBy: { type: String, default: null },
  version: { type: Number, default: 1 },
  previousFiles: { type: [previousFileSchema], default: [] },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
}, { collection: 'driver_documents' });
driverDocumentSchema.index({ tenantId: 1, driverId: 1, type: 1 }, { unique: true });
driverDocumentSchema.index({ tenantId: 1, status: 1 });

/** An actual registered vehicle (not a category such as Sedan; that is in vehicle_categories). */
const vehicleSchema = new mongoose.Schema({
  tenantId: { type: String, required: true, index: true },
  vehicleId: { type: String, required: true, unique: true },
  registrationNumber: { type: String, required: true, trim: true },
  /** upper-case letters and digits only, used to stop duplicate registrations inside one business */
  registrationKey: { type: String, required: true },
  make: { type: String, required: true, trim: true },
  model: { type: String, required: true, trim: true },
  year: { type: Number, default: null },
  colour: { type: String, default: '', trim: true },
  categoryId: { type: String, required: true },
  passengerCapacity: { type: Number, required: true },
  luggageCapacity: { type: Number, default: null },
  operatingRegionId: { type: String, default: null },
  /** account status (ACTIVE, INACTIVE, SUSPENDED), separate from verification and from operational eligibility */
  status: { type: String, enum: ['ACTIVE', 'INACTIVE', 'SUSPENDED'], default: 'INACTIVE' },
  verificationStatus: { type: String, enum: ['INCOMPLETE', 'PENDING_REVIEW', 'APPROVED', 'REJECTED', 'EXPIRED'], default: 'INCOMPLETE' },
  /** earliest expiry among the approved mandatory documents; an APPROVED vehicle past this date is EXPIRED */
  verificationExpiresAt: { type: Date, default: null },
  createdBy: { type: String, default: null },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
}, { collection: 'vehicles' });
vehicleSchema.index({ tenantId: 1, registrationKey: 1 }, { unique: true });
vehicleSchema.index({ tenantId: 1, status: 1 });
vehicleSchema.index({ tenantId: 1, categoryId: 1 });

const vehicleDocumentSchema = new mongoose.Schema({
  tenantId: { type: String, required: true, index: true },
  docId: { type: String, required: true, unique: true },
  vehicleId: { type: String, required: true },
  type: { type: String, required: true },
  number: { type: String, default: '' },
  expiryDate: { type: Date, default: null },
  file: { type: storageSchema, required: true },
  status: { type: String, enum: DOCUMENT_STATUSES, default: 'SUBMITTED' },
  rejectionReason: { type: String, default: '' },
  submittedAt: { type: Date, default: Date.now },
  reviewedAt: { type: Date, default: null },
  reviewedBy: { type: String, default: null },
  version: { type: Number, default: 1 },
  previousFiles: { type: [previousFileSchema], default: [] },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
}, { collection: 'vehicle_documents' });
vehicleDocumentSchema.index({ tenantId: 1, vehicleId: 1, type: 1 }, { unique: true });

/** Which driver drives which vehicle. Ended assignments stay as history (active=false). */
const assignmentSchema = new mongoose.Schema({
  tenantId: { type: String, required: true, index: true },
  assignmentId: { type: String, required: true, unique: true },
  driverId: { type: String, required: true },
  vehicleId: { type: String, required: true },
  active: { type: Boolean, default: true },
  assignedAt: { type: Date, default: Date.now },
  assignedBy: { type: String, default: null },
  endedAt: { type: Date, default: null },
  endedBy: { type: String, default: null },
  endReason: { type: String, default: '' }
}, { collection: 'driver_vehicle_assignments' });
// At most one active assignment per vehicle and per driver, enforced by the database as well as in code.
assignmentSchema.index({ tenantId: 1, vehicleId: 1 }, { unique: true, partialFilterExpression: { active: true } });
assignmentSchema.index({ tenantId: 1, driverId: 1 }, { unique: true, partialFilterExpression: { active: true } });

/** Timeline shown on driver and vehicle screens: verification decisions, status changes, assignments, document events. */
const entityHistorySchema = new mongoose.Schema({
  tenantId: { type: String, required: true, index: true },
  subjectType: { type: String, enum: ['driver', 'vehicle'], required: true },
  subjectId: { type: String, required: true },
  kind: { type: String, required: true }, // VERIFICATION, ACCOUNT_STATUS, ASSIGNMENT, DOCUMENT
  action: { type: String, required: true },
  from: { type: String, default: null },
  to: { type: String, default: null },
  detail: { type: String, default: '' },
  reason: { type: String, default: '' },
  actorId: { type: String, default: null },
  actorEmail: { type: String, default: null },
  at: { type: Date, default: Date.now }
}, { collection: 'entity_history' });
entityHistorySchema.index({ tenantId: 1, subjectType: 1, subjectId: 1, at: -1 });

const reuse = (name, schema) => mongoose.models[name] || mongoose.model(name, schema);

module.exports = {
  DriverDocument: reuse('DriverDocument', driverDocumentSchema),
  Vehicle: reuse('Vehicle', vehicleSchema),
  VehicleDocument: reuse('VehicleDocument', vehicleDocumentSchema),
  DriverVehicleAssignment: reuse('DriverVehicleAssignment', assignmentSchema),
  EntityHistory: reuse('EntityHistory', entityHistorySchema),
  DOCUMENT_STATUSES
};
