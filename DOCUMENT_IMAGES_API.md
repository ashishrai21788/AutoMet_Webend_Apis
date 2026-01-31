# Document Images API Documentation

## 📸 **New Document Image Fields Added**

### **Image Fields:**
- **`vehicleRegistrationImages`** - Array of vehicle registration document image URLs
- **`vehicleInsuranceImages`** - Array of vehicle insurance document image URLs  
- **`drivingLicenseImages`** - Array of driving license document image URLs
- **`idProofImages`** - Array of ID proof document image URLs

## 🔧 **Field Specifications**

### **Data Type:**
- **Type:** Array of Strings
- **Default:** Empty array `[]`
- **Validation:** Each URL must be a non-empty string

### **Validation Rules:**
- Must be an array of strings
- Each URL must be a non-empty string
- URLs are not validated for format (can be any valid URL)

## 📝 **Usage Examples**

### **1. Create Driver with Document Images**
```bash
curl -X POST http://localhost:3000/api/drivers \
  -H "Content-Type: application/json" \
  -d '{
    "firstName": "Alex",
    "lastName": "Wilson",
    "email": "alex.wilson@example.com",
    "phone": "9876543215",
    "password": "password123",
    "vehicleType": "Car",
    "vehicleManufacturingYear": 2022,
    "vehicleRegistrationImages": [
      "https://example.com/images/vehicle_reg_front.jpg",
      "https://example.com/images/vehicle_reg_back.jpg"
    ],
    "drivingLicenseImages": [
      "https://example.com/images/driving_license_front.jpg",
      "https://example.com/images/driving_license_back.jpg"
    ],
    "idProofImages": [
      "https://example.com/images/aadhaar_front.jpg",
      "https://example.com/images/aadhaar_back.jpg"
    ]
  }'
```

### **2. Update Document Images**
```bash
curl -X PUT http://localhost:3000/api/drivers/vehicle-details \
  -H "Content-Type: application/json" \
  -d '{
    "driverId": "8608360022",
    "vehicleInsuranceImages": [
      "https://example.com/images/insurance_policy_1.jpg",
      "https://example.com/images/insurance_policy_2.jpg"
    ],
    "vehicleRegistrationImages": [
      "https://example.com/images/new_reg_front.jpg",
      "https://example.com/images/new_reg_back.jpg"
    ]
  }'
```

### **3. Update Single Image Field**
```bash
curl -X PUT http://localhost:3000/api/drivers/vehicle-details \
  -H "Content-Type: application/json" \
  -d '{
    "driverId": "8608360022",
    "drivingLicenseImages": [
      "https://example.com/images/updated_license.jpg"
    ]
  }'
```

### **4. Clear All Images (Set Empty Array)**
```bash
curl -X PUT http://localhost:3000/api/drivers/vehicle-details \
  -H "Content-Type: application/json" \
  -d '{
    "driverId": "8608360022",
    "vehicleRegistrationImages": [],
    "vehicleInsuranceImages": [],
    "drivingLicenseImages": [],
    "idProofImages": []
  }'
```

## 📊 **Response Format**

### **Success Response (200/201 OK):**
```json
{
  "success": true,
  "message": "Driver created successfully. OTP sent for verification.",
  "data": {
    "driver": {
      // Complete driver object with image fields
      "vehicleRegistrationImages": [
        "https://example.com/images/vehicle_reg_front.jpg",
        "https://example.com/images/vehicle_reg_back.jpg"
      ],
      "vehicleInsuranceImages": [],
      "drivingLicenseImages": [
        "https://example.com/images/driving_license_front.jpg",
        "https://example.com/images/driving_license_back.jpg"
      ],
      "idProofImages": [
        "https://example.com/images/aadhaar_front.jpg",
        "https://example.com/images/aadhaar_back.jpg"
      ]
    }
  }
}
```

### **Update Response with Document Images:**
```json
{
  "success": true,
  "message": "Vehicle details updated successfully",
  "data": {
    "driver": {
      // Complete driver object
    },
    "updatedFields": ["vehicleInsuranceImages"],
    "vehicleDetails": {
      // Vehicle details
    },
    "documentImages": {
      "vehicleRegistrationImages": [
        "https://example.com/images/vehicle_reg_front.jpg",
        "https://example.com/images/vehicle_reg_back.jpg"
      ],
      "vehicleInsuranceImages": [
        "https://example.com/images/insurance_policy_1.jpg",
        "https://example.com/images/insurance_policy_2.jpg"
      ],
      "drivingLicenseImages": [
        "https://example.com/images/driving_license_front.jpg",
        "https://example.com/images/driving_license_back.jpg"
      ],
      "idProofImages": [
        "https://example.com/images/aadhaar_front.jpg",
        "https://example.com/images/aadhaar_back.jpg"
      ]
    }
  }
}
```

### **Error Response (400 Bad Request):**
```json
{
  "success": false,
  "message": "Vehicle registration images must be an array of image URLs"
}
```

## 🎯 **Key Features**

### **✅ Flexible Image Management:**
- Add multiple images per document type
- Update individual image fields
- Clear images by setting empty arrays
- Partial updates supported

### **✅ Validation:**
- Array validation for all image fields
- Non-empty string validation for URLs
- Clear error messages for invalid data

### **✅ Integration:**
- Works with driver creation API
- Works with vehicle details update API
- Backward compatible with existing drivers

## 🔍 **Database Schema**

```javascript
// Document Images (Optional - can be updated later)
vehicleRegistrationImages: {
  type: [String], // Array of image URLs
  default: [],
  validate: {
    validator: function(v) {
      return Array.isArray(v) && v.every(url => typeof url === 'string' && url.trim().length > 0);
    },
    message: 'Vehicle registration images must be an array of valid URLs'
  }
},
vehicleInsuranceImages: {
  type: [String], // Array of image URLs
  default: [],
  validate: {
    validator: function(v) {
      return Array.isArray(v) && v.every(url => typeof url === 'string' && url.trim().length > 0);
    },
    message: 'Vehicle insurance images must be an array of valid URLs'
  }
},
drivingLicenseImages: {
  type: [String], // Array of image URLs
  default: [],
  validate: {
    validator: function(v) {
      return Array.isArray(v) && v.every(url => typeof url === 'string' && url.trim().length > 0);
    },
    message: 'Driving license images must be an array of valid URLs'
  }
},
idProofImages: {
  type: [String], // Array of image URLs
  default: [],
  validate: {
    validator: function(v) {
      return Array.isArray(v) && v.every(url => typeof url === 'string' && url.trim().length > 0);
    },
    message: 'ID proof images must be an array of valid URLs'
  }
}
```

## 🚀 **Use Cases**

### **1. Complete Document Upload During Registration:**
- Driver provides all required documents during signup
- All images are stored immediately
- Ready for verification process

### **2. Gradual Document Upload:**
- Driver signs up with basic info
- Uploads documents later via update API
- Flexible document management

### **3. Document Updates:**
- Replace expired documents
- Add additional images
- Update specific document types

### **4. Document Verification:**
- Admin can access all document images
- Multiple images per document type
- Complete audit trail

## 📱 **Mobile App Integration**

### **Image Upload Flow:**
1. **Capture/Select Images** - Use device camera or gallery
2. **Upload to Server** - Upload images to your image hosting service
3. **Get URLs** - Receive image URLs from upload service
4. **Update Driver** - Send URLs to driver API
5. **Store in Database** - Images are stored as URL arrays

### **Example Mobile Integration:**
```javascript
// After uploading images to your server
const imageUrls = [
  "https://your-server.com/uploads/vehicle_reg_123.jpg",
  "https://your-server.com/uploads/vehicle_reg_124.jpg"
];

// Update driver with image URLs
const response = await fetch('/api/drivers/vehicle-details', {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    driverId: '1234567890',
    vehicleRegistrationImages: imageUrls
  })
});
```

## 🔒 **Security Considerations**

### **Image URL Validation:**
- URLs are stored as provided (no format validation)
- Ensure your image hosting service is secure
- Consider implementing URL validation for your domain

### **Access Control:**
- Implement proper authentication for image access
- Use signed URLs for temporary access
- Consider image compression and optimization

The document images API is now fully functional and ready for use! 📸✨
