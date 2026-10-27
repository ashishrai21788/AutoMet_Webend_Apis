const express = require('express');
const router = express.Router();
const payments = require('../controllers/paymentsController');
const { requireAuth, requireSchedulerSecret } = require('../lib/authMiddleware');
const { createLimiter } = require('../lib/rateLimit');

const actor = (name, max) => createLimiter({ name, windowMs: 60 * 1000, max, key: (r) => `${name}:${r.authActorId || r.ip}` });
const rider = requireAuth({ roles: ['user'] });
const driver = requireAuth({ roles: ['driver'] });
const either = requireAuth({ roles: ['user', 'driver'] });

// Provider callbacks: no sign-in (the signature is the authentication), generous limit per address.
router.post('/webhook/:provider', createLimiter({ name: 'payments-webhook', windowMs: 60 * 1000, max: 600, key: (r) => `payments-webhook:${r.ip}` }), payments.webhook);

// Scheduled upkeep (like the ride timeouts): expire stale payments, finish interrupted bookings, settle pending refunds.
router.post('/jobs/run', requireSchedulerSecret, payments.runJobs);

router.get('/methods', either, payments.methods);
router.post('/create', rider, actor('payments-create', 30), payments.create);
router.get('/trip/:tripId', either, payments.forTrip);
router.post('/cash/confirm', driver, actor('payments-cash', 60), payments.confirmCash);
router.post('/cash/dispute', either, actor('payments-dispute', 20), payments.disputeCash);
router.get('/commission', driver, payments.commissionSummary);
router.post('/commission/pay', driver, actor('payments-commission', 20), payments.payCommission);
router.post('/mock/simulate', either, actor('payments-mock', 60), payments.mockSimulate);
router.post('/:paymentId/refresh', rider, actor('payments-refresh', 60), payments.refresh);

module.exports = router;
