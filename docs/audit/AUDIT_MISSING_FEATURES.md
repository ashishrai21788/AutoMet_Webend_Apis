# Missing, partial, deferred and blocked work

## Not implemented (in scope; suggested order)
1. ~~Legal documents module~~ **Done in cycle 2** (see AUDIT_MASTER_REPORT.md). Still open: translations (one language per type today), the built-in fallback text still ships in the apps, and the owner must write and have the real text reviewed.
2. ~~Configuration publish lifecycle~~ **Done in cycles 3 and 4**: settings history and rollback (business details, payouts, tolls, app versions, ride settings) and pricing drafts, publish and history (fare rules). Scheduled publish is done too. Cancellation policies now have change history and restore (cycle 7). Still open: drafts for regions and categories. The driver cancellation penalty is done (cycle 8), with a dashboard view and waiver (cycle 10).
3. ~~Minimum app version and forced update~~ **Done in cycle 3.**
4. ~~Tolls~~ **Done in cycle 3** (entered by the driver, capped by the business). Still open: working a toll out from the route, and a toll-free vehicle or area setting.
5. ~~Tax effective dates and rule versions~~ **Done**: a tax change can be scheduled for a date, and each trip stores the pricing version and the tax rates it was charged.
6. **Surge**: DONE (cycle 5). Demand-based multiplier within the rule cap, pause switch, rider label. Quote lock and cache are in memory per server instance.
7. **Branded build pipeline** from a business record (applicationId, icons, Firebase file, signing) with artifact verification.
8. Parts of the requested audit not performed in this cycle: independent per-area agents, accessibility and text-scaling pass, dark mode, full concurrency and network-failure suites on devices, performance with large data sets, a Play policy cross-check of every SDK, deployment and artifact verification.

## Partial
- Coupons: riders must know the code (no list of offers); one coupon per ride by design (no stacking).
- Pagination and data volume: audited in cycle 9 (see AUDIT_MASTER_REPORT.md). Two scaling limits remain open: the driver earnings overview and the driver history for "all time" read every trip of the driver.
- The rider coupon row and tip row were seen and exercised on a device (cycle 2b). The admin pages were opened in a browser against the lab backend (cycle 2b).

## Deferred by instruction (not built in this phase)
- **Chat.** No operational chat exists and none is claimed.
- **Online payments.** Not integrated. When added the system needs a payment state machine (created, authorised, captured, failed, refunded), provider webhooks with signature checks and idempotency, refunds and reversals that also reverse coupon uses and driver earnings, reconciliation against the provider's settlement report, and an online and cash split in the driver balance (already modelled: online earnings are owed to the driver, cash earnings are not).

## Blocked
- Anything against production data or a real Play Console: no access from this environment.
- Hosting the privacy policy on a public URL and filing Play's Data safety form: owner actions.
