# FCM (Push Notifications) Setup

This project uses **Firebase Admin SDK only for FCM (Firebase Cloud Messaging)** to send push notifications to drivers and users. **Firestore database is not used.**

## Configuration

Set one of these in your `.env` file (project root):

- **Option 1:** `FIREBASE_SERVICE_ACCOUNT_KEY='{"type":"service_account",...}'` (full JSON string)
- **Option 2:** `FIREBASE_SERVICE_ACCOUNT_PATH=./automet-89e4b-firebase-adminsdk-fbsvc-973c0f0fdd.json` (path to service account JSON)
- **Option 3:** `GOOGLE_APPLICATION_CREDENTIALS=/path/to/credentials.json`
- **Option 4:** `FIREBASE_PROJECT_ID=your-project-id` (limited; may not work for FCM)

FCM tokens are read from **MongoDB** (`drivers.fcmToken`, `users.fcmToken`). No Firestore collections are used.
