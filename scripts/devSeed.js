/**
 * LOCAL DEVELOPMENT ONLY. Demo business with drivers, riders, trips, documents and audit events, loaded into the
 * in-memory database by `DEMO_DATA=1 npm run dev:fake`, so the dashboard's operations screens can be tried with data.
 * Nothing here exists anywhere real; the sign-in below is a local test value.
 */
const bcrypt = require('bcryptjs');

const DEMO_ADMIN = { email: 'owner@demo.test', password: 'Demo-Owner-123' };
const DAY = 86400000;

async function seedDemo(db) {
  const now = Date.now();
  const ago = (ms) => new Date(now - ms);
  const ahead = (days) => new Date(now + days * DAY);
  const t = 'app_demo00001';

  await db.Tenant.create({
    tenantId: t, name: 'Demo Rides', slug: 'demo-rides', appName: 'Demo Go', packageName: 'com.demo.rider', status: 'active', plan: 'standard',
    brandColor: '#0a7d5a', supportEmail: 'help@demo.test', supportPhone: '+911234567890', market: { country: 'IN', currency: 'INR', timezone: 'Asia/Kolkata' }
  });
  await db.AdminUser.create({ adminId: 'a_demo_owner', name: 'Demo Owner', email: DEMO_ADMIN.email, role: 'client_admin', tenantId: t, passwordHash: bcrypt.hashSync(DEMO_ADMIN.password, 10) });

  await db.ServiceRegion.create({ tenantId: t, regionId: 'rg_blr', country: 'IN', state: 'Karnataka', city: 'Bengaluru', zoneName: 'All areas', key: 'karnataka|bengaluru|all areas', active: true, center: { lat: 12.97, lng: 77.59 }, radiusKm: 25 });
  await db.ServiceRegion.create({ tenantId: t, regionId: 'rg_mys', country: 'IN', state: 'Karnataka', city: 'Mysuru', zoneName: 'All areas', key: 'karnataka|mysuru|all areas', active: true });
  await db.VehicleCategory.create({ tenantId: t, categoryId: 'vc_sedan', name: 'Sedan', nameKey: 'sedan', active: true, regionIds: ['rg_blr'], passengerCapacity: 4, rideType: 'economy' });
  await db.VehicleCategory.create({ tenantId: t, categoryId: 'vc_bike', name: 'Bike', nameKey: 'bike', active: true, regionIds: ['rg_blr'], passengerCapacity: 1, rideType: 'two_wheeler' });
  await db.FareRule.create({ tenantId: t, ruleId: 'fr_sedan', categoryId: 'vc_sedan', regionId: null, regionKey: 'default', currency: 'INR', baseFare: 40, perKm: 12, perMinute: 1.5, minimumFare: 60, bookingFee: 5, waitingFreeMinutes: 3, waitingPerMinute: 1, active: true });

  const drivers = [
    ['drv_demo1', 'Asha', 'Verma', { isOnline: true, accountStatus: 'ACTIVE', driverVerificationStatus: 'APPROVED', verificationExpiresAt: ahead(120), lastLocation: { type: 'Point', coordinates: [77.606, 12.975] }, locationUpdatedAt: ago(4000), locationRegionId: 'rg_blr' }],
    ['drv_demo2', 'Ravi', 'Kumar', { isOnline: true, accountStatus: 'ACTIVE', driverVerificationStatus: 'PENDING_REVIEW', lastLocation: { type: 'Point', coordinates: [77.64, 12.978] }, locationUpdatedAt: ago(4000), locationRegionId: 'rg_blr' }],
    ['drv_demo3', 'Meena', 'Iyer', { isOnline: false, accountStatus: 'SUSPENDED', driverVerificationStatus: 'APPROVED', verificationExpiresAt: ahead(60) }],
    ['drv_demo4', 'Imran', 'Shaikh', { isOnline: false, accountStatus: 'ACTIVE', driverVerificationStatus: 'APPROVED', verificationExpiresAt: ahead(90) }]
  ];
  let n = 0;
  for (const [driverId, firstName, lastName, extra] of drivers) {
    n += 1;
    await db.Driver.create({ driverId, tenantId: t, firstName, lastName, email: `${driverId}@demo.test`, phone: `+9198000000${n}0`, passwordHash: 'x', operatingRegionId: 'rg_blr', eligibleCategoryId: 'vc_sedan', ...extra });
  }
  await db.Vehicle.create({ tenantId: t, vehicleId: 'veh_demo1', registrationNumber: 'KA01AB1234', registrationKey: 'KA01AB1234', make: 'Toyota', model: 'Etios', categoryId: 'vc_sedan', passengerCapacity: 4, operatingRegionId: 'rg_blr', status: 'ACTIVE', verificationStatus: 'APPROVED', verificationExpiresAt: ahead(90) });
  await db.DriverVehicleAssignment.create({ tenantId: t, assignmentId: 'as_demo1', driverId: 'drv_demo1', vehicleId: 'veh_demo1', active: true });

  const file = { key: 'demo', mime: 'image/jpeg', size: 1 };
  await db.DriverDocument.create({ tenantId: t, docId: 'dd_demo1', driverId: 'drv_demo1', type: 'DRIVING_LICENSE', status: 'APPROVED', expiryDate: ahead(12), file, submittedAt: ago(9 * DAY) });
  await db.DriverDocument.create({ tenantId: t, docId: 'dd_demo2', driverId: 'drv_demo4', type: 'IDENTITY', status: 'APPROVED', expiryDate: ahead(-4), file, submittedAt: ago(30 * DAY) });
  await db.DriverDocument.create({ tenantId: t, docId: 'dd_demo3', driverId: 'drv_demo2', type: 'DRIVING_LICENSE', status: 'SUBMITTED', file, submittedAt: ago(3 * DAY) });

  const riders = [['usr_demo1', 'Anita', '+919100000001'], ['usr_demo2', 'Bhavna', '+919100000002'], ['usr_demo3', 'Chetan', '+919100000003']];
  for (const [userId, firstName, phone] of riders) {
    await db.User.create({ userId, tenantId: t, firstName, lastName: 'Rao', phone, email: `${userId}@demo.test`, isPhoneVerified: true, createdAt: ago((userId === 'usr_demo3' ? 20 : 2) * DAY) });
  }

  const places = [['MG Road', 12.975, 77.606], ['Indiranagar', 12.978, 77.64], ['Whitefield', 12.969, 77.75], ['Koramangala', 12.935, 77.624], ['Airport', 13.198, 77.706]];
  let i = 0;
  const trip = (status, riderId, driverId, minsAgo, extra = {}) => {
    i += 1;
    const [a, b] = [places[i % 5], places[(i + 2) % 5]];
    return db.TripDetails.create({
      trip_id: `TRIP-${1000 + i}`, request_id: `REQ-${1000 + i}`, user_id: riderId, driver_id: driverId, tenant_id: t, status,
      pickup: { address: a[0], lat: a[1], lng: a[2] }, drop: { address: b[0], lat: b[1], lng: b[2] }, fare: 120 + i * 35, currency: 'INR', fare_basis: 'ESTIMATE',
      fare_source: 'BUSINESS_RULES', payment_mode: 'CASH', region_id: 'rg_blr', category_id: 'vc_sedan', distance_km: 4 + i, estimated_duration_min: 15 + i,
      fare_breakdown: { lines: [{ key: 'base', label: 'Base fare', amount: 40 }, { key: 'distance', label: `Distance (${4 + i} km)`, amount: (4 + i) * 12 }], fees: [{ key: 'booking', label: 'Booking fee', amount: 5 }], taxes: [], total: 120 + i * 35 },
      requested_at: ago(minsAgo * 60000), timeout_at: ago(minsAgo * 60000 - 30000), ...extra
    });
  };
  await trip('ON_GOING', 'usr_demo1', 'drv_demo1', 25, { responded_at: ago(23 * 60000), driver_on_the_way_at: ago(22 * 60000), arrived_at: ago(15 * 60000), started_at: ago(12 * 60000) });
  await trip('REQUESTED', 'usr_demo2', 'drv_demo2', 1);
  await trip('COMPLETED', 'usr_demo1', 'drv_demo1', 180, { responded_at: ago(178 * 60000), arrived_at: ago(170 * 60000), started_at: ago(165 * 60000), completed_at: ago(140 * 60000) });
  await trip('COMPLETED', 'usr_demo2', 'drv_demo1', 300, { completed_at: ago(270 * 60000), started_at: ago(290 * 60000) });
  await trip('CANCELLED_BY_USER', 'usr_demo2', 'drv_demo4', 90, { cancelled_by: 'USER', cancel_stage: 'before_accept', cancellation_reason: 'Plans changed', cancelled_at: ago(88 * 60000) });
  await trip('NO_RESPONSE', 'usr_demo3', 'drv_demo2', 600);
  for (let d = 1; d <= 5; d++) await trip('COMPLETED', 'usr_demo3', 'drv_demo1', d * 1440 + 60, { completed_at: ago(d * 1440 * 60000) });
  await db.TripEvent.create({ trip_id: 'TRIP-1001', event: 'ride_request_received', created_at: ago(25 * 60000) });
  await db.TripEvent.create({ trip_id: 'TRIP-1001', event: 'ride_request_accepted', created_at: ago(23 * 60000) });

  // problems reported from the driver app, for the Support inbox
  await db.DriverIssue.create({ _id: '650000000000000000000001', driverId: 'drv_demo1', issueText: 'The app closes when I tap Accept on a ride request.', imageUrls: [], status: 'issue submitted', createdAt: ago(3 * 3600000), updatedAt: ago(3 * 3600000) });
  await db.DriverIssue.create({ _id: '650000000000000000000002', driverId: 'drv_demo2', issueText: 'My last trip fare shows less than the rider paid.\nPlease check trip TRIP-1004.', status: 'under process', adminNotes: 'Checking the fare with the rider', notes: [{ at: ago(3600000), by: DEMO_ADMIN.email, text: 'Checking the fare with the rider', status: 'under process' }], createdAt: ago(26 * 3600000), updatedAt: ago(3600000) });
  await db.DriverIssue.create({ _id: '650000000000000000000003', driverId: 'drv_demo4', issueText: 'Could not upload my insurance document.', status: 'complete', resolvedAt: ago(2 * DAY), createdAt: ago(4 * DAY), updatedAt: ago(2 * DAY) });

  await db.DriverIssue.create({ reporterType: 'rider', riderId: 'usr_demo1', tenantId: t, tripId: 'TRIP-1003', issueText: 'The driver took a longer route than the map showed.', status: 'issue submitted', createdAt: ago(40 * 60000), updatedAt: ago(40 * 60000) });
  const e = (action, targetType, targetId, actorEmail, at, meta) => db.AdminAudit.create({ tenantId: t, actorEmail, actorId: actorEmail, action, targetType, targetId, meta, at });
  await e('driver.created', 'driver', 'drv_demo1', DEMO_ADMIN.email, ago(10 * DAY));
  await e('document.reviewed', 'driver_document', 'dd_demo1', DEMO_ADMIN.email, ago(9 * DAY), { decision: 'APPROVED', number: 'KA0120250001' });
  await e('driver.status_changed', 'driver', 'drv_demo3', DEMO_ADMIN.email, ago(2 * DAY), { from: 'ACTIVE', to: 'SUSPENDED', reason: 'Repeated complaints' });
  await e('business.ride_settings_updated', 'business', t, DEMO_ADMIN.email, ago(1 * DAY), { requireEligibleDrivers: false });
}

/**
 * Pretends the demo drivers' phones are sending heartbeats: the first driver moves every few seconds, the second one
 * keeps sending until the "stale" test and then goes quiet, so the live map can be watched changing.
 */
function startDemoMovement(db, { intervalMs = 5000 } = {}) {
  const start = Date.now();
  const timer = setInterval(() => {
    const t = (Date.now() - start) / 1000;
    const a = db.Driver.rows.find((d) => d.driverId === 'drv_demo1');
    if (a) { a.lastLocation = { type: 'Point', coordinates: [77.606 + 0.01 * Math.sin(t / 20), 12.975 + 0.01 * Math.cos(t / 20)] }; a.locationUpdatedAt = new Date(); a.locationHeading = Math.round((t * 6) % 360); a.locationSpeedKph = 28; }
    const b = db.Driver.rows.find((d) => d.driverId === 'drv_demo2');
    if (b && t < 90) { b.lastLocation = { type: 'Point', coordinates: [77.64 + 0.004 * Math.cos(t / 15), 12.978 + 0.004 * Math.sin(t / 15)] }; b.locationUpdatedAt = new Date(); } // after 90 seconds this driver's location goes stale
  }, intervalMs);
  if (timer.unref) timer.unref();
}

module.exports = { seedDemo, startDemoMovement, DEMO_ADMIN };
