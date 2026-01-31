# 📸 Image Upload API Documentation

## 🎯 **Overview**

The `updateVehicleDetails` API now supports image uploads for driver documents using Cloudinary and Multer. This allows drivers to upload images for vehicle registration, insurance, driving license, and ID proof documents.

## 🔧 **Setup Requirements**

### **1. Environment Variables**
Add these to your `.env` file:

```env
# Cloudinary Configuration
CLOUDINARY_CLOUD_NAME=your_cloudinary_cloud_name
CLOUDINARY_API_KEY=your_cloudinary_api_key
CLOUDINARY_API_SECRET=your_cloudinary_api_secret
```

### **2. Dependencies Installed**
- `cloudinary`: ^2.5.0 - For cloud image storage
- `multer`: ^1.4.5-lts.1 - For handling multipart form data

## 📡 **API Endpoint**

### **Update Vehicle Details with Image Upload**
```
PUT /api/drivers/vehicle-details
Content-Type: multipart/form-data
```

## 📋 **Request Format**

### **Form Data Fields:**

#### **Vehicle Information (Optional):**
- `driverId` (required) - Driver ID
- `vehicleType` - Auto, Car, Bike, Van
- `vehicleNumber` - Vehicle registration number
- `vehicleModel` - Vehicle model
- `vehicleColor` - Vehicle color
- `vehicleManufacturingYear` - Manufacturing year (1900 to current year + 1)
- `engineNumber` - Engine number
- `chassisNumber` - Chassis number

#### **Vehicle Insurance (Optional):**
- `vehicleInsurance[policyNumber]` - Insurance policy number
- `vehicleInsurance[insuranceCompany]` - Insurance company name
- `vehicleInsurance[insuranceExpiryDate]` - Insurance expiry date
- `vehicleInsurance[insuranceAmount]` - Insurance amount
- `vehicleInsurance[isInsuranceValid]` - Insurance validity status

#### **Image Upload Fields (Optional):**
- `vehicleRegistrationImages` - Array of vehicle registration images (max 5 files)
- `vehicleInsuranceImages` - Array of vehicle insurance images (max 5 files)
- `drivingLicenseImages` - Array of driving license images (max 5 files)
- `idProofImages` - Array of ID proof images (max 5 files)

## 📤 **Image Upload Specifications**

### **File Requirements:**
- **File Types:** Images only (JPEG, PNG, GIF, WebP, etc.)
- **File Size:** Maximum 10MB per file
- **File Count:** Maximum 5 files per field
- **Total Files:** Maximum 10 files per request

### **Cloudinary Storage:**
- **Folder Structure:**
  - `driver-documents/vehicle-registration/` - Vehicle registration images
  - `driver-documents/vehicle-insurance/` - Vehicle insurance images
  - `driver-documents/driving-license/` - Driving license images
  - `driver-documents/id-proof/` - ID proof images

## 📝 **Example Usage**

### **cURL Example:**
```bash
curl -X PUT http://localhost:3000/api/drivers/vehicle-details \
  -F "driverId=0656798311" \
  -F "vehicleType=Car" \
  -F "vehicleModel=Honda City" \
  -F "vehicleManufacturingYear=2020" \
  -F "vehicleRegistrationImages=@/path/to/registration1.jpg" \
  -F "vehicleRegistrationImages=@/path/to/registration2.jpg" \
  -F "drivingLicenseImages=@/path/to/license.jpg"
```

### **JavaScript/Fetch Example:**
```javascript
const formData = new FormData();
formData.append('driverId', '0656798311');
formData.append('vehicleType', 'Car');
formData.append('vehicleModel', 'Honda City');
formData.append('vehicleManufacturingYear', '2020');

// Add images
formData.append('vehicleRegistrationImages', file1);
formData.append('vehicleRegistrationImages', file2);
formData.append('drivingLicenseImages', file3);

const response = await fetch('/api/drivers/vehicle-details', {
  method: 'PUT',
  body: formData
});

const result = await response.json();
console.log(result);
```

### **React Native Example:**
```javascript
import FormData from 'form-data';

const updateVehicleDetails = async (driverId, vehicleData, images) => {
  const formData = new FormData();
  
  formData.append('driverId', driverId);
  formData.append('vehicleType', vehicleData.vehicleType);
  formData.append('vehicleModel', vehicleData.vehicleModel);
  
  // Add images
  if (images.vehicleRegistration) {
    images.vehicleRegistration.forEach(image => {
      formData.append('vehicleRegistrationImages', {
        uri: image.uri,
        type: image.type,
        name: image.fileName
      });
    });
  }
  
  const response = await fetch('/api/drivers/vehicle-details', {
    method: 'PUT',
    body: formData,
    headers: {
      'Content-Type': 'multipart/form-data',
    },
  });
  
  return await response.json();
};
```

## 📊 **Response Format**

### **Success Response (200):**
```json
{
  "success": true,
  "message": "Vehicle details updated successfully",
  "data": {
    "driver": {
      // Complete driver object with all fields
      "vehicleManufacturingYear": 2020,
      "engineNumber": "ENG123456",
      "chassisNumber": "CHS789012",
      "vehicleRegistrationImages": [
        "https://res.cloudinary.com/your-cloud/image/upload/v1234567890/driver-documents/vehicle-registration/reg1.jpg",
        "https://res.cloudinary.com/your-cloud/image/upload/v1234567890/driver-documents/vehicle-registration/reg2.jpg"
      ],
      "drivingLicenseImages": [
        "https://res.cloudinary.com/your-cloud/image/upload/v1234567890/driver-documents/driving-license/license1.jpg"
      ]
    },
    "updatedFields": [
      "vehicleType",
      "vehicleModel",
      "vehicleManufacturingYear",
      "vehicleRegistrationImages",
      "drivingLicenseImages"
    ],
    "vehicleDetails": {
      "vehicleType": "Car",
      "vehicleModel": "Honda City",
      "vehicleManufacturingYear": 2020,
      "engineNumber": "ENG123456",
      "chassisNumber": "CHS789012"
    },
    "documentImages": {
      "vehicleRegistrationImages": ["url1", "url2"],
      "vehicleInsuranceImages": [],
      "drivingLicenseImages": ["url3"],
      "idProofImages": []
    },
    "uploadResults": {
      "vehicleRegistrationImages": ["url1", "url2"],
      "vehicleInsuranceImages": [],
      "drivingLicenseImages": ["url3"],
      "idProofImages": []
    }
  }
}
```

### **Error Responses:**

#### **Missing Driver ID (400):**
```json
{
  "success": false,
  "message": "Missing required field: driverId",
  "data": {
    "missingFields": {
      "driverId": true
    }
  }
}
```

#### **Invalid File Type (400):**
```json
{
  "success": false,
  "message": "Only image files are allowed.",
  "error": "Only image files are allowed!"
}
```

#### **File Too Large (400):**
```json
{
  "success": false,
  "message": "File too large. Maximum size is 10MB.",
  "error": "File too large"
}
```

#### **Driver Not Found (404):**
```json
{
  "success": false,
  "message": "Driver not found",
  "data": {
    "driverId": "0656798311"
  }
}
```

## 🔒 **Security Features**

### **File Validation:**
- Only image files are allowed
- File size limit (10MB per file)
- File count limit (5 files per field, 10 total)
- Automatic file cleanup on error

### **Cloudinary Security:**
- Secure HTTPS URLs
- Automatic image optimization
- Organized folder structure
- Public ID management

## 🚀 **Features**

### **✅ Image Upload:**
- Multiple file upload support
- Automatic Cloudinary integration
- Organized folder structure
- Image optimization

### **✅ Error Handling:**
- Comprehensive validation
- File cleanup on errors
- Detailed error messages
- Graceful failure handling

### **✅ Database Integration:**
- Appends new images to existing arrays
- Preserves existing image URLs
- Complete field validation
- Transaction safety

### **✅ Mobile Ready:**
- Multipart form data support
- Proper headers for mobile apps
- JSON response format
- Error handling for mobile

## 📱 **Mobile App Integration**

### **React Native:**
```javascript
// Install react-native-image-picker for image selection
import { launchImageLibrary } from 'react-native-image-picker';

const selectAndUploadImages = async () => {
  const options = {
    mediaType: 'photo',
    quality: 0.8,
    maxWidth: 1200,
    maxHeight: 1200,
  };
  
  launchImageLibrary(options, async (response) => {
    if (response.assets) {
      const formData = new FormData();
      formData.append('driverId', '0656798311');
      
      response.assets.forEach(asset => {
        formData.append('vehicleRegistrationImages', {
          uri: asset.uri,
          type: asset.type,
          name: asset.fileName
        });
      });
      
      // Upload to API
      const result = await updateVehicleDetails(formData);
      console.log('Upload result:', result);
    }
  });
};
```

### **Flutter:**
```dart
import 'package:image_picker/image_picker.dart';
import 'package:http/http.dart' as http;

Future<void> uploadVehicleImages() async {
  final picker = ImagePicker();
  final images = await picker.pickMultiImage();
  
  var request = http.MultipartRequest(
    'PUT', 
    Uri.parse('http://localhost:3000/api/drivers/vehicle-details')
  );
  
  request.fields['driverId'] = '0656798311';
  
  for (var image in images) {
    request.files.add(await http.MultipartFile.fromPath(
      'vehicleRegistrationImages', 
      image.path
    ));
  }
  
  var response = await request.send();
  var responseData = await response.stream.bytesToString();
  print('Upload result: $responseData');
}
```

## 🎉 **Summary**

The image upload functionality is now fully integrated into the `updateVehicleDetails` API, providing:

1. **✅ Multipart form data support** for file uploads
2. **✅ Cloudinary integration** for cloud storage
3. **✅ Comprehensive validation** for files and data
4. **✅ Error handling** with file cleanup
5. **✅ Mobile app compatibility** with proper headers
6. **✅ Database integration** with image URL storage
7. **✅ Security features** for file validation

**Ready for production use!** 🚀
