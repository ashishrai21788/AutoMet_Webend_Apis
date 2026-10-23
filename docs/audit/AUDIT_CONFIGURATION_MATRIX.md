# Configuration matrix

"Consumed" means a downstream component actually reads the saved value. Rows marked PASS were traced in source; they were not all re-run this cycle.

| Key | Admin location | Scope | Storage | API | Rider app | Driver app | Backend logic | Cache | Status |
|---|---|---|---|---|---|---|---|---|---|
| business name, appName | Business settings | tenant | `tenants` | `GET /api/v1/public/config` | `Brand.name` | `Brand.name` | emails, invoices | ETag from a hash of the whole config (`publicController.js`) | PASS (source-traced) |
| brandColor, logoUrl | Business settings | tenant | `tenants` | public config | `Brand.color` / `logoUrl` | same | none | same | PASS (source-traced) |
| support phone and email | Business settings | tenant | `tenants` | public config; driver `summary.support` | help dialogs | help dialogs, ride completed | PDF footers | same | PASS |
| market (country, currency, timezone) | Regions | tenant | `tenants.market` | public config | money formatting | money formatting | all fare and invoice maths | same | PASS |
| regions (centre and radius) | Regions | tenant | `service_regions` | public config | service availability | availability | `lib/regionMatch.js` in pricing | same | PASS |
| vehicle categories | Categories | tenant | `vehicle_categories` | public config, ride options | ride type list | request map icon | pricing, dispatch | same | PASS |
| fare rules (base, km, minute, minimum, fees, taxes) | Pricing | tenant, category, region | `fare_rules` | `trips/estimate`, ride options | shows the server fare | earnings | `lib/fareRules.js` | none (read per request) | PASS |
| surge maximum multiplier | Pricing | rule | `fare_rules.surge` | none | none | none | applied by demand within this cap (`lib/surge.js`); pause switch in `surgeSettings` | n/a | PASS |
| driver commission percent, payout rules | Driver Payouts, Payout settings | tenant | `tenants.payoutSettings` | none (server side) | none | earnings screens | `lib/driverMoney.js` | read per request | PASS |
| coupons | Coupons | tenant | `coupons` | estimate, create-request | apply row | earnings through the trip | `lib/coupons.js` | none | PASS |
| incentives and goals | Incentives and Goals | tenant | `driver_incentives` | `driver/earnings/incentives` | n/a | cards and screen | `lib/incentives.js` | none | PASS |
| legal documents (privacy, rider and driver terms, location disclosure, account deletion, cancellation and refund) | Legal Documents | tenant, per type, versioned | `legal_documents`, `legal_acceptances` | `GET /api/v1/public/legal[/:type]`, hosted page `/legal/:appId/:type`, `/api/v1/legal/pending` and `/accept` | policy and terms screens, consent dialog | same | publish rules, consent check | ETag per document | PASS (tests and live run; apps compile, not seen on a device). Apps fall back to the built-in text when a business has published nothing |
| minimum app version, forced update | **none** | n/a | none | none | none | none | none | n/a | **NOT IMPLEMENTED** |
| configuration versioning, draft, rollback | **none** | n/a | only an automatic content hash | public config `version` | ETag | ETag | n/a | ETag | **PARTIAL** (change detection only; no history, no rollback) |
| build identity (applicationId, icon, Firebase file) | none | build | gradle `-PappId` and `-PappName` | n/a | build time | build time | n/a | n/a | PARTIAL (a per-business build flag exists; no pipeline from the dashboard) |

Runtime or build time: display name, colours, logo, support details, categories, areas, fares and coupons are runtime. applicationId, launcher icon, Firebase registration and signing are build time and are not changed by the dashboard.
