const https = require('https');

function post(path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = https.request({
      hostname: 'automet-webend-apis.onrender.com',
      port: 443,
      path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
        'X-App-Id': 'app_a8c359b926'
      }
    }, (res) => {
      let b = '';
      res.on('data', chunk => b += chunk);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(b) }); }
        catch (e) { resolve({ status: res.statusCode, body: b }); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function run() {
  console.log('1. Driver Login via /api/drivers/login for 9876500001...');
  const res1 = await post('/api/drivers/login', { phoneNumber: '9876500001' });
  console.log('Driver Login res:', res1.status, res1.body.message);
  console.log('Data:', JSON.stringify(res1.body.data, null, 2));

  const driverId = res1.body.data?.driver?.driverId;
  const otp = res1.body.data?.otp?.otp || '123456';

  console.log(`\n2. Verifying OTP ${otp} for Driver ${driverId}...`);
  const res2 = await post('/api/otp/verify', { driverId, otp });
  console.log('Driver Verify res:', res2.status, res2.body.message);
  console.log('Driver Token:', res2.body.data?.accessToken?.slice(0, 25) + '...');
}

run().catch(console.error);
