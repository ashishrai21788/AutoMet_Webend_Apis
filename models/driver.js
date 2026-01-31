const mongoose = require('mongoose');

const driverSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true,
  },
  phone: {
    type: String,
    required: true,
    unique: true,
    trim: true,
  },
  vehicleNumber: {
    type: String,
    required: true,
    trim: true,
  },
  isOnline: {
    type: Boolean,
    default: false,
  },
}, { timestamps: true });

// Use collection name from environment variable
const collectionName = process.env.COLLECTION_NAME || 'drivers';
module.exports = mongoose.model('Driver', driverSchema, collectionName); 