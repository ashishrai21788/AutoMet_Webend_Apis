/**
 * The driver's own data rights, from the app's Privacy & Data screen:
 *   GET  /api/v1/driver/account/export : a copy of the driver's data (a JSON file), without secrets or document files
 *   POST /api/v1/driver/account/delete : erases the account and its personal data
 *
 * What deletion removes: name, phone, email, photo, licence/ID/bank/vehicle details held on the driver record, every uploaded
 * document and its stored file, support reports, notifications and the duty log; the driver is signed out everywhere and
 * can no longer sign in. What stays: the trip and earnings records (no name, phone or photo is kept with them) because
 * accounting and safety rules require them, and the business's own vehicle record. The privacy policy says the same.
 */
const { TripDetails } = require('../models/tripDetailsModel');
const { createModel } = require('../models/dynamicModel');
const { Vehicle, DriverVehicleAssignment, DriverDocument } = require('../models/fleetModels');
const { DriverIssue } = require('../models/supportModels');
const { DriverDutySession } = require('../models/driverDutySessionModel');
const privateStorage = require('../lib/privateStorage');
const { strip } = require('../lib/tenantExport');
const c = require('./fleet/common');

const LIVE_STATUSES = ['ACCEPTED', 'DRIVER_ON_THE_WAY', 'ARRIVED', 'ON_GOING'];
const TRIP_FIELDS = ['trip_id', 'status', 'requested_at', 'started_at', 'completed_at', 'cancelled_at', 'cancellation_reason', 'distance_km', 'fare', 'currency', 'payment_mode', 'fare_breakdown', 'pickup', 'drop', 'rider_rating', 'driver_rating'];

const pick = (obj, keys) => Object.fromEntries(keys.filter((k) => obj[k] !== undefined).map((k) => [k, obj[k]]));

async function exportData(req, res) {
  const driver = req.ownDriver;
  const fresh = (await createModel('drivers').findOne({ driverId: driver.driverId }).lean()) || driver;
  const [trips, documents, assignments, issues, sessions] = await Promise.all([
    TripDetails.find({ driver_id: driver.driverId }).limit(20000).lean(),
    req.data.find(DriverDocument, { driverId: driver.driverId }),
    req.data.find(DriverVehicleAssignment, { driverId: driver.driverId }),
    DriverIssue.find({ driverId: driver.driverId }).limit(2000).lean(),
    DriverDutySession.find({ driverId: driver.driverId }).limit(20000).lean()
  ]);
  const vehicles = [];
  for (const a of assignments || []) {
    const v = await req.data.findOne(Vehicle, { vehicleId: a.vehicleId });
    if (v) vehicles.push(strip(v.toObject ? v.toObject() : v));
  }
  const file = {
    exportedAt: new Date().toISOString(),
    note: 'A copy of the data held about your driver account. Passwords, sign-in tokens and push tokens are not included, and neither are the document files themselves (only their records).',
    business: req.business.name || '',
    account: strip(fresh),
    documents: (documents || []).map((d) => {
      const o = d.toObject ? d.toObject() : d;
      return { type: o.type, number: o.number, expiryDate: o.expiryDate, status: o.status, submittedAt: o.submittedAt, reviewedAt: o.reviewedAt, fileName: o.file && o.file.originalName };
    }),
    vehicles,
    trips: trips.map((t) => pick(t, TRIP_FIELDS)),
    onlineSessions: sessions.map((s) => ({ startedAt: s.startedAt, endedAt: s.endedAt })),
    supportReports: issues.map((i) => strip(i))
  };
  res.set({ 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': 'attachment; filename="my-driver-data.json"', 'Cache-Control': 'private, no-store' });
  return res.status(200).send(JSON.stringify(file, null, 2));
}

async function deleteAccount(req, res) {
  const driver = req.ownDriver;
  if (String((req.body && req.body.confirm) || '').toUpperCase() !== 'DELETE') {
    return c.fail(res, 400, 'Please confirm that you want to delete your account.');
  }
  const live = await TripDetails.findOne({ driver_id: driver.driverId, status: { $in: LIVE_STATUSES } }).lean();
  if (live) return c.fail(res, 409, 'Finish or cancel your current ride before deleting your account.');

  const id = driver.driverId;
  // uploaded documents: the stored files first, then their records
  const documents = (await req.data.find(DriverDocument, { driverId: id })) || [];
  for (const d of documents) {
    const o = d.toObject ? d.toObject() : d;
    const keys = [o.file && o.file.key, ...((o.previousFiles || []).map((p) => p && p.key))].filter(Boolean);
    for (const key of keys) { try { await privateStorage.removeFile(key); } catch (e) { console.error('[driver delete] file', e && e.message); } }
  }
  await DriverDocument.deleteMany({ driverId: id });
  try { await DriverVehicleAssignment.updateMany({ driverId: id, active: true }, { $set: { active: false, updatedAt: new Date() } }); } catch (_) { /* nothing assigned */ }
  try { await DriverIssue.deleteMany({ driverId: id }); } catch (_) { /* no reports */ }
  try { await DriverDutySession.deleteMany({ driverId: id }); } catch (_) { /* no log */ }
  try {
    const mongoose = require('../lib/db/mongoose');
    await mongoose.connection.db.collection('drivers_notification').deleteMany({ driverId: id });
  } catch (_) { /* no notifications kept */ }

  const now = new Date();
  await createModel('drivers').findOneAndUpdate({ driverId: id }, {
    $set: {
      firstName: 'Deleted', lastName: 'driver', email: `deleted_${id}@deleted.invalid`, phone: `deleted_${id}`,
      profilePhoto: 'https://cdn.example.com/drivers/default.jpg', passwordHash: 'deleted',
      dateOfBirth: null, address: null,
      vehicleType: null, vehicleNumber: null, vehicleModel: null, vehicleColor: null, vehicleManufacturingYear: null, engineNumber: null, chassisNumber: null,
      fuleType: null, seatingCapacity: null,
      licenseNumber: null, licenseExpiry: null, license_type: null, expiry_date: null, drivingLicenseIssueDate: null, drivingLicenseIssuingAuthority: null,
      aadhaarNumber: null, id_proof_type: null,
      vehicleRegistrationImages: [], vehicleInsuranceImages: [], drivingLicenseImages: [], idProofImages: [],
      bankAccount: null, accessToken: null, fcmToken: null, deviceId: null,
      isOnline: false, isLoggedin: false, isPhoneVerified: false, lastLocation: null, locationUpdatedAt: null,
      accountStatus: 'INACTIVE', deletedAt: now, updatedAt: now
    }
  });
  console.log('[account] driver account deleted', { driverId: id });
  return c.ok(res, { driverId: id, message: 'Your account and personal data have been deleted.' });
}

const safe = (fn) => async (req, res) => {
  try {
    return await fn(req, res);
  } catch (e) {
    console.error('[driver account]', e && e.message);
    return c.fail(res, 500, 'Something went wrong. Please try again.');
  }
};

module.exports = { exportData: safe(exportData), deleteAccount: safe(deleteAccount) };
