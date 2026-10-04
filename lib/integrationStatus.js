/**
 * Which outside services this server is configured to use. Only yes/no: values, keys and account names are never read
 * out. "Configured" means the settings are present, not that the service has been exercised successfully.
 */
function integrationStatus(env = process.env, mongoose = require('mongoose')) {
  const has = (...names) => names.every((n) => !!String(env[n] || '').trim());
  return {
    database: { configured: has('MONGODB_USERNAME', 'MONGODB_PASSWORD', 'MONGODB_CLUSTER') || has('MONGODB_URI'), connected: mongoose.connection.readyState === 1 },
    documentStorage: { provider: 'Cloudinary', configured: has('CLOUDINARY_CLOUD_NAME', 'CLOUDINARY_API_KEY', 'CLOUDINARY_API_SECRET') },
    pushNotifications: { provider: 'Firebase Cloud Messaging', configured: has('FIREBASE_SERVICE_ACCOUNT_KEY') || has('FIREBASE_SERVICE_ACCOUNT_PATH') },
    adminSecurity: { configured: has('JWT_SECRET') },
    // no SMS provider is built into the server yet, so riders and drivers cannot receive their sign-in codes by text message
    otpDelivery: { provider: null, configured: false },
    payments: { provider: null, configured: false }
  };
}

module.exports = { integrationStatus };
