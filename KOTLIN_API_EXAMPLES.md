# 📱 Kotlin API Request Examples for Vehicle Details

## 🚗 Vehicle Details API - Kotlin Implementation

### **API Details:**
- **Endpoint**: `PUT http://localhost:3000/api/drivers/vehicle-details`
- **Content-Type**: `multipart/form-data`
- **Method**: `PUT`

---

## 🔧 **Data Classes**

```kotlin
// Vehicle Data Classes
data class VehicleData(
    val vehicleType: String? = null,
    val vehicleNumber: String? = null,
    val vehicleModel: String? = null,
    val vehicleColor: String? = null,
    val vehicleManufacturingYear: Int? = null,
    val engineNumber: String? = null,
    val chassisNumber: String? = null,
    val insurance: InsuranceData? = null
)

data class InsuranceData(
    val policyNumber: String? = null,
    val insuranceCompany: String? = null,
    val insuranceExpiryDate: String? = null,
    val insuranceAmount: Int? = null,
    val isInsuranceValid: Boolean? = null
)

data class ImageData(
    val uri: String,
    val type: String = "image/jpeg",
    val fileName: String
)

data class VehicleImages(
    val vehicleRegistrationImages: List<ImageData>? = null,
    val vehicleInsuranceImages: List<ImageData>? = null,
    val drivingLicenseImages: List<ImageData>? = null,
    val idProofImages: List<ImageData>? = null
)

// API Response Classes
data class ApiResponse(
    val success: Boolean,
    val message: String,
    val data: ResponseData? = null
)

data class ResponseData(
    val driver: Driver? = null,
    val updatedFields: List<String>? = null,
    val vehicleDetails: VehicleData? = null,
    val documentImages: DocumentImages? = null,
    val uploadResults: UploadResults? = null
)

data class Driver(
    val driverId: String,
    val vehicleType: String? = null,
    val vehicleNumber: String? = null,
    val vehicleModel: String? = null,
    val vehicleColor: String? = null,
    val vehicleManufacturingYear: Int? = null,
    val engineNumber: String? = null,
    val chassisNumber: String? = null,
    val vehicleInsurance: InsuranceData? = null,
    val vehicleRegistrationImages: List<String>? = null,
    val vehicleInsuranceImages: List<String>? = null,
    val drivingLicenseImages: List<String>? = null,
    val idProofImages: List<String>? = null
)

data class DocumentImages(
    val vehicleRegistrationImages: List<String>? = null,
    val vehicleInsuranceImages: List<String>? = null,
    val drivingLicenseImages: List<String>? = null,
    val idProofImages: List<String>? = null
)

data class UploadResults(
    val vehicleRegistrationImages: List<String>? = null,
    val vehicleInsuranceImages: List<String>? = null,
    val drivingLicenseImages: List<String>? = null,
    val idProofImages: List<String>? = null
)
```

---

## 🌐 **API Service Class**

```kotlin
import okhttp3.*
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.asRequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.File
import java.io.IOException
import com.google.gson.Gson
import com.google.gson.annotations.SerializedName

class VehicleDetailsApiService {
    private val client = OkHttpClient()
    private val gson = Gson()
    private val baseUrl = "http://localhost:3000/api/drivers/vehicle-details"

    // Main API call function
    suspend fun updateVehicleDetails(
        driverId: String,
        vehicleData: VehicleData? = null,
        images: VehicleImages? = null
    ): Result<ApiResponse> {
        return try {
            val request = buildRequest(driverId, vehicleData, images)
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

    private fun buildRequest(
        driverId: String,
        vehicleData: VehicleData?,
        images: VehicleImages?
    ): Request {
        val requestBody = MultipartBody.Builder()
            .setType(MultipartBody.FORM)
            .addFormDataPart("driverId", driverId)
            .apply {
                // Add vehicle information
                vehicleData?.let { data ->
                    data.vehicleType?.let { addFormDataPart("vehicleType", it) }
                    data.vehicleNumber?.let { addFormDataPart("vehicleNumber", it) }
                    data.vehicleModel?.let { addFormDataPart("vehicleModel", it) }
                    data.vehicleColor?.let { addFormDataPart("vehicleColor", it) }
                    data.vehicleManufacturingYear?.let { 
                        addFormDataPart("vehicleManufacturingYear", it.toString()) 
                    }
                    data.engineNumber?.let { addFormDataPart("engineNumber", it) }
                    data.chassisNumber?.let { addFormDataPart("chassisNumber", it) }
                    
                    // Add insurance information
                    data.insurance?.let { insurance ->
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
                }
                
                // Add images
                images?.let { imgData ->
                    imgData.vehicleRegistrationImages?.forEach { image ->
                        addImagePart("vehicleRegistrationImages", image)
                    }
                    imgData.vehicleInsuranceImages?.forEach { image ->
                        addImagePart("vehicleInsuranceImages", image)
                    }
                    imgData.drivingLicenseImages?.forEach { image ->
                        addImagePart("drivingLicenseImages", image)
                    }
                    imgData.idProofImages?.forEach { image ->
                        addImagePart("idProofImages", image)
                    }
                }
            }
            .build()

        return Request.Builder()
            .url(baseUrl)
            .put(requestBody)
            .build()
    }

    private fun MultipartBody.Builder.addImagePart(fieldName: String, imageData: ImageData) {
        val file = File(imageData.uri)
        if (file.exists()) {
            val mediaType = imageData.type.toMediaType()
            val requestBody = file.asRequestBody(mediaType)
            addFormDataPart(fieldName, imageData.fileName, requestBody)
        }
    }
}
```

---

## 🎯 **Usage Examples**

### **1. Basic Vehicle Information Update**
```kotlin
class VehicleDetailsViewModel : ViewModel() {
    private val apiService = VehicleDetailsApiService()
    
    fun updateBasicVehicleInfo(driverId: String) {
        viewModelScope.launch {
            val vehicleData = VehicleData(
                vehicleType = "Car",
                vehicleNumber = "DL01AB1234",
                vehicleModel = "Honda City",
                vehicleColor = "White",
                vehicleManufacturingYear = 2020,
                engineNumber = "ENG123456789",
                chassisNumber = "CHS987654321"
            )
            
            val result = apiService.updateVehicleDetails(driverId, vehicleData)
            
            result.onSuccess { response ->
                // Handle success
                Log.d("API", "Success: ${response.message}")
                // Update UI with response.data.driver
            }.onFailure { error ->
                // Handle error
                Log.e("API", "Error: ${error.message}")
            }
        }
    }
}
```

### **2. Vehicle Information with Insurance**
```kotlin
fun updateVehicleWithInsurance(driverId: String) {
    viewModelScope.launch {
        val insuranceData = InsuranceData(
            policyNumber = "POL123456789",
            insuranceCompany = "HDFC ERGO",
            insuranceExpiryDate = "2025-12-31",
            insuranceAmount = 18000,
            isInsuranceValid = true
        )
        
        val vehicleData = VehicleData(
            vehicleType = "Car",
            vehicleNumber = "DL01AB1234",
            vehicleModel = "Honda City",
            vehicleColor = "White",
            vehicleManufacturingYear = 2020,
            engineNumber = "ENG123456789",
            chassisNumber = "CHS987654321",
            insurance = insuranceData
        )
        
        val result = apiService.updateVehicleDetails(driverId, vehicleData)
        
        result.onSuccess { response ->
            Log.d("API", "Vehicle with insurance updated successfully")
        }.onFailure { error ->
            Log.e("API", "Error updating vehicle: ${error.message}")
        }
    }
}
```

### **3. Image Upload Only**
```kotlin
fun uploadVehicleImages(driverId: String, imagePaths: List<String>) {
    viewModelScope.launch {
        val images = VehicleImages(
            vehicleRegistrationImages = imagePaths.map { path ->
                ImageData(
                    uri = path,
                    type = "image/jpeg",
                    fileName = "registration_${System.currentTimeMillis()}.jpg"
                )
            }
        )
        
        val result = apiService.updateVehicleDetails(driverId, null, images)
        
        result.onSuccess { response ->
            val uploadedUrls = response.data?.uploadResults?.vehicleRegistrationImages
            Log.d("API", "Images uploaded: $uploadedUrls")
        }.onFailure { error ->
            Log.e("API", "Error uploading images: ${error.message}")
        }
    }
}
```

### **4. Complete Update with All Data**
```kotlin
fun updateCompleteVehicleDetails(
    driverId: String,
    vehicleData: VehicleData,
    registrationImages: List<String>,
    insuranceImages: List<String>,
    licenseImages: List<String>,
    idProofImages: List<String>
) {
    viewModelScope.launch {
        val images = VehicleImages(
            vehicleRegistrationImages = registrationImages.map { path ->
                ImageData(
                    uri = path,
                    type = "image/jpeg",
                    fileName = "registration_${System.currentTimeMillis()}.jpg"
                )
            },
            vehicleInsuranceImages = insuranceImages.map { path ->
                ImageData(
                    uri = path,
                    type = "image/jpeg",
                    fileName = "insurance_${System.currentTimeMillis()}.jpg"
                )
            },
            drivingLicenseImages = licenseImages.map { path ->
                ImageData(
                    uri = path,
                    type = "image/jpeg",
                    fileName = "license_${System.currentTimeMillis()}.jpg"
                )
            },
            idProofImages = idProofImages.map { path ->
                ImageData(
                    uri = path,
                    type = "image/jpeg",
                    fileName = "idproof_${System.currentTimeMillis()}.jpg"
                )
            }
        )
        
        val result = apiService.updateVehicleDetails(driverId, vehicleData, images)
        
        result.onSuccess { response ->
            Log.d("API", "Complete vehicle details updated successfully")
            // Handle success - update UI, show success message, etc.
        }.onFailure { error ->
            Log.e("API", "Error updating vehicle details: ${error.message}")
            // Handle error - show error message, retry option, etc.
        }
    }
}
```

---

## 📱 **Activity/Fragment Implementation**

```kotlin
class VehicleDetailsActivity : AppCompatActivity() {
    private lateinit var viewModel: VehicleDetailsViewModel
    private val apiService = VehicleDetailsApiService()
    
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_vehicle_details)
        
        viewModel = ViewModelProvider(this)[VehicleDetailsViewModel::class.java]
        
        setupUI()
        observeViewModel()
    }
    
    private fun setupUI() {
        // Setup your UI components
        btnUpdateVehicle.setOnClickListener {
            updateVehicleDetails()
        }
        
        btnUploadImages.setOnClickListener {
            selectImages()
        }
    }
    
    private fun updateVehicleDetails() {
        val driverId = etDriverId.text.toString()
        
        if (driverId.isEmpty()) {
            showError("Driver ID is required")
            return
        }
        
        val vehicleData = VehicleData(
            vehicleType = spinnerVehicleType.selectedItem.toString(),
            vehicleNumber = etVehicleNumber.text.toString(),
            vehicleModel = etVehicleModel.text.toString(),
            vehicleColor = etVehicleColor.text.toString(),
            vehicleManufacturingYear = etManufacturingYear.text.toString().toIntOrNull(),
            engineNumber = etEngineNumber.text.toString(),
            chassisNumber = etChassisNumber.text.toString(),
            insurance = InsuranceData(
                policyNumber = etPolicyNumber.text.toString(),
                insuranceCompany = etInsuranceCompany.text.toString(),
                insuranceExpiryDate = etExpiryDate.text.toString(),
                insuranceAmount = etInsuranceAmount.text.toString().toIntOrNull(),
                isInsuranceValid = switchInsuranceValid.isChecked
            )
        )
        
        // Get selected image paths
        val selectedImages = getSelectedImagePaths()
        val images = VehicleImages(
            vehicleRegistrationImages = selectedImages.registration,
            vehicleInsuranceImages = selectedImages.insurance,
            drivingLicenseImages = selectedImages.license,
            idProofImages = selectedImages.idProof
        )
        
        // Show loading
        showLoading(true)
        
        // Make API call
        lifecycleScope.launch {
            val result = apiService.updateVehicleDetails(driverId, vehicleData, images)
            
            result.onSuccess { response ->
                showLoading(false)
                showSuccess("Vehicle details updated successfully!")
                // Update UI with new data
                updateUIWithResponse(response.data?.driver)
            }.onFailure { error ->
                showLoading(false)
                showError("Error: ${error.message}")
            }
        }
    }
    
    private fun selectImages() {
        // Implement image selection logic
        // You can use libraries like ImagePicker or implement custom image selection
    }
    
    private fun getSelectedImagePaths(): SelectedImages {
        // Return selected image paths grouped by type
        return SelectedImages(
            registration = listOf("path/to/registration1.jpg", "path/to/registration2.jpg"),
            insurance = listOf("path/to/insurance.jpg"),
            license = listOf("path/to/license.jpg"),
            idProof = listOf("path/to/idproof.jpg")
        )
    }
    
    private fun observeViewModel() {
        // Observe ViewModel if needed
    }
    
    private fun showLoading(show: Boolean) {
        progressBar.visibility = if (show) View.VISIBLE else View.GONE
        btnUpdateVehicle.isEnabled = !show
    }
    
    private fun showSuccess(message: String) {
        Toast.makeText(this, message, Toast.LENGTH_SHORT).show()
    }
    
    private fun showError(message: String) {
        Toast.makeText(this, message, Toast.LENGTH_LONG).show()
    }
    
    private fun updateUIWithResponse(driver: Driver?) {
        driver?.let {
            // Update UI with driver data
            etVehicleNumber.setText(it.vehicleNumber)
            etVehicleModel.setText(it.vehicleModel)
            // ... update other fields
        }
    }
}

data class SelectedImages(
    val registration: List<String>,
    val insurance: List<String>,
    val license: List<String>,
    val idProof: List<String>
)
```

---

## 🔧 **Dependencies (build.gradle)**

```gradle
dependencies {
    implementation 'com.squareup.okhttp3:okhttp:4.12.0'
    implementation 'com.google.code.gson:gson:2.10.1'
    implementation 'androidx.lifecycle:lifecycle-viewmodel-ktx:2.7.0'
    implementation 'androidx.lifecycle:lifecycle-runtime-ktx:2.7.0'
    implementation 'org.jetbrains.kotlinx:kotlinx-coroutines-android:1.7.3'
}
```

---

## 📝 **Demo Data for Testing**

```kotlin
// Complete demo data
val demoVehicleData = VehicleData(
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
    )
)

val demoImages = VehicleImages(
    vehicleRegistrationImages = listOf(
        ImageData("file://path/to/registration1.jpg", "image/jpeg", "reg1.jpg"),
        ImageData("file://path/to/registration2.jpg", "image/jpeg", "reg2.jpg")
    ),
    vehicleInsuranceImages = listOf(
        ImageData("file://path/to/insurance.jpg", "image/jpeg", "insurance.jpg")
    ),
    drivingLicenseImages = listOf(
        ImageData("file://path/to/license.jpg", "image/jpeg", "license.jpg")
    ),
    idProofImages = listOf(
        ImageData("file://path/to/aadhaar.jpg", "image/jpeg", "aadhaar.jpg")
    )
)

// Usage
apiService.updateVehicleDetails("0656798311", demoVehicleData, demoImages)
```

---

## 🚀 **Key Features:**

1. **Type Safety**: All data classes with proper null safety
2. **Coroutines**: Async/await pattern for API calls
3. **Error Handling**: Proper Result<T> pattern for error handling
4. **Image Upload**: Support for multiple image types
5. **Flexible**: Can update partial data or complete vehicle information
6. **Modern Kotlin**: Uses latest Kotlin features and best practices

This Kotlin implementation provides a complete, production-ready solution for integrating with your vehicle details API! 🎯
