const express = require('express');
const router = express.Router();
const imageController = require('../controllers/imageController');
const { uploadSingleImage, handleMulterError } = require('../config/multer');
const { requireAuth } = require('../lib/authMiddleware');

// Both need a signed-in rider or driver: without one anyone on the internet could fill the image storage or empty it.
const signedIn = requireAuth({ roles: ['user', 'driver'] });

// Upload single image to Cloudinary
router.post('/upload', signedIn, uploadSingleImage, handleMulterError, imageController.uploadImage);

// Delete image from Cloudinary by public_id
router.delete('/delete/:public_id', signedIn, imageController.deleteImage);

module.exports = router;
