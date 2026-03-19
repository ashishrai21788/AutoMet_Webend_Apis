# AutoMet Ecosystem – Cross-App Reference

This document describes the **three-app AutoMet ecosystem** so agents and developers can keep Driver, User, and Backend in sync.

## Projects

| App       | Path                          | Role                          |
|-----------|-------------------------------|-------------------------------|
| Driver    | `AutoMet_Driver`              | Drivers share location/profile |
| User      | `AutoMet_user`               | Passengers discover drivers    |
| Backend   | `AutoMet_Webend_Apis`        | REST API, Firebase, FCM       |

## Data Flow

```
Driver App ──► Firebase (driversRealtime, driversProfilePublic) ──► User App
     │                                                                  │
     └──────────────► Backend REST API ◄───────────────────────────────┘
```

## Shared Contracts (Backend Defines)

### API Response Shape
```json
{ "success": true, "message": "...", "data": { ... } }
```

### Firebase (Backend config; Driver writes; User reads)
- **driversRealtime/{driverId}**: `g`, `l`, `name`, `rating`, `profilePhoto`, `onDuty`, `isOnline`, `activeTripId`, `lastSeen`, etc.
- **driversProfilePublic/{driverId}**: profile fields for map markers

### Ride/Trip Status
- Requested, Accepted, ON_THE_WAY, ARRIVED, STARTED, Completed, Cancelled
- Align with Driver app `RideRequestPayload` and User app trip handling

## When Making Changes

- **Backend**: Changing API response shape or Firebase schema affects both mobile apps
- Always verify Driver and User app DTOs/types before shipping
