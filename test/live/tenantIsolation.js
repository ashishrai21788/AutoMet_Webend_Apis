/**
 * Two businesses on one real server (real HTTP, real database engine), then every cross-business access we can think of.
 *
 *   node test/live/tenantIsolation.js              (Postgres, in process)
 *   DB_ENGINE=mongo node test/live/tenantIsolation.js
 *
 * Business A and business B each get a region, category, fare rule, cancellation policy, coupon, incentive, legal document, driver,
 * vehicle, rider, a trip with a driver penalty and a support issue. Then business B's admin, rider and driver try to read, change
 * and delete business A's things (and the other way round), with their own app id and with A's. Everything must be refused or
 * come back empty, and A's data must be unchanged afterwards. Exits 1 if anything leaks.
 */
const { start } = require('../contract/harness');

const results = [];
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `   <- ${detail}`}`); };
const short = (j) => JSON.stringify(j).slice(0, 160);

(async () => {
  const engine = process.env.DB_ENGINE || 'postgres';
  const server = await start({ engine });
  const { patch, peek } = server;
  const http = async (method, path, { body, token, app } = {}) => {
    const r = await fetch(server.base + path, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(app ? { 'X-App-Id': app } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    return { s: r.status, j: await r.json().catch(() => ({})) };
  };
  const must = (r, what, ok = [200, 201]) => { if (!ok.includes(r.s)) throw new Error(`${what}: HTTP ${r.s} ${short(r.j)}`); return r; };

  try {
    const owner = must(await http('POST', '/api/admin/auth/login', { body: { email: 'owner@contract.test', password: 'Contract-Owner-Pass-1' } }), 'owner sign-in').j.data.token;

    // ---------- two businesses ----------
    const defaultApp = must(await http('GET', '/api/admin/tenants', { token: owner }), 'tenants').j.data[0].appId;
    const madeB = must(await http('POST', '/api/admin/tenants', { token: owner, body: { name: 'Bravo Cabs', appName: 'Bravo Rides', packageName: 'com.bravo.rider', city: 'Noida', plan: 'trial', adminName: 'Bravo Admin', adminEmail: 'bravo@live.test' } }), 'create business B');
    const appB = madeB.j.data.appId;
    const appA = defaultApp;

    const adminOf = async (app, email, name, tempPassword) => {
      let tp = tempPassword;
      if (!tp) tp = must(await http('POST', '/api/admin/users', { token: owner, body: { name, email, role: 'client_admin', tenantId: app } }), 'create admin').j.data.temporaryPassword;
      const first = must(await http('POST', '/api/admin/auth/login', { body: { email, password: tp } }), 'first sign-in').j.data.token;
      return must(await http('POST', '/api/admin/auth/change-password', { token: first, body: { currentPassword: tp, newPassword: `${name.replace(/\W/g, '')}-Pass-1x` } }), 'change password').j.data.token;
    };
    const tokenA = await adminOf(appA, 'alpha@live.test', 'Alpha Admin');
    const tokenB = await adminOf(appB, 'bravo@live.test', 'Bravo Admin', madeB.j.data.initialAdmin.temporaryPassword);

    // ---------- everything business X owns ----------
    const build = async (X, app, token, c) => {
      const adm = (m, p, body) => http(m, `/api/admin/business${p}`, { token, app, body });
      must(await adm('PUT', '/market', { country: 'IN', currency: 'INR', timezone: 'Asia/Kolkata' }), `${X} market`);
      const regionId = must(await adm('POST', '/regions', { state: c.state, cities: [{ name: c.city, lat: c.lat, lng: c.lng }], zoneName: 'All areas', radiusKm: 30 }), `${X} region`).j.data.created[0].id;
      const categoryId = must(await adm('POST', '/categories', { name: `${X} Sedan`, passengerCapacity: 4, rideType: 'economy', regionIds: [regionId] }), `${X} category`).j.data.id;
      must(await adm('PUT', '/fare-rules', { categoryId, regionId, baseFare: 40, perKm: 12, perMinute: 1, minimumFare: 70, bookingFee: 5, waitingFreeMinutes: 3, waitingPerMinute: 1.5, additionalCharges: [], taxes: [], surge: { enabled: false, maxMultiplier: 1 } }), `${X} fare rule`);
      const policy = must(await adm('PUT', '/cancellation-policies', { categoryId, regionId, rider: { freeCancellationMinutes: 1, feeAfterWindow: 30, feeAfterDriverArrived: 50, noShowFee: 40 }, driver: { penaltyFee: 25, graceCancellations: 0 }, conditions: '' }), `${X} policy`).j.data;
      const now = Date.now();
      const coupon = must(await adm('POST', '/coupons', { code: `${X}COUPON`, title: `${X} coupon`, type: 'PERCENT', value: 10, maxDiscount: 20, minFare: 10, totalLimit: 5, perUserLimit: 1, startsAt: new Date(now - 3600e3).toISOString(), endsAt: new Date(now + 864e5).toISOString() }), `${X} coupon`).j.data;
      const incentive = must(await adm('POST', '/incentives', { name: `${X} bonus`, targetTrips: 3, bonus: 50, startsAt: new Date(now - 864e5).toISOString(), endsAt: new Date(now + 864e5).toISOString() }), `${X} incentive`).j.data;
      const legalDraft = must(await adm('POST', '/legal/PRIVACY_POLICY', { content: `# ${X} privacy\n\nWe collect your phone number and location to run rides for ${X}.\n\n- Phone\n- Location\n\nContact support for any question about your data and how it is used.` }), `${X} legal draft`).j.data;
      must(await adm('POST', `/legal/doc/${legalDraft.id}/publish`, {}), `${X} legal publish`);

      const drv = must(await adm('POST', '/drivers', { fullName: `${X} Driver`, phone: c.driverPhone, email: `${X}d@live.test`, dateOfBirth: '1990-04-02', address: { country: 'IN', state: c.state, city: c.city, line: '1 Main Road' }, operatingRegionId: regionId, eligibleCategoryId: categoryId }), `${X} driver`).j.data;
      const veh = must(await adm('POST', '/vehicles', { registrationNumber: c.plate, make: 'Maruti', model: 'Dzire', year: 2021, colour: 'White', categoryId, passengerCapacity: 4, luggageCapacity: 2, operatingRegionId: regionId, status: 'ACTIVE' }), `${X} vehicle`).j.data;
      must(await adm('POST', `/drivers/${drv.id}/assign-vehicle`, { vehicleId: veh.id }), `${X} assign`);
      await patch('drivers', { driverId: drv.id }, { driverVerificationStatus: 'APPROVED', accountStatus: 'ACTIVE' });
      await patch('vehicles', { vehicleId: veh.id }, { verificationStatus: 'APPROVED' });

      // the driver app
      must(await http('POST', '/api/drivers/login', { app, body: { phoneNumber: c.driverPhone, device_id: `${X}-d`, fcm_id: `${X}-d` } }), `${X} driver login`);
      const dotp = (await peek('drivers_otp', { driverId: drv.id, isUsed: false })).otp;
      const dv = must(await http('POST', '/api/otp/verify', { app, body: { driverId: drv.id, otp: dotp, device_id: `${X}-d`, fcm_id: `${X}-d` } }), `${X} driver verify`).j.data;
      const driverToken = dv.accessToken || (dv.driver && dv.driver.accessToken);
      must(await http('PUT', '/api/drivers/online-status', { app, token: driverToken, body: { driverId: drv.id, isOnline: true, onlineAs: 0 } }), `${X} online`);
      must(await http('POST', '/api/drivers/location', { app, token: driverToken, body: { driverId: drv.id, lat: c.lat, lng: c.lng, accuracy: 10 } }), `${X} location`);
      const issue = must(await http('POST', '/api/drivers/issues', { app, token: driverToken, body: { driverId: drv.id, issueText: `${X} says the map takes long to load on the trip screen` } }), `${X} issue`).j.data;

      // the rider app
      const rr = must(await http('POST', '/api/users/register', { app, body: { name: `${X} Rider`, phone: c.riderPhone, email: `${X}r@live.test` } }), `${X} rider register`).j.data;
      const userId = (rr.user && rr.user.userId) || rr.userId;
      const rotp = (await peek('users_otp', { userId, isUsed: false })).otp;
      const rv = must(await http('POST', '/api/users/verify-otp', { app, body: { userId, otp: rotp, device_id: `${X}-r`, fcm_id: `${X}-r` } }), `${X} rider verify`).j.data;
      const riderToken = rv.accessToken || (rv.user && rv.user.accessToken);

      // a trip that ends in a driver cancellation with a penalty
      const trip = must(await http('POST', '/api/v1/trips/create-request', { app, token: riderToken, body: { request_id: `${X}-req`, user_id: userId, driver_id: drv.id, pickup_address: `${c.city} A`, pickup_latitude: c.lat, pickup_longitude: c.lng, drop_address: `${c.city} B`, drop_latitude: c.lat + 0.02, drop_longitude: c.lng + 0.02, category_id: categoryId, coupon_code: `${X}COUPON` } }), `${X} booking`).j.data;
      must(await http('POST', '/api/v1/trips/driver-response', { app, token: driverToken, body: { trip_id: trip.trip_id, driver_id: drv.id, response: 'ACCEPTED' } }), `${X} accept`);
      must(await http('POST', '/api/v1/rides/driver-cancel', { app, token: driverToken, body: { trip_id: trip.trip_id, driver_id: drv.id, reason: 'Vehicle problem' } }), `${X} driver cancel`);
      return { X, app, token, regionId, categoryId, policyId: policy.id, couponId: coupon.id, couponCode: `${X}COUPON`, incentiveId: incentive.id, legalDocId: legalDraft.id,
        driverId: drv.id, vehicleId: veh.id, driverToken, userId, riderToken, tripId: trip.trip_id, issueId: issue.id || issue.issueId || (issue.issue && issue.issue.id), driverPhone: c.driverPhone, riderPhone: c.riderPhone };
    };

    const A = await build('A', appA, tokenA, { state: 'Maharashtra', city: 'Pune', lat: 18.5204, lng: 73.8567, driverPhone: '+919811110001', riderPhone: '+919811110002', plate: 'MH12AB1111' });
    const B = await build('B', appB, tokenB, { state: 'Uttar Pradesh', city: 'Noida', lat: 28.5746, lng: 77.4858, driverPhone: '+919811120001', riderPhone: '+919811120002', plate: 'UP16AB2222' });
    check('both businesses are set up with a driver, rider, trip, penalty, coupon, incentive, policy and legal text', !!(A.tripId && B.tripId && A.couponId && B.couponId && A.policyId && B.policyId));

    const ids = (r) => JSON.stringify(r.j);
    const refused = (r) => r.s >= 400 && r.s < 500;
    const emptyOrRefused = (r, id) => refused(r) || !ids(r).includes(id);
    const gone = (r) => r.s === 404 || r.s === 403;

    // ---------- 1. lists show only your own business ----------
    const lists = [['drivers', 'driverId'], ['vehicles', 'vehicleId'], ['riders', 'userId'], ['trips', 'tripId'], ['coupons', 'couponId'], ['incentives', 'incentiveId'], ['regions', 'regionId'], ['categories', 'categoryId'], ['cancellation-policies', 'policyId'], ['fare-rules', 'categoryId'], ['support/issues', 'issueId'], ['audit', 'tripId'], ['adjustments', 'driverId']];
    for (const [path, key] of lists) {
      for (const [me, other] of [[B, A], [A, B]]) {
        const r = await http('GET', `/api/admin/business/${path}?pageSize=100`, { token: me.token, app: me.app });
        const leaked = other[key] && ids(r).includes(String(other[key]));
        check(`${me.X}'s ${path} list never contains ${other.X}'s ${key}`, r.s < 500 && !leaked, `HTTP ${r.s} ${leaked ? 'LEAKED' : ''}`);
      }
    }
    for (const [me, other] of [[B, A], [A, B]]) {
      const r = await http('GET', '/api/admin/business/live-map', { token: me.token, app: me.app });
      check(`${me.X}'s live map has none of ${other.X}'s drivers`, r.s < 500 && !ids(r).includes(other.driverId), `HTTP ${r.s}`);
      const o = await http('GET', '/api/admin/business/overview', { token: me.token, app: me.app });
      check(`${me.X}'s overview is its own`, o.s < 500 && !ids(o).includes(other.driverId));
    }

    // ---------- 2. the other business's records by id: read, change, delete ----------
    const attack = [
      ['GET', `/drivers/${A.driverId}`], ['PATCH', `/drivers/${A.driverId}`, { fullName: 'Hacked' }], ['POST', `/drivers/${A.driverId}/status`, { status: 'SUSPENDED', reason: 'tenant test' }],
      ['GET', `/drivers/${A.driverId}/history`], ['GET', `/drivers/${A.driverId}/documents`],
      ['GET', `/vehicles/${A.vehicleId}`], ['PATCH', `/vehicles/${A.vehicleId}`, { colour: 'Pink' }], ['POST', `/vehicles/${A.vehicleId}/status`, { status: 'INACTIVE' }],
      ['GET', `/riders/${A.userId}`], ['POST', `/riders/${A.userId}/status`, { status: 'SUSPENDED', reason: 'tenant test' }],
      ['GET', `/trips/${A.tripId}`], ['POST', `/trips/${A.tripId}/cancel`, { reason: 'tenant test attack' }], ['POST', `/trips/${A.tripId}/waive-driver-penalty`, { reason: 'tenant test attack' }],
      ['PUT', `/coupons/${A.couponId}`, { title: 'Hacked' }], ['GET', `/coupons/${A.couponId}/redemptions`], ['PUT', `/incentives/${A.incentiveId}`, { name: 'Hacked' }],
      ['PATCH', `/regions/${A.regionId}`, { zoneName: 'Hacked' }], ['PATCH', `/categories/${A.categoryId}`, { name: 'Hacked' }],
      ['DELETE', `/cancellation-policies/${A.policyId}`], ['POST', `/cancellation-policies/history/cpc_nothing/restore`, {}],
      ['PUT', `/legal/doc/${A.legalDocId}`, { content: 'Hacked' }], ['POST', `/legal/doc/${A.legalDocId}/publish`, {}], ['DELETE', `/legal/doc/${A.legalDocId}`],
      ['GET', `/support/issues/${A.issueId}`], ['POST', `/support/issues/${A.issueId}`, { status: 'RESOLVED', note: 'tenant test' }]
    ];
    let leaks = 0; const bad = [];
    for (const [m, p, body] of attack) {
      const r = await http(m, `/api/admin/business${p}`, { token: B.token, app: B.app, body });
      if (!(refused(r) || (m === 'GET' && !ids(r).includes(A.driverId + '"') && false))) { leaks += 1; bad.push(`${m} ${p} -> ${r.s}`); }
    }
    check(`B's admin is refused on all ${attack.length} attempts to read or change A's records by id`, leaks === 0, bad.join(' | '));

    // ---------- 3. asking for another business by header or token ----------
    const spoof = await http('GET', '/api/admin/business/drivers', { token: B.token, app: A.app });
    check('B\'s admin naming A\'s app id is refused', refused(spoof) || !ids(spoof).includes(A.driverId), `HTTP ${spoof.s}`);
    const spoofWrite = await http('POST', '/api/admin/business/coupons', { token: B.token, app: A.app, body: { code: 'SPOOF', title: 'x', type: 'PERCENT', value: 5, startsAt: new Date().toISOString(), endsAt: new Date(Date.now() + 864e5).toISOString() } });
    check('B\'s admin cannot create a coupon inside A', refused(spoofWrite), `HTTP ${spoofWrite.s}`);
    const noApp = await http('GET', '/api/admin/business/drivers', { token: B.token });
    check('B\'s admin with no app id sees only B', noApp.s < 500 && !ids(noApp).includes(A.driverId), `HTTP ${noApp.s}`);

    // ---------- 4. the apps ----------
    const cross = async (label, r) => check(label, refused(r) || !ids(r).includes('"A_'), `HTTP ${r.s}`);
    const riderHist = await http('GET', `/api/v1/rides?user_id=${A.userId}`, { token: B.riderToken, app: B.app });
    check('B\'s rider cannot read A\'s rider\'s history', refused(riderHist), `HTTP ${riderHist.s}`);
    const riderDetail = await http('GET', `/api/v1/rides/details?trip_id=${A.tripId}&user_id=${A.userId}`, { token: B.riderToken, app: B.app });
    check('B\'s rider cannot open A\'s trip', refused(riderDetail), `HTTP ${riderDetail.s}`);
    const riderProfile = await http('GET', `/api/users/detail/${A.userId}`, { token: B.riderToken, app: B.app });
    check('B\'s rider cannot read A\'s rider profile', refused(riderProfile), `HTTP ${riderProfile.s}`);
    const wrongApp = await http('GET', `/api/users/detail/${B.userId}`, { token: B.riderToken, app: A.app });
    check('B\'s rider token used on A\'s app is refused', refused(wrongApp), `HTTP ${wrongApp.s}`);
    const driverWrongApp = await http('GET', '/api/drivers/profile', { token: B.driverToken, app: A.app });
    check('B\'s driver token used on A\'s app is refused', refused(driverWrongApp), `HTTP ${driverWrongApp.s}`);
    const driverRide = await http('GET', `/api/v1/rides/details?trip_id=${A.tripId}&driver_id=${A.driverId}`, { token: B.driverToken, app: B.app });
    check('B\'s driver cannot open A\'s trip', refused(driverRide), `HTTP ${driverRide.s}`);
    const driverEarn = await http('GET', '/api/v1/driver/earnings/overview?range=week', { token: B.driverToken, app: B.app });
    check('a driver\'s earnings are their own business\'s (no A trips)', driverEarn.s < 500 && !ids(driverEarn).includes(A.tripId));
    const tx = await http('GET', '/api/v1/driver/earnings/payouts/transactions?limit=50', { token: B.driverToken, app: B.app });
    check('B\'s driver ledger has no A entries', tx.s < 500 && !ids(tx).includes(A.tripId) && !ids(tx).includes('A_'));
    const cancelOther = await http('POST', '/api/v1/rides/driver-cancel', { token: B.driverToken, app: B.app, body: { trip_id: A.tripId, driver_id: B.driverId, reason: 'attack' } });
    check('B\'s driver cannot cancel A\'s trip', refused(cancelOther), `HTTP ${cancelOther.s}`);
    const tipOther = await http('POST', '/api/v1/rides/tip', { token: B.riderToken, app: B.app, body: { trip_id: A.tripId, user_id: B.userId, amount: 10 } });
    check('B\'s rider cannot tip on A\'s trip', refused(tipOther), `HTTP ${tipOther.s}`);
    const estimateA = await http('POST', '/api/v1/trips/estimate', { token: B.riderToken, app: B.app, body: { pickup_latitude: 18.5204, pickup_longitude: 73.8567, drop_latitude: 18.55, drop_longitude: 73.89, category_id: A.categoryId } });
    check('B\'s rider cannot price against A\'s category', refused(estimateA) || estimateA.j.success === false, `HTTP ${estimateA.s}`);
    const couponAcross = await http('POST', '/api/v1/trips/estimate', { token: B.riderToken, app: B.app, body: { pickup_latitude: 28.5746, pickup_longitude: 77.4858, drop_latitude: 28.6, drop_longitude: 77.5, category_id: B.categoryId, coupon_code: A.couponCode } });
    check('A\'s coupon code is not valid in B', refused(couponAcross) || !(couponAcross.j.data && couponAcross.j.data.coupon && couponAcross.j.data.coupon.applied), `HTTP ${couponAcross.s} ${short(couponAcross.j.data && couponAcross.j.data.coupon)}`);

    // ---------- 5. public config and legal text are per business ----------
    for (const [me, other] of [[A, B], [B, A]]) {
      const cfg = await http('GET', '/api/v1/public/business/config', { app: me.app });
      check(`the public config for ${me.X} names ${me.X}, not ${other.X}`, cfg.s === 200 && ids(cfg).includes(me.app) && !ids(cfg).includes(other.app), `HTTP ${cfg.s}`);
      const legal = await http('GET', '/api/v1/legal/pending', { token: me.riderToken, app: me.app });
      check(`${me.X}'s legal text mentions only ${me.X}`, legal.s < 500 && !ids(legal).includes(`for ${other.X}.`));
    }

    // ---------- 6. A's data is exactly as it was ----------
    const aDriver = await http('GET', `/api/admin/business/drivers/${A.driverId}`, { token: A.token, app: A.app });
    check('A\'s driver was not renamed, suspended or changed', aDriver.s === 200 && !ids(aDriver).includes('Hacked') && !ids(aDriver).includes('SUSPENDED'), short(aDriver.j));
    const aPolicies = await http('GET', '/api/admin/business/cancellation-policies', { token: A.token, app: A.app });
    check('A\'s cancellation policy still exists', ids(aPolicies).includes(A.policyId));
    const aLegal = await http('GET', '/api/admin/business/legal', { token: A.token, app: A.app });
    check('A\'s published legal text still exists and was not deleted', aLegal.s === 200 && ids(aLegal).includes('PRIVACY_POLICY'));
    const aTrip = await http('GET', `/api/admin/business/trips/${A.tripId}`, { token: A.token, app: A.app });
    check('A\'s trip is still cancelled by the driver, penalty intact and not waived', aTrip.s === 200 && ids(aTrip).includes('CANCELLED_BY_DRIVER') && !ids(aTrip).includes('"waived":true'), short(aTrip.j));
    const aCoupon = await http('GET', '/api/admin/business/coupons', { token: A.token, app: A.app });
    check('A\'s coupon was not edited', !ids(aCoupon).includes('Hacked') && !ids(aCoupon).includes('SPOOF'));
    const aRegion = await http('GET', '/api/admin/business/regions', { token: A.token, app: A.app });
    check('A\'s region and category were not renamed', !ids(aRegion).includes('Hacked'));

    // ---------- 7. a platform owner can still see both (the one place that is meant to cross) ----------
    const all = await http('GET', '/api/admin/tenants', { token: owner });
    check('the platform owner sees both businesses', all.s === 200 && ids(all).includes(A.app) && ids(all).includes(B.app));
  } catch (e) {
    check('the run itself', false, e.message);
  } finally {
    await server.stop();
  }
  const bad = results.filter((x) => !x).length;
  console.log(`\n${results.length - bad}/${results.length} passed`);
  process.exit(bad ? 1 : 0);
})();
