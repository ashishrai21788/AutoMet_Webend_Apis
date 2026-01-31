# 📸 Kotlin Implementation Guide - Image Upload & Delete APIs

## 🎯 Overview

This guide provides complete Kotlin implementation examples for:
1. **Upload Image to Cloudinary** - `POST /api/images/upload`
2. **Delete Image from Cloudinary** - `DELETE /api/images/delete/:public_id`

---

## 📦 Required Dependencies

Add these to your `build.gradle.kts` (Kotlin DSL) or `build.gradle`:

```kotlin
dependencies {
    // Retrofit for API calls
    implementation("com.squareup.retrofit2:retrofit:2.9.0")
    implementation("com.squareup.retrofit2:converter-gson:2.9.0")
    
    // OkHttp for multipart uploads
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("com.squareup.okhttp3:logging-interceptor:4.12.0")
    
    // Gson for JSON parsing
    implementation("com.google.code.gson:gson:2.10.1")
    
    // Coroutines for async operations
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.7.3")
}
```

---

## 📋 Data Classes

Create these data classes to handle API responses:

```kotlin
// Upload Image Response
data class ImageUploadResponse(
    val success: Boolean? = false,
    val message: String? = "",
    val data: ImageUploadData? = null
)

data class ImageUploadData(
    val url: String? = null,
    val public_id: String? = null,
    val width: Int? = 0,
    val height: Int? = 0,
    val format: String? = null,
    val bytes: Long? = 0,
    val folder: String? = null,
    val uploadedAt: String? = null
)

// Delete Image Response
data class ImageDeleteResponse(
    val success: Boolean? = false,
    val message: String? = "",
    val data: ImageDeleteData? = null
)

data class ImageDeleteData(
    val public_id: String? = null,
    val result: String? = null,
    val deletedAt: String? = null
)

// Error Response
data class ErrorResponse(
    val success: Boolean? = false,
    val message: String? = "",
    val data: ErrorData? = null,
    val error: String? = null
)

data class ErrorData(
    val error: String? = null,
    val public_id: String? = null
)
```

---

## 🔧 API Interface (Retrofit)

Create an interface for API endpoints:

```kotlin
import okhttp3.MultipartBody
import okhttp3.RequestBody
import retrofit2.Call
import retrofit2.http.*

interface ImageApiService {
    
    @Multipart
    @POST("images/upload")
    fun uploadImage(
        @Part image: MultipartBody.Part,
        @Part("folder") folder: RequestBody?
    ): Call<ImageUploadResponse>
    
    @DELETE("images/delete/{public_id}")
    fun deleteImage(
        @Path("public_id") publicId: String
    ): Call<ImageDeleteResponse>
}
```

---

## 🚀 Implementation - Method 1: Using Retrofit (Recommended)

### **Step 1: Setup Retrofit Client**

```kotlin
import okhttp3.OkHttpClient
import okhttp3.logging.HttpLoggingInterceptor
import retrofit2.Retrofit
import retrofit2.converter.gson.GsonConverterFactory
import java.util.concurrent.TimeUnit

object ApiClient {
    private const val BASE_URL = "http://172.16.8.65:3000/api/"
    
    private val loggingInterceptor = HttpLoggingInterceptor().apply {
        level = HttpLoggingInterceptor.Level.BODY
    }
    
    private val okHttpClient = OkHttpClient.Builder()
        .addInterceptor(loggingInterceptor)
        .connectTimeout(30, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .writeTimeout(30, TimeUnit.SECONDS)
        .build()
    
    private val retrofit = Retrofit.Builder()
        .baseUrl(BASE_URL)
        .client(okHttpClient)
        .addConverterFactory(GsonConverterFactory.create())
        .build()
    
    val imageApiService: ImageApiService = retrofit.create(ImageApiService::class.java)
}
```

### **Step 2: Image Upload Function**

```kotlin
import android.net.Uri
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.MultipartBody
import okhttp3.RequestBody.Companion.asRequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.File

class ImageUploadManager {
    
    /**
     * Upload image to Cloudinary
     * @param imageFile File object of the image
     * @param folder Optional folder path in Cloudinary (default: "driver-documents")
     * @param callback Callback with upload result
     */
    fun uploadImage(
        imageFile: File,
        folder: String? = "driver-documents",
        callback: (ImageUploadResponse?, Error?) -> Unit
    ) {
        // Create multipart request body for image
        val requestFile = imageFile.asRequestBody("image/*".toMediaTypeOrNull())
        val imagePart = MultipartBody.Part.createFormData("image", imageFile.name, requestFile)
        
        // Create request body for folder (optional)
        val folderBody = folder?.toRequestBody("text/plain".toMediaTypeOrNull())
        
        // Make API call
        val call = ApiClient.imageApiService.uploadImage(imagePart, folderBody)
        
        call.enqueue(object : retrofit2.Callback<ImageUploadResponse> {
            override fun onResponse(
                call: retrofit2.Call<ImageUploadResponse>,
                response: retrofit2.Response<ImageUploadResponse>
            ) {
                if (response.isSuccessful) {
                    callback(response.body(), null)
                } else {
                    val errorBody = response.errorBody()?.string()
                    callback(null, Exception("Upload failed: $errorBody"))
                }
            }
            
            override fun onFailure(call: retrofit2.Call<ImageUploadResponse>, t: Throwable) {
                callback(null, t)
            }
        })
    }
    
    /**
     * Upload image from URI (for Android)
     * @param imageUri URI of the image
     * @param folder Optional folder path
     * @param callback Callback with upload result
     */
    fun uploadImageFromUri(
        imageUri: Uri,
        context: android.content.Context,
        folder: String? = "driver-documents",
        callback: (ImageUploadResponse?, Error?) -> Unit
    ) {
        try {
            // Convert URI to File
            val inputStream = context.contentResolver.openInputStream(imageUri)
            val file = File(context.cacheDir, "temp_image_${System.currentTimeMillis()}.jpg")
            
            inputStream?.use { input ->
                file.outputStream().use { output ->
                    input.copyTo(output)
                }
            }
            
            uploadImage(file, folder, callback)
        } catch (e: Exception) {
            callback(null, e)
        }
    }
}
```

### **Step 3: Image Delete Function**

```kotlin
class ImageDeleteManager {
    
    /**
     * Delete image from Cloudinary
     * @param publicId Cloudinary public_id of the image
     * @param callback Callback with delete result
     */
    fun deleteImage(
        publicId: String,
        callback: (ImageDeleteResponse?, Error?) -> Unit
    ) {
        // URL encode the public_id
        val encodedPublicId = java.net.URLEncoder.encode(publicId, "UTF-8")
        
        // Make API call
        val call = ApiClient.imageApiService.deleteImage(encodedPublicId)
        
        call.enqueue(object : retrofit2.Callback<ImageDeleteResponse> {
            override fun onResponse(
                call: retrofit2.Call<ImageDeleteResponse>,
                response: retrofit2.Response<ImageDeleteResponse>
            ) {
                if (response.isSuccessful) {
                    callback(response.body(), null)
                } else {
                    val errorBody = response.errorBody()?.string()
                    callback(null, Exception("Delete failed: $errorBody"))
                }
            }
            
            override fun onFailure(call: retrofit2.Call<ImageDeleteResponse>, t: Throwable) {
                callback(null, t)
            }
        })
    }
}
```

---

## 🔄 Implementation - Method 2: Using Coroutines (Modern Approach)

### **Updated API Interface with Suspend Functions**

```kotlin
import okhttp3.MultipartBody
import okhttp3.RequestBody
import retrofit2.http.*

interface ImageApiService {
    
    @Multipart
    @POST("images/upload")
    suspend fun uploadImage(
        @Part image: MultipartBody.Part,
        @Part("folder") folder: RequestBody?
    ): ImageUploadResponse
    
    @DELETE("images/delete/{public_id}")
    suspend fun deleteImage(
        @Path("public_id") publicId: String
    ): ImageDeleteResponse
}
```

### **Coroutine-based Upload Function**

```kotlin
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File

class ImageUploadRepository {
    
    suspend fun uploadImage(
        imageFile: File,
        folder: String? = "driver-documents"
    ): Result<ImageUploadResponse> {
        return withContext(Dispatchers.IO) {
            try {
                val requestFile = imageFile.asRequestBody("image/*".toMediaTypeOrNull())
                val imagePart = MultipartBody.Part.createFormData("image", imageFile.name, requestFile)
                val folderBody = folder?.toRequestBody("text/plain".toMediaTypeOrNull())
                
                val response = ApiClient.imageApiService.uploadImage(imagePart, folderBody)
                Result.success(response)
            } catch (e: Exception) {
                Result.failure(e)
            }
        }
    }
    
    suspend fun deleteImage(publicId: String): Result<ImageDeleteResponse> {
        return withContext(Dispatchers.IO) {
            try {
                val encodedPublicId = java.net.URLEncoder.encode(publicId, "UTF-8")
                val response = ApiClient.imageApiService.deleteImage(encodedPublicId)
                Result.success(response)
            } catch (e: Exception) {
                Result.failure(e)
            }
        }
    }
}
```

### **Usage in ViewModel or Activity**

```kotlin
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.launch

class ImageViewModel : ViewModel() {
    private val repository = ImageUploadRepository()
    
    fun uploadImage(imageFile: File, folder: String? = null) {
        viewModelScope.launch {
            repository.uploadImage(imageFile, folder)
                .onSuccess { response ->
                    // Handle success
                    val imageUrl = response.data?.url
                    val publicId = response.data?.public_id
                    println("Upload successful! URL: $imageUrl, Public ID: $publicId")
                }
                .onFailure { error ->
                    // Handle error
                    println("Upload failed: ${error.message}")
                }
        }
    }
    
    fun deleteImage(publicId: String) {
        viewModelScope.launch {
            repository.deleteImage(publicId)
                .onSuccess { response ->
                    // Handle success
                    println("Delete successful! Result: ${response.data?.result}")
                }
                .onFailure { error ->
                    // Handle error
                    println("Delete failed: ${error.message}")
                }
        }
    }
}
```

---

## 📱 Complete Android Activity Example

```kotlin
import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.widget.Button
import android.widget.ImageView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import java.io.File

class ImageUploadActivity : AppCompatActivity() {
    
    private lateinit var uploadButton: Button
    private lateinit var deleteButton: Button
    private lateinit var imageView: ImageView
    private val imageUploadManager = ImageUploadManager()
    private val imageDeleteManager = ImageDeleteManager()
    
    private var uploadedPublicId: String? = null
    private var uploadedImageUrl: String? = null
    
    companion object {
        private const val PICK_IMAGE_REQUEST = 1001
    }
    
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_image_upload)
        
        uploadButton = findViewById(R.id.btnUpload)
        deleteButton = findViewById(R.id.btnDelete)
        imageView = findViewById(R.id.imageView)
        
        uploadButton.setOnClickListener {
            pickImage()
        }
        
        deleteButton.setOnClickListener {
            uploadedPublicId?.let { publicId ->
                deleteImage(publicId)
            } ?: run {
                Toast.makeText(this, "No image uploaded yet", Toast.LENGTH_SHORT).show()
            }
        }
    }
    
    private fun pickImage() {
        val intent = Intent(Intent.ACTION_PICK)
        intent.type = "image/*"
        startActivityForResult(intent, PICK_IMAGE_REQUEST)
    }
    
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        
        if (requestCode == PICK_IMAGE_REQUEST && resultCode == Activity.RESULT_OK) {
            data?.data?.let { uri ->
                imageView.setImageURI(uri)
                uploadImage(uri)
            }
        }
    }
    
    private fun uploadImage(imageUri: Uri) {
        uploadButton.isEnabled = false
        uploadButton.text = "Uploading..."
        
        imageUploadManager.uploadImageFromUri(
            imageUri = imageUri,
            context = this,
            folder = "driver-documents/profile-photos"
        ) { response, error ->
            runOnUiThread {
                uploadButton.isEnabled = true
                uploadButton.text = "Upload Image"
                
                if (error != null) {
                    Toast.makeText(this, "Upload failed: ${error.message}", Toast.LENGTH_LONG).show()
                } else if (response?.success == true) {
                    uploadedPublicId = response.data?.public_id
                    uploadedImageUrl = response.data?.url
                    
                    Toast.makeText(
                        this,
                        "Upload successful!\nURL: ${response.data?.url}",
                        Toast.LENGTH_LONG
                    ).show()
                    
                    deleteButton.isEnabled = true
                } else {
                    Toast.makeText(this, "Upload failed: ${response?.message}", Toast.LENGTH_LONG).show()
                }
            }
        }
    }
    
    private fun deleteImage(publicId: String) {
        deleteButton.isEnabled = false
        deleteButton.text = "Deleting..."
        
        imageDeleteManager.deleteImage(publicId) { response, error ->
            runOnUiThread {
                deleteButton.isEnabled = true
                deleteButton.text = "Delete Image"
                
                if (error != null) {
                    Toast.makeText(this, "Delete failed: ${error.message}", Toast.LENGTH_LONG).show()
                } else if (response?.success == true) {
                    uploadedPublicId = null
                    uploadedImageUrl = null
                    imageView.setImageResource(0)
                    
                    Toast.makeText(this, "Image deleted successfully", Toast.LENGTH_SHORT).show()
                } else {
                    Toast.makeText(this, "Delete failed: ${response?.message}", Toast.LENGTH_LONG).show()
                }
            }
        }
    }
}
```

---

## 🎯 Quick Usage Examples

### **Example 1: Upload Image from File**

```kotlin
val imageFile = File("/path/to/image.jpg")
val uploadManager = ImageUploadManager()

uploadManager.uploadImage(
    imageFile = imageFile,
    folder = "driver-documents/profile-photos"
) { response, error ->
    if (error == null && response?.success == true) {
        val imageUrl = response.data?.url
        val publicId = response.data?.public_id
        
        // Save publicId and URL to database
        println("Image URL: $imageUrl")
        println("Public ID: $publicId")
    } else {
        println("Error: ${error?.message}")
    }
}
```

### **Example 2: Delete Image**

```kotlin
val publicId = "driver-documents/profile-photos/abc123xyz"
val deleteManager = ImageDeleteManager()

deleteManager.deleteImage(publicId) { response, error ->
    if (error == null && response?.success == true) {
        println("Image deleted successfully")
    } else {
        println("Error: ${error?.message}")
    }
}
```

### **Example 3: Using Coroutines**

```kotlin
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch

val repository = ImageUploadRepository()

// Upload
CoroutineScope(Dispatchers.Main).launch {
    val imageFile = File("/path/to/image.jpg")
    repository.uploadImage(imageFile, "driver-documents/profile-photos")
        .onSuccess { response ->
            println("URL: ${response.data?.url}")
            println("Public ID: ${response.data?.public_id}")
        }
        .onFailure { error ->
            println("Error: ${error.message}")
        }
}

// Delete
CoroutineScope(Dispatchers.Main).launch {
    repository.deleteImage("driver-documents/profile-photos/abc123xyz")
        .onSuccess { response ->
            println("Deleted: ${response.data?.result}")
        }
        .onFailure { error ->
            println("Error: ${error.message}")
        }
}
```

---

## ⚠️ Important Notes for Client

1. **Base URL:** Update `BASE_URL` in `ApiClient` to match your server IP/domain
2. **File Size:** Maximum 10MB per image
3. **File Types:** Only image files (JPEG, PNG, GIF, WebP, etc.)
4. **Public ID Encoding:** Always URL-encode `public_id` when deleting
5. **Error Handling:** Always check `response.success` before using data
6. **Network Permissions:** Add internet permission in `AndroidManifest.xml`:
   ```xml
   <uses-permission android:name="android.permission.INTERNET" />
   ```

---

## 🔍 Testing

### **Test Upload:**
```kotlin
val testFile = File(context.filesDir, "test_image.jpg")
// Create or copy a test image to testFile
uploadManager.uploadImage(testFile, "test-uploads")
```

### **Test Delete:**
```kotlin
// Use public_id from upload response
deleteManager.deleteImage("test-uploads/[public_id_from_upload]")
```

---

**Last Updated:** December 27, 2024


