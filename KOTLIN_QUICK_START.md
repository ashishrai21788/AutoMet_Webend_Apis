# 🚀 Kotlin Quick Start Guide - Image Upload & Delete APIs

## 📋 Quick Summary for Client

### **APIs Available:**
1. **Upload Image:** `POST /api/images/upload`
2. **Delete Image:** `DELETE /api/images/delete/:public_id`

### **Base URL:**
```
http://172.16.8.65:3000/api
```

---

## ⚡ Quick Implementation (5 Minutes)

### **Step 1: Add Dependencies**

```kotlin
// build.gradle.kts
dependencies {
    implementation("com.squareup.retrofit2:retrofit:2.9.0")
    implementation("com.squareup.retrofit2:converter-gson:2.9.0")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("com.google.code.gson:gson:2.10.1")
}
```

### **Step 2: Data Classes**

```kotlin
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
```

### **Step 3: API Interface**

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

### **Step 4: Retrofit Setup**

```kotlin
import retrofit2.Retrofit
import retrofit2.converter.gson.GsonConverterFactory

object ApiClient {
    private const val BASE_URL = "http://172.16.8.65:3000/api/"
    
    private val retrofit = Retrofit.Builder()
        .baseUrl(BASE_URL)
        .addConverterFactory(GsonConverterFactory.create())
        .build()
    
    val imageApiService: ImageApiService = retrofit.create(ImageApiService::class.java)
}
```

### **Step 5: Upload Function**

```kotlin
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.MultipartBody
import okhttp3.RequestBody.Companion.asRequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.File

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
```

### **Step 6: Delete Function**

```kotlin
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
```

### **Step 7: Usage**

```kotlin
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch

// Upload
CoroutineScope(Dispatchers.Main).launch {
    val imageFile = File("/path/to/image.jpg")
    uploadImage(imageFile, "driver-documents/profile-photos")
        .onSuccess { response ->
            println("URL: ${response.data?.url}")
            println("Public ID: ${response.data?.public_id}")
            // Save public_id for later deletion
        }
        .onFailure { error ->
            println("Error: ${error.message}")
        }
}

// Delete
CoroutineScope(Dispatchers.Main).launch {
    deleteImage("driver-documents/profile-photos/abc123xyz")
        .onSuccess { response ->
            println("Deleted: ${response.data?.result}")
        }
        .onFailure { error ->
            println("Error: ${error.message}")
        }
}
```

---

## 📱 Android Example (Complete)

```kotlin
class ImageUploadActivity : AppCompatActivity() {
    
    private fun uploadImage(uri: Uri) {
        // Convert URI to File
        val file = File(cacheDir, "temp_${System.currentTimeMillis()}.jpg")
        contentResolver.openInputStream(uri)?.use { input ->
            file.outputStream().use { output ->
                input.copyTo(output)
            }
        }
        
        // Upload
        lifecycleScope.launch {
            uploadImage(file, "driver-documents/profile-photos")
                .onSuccess { response ->
                    runOnUiThread {
                        Toast.makeText(
                            this@ImageUploadActivity,
                            "Uploaded! URL: ${response.data?.url}",
                            Toast.LENGTH_LONG
                        ).show()
                    }
                }
                .onFailure { error ->
                    runOnUiThread {
                        Toast.makeText(
                            this@ImageUploadActivity,
                            "Error: ${error.message}",
                            Toast.LENGTH_LONG
                        ).show()
                    }
                }
        }
    }
}
```

---

## 📚 Full Documentation

For complete implementation details, examples, and best practices, see:
- **`KOTLIN_IMAGE_UPLOAD_GUIDE.md`** - Complete guide with all examples

---

## ⚠️ Important Notes

1. **Base URL:** Update to your server IP/domain
2. **File Size:** Max 10MB per image
3. **File Types:** Images only (JPEG, PNG, GIF, WebP)
4. **Public ID:** Always URL-encode when deleting
5. **Permissions:** Add internet permission in AndroidManifest.xml

---

**Need Help?** Check the full guide: `KOTLIN_IMAGE_UPLOAD_GUIDE.md`


