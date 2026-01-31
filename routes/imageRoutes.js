const express = require('express');
const router = express.Router();
const imageController = require('../controllers/imageController');
const { uploadSingleImage, handleMulterError } = require('../config/multer');

// Upload single image to Cloudinary
router.post('/upload', uploadSingleImage, handleMulterError, imageController.uploadImage);

// Delete image from Cloudinary by public_id
router.delete('/delete/:public_id', imageController.deleteImage);

module.exports = router;

