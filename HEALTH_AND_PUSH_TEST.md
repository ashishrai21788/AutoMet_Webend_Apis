# Health checks & push notification tests

Use this to verify the server, database, FCM configuration, and test notifications to **user** and **driver** devices.

## Prerequisites

- Server running (`npm start` or `node index.js`).
- `.env` has **`FIREBASE_SERVICE_ACCOUNT_PATH`** (or `FIREBASE_SERVICE_ACCOUNT_KEY` / `GOOGLE_APPLICATION_CREDENTIALS`).
- MongoDB connected (otherwise `/api/*` returns **503** except `/api/health` path handling — see below).
- Test devices: user app logged in (FCM token saved on `users.fcmToken`) and driver app logged in (`drivers.fcmToken`).

---

## 1. Health: no database required

These are registered **before** the DB middleware, so they respond even if MongoDB is down:

| Method | URL | What it checks |
|--------|-----|----------------|
| GET | `/test` | Server process alive |
| GET | `/api/health` | `dbConnected`, `fcmReady`, `mongooseState` |

```bash
curl -s "http://localhost:3000/api/health"
```

**Expected (DB up):** HTTP 200, `"success": true`, `"fcmReady": true` if Firebase SA is configured.

**Expected (DB down):** HTTP 503 — still shows `fcmReady` so you can confirm FCM config without Mongo.

---

## 2. Health: includes memory / uptime

| GET | `/health` |

```bash
curl -s "http://localhost:3000/health"
```

Response includes `health.dbConnected`, `health.fcmReady`, memory, uptime.

---

## 3. Test push to **driver** (FCM)

**POST** `/api/drivers/notifications/send`  
Requires **MongoDB** (503 if DB disconnected).

Body (JSON):

```json
{
  "driverId": "YOUR_DRIVER_ID",
  "title": "Test from server",
  "body": "Driver push test — AutoMet webend",
  "channelId": "driver_notifications",
  "data": { "type": "TEST_PUSH" }
}
```

```bash
export BASE_URL="http://localhost:3000"
export DRIVER_ID="DRV_xxxx"

curl -s -X POST "$BASE_URL/api/drivers/notifications/send" \
  -H "Content-Type: application/json" \
  -d "{\"driverId\":\"$DRIVER_ID\",\"title\":\"Test from server\",\"body\":\"Driver push test\",\"channelId\":\"driver_notifications\",\"data\":{\"type\":\"TEST_PUSH\"}}"
```

**Success:** HTTP 200, `"success": true`, `data.messageId` present.  
**Failures:** 400 (no FCM token on driver), 404 (driver not found), 502 (FCM send error).

---

## 4. Test push to **user** (FCM)

**POST** `/api/users/notifications/send`

Body:

```json
{
  "userId": "YOUR_USER_ID",
  "title": "Test from server",
  "body": "User push test — AutoMet webend",
  "channelId": "user_notifications",
  "data": { "type": "TEST_PUSH" }
}
```

```bash
export USER_ID="USR_xxxx"

curl -s -X POST "$BASE_URL/api/users/notifications/send" \
  -H "Content-Type: application/json" \
  -d "{\"userId\":\"$USER_ID\",\"title\":\"Test from server\",\"body\":\"User push test\",\"channelId\":\"user_notifications\",\"data\":{\"type\":\"TEST_PUSH\"}}"
```

---

## 5. One-shot script

From project root:

```bash
chmod +x scripts/test-health-and-push.sh
export DRIVER_ID="DRV_..."   # optional
export USER_ID="USR_..."     # optional
export BASE_URL="http://localhost:3000"
./scripts/test-health-and-push.sh
```

---

## Quick checklist

| Check | Command / note |
|-------|------------------|
| API + DB | `GET /api/health` → 200, `dbConnected: true` |
| FCM configured | `fcmReady: true` on `/api/health` and `/health` |
| Driver device | Driver logged in once so `drivers.fcmToken` is set |
| User device | User logged in so `users.fcmToken` is set |
| Driver push | POST `/api/drivers/notifications/send` |
| User push | POST `/api/users/notifications/send` |
