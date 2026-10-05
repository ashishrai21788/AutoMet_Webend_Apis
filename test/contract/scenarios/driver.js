/**
 * The driver app: sign-in (login, OTP), profile, fields, vehicle details, online status, location heartbeat, notifications,
 * issue reports, analytics, FAQs and logout, plus what the driver app's old generic routes now answer.
 * The driver exists because the dashboard created it (driver self sign-up is closed: POST /api/drivers answers 403).
 */
const { configuredBusiness, driverSignIn } = require('./common');

module.exports = async function driver(t) {
  const { call, peek, seed, alias } = t;
  const ctx = await configuredBusiness(t);
  const { driverId } = ctx;

  await call('login: missing phone', { method: 'POST', path: '/api/drivers/login', body: {}, expectStatus: 400 });
  await call('login: unknown phone', { method: 'POST', path: '/api/drivers/login', body: { phoneNumber: '+919899999999' }, expectStatus: 404 });
  await call('self sign-up is closed', { method: 'POST', path: '/api/drivers', body: { fullName: 'New Person', phone: '+919822222222' }, expectStatus: 403 });
  await call('generic read of all drivers is closed', { path: '/api/drivers', expectStatus: 403 });
  await call('generic read of one driver is closed', { path: `/api/drivers/${driverId}`, expectStatus: 403 });

  await call('otp: verify with missing fields', { method: 'POST', path: '/api/otp/verify', body: { driverId }, expectStatus: 400 });
  const token = await driverSignIn(t, { driverId, phone: ctx.driverPhone });
  await call('otp: the same code twice', { method: 'POST', path: '/api/otp/verify', body: { driverId, otp: '000000' }, expectStatus: 400 });
  await call('otp: resend, missing driverId', { method: 'POST', path: '/api/otp/resend', body: {}, expectStatus: 400 });
  await call('otp: resend', { method: 'POST', path: '/api/otp/resend', body: { driverId } });
  await call('otp: update-token without a session', { method: 'POST', path: '/api/otp/update-token', body: { driverId, fcm_id: 'driver-fcm-2' }, expectStatus: 401 });
  await call('otp: update-token', { method: 'POST', path: '/api/otp/update-token', body: { driverId, fcm_id: 'driver-fcm-2', device_id: 'driver-device-2' }, token });

  await call('profile: no session', { path: '/api/drivers/profile', expectStatus: 401 });
  await call('profile', { path: '/api/drivers/profile', token, expectStatus: 200 });
  await call('profile: update, missing driverId', { method: 'PUT', path: '/api/drivers/profile', body: { firstName: 'Deepa' }, token });
  await call('profile: update', { method: 'PUT', path: '/api/drivers/profile', body: { driverId, firstName: 'Deepa', lastName: 'Driver-Rao' }, token });
  await call('profile: another driver id is refused', { method: 'PUT', path: '/api/drivers/profile', body: { driverId: '9999999999', firstName: 'X' }, token });
  await call('update fields: nothing to update', { method: 'PUT', path: '/api/drivers/update', body: { driverId }, token, expectStatus: 400 });
  await call('update fields', { method: 'POST', path: '/api/drivers/update', body: { driverId, gender: 'female', emergencyContactName: 'Asha' }, token });
  await call('profile: after the updates', { path: '/api/drivers/profile', token, expectStatus: 200 });
  await call('status of a driver', { path: `/api/drivers/status/${driverId}`, expectStatus: 200 });

  await call('vehicle details: read', { path: `/api/drivers/${driverId}/vehicle-details` });
  await call('vehicle details: missing driverId', { method: 'PUT', path: '/api/drivers/vehicle-details', body: {}, token, expectStatus: 400 });
  await call('vehicle details: update', { method: 'PUT', path: '/api/drivers/vehicle-details', body: { driverId, vehicleType: 'Sedan', vehicleNumber: 'MH12AB1234', vehicleModel: 'Dzire', vehicleColor: 'White', vehicleManufacturingYear: '2021', fuleType: 'Petrol', seatingCapacity: 4, isVehicleAdded: true }, token });
  await call('vehicle details: read after the update', { path: `/api/drivers/${driverId}/vehicle-details` });

  await call('online: invalid onlineAs', { method: 'PUT', path: '/api/drivers/online-status', body: { driverId, isOnline: true, onlineAs: 'driver' }, token, expectStatus: 400 });
  await call('online: go online', { method: 'PUT', path: '/api/drivers/online-status', body: { driverId, isOnline: true, onlineAs: 0 }, token });
  await call('location: bad coordinates', { method: 'POST', path: '/api/drivers/location', body: { driverId, lat: 95, lng: 73.85 }, token });
  await call('location: heartbeat', { method: 'POST', path: '/api/drivers/location', body: { driverId, lat: 18.5204, lng: 73.8567, accuracy: 12, heading: 90, speed: 5 }, token });
  await call('status of a driver: online', { path: `/api/drivers/status/${driverId}`, expectStatus: 200 });

  await seed('driver_notification', { driverId, title: 'New ride area', description: 'Demand is high in Pune', date: '2026-10-01', isUnread: true, type: 'Informational', notification_id: 'dn-1', createdAt: new Date('2026-10-01T10:00:00Z') });
  const second = await seed('driver_notification', { driverId, title: 'Payout', description: 'Weekly summary', date: '2026-10-02', isUnread: true, type: 'Informational', notification_id: 'dn-2', createdAt: new Date('2026-10-02T10:00:00Z') });
  await call('notifications: no session', { path: `/api/drivers/notifications?driverId=${driverId}`, expectStatus: 401 });
  await call('notifications: list', { path: `/api/drivers/notifications?driverId=${driverId}`, token });
  await call('notifications: mark-read, missing ids', { method: 'PUT', path: '/api/drivers/notifications/mark-read', body: { driverId }, token });
  await call('notifications: mark-read', { method: 'PUT', path: '/api/drivers/notifications/mark-read', body: { driverId, notificationIds: [String(second.insertedId)] }, token });
  await call('notifications: mark all read', { path: `/api/drivers/notifications/mark-all-read?driverId=${driverId}`, token });
  await call('notifications: list after reading', { path: `/api/drivers/notifications?driverId=${driverId}`, token });
  await call('notifications: delete', { path: `/api/drivers/notifications/delete?driverId=${driverId}&notificationId=${second.insertedId}`, token });
  await call('notifications: list after delete', { path: `/api/drivers/notifications?driverId=${driverId}`, token });

  await call('faqs', { path: '/api/drivers/faqs' });
  await call('issue: no session', { method: 'POST', path: '/api/drivers/issues', body: { driverId, issueText: 'App crashes' }, expectStatus: 401 });
  await call('issue: submit', { method: 'POST', path: '/api/drivers/issues', body: { driverId, issueText: 'The app closes when I accept a ride', imageUrls: [] }, token });
  await call('issue: list my own', { path: `/api/drivers/${driverId}/issues`, token });
  await call('issue: cannot change status from the app', { method: 'PUT', path: '/api/drivers/issues/anything', body: { status: 'complete' }, token, expectStatus: 403 });

  // rider-app analytics events that mention this driver, then the driver's own analytics summary (an aggregation)
  const now = new Date().toISOString();
  await call('analytics: rider app saves events', {
    method: 'POST', path: '/api/user-app-analytics',
    body: { deviceId: 'rider-device-1', sessionId: 'session-1', platform: 'android', events: [
      { eventName: 'visible_driver_snapshot', timestamp: now, params: { driver_ids: [driverId] } },
      { eventName: 'driver_marker_tapped', timestamp: now, params: { driver_id: driverId } },
      { eventName: 'driver_call_tapped', timestamp: now, params: { driver_id: driverId } },
      { eventName: 'driver-info-card-viewed', timestamp: now, params: { driver_id: driverId } }
    ] }
  });
  await call('analytics: empty body', { method: 'POST', path: '/api/user-app-analytics', body: {}, expectStatus: 400 });
  await call('analytics: driver summary', { path: `/api/drivers/${driverId}/analytics` });
  await call('analytics: driver app saves its own events', { method: 'POST', path: '/api/driver-app-analytics', body: { deviceId: 'driver-device-1', events: [{ eventName: 'app_opened', timestamp: now, params: {} }] } });

  await call('collections not open to the app: admin users', { path: '/api/admin_users', expectStatus: 403 });
  await call('go offline', { method: 'PUT', path: '/api/drivers/online-status', body: { driverId, isOnline: false, onlineAs: 0 }, token });
  await call('logout: no session', { method: 'POST', path: '/api/drivers/logout', body: { driverId }, expectStatus: 401 });
  await call('logout', { method: 'POST', path: '/api/drivers/logout', body: { driverId }, token });
  await call('after logout: the old session', { path: '/api/drivers/profile', token });
  alias(String(driverId), 'driverId');
};
