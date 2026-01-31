# API Troubleshooting – "Not a single API is working"

Use this when the server is running but API calls fail or return errors.

---

## 1. Check why APIs return 503

**All `/api/*` routes need MongoDB.** If the database is not connected, every `/api/*` request returns **503** with `DATABASE_CONNECTION_ERROR`.

### Step 1: Check DB status

```bash
# From same machine as server
curl http://localhost:3000/health

# From another device (use your server's IP, e.g. 192.168.1.10)
curl http://YOUR_SERVER_IP:3000/health
```

Or:

```bash
curl http://localhost:3000/api/health
```

In the response, check:

- **`dbConnected: true`** → MongoDB is connected; 503 is from something else (see below).
- **`dbConnected: false`** → MongoDB is not connected; that’s why all APIs return 503.

### Step 2: Fix MongoDB connection

When `dbConnected` is false:

1. **Check server logs** – You should see errors like:
   - `Missing required MongoDB environment variables`
   - `bad auth : authentication failed`
   - `connection refused` / timeout

2. **Check `.env`** (in project root):
   - `MONGODB_USERNAME`
   - `MONGODB_PASSWORD` (use `%40` for `@` in password)
   - `MONGODB_CLUSTER` (e.g. `xxx.mongodb.net`)
   - `DB_NAME` (e.g. `api_database`)

3. **Restart the server** after changing `.env`:
   ```bash
   npm run dev
   ```
   Wait until you see: `✅ Database connection established`.

4. **Test again**: `curl http://localhost:3000/health` → `dbConnected` should be `true`, and other APIs should stop returning 503.

---

## 2. Wrong URL (e.g. from phone or another PC)

**`localhost` only works on the same machine as the server.**

- On the **same machine** as the server: use `http://localhost:3000` or `http://127.0.0.1:3000`.
- From **another device** (phone, another PC): use the server machine’s IP, e.g. `http://192.168.1.10:3000`.

When the server starts it prints something like:

```text
🌐 Network HTTP access: http://192.168.1.10:3000
📱 API Base URL: http://192.168.1.10:3000/api
```

Use that **API Base URL** (or the host part) from other devices.

### Quick test

- Same machine: `curl http://localhost:3000/health`
- Other device: open browser or use curl to `http://SERVER_IP:3000/health`

If the same machine works but the other device gets “connection refused” or timeout:

- **Firewall**: allow inbound TCP port **3000** on the server.
- **Wi‑Fi**: both devices should be on the same network (or you need proper routing/port forwarding).

---

## 3. POST/PUT body not sent or wrong format

APIs that expect JSON need:

- **Header:** `Content-Type: application/json`
- **Body:** valid JSON

If you omit `Content-Type: application/json` or send invalid JSON, the server may respond with **400** or treat the body as missing (e.g. “Missing required field”).

### Example (Postman / curl)

```bash
curl -X POST http://localhost:3000/api/users/login \
  -H "Content-Type: application/json" \
  -d '{"phoneNumber":"1234567890","password":"mypass"}'
```

From code (e.g. Kotlin/Java), set the request header to `Content-Type: application/json` and send a JSON string in the body.

---

## 4. Endpoints that don’t need DB (for quick checks)

Use these to confirm the server is reachable and that 503 is due to DB:

| Method | URL | Purpose |
|--------|-----|--------|
| GET | `/health` | Server + DB status (same as below, root) |
| GET | `/test` | Simple “server is working” |
| GET | `/api/health` | API reachable + `dbConnected` (no DB required) |

If `/health` or `/api/health` returns **200** and `dbConnected: true`, then other APIs should work (same host/port and headers/body as above). If they still don’t, the issue is likely wrong path, method, or body.

---

## 5. Summary checklist

- [ ] Server is running (`npm run dev`).
- [ ] `GET /health` or `GET /api/health` shows **`dbConnected: true`** (if not, fix MongoDB and restart).
- [ ] From another device you use **`http://SERVER_IP:3000`**, not `localhost`.
- [ ] For POST/PUT you send **`Content-Type: application/json`** and **valid JSON** in the body.
- [ ] Firewall allows **port 3000** if calling from another machine.

If all of the above are correct and a specific API still fails, check that endpoint’s docs (e.g. required fields, method, path) and the response body (e.g. `message`, `missingFields`, `validationErrors`) for the exact error.
