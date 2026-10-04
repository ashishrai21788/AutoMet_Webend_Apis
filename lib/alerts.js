/**
 * Things a business admin should look at, worked out from the business's own records. Pure: the controller loads the
 * records and this decides. Nothing here is invented: an alert exists only when the records show the problem, and
 * problems the platform cannot see yet (dispatch failures, payment failures) are not reported at all.
 *
 * Severity: critical = riders or drivers are affected now, warning = will become a problem soon, info = worth knowing.
 */
const DAY = 24 * 60 * 60 * 1000;
const EXPIRY_WARNING_DAYS = 30;
const REVIEW_BACKLOG_HOURS = 48;
const MAX_ITEMS = 10;

const DOC_LABEL = {
  DRIVING_LICENSE: 'Driving licence', IDENTITY: 'Identity document', ADDRESS_PROOF: 'Address proof', PROFILE_PHOTO: 'Profile photo',
  REGISTRATION_CERTIFICATE: 'Registration certificate', INSURANCE: 'Insurance', POLLUTION_CERTIFICATE: 'Pollution certificate',
  PERMIT: 'Permit', FITNESS_CERTIFICATE: 'Fitness certificate', OTHER: 'Other document'
};
const docLabel = (type) => DOC_LABEL[type] || String(type || 'Document').replace(/_/g, ' ').toLowerCase();

const driverName = (d) => [d.firstName, d.lastName].filter(Boolean).join(' ').trim() || d.name || d.phone || d.driverId;

function daysUntil(date, now) {
  return Math.ceil((new Date(date).getTime() - now.getTime()) / DAY);
}

function build({ key, severity, type, title, detail, items, count, link }) {
  return {
    id: key, severity, type, title, detail,
    count: count ?? items.length,
    items: items.slice(0, MAX_ITEMS),
    more: Math.max(0, (count ?? items.length) - MAX_ITEMS),
    link
  };
}

function computeAlerts({ tenant, regions = [], categories = [], fareRules = [], drivers = [], vehicles = [], driverDocs = [], vehicleDocs = [], assignedDriverIds = [], now = new Date() }) {
  const alerts = [];
  const activeRegions = regions.filter((r) => r.active);
  const activeRegionIds = new Set(activeRegions.map((r) => r.regionId));
  const activeCategories = categories.filter((c) => c.active);
  const pricedCategoryIds = new Set(fareRules.filter((r) => r.active).map((r) => r.categoryId));

  // ---- configuration ----
  if (regions.length > 0 && activeRegions.length === 0) {
    alerts.push(build({ key: 'config.no_active_region', severity: 'critical', type: 'REGION', title: 'No active service region', detail: 'Riders cannot book anywhere until a region is active.', items: [], count: 1, link: '/regions' }));
  }
  const noArea = activeRegions.filter((r) => !(r.center && Number.isFinite(r.center.lat) && Number.isFinite(r.radiusKm)));
  if (noArea.length) {
    alerts.push(build({
      key: 'config.region_no_area', severity: 'warning', type: 'REGION', title: 'Regions without a service area',
      detail: 'These regions have no centre point and radius, so pickups cannot be matched to them.',
      items: noArea.map((r) => ({ kind: 'region', id: r.regionId, label: `${r.city}${r.zoneName && r.zoneName !== 'All areas' ? ` · ${r.zoneName}` : ''}` })), link: '/regions'
    }));
  }
  const unpriced = activeCategories.filter((c) => !pricedCategoryIds.has(c.categoryId));
  if (unpriced.length) {
    alerts.push(build({
      key: 'config.category_no_price', severity: 'warning', type: 'PRICING', title: 'Vehicle categories without pricing',
      detail: 'Riders cannot book these until a fare rule is saved.',
      items: unpriced.map((c) => ({ kind: 'category', id: c.categoryId, label: c.name })), link: '/pricing'
    }));
  }
  const noRegion = activeCategories.filter((c) => !(c.regionIds || []).some((id) => activeRegionIds.has(id)));
  if (noRegion.length) {
    alerts.push(build({
      key: 'config.category_no_region', severity: 'warning', type: 'CATEGORY', title: 'Vehicle categories not offered in any active region',
      detail: 'These categories cannot be booked because none of their regions is active.',
      items: noRegion.map((c) => ({ kind: 'category', id: c.categoryId, label: c.name })), link: '/categories'
    }));
  }

  // ---- drivers ----
  const driverById = new Map(drivers.map((d) => [d.driverId, d]));
  const assigned = new Set(assignedDriverIds);
  const suspended = drivers.filter((d) => d.accountStatus === 'SUSPENDED');
  if (suspended.length) {
    alerts.push(build({
      key: 'drivers.suspended', severity: 'info', type: 'DRIVER', title: 'Suspended drivers', detail: 'These drivers cannot go online or receive rides.',
      items: suspended.map((d) => ({ kind: 'driver', id: d.driverId, label: driverName(d) })), link: '/drivers?accountStatus=SUSPENDED'
    }));
  }
  const noVehicle = drivers.filter((d) => d.accountStatus === 'ACTIVE' && d.driverVerificationStatus === 'APPROVED' && !assigned.has(d.driverId));
  if (noVehicle.length) {
    alerts.push(build({
      key: 'drivers.no_vehicle', severity: 'info', type: 'DRIVER', title: 'Verified drivers without a vehicle', detail: 'Assign an approved vehicle so they can take rides.',
      items: noVehicle.map((d) => ({ kind: 'driver', id: d.driverId, label: driverName(d) })), link: '/drivers'
    }));
  }

  // ---- documents ----
  const expiryItems = (docs, subjectKey, lookup, kind, labelOf) => {
    const expired = [];
    const expiring = [];
    for (const doc of docs) {
      if (!doc.expiryDate || doc.status === 'REJECTED') continue;
      const days = daysUntil(doc.expiryDate, now);
      const subject = lookup.get(doc[subjectKey]);
      if (!subject) continue;
      const item = { kind, id: doc[subjectKey], label: `${labelOf(subject)} · ${docLabel(doc.type)}`, detail: days < 0 ? `Expired ${-days} day${-days === 1 ? '' : 's'} ago` : days === 0 ? 'Expires today' : `Expires in ${days} day${days === 1 ? '' : 's'}`, days };
      if (days < 0) expired.push(item); else if (days <= EXPIRY_WARNING_DAYS) expiring.push(item);
    }
    const byDays = (a, b) => a.days - b.days;
    return { expired: expired.sort(byDays), expiring: expiring.sort(byDays) };
  };

  const vehicleById = new Map(vehicles.map((v) => [v.vehicleId, v]));
  const driverExp = expiryItems(driverDocs, 'driverId', driverById, 'driver', driverName);
  const vehicleExp = expiryItems(vehicleDocs, 'vehicleId', vehicleById, 'vehicle', (v) => v.registrationNumber);
  const strip = (items) => items.map(({ days, ...rest }) => rest);

  if (driverExp.expired.length) alerts.push(build({ key: 'docs.driver_expired', severity: 'critical', type: 'DOCUMENT', title: 'Expired driver documents', detail: 'These drivers are no longer verified until a new document is approved.', items: strip(driverExp.expired), link: '/verification' }));
  if (vehicleExp.expired.length) alerts.push(build({ key: 'docs.vehicle_expired', severity: 'critical', type: 'DOCUMENT', title: 'Expired vehicle documents', detail: 'These vehicles are no longer verified until a new document is approved.', items: strip(vehicleExp.expired), link: '/vehicles' }));
  if (driverExp.expiring.length) alerts.push(build({ key: 'docs.driver_expiring', severity: 'warning', type: 'DOCUMENT', title: `Driver documents expiring within ${EXPIRY_WARNING_DAYS} days`, detail: 'Ask these drivers to upload renewed documents.', items: strip(driverExp.expiring), link: '/verification' }));
  if (vehicleExp.expiring.length) alerts.push(build({ key: 'docs.vehicle_expiring', severity: 'warning', type: 'DOCUMENT', title: `Vehicle documents expiring within ${EXPIRY_WARNING_DAYS} days`, detail: 'Renew these documents to keep the vehicles verified.', items: strip(vehicleExp.expiring), link: '/vehicles' }));

  // ---- review backlog ----
  const waiting = [...driverDocs.map((d) => ({ ...d, subject: 'driver' })), ...vehicleDocs.map((d) => ({ ...d, subject: 'vehicle' }))].filter((d) => d.status === 'SUBMITTED');
  if (waiting.length) {
    const oldest = waiting.reduce((a, b) => (new Date(a.submittedAt) < new Date(b.submittedAt) ? a : b));
    const oldestHours = Math.floor((now.getTime() - new Date(oldest.submittedAt).getTime()) / 3600000);
    const late = waiting.filter((d) => (now.getTime() - new Date(d.submittedAt).getTime()) / 3600000 >= REVIEW_BACKLOG_HOURS);
    alerts.push(build({
      key: 'docs.awaiting_review', severity: late.length ? 'warning' : 'info', type: 'DOCUMENT',
      title: `${waiting.length} document${waiting.length === 1 ? '' : 's'} awaiting review`,
      detail: late.length ? `${late.length} waiting more than ${REVIEW_BACKLOG_HOURS} hours; the oldest has waited ${oldestHours} hours.` : `The oldest has waited ${oldestHours} hour${oldestHours === 1 ? '' : 's'}.`,
      items: [], count: waiting.length, link: '/verification'
    }));
  }

  const order = { critical: 0, warning: 1, info: 2 };
  return alerts.sort((a, b) => order[a.severity] - order[b.severity] || a.id.localeCompare(b.id));
}

const summarize = (alerts) => ({
  critical: alerts.filter((a) => a.severity === 'critical').length,
  warning: alerts.filter((a) => a.severity === 'warning').length,
  info: alerts.filter((a) => a.severity === 'info').length
});

module.exports = { computeAlerts, summarize, EXPIRY_WARNING_DAYS, REVIEW_BACKLOG_HOURS };
