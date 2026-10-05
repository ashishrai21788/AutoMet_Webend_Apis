/**
 * The rider (user) app's account flow: public business config, register, OTP verify, login, profile, token, notifications,
 * logout. Every request here is one the Android user app really makes (see docs/POSTGRES_ENGINE.md).
 */
module.exports = async function rider({ call, peek, seed, alias }) {
  await call('public config: default business', { path: '/api/v1/public/business/config', expectStatus: 200 });
  await call('public config: unknown App ID', { path: '/api/v1/public/business/config', headers: { 'X-App-Id': 'app_does_not_exist' } });

  await call('register: missing fields', { method: 'POST', path: '/api/users/register', body: { name: 'Rae' }, expectStatus: 400 });
  const reg = await call('register', { method: 'POST', path: '/api/users/register', body: { name: 'Rae Rider', phone: '+919800000001', email: 'Rae@Contract.test' }, expectStatus: 201 });
  const userId = reg.body.data.user.userId;
  alias(userId, 'userId'); // generated per run
  await call('register: phone already used', { method: 'POST', path: '/api/users/register', body: { name: 'Other Person', phone: '+919800000001' }, expectStatus: 400 });
  await call('register: email already used', { method: 'POST', path: '/api/users/register', body: { name: 'Other Person', phone: '+919800000002', email: 'rae@contract.test' }, expectStatus: 400 });

  await call('verify-otp: missing fields', { method: 'POST', path: '/api/users/verify-otp', body: { userId }, expectStatus: 400 });
  await call('verify-otp: wrong code', { method: 'POST', path: '/api/users/verify-otp', body: { userId, otp: '000000' }, expectStatus: 400 });
  const otp1 = (await peek('users_otp', { userId, isUsed: false })).otp;
  alias(otp1, 'otp1');
  const ver = await call('verify-otp', { method: 'POST', path: '/api/users/verify-otp', body: { userId, otp: otp1, device_id: 'device-1', fcm_id: 'fcm-token-1' }, expectStatus: 200 });
  const token = ver.body.data.accessToken || (ver.body.data.user && ver.body.data.user.accessToken);
  await call('verify-otp: the same code twice', { method: 'POST', path: '/api/users/verify-otp', body: { userId, otp: otp1 }, expectStatus: 400 });

  await call('login: missing phone', { method: 'POST', path: '/api/users/login', body: {}, expectStatus: 400 });
  await call('login: unknown phone', { method: 'POST', path: '/api/users/login', body: { phoneNumber: '+919899999999' }, expectStatus: 404 });
  await call('login', { method: 'POST', path: '/api/users/login', body: { phoneNumber: '+919800000001' }, expectStatus: 200 });
  const otp2 = (await peek('users_otp', { userId, isUsed: false })).otp;
  alias(otp2, 'otp2');
  await call('resend-otp: missing userId', { method: 'POST', path: '/api/users/resend-otp', body: { phoneNumber: '+919800000001' }, expectStatus: 400 });
  await call('resend-otp: unknown user', { method: 'POST', path: '/api/users/resend-otp', body: { userId: 'U_does_not_exist' }, expectStatus: 404 });
  await call('resend-otp', { method: 'POST', path: '/api/users/resend-otp', body: { userId }, expectStatus: 200 });
  const otp3 = (await peek('users_otp', { userId, isUsed: false })).otp;
  alias(otp3, 'otp3');
  const ver2 = await call('verify-otp: login', { method: 'POST', path: '/api/users/verify-otp', body: { userId, otp: otp3 || otp2, device_id: 'device-1', fcm_id: 'fcm-token-2' }, expectStatus: 200 });
  const token2 = ver2.body.data.accessToken || (ver2.body.data.user && ver2.body.data.user.accessToken) || token;

  await call('detail: by userId', { path: `/api/users/detail/${userId}`, expectStatus: 200 });
  await call('detail: unknown userId', { path: '/api/users/detail/U_does_not_exist' });

  await call('profile: no token', { method: 'PUT', path: '/api/users/profile', body: { userId, firstName: 'Raye' }, expectStatus: 401 });
  await call('profile: missing userId', { method: 'PUT', path: '/api/users/profile', body: { firstName: 'Raye' }, token: token2, expectStatus: 400 });
  await call('profile: empty first name', { method: 'PUT', path: '/api/users/profile', body: { userId, firstName: '  ' }, token: token2, expectStatus: 400 });
  await call('profile: update', { method: 'PUT', path: '/api/users/profile', body: { userId, firstName: 'Raye', lastName: 'Rider-Lee' }, token: token2, expectStatus: 200 });
  await call('detail: after update', { path: `/api/users/detail/${userId}`, expectStatus: 200 });

  await call('update-token: missing fields', { method: 'POST', path: '/api/users/update-token', body: { userId }, token: token2, expectStatus: 400 });
  await call('update-token', { method: 'POST', path: '/api/users/update-token', body: { userId, fcm_id: 'fcm-token-3', device_id: 'device-2' }, token: token2, expectStatus: 200 });

  // notifications are created by outside events (ride updates, support), so the scenario seeds two directly
  const first = await seed('users_notification', { userId, title: 'Welcome', description: 'Thanks for joining', date: '2026-10-01', isUnread: true, type: 'Informational', notification_id: 'n-1', createdAt: new Date('2026-10-01T10:00:00Z') });
  await seed('users_notification', { userId, title: 'Your ride', description: 'A driver is on the way', date: '2026-10-02', isUnread: true, type: 'Ride', notification_id: 'n-2', createdAt: new Date('2026-10-02T10:00:00Z') });
  await call('notifications: no token', { path: `/api/users/notifications?userId=${userId}`, expectStatus: 401 });
  await call('notifications: list', { path: `/api/users/notifications?userId=${userId}`, token: token2, expectStatus: 200 });
  await call('notifications: mark-read, missing ids', { method: 'PUT', path: '/api/users/notifications/mark-read', body: { userId }, token: token2, expectStatus: 400 });
  await call('notifications: mark-read, bad id format', { method: 'PUT', path: '/api/users/notifications/mark-read', body: { userId, notificationIds: ['n-1'] }, token: token2, expectStatus: 400 });
  await call('notifications: mark-read', { method: 'PUT', path: '/api/users/notifications/mark-read', body: { userId, notificationIds: [String(first.insertedId)] }, token: token2, expectStatus: 200 });
  await call('notifications: list after read', { path: `/api/users/notifications?userId=${userId}`, token: token2, expectStatus: 200 });
  await call('notifications: delete, missing id', { path: `/api/users/notifications/delete?userId=${userId}`, token: token2, expectStatus: 400 });
  await call('notifications: delete', { path: `/api/users/notifications/delete?userId=${userId}&notificationId=${first.insertedId}`, token: token2 });
  await call('notifications: list after delete', { path: `/api/users/notifications?userId=${userId}`, token: token2, expectStatus: 200 });

  await call('logout: no token', { method: 'POST', path: '/api/users/logout', body: { userId }, expectStatus: 401 });
  await call('logout', { method: 'POST', path: '/api/users/logout', body: { userId }, token: token2, expectStatus: 200 });
  await call('after logout: profile with the old token', { method: 'PUT', path: '/api/users/profile', body: { userId, firstName: 'Again' }, token: token2 });
};
