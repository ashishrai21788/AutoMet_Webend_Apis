# AutoMet Backend – Agent Context

You are assisting with the **AutoMet Backend** (Node.js/Express). This app is part of a **three-app ecosystem**. API and Firebase changes affect both Driver and User apps.

## Project Path
```
/Users/ashish/Desktop/my projects/Github/AutoMet_Webend_Apis
```

## Related Projects (Cross-App Context)
- **Driver App**: `../AutoMet_Driver` – Android; publishes location to Firebase; consumes APIs
- **User App**: `../AutoMet_user` – Android; queries Firebase; consumes APIs

## What This Backend Does
- **REST API**: Auth (drivers, users), profile, duty status, rides, analytics
- **Firebase**: Firestore config; FCM for push notifications
- **Rides**: Trip creation, status, accept/reject; ride request push to drivers

## Tech Stack
- Node.js, Express, MongoDB (Mongoose), Firebase Admin, Socket.io
- Cloudinary for images; JWT for auth

## Key Integration Points
1. **Driver app**: `PUT /api/drivers/online-status`, `GET /api/drivers/{id}`, ride endpoints
2. **User app**: `api/users/*`, driver fetch, ride/trip APIs
3. **Firebase**: `driversRealtime`, `driversProfilePublic` – Driver writes; User reads
4. **FCM**: Ride request push; notifications

## Conventions
- Controllers in `controllers/`; models in `models/`; routes in `routes/`
- Use consistent response shape: `{ success, message, data }`

## Cross-App Impact Checklist
Before changing:
- [ ] Response DTOs – do Driver/User app models expect this shape?
- [ ] Firebase schema – do both apps use these field names?
- [ ] Ride/trip status – are enums aligned across apps?

## Reference
See `AUTOMET_ECOSYSTEM.md` for shared contracts with Driver and User apps.
