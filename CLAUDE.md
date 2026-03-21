# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

AutoMet is a ride-hailing backend API (Node.js/Express 5) serving both a **driver app** and a **user app**. It uses MongoDB Atlas (via Mongoose), Cloudinary for image storage, Firebase/Firestore for push notifications (FCM), and Socket.IO for real-time ride events. Deployed on Render.

## Commands

- `npm run dev` — start with nodemon (development)
- `npm start` — start without auto-reload (production)
- `npm run monitor` — start via `monitor.js` (process monitoring wrapper)
- `npm run health` — curl the local health endpoint

There are no tests configured (`npm test` exits with error).

## Architecture

**MVC + dynamic model factory pattern.** The key architectural concept is that `models/dynamicModel.js` exports a `createModel(collectionName)` factory that returns different Mongoose models based on the collection name — `driverSchema` for "drivers", `userSchema` for "users", and a `genericSchema` for everything else. This factory is used throughout controllers.

### Route mounting (index.js)

Routes are mounted in a specific order that matters:
- `/api/users` — user auth (register, login, OTP verify, profile)
- `/api/user-app-analytics` / `/api/driver-app-analytics` — analytics events
- `/api` — **dynamic routes** via `dynamicRoutes.js` (includes all `/api/drivers/*` specific routes AND catch-all `/:collectionName` CRUD). Specific driver routes (login, logout, profile, vehicle, notifications, issues) are defined **before** the dynamic catch-all.
- `/api/otp` — driver OTP verification
- `/api/images` — Cloudinary image upload/delete
- `/api/v1/rides` — ride lifecycle (request, accept, reject, status, timeline, timeouts)
- `/api/v1/ride-actions` — atomic ride actions (request, accept, reject, cancel) via `services/rideActionService.js`
- `/api/v1/trips` — trip requests with 30s wait, driver response, timeouts

### Key patterns

- **Atomic ride updates**: `services/rideActionService.js` uses `findOneAndUpdate` with status in the filter for race-condition-safe state transitions (no distributed locks needed).
- **Socket.IO rooms**: drivers join `driver:{driverId}`, users join `user:{userId}`. Events: `ride_request_received`, `ride_request_accepted`, `ride_request_rejected`, `ride_request_timeout`, `ride_cancelled_by_user`.
- **Push notifications**: `lib/pushNotification.js` resolves FCM tokens from driver/user docs and sends via Firebase Admin SDK (`config/firestore.js`).
- **Image uploads**: multer for multipart handling → Cloudinary upload. Images stored as `{url, publicId}` objects on driver documents.
- **JWT auth**: 7-day tokens, stored in the driver/user document's `accessToken` field. `verifyToken` middleware in `dynamicController.js`.
- **DB connection middleware**: All `/api/*` routes (except health) return 503 if MongoDB is disconnected.

## Environment Variables

Required in `.env` (see `render-environment-variables.example.csv` for full list):
- `MONGODB_USERNAME`, `MONGODB_PASSWORD`, `MONGODB_CLUSTER`, `DB_NAME` — MongoDB Atlas connection
- `JWT_SECRET` — JWT signing key
- `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET` — image storage
- `PORT` (default 3000), `HOST` (default 0.0.0.0)

Firebase is initialized by `config/firestore.js` via either `FIREBASE_SERVICE_ACCOUNT_KEY` (inline JSON string in env) or `FIREBASE_SERVICE_ACCOUNT_PATH` (path to service account JSON file).

## Important Notes

- The `.gitignore` blocks all `*.json` files except `package.json`, `package-lock.json`, and `tsconfig.json`. Be aware of this when adding new JSON config files.
- `fuleType` (not "fuelType") is the established field name in the driver schema — do not "fix" the typo as it's used across the API and client apps.
- Express 5 is used (not Express 4) — error handling and routing behavior differs slightly.
- The project uses **CommonJS** (`require`/`module.exports`). Do not use ES module `import`/`export` syntax.
