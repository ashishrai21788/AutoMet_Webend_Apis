const express = require('express');
const router = express.Router();
const driverController = require('../controllers/driverController');

// Create a new driver
router.post('/', driverController.createDriver);

// Get all drivers
router.get('/', driverController.getDrivers);

module.exports = router; 