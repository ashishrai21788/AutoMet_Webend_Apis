const express = require('express');
const router = express.Router();
const presence = require('../controllers/riderPresenceController');
const { requireAuth } = require('../lib/authMiddleware');

// Mounted at /api/v1/rider/presence. The rider app tells the server where it is while the map is open.
router.post('/', requireAuth({ roles: ['user'] }), presence.report);

module.exports = router;
