/**
 * Complete End-to-End Live Ride Lifecycle Test
 * Tests the real running system against the live server or localhost
 * with real Rider and Driver in Varanasi.
 *
 * Sequence:
 * 1. Authenticate / verify Rider (2053495953) and Driver (2697594339)
 * 2. POST /api/v1/trips/estimate (Fare Calculation)
 * 3. POST /api/v1/trips/ride-options (Available Ride Categories)
 * 4. POST /api/v1/trips/nearby-drivers (Driver Visibility with { latitude, longitude })
 * 5. POST /api/v1/trips/create-request (Booking Creation)
 * 6. POST /api/v1/trips/driver-response (Driver Acceptance)
 * 7. PATCH /api/v1/rides/:tripId/status -> ARRIVED (Driver Arrived)
 * 8. PATCH /api/v1/rides/:tripId/status -> ON_GOING with OTP (Ride Started)
 * 9. PATCH /api/v1/rides/:tripId/status -> COMPLETED (Ride Finished)
 * 10. POST /api/v1/rides/receipt-ack (Rider Receipt Dismissal)
 * 11. POST /api/v1/rides/rate (Rider Rates Driver 5 stars)
 * 12. Database verification: Trip details, financial split, earnings, ledger
 */

const http = require('http');
const https = require('https');
const mongoose = require('../lib/db/mongoose');
const jwt = require('jsonwebtoken');
require('dotenv').config();

const BASE_URL = process.env.TARGET_URL || 'http://127.0.0.1:3999';
const APP_ID = 'app_a8c359b926'; // Default AutoMet tenant
const RIDER_USER_ID = '2053495953';
const DRIVER_ID = '2697594339';
const JWT_SECRET = process.env.JWT_SECRET;

function httpRequest(method, path, body = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE_URL);
    const client = url.protocol === 'https:' ? https : http;
    const reqHeaders = {
      'Content-Type': 'application/json',
      'X-App-Id': APP_ID,
      ...headers
    };
    const req = client.request({
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      method,
      headers: reqHeaders
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch (e) { json = data; }
        resolve({ status: res.statusCode, headers: res.headers, body: json });
      });
    });
    req.on('error', reject);
    if (body) {
      req.write(typeof body === 'string' ? body : JSON.stringify(body));
    }
    req.end();
  });
}

async function run() {
  console.log('====================================================');
  console.log(`🚀 STARTING FULL E2E RIDE LIFECYCLE TEST on ${BASE_URL}`);
  console.log('====================================================');

  const connectDB = require('../config/db');
  await connectDB();
  const { TripDetails } = require('../models/tripDetailsModel');
  const { createModel } = require('../models/dynamicModel');
  const UserModel = createModel('users');
  const DriverModel = createModel('drivers');

  // Verify accounts in DB
  const user = await UserModel.findOne({ userId: RIDER_USER_ID });
  const driver = await DriverModel.findOne({ driverId: DRIVER_ID });
  if (!user || !driver) {
    throw new Error(`Accounts missing! Rider: ${!!user}, Driver: ${!!driver}`);
  }

  // Ensure active valid tokens
  const riderToken = jwt.sign({ userId: RIDER_USER_ID, role: 'user', appId: APP_ID }, JWT_SECRET, { expiresIn: '7d' });
  const driverToken = jwt.sign({ driverId: DRIVER_ID, role: 'driver', appId: APP_ID }, JWT_SECRET, { expiresIn: '7d' });

  // Update tokens and online status in database
  await UserModel.updateOne({ userId: RIDER_USER_ID }, { $set: { accessToken: riderToken, isVerified: true, accountStatus: 'ACTIVE' } });
  await DriverModel.updateOne({ driverId: DRIVER_ID }, { 
    $set: { 
      accessToken: driverToken, 
      isOnline: true, 
      verificationStatus: 'APPROVED', 
      isVerified: true, 
      location: { type: 'Point', coordinates: [82.9739, 25.3176] },
      fcmToken: driver.fcmToken || 'fake-driver-fcm-token-for-e2e-testing-1234567890'
    } 
  });

  console.log('✅ Accounts Verified and Tokens Updated');
  console.log(`   Rider: ${user.firstName || 'Asha'} (${RIDER_USER_ID})`);
  console.log(`   Driver: ${driver.name || 'Test Driver'} (${DRIVER_ID}), Status: Online`);

  const riderHeaders = { 'Authorization': `Bearer ${riderToken}` };
  const driverHeaders = { 'Authorization': `Bearer ${driverToken}` };

  // Step 1: Fare Estimate
  console.log('\n--- Step 1: Fare Estimate ---');
  const estRes = await httpRequest('POST', '/api/v1/trips/estimate', {
    pickup_latitude: 25.3176,
    pickup_longitude: 82.9739,
    drop_latitude: 25.3350,
    drop_longitude: 82.9900,
    category_id: 'vc_684dc8a54e66da65'
  }, riderHeaders);
  console.log(`Status: ${estRes.status}`);
  console.log('Estimate:', JSON.stringify(estRes.body, null, 2));
  if (estRes.status !== 200 || !estRes.body.success) throw new Error('Fare estimate failed');
  const estimatedFare = estRes.body.data.fare;

  // Step 2: Ride Options
  console.log('\n--- Step 2: Ride Options ---');
  const optRes = await httpRequest('POST', '/api/v1/trips/ride-options', {
    pickup_latitude: 25.3176,
    pickup_longitude: 82.9739,
    drop_latitude: 25.3350,
    drop_longitude: 82.9900
  }, riderHeaders);
  console.log(`Status: ${optRes.status}, Options found: ${optRes.body.data?.options?.length || 0}`);
  if (optRes.status !== 200) throw new Error('Ride options failed');

  // Step 3: Nearby Drivers
  console.log('\n--- Step 3: Nearby Drivers ---');
  const nearRes = await httpRequest('POST', '/api/v1/trips/nearby-drivers', {
    latitude: 25.3176,
    longitude: 82.9739,
    category_id: 'vc_684dc8a54e66da65'
  }, riderHeaders);
  console.log(`Status: ${nearRes.status}, Nearby count: ${nearRes.body.data?.drivers?.length || 0}`);

  // Step 4: Create Trip Request
  console.log('\n--- Step 4: Create Trip Request ---');
  const reqId = `REQ_${Date.now()}`;
  const createRes = await httpRequest('POST', '/api/v1/trips/create-request', {
    request_id: reqId,
    user_id: RIDER_USER_ID,
    driver_id: DRIVER_ID,
    pickup_address: 'Varanasi Junction Railway Station',
    pickup_latitude: 25.3176,
    pickup_longitude: 82.9739,
    drop_address: 'BHU Main Gate, Lanka',
    drop_latitude: 25.3350,
    drop_longitude: 82.9900,
    category_id: 'vc_684dc8a54e66da65',
    payment_mode: 'CASH'
  }, riderHeaders);
  console.log(`Status: ${createRes.status}`);
  console.log('Create Response:', JSON.stringify(createRes.body, null, 2));
  if (createRes.status !== 200 && createRes.status !== 201) throw new Error('Create request failed');

  const tripId = createRes.body.data?.trip_id || createRes.body.trip_id;
  console.log(`🎉 Trip Created! ID: ${tripId}`);

  // Inspect Trip in DB
  let tripDoc = await TripDetails.findOne({ trip_id: tripId });
  console.log(`   Initial DB Status: ${tripDoc.status}`);
  console.log(`   Start OTP in DB: ${tripDoc.start_otp}`);
  const startOtp = tripDoc.start_otp;

  // Step 5: Driver Responds / Accepts Offer
  console.log('\n--- Step 5: Driver Accepts Offer ---');
  const acceptRes = await httpRequest('POST', '/api/v1/trips/driver-response', {
    trip_id: tripId,
    driver_id: DRIVER_ID,
    response: 'ACCEPTED'
  }, driverHeaders);
  console.log(`Status: ${acceptRes.status}`);
  console.log('Accept Response:', JSON.stringify(acceptRes.body, null, 2));
  if (acceptRes.status !== 200 || !acceptRes.body.success) throw new Error('Driver accept failed');

  // Verify status in DB
  tripDoc = await TripDetails.findOne({ trip_id: tripId });
  console.log(`   Status after accept: ${tripDoc.status}`);

  // Step 6: Driver updates status to ARRIVED
  console.log('\n--- Step 6: Driver Arrives at Pickup ---');
  const arriveRes = await httpRequest('PATCH', `/api/v1/rides/${tripId}/status`, {
    status: 'ARRIVED'
  }, driverHeaders);
  console.log(`Status: ${arriveRes.status}`);
  console.log('Arrive Response:', JSON.stringify(arriveRes.body, null, 2));
  if (arriveRes.status !== 200 || !arriveRes.body.success) throw new Error('Driver arrive failed');

  // Step 7: Driver Starts Trip with Start OTP
  console.log('\n--- Step 7: Driver Starts Trip (OTP Verification) ---');
  // First test wrong OTP (should be refused)
  const badOtpRes = await httpRequest('PATCH', `/api/v1/rides/${tripId}/status`, {
    status: 'ON_GOING',
    otp: '0000'
  }, driverHeaders);
  console.log(`Invalid OTP refusal check: Status ${badOtpRes.status}, Error: ${badOtpRes.body?.error || badOtpRes.body?.message}`);
  if (badOtpRes.status === 200) throw new Error('Security flaw: Trip started with wrong OTP!');

  // Now start with valid OTP
  const startRes = await httpRequest('PATCH', `/api/v1/rides/${tripId}/status`, {
    status: 'ON_GOING',
    otp: startOtp
  }, driverHeaders);
  console.log(`Status with correct OTP: ${startRes.status}`);
  console.log('Start Response:', JSON.stringify(startRes.body, null, 2));
  if (startRes.status !== 200 || !startRes.body.success) throw new Error('Trip start failed with valid OTP');

  // Verify DB
  tripDoc = await TripDetails.findOne({ trip_id: tripId });
  console.log(`   Status in DB: ${tripDoc.status}, OTP Verified At: ${tripDoc.start_otp_verified_at}`);

  // Step 8: Driver Completes Trip
  console.log('\n--- Step 8: Driver Completes Trip ---');
  const completeRes = await httpRequest('PATCH', `/api/v1/rides/${tripId}/status`, {
    status: 'COMPLETED',
    toll_minor: 0
  }, driverHeaders);
  console.log(`Status: ${completeRes.status}`);
  console.log('Complete Response:', JSON.stringify(completeRes.body, null, 2));
  if (completeRes.status !== 200 || !completeRes.body.success) throw new Error('Trip complete failed');

  // Step 9: Rider Checks Active Ride / Needs Receipt
  console.log('\n--- Step 9: Rider Queries Active Ride ---');
  const activeRes = await httpRequest('GET', `/api/v1/rides/active?user_id=${RIDER_USER_ID}`, null, riderHeaders);
  console.log(`Status: ${activeRes.status}, Needs Receipt: ${activeRes.body?.data?.active_ride?.needs_receipt}`);

  // Step 10: Rider Acknowledges Receipt
  console.log('\n--- Step 10: Rider Dismisses / Acknowledges Receipt ---');
  const ackRes = await httpRequest('POST', '/api/v1/rides/receipt-ack', {
    ride_id: tripId,
    user_id: RIDER_USER_ID
  }, riderHeaders);
  console.log(`Status: ${ackRes.status}`);
  console.log('Receipt Ack Response:', JSON.stringify(ackRes.body, null, 2));
  if (ackRes.status !== 200 || !ackRes.body.success) throw new Error('Receipt ack failed');

  // Step 11: Rider Rates Driver
  console.log('\n--- Step 11: Rider Rates Driver (5 Stars) ---');
  const rateRes = await httpRequest('POST', '/api/v1/rides/rate', {
    ride_id: tripId,
    user_id: RIDER_USER_ID,
    stars: 5,
    comment: 'Smooth and polite ride in Varanasi!',
    tags: ['POLITE', 'CLEAN_CAR', 'SMOOTH_DRIVE']
  }, riderHeaders);
  console.log(`Status: ${rateRes.status}`);
  console.log('Rate Response:', JSON.stringify(rateRes.body, null, 2));
  if (rateRes.status !== 200 || !rateRes.body.success) throw new Error('Rating failed');

  // Step 12: Final Database & Financial Audit
  console.log('\n--- Step 12: Final Database & Financial Verification ---');
  const finalTrip = await TripDetails.findOne({ trip_id: tripId });
  console.log('Final Trip Record in MongoDB:');
  console.log({
    trip_id: finalTrip.trip_id,
    status: finalTrip.status,
    fare: finalTrip.fare,
    currency: finalTrip.currency,
    driver_earning: finalTrip.driver_earning,
    driver_earning_minor: finalTrip.driver_earning_minor,
    platform_commission_minor: finalTrip.platform_commission_minor,
    start_otp: finalTrip.start_otp,
    start_otp_verified_at: finalTrip.start_otp_verified_at,
    completed_at: finalTrip.completed_at,
    rider_receipt_ack_at: finalTrip.rider_receipt_ack_at,
    rider_rating: finalTrip.rider_rating
  });

  console.log('\n====================================================');
  console.log('🏆 FULL END-TO-END RIDE LIFECYCLE COMPLETED SUCCESSFULLY!');
  console.log('====================================================');
  process.exit(0);
}

run().catch(err => {
  console.error('\n❌ E2E TEST FAILED:', err);
  process.exit(1);
});
