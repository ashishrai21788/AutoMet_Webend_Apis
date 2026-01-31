const Driver = require('../models/driver');

// Create a new driver
exports.createDriver = async (req, res) => {
  try {
    const { name, phone, vehicleNumber, isOnline } = req.body;
    const driver = new Driver({ name, phone, vehicleNumber, isOnline });
    await driver.save();
    res.status(201).json(driver);
  } catch (error) {
    if (error.code === 11000) {
      return res.status(400).json({ error: 'Phone number already exists' });
    }
    res.status(500).json({ error: 'Server error' });
  }
};

// Get all drivers
exports.getDrivers = async (req, res) => {
  try {
    const drivers = await Driver.find();
    res.status(200).json(drivers);
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
}; 