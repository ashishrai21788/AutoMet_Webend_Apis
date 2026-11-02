/**
 * SMS & OTP Delivery Service
 *
 * Provides a modular interface for sending OTPs and SMS alerts to riders and drivers.
 * Supports MSG91, Twilio, or mock/test login mode.
 *
 * Environment variables:
 *   SMS_PROVIDER: 'msg91' | 'twilio' | 'mock' (default: 'mock')
 *
 *   For MSG91:
 *     MSG91_AUTH_KEY: API authentication key from MSG91 control panel
 *     MSG91_TEMPLATE_ID: DLT-approved template ID for OTP (e.g. 64b8...)
 *
 *   For Twilio:
 *     TWILIO_ACCOUNT_SID: Twilio Account SID
 *     TWILIO_AUTH_TOKEN: Twilio Auth Token
 *     TWILIO_FROM_NUMBER: Twilio Sender Phone Number (E.164 format)
 */
const https = require('https');
const { testLoginConfig, last10 } = require('../lib/testLogin');

function isTestNumber(phone) {
  const cfg = testLoginConfig();
  return Boolean(cfg && cfg.numbers && cfg.numbers.has(last10(phone)));
}

async function sendViaMsg91({ phone, otp, authKey, templateId }) {
  return new Promise((resolve, reject) => {
    // Normalise Indian 10-digit phone to 91XXXXXXXXXX
    const digits = String(phone).replace(/\D/g, '');
    const mobile = digits.length === 10 ? `91${digits}` : digits;

    const postData = JSON.stringify({
      template_id: templateId,
      mobile: mobile,
      otp: otp
    });

    const options = {
      hostname: 'control.msg91.com',
      port: 443,
      path: '/api/v5/otp',
      method: 'POST',
      headers: {
        'authkey': authKey,
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(postData)
      }
    };

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve({ success: true, provider: 'msg91', body });
        } else {
          console.warn(`[smsService:msg91] Failed (${res.statusCode}): ${body}`);
          resolve({ success: false, provider: 'msg91', status: res.statusCode, body });
        }
      });
    });

    req.on('error', (err) => {
      console.error('[smsService:msg91] Network error:', err.message);
      reject(err);
    });

    req.setTimeout(8000, () => {
      req.destroy();
      reject(new Error('MSG91 request timeout (8s)'));
    });

    req.write(postData);
    req.end();
  });
}

async function sendViaTwilio({ phone, otp, accountSid, authToken, fromNumber }) {
  return new Promise((resolve, reject) => {
    const digits = String(phone).replace(/\D/g, '');
    const to = digits.startsWith('+') ? digits : `+${digits.length === 10 ? '91' + digits : digits}`;
    const bodyText = `Your AutoMet verification code is: ${otp}. Valid for 5 minutes.`;

    const postData = new URLSearchParams({
      To: to,
      From: fromNumber,
      Body: bodyText
    }).toString();

    const auth = Buffer.from(`${accountSid}:${authToken}`).toString('base64');

    const options = {
      hostname: 'api.twilio.com',
      port: 443,
      path: `/2010-04-01/Accounts/${accountSid}/Messages.json`,
      method: 'POST',
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postData)
      }
    };

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve({ success: true, provider: 'twilio', body });
        } else {
          console.warn(`[smsService:twilio] Failed (${res.statusCode}): ${body}`);
          resolve({ success: false, provider: 'twilio', status: res.statusCode, body });
        }
      });
    });

    req.on('error', (err) => {
      console.error('[smsService:twilio] Network error:', err.message);
      reject(err);
    });

    req.setTimeout(8000, () => {
      req.destroy();
      reject(new Error('Twilio request timeout (8s)'));
    });

    req.write(postData);
    req.end();
  });
}

/**
 * Dispatches an OTP to a phone number.
 * - Test accounts configured in TEST_LOGIN_NUMBERS skip third-party dispatch.
 * - If SMS_PROVIDER is configured, sends via provider.
 * - Otherwise logs OTP in development and skips delivery.
 */
async function sendOtp(phone, otp, context = 'login') {
  if (!phone || !otp) {
    return { success: false, error: 'Phone and OTP are required' };
  }

  // Allow-listed test numbers use fixed code without sending real SMS
  if (isTestNumber(phone)) {
    if (process.env.NODE_ENV !== 'production') {
      console.log(`[smsService] Test number ${last10(phone)}: OTP ${otp} (bypassing provider)`);
    }
    return { success: true, provider: 'test-login', testAccount: true };
  }

  const provider = (process.env.SMS_PROVIDER || '').trim().toLowerCase();

  if (provider === 'msg91') {
    const authKey = process.env.MSG91_AUTH_KEY;
    const templateId = process.env.MSG91_TEMPLATE_ID;
    if (!authKey || !templateId) {
      console.warn('[smsService] MSG91 selected but MSG91_AUTH_KEY or MSG91_TEMPLATE_ID is missing');
      return { success: false, error: 'MSG91 credentials missing' };
    }
    try {
      return await sendViaMsg91({ phone, otp, authKey, templateId });
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  if (provider === 'twilio') {
    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const authToken = process.env.TWILIO_AUTH_TOKEN;
    const fromNumber = process.env.TWILIO_FROM_NUMBER;
    if (!accountSid || !authToken || !fromNumber) {
      console.warn('[smsService] Twilio selected but credentials or TWILIO_FROM_NUMBER missing');
      return { success: false, error: 'Twilio credentials missing' };
    }
    try {
      return await sendViaTwilio({ phone, otp, accountSid, authToken, fromNumber });
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  // Default: Mock/Development log mode
  if (process.env.NODE_ENV !== 'production') {
    console.log(`[smsService:mock] Sent ${context} OTP ${otp} to ${phone}`);
  }
  return { success: true, provider: 'mock', delivered: false };
}

function isProviderConfigured() {
  const provider = (process.env.SMS_PROVIDER || '').trim().toLowerCase();
  if (provider === 'msg91') {
    return Boolean(process.env.MSG91_AUTH_KEY && process.env.MSG91_TEMPLATE_ID);
  }
  if (provider === 'twilio') {
    return Boolean(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_FROM_NUMBER);
  }
  return false;
}

module.exports = {
  sendOtp,
  isProviderConfigured
};
