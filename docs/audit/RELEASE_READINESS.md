# Release readiness (cycle 1)

| Gate | Status | Why |
|---|---|---|
| Functional: critical journeys | PARTIAL | the driver journey was verified on a device; the rider journey was verified in earlier cycles and not re-run; the rider coupon and tip UI were not seen on a device |
| Configuration: end to end | PARTIAL | business details, categories, fares, commission, coupons and incentives are connected; legal documents are now connected (cycle 2); versioning of other settings, minimum version and build identity are not |
| Financial | PASS for what exists | fares, commission, coupons, tips, incentives, adjustments and payouts reconcile in tests; tolls missing; tax rule versions not stored; no online payments (deferred) |
| Cross-platform sync | PARTIAL | the server is authoritative; lab runs show driver and admin agree after coupons, tips and payouts; there is no automated multi-client concurrency suite |
| Security and compliance | PARTIAL | tenant isolation tests pass; driver data export and deletion exist; each business can now publish its privacy policy at a public URL (the business must still write it and enter that URL in Play); the Data safety form is not filed |
| Technical | PASS for the builds and tests listed | 519 of 523 backend tests pass (4 skipped, 0 failed), admin 24 of 24, apps compile; no production deployment verified; no migration was needed (new collections are created from the models) |

**Decision: NOT PRODUCTION READY.** Cycle 2 added the legal documents module. Suggested next cycle: configuration publish and rollback, minimum app version, tolls.
