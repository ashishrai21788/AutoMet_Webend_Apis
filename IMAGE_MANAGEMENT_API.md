# 📸 Image Management API Documentation

## 🎯 **Overview**

The `PUT /api/drivers/vehicle-details` API now supports proper image management with the following features:

1. **Image Replacement**: Remove existing images and add new ones
2. **Image Addition**: Add new images while keeping existing ones
3. **Image Removal**: Remove specific images from the database
4. **Complete Replacement**: Replace all images with new ones

## 🔧 **How It Works**

### **Image Management Logic:**

1. **Client sends existing image URLs** that should be kept in the database
2. **Client sends new image files** to be uploaded
3. **API combines** existing URLs + new upload URLs
4. **Database is updated** with the final combined list

### **Key Parameters:**

| Parameter | Type | Description | Example |
|-----------|------|-------------|---------|
| `existingVehicleRegistrationImages` | JSON String | Array of existing URLs to keep | `["url1", "url2"]` |
| `existingVehicleInsuranceImages` | JSON String | Array of existing URLs to keep | `["url1", "url2"]` |
| `existingDrivingLicenseImages` | JSON String | Array of existing URLs to keep | `["url1", "url2"]` |
| `existingIdProofImages` | JSON String | Array of existing URLs to keep | `["url1", "url2"]` |
| `vehicleRegistrationImages` | File Array | New images to upload | `[file1, file2]` |
| `vehicleInsuranceImages` | File Array | New images to upload | `[file1, file2]` |
| `drivingLicenseImages` | File Array | New images to upload | `[file1, file2]` |
| `idProofImages` | File Array | New images to upload | `[file1, file2]` |

## 📱 **Mobile Implementation Examples**

### **React Native Example:**

```javascript
const updateVehicleImages = async (driverId, imageUpdates) => {
  const formData = new FormData();
  
  // Required field
  formData.append('driverId', driverId);
  
  // Send existing URLs that should be kept
  if (imageUpdates.existingVehicleRegistration) {
    formData.append('existingVehicleRegistrationImages', 
      JSON.stringify(imageUpdates.existingVehicleRegistration));
  }
  
  if (imageUpdates.existingVehicleInsurance) {
    formData.append('existingVehicleInsuranceImages', 
      JSON.stringify(imageUpdates.existingVehicleInsurance));
  }
  
  if (imageUpdates.existingDrivingLicense) {
    formData.append('existingDrivingLicenseImages', 
      JSON.stringify(imageUpdates.existingDrivingLicense));
  }
  
  if (imageUpdates.existingIdProof) {
    formData.append('existingIdProofImages', 
      JSON.stringify(imageUpdates.existingIdProof));
  }
  
  // Add new images to upload
  if (imageUpdates.newVehicleRegistration) {
    imageUpdates.newVehicleRegistration.forEach(image => {
      formData.append('vehicleRegistrationImages', {
        uri: image.uri,
        type: image.type || 'image/jpeg',
        name: image.fileName || 'registration.jpg'
      });
    });
  }
  
  if (imageUpdates.newVehicleInsurance) {
    imageUpdates.newVehicleInsurance.forEach(image => {
      formData.append('vehicleInsuranceImages', {
        uri: image.uri,
        type: image.type || 'image/jpeg',
        name: image.fileName || 'insurance.jpg'
      });
    });
  }
  
  if (imageUpdates.newDrivingLicense) {
    imageUpdates.newDrivingLicense.forEach(image => {
      formData.append('drivingLicenseImages', {
        uri: image.uri,
        type: image.type || 'image/jpeg',
        name: image.fileName || 'license.jpg'
      });
    });
  }
  
  if (imageUpdates.newIdProof) {
    imageUpdates.newIdProof.forEach(image => {
      formData.append('idProofImages', {
        uri: image.uri,
        type: image.type || 'image/jpeg',
        name: image.fileName || 'idproof.jpg'
      });
    });
  }
  
  try {
    const response = await fetch('http://localhost:3000/api/drivers/vehicle-details', {
      method: 'PUT',
      body: formData,
      headers: {
        'Content-Type': 'multipart/form-data',
      },
    });
    
    const result = await response.json();
    return result;
  } catch (error) {
    console.error('Error updating vehicle images:', error);
    throw error;
  }
};

// Usage Examples:

// 1. Add new images while keeping existing ones
const addNewImages = async () => {
  const imageUpdates = {
    existingVehicleRegistration: [
      "https://res.cloudinary.com/.../existing1.jpg",
      "https://res.cloudinary.com/.../existing2.jpg"
    ],
    newVehicleRegistration: [
      { uri: 'file://path/to/new1.jpg', fileName: 'new1.jpg' },
      { uri: 'file://path/to/new2.jpg', fileName: 'new2.jpg' }
    ]
  };
  
  const result = await updateVehicleImages('0656798311', imageUpdates);
  console.log('Images updated:', result);
};

// 2. Remove some images and add new ones
const replaceImages = async () => {
  const imageUpdates = {
    existingVehicleRegistration: [
      "https://res.cloudinary.com/.../keep_this_one.jpg"
      // Removed other URLs - they will be deleted from database
    ],
    newVehicleRegistration: [
      { uri: 'file://path/to/replacement1.jpg', fileName: 'replacement1.jpg' }
    ]
  };
  
  const result = await updateVehicleImages('0656798311', imageUpdates);
  console.log('Images replaced:', result);
};

// 3. Complete replacement (remove all existing, add new ones)
const completeReplacement = async () => {
  const imageUpdates = {
    existingVehicleRegistration: [], // Empty array = remove all existing
    newVehicleRegistration: [
      { uri: 'file://path/to/new1.jpg', fileName: 'new1.jpg' },
      { uri: 'file://path/to/new2.jpg', fileName: 'new2.jpg' }
    ]
  };
  
  const result = await updateVehicleImages('0656798311', imageUpdates);
  console.log('All images replaced:', result);
};

// 4. Only remove images (no new uploads)
const removeImages = async () => {
  const imageUpdates = {
    existingVehicleRegistration: [
      "https://res.cloudinary.com/.../keep_this_one.jpg"
      // Other URLs removed
    ]
    // No new images to upload
  };
  
  const result = await updateVehicleImages('0656798311', imageUpdates);
  console.log('Images removed:', result);
};
```

### **Kotlin Example:**

```kotlin
data class ImageUpdate(
    val existingVehicleRegistration: List<String>? = null,
    val existingVehicleInsurance: List<String>? = null,
    val existingDrivingLicense: List<String>? = null,
    val existingIdProof: List<String>? = null,
    val newVehicleRegistration: List<ImageData>? = null,
    val newVehicleInsurance: List<ImageData>? = null,
    val newDrivingLicense: List<ImageData>? = null,
    val newIdProof: List<ImageData>? = null
)

class VehicleImageManager {
    private val apiService = VehicleDetailsApiService()
    
    suspend fun updateVehicleImages(
        driverId: String,
        imageUpdates: ImageUpdate
    ): Result<ApiResponse> {
        return try {
            val request = buildImageUpdateRequest(driverId, imageUpdates)
            val response = client.newCall(request).execute()
            
            if (response.isSuccessful) {
                val responseBody = response.body?.string()
                val apiResponse = gson.fromJson(responseBody, ApiResponse::class.java)
                Result.success(apiResponse)
            } else {
                val errorBody = response.body?.string()
                val errorResponse = gson.fromJson(errorBody, ApiResponse::class.java)
                Result.failure(Exception("API Error: ${errorResponse.message}"))
            }
        } catch (e: Exception) {
            Result.failure(e)
        }
    }
    
    private fun buildImageUpdateRequest(
        driverId: String,
        imageUpdates: ImageUpdate
    ): Request {
        val requestBody = MultipartBody.Builder()
            .setType(MultipartBody.FORM)
            .addFormDataPart("driverId", driverId)
            .apply {
                // Add existing URLs
                imageUpdates.existingVehicleRegistration?.let { urls ->
                    addFormDataPart("existingVehicleRegistrationImages", 
                        gson.toJson(urls))
                }
                imageUpdates.existingVehicleInsurance?.let { urls ->
                    addFormDataPart("existingVehicleInsuranceImages", 
                        gson.toJson(urls))
                }
                imageUpdates.existingDrivingLicense?.let { urls ->
                    addFormDataPart("existingDrivingLicenseImages", 
                        gson.toJson(urls))
                }
                imageUpdates.existingIdProof?.let { urls ->
                    addFormDataPart("existingIdProofImages", 
                        gson.toJson(urls))
                }
                
                // Add new images
                imageUpdates.newVehicleRegistration?.forEach { image ->
                    addImagePart("vehicleRegistrationImages", image)
                }
                imageUpdates.newVehicleInsurance?.forEach { image ->
                    addImagePart("vehicleInsuranceImages", image)
                }
                imageUpdates.newDrivingLicense?.forEach { image ->
                    addImagePart("drivingLicenseImages", image)
                }
                imageUpdates.newIdProof?.forEach { image ->
                    addImagePart("idProofImages", image)
                }
            }
            .build()
        
        return Request.Builder()
            .url("http://localhost:3000/api/drivers/vehicle-details")
            .put(requestBody)
            .build()
    }
}

// Usage Examples:

// 1. Add new images while keeping existing
val addNewImages = ImageUpdate(
    existingVehicleRegistration = listOf(
        "https://res.cloudinary.com/.../existing1.jpg",
        "https://res.cloudinary.com/.../existing2.jpg"
    ),
    newVehicleRegistration = listOf(
        ImageData("file://path/to/new1.jpg", "image/jpeg", "new1.jpg"),
        ImageData("file://path/to/new2.jpg", "image/jpeg", "new2.jpg")
    )
)

// 2. Complete replacement
val completeReplacement = ImageUpdate(
    existingVehicleRegistration = emptyList(), // Remove all existing
    newVehicleRegistration = listOf(
        ImageData("file://path/to/new1.jpg", "image/jpeg", "new1.jpg")
    )
)

// 3. Only remove images
val removeImages = ImageUpdate(
    existingVehicleRegistration = listOf(
        "https://res.cloudinary.com/.../keep_this_one.jpg"
        // Other URLs removed
    )
    // No new images
)
```

## 📊 **Response Format**

### **Success Response:**
```json
{
  "success": true,
  "message": "Vehicle details updated successfully",
  "data": {
    "driver": {
      "driverId": "0656798311",
      "vehicleRegistrationImages": [
        "https://res.cloudinary.com/.../existing1.jpg",
        "https://res.cloudinary.com/.../existing2.jpg",
        "https://res.cloudinary.com/.../new1.jpg",
        "https://res.cloudinary.com/.../new2.jpg"
      ],
      "vehicleInsuranceImages": [...],
      "drivingLicenseImages": [...],
      "idProofImages": [...]
    },
    "updatedFields": ["vehicleRegistrationImages"],
    "uploadResults": {
      "vehicleRegistrationImages": [
        "https://res.cloudinary.com/.../new1.jpg",
        "https://res.cloudinary.com/.../new2.jpg"
      ],
      "vehicleInsuranceImages": [],
      "drivingLicenseImages": [],
      "idProofImages": []
    }
  }
}
```

## 🎯 **Key Benefits**

1. **✅ Flexible Image Management**: Add, remove, or replace images as needed
2. **✅ No Data Loss**: Existing images are preserved unless explicitly removed
3. **✅ Efficient Updates**: Only upload new images, keep existing URLs
4. **✅ Complete Control**: Client decides which images to keep/remove
5. **✅ Mobile Friendly**: Works seamlessly with mobile image pickers

## 📝 **Best Practices**

1. **Always send existing URLs** that should be kept in the database
2. **Use empty arrays** to remove all existing images
3. **Validate image URLs** before sending to API
4. **Handle errors gracefully** when image uploads fail
5. **Clean up local files** after successful upload

This implementation provides complete control over image management while maintaining data integrity! 🚀
