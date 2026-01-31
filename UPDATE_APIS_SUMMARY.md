# Update APIs Summary

This document lists all APIs responsible for updating records, including their endpoints and accepted keys/fields.

---

## 1. Update Driver Profile
**Endpoint:** `PUT /api/drivers/profile`

**Description:** Updates driver's basic profile information (firstName, lastName, profilePhoto)

**Request Body Keys:**
```json
{
  "driverId": "string (required)",
  "firstName": "string (optional)",
  "lastName": "string (optional)",
  "profilePhoto": "string (optional)"
}
```

**Notes:**
- At least one of `firstName`, `lastName`, or `profilePhoto` must be provided
- All fields are optional individually, but at least one must be present
- Fields cannot be empty strings

**Example Request:**
```json
{
  "driverId": "0656798311",
  "firstName": "Ashish",
  "lastName": "Rai",
  "profilePhoto": "https://res.cloudinary.com/.../profile.jpg"
}
```

---

## 2. Update Vehicle Details
**Endpoint:** `PUT /api/drivers/vehicle-details`

**Description:** Updates vehicle information, license details, and document images

**Request Body Keys:**
```json
{
  "driverId": "string (required)",
  "vehicleData": {
    "vehicleType": "string (optional) - enum: ['Auto', 'Car', 'Bike', 'Van']",
    "vehicleNumber": "string (optional)",
    "vehicleModel": "string (optional)",
    "vehicleColor": "string (optional)",
    "vehicleManufacturingYear": "number|string (optional) - range: 1900 to current year + 1",
    "engineNumber": "string (optional)",
    "chassisNumber": "string (optional)",
    "vehicleInsurance": {
      "policyNumber": "string (optional)",
      "insuranceCompany": "string (optional)",
      "insuranceExpiryDate": "string|Date (optional) - ISO date format",
      "insuranceAmount": "number (optional)",
      "isInsuranceValid": "boolean (optional)"
    }
  },
  "licenseData": {
    "license_number": "string (optional)",
    "license_type": "string (optional)",
    "drivingLicenseIssueDate": "string (optional) - ISO date format",
    "expiry_date": "string (optional) - ISO date format",
    "drivingLicenseIssuingAuthority": "string (optional)"
  },
  "vehicleRegistrationImages": [
    {
      "url": "string (required)",
      "publicId": "string (required)"
    }
  ],
  "vehicleInsuranceImages": [
    {
      "url": "string (required)",
      "publicId": "string (required)"
    }
  ],
  "insurance": [
    {
      "url": "string (required)",
      "publicId": "string (required)"
    }
  ],
  "drivingLicenseImages": [
    {
      "url": "string (required)",
      "publicId": "string (required)"
    }
  ],
  "idProofImages": [
    {
      "url": "string (required)",
      "publicId": "string (required)"
    }
  ],
  "id_proof_type": "string (optional)"
}
```

**Notes:**
- `insurance` is an alias for `vehicleInsuranceImages` (both work)
- Image arrays **replace** existing images completely (not merged)
- Image format: Array of objects with `{url, publicId}` structure
- All fields in `vehicleData` and `licenseData` are optional
- Date fields accept ISO date strings (e.g., "2025-12-31" or "2025-12-31T00:00:00.000Z")

**Example Request:**
```json
{
  "driverId": "0656798311",
  "vehicleData": {
    "vehicleType": "Car",
    "vehicleNumber": "DL01AB1234",
    "vehicleModel": "Bajaj RE",
    "vehicleManufacturingYear": "2025",
    "vehicleColor": "White",
    "engineNumber": "ENG123456",
    "chassisNumber": "CHS123456",
    "vehicleInsurance": {
      "policyNumber": "POL123456",
      "insuranceExpiryDate": "2025-09-17"
    }
  },
  "licenseData": {
    "license_number": "DL123456789",
    "license_type": "LMV",
    "drivingLicenseIssueDate": "2020-01-15",
    "expiry_date": "2027-12-31",
    "drivingLicenseIssuingAuthority": "RTO Delhi"
  },
  "vehicleRegistrationImages": [
    {
      "url": "https://res.cloudinary.com/.../reg1.jpg",
      "publicId": "driver-documents/vehicle-registration/abc123"
    }
  ],
  "drivingLicenseImages": [
    {
      "url": "https://res.cloudinary.com/.../license1.jpg",
      "publicId": "driver-documents/driving-license/xyz789"
    }
  ],
  "insurance": [
    {
      "url": "https://res.cloudinary.com/.../insurance1.jpg",
      "publicId": "driver-documents/vehicle-insurance/def456"
    }
  ],
  "idProofImages": [
    {
      "url": "https://res.cloudinary.com/.../idproof1.jpg",
      "publicId": "driver-documents/id-proof/ghi789"
    }
  ],
  "id_proof_type": "Aadhaar"
}
```

---

## 3. Update Online Status
**Endpoint:** `PUT /api/drivers/online-status`

**Description:** Updates driver's online status and booking mode

**Request Body Keys:**
```json
{
  "driverId": "string (required)",
  "isOnline": "boolean (optional)",
  "onlineAs": "number (optional) - enum: [0, 1]"
}
```

**Notes:**
- `onlineAs`: 0 = Public booking, 1 = Private booking
- At least one of `isOnline` or `onlineAs` should be provided
- `lastActive` is automatically updated to current timestamp

**Example Request:**
```json
{
  "driverId": "0656798311",
  "isOnline": true,
  "onlineAs": 0
}
```

---

## 4. Update Issue Status
**Endpoint:** `PUT /api/drivers/issues/:issueId`

**Description:** Updates the status of a driver issue report (admin function)

**URL Parameters:**
- `issueId`: MongoDB ObjectId (required)

**Request Body Keys:**
```json
{
  "status": "string (required) - enum: ['issue submitted', 'under process', 'complete']",
  "adminNotes": "string (optional)"
}
```

**Notes:**
- `resolvedAt` is automatically set when status is changed to 'complete'
- `updatedAt` is automatically updated

**Example Request:**
```json
{
  "status": "under process",
  "adminNotes": "Issue is being investigated"
}
```

**Example URL:**
```
PUT /api/drivers/issues/507f1f77bcf86cd799439011
```

---

## 5. Generic Update Record (Dynamic)
**Endpoint:** `PUT /api/:collectionName/:id`

**Description:** Generic update endpoint for any MongoDB collection

**URL Parameters:**
- `collectionName`: Name of the MongoDB collection (required)
- `id`: MongoDB ObjectId of the record to update (required)

**Request Body Keys:**
```json
{
  // Any fields from the collection's schema
  // All fields are optional
  // Updates are merged with existing data
}
```

**Notes:**
- This is a generic endpoint that accepts any fields
- Updates are merged with existing data (not replaced)
- Validates against the collection's schema
- Returns error if duplicate unique fields (e.g., phone/email for drivers)

**Example Request:**
```json
PUT /api/drivers/507f1f77bcf86cd799439011
{
  "firstName": "John",
  "vehicleType": "Car"
}
```

**Example Request (Other Collection):**
```json
PUT /api/users/507f1f77bcf86cd799439011
{
  "name": "Jane Doe",
  "email": "jane@example.com"
}
```

---

## Summary Table

| API Endpoint | Method | Required Keys | Optional Keys | Notes |
|-------------|--------|--------------|---------------|-------|
| `/api/drivers/profile` | PUT | `driverId` | `firstName`, `lastName`, `profilePhoto` | At least one optional key required |
| `/api/drivers/vehicle-details` | PUT | `driverId` | All fields in `vehicleData`, `licenseData`, image arrays, `id_proof_type` | Image arrays replace existing |
| `/api/drivers/online-status` | PUT | `driverId` | `isOnline`, `onlineAs` | At least one optional key recommended |
| `/api/drivers/issues/:issueId` | PUT | `status` | `adminNotes` | Admin function |
| `/api/:collectionName/:id` | PUT | None (any schema fields) | Any schema fields | Generic endpoint |

---

## Common Response Format

All update APIs return a similar response structure:

**Success Response (200):**
```json
{
  "success": true,
  "message": "Update message",
  "data": {
    // Updated record or relevant data
  }
}
```

**Error Response (400/404/500):**
```json
{
  "success": false,
  "message": "Error message",
  "data": {
    // Error details
  }
}
```

---

## Notes

1. **Image Arrays**: In `updateVehicleDetails`, image arrays completely **replace** existing images, not merge them.

2. **Date Fields**: Date fields accept ISO date strings (e.g., "2025-12-31") or Date objects.

3. **Validation**: All update APIs validate input data against the schema and return detailed error messages.

4. **Password Hash**: Password hash is automatically removed from driver responses for security.

5. **Generic Endpoint**: The generic `PUT /api/:collectionName/:id` endpoint can update any collection, but be careful with validation and unique constraints.
