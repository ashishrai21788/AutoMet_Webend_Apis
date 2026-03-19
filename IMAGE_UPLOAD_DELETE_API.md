# 📸 Image Upload & Delete API Documentation

## 🎯 Overview

Two new APIs have been created for direct image management with Cloudinary:
1. **Upload Image** - Upload a single image to Cloudinary and get URL + public_id
2. **Delete Image** - Delete an image from Cloudinary using public_id

---

## 📤 API 1: Upload Image to Cloudinary

### **Endpoint:**
```
POST /api/images/upload
```

### **Content-Type:**
```
multipart/form-data
```

### **Request Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `image` | File | Yes | Image file to upload (max 10MB) |
| `folder` | String | No | Cloudinary folder path (default: `driver-documents`) |

### **File Requirements:**
- **File Types:** Images only (JPEG, PNG, GIF, WebP, etc.)
- **File Size:** Maximum 10MB
- **Field Name:** `image`

---

## 📝 Demo Request Examples

### **1. cURL Example:**
```bash
curl -X POST http://localhost:3000/api/images/upload \
  -F "image=@/Users/ashish/Desktop/image.jpg" \
  -F "folder=driver-documents/profile-photos"
```

### **2. JavaScript/Fetch Example:**
```javascript
const formData = new FormData();
formData.append('image', fileInput.files[0]);
formData.append('folder', 'driver-documents/profile-photos');

const response = await fetch('http://localhost:3000/api/images/upload', {
  method: 'POST',
  body: formData
});

const result = await response.json();
console.log('Upload Result:', result);
```

### **3. React Native Example:**
```javascript
import FormData from 'form-data';
import { launchImageLibrary } from 'react-native-image-picker';

const uploadImage = async () => {
  const result = await launchImageLibrary({
    mediaType: 'photo',
    quality: 0.8,
  });

  if (result.assets && result.assets[0]) {
    const formData = new FormData();
    formData.append('image', {
      uri: result.assets[0].uri,
      type: 'image/jpeg',
      name: 'image.jpg',
    });
    formData.append('folder', 'driver-documents/profile-photos');

    const response = await fetch('http://172.16.8.65:3000/api/images/upload', {
      method: 'POST',
      body: formData,
      headers: {
        'Content-Type': 'multipart/form-data',
      },
    });

    const data = await response.json();
    console.log('Upload Result:', data);
    return data;
  }
};
```

### **4. Postman Example:**
1. Method: `POST`
2. URL: `http://localhost:3000/api/images/upload`
3. Body → form-data:
   - Key: `image` (Type: File) → Select file
   - Key: `folder` (Type: Text) → `driver-documents/profile-photos`

---

## ✅ Success Response (200 OK)

```json
{
  "success": true,
  "message": "Image uploaded successfully to Cloudinary",
  "data": {
    "url": "https://res.cloudinary.com/your_cloud_name/image/upload/v1761289512/driver-documents/profile-photos/abc123xyz.jpg",
    "public_id": "driver-documents/profile-photos/abc123xyz",
    "width": 1920,
    "height": 1080,
    "format": "jpg",
    "bytes": 245678,
    "folder": "driver-documents/profile-photos",
    "uploadedAt": "2024-12-27T10:30:00.000Z"
  }
}
```

### **Response Fields:**

| Field | Type | Description |
|-------|------|-------------|
| `url` | String | HTTPS URL of the uploaded image |
| `public_id` | String | Cloudinary public_id (use for deletion) |
| `width` | Number | Image width in pixels |
| `height` | Number | Image height in pixels |
| `format` | String | Image format (jpg, png, etc.) |
| `bytes` | Number | File size in bytes |
| `folder` | String | Cloudinary folder where image is stored |
| `uploadedAt` | String | ISO timestamp of upload |

---

## ❌ Error Responses

### **400 Bad Request - No File:**
```json
{
  "success": false,
  "message": "No image file provided",
  "data": {
    "error": "Please provide an image file in the request"
  }
}
```

### **400 Bad Request - File Too Large:**
```json
{
  "success": false,
  "message": "File too large. Maximum size is 10MB.",
  "error": "File size exceeds 10MB limit"
}
```

### **400 Bad Request - Invalid File Type:**
```json
{
  "success": false,
  "message": "Only image files are allowed.",
  "error": "Only image files are allowed!"
}
```

### **500 Server Error - Cloudinary Upload Failed:**
```json
{
  "success": false,
  "message": "Failed to upload image to Cloudinary",
  "data": {
    "error": "Cloudinary API error message"
  }
}
```

---

## 🗑️ API 2: Delete Image from Cloudinary

### **Endpoint:**
```
DELETE /api/images/delete/:public_id
```

### **URL Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `public_id` | String | Yes | Cloudinary public_id of the image |

**Note:** The `public_id` should be URL-encoded if it contains special characters.

---

## 📝 Demo Request Examples

### **1. cURL Example:**
```bash
# Simple public_id
curl -X DELETE http://localhost:3000/api/images/delete/driver-documents/profile-photos/abc123xyz

# With URL encoding (if public_id has special characters)
curl -X DELETE "http://localhost:3000/api/images/delete/driver-documents%2Fprofile-photos%2Fabc123xyz"
```

### **2. JavaScript/Fetch Example:**
```javascript
const publicId = 'driver-documents/profile-photos/abc123xyz';

const response = await fetch(`http://localhost:3000/api/images/delete/${encodeURIComponent(publicId)}`, {
  method: 'DELETE'
});

const result = await response.json();
console.log('Delete Result:', result);
```

### **3. React Native Example:**
```javascript
const deleteImage = async (publicId) => {
  const encodedPublicId = encodeURIComponent(publicId);
  
  const response = await fetch(`http://172.16.8.65:3000/api/images/delete/${encodedPublicId}`, {
    method: 'DELETE',
  });

  const data = await response.json();
  console.log('Delete Result:', data);
  return data;
};

// Usage
deleteImage('driver-documents/profile-photos/abc123xyz');
```

### **4. Postman Example:**
1. Method: `DELETE`
2. URL: `http://localhost:3000/api/images/delete/driver-documents/profile-photos/abc123xyz`

---

## ✅ Success Response (200 OK)

```json
{
  "success": true,
  "message": "Image deleted successfully from Cloudinary",
  "data": {
    "public_id": "driver-documents/profile-photos/abc123xyz",
    "result": "ok",
    "deletedAt": "2024-12-27T10:35:00.000Z"
  }
}
```

### **Response Fields:**

| Field | Type | Description |
|-------|------|-------------|
| `public_id` | String | The public_id that was deleted |
| `result` | String | Deletion result (`ok` = success, `not found` = image doesn't exist) |
| `deletedAt` | String | ISO timestamp of deletion |

---

## ❌ Error Responses

### **400 Bad Request - Missing public_id:**
```json
{
  "success": false,
  "message": "Missing required parameter: public_id",
  "data": {
    "missingFields": {
      "public_id": true
    }
  }
}
```

### **500 Server Error - Delete Failed:**
```json
{
  "success": false,
  "message": "Failed to delete image from Cloudinary",
  "data": {
    "error": "Cloudinary API error message",
    "public_id": "driver-documents/profile-photos/abc123xyz"
  }
}
```

---

## 🔄 Complete Workflow Example

### **Step 1: Upload Image**
```bash
curl -X POST http://localhost:3000/api/images/upload \
  -F "image=@/path/to/image.jpg" \
  -F "folder=driver-documents/profile-photos"
```

**Response:**
```json
{
  "success": true,
  "message": "Image uploaded successfully to Cloudinary",
  "data": {
    "url": "https://res.cloudinary.com/your_cloud_name/image/upload/v1761289512/driver-documents/profile-photos/abc123xyz.jpg",
    "public_id": "driver-documents/profile-photos/abc123xyz",
    "width": 1920,
    "height": 1080,
    "format": "jpg",
    "bytes": 245678,
    "folder": "driver-documents/profile-photos",
    "uploadedAt": "2024-12-27T10:30:00.000Z"
  }
}
```

### **Step 2: Save public_id and URL**
Save the `public_id` and `url` in your database for future reference.

### **Step 3: Delete Image (if needed)**
```bash
curl -X DELETE http://localhost:3000/api/images/delete/driver-documents/profile-photos/abc123xyz
```

**Response:**
```json
{
  "success": true,
  "message": "Image deleted successfully from Cloudinary",
  "data": {
    "public_id": "driver-documents/profile-photos/abc123xyz",
    "result": "ok",
    "deletedAt": "2024-12-27T10:35:00.000Z"
  }
}
```

---

## 📋 Important Notes

1. **Temporary Files:** Images are temporarily stored locally during upload, then automatically deleted after Cloudinary upload
2. **Public ID Format:** The `public_id` includes the folder path (e.g., `driver-documents/profile-photos/abc123xyz`)
3. **URL Encoding:** Always URL-encode the `public_id` when using it in DELETE requests
4. **Image Optimization:** Cloudinary automatically optimizes images (max 1200x1200px, auto quality)
5. **HTTPS URLs:** All returned URLs use HTTPS for security

---

## 🚀 Quick Test

### **Test Upload:**
```bash
# Create a test image or use an existing one
curl -X POST http://localhost:3000/api/images/upload \
  -F "image=@test.jpg" \
  -F "folder=test-uploads"
```

### **Test Delete:**
```bash
# Use the public_id from upload response
curl -X DELETE http://localhost:3000/api/images/delete/test-uploads/[public_id_from_upload]
```

---

**Last Updated:** December 27, 2024

