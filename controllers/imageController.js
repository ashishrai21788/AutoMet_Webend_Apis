const { uploadImage, deleteImage } = require('../config/cloudinary');
const { uploadSingleImage, handleMulterError, cleanupUploadedFiles } = require('../config/multer');

// Upload single image to Cloudinary
exports.uploadImage = async (req, res) => {
  let uploadedFile = null;
  
  try {
    // Check if file was uploaded
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: 'No image file provided',
        data: {
          error: 'Please provide an image file in the request'
        }
      });
    }

    uploadedFile = req.file;

    // Get optional folder parameter from request body or query
    const folder = req.body.folder || req.query.folder || 'driver-documents';

    // Upload image to Cloudinary
    const uploadResult = await uploadImage(uploadedFile, folder);

    if (!uploadResult.success) {
      return res.status(500).json({
        success: false,
        message: 'Failed to upload image to Cloudinary',
        data: {
          error: uploadResult.error
        }
      });
    }

    // Set proper headers
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');

    // Return success response with image details
    res.status(200).json({
      success: true,
      message: 'Image uploaded successfully to Cloudinary',
      data: {
        url: uploadResult.url,
        public_id: uploadResult.public_id,
        width: uploadResult.width,
        height: uploadResult.height,
        format: uploadResult.format,
        bytes: uploadResult.bytes,
        folder: folder,
        uploadedAt: new Date().toISOString()
      }
    });

  } catch (error) {
    console.error('Image upload error:', error);
    // Cleanup handled by finally block
    res.status(500).json({
      success: false,
      message: 'Server error during image upload',
      data: {
        error: error.message
      }
    });
  } finally {
    // Clean up temporary file after successful upload
    if (uploadedFile) {
      cleanupUploadedFiles(uploadedFile);
    }
  }
};

// Delete image from Cloudinary by public_id
exports.deleteImage = async (req, res) => {
  try {
    const { public_id } = req.params;

    // Validate required parameter
    if (!public_id) {
      return res.status(400).json({
        success: false,
        message: 'Missing required parameter: public_id',
        data: {
          missingFields: {
            public_id: !public_id
          }
        }
      });
    }

    // Delete image from Cloudinary
    const deleteResult = await deleteImage(public_id);

    if (!deleteResult.success) {
      return res.status(500).json({
        success: false,
        message: 'Failed to delete image from Cloudinary',
        data: {
          error: deleteResult.error || 'Unknown error occurred',
          public_id: public_id
        }
      });
    }

    // Set proper headers
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');

    // Return success response
    res.status(200).json({
      success: true,
      message: 'Image deleted successfully from Cloudinary',
      data: {
        public_id: public_id,
        result: deleteResult.result,
        deletedAt: new Date().toISOString()
      }
    });

  } catch (error) {
    console.error('Image delete error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error during image deletion',
      data: {
        error: error.message
      }
    });
  }
};

