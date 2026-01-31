# Vehicle Details API Documentation

## 🚗 **New Vehicle Details Fields Added**

### **Mandatory Field:**
- **`vehicleManufacturingYear`** - Vehicle manufacturing year (required for vehicle registration)

### **Optional Fields:**
- **`engineNumber`** - Vehicle engine number
- **`chassisNumber`** - Vehicle chassis number  
- **`vehicleInsurance`** - Complete insurance details object

## 📋 **Vehicle Insurance Details Structure**

```json
{
  "vehicleInsurance": {
    "policyNumber": "string (optional)",
    "insuranceCompany": "string (optional)", 
    "insuranceExpiryDate": "date (optional)",
    "insuranceAmount": "number (optional)",
    "isInsuranceValid": "boolean (optional)"
  }
}
```

## 🔧 **API Endpoint**

### **Update Vehicle Details**
- **URL:** `PUT /api/drivers/vehicle-details`
- **Content-Type:** `application/json`

### **Request Body:**
```json
{
  "driverId": "string (required)",
  "vehicleType": "string (optional) - Auto|Car|Bike|Van",
  "vehicleNumber": "string (optional)",
  "vehicleModel": "string (optional)",
  "vehicleColor": "string (optional)",
  "vehicleManufacturingYear": "number (optional) - 1900 to current year + 1",
  "engineNumber": "string (optional)",
  "chassisNumber": "string (optional)",
  "vehicleInsurance": {
    "policyNumber": "string (optional)",
    "insuranceCompany": "string (optional)",
    "insuranceExpiryDate": "date (optional)",
    "insuranceAmount": "number (optional)",
    "isInsuranceValid": "boolean (optional)"
  }
}
```

## ✅ **Validation Rules**

### **Vehicle Manufacturing Year:**
- **Range:** 1900 to current year + 1
- **Type:** Number
- **Example:** 2020, 2021, 2022, etc.

### **Vehicle Type:**
- **Valid Values:** Auto, Car, Bike, Van
- **Case Sensitive:** Yes

### **Insurance Amount:**
- **Minimum:** 0
- **Type:** Number

## 📝 **Usage Examples**

### **1. Update Complete Vehicle Details**
```bash
curl -X PUT http://localhost:3000/api/drivers/vehicle-details \
  -H "Content-Type: application/json" \
  -d '{
    "driverId": "0656798311",
    "vehicleType": "Car",
    "vehicleModel": "Honda City",
    "vehicleColor": "White",
    "vehicleManufacturingYear": 2020,
    "engineNumber": "ENG123456789",
    "chassisNumber": "CHS987654321",
    "vehicleInsurance": {
      "policyNumber": "POL123456789",
      "insuranceCompany": "Bajaj Allianz",
      "insuranceExpiryDate": "2025-12-31",
      "insuranceAmount": 15000,
      "isInsuranceValid": true
    }
  }'
```

### **2. Update Only Optional Fields (Skip Manufacturing Year)**
```bash
curl -X PUT http://localhost:3000/api/drivers/vehicle-details \
  -H "Content-Type: application/json" \
  -d '{
    "driverId": "0656798311",
    "engineNumber": "ENG999888777",
    "chassisNumber": "CHS111222333"
  }'
```

### **3. Update Only Insurance Details**
```bash
curl -X PUT http://localhost:3000/api/drivers/vehicle-details \
  -H "Content-Type: application/json" \
  -d '{
    "driverId": "0656798311",
    "vehicleInsurance": {
      "policyNumber": "POL999888777",
      "insuranceCompany": "ICICI Lombard",
      "insuranceExpiryDate": "2026-06-30",
      "insuranceAmount": 20000,
      "isInsuranceValid": true
    }
  }'
```

### **4. Update Only Manufacturing Year**
```bash
curl -X PUT http://localhost:3000/api/drivers/vehicle-details \
  -H "Content-Type: application/json" \
  -d '{
    "driverId": "0656798311",
    "vehicleManufacturingYear": 2022
  }'
```

## 📊 **Response Format**

### **Success Response (200 OK):**
```json
{
  "success": true,
  "message": "Vehicle details updated successfully",
  "data": {
    "driver": {
      // Complete driver object with updated vehicle details
    },
    "updatedFields": ["vehicleType", "vehicleManufacturingYear", "engineNumber"],
    "vehicleDetails": {
      "vehicleType": "Car",
      "vehicleNumber": null,
      "vehicleModel": "Honda City",
      "vehicleColor": "White",
      "vehicleManufacturingYear": 2020,
      "engineNumber": "ENG123456789",
      "chassisNumber": "CHS987654321",
      "vehicleInsurance": {
        "policyNumber": "POL123456789",
        "insuranceCompany": "Bajaj Allianz",
        "insuranceExpiryDate": "2025-12-31T00:00:00.000Z",
        "insuranceAmount": 15000,
        "isInsuranceValid": true
      }
    }
  }
}
```

### **Error Response (400 Bad Request):**
```json
{
  "success": false,
  "message": "Invalid vehicle manufacturing year. Must be between 1900 and current year + 1",
  "data": {
    "vehicleManufacturingYear": 1800,
    "validRange": {
      "min": 1900,
      "max": 2026
    }
  }
}
```

## 🎯 **Key Features**

### **✅ Flexible Updates:**
- Update any combination of fields
- Skip optional fields as needed
- Partial updates supported

### **✅ Validation:**
- Manufacturing year range validation
- Vehicle type enum validation
- Insurance amount minimum validation

### **✅ Driver-Friendly:**
- All optional fields can be skipped
- Only manufacturing year is mandatory
- Clear error messages for validation failures

### **✅ Insurance Management:**
- Complete insurance details tracking
- Policy number, company, expiry date
- Insurance amount and validity status

## 🔍 **Database Schema Updates**

The driver schema now includes:

```javascript
// Vehicle Manufacturing Year (Mandatory field)
vehicleManufacturingYear: {
  type: Number,
  default: null,
  min: 1900,
  max: new Date().getFullYear() + 1,
  validate: {
    validator: function(v) {
      return v === null || (v >= 1900 && v <= new Date().getFullYear() + 1);
    },
    message: 'Vehicle manufacturing year must be between 1900 and current year + 1'
  }
},

// Engine Number (Optional)
engineNumber: {
  type: String,
  default: null,
  trim: true,
},

// Chassis Number (Optional)
chassisNumber: {
  type: String,
  default: null,
  trim: true,
},

// Vehicle Insurance Details (Optional)
vehicleInsurance: {
  policyNumber: { type: String, default: null, trim: true },
  insuranceCompany: { type: String, default: null, trim: true },
  insuranceExpiryDate: { type: Date, default: null },
  insuranceAmount: { type: Number, default: null, min: 0 },
  isInsuranceValid: { type: Boolean, default: false }
}
```

## 🚀 **Getting Started**

### **Option 1: Complete Registration (Recommended)**
1. **Driver Registration:** Driver signs up with basic details AND vehicle information
2. **All Fields:** Driver can provide complete vehicle details during signup
3. **Validation:** Manufacturing year and vehicle type are validated during creation
4. **Ready to Go:** Driver is created with all vehicle details

### **Option 2: Basic Registration + Update Later**
1. **Driver Registration:** Driver signs up with basic details only
2. **Vehicle Details:** Driver updates vehicle information using the update API
3. **Optional Fields:** Driver can skip engine number, chassis number, and insurance details
4. **Mandatory Field:** Driver must provide manufacturing year for vehicle registration
5. **Flexible Updates:** Driver can update any field at any time

## 📝 **Driver Creation with Vehicle Details**

### **Create Driver with Complete Vehicle Details**
```bash
curl -X POST http://localhost:3000/api/drivers \
  -H "Content-Type: application/json" \
  -d '{
    "firstName": "John",
    "lastName": "Doe",
    "email": "john.doe@example.com",
    "phone": "9876543210",
    "password": "password123",
    "vehicleType": "Car",
    "vehicleNumber": "DL01AB1234",
    "vehicleModel": "Toyota Camry",
    "vehicleColor": "Silver",
    "vehicleManufacturingYear": 2021,
    "engineNumber": "ENG123456789",
    "chassisNumber": "CHS987654321",
    "vehicleInsurance": {
      "policyNumber": "POL123456789",
      "insuranceCompany": "HDFC ERGO",
      "insuranceExpiryDate": "2025-12-31",
      "insuranceAmount": 18000,
      "isInsuranceValid": true
    }
  }'
```

### **Create Driver with Basic Information Only**
```bash
curl -X POST http://localhost:3000/api/drivers \
  -H "Content-Type: application/json" \
  -d '{
    "firstName": "Jane",
    "lastName": "Smith",
    "email": "jane.smith@example.com",
    "phone": "9876543211",
    "password": "password123"
  }'
```

### **Create Driver with Partial Vehicle Details**
```bash
curl -X POST http://localhost:3000/api/drivers \
  -H "Content-Type: application/json" \
  -d '{
    "firstName": "Mike",
    "lastName": "Johnson",
    "email": "mike.johnson@example.com",
    "phone": "9876543212",
    "password": "password123",
    "vehicleType": "Bike",
    "vehicleManufacturingYear": 2020,
    "engineNumber": "ENG999888777"
  }'
```

The API is now ready for use with full vehicle details management during driver creation! 🎉
