const express = require('express');
const router = express.Router();
const tripsController = require('../controllers/tripsController');

router.post('/create-request', tripsController.createRequest);
router.post('/cancel-request', tripsController.cancelRequest);
router.post('/driver-response', tripsController.driverResponse);
router.post('/check-timeouts', tripsController.checkTimeouts);

module.exports = router;
