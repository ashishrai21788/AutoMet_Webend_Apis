// Cross-business isolation, on the real backend + Postgres (the lab). Business A = the lab's business; B = a second business "Zed Cabs".
const lab = require('./' + (process.env.LAB_FILE || 'lab.json'));
const results = [];
const U = String(Date.now()).slice(-6);
const check = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  <- ' + detail}`); };
const call = async (method, p, { body, token, appId } = {}) => {
  const r = await fetch(lab.base + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(appId ? { 'X-App-Id': appId } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const peekOtp = async (userId) => '123456'; // the project's fixed test code for the allow-listed test numbers

(async () => {
  // ---- business B = the "Zed Cabs3" business made on the first full run (its rider B is registered there)
  const tenants = (await call('GET', '/api/admin/tenants', { token: lab.owner })).body.data;
  const B = tenants.find((t) => t.name === 'Zed Cabs3').appId;
  const adminB = (await call('POST', '/api/admin/auth/login', { body: { email: 'zed3@lab.test', password: 'Zed-Admin-Pass-1' } })).body.data.token;
  const bizB = (m, p, b2) => call(m, p, { body: b2, token: adminB, appId: B });
  const regB = (await bizB('GET', '/api/admin/business/regions')).body.data[0].id;
  const catB = (await bizB('GET', '/api/admin/business/categories')).body.data[0].id;
  const drvB = (await bizB('GET', '/api/admin/business/drivers')).body.data.items[0].id;
  check('business B (Zed Cabs3) is set up with its own admin, region, category and driver', !!(B && adminB && regB && catB && drvB));

  // ---- riders: one in each business (a rider registers into the business named by X-App-Id)
  const rider = async (appId, phone, name) => {
    const reg = await call('POST', '/api/users/register', { body: { name, phone, email: `${phone}@lab.test` }, appId });
    let userId = reg.body.data && reg.body.data.user && reg.body.data.user.userId;
    const lg = await call('POST', '/api/users/login', { body: { phoneNumber: phone }, appId });
    if (!userId) userId = lg.body.data && lg.body.data.user && lg.body.data.user.userId; // already registered on an earlier run
    const code = (lg.body.data && lg.body.data.otp && lg.body.data.otp.otp) || '123456';
    const ver = await call('POST', '/api/users/verify-otp', { body: { userId, otp: code, device_id: 'd-' + phone, fcm_id: 'f-' + phone }, appId });
    const token = ver.body.data && (ver.body.data.accessToken || (ver.body.data.user && ver.body.data.user.accessToken));
    return { userId, token, status: [reg.status, lg.status, ver.status] };
  };
  const rA = await rider(lab.appId, '9876543210', 'Rider A');
  const rB = await rider(B, '1234567891', 'Rider B');
  check('a rider signs in to each business', !!(rA.token && rB.token), JSON.stringify([rA.status, rB.status]));

  // ---- pricing: each rider is priced by their own business, whatever App ID the request carries
  const noida = { pickup_latitude: 28.5746, pickup_longitude: 77.4858, drop_latitude: 28.6, drop_longitude: 77.5 };
  const pune = { pickup_latitude: 18.5314, pickup_longitude: 73.8446, drop_latitude: 18.5912, drop_longitude: 73.7389 };
  const estA = await call('POST', '/api/v1/trips/estimate', { body: { ...noida, category_id: lab.categoryId }, token: rA.token, appId: lab.appId });
  check('rider A is priced by business A in A\'s own area', estA.status === 200, JSON.stringify(estA.body).slice(0, 160));
  const estAinB = await call('POST', '/api/v1/trips/estimate', { body: pune, token: rA.token, appId: lab.appId });
  check('rider A cannot get a quote in business B\'s area (Pune)', estAinB.status !== 200, `status ${estAinB.status}`);
  const estAHeaderB = await call('POST', '/api/v1/trips/estimate', { body: pune, token: rA.token, appId: B });
  check('rider A naming business B in X-App-Id still gets no Pune quote from B\'s rules', estAHeaderB.status !== 200 || !/999/.test(JSON.stringify(estAHeaderB.body)), JSON.stringify(estAHeaderB.body).slice(0, 200));
  const estB = await call('POST', '/api/v1/trips/estimate', { body: { ...pune, category_id: catB }, token: rB.token, appId: B });
  check('rider B is priced by business B in B\'s area', estB.status === 200 && /999/.test(JSON.stringify(estB.body)), JSON.stringify(estB.body).slice(0, 200));

  // ---- ride options and nearby drivers carry only the rider's own business's categories
  const optA = await call('POST', '/api/v1/trips/ride-options', { body: noida, token: rA.token, appId: lab.appId });
  check('A\'s ride options never mention B\'s category', !/Zed Sedan/.test(JSON.stringify(optA.body)), JSON.stringify(optA.body).slice(0, 200));
  const optB = await call('POST', '/api/v1/trips/ride-options', { body: pune, token: rB.token, appId: B });
  check('B\'s ride options never mention A\'s category (VIP)', !/VIP/.test(JSON.stringify(optB.body)), JSON.stringify(optB.body).slice(0, 200));

  // ---- a rider cannot book B's driver, and cannot read or cancel B's records
  const tripBody = (uid, drv) => ({ request_id: 'lab-x-' + Math.random(), user_id: uid, driver_id: drv, pickup_address: 'P', pickup_latitude: 28.5746, pickup_longitude: 77.4858, drop_address: 'D', drop_latitude: 28.6, drop_longitude: 77.5 });
  const cross = await call('POST', '/api/v1/trips/create-request', { body: tripBody(rA.userId, drvB), token: rA.token, appId: lab.appId });
  check('rider A cannot book business B\'s driver', cross.status >= 400 && cross.status < 500, `status ${cross.status} ${JSON.stringify(cross.body).slice(0, 160)}`);

  const profB = await call('GET', `/api/users/detail/${rB.userId}`, { token: rA.token, appId: lab.appId });
  check('rider A cannot read rider B\'s profile', profB.status === 403, `status ${profB.status}`);
  const histB = await call('GET', `/api/v1/rides/history?user_id=${rB.userId}`, { token: rA.token, appId: lab.appId });
  check('rider A cannot list rider B\'s trips', histB.status === 403 || (histB.body.data || []).length === 0, `status ${histB.status}`);
  const delB = await call('POST', '/api/users/account/delete', { body: { userId: rB.userId }, token: rA.token, appId: lab.appId });
  check('rider A cannot delete rider B\'s account', delB.status === 403, `status ${delB.status}`);
  const editB = await call('PUT', '/api/users/profile', { body: { userId: rB.userId, firstName: 'Hacked' }, token: rA.token, appId: lab.appId });
  check('rider A cannot edit rider B\'s profile', editB.status === 403, `status ${editB.status}`);
  const notiB = await call('GET', `/api/users/notifications?userId=${rB.userId}`, { token: rA.token, appId: lab.appId });
  check('rider A asking for B\'s notifications only gets their own', notiB.status === 200 && (notiB.body.data.notifications || []).every((n) => !n.userId || n.userId === rA.userId), JSON.stringify(notiB.body).slice(0, 160));

  // ---- the dashboards: each business admin sees only their own people and records
  const ridersA = await call('GET', '/api/admin/business/riders', { token: lab.admin, appId: lab.appId });
  const namesA = JSON.stringify(ridersA.body);
  check('business A\'s admin does not see rider B', ridersA.status < 500 && !/Rider B/.test(namesA), `status ${ridersA.status}`);
  const driversA = await call('GET', '/api/admin/business/drivers', { token: lab.admin, appId: lab.appId });
  check('business A\'s admin does not see B\'s driver', !/Zed Driver/.test(JSON.stringify(driversA.body)));
  const driversB = await call('GET', '/api/admin/business/drivers', { token: adminB, appId: B });
  check('business B\'s admin does not see A\'s driver', !/Test Onboarding/.test(JSON.stringify(driversB.body)));
  const adminAasB = await call('GET', '/api/admin/business/drivers', { token: lab.admin, appId: B });
  check('A\'s admin naming business B in the header is refused or sees nothing of B', adminAasB.status >= 400 || !/Zed Driver/.test(JSON.stringify(adminAasB.body)), `status ${adminAasB.status} ${JSON.stringify(adminAasB.body).slice(0, 160)}`);
  const catsAasB = await call('GET', '/api/admin/business/categories', { token: lab.admin, appId: B });
  check('A\'s admin cannot read B\'s categories by naming B', catsAasB.status >= 400 || !/Zed Sedan/.test(JSON.stringify(catsAasB.body)), `status ${catsAasB.status}`);
  const writeAasB = await call('PUT', '/api/admin/business/fare-rules', { body: { categoryId: catB, regionId: regB, baseFare: 1, perKm: 1, perMinute: 1, minimumFare: 1, bookingFee: 0, waitingFreeMinutes: 1, waitingPerMinute: 1 }, token: lab.admin, appId: B });
  check('A\'s admin cannot change B\'s fares by naming B', writeAasB.status >= 400, `status ${writeAasB.status}`);
  const estAfter = await call('POST', '/api/v1/trips/estimate', { body: { ...pune, category_id: catB }, token: rB.token, appId: B });
  check('B\'s fares are unchanged after A\'s admin tried to change them', /999/.test(JSON.stringify(estAfter.body)), JSON.stringify(estAfter.body).slice(0, 160));

  // ---- public config is per business
  const cfgA = await call('GET', '/api/v1/public/business/config', { appId: lab.appId });
  const cfgB = await call('GET', '/api/v1/public/business/config', { appId: B });
  check('each business\'s public config carries its own name', /uRide|AutoMet|app_/i.test(JSON.stringify(cfgA.body)) && /Zed/.test(JSON.stringify(cfgB.body)) && !/Zed/.test(JSON.stringify(cfgA.body)), JSON.stringify(cfgB.body).slice(0, 160));

  const fails = results.filter((r) => !r.ok);
  console.log(`\n${results.length - fails.length}/${results.length} passed`);
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error('ERROR', e.message); process.exit(2); });
