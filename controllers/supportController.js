/**
 * Support inbox: the problems this business's drivers report from the driver app, with a status, internal notes and a
 * history of who did what. Issues are matched to the business through the driver who reported them (older reports carry
 * no business tag), so a business only ever sees its own drivers' reports.
 */
const mongoose = require('mongoose');
const { AdminAudit } = require('../models/adminModels');
const { DriverIssue } = require('../models/supportModels');
const { createModel } = require('../models/dynamicModel');
const { TripDetails } = require('../models/tripDetailsModel');
const { effectiveTenantId } = require('../lib/appTenant');
const c = require('./fleet/common');

const Driver = () => createModel('drivers');
const User = () => createModel('users');
const MAX_DRIVERS = 20000;
const STATUS_FLOW = { 'issue submitted': 'New', 'under process': 'In progress', complete: 'Resolved' };
const STATUSES = Object.keys(STATUS_FLOW);
const fullName = (d) => [d.firstName, d.lastName].filter(Boolean).join(' ').trim() || d.name || d.phone || d.driverId;

async function driverIds(req) {
  const rows = await req.legacyData.find(Driver(), {}).select('driverId').limit(MAX_DRIVERS).lean();
  return rows.map((d) => d.driverId);
}

const idOf = (i) => String(i._id || i.id);

function item(i, person) {
  const rider = i.reporterType === 'rider';
  return {
    id: idOf(i), reporterType: rider ? 'rider' : 'driver', reporterId: rider ? i.riderId : i.driverId, tripId: i.tripId || null,
    driverId: rider ? null : i.driverId, driverName: person ? fullName(person) : (rider ? i.riderId : i.driverName || i.driverId), driverPhone: person ? person.phone : (rider ? null : i.driverPhone || null),
    text: i.issueText || '', imageCount: (i.imageUrls || []).length, status: i.status || 'issue submitted', statusLabel: STATUS_FLOW[i.status || 'issue submitted'] || i.status,
    createdAt: i.createdAt, updatedAt: i.updatedAt || i.createdAt, resolvedAt: i.resolvedAt || null, noteCount: (i.notes || []).length
  };
}

/** The issue by id, only if one of this business's drivers reported it. */
async function findIssue(req) {
  const id = String(req.params.id);
  if (!mongoose.Types.ObjectId.isValid(id)) return null;
  const issue = await DriverIssue.findOne({ _id: id }).lean();
  if (!issue) return null;
  if (issue.reporterType === 'rider') {
    if (issue.tenantId !== req.business.tenantId) return null;
    const rider = await req.legacyData.findOne(User(), { userId: issue.riderId }).select('userId firstName lastName phone').lean();
    return { issue, driver: rider || { firstName: issue.riderId, phone: null } };
  }
  const owned = await req.legacyData.findOne(Driver(), { driverId: issue.driverId }).select('driverId firstName lastName name phone').lean();
  return owned ? { issue, driver: owned } : null;
}

exports.list = c.handle(async (req, res) => {
  const { page, pageSize, skip } = c.pageParams(req.query);
  const ids = await driverIds(req);
  // a driver's report is this business's when the driver is; a rider's report carries the business it was made in
  const ownership = [{ driverId: { $in: ids } }, { reporterType: 'rider', tenantId: req.business.tenantId }];
  const filter = { $and: [{ $or: ownership }] };
  const status = String(req.query.status || '').trim();
  if (status) {
    if (!STATUSES.includes(status)) return c.invalid(res, { status: 'Unknown status' });
    filter.$and.push({ status });
  }
  const q = String(req.query.q || '').trim().slice(0, 80);
  if (q) filter.$and.push({ $or: [{ issueText: { $regex: c.escapeRegex(q), $options: 'i' } }, { driverId: { $regex: c.escapeRegex(q), $options: 'i' } }, { riderId: { $regex: c.escapeRegex(q), $options: 'i' } }, { driverName: { $regex: c.escapeRegex(q), $options: 'i' } }] });

  const [rows, total, openCount] = await Promise.all([
    DriverIssue.find(filter).sort({ createdAt: -1 }).skip(skip).limit(pageSize).lean(),
    DriverIssue.countDocuments(filter),
    DriverIssue.countDocuments({ $and: [{ $or: ownership }, { status: { $ne: 'complete' } }] })
  ]);
  const driverRows = rows.filter((r) => r.reporterType !== 'rider');
  const riderRows = rows.filter((r) => r.reporterType === 'rider');
  const [owners, riders] = await Promise.all([
    driverRows.length ? req.legacyData.find(Driver(), { driverId: { $in: [...new Set(driverRows.map((r) => r.driverId))] } }).select('driverId firstName lastName name phone').lean() : [],
    riderRows.length ? req.legacyData.find(User(), { userId: { $in: [...new Set(riderRows.map((r) => r.riderId))] } }).select('userId firstName lastName phone').lean() : []
  ]);
  const by = new Map(owners.map((d) => [d.driverId, d]));
  const byRider = new Map(riders.map((u) => [u.userId, u]));
  return c.ok(res, { items: rows.map((r) => item(r, r.reporterType === 'rider' ? byRider.get(r.riderId) : by.get(r.driverId))), total, page, pageSize, open: openCount });
});

exports.get = c.handle(async (req, res) => {
  const found = await findIssue(req);
  if (!found) return c.fail(res, 404, 'Issue not found');
  const { issue, driver } = found;
  return c.ok(res, {
    ...item(issue, driver), imageUrls: (issue.imageUrls || []).filter((u) => /^https:\/\//i.test(u)),
    notes: (issue.notes || []).map((n) => ({ at: n.at, by: n.by, text: n.text, status: n.status || null }))
  });
});

/** POST /business/support/issues/:id  { status?, note? }: at least one of them. */
exports.update = c.handle(async (req, res) => {
  const found = await findIssue(req);
  if (!found) return c.fail(res, 404, 'Issue not found');
  const { issue } = found;
  const fromStatus = issue.status || 'issue submitted';
  const body = req.body || {};
  const errors = {};
  const status = body.status === undefined ? null : String(body.status);
  const note = String(body.note || '').trim().replace(/\r/g, '');
  if (status !== null && !STATUSES.includes(status)) errors.status = 'Choose New, In progress or Resolved';
  if (note.length > 1000) errors.note = 'Keep a note under 1000 characters';
  if (status === null && !note) errors.note = 'Write a note or change the status';
  if (Object.keys(errors).length) return c.invalid(res, errors);

  const now = new Date();
  const set = { updatedAt: now };
  if (status !== null && status !== fromStatus) {
    set.status = status;
    set.resolvedAt = status === 'complete' ? now : null;
  }
  const entry = { at: now, by: req.admin.email, text: note || (set.status ? `Status changed to ${STATUS_FLOW[set.status]}` : ''), status: set.status || null };
  if (note) set.adminNotes = note;
  await DriverIssue.findOneAndUpdate({ _id: issue._id }, { $set: set, $push: { notes: entry } });
  try {
    await AdminAudit.create({
      tenantId: req.business.tenantId, actorId: req.admin.adminId, actorEmail: req.admin.email, action: 'support.issue_updated', targetType: 'issue', targetId: idOf(issue),
      meta: { from: fromStatus, to: set.status || fromStatus, noted: !!note }, ip: req.ip || null
    });
  } catch (e) { console.warn('[support] audit write failed:', e.message); }
  return c.ok(res, { id: idOf(issue), status: set.status || fromStatus });
});


// ---------------------------------------------------------------- rider-facing

const RIDER_ISSUE_MIN = 5;
const RIDER_ISSUE_MAX = 2000;

/** POST /api/users/issues  { issueText, tripId?, imageUrls? }  (rider sign-in) */
exports.submitRiderIssue = async (req, res) => {
  try {
    const riderId = String(req.authActorId || (req.body && req.body.userId) || '').trim();
    if (!riderId) return res.status(400).json({ success: false, message: 'Missing required field: userId', data: null });
    const rider = await User().findOne({ userId: riderId }).lean();
    if (!rider) return res.status(404).json({ success: false, message: 'Rider not found', data: null });

    const body = req.body || {};
    const text = String(body.issueText || '').trim();
    const errors = {};
    if (text.length < RIDER_ISSUE_MIN) errors.issueText = 'Please describe the problem (at least 5 characters)';
    else if (text.length > RIDER_ISSUE_MAX) errors.issueText = 'Please keep it under 2000 characters';
    let imageUrls = [];
    if (body.imageUrls !== undefined && body.imageUrls !== null) {
      if (!Array.isArray(body.imageUrls)) errors.imageUrls = 'imageUrls must be a list';
      else imageUrls = body.imageUrls.filter((u) => typeof u === 'string' && /^https:\/\/\S{4,500}$/i.test(u.trim())).map((u) => u.trim()).slice(0, 5);
    }
    let tripId = null;
    if (body.tripId) {
      const t = await TripDetails.findOne({ trip_id: String(body.tripId), user_id: riderId }).select('trip_id').lean(); // only the rider's own trip
      if (!t) errors.tripId = 'That trip was not found on your account';
      else tripId = t.trip_id;
    }
    if (Object.keys(errors).length) return res.status(400).json({ success: false, message: Object.values(errors)[0], errors, data: null });

    const tenantId = await effectiveTenantId(rider);
    const now = new Date();
    const doc = await DriverIssue.create({ reporterType: 'rider', riderId, tenantId, tripId, issueText: text, imageUrls, status: 'issue submitted', createdAt: now, updatedAt: now });
    return res.status(201).json({ success: true, message: 'Your report was sent to support', data: { issueId: idOf(doc), status: 'issue submitted', createdAt: now } });
  } catch (e) {
    console.error('[support] rider issue failed:', e.message);
    return res.status(500).json({ success: false, message: 'Could not send your report. Please try again.', data: null });
  }
};

/** GET /api/users/issues: the rider's own reports, with the status and the latest note from support. */
exports.myRiderIssues = async (req, res) => {
  try {
    const riderId = String(req.authActorId || (req.query && req.query.userId) || '').trim();
    if (!riderId) return res.status(400).json({ success: false, message: 'Missing userId', data: null });
    const rows = await DriverIssue.find({ reporterType: 'rider', riderId }).sort({ createdAt: -1 }).limit(50).lean();
    return res.status(200).json({
      success: true, message: 'OK',
      data: rows.map((i) => ({ issueId: idOf(i), tripId: i.tripId || null, issueText: i.issueText, status: i.status || 'issue submitted', statusLabel: STATUS_FLOW[i.status || 'issue submitted'], supportNote: i.adminNotes || null, createdAt: i.createdAt, updatedAt: i.updatedAt, resolvedAt: i.resolvedAt || null }))
    });
  } catch (e) {
    return res.status(500).json({ success: false, message: 'Could not load your reports', data: null });
  }
};

exports.helpers = { STATUSES, STATUS_FLOW };
