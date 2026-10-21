const express = require('express');
const router = express.Router();
const account = require('../controllers/driverAccountController');
const onboarding = require('../controllers/driverOnboardingController');
const { requireAuth } = require('../lib/authMiddleware');
const { createLimiter } = require('../lib/rateLimit');

// Mounted at /api/v1/driver/account. The signed-in driver's own data rights: a copy of their data, and deleting the account.
router.get('/export', requireAuth({ roles: ['driver'] }),
  createLimiter({ name: 'driver-data-export', windowMs: 60 * 60 * 1000, max: 10, key: (q) => (q.authActorId ? 'drvexp:' + q.authActorId : null), message: 'Please wait a while before trying again.' }),
  onboarding.driverContext, account.exportData);
router.post('/delete', requireAuth({ roles: ['driver'] }),
  createLimiter({ name: 'driver-account-delete', windowMs: 60 * 60 * 1000, max: 5, key: (q) => (q.authActorId ? 'drvdel:' + q.authActorId : null), message: 'Please wait a while before trying again.' }),
  onboarding.driverContext, account.deleteAccount);

module.exports = router;
