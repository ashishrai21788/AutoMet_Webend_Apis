const express = require('express');
const router = express.Router();
const legalController = require('../controllers/legalController');
const { requireAuth } = require('../lib/authMiddleware');

// Mounted at /api/v1/legal. What the signed-in rider or driver still has to agree to, and recording that they agreed.
router.get('/pending', requireAuth({ roles: ['user', 'driver'] }), legalController.pending);
router.post('/accept', requireAuth({ roles: ['user', 'driver'] }), legalController.accept);

module.exports = router;
