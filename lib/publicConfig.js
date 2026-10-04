const crypto = require('crypto');

/**
 * What a rider or driver app may know about its business. Everything here is safe to show to anyone who has the app:
 * no admin data, no document or verification rules, no fare amounts (fares come from the fare estimate, which is
 * calculated on the server), no team and no counts.
 *
 * `version` changes whenever anything in the response changes, so an app can keep its copy until the version moves
 * (the route also answers a matching If-None-Match with 304).
 */
function buildPublicConfig({ tenant, regions = [], categories = [], pricedCategoryIds = new Set(), resolvedBy = 'header' }) {
  const activeRegions = regions.filter((r) => r.active);
  const activeRegionIds = new Set(activeRegions.map((r) => r.regionId));

  const config = {
    appId: tenant.tenantId,
    resolvedBy, // 'header' when the app named its business, 'default' when it did not (an app that sends no App ID)
    business: {
      name: tenant.name,
      appName: tenant.appName,
      brandColor: tenant.brandColor || '#f5a300',
      logoUrl: tenant.logoUrl || '',
      supportEmail: tenant.supportEmail || '',
      supportPhone: tenant.supportPhone || ''
    },
    market: tenant.market && tenant.market.country
      ? { country: tenant.market.country, currency: tenant.market.currency, timezone: tenant.market.timezone }
      : null,
    regions: activeRegions
      .map((r) => ({
        regionId: r.regionId,
        city: r.city,
        state: r.state,
        zoneName: r.zoneName,
        center: r.center && Number.isFinite(r.center.lat) && Number.isFinite(r.center.lng) ? { lat: r.center.lat, lng: r.center.lng } : null,
        radiusKm: Number.isFinite(r.radiusKm) ? r.radiusKm : null
      }))
      .sort((a, b) => `${a.city}|${a.zoneName}`.localeCompare(`${b.city}|${b.zoneName}`)),
    vehicleCategories: categories
      .filter((c) => c.active)
      .map((c) => ({
        categoryId: c.categoryId,
        name: c.name,
        description: c.description || '',
        rideType: c.rideType,
        icon: c.icon || 'car',
        imageUrl: c.imageUrl || '',
        passengerCapacity: c.passengerCapacity,
        luggageCapacity: c.luggageCapacity ?? null,
        // only regions that are still active; a category with none left cannot be booked anywhere
        regionIds: (c.regionIds || []).filter((id) => activeRegionIds.has(id)),
        // false means the business has not set a price for it, so the app should not offer it yet
        bookable: pricedCategoryIds.has(c.categoryId)
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    rideSettings: {
      // drivers must be verified and have an approved vehicle before they can take rides (lets the driver app explain why it refuses to go online)
      requireEligibleDrivers: !!(tenant.rideSettings && tenant.rideSettings.requireEligibleDrivers)
    }
  };
  config.vehicleCategories.forEach((c) => { c.bookable = c.bookable && c.regionIds.length > 0; });
  config.serviceAvailable = config.regions.length > 0 && config.vehicleCategories.some((c) => c.bookable);

  const version = crypto.createHash('sha1').update(JSON.stringify(config)).digest('hex').slice(0, 16);
  return { ...config, version };
}

module.exports = { buildPublicConfig };
