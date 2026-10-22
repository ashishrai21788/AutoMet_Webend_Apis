# Missing, partial, deferred and blocked work

## Not implemented (in scope; suggested order)
1. ~~Legal documents module~~ **Done in cycle 2** (see AUDIT_MASTER_REPORT.md). Still open: translations (one language per type today), the built-in fallback text still ships in the apps, and the owner must write and have the real text reviewed.
2. **Configuration publish lifecycle**: draft, validate, publish, history, rollback of pricing and branding as immutable snapshots. Today edits are live immediately and only an audit row records them.
3. **Minimum app version and forced update**, returned in public config and enforced by the apps.
4. **Tolls**: a toll amount entered or confirmed per trip, shown to the rider, included in the fare and invoice, and in driver earnings. No code exists.
5. **Tax effective dates and rule versions** stored on each trip. Rates are read from the current fare rule; the trip keeps the amounts charged, but not the rule version.
6. **Surge**: the fare engine accepts a multiplier and the rule stores a cap, but nothing sets a multiplier. Either add a demand-driven multiplier or remove the setting.
7. **Branded build pipeline** from a business record (applicationId, icons, Firebase file, signing) with artifact verification.
8. Parts of the requested audit not performed in this cycle: independent per-area agents, accessibility and text-scaling pass, dark mode, full concurrency and network-failure suites on devices, performance with large data sets, a Play policy cross-check of every SDK, deployment and artifact verification.

## Partial
- Coupons: riders must know the code (no list of offers); one coupon per ride by design (no stacking).
- Pagination: not audited for the admin audit log, reports and invoice lists.
- The rider coupon row and tip row were seen and exercised on a device (cycle 2b). The admin pages were opened in a browser against the lab backend (cycle 2b).

## Deferred by instruction (not built in this phase)
- **Chat.** No operational chat exists and none is claimed.
- **Online payments.** Not integrated. When added the system needs a payment state machine (created, authorised, captured, failed, refunded), provider webhooks with signature checks and idempotency, refunds and reversals that also reverse coupon uses and driver earnings, reconciliation against the provider's settlement report, and an online and cash split in the driver balance (already modelled: online earnings are owed to the driver, cash earnings are not).

## Blocked
- Anything against production data or a real Play Console: no access from this environment.
- Hosting the privacy policy on a public URL and filing Play's Data safety form: owner actions.
