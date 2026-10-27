/**
 * Region and category drafts (admin dashboard, Regions and Categories).
 *
 * A business can choose how setup changes are applied:
 *   direct  a saved region or category is live at once (the default)
 *   draft   a save is checked exactly as before, then waits as a draft; nothing changes for riders or drivers until the drafts are
 *           published together
 *
 *   GET    /api/admin/business/setup/draft        the mode, the drafts, what publishing would change, and which are stale
 *   DELETE /api/admin/business/setup/draft/:id    discard one draft
 *   DELETE /api/admin/business/setup/draft        discard all drafts
 *   POST   /api/admin/business/setup/publish      { note? } apply every draft together; everything is checked first
 *   PUT    /api/admin/business/setup/workflow     { mode: direct | draft }
 *
 * The existing region and category routes call the capture* functions below instead of writing live when the mode is draft.
 *
 * Publishing is checked before anything is written: a draft made against a record that has changed since is stale, and a name or zone
 * that another change has taken, or a region that became inactive, is a problem. Either way nothing is applied and the drafts are kept.
 * The apply step then writes in a fixed order (new regions, region edits, new categories, category edits) and removes each draft as
 * it is applied, so a failure part way leaves exactly the drafts that were not applied.
 */
const crypto = require('crypto');
const { Tenant, AdminAudit } = require('../models/adminModels');
const { ServiceRegion, VehicleCategory } = require('../models/businessModels');
const { SetupDraft } = require('../models/setupDraftModel');
const v = require('../lib/businessValidation');

const ok = (res, data, status = 200) => res.status(status).json({ success: true, message: 'OK', data });
const fail = (res, status, message, errors) => res.status(status).json({ success: false, message, errors: errors || undefined, data: null });
const invalid = (res, errors) => fail(res, 400, 'Please fix the highlighted fields', errors);
const newId = (prefix) => `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
const DUP = (e) => e && e.code === 11000;
const MODES = ['direct', 'draft'];

async function audit(req, action, targetType, targetId, meta) {
  try {
    await AdminAudit.create({
      tenantId: req.business.tenantId, actorId: req.admin.adminId, actorEmail: req.admin.email, action, targetType,
      targetId, meta: meta || null, ip: req.ip || null
    });
  } catch (e) {
    console.warn('[setupDrafts] audit write failed:', e.message);
  }
}

const handle = (fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (e) {
    console.error(`[setupDrafts] ${req.method} ${req.path}:`, e.message);
    fail(res, 500, 'Something went wrong. Please try again.');
  }
};

const isDraftMode = (req) => !!(req.business && req.business.setupWorkflow === 'draft');
const drafts = (req) => req.data.find(SetupDraft);
const sameTime = (a, b) => (a ? new Date(a).getTime() : null) === (b ? new Date(b).getTime() : null);
const draftSet = (rows, entity, op) => rows.filter((d) => d.entity === entity && (!op || d.op === op));

// ---------- saving as a draft (called by the region and category routes) ----------

/** Puts one UPDATE draft in place for a live record; a later edit is merged into the earlier one. */
async function upsertUpdate(req, entity, target, targetId, value, reserveKey) {
  const rows = await drafts(req);
  const existing = rows.find((d) => d.entity === entity && d.op === 'UPDATE' && d.targetId === targetId);
  const payload = { ...(existing ? existing.payload : {}), ...value };
  const key = reserveKey !== undefined ? reserveKey : (existing ? existing.reserveKey : null);
  if (existing) {
    return req.data.update(SetupDraft, { draftId: existing.draftId }, { payload, reserveKey: key, updatedAt: new Date() });
  }
  return req.data.create(SetupDraft, {
    draftId: newId('sd'), entity, op: 'UPDATE', targetId, reserveKey: key, payload, baseUpdatedAt: target.updatedAt || null,
    createdBy: req.admin.adminId, createdAt: new Date(), updatedAt: new Date()
  });
}

const savedAsDraft = (res, created, extra = {}) => ok(res, { draft: true, drafts: created.map((d) => ({ id: d.draftId, entity: d.entity, op: d.op })), ...extra }, 202);

async function captureRegionBatch(req, res, value, market) {
  const rows = await drafts(req);
  const waiting = new Set(draftSet(rows, 'region').map((d) => d.reserveKey).filter(Boolean));
  const created = [];
  const skipped = [];
  for (const { name: city, center } of value.cities) {
    const key = v.normalizeKey(value.state, city, value.zoneName);
    if (waiting.has(key) || (await req.data.exists(ServiceRegion, { key }))) { skipped.push(city); continue; }
    waiting.add(key);
    created.push(await req.data.create(SetupDraft, {
      draftId: newId('sd'), entity: 'region', op: 'CREATE', targetId: null, reserveKey: key,
      payload: { country: market.country, state: value.state, city, zoneName: value.zoneName, key, center: center || null, radiusKm: center ? value.radiusKm : null },
      createdBy: req.admin.adminId, createdAt: new Date(), updatedAt: new Date()
    }));
  }
  if (!created.length) return fail(res, 409, 'Those regions already exist or are already waiting as drafts', { cities: 'Already added' });
  return savedAsDraft(res, created, { skipped });
}

async function captureRegionUpdate(req, res, value, region) {
  let reserveKey;
  if (value.zoneName !== undefined) {
    reserveKey = v.normalizeKey(region.state, region.city, value.zoneName);
    const clash = await req.data.findOne(ServiceRegion, { key: reserveKey });
    const rows = await drafts(req);
    const taken = draftSet(rows, 'region').some((d) => d.reserveKey === reserveKey && !(d.op === 'UPDATE' && d.targetId === region.regionId));
    if ((clash && clash.regionId !== region.regionId) || taken) return fail(res, 409, 'That zone already exists for this city', { zoneName: 'Already exists' });
  }
  const draft = await upsertUpdate(req, 'region', region, region.regionId, value, reserveKey);
  return savedAsDraft(res, [draft]);
}

/** The regions a category may name: they exist, and are active unless the category already had them. */
async function regionIdsProblem(req, ids, previous = []) {
  const regions = await req.data.find(ServiceRegion, { regionId: { $in: ids } });
  const byId = new Map(regions.map((r) => [r.regionId, r]));
  for (const id of ids) {
    const r = byId.get(id);
    if (!r) return 'One of the selected regions does not exist';
    if (!r.active && !previous.includes(id)) return `Region "${r.city} (${r.zoneName})" is inactive`;
  }
  return null;
}

async function captureCategoryCreate(req, res, value) {
  const problem = await regionIdsProblem(req, value.regionIds);
  if (problem) return invalid(res, { regionIds: problem });
  const nameKey = v.normalizeKey(value.name);
  const rows = await drafts(req);
  if ((await req.data.exists(VehicleCategory, { nameKey })) || draftSet(rows, 'category').some((d) => d.reserveKey === nameKey)) {
    return fail(res, 409, 'A category with this name already exists', { name: 'Already exists' });
  }
  const draft = await req.data.create(SetupDraft, {
    draftId: newId('sd'), entity: 'category', op: 'CREATE', targetId: null, reserveKey: nameKey,
    payload: { ...value, nameKey, active: value.active !== false },
    createdBy: req.admin.adminId, createdAt: new Date(), updatedAt: new Date()
  });
  return savedAsDraft(res, [draft]);
}

async function captureCategoryUpdate(req, res, value, category) {
  if (value.regionIds) {
    const problem = await regionIdsProblem(req, value.regionIds, category.regionIds || []);
    if (problem) return invalid(res, { regionIds: problem });
  }
  let reserveKey;
  const extra = {};
  if (value.name !== undefined) {
    reserveKey = v.normalizeKey(value.name);
    extra.nameKey = reserveKey;
    const clash = await req.data.findOne(VehicleCategory, { nameKey: reserveKey });
    const rows = await drafts(req);
    const taken = draftSet(rows, 'category').some((d) => d.reserveKey === reserveKey && !(d.op === 'UPDATE' && d.targetId === category.categoryId));
    if ((clash && clash.categoryId !== category.categoryId) || taken) return fail(res, 409, 'A category with this name already exists', { name: 'Already exists' });
  }
  const draft = await upsertUpdate(req, 'category', category, category.categoryId, { ...value, ...extra }, reserveKey);
  return savedAsDraft(res, [draft]);
}

// ---------- reading ----------

const COMPARED = { region: ['zoneName', 'active', 'center', 'radiusKm'], category: ['name', 'description', 'icon', 'imageUrl', 'mapIconUrl', 'passengerCapacity', 'luggageCapacity', 'rideType', 'regionIds', 'active'] };
const sameValue = (a, b) => JSON.stringify(a === undefined ? null : a) === JSON.stringify(b === undefined ? null : b);

const liveOf = (d, regions, categories) => (d.entity === 'region' ? regions : categories).find((r) => (d.entity === 'region' ? r.regionId : r.categoryId) === d.targetId) || null;

function labelOf(d, live) {
  const p = d.payload || {};
  if (d.entity === 'region') return d.op === 'CREATE' ? `${p.city} (${p.zoneName})` : `${live ? live.city : 'Region'} (${p.zoneName !== undefined ? p.zoneName : live ? live.zoneName : ''})`;
  return p.name || (live ? live.name : 'Category');
}

function draftView(d, live, stale) {
  return { id: d.draftId, entity: d.entity, op: d.op, targetId: d.targetId, label: labelOf(d, live), fields: d.payload, stale, createdAt: d.createdAt, createdBy: d.createdBy || null };
}

/** What each draft would change against live: ADDED, or CHANGED with only the fields that really differ (a draft that matches live changes nothing). */
function changesOf(rows, regions, categories) {
  const out = [];
  for (const d of rows) {
    const live = liveOf(d, regions, categories);
    if (d.op === 'CREATE') { out.push({ id: d.draftId, entity: d.entity, kind: 'ADDED', label: labelOf(d, null), fields: Object.entries(d.payload).filter(([k]) => !['key', 'nameKey', 'country'].includes(k)).map(([field, to]) => ({ field, from: null, to })) }); continue; }
    if (!live) continue;
    const fields = COMPARED[d.entity].filter((f) => f in (d.payload || {}) && !sameValue(d.payload[f], live[f])).map((field) => ({ field, from: live[field] === undefined ? null : live[field], to: d.payload[field] }));
    if (fields.length) out.push({ id: d.draftId, entity: d.entity, kind: 'CHANGED', label: labelOf(d, live), fields });
  }
  return out;
}

const staleOf = (rows, regions, categories) => rows.filter((d) => {
  if (d.op !== 'UPDATE') return false;
  const live = liveOf(d, regions, categories);
  return !live || !sameTime(live.updatedAt, d.baseUpdatedAt);
}).map((d) => d.draftId);

const summaryOf = (changes) => ({ added: changes.filter((c) => c.kind === 'ADDED').length, changed: changes.filter((c) => c.kind === 'CHANGED').length });

async function snapshot(req) {
  const [rows, regions, categories] = await Promise.all([drafts(req), req.data.find(ServiceRegion), req.data.find(VehicleCategory)]);
  rows.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  return { rows, regions, categories };
}

exports.getDraft = handle(async (req, res) => {
  const { rows, regions, categories } = await snapshot(req);
  const stale = staleOf(rows, regions, categories);
  const changes = changesOf(rows, regions, categories);
  return ok(res, {
    mode: isDraftMode(req) ? 'draft' : 'direct',
    drafts: rows.map((d) => draftView(d, liveOf(d, regions, categories), stale.includes(d.draftId))),
    changes, summary: summaryOf(changes), stale
  });
});

// ---------- the switch, discarding, publishing ----------

exports.setWorkflow = handle(async (req, res) => {
  const mode = req.body && req.body.mode;
  if (!MODES.includes(mode)) return invalid(res, { mode: 'Choose direct or draft' });
  if (mode === 'direct' && (await drafts(req)).length) return fail(res, 409, 'Publish or discard the waiting drafts before applying changes immediately', { mode: 'Drafts are waiting' });
  await req.data.update(Tenant, {}, { setupWorkflow: mode });
  await audit(req, 'setup.workflow_changed', 'business', req.business.tenantId, { mode });
  return ok(res, { mode });
});

exports.discard = handle(async (req, res) => {
  const id = req.params && req.params.id;
  const rows = await drafts(req);
  const target = id ? rows.filter((d) => d.draftId === id) : rows;
  if (id && !target.length) return fail(res, 404, 'That draft does not exist');
  for (const d of target) await req.data.remove(SetupDraft, { draftId: d.draftId });
  if (target.length) await audit(req, 'setup.drafts_discarded', 'business', req.business.tenantId, { count: target.length, id: id || null });
  return ok(res, { discarded: target.length });
});

/** Everything that must hold for the drafts to go live together, judged against live as it is now plus the earlier drafts in the same publish. */
function problemsOf(rows, regions, categories) {
  const problems = [];
  const regionKeys = new Map(regions.map((r) => [r.key, r.regionId]));
  const regionActive = new Map(regions.map((r) => [r.regionId, r.active]));
  for (const d of draftSet(rows, 'region', 'UPDATE')) {
    const live = regions.find((r) => r.regionId === d.targetId);
    if (!live) continue;
    if (d.payload.zoneName !== undefined) regionKeys.delete(live.key);
    if (d.payload.active !== undefined) regionActive.set(live.regionId, d.payload.active);
  }
  for (const d of draftSet(rows, 'region', 'CREATE')) {
    if (regionKeys.has(d.payload.key)) problems.push(`Region ${labelOf(d, null)} already exists`);
    regionKeys.set(d.payload.key, d.draftId);
  }
  for (const d of draftSet(rows, 'region', 'UPDATE')) {
    if (d.payload.zoneName === undefined) continue;
    if (regionKeys.has(d.reserveKey)) problems.push(`Zone "${d.payload.zoneName}" already exists for ${(regions.find((r) => r.regionId === d.targetId) || {}).city}`);
    regionKeys.set(d.reserveKey, d.targetId);
  }

  const names = new Map(categories.map((c) => [c.nameKey, c.categoryId]));
  for (const d of draftSet(rows, 'category', 'UPDATE')) {
    const live = categories.find((c) => c.categoryId === d.targetId);
    if (live && d.payload.name !== undefined) names.delete(live.nameKey);
  }
  for (const d of draftSet(rows, 'category')) {
    if (d.payload.name !== undefined) {
      if (names.has(d.reserveKey)) problems.push(`A category named "${d.payload.name}" already exists`);
      names.set(d.reserveKey, d.draftId);
    }
    if (d.payload.regionIds) {
      const live = d.op === 'UPDATE' ? categories.find((c) => c.categoryId === d.targetId) : null;
      const had = (live && live.regionIds) || [];
      for (const id of d.payload.regionIds) {
        const r = regions.find((x) => x.regionId === id);
        if (!r) problems.push(`"${labelOf(d, live)}" names a region that does not exist`);
        else if (regionActive.get(id) === false && !had.includes(id)) problems.push(`Region "${r.city} (${r.zoneName})" is inactive, so "${labelOf(d, live)}" cannot use it`);
      }
    }
  }
  return problems;
}

exports.publish = handle(async (req, res) => {
  const { rows, regions, categories } = await snapshot(req);
  if (!rows.length) return fail(res, 409, 'There are no drafts to publish');
  const stale = staleOf(rows, regions, categories);
  if (stale.length) return fail(res, 409, 'Live setup changed after some drafts were made. Discard those drafts and make them again.', { stale });
  const problems = problemsOf(rows, regions, categories);
  if (problems.length) return fail(res, 409, 'Some drafts cannot be published', { problems });

  const note = typeof (req.body && req.body.note) === 'string' ? req.body.note.trim().slice(0, 300) : '';
  const done = { added: 0, changed: 0 };
  const finish = async (d) => req.data.remove(SetupDraft, { draftId: d.draftId });
  try {
    for (const d of draftSet(rows, 'region', 'CREATE')) {
      const row = await req.data.create(ServiceRegion, { regionId: newId('rg'), ...d.payload, active: true, createdAt: new Date(), updatedAt: new Date() });
      await audit(req, 'region.created', 'region', row.regionId, { count: 1, state: d.payload.state });
      await finish(d); done.added += 1;
    }
    for (const d of draftSet(rows, 'region', 'UPDATE')) {
      const set = { ...d.payload, updatedAt: new Date() };
      if (d.payload.zoneName !== undefined) set.key = d.reserveKey;
      await req.data.update(ServiceRegion, { regionId: d.targetId }, set);
      await audit(req, d.payload.active === false ? 'region.deactivated' : 'region.updated', 'region', d.targetId, d.payload);
      await finish(d); done.changed += 1;
    }
    for (const d of draftSet(rows, 'category', 'CREATE')) {
      const row = await req.data.create(VehicleCategory, { categoryId: newId('vc'), ...d.payload, createdAt: new Date(), updatedAt: new Date() });
      await audit(req, 'category.created', 'category', row.categoryId, { name: row.name });
      await finish(d); done.added += 1;
    }
    for (const d of draftSet(rows, 'category', 'UPDATE')) {
      const set = { ...d.payload, updatedAt: new Date() };
      if (d.payload.name !== undefined) set.nameKey = d.reserveKey;
      await req.data.update(VehicleCategory, { categoryId: d.targetId }, set);
      await audit(req, d.payload.active === false ? 'category.deactivated' : 'category.updated', 'category', d.targetId, { fields: Object.keys(d.payload) });
      await finish(d); done.changed += 1;
    }
  } catch (e) {
    if (DUP(e)) return fail(res, 409, 'A name or zone was taken while publishing. The drafts that were not applied are kept.', { applied: done });
    throw e;
  }
  await audit(req, 'setup.published', 'business', req.business.tenantId, { ...done, ...(note ? { note } : {}) });
  return ok(res, { published: done });
});

Object.assign(exports, { isDraftMode, captureRegionBatch, captureRegionUpdate, captureCategoryCreate, captureCategoryUpdate });
