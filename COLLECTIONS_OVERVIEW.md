# Collections Overview – Driver & User Apps

This backend serves **both** the **driver app** and the **user app**. All collections live in the **same MongoDB database** (`DB_NAME` in `.env`), but the collections are **different** for each app.

---

## Database

- **One database** (e.g. `api_database`) is used for the whole project.
- **Driver** and **user** data are separated by **collection name**, not by database.

---

## Driver app collections

| Collection                 | Purpose                                      |
|---------------------------|----------------------------------------------|
| `drivers`                 | Driver accounts (default; name from `COLLECTION_NAME` in .env) |
| `drivers_otp`             | OTP records for driver verification         |
| `driver_app_analytics`    | Driver app analytics events (duty_on, duty_off, etc.) |
| `driver_faq`              | Driver FAQs                                  |
| `driver_issues_reports`    | Driver issue reports                         |
| `driver_notification`     | Driver notifications                         |

---

## User app collections

| Collection                 | Purpose                                      |
|---------------------------|----------------------------------------------|
| `users`                   | User accounts                                |
| `users_otp`               | OTP records for user verification           |
| `user_app_analytics`      | User app analytics events (login, screen_view, etc.) |
| `users_notification`      | User notifications                           |

---

## Summary

- **Driver app** → uses `drivers`, `drivers_otp`, `driver_app_analytics`, `driver_faq`, `driver_issues_reports`, `driver_notification`.
- **User app** → uses `users`, `users_otp`, `user_app_analytics`, `users_notification`.
- **Same DB** → one `DB_NAME`; collections are different so driver and user data stay separate.

---

## .env

- **DB_NAME** – shared database for both driver and user (e.g. `api_database`).
- **COLLECTION_NAME** – used only for the **default driver collection** name (e.g. `drivers`). User and other driver-related collections are fixed in code and do not use this env var.
