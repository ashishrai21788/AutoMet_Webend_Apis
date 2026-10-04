const express = require('express');
const router = express.Router();
const { createLimiter } = require('../lib/rateLimit');
const { clientIp } = require('../lib/rateLimit');
const publicController = require('../controllers/publicController');

// No sign-in, so it is limited per address (generous: every app start calls it once)
const limit = createLimiter({ name: 'public-config-ip', windowMs: 10 * 60 * 1000, max: 120, key: (r) => `public:config:${clientIp(r)}` });

router.get('/business/config', limit, publicController.businessConfig);

module.exports = router;
