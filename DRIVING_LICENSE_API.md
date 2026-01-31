# 🚗 Driving License Information API

## 🎯 **Overview**

The `PUT /api/drivers/vehicle-details` API now supports updating driving license information along with vehicle details and image uploads.

## 📋 **Supported Fields**

### **🚗 Vehicle Information:**
| Field | Type | Required | Description | Example |
|-------|------|----------|-------------|---------|
| `vehicleType` | String | No | Type of vehicle | `"Car"`, `"Auto"`, `"Bike"`, `"Van"` |
| `vehicleNumber` | String | No | Vehicle registration number | `"DL01AB1234"` |
| `vehicleModel` | String | No | Vehicle model | `"Honda City"` |
| `vehicleColor` | String | No | Vehicle color | `"White"` |
| `vehicleManufacturingYear` | Number | No | Manufacturing year | `2020` |
| `engineNumber` | String | No | Engine number | `"ENG123456789"` |
| `chassisNumber` | String | No | Chassis number | `"CHS987654321"` |

### **🛡️ Vehicle Insurance:**
| Field | Type | Description | Example |
|-------|------|-------------|---------|
| `vehicleInsurance[policyNumber]` | String | Insurance policy number | `"POL123456789"` |
| `vehicleInsurance[insuranceCompany]` | String | Insurance company | `"HDFC ERGO"` |
| `vehicleInsurance[insuranceExpiryDate]` | Date | Insurance expiry date | `"2025-12-31"` |
| `vehicleInsurance[insuranceAmount]` | Number | Insurance amount | `18000` |
| `vehicleInsurance[isInsuranceValid]` | Boolean | Insurance validity | `true` |

### **📄 Driving License Information:**
| Field | Type | Required | Description | Example |
|-------|------|----------|-------------|---------|
| `licenseNumber` | String | No | Driving license number | `"ABC123456789"` |
| `licenseType` | String | No | License type | `"MCWG"`, `"LMV"`, `"HMV"` |
| `licenseExpiry` | Date | No | License expiry date | `"2026-12-31"` |
| `issuingAuthority` | String | No | Issuing authority | `"RTO Delhi"` |

### **📸 Document Images:**
| Field | Type | Max Files | Description |
|-------|------|-----------|-------------|
| `vehicleRegistrationImages` | File Array | 5 | Vehicle registration documents |
| `vehicleInsuranceImages` | File Array | 5 | Vehicle insurance documents |
| `drivingLicenseImages` | File Array | 5 | Driving license documents |
| `idProofImages` | File Array | 5 | ID proof documents |

### **🔄 Image Management:**
| Field | Type | Description | Example |
|-------|------|-------------|---------|
| `existingVehicleRegistrationImages` | JSON String | URLs to keep in database | `["url1", "url2"]` |
| `existingVehicleInsuranceImages` | JSON String | URLs to keep in database | `["url1", "url2"]` |
| `existingDrivingLicenseImages` | JSON String | URLs to keep in database | `["url1", "url2"]` |
| `existingIdProofImages` | JSON String | URLs to keep in database | `["url1", "url2"]` |

## 📱 **Mobile Implementation Examples**

### **React Native Example:**

```javascript
const updateDriverInformation = async (driverId, formData) => {
  const formDataToSend = new FormData();
  
  // Required field
  formDataToSend.append('driverId', driverId);
  
  // Vehicle Information
  if (formData.vehicleType) {
    formDataToSend.append('vehicleType', formData.vehicleType);
  }
  if (formData.vehicleNumber) {
    formDataToSend.append('vehicleNumber', formData.vehicleNumber);
  }
  if (formData.vehicleModel) {
    formDataToSend.append('vehicleModel', formData.vehicleModel);
  }
  if (formData.vehicleColor) {
    formDataToSend.append('vehicleColor', formData.vehicleColor);
  }
  if (formData.vehicleManufacturingYear) {
    formDataToSend.append('vehicleManufacturingYear', formData.vehicleManufacturingYear.toString());
  }
  if (formData.engineNumber) {
    formDataToSend.append('engineNumber', formData.engineNumber);
  }
  if (formData.chassisNumber) {
    formDataToSend.append('chassisNumber', formData.chassisNumber);
  }
  
  // Vehicle Insurance
  if (formData.insurance) {
    if (formData.insurance.policyNumber) {
      formDataToSend.append('vehicleInsurance[policyNumber]', formData.insurance.policyNumber);
    }
    if (formData.insurance.insuranceCompany) {
      formDataToSend.append('vehicleInsurance[insuranceCompany]', formData.insurance.insuranceCompany);
    }
    if (formData.insurance.insuranceExpiryDate) {
      formDataToSend.append('vehicleInsurance[insuranceExpiryDate]', formData.insurance.insuranceExpiryDate);
    }
    if (formData.insurance.insuranceAmount) {
      formDataToSend.append('vehicleInsurance[insuranceAmount]', formData.insurance.insuranceAmount.toString());
    }
    if (formData.insurance.isInsuranceValid !== undefined) {
      formDataToSend.append('vehicleInsurance[isInsuranceValid]', formData.insurance.isInsuranceValid.toString());
    }
  }
  
  // Driving License Information
  if (formData.licenseNumber) {
    formDataToSend.append('licenseNumber', formData.licenseNumber);
  }
  if (formData.licenseType) {
    formDataToSend.append('licenseType', formData.licenseType);
  }
  if (formData.licenseExpiry) {
    formDataToSend.append('licenseExpiry', formData.licenseExpiry);
  }
  if (formData.issuingAuthority) {
    formDataToSend.append('issuingAuthority', formData.issuingAuthority);
  }
  
  // Image Management
  if (formData.existingImages) {
    if (formData.existingImages.vehicleRegistration) {
      formDataToSend.append('existingVehicleRegistrationImages', 
        JSON.stringify(formData.existingImages.vehicleRegistration));
    }
    if (formData.existingImages.vehicleInsurance) {
      formDataToSend.append('existingVehicleInsuranceImages', 
        JSON.stringify(formData.existingImages.vehicleInsurance));
    }
    if (formData.existingImages.drivingLicense) {
      formDataToSend.append('existingDrivingLicenseImages', 
        JSON.stringify(formData.existingImages.drivingLicense));
    }
    if (formData.existingImages.idProof) {
      formDataToSend.append('existingIdProofImages', 
        JSON.stringify(formData.existingImages.idProof));
    }
  }
  
  // New Images
  if (formData.newImages) {
    if (formData.newImages.vehicleRegistration) {
      formData.newImages.vehicleRegistration.forEach(image => {
        formDataToSend.append('vehicleRegistrationImages', {
          uri: image.uri,
          type: image.type || 'image/jpeg',
          name: image.fileName || 'registration.jpg'
        });
      });
    }
    if (formData.newImages.vehicleInsurance) {
      formData.newImages.vehicleInsurance.forEach(image => {
        formDataToSend.append('vehicleInsuranceImages', {
          uri: image.uri,
          type: image.type || 'image/jpeg',
          name: image.fileName || 'insurance.jpg'
        });
      });
    }
    if (formData.newImages.drivingLicense) {
      formData.newImages.drivingLicense.forEach(image => {
        formDataToSend.append('drivingLicenseImages', {
          uri: image.uri,
          type: image.type || 'image/jpeg',
          name: image.fileName || 'license.jpg'
        });
      });
    }
    if (formData.newImages.idProof) {
      formData.newImages.idProof.forEach(image => {
        formDataToSend.append('idProofImages', {
          uri: image.uri,
          type: image.type || 'image/jpeg',
          name: image.fileName || 'idproof.jpg'
        });
      });
    }
  }
  
  try {
    const response = await fetch('http://localhost:3000/api/drivers/vehicle-details', {
      method: 'PUT',
      body: formDataToSend,
      headers: {
        'Content-Type': 'multipart/form-data',
      },
    });
    
    const result = await response.json();
    return result;
  } catch (error) {
    console.error('Error updating driver information:', error);
    throw error;
  }
};

// Usage Example:
const formData = {
  // Vehicle Information
  vehicleType: 'Car',
  vehicleNumber: 'DL01AB1234',
  vehicleModel: 'Honda City',
  vehicleColor: 'White',
  vehicleManufacturingYear: 2020,
  engineNumber: 'ENG123456789',
  chassisNumber: 'CHS987654321',
  
  // Vehicle Insurance
  insurance: {
    policyNumber: 'POL123456789',
    insuranceCompany: 'HDFC ERGO',
    insuranceExpiryDate: '2025-12-31',
    insuranceAmount: 18000,
    isInsuranceValid: true
  },
  
  // Driving License Information
  licenseNumber: 'ABC123456789',
  licenseType: 'MCWG',
  licenseExpiry: '2026-12-31',
  issuingAuthority: 'RTO Delhi',
  
  // Image Management
  existingImages: {
    vehicleRegistration: [
      'https://res.cloudinary.com/.../existing1.jpg',
      'https://res.cloudinary.com/.../existing2.jpg'
    ],
    drivingLicense: [
      'https://res.cloudinary.com/.../license1.jpg'
    ]
  },
  
  newImages: {
    vehicleRegistration: [
      { uri: 'file://path/to/new1.jpg', fileName: 'new1.jpg' }
    ],
    drivingLicense: [
      { uri: 'file://path/to/license2.jpg', fileName: 'license2.jpg' }
    ]
  }
};

updateDriverInformation('0656798311', formData)
  .then(result => {
    console.log('Driver information updated:', result);
  })
  .catch(error => {
    console.error('Error:', error);
  });
```

### **Kotlin Example:**

```kotlin
data class DriverUpdateData(
    val vehicleType: String? = null,
    val vehicleNumber: String? = null,
    val vehicleModel: String? = null,
    val vehicleColor: String? = null,
    val vehicleManufacturingYear: Int? = null,
    val engineNumber: String? = null,
    val chassisNumber: String? = null,
    val insurance: InsuranceData? = null,
    val licenseNumber: String? = null,
    val licenseType: String? = null,
    val licenseExpiry: String? = null,
    val issuingAuthority: String? = null,
    val existingImages: ExistingImages? = null,
    val newImages: NewImages? = null
)

data class InsuranceData(
    val policyNumber: String? = null,
    val insuranceCompany: String? = null,
    val insuranceExpiryDate: String? = null,
    val insuranceAmount: Int? = null,
    val isInsuranceValid: Boolean? = null
)

data class ExistingImages(
    val vehicleRegistration: List<String>? = null,
    val vehicleInsurance: List<String>? = null,
    val drivingLicense: List<String>? = null,
    val idProof: List<String>? = null
)

data class NewImages(
    val vehicleRegistration: List<ImageData>? = null,
    val vehicleInsurance: List<ImageData>? = null,
    val drivingLicense: List<ImageData>? = null,
    val idProof: List<ImageData>? = null
)

class DriverUpdateManager {
    suspend fun updateDriverInformation(
        driverId: String,
        updateData: DriverUpdateData
    ): Result<ApiResponse> {
        return try {
            val request = buildUpdateRequest(driverId, updateData)
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
    
    private fun buildUpdateRequest(
        driverId: String,
        updateData: DriverUpdateData
    ): Request {
        val requestBody = MultipartBody.Builder()
            .setType(MultipartBody.FORM)
            .addFormDataPart("driverId", driverId)
            .apply {
                // Vehicle Information
                updateData.vehicleType?.let { addFormDataPart("vehicleType", it) }
                updateData.vehicleNumber?.let { addFormDataPart("vehicleNumber", it) }
                updateData.vehicleModel?.let { addFormDataPart("vehicleModel", it) }
                updateData.vehicleColor?.let { addFormDataPart("vehicleColor", it) }
                updateData.vehicleManufacturingYear?.let { 
                    addFormDataPart("vehicleManufacturingYear", it.toString()) 
                }
                updateData.engineNumber?.let { addFormDataPart("engineNumber", it) }
                updateData.chassisNumber?.let { addFormDataPart("chassisNumber", it) }
                
                // Vehicle Insurance
                updateData.insurance?.let { insurance ->
                    insurance.policyNumber?.let { 
                        addFormDataPart("vehicleInsurance[policyNumber]", it) 
                    }
                    insurance.insuranceCompany?.let { 
                        addFormDataPart("vehicleInsurance[insuranceCompany]", it) 
                    }
                    insurance.insuranceExpiryDate?.let { 
                        addFormDataPart("vehicleInsurance[insuranceExpiryDate]", it) 
                    }
                    insurance.insuranceAmount?.let { 
                        addFormDataPart("vehicleInsurance[insuranceAmount]", it.toString()) 
                    }
                    insurance.isInsuranceValid?.let { 
                        addFormDataPart("vehicleInsurance[isInsuranceValid]", it.toString()) 
                    }
                }
                
                // Driving License Information
                updateData.licenseNumber?.let { addFormDataPart("licenseNumber", it) }
                updateData.licenseType?.let { addFormDataPart("licenseType", it) }
                updateData.licenseExpiry?.let { addFormDataPart("licenseExpiry", it) }
                updateData.issuingAuthority?.let { addFormDataPart("issuingAuthority", it) }
                
                // Existing Images
                updateData.existingImages?.let { existing ->
                    existing.vehicleRegistration?.let { urls ->
                        addFormDataPart("existingVehicleRegistrationImages", gson.toJson(urls))
                    }
                    existing.vehicleInsurance?.let { urls ->
                        addFormDataPart("existingVehicleInsuranceImages", gson.toJson(urls))
                    }
                    existing.drivingLicense?.let { urls ->
                        addFormDataPart("existingDrivingLicenseImages", gson.toJson(urls))
                    }
                    existing.idProof?.let { urls ->
                        addFormDataPart("existingIdProofImages", gson.toJson(urls))
                    }
                }
                
                // New Images
                updateData.newImages?.let { new ->
                    new.vehicleRegistration?.forEach { image ->
                        addImagePart("vehicleRegistrationImages", image)
                    }
                    new.vehicleInsurance?.forEach { image ->
                        addImagePart("vehicleInsuranceImages", image)
                    }
                    new.drivingLicense?.forEach { image ->
                        addImagePart("drivingLicenseImages", image)
                    }
                    new.idProof?.forEach { image ->
                        addImagePart("idProofImages", image)
                    }
                }
            }
            .build()
        
        return Request.Builder()
            .url("http://localhost:3000/api/drivers/vehicle-details")
            .put(requestBody)
            .build()
    }
}

// Usage Example:
val updateData = DriverUpdateData(
    vehicleType = "Car",
    vehicleNumber = "DL01AB1234",
    vehicleModel = "Honda City",
    vehicleColor = "White",
    vehicleManufacturingYear = 2020,
    engineNumber = "ENG123456789",
    chassisNumber = "CHS987654321",
    insurance = InsuranceData(
        policyNumber = "POL123456789",
        insuranceCompany = "HDFC ERGO",
        insuranceExpiryDate = "2025-12-31",
        insuranceAmount = 18000,
        isInsuranceValid = true
    ),
    licenseNumber = "ABC123456789",
    licenseType = "MCWG",
    licenseExpiry = "2026-12-31",
    issuingAuthority = "RTO Delhi"
)

driverUpdateManager.updateDriverInformation("0656798311", updateData)
    .onSuccess { response ->
        Log.d("API", "Driver updated successfully: ${response.message}")
    }
    .onFailure { error ->
        Log.e("API", "Error updating driver: ${error.message}")
    }
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
      "vehicleType": "Car",
      "vehicleNumber": "DL01AB1234",
      "vehicleModel": "Honda City",
      "vehicleColor": "White",
      "vehicleManufacturingYear": 2020,
      "engineNumber": "ENG123456789",
      "chassisNumber": "CHS987654321",
      "licenseNumber": "ABC123456789",
      "licenseType": "MCWG",
      "licenseExpiry": "2026-12-31T00:00:00.000Z",
      "issuingAuthority": "RTO Delhi",
      "vehicleInsurance": {
        "policyNumber": "POL123456789",
        "insuranceCompany": "HDFC ERGO",
        "insuranceExpiryDate": "2025-12-31T00:00:00.000Z",
        "insuranceAmount": 18000,
        "isInsuranceValid": true
      },
      "vehicleRegistrationImages": [...],
      "vehicleInsuranceImages": [...],
      "drivingLicenseImages": [...],
      "idProofImages": [...]
    },
    "updatedFields": [
      "vehicleType",
      "vehicleNumber",
      "licenseNumber",
      "licenseExpiry",
      "issuingAuthority",
      "licenseType"
    ],
    "vehicleDetails": { /* vehicle details object */ },
    "documentImages": { /* document images object */ },
    "uploadResults": { /* upload results object */ }
  }
}
```

## 🎯 **Key Features**

1. **✅ Complete Driver Information**: Vehicle details + driving license + insurance
2. **✅ Flexible Updates**: Update any combination of fields
3. **✅ Image Management**: Add, remove, or replace document images
4. **✅ Data Validation**: Proper validation for all field types
5. **✅ Mobile Friendly**: Works seamlessly with mobile forms

This API now provides complete support for updating all driver information including driving license details! 🚀
