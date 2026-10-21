const express = require('express');
const router = express.Router();
const { createLimiter } = require('../lib/rateLimit');
const { clientIp } = require('../lib/rateLimit');
const publicController = require('../controllers/publicController');
const shareController = require('../controllers/shareController');
const legalController = require('../controllers/legalController');

// No sign-in, so it is limited per address (generous: every app start calls it once)
const limit = createLimiter({ name: 'public-config-ip', windowMs: 10 * 60 * 1000, max: 120, key: (r) => `public:config:${clientIp(r)}` });

router.get('/business/config', limit, publicController.businessConfig);
// the business's legal documents in force (privacy policy, terms ...); no sign-in, the apps read them before an account exists
router.get('/legal', limit, legalController.list);
router.get('/legal/:type', limit, legalController.one);

// A shared ride, by its random link token (the page /t/:token polls this); read-only and sanitised
const trackLimit = createLimiter({ name: 'public-track-ip', windowMs: 60 * 1000, max: 60, key: (r) => `public:track:${clientIp(r)}` });
router.get('/track/:token', trackLimit, shareController.publicTrack);

module.exports = router;
