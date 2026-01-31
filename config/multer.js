const multer = require('multer');
const path = require('path');
const fs = require('fs');

// Ensure uploads directory exists
const uploadsDir = path.join(__dirname, '../uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// Configure multer storage
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadsDir);
  },
  filename: (req, file, cb) => {
    // Generate unique filename with timestamp
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    const extension = path.extname(file.originalname);
    const filename = file.fieldname + '-' + uniqueSuffix + extension;
    cb(null, filename);
  }
});

// File filter for image validation
const fileFilter = (req, file, cb) => {
  // Check if file is an image
  if (file.mimetype.startsWith('image/')) {
    // Check file size (max 10MB)
    if (file.size && file.size > 10 * 1024 * 1024) {
      return cb(new Error('File size too large. Maximum size is 10MB.'), false);
    }
    cb(null, true);
  } else {
    cb(new Error('Only image files are allowed!'), false);
  }
};

// Configure multer
const upload = multer({
  storage: storage,
  fileFilter: fileFilter,
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB limit
    files: 10 // Maximum 10 files per request
  }
});

// Middleware for vehicle document images
const uploadVehicleDocuments = upload.fields([
  { name: 'vehicleRegistrationImages', maxCount: 5 },
  { name: 'vehicleInsuranceImages', maxCount: 5 },
  { name: 'drivingLicenseImages', maxCount: 5 },
  { name: 'idProofImages', maxCount: 5 }
]);

// Middleware for single image upload
const uploadSingleImage = upload.single('image');

// Middleware for multiple images with same field name
const uploadMultipleImages = upload.array('images', 10);

// Error handling middleware
const handleMulterError = (error, req, res, next) => {
  if (error instanceof multer.MulterError) {
    if (error.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({
        success: false,
        message: 'File too large. Maximum size is 10MB.',
        error: error.message
      });
    }
    if (error.code === 'LIMIT_FILE_COUNT') {
      return res.status(400).json({
        success: false,
        message: 'Too many files. Maximum 10 files allowed.',
        error: error.message
      });
    }
    if (error.code === 'LIMIT_UNEXPECTED_FILE') {
      return res.status(400).json({
        success: false,
        message: 'Unexpected field name for file upload.',
        error: error.message
      });
    }
  }
  
  if (error.message === 'Only image files are allowed!') {
    return res.status(400).json({
      success: false,
      message: 'Only image files are allowed.',
      error: error.message
    });
  }
  
  next(error);
};

// Clean up uploaded files
const cleanupUploadedFiles = (files) => {
  if (!files) return;
  
  const filePaths = [];
  
  // Handle single file
  if (files.path) {
    filePaths.push(files.path);
  }
  
  // Handle multiple files
  if (Array.isArray(files)) {
    files.forEach(file => {
      if (file.path) {
        filePaths.push(file.path);
      }
    });
  }
  
  // Handle field-based files
  if (typeof files === 'object' && !Array.isArray(files)) {
    Object.values(files).forEach(fileArray => {
      if (Array.isArray(fileArray)) {
        fileArray.forEach(file => {
          if (file.path) {
            filePaths.push(file.path);
          }
        });
      }
    });
  }
  
  // Delete files
  filePaths.forEach(filePath => {
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        console.log('✅ Cleaned up temporary file:', filePath);
      }
    } catch (error) {
      console.error('❌ Error cleaning up file:', filePath, error.message);
    }
  });
};

module.exports = {
  upload,
  uploadVehicleDocuments,
  uploadSingleImage,
  uploadMultipleImages,
  handleMulterError,
  cleanupUploadedFiles
};
