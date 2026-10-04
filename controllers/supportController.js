/**
 * Support inbox: the problems this business's drivers report from the driver app, with a status, internal notes and a
 * history of who did what. Issues are matched to the business through the driver who reported them (older reports carry
 * no business tag), so a business only ever sees its own drivers' reports.
 */
const mongoose = require('mongoose');
const { AdminAudit } = require('../models/adminModels');
const { DriverIssue } = require('../models/supportModels');
const { createModel } = require('../models/dynamicModel');
const c = require('./fleet/common');

const Driver = () => createModel('drivers');
const MAX_DRIVERS = 20000;
const STATUS_FLOW = { 'issue submitted': 'New', 'under process': 'In progress', complete: 'Resolved' };
const STATUSES = Object.keys(STATUS_FLOW);
const fullName = (d) => [d.firstName, d.lastName].filter(Boolean).join(' ').trim() || d.name || d.phone || d.driverId;

async function driverIds(req) {
  const rows = await req.legacyData.find(Driver(), {}).select('driverId').limit(MAX_DRIVERS).lean();
  return rows.map((d) => d.driverId);
}

const idOf = (i) => String(i._id || i.id);

function item(i, driver) {
  return {
    id: idOf(i), driverId: i.driverId, driverName: driver ? fullName(driver) : i.driverName || i.driverId, driverPhone: driver ? driver.phone : i.driverPhone || null,
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
  const owned = await req.legacyData.findOne(Driver(), { driverId: issue.driverId }).select('driverId firstName lastName name phone').lean();
  return owned ? { issue, driver: owned } : null;
}

exports.list = c.handle(async (req, res) => {
  const { page, pageSize, skip } = c.pageParams(req.query);
  const ids = await driverIds(req);
  const filter = { driverId: { $in: ids } };
  const status = String(req.query.status || '').trim();
  if (status) {
    if (!STATUSES.includes(status)) return c.invalid(res, { status: 'Unknown status' });
    filter.status = status;
  }
  const q = String(req.query.q || '').trim().slice(0, 80);
  if (q) filter.$or = [{ issueText: { $regex: c.escapeRegex(q), $options: 'i' } }, { driverId: { $regex: c.escapeRegex(q), $options: 'i' } }, { driverName: { $regex: c.escapeRegex(q), $options: 'i' } }];

  const [rows, total, openCount] = await Promise.all([
    DriverIssue.find(filter).sort({ createdAt: -1 }).skip(skip).limit(pageSize).lean(),
    DriverIssue.countDocuments(filter),
    DriverIssue.countDocuments({ driverId: { $in: ids }, status: { $ne: 'complete' } })
  ]);
  const owners = rows.length ? await req.legacyData.find(Driver(), { driverId: { $in: [...new Set(rows.map((r) => r.driverId))] } }).select('driverId firstName lastName name phone').lean() : [];
  const by = new Map(owners.map((d) => [d.driverId, d]));
  return c.ok(res, { items: rows.map((r) => item(r, by.get(r.driverId))), total, page, pageSize, open: openCount });
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

exports.helpers = { STATUSES, STATUS_FLOW };
