/**
 * Weather pricing in the admin dashboard (Pricing). See lib/weather.js for how it works and what protects riders.
 *
 *   GET /api/admin/business/weather-pricing   { enabled, multipliers, maxMultiplier, conditions, ... }
 *   PUT /api/admin/business/weather-pricing   { enabled, multipliers: { HEAVY_RAIN: 1.3, ... }, maxMultiplier }
 *
 * It is off until a business turns it on, it only takes effect on fare rules that have surge switched on, and the rule's own maximum
 * still caps demand surge and weather together. Every change is audited and recorded in the settings history.
 */
const { Tenant, AdminAudit } = require('../models/adminModels');
const { clearAppTenantCache } = require('../lib/appTenant');
const weather = require('../lib/weather');
const configHistory = require('./configHistoryController');
const c = require('./fleet/common');

const HINTS = {
  LIGHT_RAIN: 'Any measurable rain up to heavy rain',
  HEAVY_RAIN: '7.6 mm or more in the last hour',
  STORM: 'Thunderstorms',
  FOG: 'Fog or rime fog',
  SNOW: 'Snow or snow showers',
  EXTREME_HEAT: '42 degrees C or hotter'
};

const shape = (tenant) => {
  const r = weather.rulesOf(tenant);
  return {
    enabled: r.enabled,
    maxMultiplier: r.maxMultiplier,
    multipliers: Object.fromEntries(weather.CONDITIONS.map((k) => [k, r.multipliers[k] || 1])),
    conditions: weather.CONDITIONS.map((key) => ({ key, label: weather.LABELS[key], hint: HINTS[key] })),
    notes: [
      'Weather pricing only applies to fare rules that have surge switched on, and the rule\'s own maximum caps demand surge and weather together.',
      'Riders see the weather as its own line in the estimate before they book, and are never charged more than the estimate they were shown.',
      'If the weather cannot be read, no adjustment is made.'
    ]
  };
};

exports.get = c.handle(async (req, res) => c.ok(res, shape(req.business)));

exports.update = c.handle(async (req, res) => {
  const { value, errors } = weather.validateSettings(req.body);
  if (Object.keys(errors).length) return c.invalid(res, errors);
  await req.data.update(Tenant, {}, { weatherPricing: value });
  clearAppTenantCache();
  weather.clearWeatherCache();
  await configHistory.track(req, 'business.weather_pricing_updated', { weatherPricing: value });
  try {
    await AdminAudit.create({
      tenantId: req.business.tenantId, actorId: req.admin.adminId, actorEmail: req.admin.email, action: 'weather_pricing.updated', targetType: 'business',
      targetId: req.business.tenantId, meta: { enabled: value.enabled, multipliers: value.multipliers, maxMultiplier: value.maxMultiplier }, ip: req.ip || null
    });
  } catch (e) { console.warn('[weather] audit write failed:', e.message); }
  return c.ok(res, shape({ weatherPricing: value }));
});
