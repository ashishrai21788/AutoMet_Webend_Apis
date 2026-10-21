const express = require('express');
const router = express.Router();
const e = require('../controllers/driverEarningsController');
const onboarding = require('../controllers/driverOnboardingController');
const { requireAuth } = require('../lib/authMiddleware');
const { createLimiter } = require('../lib/rateLimit');

// Mounted at /api/v1/driver/earnings. The signed-in driver's own earnings, analytics, bank account and withdrawals.
const driver = [requireAuth({ roles: ['driver'] }), onboarding.driverContext];
const limit = (name, max) => createLimiter({ name, windowMs: 60 * 60 * 1000, max, key: (q) => (q.authActorId ? name + ':' + q.authActorId : null), message: 'Please wait a while before trying again.' });

router.get('/overview', ...driver, e.overview);
router.get('/analytics', ...driver, e.analytics);
router.get('/incentives', ...driver, e.incentivesList);
router.get('/export.csv', ...driver, e.exportCsv);
router.get('/payouts', ...driver, e.payoutsSummary);
router.get('/payouts/transactions', ...driver, e.transactions);
router.put('/bank', requireAuth({ roles: ['driver'] }), limit('driver-bank', 20), onboarding.driverContext, e.saveBank);
router.post('/payouts/withdraw', requireAuth({ roles: ['driver'] }), limit('driver-withdraw', 20), onboarding.driverContext, e.withdraw);
router.post('/payouts/:id/cancel', ...driver, e.cancelWithdrawal);

module.exports = router;
