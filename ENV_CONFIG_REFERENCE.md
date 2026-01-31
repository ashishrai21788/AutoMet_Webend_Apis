# Environment & Config Reference

Quick reference for `.env` / `.env.example` and which config files use each variable.

---

## Required (app needs these to run fully)

| Variable | Used by | Description |
|----------|---------|-------------|
| `MONGODB_USERNAME` | config/db.js | MongoDB Atlas user |
| `MONGODB_PASSWORD` | config/db.js | MongoDB Atlas password (use `%40` for `@`) |
| `MONGODB_CLUSTER` | config/db.js | Atlas host (e.g. `cluster.mongodb.net`) |
| `DB_NAME` | config/db.js | Database name (e.g. `api_database`) |
| `COLLECTION_NAME` | models/driver.js | Default driver collection (e.g. `drivers`) |
| `PORT` | index.js | Server port (default 3000) |
| `JWT_SECRET` | userController, otpController, dynamicController | JWT signing secret |
| `CLOUDINARY_CLOUD_NAME` | config/cloudinary.js | Cloudinary cloud name |
| `CLOUDINARY_API_KEY` | config/cloudinary.js | Cloudinary API key |
| `CLOUDINARY_API_SECRET` | config/cloudinary.js | Cloudinary API secret |

---

## Optional

| Variable | Used by | Description |
|---------|---------|-------------|
| `HOST` | index.js | Bind address (default `0.0.0.0`) |
| `NODE_ENV` | index.js, analytics/dynamic controllers | e.g. `development` for extra logging |
| `CLOUDINARY_URL` | — | Alternative single URL; app uses the three vars above |
| `FIREBASE_SERVICE_ACCOUNT_KEY` | config/firestore.js | Firebase SA as JSON string |
| `FIREBASE_SERVICE_ACCOUNT_PATH` | config/firestore.js | Path to Firebase SA JSON file |
| `GOOGLE_APPLICATION_CREDENTIALS` | config/firestore.js | Path to Google credentials |
| `FIREBASE_PROJECT_ID` | config/firestore.js | Firebase project ID (dev) |
| `FIRESTORE_DRIVERS_COLLECTION` | config/firestore.js | Firestore collection name (default `drivers`) |

---

## Config files

| File | Purpose |
|------|---------|
| config/db.js | MongoDB connection (Mongoose); requires MongoDB vars |
| config/cloudinary.js | Cloudinary config and image upload/delete; requires Cloudinary vars |
| config/firestore.js | Firebase Admin / Firestore; optional, uses Firebase vars if set |
| config/multer.js | File upload (disk storage); no env vars, uses `uploads/` |

---

## .gitignore

- `.env`, `.env.local`, `.env.*.local` are ignored (secrets).
- `.env.example` is **not** ignored; use it as a template with placeholders only.
- `firebase-service-account.json` and `*.json` (with exceptions) are ignored; don’t commit credentials.
