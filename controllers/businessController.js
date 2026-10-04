const crypto = require('crypto');
const { Tenant, AdminAudit } = require('../models/adminModels');
const { ServiceRegion, VehicleCategory, FareRule, CancellationPolicy, SetupProgress } = require('../models/businessModels');
const shapes = require('../lib/adminShapes');
const v = require('../lib/businessValidation');
const { validateFareRuleInput, calculateFare, MAX_MONEY } = require('../lib/fareRules');
const { computeSetup } = require('../lib/businessSetup');

const ok = (res, data, status = 200) => res.status(status).json({ success: true, message: 'OK', data });
const fail = (res, status, message, errors) => res.status(status).json({ success: false, message, errors: errors || undefined, data: null });
const invalid = (res, errors) => fail(res, 400, 'Please fix the highlighted fields', errors);
const newId = (prefix) => `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
const DUP = (e) => e && e.code === 11000;

async function audit(req, action, targetType, targetId, meta) {
  try {
    await AdminAudit.create({
      tenantId: req.business.tenantId, actorId: req.admin.adminId, actorEmail: req.admin.email, action, targetType,
      targetId, meta: meta || null, ip: req.ip || null
    });
  } catch (e) {
    console.warn('[business] audit write failed:', e.message);
  }
}

// Wraps a handler so an unexpected error becomes a clean 500 and never leaks internals.
const handle = (fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (e) {
    console.error(`[business] ${req.method} ${req.path}:`, e.message);
    fail(res, 500, 'Something went wrong. Please try again.');
  }
};

async function loadSetupInputs(req) {
  const d = req.data;
  const [regions, categories, fareRules, progress] = await Promise.all([
    d.find(ServiceRegion), d.find(VehicleCategory), d.find(FareRule), d.findOne(SetupProgress)
  ]);
  return {
    regions, categories, fareRules,
    setup: computeSetup({ market: req.business.market && req.business.market.country ? req.business.market : null, regions, categories, fareRules, completedAt: progress?.completedAt || null })
  };
}

// ---------- overview, settings, market ----------

exports.overview = handle(async (req, res) => {
  const { regions, categories, fareRules, setup } = await loadSetupInputs(req);
  const priced = new Set(fareRules.filter((f) => f.active).map((f) => f.categoryId));
  return ok(res, {
    business: shapes.publicTenant(req.business),
    setup,
    counts: {
      regions: regions.length,
      activeRegions: regions.filter((r) => r.active).length,
      categories: categories.length,
      activeCategories: categories.filter((c) => c.active).length,
      fareRules: fareRules.length,
      pricedCategories: categories.filter((c) => c.active && priced.has(c.categoryId)).length
    }
  });
});

exports.getBusiness = handle(async (req, res) => ok(res, shapes.publicTenant(req.business)));

exports.updateSettings = handle(async (req, res) => {
  const { value, errors } = v.validateBusinessSettings(req.body);
  if (Object.keys(errors).length) return invalid(res, errors);
  try {
    const updated = await req.data.update(Tenant, {}, value);
    await audit(req, 'business.settings_updated', 'business', req.business.tenantId, { fields: Object.keys(value) });
    return ok(res, shapes.publicTenant(updated));
  } catch (e) {
    if (DUP(e)) return fail(res, 409, 'That name is already used by another business', { name: 'Already in use' });
    throw e;
  }
});

exports.setMarket = handle(async (req, res) => {
  const { value, errors } = v.validateMarket(req.body);
  if (Object.keys(errors).length) return invalid(res, errors);
  const current = req.business.market && req.business.market.country ? req.business.market : null;
  const d = req.data;
  if (current && current.country !== value.country) {
    const [regionCount, ruleCount] = await Promise.all([d.count(ServiceRegion), d.count(FareRule)]);
    if (regionCount > 0 || ruleCount > 0) {
      return fail(res, 409, 'The country cannot be changed once regions or pricing exist', { country: 'Locked while regions or pricing exist' });
    }
  }
  if (current && current.currency !== value.currency) {
    const [ruleCount, policyCount] = await Promise.all([d.count(FareRule), d.count(CancellationPolicy)]);
    if (ruleCount > 0 || policyCount > 0) {
      return fail(res, 409, 'The currency cannot be changed once pricing exists', { currency: 'Locked while pricing exists' });
    }
  }
  const updated = await d.update(Tenant, {}, { market: value });
  await audit(req, 'business.market_set', 'business', req.business.tenantId, value);
  return ok(res, shapes.publicTenant(updated));
});

// ---------- regions ----------

exports.listRegions = handle(async (req, res) => {
  const rows = await req.data.find(ServiceRegion);
  rows.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  return ok(res, rows.map(shapes.publicRegion));
});

exports.createRegions = handle(async (req, res) => {
  const market = req.business.market && req.business.market.country ? req.business.market : null;
  if (!market) return fail(res, 409, 'Choose the operating country first', { country: 'Set the country before adding regions' });
  const { value, errors } = v.validateRegionBatch(req.body);
  if (Object.keys(errors).length) return invalid(res, errors);

  const created = [];
  const skipped = [];
  for (const city of value.cities) {
    const key = v.normalizeKey(value.state, city, value.zoneName);
    if (await req.data.exists(ServiceRegion, { key })) { skipped.push(city); continue; }
    try {
      const row = await req.data.create(ServiceRegion, {
        regionId: newId('rg'), country: market.country, state: value.state, city, zoneName: value.zoneName, key,
        active: true, createdAt: new Date(), updatedAt: new Date()
      });
      created.push(row);
    } catch (e) {
      if (DUP(e)) skipped.push(city); else throw e;
    }
  }
  if (created.length === 0) return fail(res, 409, 'Those regions already exist', { cities: 'Already added' });
  await audit(req, 'region.created', 'region', created[0].regionId, { count: created.length, state: value.state });
  return ok(res, { created: created.map(shapes.publicRegion), skipped }, 201);
});

exports.updateRegion = handle(async (req, res) => {
  const { value, errors } = v.validateRegionUpdate(req.body);
  if (Object.keys(errors).length) return invalid(res, errors);
  const region = await req.data.findOne(ServiceRegion, { regionId: req.params.id });
  if (!region) return fail(res, 404, 'Region not found');

  const set = { ...value, updatedAt: new Date() };
  if (value.zoneName !== undefined) {
    set.key = v.normalizeKey(region.state, region.city, value.zoneName);
    const clash = await req.data.findOne(ServiceRegion, { key: set.key });
    if (clash && clash.regionId !== region.regionId) return fail(res, 409, 'That zone already exists for this city', { zoneName: 'Already exists' });
  }
  try {
    const updated = await req.data.update(ServiceRegion, { regionId: region.regionId }, set);
    await audit(req, value.active === false ? 'region.deactivated' : 'region.updated', 'region', region.regionId, value);
    return ok(res, shapes.publicRegion(updated));
  } catch (e) {
    if (DUP(e)) return fail(res, 409, 'That zone already exists for this city', { zoneName: 'Already exists' });
    throw e;
  }
});

// ---------- vehicle categories ----------

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

exports.listCategories = handle(async (req, res) => {
  const rows = await req.data.find(VehicleCategory);
  rows.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  return ok(res, rows.map(shapes.publicCategory));
});

exports.createCategory = handle(async (req, res) => {
  const { value, errors } = v.validateCategory(req.body);
  if (Object.keys(errors).length) return invalid(res, errors);
  const problem = await regionIdsProblem(req, value.regionIds);
  if (problem) return invalid(res, { regionIds: problem });

  const nameKey = v.normalizeKey(value.name);
  if (await req.data.exists(VehicleCategory, { nameKey })) return fail(res, 409, 'A category with this name already exists', { name: 'Already exists' });
  try {
    const row = await req.data.create(VehicleCategory, {
      categoryId: newId('vc'), ...value, nameKey, active: value.active !== false, createdAt: new Date(), updatedAt: new Date()
    });
    await audit(req, 'category.created', 'category', row.categoryId, { name: row.name });
    return ok(res, shapes.publicCategory(row), 201);
  } catch (e) {
    if (DUP(e)) return fail(res, 409, 'A category with this name already exists', { name: 'Already exists' });
    throw e;
  }
});

exports.updateCategory = handle(async (req, res) => {
  const { value, errors } = v.validateCategory(req.body, { partial: true });
  if (Object.keys(errors).length) return invalid(res, errors);
  const category = await req.data.findOne(VehicleCategory, { categoryId: req.params.id });
  if (!category) return fail(res, 404, 'Category not found');

  if (value.regionIds) {
    const problem = await regionIdsProblem(req, value.regionIds, category.regionIds || []);
    if (problem) return invalid(res, { regionIds: problem });
  }
  const set = { ...value, updatedAt: new Date() };
  if (value.name !== undefined) {
    set.nameKey = v.normalizeKey(value.name);
    const clash = await req.data.findOne(VehicleCategory, { nameKey: set.nameKey });
    if (clash && clash.categoryId !== category.categoryId) return fail(res, 409, 'A category with this name already exists', { name: 'Already exists' });
  }
  try {
    const updated = await req.data.update(VehicleCategory, { categoryId: category.categoryId }, set);
    await audit(req, value.active === false ? 'category.deactivated' : 'category.updated', 'category', category.categoryId, { fields: Object.keys(value) });
    return ok(res, shapes.publicCategory(updated));
  } catch (e) {
    if (DUP(e)) return fail(res, 409, 'A category with this name already exists', { name: 'Already exists' });
    throw e;
  }
});

// ---------- fare rules and cancellation policies ----------

/** Shared checks for fare rules and cancellation policies: market set, category and region belong to this business. */
async function resolveTarget(req, res) {
  const market = req.business.market && req.business.market.country ? req.business.market : null;
  if (!market) { fail(res, 409, 'Choose the operating country and currency first'); return null; }
  const categoryId = typeof req.body?.categoryId === 'string' ? req.body.categoryId : '';
  const regionId = req.body?.regionId ? String(req.body.regionId) : null;
  const category = categoryId ? await req.data.findOne(VehicleCategory, { categoryId }) : null;
  if (!category) { invalid(res, { categoryId: 'Choose a vehicle category' }); return null; }
  if (regionId) {
    const region = await req.data.findOne(ServiceRegion, { regionId });
    if (!region) { invalid(res, { regionId: 'Region not found' }); return null; }
    if (!(category.regionIds || []).includes(regionId)) { invalid(res, { regionId: 'This category is not available in that region' }); return null; }
  }
  return { market, category, regionId, regionKey: regionId || 'default' };
}

exports.listFareRules = handle(async (req, res) => {
  const rows = await req.data.find(FareRule);
  return ok(res, rows.map(shapes.publicFareRule));
});

exports.saveFareRule = handle(async (req, res) => {
  const target = await resolveTarget(req, res);
  if (!target) return;
  const { value, errors } = validateFareRuleInput(req.body);
  if (Object.keys(errors).length) return invalid(res, errors);

  const now = new Date();
  const rule = await req.data.update(
    FareRule,
    { categoryId: target.category.categoryId, regionKey: target.regionKey },
    { ...value, regionId: target.regionId, currency: target.market.currency, active: true, updatedAt: now },
    { upsert: true, setOnInsert: { ruleId: newId('fr'), createdAt: now } }
  );
  await audit(req, 'fare_rule.saved', 'fare_rule', rule.ruleId, { category: target.category.name, regionId: target.regionId });
  return ok(res, shapes.publicFareRule(rule));
});

exports.deleteFareRule = handle(async (req, res) => {
  const rule = await req.data.findOne(FareRule, { ruleId: req.params.id });
  if (!rule) return fail(res, 404, 'Fare rule not found');
  await req.data.remove(FareRule, { ruleId: rule.ruleId });
  await audit(req, 'fare_rule.deleted', 'fare_rule', rule.ruleId, { categoryId: rule.categoryId, regionId: rule.regionId });
  return ok(res, { id: rule.ruleId });
});

exports.previewFare = handle(async (req, res) => {
  const market = req.business.market && req.business.market.country ? req.business.market : null;
  if (!market) return fail(res, 409, 'Choose the operating country and currency first');
  const { value, errors } = validateFareRuleInput(req.body?.rule);
  const t = req.body?.trip || {};
  const trip = {};
  const tripErrors = {};
  const range = (field, label, min, max, fallback) => {
    const raw = t[field] === undefined || t[field] === '' ? fallback : Number(t[field]);
    if (!(Number.isFinite(raw) && raw >= min && raw <= max)) tripErrors[`trip.${field}`] = `${label} must be ${min} to ${max}`;
    else trip[field] = raw;
  };
  range('distanceKm', 'Distance', 0, 1000, 10);
  range('durationMin', 'Duration', 0, 1440, 20);
  range('waitingMin', 'Waiting time', 0, 240, 0);
  range('surgeMultiplier', 'Surge multiplier', 1, 10, 1);
  range('discount', 'Discount', 0, MAX_MONEY, 0);
  const all = { ...errors, ...tripErrors };
  if (Object.keys(all).length) return invalid(res, all);
  return ok(res, calculateFare(value, trip, market.currency));
});

exports.listPolicies = handle(async (req, res) => {
  const rows = await req.data.find(CancellationPolicy);
  return ok(res, rows.map(shapes.publicPolicy));
});

exports.savePolicy = handle(async (req, res) => {
  const target = await resolveTarget(req, res);
  if (!target) return;
  const { value, errors } = v.validateCancellationPolicy(req.body);
  if (Object.keys(errors).length) return invalid(res, errors);

  const now = new Date();
  const policy = await req.data.update(
    CancellationPolicy,
    { categoryId: target.category.categoryId, regionKey: target.regionKey },
    { ...value, regionId: target.regionId, currency: target.market.currency, active: true, updatedAt: now },
    { upsert: true, setOnInsert: { policyId: newId('cp'), createdAt: now } }
  );
  await audit(req, 'cancellation_policy.saved', 'cancellation_policy', policy.policyId, { category: target.category.name, regionId: target.regionId });
  return ok(res, shapes.publicPolicy(policy));
});

exports.deletePolicy = handle(async (req, res) => {
  const policy = await req.data.findOne(CancellationPolicy, { policyId: req.params.id });
  if (!policy) return fail(res, 404, 'Cancellation policy not found');
  await req.data.remove(CancellationPolicy, { policyId: policy.policyId });
  await audit(req, 'cancellation_policy.deleted', 'cancellation_policy', policy.policyId, null);
  return ok(res, { id: policy.policyId });
});

// ---------- setup ----------

exports.completeSetup = handle(async (req, res) => {
  const { setup } = await loadSetupInputs(req);
  if (!setup.ready) {
    return fail(res, 409, `Finish "${setup.nextStep.title}" before confirming setup`, { step: setup.nextStep.key });
  }
  await req.data.update(SetupProgress, {}, { completedAt: new Date(), completedBy: req.admin.adminId, updatedAt: new Date() }, { upsert: true });
  await audit(req, 'setup.completed', 'business', req.business.tenantId, null);
  const fresh = await loadSetupInputs(req);
  return ok(res, fresh.setup);
});
