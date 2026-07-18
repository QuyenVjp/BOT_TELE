# Tasks: Notifications, Quantity Checkout, and Payment UX

**Feature:** `003-notifications-quantity-checkout`  
**Authority:** `spec.md`, `plan.md`, `data-model.md`, and the contracts in `contracts/`  
**Execution rule:** tests precede implementation in every story; keep `.specify/feature.json` pinned
to Feature 001 while the active MVP implementation is in progress.

## Phase 1: Setup and shared contracts

**Goal:** Establish fixtures, migration boundaries, and shared event/rate-limit contracts without
changing the active Feature 001 source of truth.

- [ ] T301 Create Feature 003 fixture README and sanitized fake merchant/supplier/SePay data in `tests/fixtures/notifications-quantity.md`
- [ ] T302 [P] Add contract fixture types for quantity, payment presentation, notification classes, and campaign fingerprints in `src/shared/contracts/feature-003.ts`

## Phase 2: Foundational persistence and outbox boundaries

**Goal:** Make PostgreSQL and the transactional outbox authoritative for quantity, payment presentation,
notification preferences, campaigns, deliveries, and digests.

### Tests first

- [ ] T303 [P] Write failing migration/constraint tests for quantity bounds, VND totals, unit counters, preference locks, campaign states, delivery dedupe, and digest windows in `tests/integration/feature-003-schema.test.ts`
- [ ] T304 [P] Write failing outbox and event-snapshot tests proving committed events are durable, allowlisted, and reconstructible in `tests/integration/feature-003-outbox.test.ts`
- [ ] T305 [P] Write failing rate-limit policy tests for Buy Now, payment check, preference changes, and Telegram fanout budgets in `tests/property/feature-003-rate-limits.test.ts`

### Implementation

- [ ] T306 Implement Feature 003 PostgreSQL migration with quantity/order counters, payment presentation, notification preference, campaign, delivery, digest, and allowlisted event snapshot tables in `src/infrastructure/db/migrations/010_notifications_quantity.sql`
- [ ] T307 Implement typed Feature 003 domain events, idempotency keys, dedupe keys, and safe display snapshots in `src/modules/notifications/domain.ts` and `src/shared/events/index.ts`
- [ ] T308 Implement transactional outbox enqueue/claim/retry primitives for notification work in `src/infrastructure/outbox/repository.ts` and `src/infrastructure/outbox/worker.ts`
- [ ] T309 Implement action-specific anti-spam policy and bounded retry/backoff primitives in `src/modules/risk/service.ts` and `src/modules/notifications/telemetry.ts`

## Phase 3: User Story 1 — Buy multiple units of one Product Variant (P1)

**Independent test:** A seeded variant accepts quantities 1, 3, and maximum, rejects invalid/above-stock
values, reserves atomically, and completes with exactly N safe entitlements without a multi-item cart.

### Tests first

- [ ] T310 [P] [US1] Write failing quantity parsing/bounds and reconfirmation tests for FR-301/FR-302 in `tests/contract/quantity-command.test.ts`
- [ ] T311 [P] [US1] Write failing exact integer VND multiplication and overflow/bounds property tests for FR-304 in `tests/property/quantity-total.test.ts`
- [ ] T312 [P] [US1] Write failing concurrent all-or-nothing reservation tests for FR-305 in `tests/integration/quantity-reservation.test.ts`
- [ ] T313 [P] [US1] Write failing supplier quantity/idempotency, timeout-Unknown, partial-success, and reconciliation tests for FR-306/FR-307 in `tests/integration/supplier-quantity.test.ts`
- [ ] T314 [P] [US1] Write failing exact-N Delivery Bundle, replay, and no-raw-credential tests for FR-308 in `tests/security/quantity-delivery.test.ts`

### Implementation

- [ ] T315 [US1] Implement bounded quantity and exact-total value objects in `src/modules/commerce/quantity.ts` and `src/shared/money/index.ts`
- [ ] T316 [US1] Extend Product Variant/Order snapshots and repository queries with maximum, quantity, unit price, total, and unit counters in `src/modules/catalog/domain.ts` and `src/modules/commerce/order.ts`
- [ ] T317 [US1] Implement atomic N-unit reservation and stale price/stock reconfirmation in `src/modules/commerce/repository.ts` and `src/modules/commerce/buy-now.ts`
- [ ] T318 [US1] Implement supplier quantity capability, deterministic `{orderId}:{unitIndex}` attempts, Unknown reconciliation, and partial review transitions in `src/modules/supplier/port.ts`, `src/modules/supplier/adapters/primary.ts`, and `src/modules/digital-goods/multi-fulfillment.ts`
- [ ] T319 [US1] Implement exact-N Delivery Bundle binding and controlled reveal integration in `src/modules/digital-goods/delivery.ts` and `src/bot/presenters/delivery.ts`
- [ ] T320 [US1] Add quantity selection, stale-data reconfirmation, and safe error callbacks in `src/bot/callbacks/quantity.ts` and `src/bot/presenters/catalog.ts`
- [ ] T321 [US1] Run the independent quantity/reservation/supplier/delivery acceptance lane and record evidence in `specs/003-notifications-quantity-checkout/evidence/us1-quantity.md`

## Phase 4: User Story 2 — Understand and control the VietQR payment session (P1)

**Independent test:** An unpaid Order produces one Vietnamese QR card whose fields match the Payment
Intent snapshot; check/cancel are safe, rate-limited, idempotent, and lose to verified SePay settlement.

### Tests first

- [ ] T322 [P] [US2] Write failing payment-session contract tests for QR image, Order/product/quantity, unit/total VND, bank display, transfer content, expiry, warning, and buttons in `tests/contract/payment-session.test.ts`
- [ ] T323 [P] [US2] Write failing QR payload/merchant snapshot property tests for FR-309/FR-310 in `tests/contract/vietqr-payment-session.test.ts`
- [ ] T324 [P] [US2] Write failing check-payment projection-first, cooldown/hourly-limit, and no-synchronous-SePay-poll tests for FR-311 in `tests/security/payment-check-abuse.test.ts`
- [ ] T325 [P] [US2] Write failing cancel/settlement race, replay, reservation-release, and `ALREADY_PAID` tests for FR-312 in `tests/integration/payment-cancel-race.test.ts`
- [ ] T326 [P] [US2] Write failing wrong/partial/over/late/unmatched payment reconciliation tests for FR-313/FR-314 in `tests/integration/payment-review-states.test.ts`

### Implementation

- [ ] T327 [US2] Implement Payment Intent quantity/amount snapshot and payment-session repository fields in `src/modules/payments/domain.ts` and `src/modules/payments/repository.ts`
- [ ] T328 [US2] Implement validated VietQR payload/media generation and idempotent QR reference in `src/modules/payments/vietqr.ts`
- [ ] T329 [US2] Implement canonical awaiting/settled/processing/review/cancelled/expired/completed payment presenters in `src/modules/payments/presentation.ts` and `src/bot/presenters/payment.ts`
- [ ] T330 [US2] Implement customer-scoped opaque check/cancel callbacks, local projection reads, rate limits, and race-safe commands in `src/bot/callbacks/payment.ts` and `src/modules/payments/service.ts`
- [ ] T331 [US2] Integrate integer VND manual-reconciliation policy and safe discrepancy guidance in `src/modules/payments/reconciliation.ts`
- [ ] T332 [US2] Run the independent VietQR/SePay payment-session acceptance lane and record evidence in `specs/003-notifications-quantity-checkout/evidence/us2-payment.md`

## Phase 5: User Story 3 — Receive accurate transactional updates (P1)

**Independent test:** A customer receives one owner-scoped notification for each meaningful Order,
payment, fulfillment, and support transition, including recovery/review states, without raw credentials.

### Tests first

- [ ] T333 [P] [US3] Write failing transactional notification policy and owner-scope contract tests in `tests/contract/notification-transactional.test.ts`
- [ ] T334 [P] [US3] Write failing event replay/dedupe tests for created, awaiting, settled, processing, review, cancelled, expired, and completed transitions in `tests/property/transactional-notification-dedupe.test.ts`
- [ ] T335 [P] [US3] Write failing transactional presenter/redaction tests for quantity status, order history link, and Delivery Bundle button in `tests/security/transactional-notification-privacy.test.ts`
- [ ] T336 [P] [US3] Write failing worker restart/at-least-once and delivery retry tests in `tests/integration/transactional-notification-worker.test.ts`

### Implementation

- [ ] T337 [US3] Implement transactional notification state mapping and allowlisted event snapshot policy in `src/modules/notifications/policy.ts`
- [ ] T338 [US3] Implement owner-scoped notification repository, dedupe, and delivery status transitions in `src/modules/notifications/repository.ts`
- [ ] T339 [US3] Implement Vietnamese transactional templates and safe Delivery Bundle action in `src/bot/presenters/notifications.ts` and `src/bot/presenters/delivery.ts`
- [ ] T340 [US3] Connect committed Order/payment/fulfillment/support events to transactional outbox enqueue in `src/modules/commerce/order.ts`, `src/modules/payments/service.ts`, `src/modules/digital-goods/fulfillment.ts`, and `src/modules/support/service.ts`
- [ ] T341 [US3] Run the independent transactional notification acceptance lane and record evidence in `specs/003-notifications-quantity-checkout/evidence/us3-transactional.md`

## Phase 6: User Story 4 — Receive product and privacy-safe purchase-activity announcements (P2)

**Independent test:** Product/restock messages show authoritative stock/price data; purchase activity is
aggregated, privacy-safe, preference-aware, and capped per recipient.

### Tests first

- [ ] T342 [P] [US4] Write failing product publish/restock content and authoritative snapshot tests in `tests/contract/product-notification.test.ts`
- [ ] T343 [P] [US4] Write failing purchase-activity allowlist/redaction tests proving no buyer, Order, payment, bank, account, credential, or private total in `tests/security/purchase-activity-privacy.test.ts`
- [ ] T344 [P] [US4] Write failing aggregation/window/frequency-cap property tests proving every event contributes without one-message-per-sale fanout in `tests/property/purchase-activity-digest.test.ts`
- [ ] T345 [P] [US4] Write failing opt-out and quiet-hour suppression-at-send tests in `tests/integration/shop-notification-preference-race.test.ts`

### Implementation

- [ ] T346 [US4] Implement product/restock event snapshot builder and authoritative catalog integration in `src/modules/notifications/policy.ts` and `src/modules/catalog/repository.ts`
- [ ] T347 [US4] Implement privacy-safe purchase-activity aggregation, digest windows, and per-recipient caps in `src/modules/notifications/digest.ts`
- [ ] T348 [US4] Implement new-product/restock and purchase-activity Vietnamese presenters with product deep links and settings actions in `src/bot/presenters/notifications.ts`
- [ ] T349 [US4] Connect catalog publish/restock and verified completion events to shop-update/purchase-activity outbox paths in `src/modules/catalog/domain.ts` and `src/modules/digital-goods/fulfillment.ts`
- [ ] T350 [US4] Run the independent product/activity acceptance and privacy load lane and record evidence in `specs/003-notifications-quantity-checkout/evidence/us4-activity.md`

## Phase 7: User Story 5 — Send important admin announcements safely (P2)

**Independent test:** Only the sole numeric root admin in private chat can create a sanitized campaign,
preview it, confirm/schedule/send/cancel it, and observe bounded, auditable fanout.

### Tests first

- [ ] T351 [P] [US5] Write failing root-admin numeric-ID/private-context/username-impersonation authorization tests in `tests/security/notification-admin-identity.test.ts`
- [ ] T352 [P] [US5] Write failing campaign content allowlist, credential-pattern, target-segment, and critical-no-marketing tests in `tests/security/admin-campaign-content.test.ts`
- [ ] T353 [P] [US5] Write failing draft/preview/recipient-estimate/step-up/fingerprint-expiry/replay tests in `tests/integration/admin-campaign-lifecycle.test.ts`
- [ ] T354 [P] [US5] Write failing campaign fanout dedupe, retry-after/backoff, blocked-chat, cancellation, and progress metric tests in `tests/integration/admin-campaign-fanout.test.ts`

### Implementation

- [ ] T355 [US5] Implement NotificationCampaign aggregate, state machine, safe-body sanitizer, and recipient estimation in `src/modules/notifications/campaign.ts`
- [ ] T356 [US5] Implement root-admin-only draft/preview/confirm/schedule/send/cancel callbacks with step-up and audit in `src/bot/callbacks/admin-broadcast.ts` and `src/bot/middleware/security.ts`
- [ ] T357 [US5] Implement batched Telegram fanout worker with retry-after/backoff, dedupe, blocked-chat suppression, metrics, and unsent cancellation in `src/modules/notifications/fanout.ts` and `src/worker.ts`
- [ ] T358 [US5] Implement campaign audit and safe admin preview/presentation in `src/infrastructure/observability/audit.ts` and `src/bot/presenters/notifications.ts`
- [ ] T359 [US5] Run the independent admin broadcast authorization/fanout acceptance lane and record evidence in `specs/003-notifications-quantity-checkout/evidence/us5-admin-broadcast.md`

## Phase 8: User Story 6 — Control notification preferences (P2)

**Independent test:** Customers can disable shop updates and purchase activity, set quiet hours and
digest frequency, while transactional and critical-service notifications remain policy-locked.

### Tests first

- [ ] T360 [P] [US6] Write failing preference schema, locked-class, defaults, timezone, and digest-frequency contract tests in `tests/contract/notification-preferences.test.ts`
- [ ] T361 [P] [US6] Write failing preference callback ownership, opaque token, idempotency, and replay tests in `tests/security/notification-preference-callback.test.ts`
- [ ] T362 [P] [US6] Write failing preference-change-versus-queued-send race tests proving immediate suppression of unsent shop/activity deliveries in `tests/integration/notification-preference-race.test.ts`

### Implementation

- [ ] T363 [US6] Implement NotificationPreference repository, validation, quiet-hour evaluation, and policy-locked classes in `src/modules/notifications/preferences.ts`
- [ ] T364 [US6] Implement customer-scoped notification settings callbacks and Vietnamese settings presenter in `src/bot/callbacks/notifications.ts` and `src/bot/presenters/notifications.ts`
- [ ] T365 [US6] Apply preference/quiet-hour evaluation immediately before every unsent delivery in `src/modules/notifications/fanout.ts` and `src/modules/notifications/policy.ts`
- [ ] T366 [US6] Run the independent preference/quiet-hour/digest acceptance lane and record evidence in `specs/003-notifications-quantity-checkout/evidence/us6-preferences.md`

## Phase 9: Cross-cutting verification and launch gate

- [ ] T367 [P] Add Feature 003 contract, integration, property, acceptance, and security test paths to `tests/README.md` and CI scripts in `.github/workflows/ci.yml`
- [ ] T368 [P] Run secret-scan and credential/telemetry redaction checks across all new notification, payment, and delivery paths in `tests/security/feature-003-redaction.test.ts`
- [ ] T369 [P] Run replay/concurrency/load/429/worker-restart abuse evidence and document metrics in `specs/003-notifications-quantity-checkout/evidence/cross-cutting.md`
- [ ] T370 [P] Reconcile Feature 003 traceability, checklists, contracts, and task checkboxes; document any owner launch gate in `specs/003-notifications-quantity-checkout/traceability.md`
- [ ] T371 [P] Run `npm run typecheck`, `npm run lint`, `npm run format:check`, `npm run test`, and `npm run secret-scan`; record exact outcomes in `specs/003-notifications-quantity-checkout/evidence/release.md`
- [ ] T372 [P] Perform STRIDE/OWASP review for payment, admin broadcast, privacy, and fanout surfaces and record Critical/High disposition in `specs/003-notifications-quantity-checkout/analysis.md`

## Dependencies and execution order

```text
T301-T309
  → US1 T310-T321
  → US2 T322-T332 (depends on US1 order/quantity snapshot)
  → US3 T333-T341 (depends on committed order/payment/fulfillment events)
  → US4 T342-T350 (depends on notification policy and completed-event snapshots)
  → US5 T351-T359 (depends on fanout/outbox and root-admin boundary)
  → US6 T360-T366 (can begin after notification policy; must gate fanout before release)
  → T367-T372
```

Within each story, all `Tests first` tasks must be red for the intended reason before the related
`Implementation` task starts. Tasks marked `[P]` may run in parallel only when they touch independent
files and do not depend on an incomplete preceding task.

## Parallel execution examples

- Foundation: T303, T304, and T305 can run in parallel; T306–T309 follow their contracts.
- US1: T310–T314 can run in parallel; T315–T320 are ordered by domain dependency.
- US2: T322–T326 can run in parallel; T327–T331 follow the payment state boundary.
- US3/US4: once T337–T338 exist, presenter and privacy/aggregation test slices can proceed in parallel.
- US5: T351–T354 can run in parallel before T355–T358.
- US6: T360–T362 can run in parallel; T363–T365 are ordered before fanout release evidence.

## Implementation strategy

1. Fold T310–T332 into the active Feature 001 payment phase before declaring the MVP payment lane complete.
2. Add transactional notifications immediately after authoritative Order/payment/fulfillment events are stable.
3. Add product/activity, admin broadcast, and preferences as independently testable slices.
4. Do not implement wallet, multi-item cart, Telegram Stars, marketing bypass, or reseller controls in this feature.
5. Do not mark a task complete without a real test/evidence reference; unresolved Critical/High findings block implementation or release.

## Format validation

- Total tasks: 72 (`T301`–`T372`), sequential with no gaps.
- Every task has a checkbox, ID, exact path, and a story label in user-story phases.
- Tests are listed before implementation in each phase.
