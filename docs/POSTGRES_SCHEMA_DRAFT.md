# Postgres schema draft (generated)

31 models. Every table also has `_id text primary key` (24-hex), `__v integer`, and `createdAt/updatedAt timestamptz` where the schema has timestamps.

## AdminAudit  (collection `admin_audit_logs`)
timestamps: no; strict: default

| column | type | notes |
|---|---|---|
| tenantId | text | default null |
| actorId | text | default null |
| actorEmail | text | default null |
| action | text | required |
| targetType | text | default null |
| targetId | text | default null |
| meta | jsonb | default null |
| ip | text | default null |
| at | timestamptz |  |

Indexes:
- {"tenantId":1}
- {"at":1}

## AdminUser  (collection `admin_users`)
timestamps: yes; strict: default

| column | type | notes |
|---|---|---|
| adminId | text | required, unique |
| name | text | required |
| email | text | required, unique |
| passwordHash | text | required, select:false |
| role | text | required, enum(super_admin|client_admin|operations|support|finance) |
| tenantId | text | default null |
| active | boolean | default true |
| mustChangePassword | boolean | default false |
| tokenVersion | double precision | default 0 |
| failedLogins | double precision | default 0 |
| lockUntil | timestamptz | default null |
| lastLoginAt | timestamptz | default null |
| totpEnabled | boolean | default false |
| totpSecret | text | select:false, default null |
| totpPending | text | select:false, default null |
| totpLastStep | double precision | select:false, default -1 |
| recoveryHashes | jsonb | select:false, default [] |
| resetTokenHash | text | select:false, default null |
| resetTokenExpires | timestamptz | default null |
| createdAt | timestamptz |  |
| updatedAt | timestamptz |  |

Indexes:
- {"adminId":1} unique
- {"email":1} unique
- {"tenantId":1}

## CancellationPolicy  (collection `cancellation_policies`)
timestamps: no; strict: default

| column | type | notes |
|---|---|---|
| tenantId | text | required |
| policyId | text | required, unique |
| categoryId | text | required |
| regionId | text | default null |
| regionKey | text | required |
| currency | text | required |
| rider | jsonb |  |
| driver | jsonb |  |
| conditions | text | default "" |
| active | boolean | default true |
| createdAt | timestamptz |  |
| updatedAt | timestamptz |  |

Indexes:
- {"tenantId":1}
- {"policyId":1} unique
- {"tenantId":1,"categoryId":1,"regionKey":1} unique

## Driver  (collection `drivers`)
timestamps: yes; strict: default

| column | type | notes |
|---|---|---|
| name | text | required |
| phone | text | required, unique |
| vehicleNumber | text | required |
| isOnline | boolean | default false |
| createdAt | timestamptz |  |
| updatedAt | timestamptz |  |

Indexes:
- {"phone":1} unique

## DriverAppAnalytics  (collection `driver_app_analytics`)
timestamps: yes; strict: default

| column | type | notes |
|---|---|---|
| events | jsonb | required |
| driverId | text | default null |
| deviceId | text | required |
| sessionId | text | required |
| appId | text | required |
| appVersion | text | default null |
| platform | text | default null |
| source | text | required |
| createdAt | timestamptz |  |
| updatedAt | timestamptz |  |

## DriverDocument  (collection `driver_documents`)
timestamps: no; strict: default

| column | type | notes |
|---|---|---|
| tenantId | text | required |
| docId | text | required, unique |
| driverId | text | required |
| type | text | required |
| number | text | default "" |
| expiryDate | timestamptz | default null |
| file | jsonb | required |
| status | text | enum(SUBMITTED|APPROVED|REJECTED), default "SUBMITTED" |
| rejectionReason | text | default "" |
| submittedAt | timestamptz |  |
| reviewedAt | timestamptz | default null |
| reviewedBy | text | default null |
| version | double precision | default 1 |
| previousFiles | jsonb | default [] |
| createdAt | timestamptz |  |
| updatedAt | timestamptz |  |

Indexes:
- {"tenantId":1}
- {"docId":1} unique
- {"tenantId":1,"driverId":1,"type":1} unique
- {"tenantId":1,"status":1}

## DriverIssue  (collection `driver_issues_reports`)
timestamps: no; strict: false (free extra fields -> jsonb "extra")

| column | type | notes |
|---|---|---|
| tenantId | text | default null |
| reporterType | text | enum(driver|rider), default "driver" |
| driverId | text | default null |
| riderId | text | default null |
| tripId | text | default null |
| issueText | text | default "" |
| imageUrls | jsonb | default [] |
| status | text | enum(issue submitted|under process|complete), default "issue submitted" |
| adminNotes | text | default null |
| notes | jsonb | default [] |
| assignedTo | text | default null |
| resolvedAt | timestamptz | default null |
| createdAt | timestamptz |  |
| updatedAt | timestamptz |  |

Indexes:
- {"tenantId":1}
- {"driverId":1}
- {"riderId":1}
- {"status":1}

## DriverOTP  (collection `drivers_otp`)
timestamps: yes; strict: default

| column | type | notes |
|---|---|---|
| driverId | text | required |
| phoneNumber | text | required |
| email | text | default null |
| otp | text | required |
| isUsed | boolean | default false |
| expiresAt | timestamptz | required |
| createdAt | timestamptz |  |
| updatedAt | timestamptz |  |

Indexes:
- {"expiresAt":1}

## DriverVehicleAssignment  (collection `driver_vehicle_assignments`)
timestamps: no; strict: default

| column | type | notes |
|---|---|---|
| tenantId | text | required |
| assignmentId | text | required, unique |
| driverId | text | required |
| vehicleId | text | required |
| active | boolean | default true |
| assignedAt | timestamptz |  |
| assignedBy | text | default null |
| endedAt | timestamptz | default null |
| endedBy | text | default null |
| endReason | text | default "" |

Indexes:
- {"tenantId":1}
- {"assignmentId":1} unique
- {"tenantId":1,"vehicleId":1} unique partial {"active":true}
- {"tenantId":1,"driverId":1} unique partial {"active":true}

## Drivers  (collection `drivers`)
timestamps: yes; strict: default

| column | type | notes |
|---|---|---|
| tenantId | text | default null |
| accountStatus | text | enum(ACTIVE|INACTIVE|SUSPENDED), default "ACTIVE" |
| driverVerificationStatus | text | enum(INCOMPLETE|PENDING_REVIEW|APPROVED|REJECTED|EXPIRED), default "INCOMPLETE" |
| verificationExpiresAt | timestamptz | default null |
| operatingRegionId | text | default null |
| eligibleCategoryId | text | default null |
| dateOfBirth | timestamptz | default null |
| address | jsonb | default null |
| createdByAdmin | text | default null |
| driverId | text | required, unique |
| firstName | text | required |
| lastName | text | required |
| email | text | required, unique |
| phone | text | required |
| passwordHash | text | required |
| profilePhoto | text | required, default "https://cdn.example.com/drivers/default.jpg" |
| vehicleType | text | default null |
| vehicleNumber | text | default null |
| vehicleModel | text | default null |
| vehicleColor | text | default null |
| vehicleManufacturingYear | double precision | default null |
| engineNumber | text | default null |
| chassisNumber | text | default null |
| fuleType | text | default "" |
| seatingCapacity | text | default "" |
| vehicleInsurance.policyNumber | text | default null |
| vehicleInsurance.insuranceCompany | text | default null |
| vehicleInsurance.insuranceExpiryDate | timestamptz | default null |
| vehicleInsurance.insuranceAmount | double precision | default null |
| vehicleInsurance.isInsuranceValid | boolean | default false |
| licenseNumber | text | default null |
| licenseExpiry | timestamptz | default null |
| license_type | text | default null |
| expiry_date | timestamptz | default null |
| drivingLicenseIssueDate | timestamptz | default null |
| drivingLicenseIssuingAuthority | text | default null |
| aadhaarNumber | text | default null |
| id_proof_type | text | default null |
| isVerified | boolean | default false |
| isProfileComplete | boolean | default false |
| isPhoneVerified | boolean | default false |
| isVehicleAdded | boolean | default false |
| isDocumentsUploaded | boolean | default false |
| verification_status | text | enum(INCOMPLETE|UNDER_REVIEW|APPROVED|REJECTED), default "INCOMPLETE" |
| vehicleRegistrationImages | jsonb | default [] |
| vehicleInsuranceImages | jsonb | default [] |
| drivingLicenseImages | jsonb | default [] |
| idProofImages | jsonb | default [] |
| currentLocation.type | text | enum(Point), default "Point" |
| currentLocation.coordinates | jsonb | default [0,0] |
| isOnline | boolean | default false |
| isLoggedin | boolean | default false |
| onlineAs | double precision | enum(0|1), default 0 |
| lastActive | timestamptz |  |
| fcmToken | text | default null |
| deviceId | text | default null |
| accessToken | text | default null |
| walletBalance | double precision | default 0 |
| membership.plan | text | enum(Free|Silver|Gold|Platinum), default "Free" |
| membership.startDate | timestamptz |  |
| membership.endDate | timestamptz |  |
| membership.paymentStatus | text | enum(Pending|Paid|Failed), default "Pending" |
| membership.transactionId | text | default null |
| membership.isCancelled | boolean | default false |
| membership.cancelledAt | timestamptz | default null |
| membership.cancelReason | text | default null |
| bankAccount.accountHolderName | text | default null |
| bankAccount.accountNumber | text | default null |
| bankAccount.ifscCode | text | default null |
| rating | double precision | default 0 |
| totalRides | double precision | default 0 |
| cancelledRides | double precision | default 0 |
| lastLocation | jsonb |  |
| locationUpdatedAt | timestamptz | default null |
| locationAccuracyM | double precision | default null |
| locationHeading | double precision | default null |
| locationSpeedKph | double precision | default null |
| locationRegionId | text | default null |
| wentOfflineAt | timestamptz | default null |
| wentOfflineReason | text | default null |
| role | text | enum(driver|user|admin), default "driver" |
| createdAt | timestamptz |  |
| updatedAt | timestamptz |  |

Indexes:
- {"tenantId":1}
- {"driverId":1} unique
- {"email":1} unique
- {"lastLocation":"2dsphere"}
- {"isOnline":1,"locationUpdatedAt":1}

## EntityHistory  (collection `entity_history`)
timestamps: no; strict: default

| column | type | notes |
|---|---|---|
| tenantId | text | required |
| subjectType | text | required, enum(driver|vehicle) |
| subjectId | text | required |
| kind | text | required |
| action | text | required |
| from | text | default null |
| to | text | default null |
| detail | text | default "" |
| reason | text | default "" |
| actorId | text | default null |
| actorEmail | text | default null |
| at | timestamptz |  |

Indexes:
- {"tenantId":1}
- {"tenantId":1,"subjectType":1,"subjectId":1,"at":-1}

## FareRule  (collection `fare_rules`)
timestamps: no; strict: default

| column | type | notes |
|---|---|---|
| tenantId | text | required |
| ruleId | text | required, unique |
| categoryId | text | required |
| regionId | text | default null |
| regionKey | text | required |
| currency | text | required |
| baseFare | double precision | required |
| perKm | double precision | required |
| perMinute | double precision | required |
| minimumFare | double precision | required |
| bookingFee | double precision | required |
| waitingFreeMinutes | double precision | required |
| waitingPerMinute | double precision | required |
| additionalCharges | jsonb | default [] |
| taxes | jsonb | default [] |
| surge | jsonb |  |
| active | boolean | default true |
| createdAt | timestamptz |  |
| updatedAt | timestamptz |  |

Indexes:
- {"tenantId":1}
- {"ruleId":1} unique
- {"tenantId":1,"categoryId":1,"regionKey":1} unique

## PlatformCounter  (collection `platform_counters`)
timestamps: no; strict: default

| column | type | notes |
|---|---|---|
| key | text | required, unique |
| seq | double precision | default 0 |

Indexes:
- {"key":1} unique

## PlatformInvoice  (collection `platform_invoices`)
timestamps: yes; strict: default

| column | type | notes |
|---|---|---|
| invoiceId | text | required, unique |
| number | text | required, unique |
| tenantId | text | required |
| type | text | enum(subscription|setup_fee|other), default "subscription" |
| description | text | default "Platform subscription" |
| periodStart | timestamptz | default null |
| periodEnd | timestamptz | default null |
| amount | double precision | required |
| taxRate | double precision | default 0 |
| taxAmount | double precision | default 0 |
| cgst | double precision | default 0 |
| sgst | double precision | default 0 |
| igst | double precision | default 0 |
| total | double precision | default null |
| sac | text | default "" |
| seller | jsonb | default null |
| buyer | jsonb | default null |
| notes | text | default "" |
| remindersSent | jsonb | default [] |
| lapsedAt | timestamptz | default null |
| emailedAt | timestamptz | default null |
| currency | text | required |
| status | text | enum(issued|paid|void), default "issued" |
| issuedAt | timestamptz |  |
| dueDate | timestamptz | required |
| paidAt | timestamptz | default null |
| paymentMethod | text | default null |
| reference | text | default "" |
| refundedAmount | double precision | default 0 |
| refunds | jsonb | default [] |
| voidedAt | timestamptz | default null |
| voidReason | text | default "" |
| createdBy | text | default null |
| createdAt | timestamptz |  |
| updatedAt | timestamptz |  |

Indexes:
- {"invoiceId":1} unique
- {"number":1} unique
- {"tenantId":1}
- {"status":1}
- {"tenantId":1,"issuedAt":-1}

## PlatformPlan  (collection `platform_plans`)
timestamps: yes; strict: default

| column | type | notes |
|---|---|---|
| planId | text | required, unique |
| name | text | required, unique |
| description | text | default "" |
| price | double precision | required |
| cycle | text | enum(monthly|yearly), default "monthly" |
| setupFee | double precision | default 0 |
| trialDays | double precision | default null |
| active | boolean | default true |
| createdAt | timestamptz |  |
| updatedAt | timestamptz |  |

Indexes:
- {"planId":1} unique
- {"name":1} unique

## PlatformSettings  (collection `platform_settings`)
timestamps: yes; strict: default

| column | type | notes |
|---|---|---|
| key | text | required, unique |
| companyName | text | default "" |
| billingEmail | text | default "" |
| invoiceDueDays | double precision | default 14 |
| defaultTrialDays | double precision | default 14 |
| invoiceNotes | text | default "" |
| legalName | text | default "" |
| gstin | text | default "" |
| address | text | default "" |
| stateCode | text | default "" |
| sac | text | default "998314" |
| gstRate | double precision | default 18 |
| reminderOffsets | jsonb | default [-3,1,7] |
| graceDays | double precision | default 15 |
| lapseAction | text | enum(none|cancel|suspend), default "none" |
| lastRunAt | timestamptz | default null |
| createdAt | timestamptz |  |
| updatedAt | timestamptz |  |

Indexes:
- {"key":1} unique

## Ride  (collection `rides`)
timestamps: no; strict: default

| column | type | notes |
|---|---|---|
| ride_id | text | required, unique |
| user_id | text | required |
| driver_id | text |  |
| pickup.address | text | required |
| pickup.lat | double precision | required |
| pickup.lng | double precision | required |
| drop.address | text | required |
| drop.lat | double precision | required |
| drop.lng | double precision | required |
| ride_note | text | default null |
| status | text | required, enum(REQUESTED|ACCEPTED|DRIVER_ON_THE_WAY|ARRIVED|STARTED|COMPLETED|CANCELLED|REJECTED), default "REQUESTED" |
| requested_at | timestamptz | required |
| accepted_at | timestamptz | default null |
| driver_on_the_way_at | timestamptz | default null |
| arrived_at | timestamptz | default null |
| started_at | timestamptz | default null |
| completed_at | timestamptz | default null |
| cancelled_at | timestamptz | default null |
| rejected_at | timestamptz | default null |
| reject_reason | text | default null |
| cancellation_reason | text | default null |
| cancelled_by | text | enum(USER|DRIVER|SYSTEM|), default null |
| created_at | timestamptz |  |
| updated_at | timestamptz |  |

Indexes:
- {"ride_id":1} unique
- {"user_id":1}
- {"driver_id":1}
- {"status":1}
- {"user_id":1,"status":1}
- {"driver_id":1,"status":1}
- {"status":1,"requested_at":1}

## ServiceRegion  (collection `service_regions`)
timestamps: no; strict: default

| column | type | notes |
|---|---|---|
| tenantId | text | required |
| regionId | text | required, unique |
| country | text | required |
| state | text | required |
| city | text | required |
| zoneName | text | required |
| key | text | required |
| center | jsonb | default null |
| radiusKm | double precision | default null |
| active | boolean | default true |
| createdAt | timestamptz |  |
| updatedAt | timestamptz |  |

Indexes:
- {"tenantId":1}
- {"regionId":1} unique
- {"tenantId":1,"key":1} unique

## SetupProgress  (collection `business_setup_progress`)
timestamps: no; strict: default

| column | type | notes |
|---|---|---|
| tenantId | text | required, unique |
| completedAt | timestamptz | default null |
| completedBy | text | default null |
| updatedAt | timestamptz |  |

Indexes:
- {"tenantId":1} unique

## Tenant  (collection `tenants`)
timestamps: yes; strict: default

| column | type | notes |
|---|---|---|
| tenantId | text | required, unique |
| name | text | required |
| slug | text | required, unique |
| appName | text | required |
| packageName | text | required, unique |
| city | text | default "" |
| plan | text | enum(trial|standard|enterprise), default "trial" |
| status | text | enum(active|trial|suspended), default "trial" |
| brandColor | text | default "#f5a300" |
| supportEmail | text | default "" |
| supportPhone | text | default "" |
| logoUrl | text | default "" |
| market | jsonb | default null |
| subscription | jsonb | default null |
| billingDetails | jsonb | default null |
| rideSettings | jsonb |  |
| verificationRequirements | jsonb |  |
| isDefault | boolean | default false |
| createdAt | timestamptz |  |
| updatedAt | timestamptz |  |

Indexes:
- {"tenantId":1} unique
- {"slug":1} unique
- {"packageName":1} unique
- {"status":1}

## Trip  (collection `trips`)
timestamps: yes; strict: default

| column | type | notes |
|---|---|---|
| trip_id | text | required, unique |
| request_id | text | default null |
| user_id | text | required |
| driver_id | text | required |
| pickup_address | text | required |
| pickup_latitude | double precision | required |
| pickup_longitude | double precision | required |
| drop_address | text | required |
| drop_latitude | double precision | required |
| drop_longitude | double precision | required |
| ride_note | text | default null |
| status | text | required, enum(REQUESTED|ACCEPTED|DRIVER_ON_THE_WAY|ARRIVED|ON_GOING|COMPLETED|REJECTED|NO_RESPONSE|REJECTED_WITH_REASON|CANCELLED_BY_USER|CANCELLED_BY_USER_AFTER_ACCEPTANCE), default "REQUESTED" |
| rejected_reason | text | default null |
| rejected_by | text | enum(USER|DRIVER|), default null |
| cancellation_reason | text | default null |
| cancelled_at | timestamptz | default null |
| cancel_stage | text | enum(before_accept|after_accept|), default null |
| cancelled_by | text | enum(USER|DRIVER|), default null |
| requested_at | timestamptz | required |
| accepted_at | timestamptz | default null |
| driver_on_the_way_at | timestamptz | default null |
| arrived_at | timestamptz | default null |
| started_at | timestamptz | default null |
| completed_at | timestamptz | default null |
| createdAt | timestamptz |  |
| updatedAt | timestamptz |  |

Indexes:
- {"trip_id":1} unique
- {"request_id":1}
- {"user_id":1}
- {"driver_id":1}
- {"status":1}
- {"user_id":1,"driver_id":1,"status":1}
- {"requested_at":1}

## TripCounter  (collection `trip_counters`)
timestamps: no; strict: default

| column | type | notes |
|---|---|---|
| seq | double precision | default 0 |

## TripDetails  (collection `trip_details`)
timestamps: no; strict: default

| column | type | notes |
|---|---|---|
| trip_id | text | required, unique |
| request_id | text | required, unique |
| user_id | text | required |
| driver_id | text | required |
| tenant_id | text | default null |
| pickup.address | text | required |
| pickup.lat | double precision | required |
| pickup.lng | double precision | required |
| drop.address | text | required |
| drop.lat | double precision | required |
| drop.lng | double precision | required |
| ride_note | text | default null |
| fare | double precision | default null |
| currency | text | default null |
| distance_km | double precision | default null |
| estimated_duration_min | double precision | default null |
| fare_basis | text | enum(ESTIMATE|ACTUAL|), default null |
| payment_mode | text | default "CASH" |
| fare_source | text | enum(BUSINESS_RULES|LEGACY_TARIFF|), default null |
| fare_breakdown | jsonb | default null |
| region_id | text | default null |
| category_id | text | default null |
| status | text | required, enum(REQUESTED|ACCEPTED|DRIVER_ON_THE_WAY|ARRIVED|ON_GOING|COMPLETED|REJECTED|REJECTED_WITH_REASON|NO_RESPONSE|CANCELLED_BY_USER|CANCELLED_BY_USER_AFTER_ACCEPTANCE|CANCELLED_BY_DRIVER), default "REQUESTED" |
| driver_response | text | default null |
| reject_reason | text | default null |
| cancellation_reason | text | default null |
| cancelled_at | timestamptz | default null |
| cancel_stage | text | enum(before_accept|after_accept|), default null |
| cancelled_by | text | enum(USER|DRIVER|ADMIN|), default null |
| requested_at | timestamptz | required |
| responded_at | timestamptz | default null |
| driver_on_the_way_at | timestamptz | default null |
| arrived_at | timestamptz | default null |
| started_at | timestamptz | default null |
| completed_at | timestamptz | default null |
| timeout_at | timestamptz | required |
| push_sent | boolean | default false |
| push_message_id | text | default null |
| push_sent_at | timestamptz | default null |
| push_status | text | enum(DELIVERED|FAILED|), default null |
| created_at | timestamptz |  |
| updated_at | timestamptz |  |

Indexes:
- {"trip_id":1} unique
- {"request_id":1} unique
- {"user_id":1}
- {"driver_id":1}
- {"tenant_id":1}
- {"status":1}
- {"user_id":1,"driver_id":1,"status":1}
- {"timeout_at":1,"status":1}

## TripEvent  (collection `trip_events`)
timestamps: no; strict: default

| column | type | notes |
|---|---|---|
| trip_id | text | required |
| event | text | required |
| payload | jsonb |  |
| created_at | timestamptz |  |

Indexes:
- {"trip_id":1}
- {"trip_id":1,"created_at":1}

## UserAppAnalytics  (collection `user_app_analytics`)
timestamps: yes; strict: default

| column | type | notes |
|---|---|---|
| events | jsonb | required |
| deviceId | text | required |
| sessionId | text | required |
| appId | text | required |
| appVersion | text | default null |
| platform | text | default null |
| source | text | required |
| createdAt | timestamptz |  |
| updatedAt | timestamptz |  |

## UserDriverMapView  (collection `user_driver_map_views`)
timestamps: no; strict: default

| column | type | notes |
|---|---|---|
| driverId | text | required |
| sessionId | text | required |
| lastSeen | timestamptz | required |

Indexes:
- {"lastSeen":1}
- {"driverId":1,"sessionId":1} unique

## UserOTP  (collection `users_otp`)
timestamps: yes; strict: default

| column | type | notes |
|---|---|---|
| userId | text | required |
| phoneNumber | text | required |
| email | text | default null |
| otp | text | required |
| isUsed | boolean | default false |
| expiresAt | timestamptz | required |
| createdAt | timestamptz |  |
| updatedAt | timestamptz |  |

Indexes:
- {"expiresAt":1}

## Users  (collection `users`)
timestamps: yes; strict: default

| column | type | notes |
|---|---|---|
| tenantId | text | default null |
| accountStatus | text | enum(ACTIVE|SUSPENDED), default "ACTIVE" |
| suspendedAt | timestamptz | default null |
| suspendedReason | text | default null |
| userId | text | required, unique |
| firstName | text | required, default "" |
| lastName | text | required, default "" |
| phone | text | required, unique |
| email | text | default null |
| passwordHash | text | default null |
| profilePhoto | text | default null |
| isPhoneVerified | boolean | default false |
| isLoggedin | boolean | default false |
| accessToken | text | default null |
| fcmToken | text | default null |
| deviceId | text | default null |
| lastActive | timestamptz | default null |
| role | text | enum(user|driver|admin), default "user" |
| createdAt | timestamptz |  |
| updatedAt | timestamptz |  |

Indexes:
- {"tenantId":1}
- {"userId":1} unique
- {"phone":1} unique

## Vehicle  (collection `vehicles`)
timestamps: no; strict: default

| column | type | notes |
|---|---|---|
| tenantId | text | required |
| vehicleId | text | required, unique |
| registrationNumber | text | required |
| registrationKey | text | required |
| make | text | required |
| model | text | required |
| year | double precision | default null |
| colour | text | default "" |
| categoryId | text | required |
| passengerCapacity | double precision | required |
| luggageCapacity | double precision | default null |
| operatingRegionId | text | default null |
| status | text | enum(ACTIVE|INACTIVE|SUSPENDED), default "INACTIVE" |
| verificationStatus | text | enum(INCOMPLETE|PENDING_REVIEW|APPROVED|REJECTED|EXPIRED), default "INCOMPLETE" |
| verificationExpiresAt | timestamptz | default null |
| createdBy | text | default null |
| createdAt | timestamptz |  |
| updatedAt | timestamptz |  |

Indexes:
- {"tenantId":1}
- {"vehicleId":1} unique
- {"tenantId":1,"registrationKey":1} unique
- {"tenantId":1,"status":1}
- {"tenantId":1,"categoryId":1}

## VehicleCategory  (collection `vehicle_categories`)
timestamps: no; strict: default

| column | type | notes |
|---|---|---|
| tenantId | text | required |
| categoryId | text | required, unique |
| name | text | required |
| nameKey | text | required |
| description | text | default "" |
| icon | text | default "car" |
| imageUrl | text | default "" |
| passengerCapacity | double precision | required |
| luggageCapacity | double precision | default null |
| rideType | text | required |
| regionIds | jsonb | default [] |
| active | boolean | default true |
| createdAt | timestamptz |  |
| updatedAt | timestamptz |  |

Indexes:
- {"tenantId":1}
- {"categoryId":1} unique
- {"tenantId":1,"nameKey":1} unique

## VehicleDocument  (collection `vehicle_documents`)
timestamps: no; strict: default

| column | type | notes |
|---|---|---|
| tenantId | text | required |
| docId | text | required, unique |
| vehicleId | text | required |
| type | text | required |
| number | text | default "" |
| expiryDate | timestamptz | default null |
| file | jsonb | required |
| status | text | enum(SUBMITTED|APPROVED|REJECTED), default "SUBMITTED" |
| rejectionReason | text | default "" |
| submittedAt | timestamptz |  |
| reviewedAt | timestamptz | default null |
| reviewedBy | text | default null |
| version | double precision | default 1 |
| previousFiles | jsonb | default [] |
| createdAt | timestamptz |  |
| updatedAt | timestamptz |  |

Indexes:
- {"tenantId":1}
- {"docId":1} unique
- {"tenantId":1,"vehicleId":1,"type":1} unique

## Not model-backed (raw collection facade, one jsonb table each)
`driver_notification`, `users_notification`, `driver_faq`, and any collection reached through the generic
`/api/:collectionName` routes (`genericSchema`, strict:false). Each becomes `(_id text pk, doc jsonb, createdAt, updatedAt)`.

## Notes for review
- `Driver` and `Drivers` both map to `drivers` (the file model and the dynamic model): one table.
- `double precision` is the automatic type for every Number; money columns will become integer paise in phase 5 (finance tables only).
- Foreign keys are NOT created yet: ids are plain text (business ids like `amt_...`, tenant ids), so FKs need the hand-review step.
