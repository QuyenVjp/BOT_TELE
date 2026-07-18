# Tasks: Telegram Shop Digital MVP

**Input**: Design documents from `specs/001-telegram-shop-mvp/`

**Prerequisites**: constitution, spec.md, plan.md, research.md, data-model.md, contracts/, checklists/, quickstart.md

**Tests**: REQUIRED. Each behavioral test task precedes its implementation and must first demonstrate the intended failure.

**Organization**: Tasks are grouped by independently testable user story and reference requirement IDs.

## Phase 1: Setup

**Purpose**: Establish the smallest reproducible Node/TypeScript project and verification lanes.

- [ ] T001 Create `package.json`, lockfile, Node 24 engine policy, and scripts for typecheck/lint/test/build in `package.json`
- [ ] T002 Create strict TypeScript project configuration in `tsconfig.json` and test configuration in `vitest.config.ts`
- [ ] T003 [P] Configure formatting/lint rules and generated/build exclusions in `eslint.config.js` and `.prettierignore`
- [ ] T004 [P] Create environment schema placeholders without secrets in `.env.example` and `src/config/env.ts`
- [ ] T005 Create process entrypoints and graceful-shutdown skeletons in `src/main.ts` and `src/worker.ts`
- [ ] T006 [P] Create test directory conventions and fixture README in `tests/README.md` and `tests/fixtures/README.md`
- [ ] T007 [P] Create containerized local PostgreSQL/Redis test dependencies in `compose.yaml`
- [ ] T008 Configure CI gates for install, typecheck, lint, tests, secret scan, dependency audit, and build in `.github/workflows/ci.yml`

**Checkpoint**: Clean scaffold installs from the lockfile and all empty verification lanes execute.

---

## Phase 2: Foundational Blocking Work

**Purpose**: Build shared correctness, persistence, reliability, and ingress boundaries required by every story.

- [ ] T009 [P] Write failing environment validation/redaction tests for FR/SR boundaries in `tests/security/config-redaction.test.ts`
- [ ] T010 [P] Write failing shared Money/ID/time property tests for integer VND and opaque identifiers in `tests/property/shared-primitives.test.ts`
- [ ] T011 Implement validated configuration loading and secret-safe diagnostics in `src/config/env.ts` and `src/config/index.ts`
- [ ] T012 [P] Implement branded IDs, integer VND Money, UTC/business-time helpers, and stable error envelope in `src/shared/ids/index.ts`, `src/shared/money/index.ts`, `src/shared/time/index.ts`, and `src/shared/errors/index.ts`
- [ ] T013 Create PostgreSQL connection, transaction wrapper, and migration runner in `src/infrastructure/db/client.ts` and `src/infrastructure/db/migrate.ts`
- [ ] T014 Create initial identity, catalog, commerce, payment, digital-goods, supplier, support, inbox, outbox, and audit migrations in `src/infrastructure/db/migrations/001_initial.sql`
- [ ] T015 [P] Write migration constraint tests for unique payment transaction, supplier idempotency, asset claim, and active bundle rules in `tests/integration/schema-constraints.test.ts`
- [ ] T016 Implement typed repository transaction boundary and optimistic-version helper in `src/infrastructure/db/transaction.ts` and `src/infrastructure/db/version.ts`
- [ ] T017 [P] Write failing outbox crash/replay integration tests for SR-006 in `tests/integration/outbox-recovery.test.ts`
- [ ] T018 Implement transactional outbox repository, poller, retry budget, and dead-letter state in `src/infrastructure/outbox/repository.ts` and `src/infrastructure/outbox/worker.ts`
- [ ] T019 [P] Write failing structured-log/audit redaction tests for SR-001/SR-005 in `tests/security/telemetry-redaction.test.ts`
- [ ] T020 Implement Pino/OpenTelemetry correlation and redaction policy in `src/infrastructure/observability/logger.ts` and `src/infrastructure/observability/tracing.ts`
- [ ] T021 [P] Write failing Telegram secret/update dedupe/body/rate boundary tests for SR-004/FR-010/FR-024 in `tests/contract/telegram-ingress.test.ts`
- [ ] T022 Implement Fastify Telegram ingress verification, body limits, update inbox dedupe, and per-action rate policy in `src/bot/webhook.ts`, `src/bot/middleware/security.ts`, and `src/modules/risk/service.ts`
- [ ] T023 Implement typed command/event envelope and dispatcher from the application contract in `src/shared/commands/index.ts` and `src/shared/events/index.ts`
- [ ] T024 Create safe vault port plus in-memory test adapter with write/reveal/delete semantics in `src/infrastructure/vault/port.ts` and `src/infrastructure/vault/testing-adapter.ts`

**Checkpoint**: The system can durably accept a deduplicated Telegram update, execute a no-op command, persist an outbox event, and recover it after worker restart without leaking secrets.

---

## Phase 3: User Story 1 - Find and Understand a Product (P1)

**Goal**: Customers browse/search active catalog data and see authoritative offer facts.

**Independent Test**: Seed active/inactive/unauthorized variants and prove browse, deterministic search, bounded natural-language parsing, fallback, pagination, and navigation without creating an Order.

### Tests

- [ ] T025 [P] [US1] Write failing catalog repository tests for active/sellable filtering and stable cursor pagination (FR-002) in `tests/integration/catalog-repository.test.ts`
- [ ] T026 [P] [US1] Write failing deterministic search and Unicode normalization tests (FR-004) in `tests/integration/catalog-search.test.ts`
- [ ] T027 [P] [US1] Write failing parser contract/property tests for allowlisted filters, prompt injection, invalid enums/prices, timeout fallback, and no product facts (FR-004/FR-005) in `tests/contract/search-parser.test.ts`
- [ ] T028 [P] [US1] Write failing Telegram menu/category/product/search acceptance tests for FR-001–FR-005 and SC-001/SC-002 in `tests/acceptance/catalog-journey.test.ts`

### Implementation

- [ ] T029 [P] [US1] Implement Category/Product/ProductVariant/ProductAlias domain types and sellability rules in `src/modules/catalog/domain.ts`
- [ ] T030 [US1] Implement catalog persistence and cursor queries in `src/modules/catalog/repository.ts`
- [ ] T031 [US1] Implement deterministic normalized search and bounded filter query in `src/modules/catalog/search.ts`
- [ ] T032 [P] [US1] Define search-parser port and strict Zod output schema in `src/modules/catalog/search-parser-port.ts`
- [ ] T033 [US1] Implement optional language-model parser adapter with timeout/circuit fallback and no domain tools in `src/modules/catalog/search-parser-adapter.ts`
- [ ] T034 [P] [US1] Implement authoritative product-card presenters and Vietnamese state/error copy in `src/bot/presenters/catalog.ts`
- [ ] T035 [US1] Implement main menu, category, pagination, product detail, and search callbacks in `src/bot/callbacks/catalog.ts`
- [ ] T036 [US1] Add catalog/menu versioned cache with database fallback in `src/modules/catalog/cache.ts`
- [ ] T037 [US1] Seed safe development categories/products/variants and one unauthorized SKU fixture in `src/infrastructure/db/seeds/catalog.ts`
- [ ] T038 [US1] Run the US1 acceptance lane and record actual p95/menu-to-product evidence in `specs/001-telegram-shop-mvp/evidence/us1-catalog.md`

**Checkpoint**: US1 works independently with no payment, supplier, or credential capability.

---

## Phase 4: User Story 2 - Buy and Pay with VietQR (P1)

**Goal**: One variant becomes one immutable Order and only verified/matched SePay evidence settles it.

**Independent Test**: Create one unpaid Order/QR, ingest signed fixtures, and prove valid settlement, mismatch review, replay safety, and reconciliation without fulfillment.

### Tests

- [ ] T039 [P] [US2] Write failing Order snapshot, stale-price, policy-block, double-tap, cancel/expiry, and forged-callback tests for FR-006–FR-008 in `tests/integration/buy-now.test.ts`
- [ ] T040 [P] [US2] Write failing VietQR payload/CRC/presentation fixture tests for FR-008 in `tests/contract/vietqr-presentation.test.ts`
- [ ] T041 [P] [US2] Write failing SePay raw-body HMAC, timestamp, schema, account/direction/amount/content tests for FR-009/SR-002/SR-004 in `tests/contract/sepay-webhook.test.ts`
- [ ] T042 [P] [US2] Write failing 100-event replay and reordered-event property tests for FR-010/SC-005 in `tests/property/payment-idempotency.test.ts`
- [ ] T043 [P] [US2] Write failing partial/over/late/wrong-content/unmatched discrepancy tests for FR-011/SC-008 in `tests/integration/payment-discrepancy.test.ts`
- [ ] T044 [P] [US2] Write failing missing-webhook reconciliation and provider-rate/backoff tests for FR-012 in `tests/integration/payment-reconciliation.test.ts`
- [ ] T045 [US2] Write failing end-to-end Telegram Buy Now to paid Order acceptance test for User Story 2 in `tests/acceptance/payment-journey.test.ts`

### Implementation

- [ ] T046 [P] [US2] Implement Order aggregate, immutable snapshot, transitions, and guards in `src/modules/commerce/order.ts`
- [ ] T047 [P] [US2] Implement PaymentIntent, BankTransaction, PaymentAllocation, and Discrepancy domain types in `src/modules/payments/domain.ts`
- [ ] T048 [US2] Implement transactional BuyNow command with sellability recheck and idempotency fingerprint in `src/modules/commerce/buy-now.ts`
- [ ] T049 [US2] Implement Order/payment repositories and unique-effect conflict mapping in `src/modules/commerce/repository.ts` and `src/modules/payments/repository.ts`
- [ ] T050 [P] [US2] Implement VietQR generator port/adapter and exact amount/content presentation in `src/modules/payments/vietqr.ts`
- [ ] T051 [US2] Implement SePay raw ingress verifier, inbox persistence, and acknowledgement contract in `src/modules/payments/sepay-webhook.ts`
- [ ] T052 [US2] Implement deterministic evidence matcher/allocation and discrepancy decisions in `src/modules/payments/matcher.ts`
- [ ] T053 [US2] Implement `PaymentSettled`/`PaymentNeedsReview` outbox transitions with exactly-once keys in `src/modules/payments/service.ts`
- [ ] T054 [US2] Implement bounded SePay reconciliation adapter, scheduler, cursor/backoff, and discrepancy comparison in `src/modules/payments/reconciliation.ts`
- [ ] T055 [P] [US2] Implement Vietnamese payment/expiry/review presenters with no screenshot instruction in `src/bot/presenters/payment.ts`
- [ ] T056 [US2] Implement Buy Now, payment status refresh, reopen, and unpaid-cancel callbacks in `src/bot/callbacks/checkout.ts`
- [ ] T057 [US2] Add alerts/metrics for signature failures, reference collisions, paid-without-Order, mismatch backlog, and reconciliation lag in `src/modules/payments/telemetry.ts`
- [ ] T058 [US2] Run US2 contract/replay/reconciliation lanes and record evidence in `specs/001-telegram-shop-mvp/evidence/us2-payment.md`

**Checkpoint**: US2 produces paid Orders from SePay truth only and never starts fulfillment from an unverified input.

---

## Phase 5: User Story 3 - Secure Fulfillment and Delivery (P1)

**Goal**: A paid Order claims or provisions one valid asset and exposes it once to its owner.

**Independent Test**: Fulfill one local and one supplier Order, exercise unknown recovery and invalid assets, then prove owner-only atomic reveal and no secret leakage.

### Tests

- [ ] T059 [P] [US3] Write failing 20-buyer final-asset concurrency/property test for FR-014/SC-006 in `tests/property/asset-claim.test.ts`
- [ ] T060 [P] [US3] Write failing Supplier Port schema, idempotency, reject, timeout-unknown, query-before-retry, and malformed-asset contract tests for FR-015/FR-016 in `tests/contract/supplier-port.test.ts`
- [ ] T061 [P] [US3] Write failing fulfillment crash/replay test at paid, supplier accepted, asset claimed, and bundle issued boundaries for FR-010/SR-006 in `tests/integration/fulfillment-recovery.test.ts`
- [ ] T062 [P] [US3] Write failing Delivery Bundle ownership, atomic first-view, expiry, replay, concurrent view, and reissue tests for FR-017/SR-003 in `tests/security/delivery-bundle.test.ts`
- [ ] T063 [P] [US3] Write failing credential scan across DB/log/trace/outbox/ticket/error fixtures for SR-001/SC-007 in `tests/security/credential-leak.test.ts`
- [ ] T064 [US3] Write failing paid-to-delivery acceptance tests for local and supplier paths plus SC-004 timing capture in `tests/acceptance/fulfillment-journey.test.ts`

### Implementation

- [ ] T065 [P] [US3] Implement DigitalAsset, SupplierOrder, DeliveryBundle, and ReplacementCase aggregates/state guards in `src/modules/digital-goods/domain.ts` and `src/modules/supplier/domain.ts`
- [ ] T066 [US3] Implement atomic local asset reserve/claim/release repository in `src/modules/digital-goods/repository.ts`
- [ ] T067 [P] [US3] Implement Supplier Port types, stable errors, and response validation schemas in `src/modules/supplier/port.ts`
- [ ] T068 [US3] Implement first authorized supplier adapter against sandbox fixtures in `src/modules/supplier/adapters/primary.ts`
- [ ] T069 [US3] Implement supplier create/query/cancel/refund/reconcile service with `Unknown` recovery in `src/modules/supplier/service.ts`
- [ ] T070 [US3] Implement asset envelope validation/quarantine and vault ingestion in `src/modules/digital-goods/asset-validation.ts`
- [ ] T071 [US3] Implement paid-Order fulfillment orchestrator with local-then-supplier policy and exactly-once keys in `src/modules/digital-goods/fulfillment.ts`
- [ ] T072 [P] [US3] Implement production vault adapter boundary and secret lifecycle in `src/infrastructure/vault/adapter.ts`
- [ ] T073 [US3] Implement Delivery Bundle issue/reveal/revoke/reissue transaction in `src/modules/digital-goods/delivery.ts`
- [ ] T074 [US3] Implement no-cache authenticated delivery HTTP route with referrer/content security headers in `src/modules/digital-goods/delivery-route.ts`
- [ ] T075 [P] [US3] Implement Vietnamese processing/completed/expired/used/needs-review presenters in `src/bot/presenters/delivery.ts`
- [ ] T076 [US3] Connect payment outbox to fulfillment worker and delivery notification in `src/worker.ts` and `src/modules/digital-goods/handlers.ts`
- [ ] T077 [US3] Add supplier health, unknown-age, invalid-asset, fulfillment-lag, and delivery-reveal metrics/alerts in `src/modules/supplier/telemetry.ts` and `src/modules/digital-goods/telemetry.ts`
- [ ] T078 [US3] Implement replacement/refund-request workflow preserving original asset and Order history in `src/modules/digital-goods/replacement.ts`
- [ ] T079 [US3] Run US3 concurrency/recovery/redaction lanes and record evidence in `specs/001-telegram-shop-mvp/evidence/us3-fulfillment.md`

**Checkpoint**: US3 delivers one valid asset exactly once and raw credentials exist only inside vault/reveal boundaries.

---

## Phase 6: User Story 4 - Order History and Support (P2)

**Goal**: Customers self-serve their own Order status and open safe contextual support tickets.

**Independent Test**: Seed multiple customers/states, prove object ownership and pagination, reopen the same unpaid payment, and open a ticket without payment/credential privilege.

### Tests

- [ ] T080 [P] [US4] Write failing BOLA, cursor pagination, status projection, and unpaid-reopen tests for FR-018/SR-003 in `tests/security/order-history.test.ts`
- [ ] T081 [P] [US4] Write failing structured reason, safe attachment/summary, SLA, and linked-Order tests for FR-019 in `tests/integration/support-ticket.test.ts`
- [ ] T082 [P] [US4] Write failing support privilege tests proving no mark-paid, evidence mutation, direct refund, or credential reveal in `tests/security/support-boundary.test.ts`
- [ ] T083 [US4] Write failing history-to-support acceptance journey in `tests/acceptance/support-journey.test.ts`

### Implementation

- [ ] T084 [US4] Implement customer-scoped Order history/detail read model and cursor repository in `src/modules/commerce/history.ts`
- [ ] T085 [P] [US4] Implement SupportTicket aggregate, reasons, states, SLA, and safe-summary policy in `src/modules/support/domain.ts`
- [ ] T086 [US4] Implement customer-scoped support repository and commands without cross-domain mutation methods in `src/modules/support/service.ts`
- [ ] T087 [P] [US4] Implement Vietnamese Order history/detail/support presenters in `src/bot/presenters/history.ts` and `src/bot/presenters/support.ts`
- [ ] T088 [US4] Implement Order pagination/detail/reopen and structured support callbacks in `src/bot/callbacks/history.ts` and `src/bot/callbacks/support.ts`
- [ ] T089 [US4] Run US4 BOLA/support-boundary lanes and record evidence in `specs/001-telegram-shop-mvp/evidence/us4-support.md`

**Checkpoint**: US4 gives useful self-service without granting payment, supplier, or secret privileges.

---

## Phase 7: User Story 5 - Sole Owner Operations (P2)

**Goal**: Only the configured numeric owner can perform private, confirmed, audited operations.

**Independent Test**: Execute the same action with the configured ID, impersonating username, wrong chat type, expired challenge, duplicate confirmation, and add-admin attempt.

### Tests

- [ ] T090 [P] [US5] Write failing numeric-ID/username-impersonation/private-context authorization tests for FR-021 in `tests/security/root-admin-identity.test.ts`
- [ ] T091 [P] [US5] Write failing `/add-admin` and equivalent capability absence tests for FR-022 in `tests/security/no-add-admin.test.ts`
- [ ] T092 [P] [US5] Write failing confirmation fingerprint/expiry/replay/reason/audit tests for FR-023/SR-005 in `tests/integration/admin-confirmation.test.ts`
- [ ] T093 [US5] Write failing owner catalog-kill-switch and discrepancy-review acceptance test in `tests/acceptance/owner-operations.test.ts`

### Implementation

- [ ] T094 [P] [US5] Implement root identity value/config guard and username drift alert in `src/modules/identity/root-admin.ts`
- [ ] T095 [US5] Implement private-context authorization middleware and deny audit in `src/bot/middleware/root-admin.ts`
- [ ] T096 [US5] Implement expiring action-bound AdminConfirmation aggregate/repository in `src/modules/identity/admin-confirmation.ts`
- [ ] T097 [US5] Implement allowlisted owner commands for catalog activation, discrepancy decision, and operational inspection in `src/bot/callbacks/admin.ts`
- [ ] T098 [US5] Implement append-only audit repository and owner-safe audit presenter in `src/modules/identity/audit.ts` and `src/bot/presenters/admin.ts`
- [ ] T099 [US5] Add alerts for impersonation, failed confirmation, high-risk action, and username drift in `src/modules/identity/telemetry.ts`
- [ ] T100 [US5] Run US5 identity/confirmation/audit lanes and record evidence in `specs/001-telegram-shop-mvp/evidence/us5-admin.md`

**Checkpoint**: No second root administrator exists and every high-risk action is private, confirmed, idempotent, and attributable.

---

## Phase 8: Cross-Cutting Hardening and Pilot Gate

- [ ] T101 [P] Map every FR/SR to tests and tasks and close any uncovered requirement in `specs/001-telegram-shop-mvp/traceability.md`
- [ ] T102 [P] Run STRIDE/OWASP review with evidence and resolve every Critical/High finding in `specs/001-telegram-shop-mvp/security-review.md`
- [ ] T103 [P] Run dependency audit, secret scan, SBOM generation, and container image scan; record results in `specs/001-telegram-shop-mvp/evidence/supply-chain.md`
- [ ] T104 Execute pilot-load catalog, checkout, webhook-ack, and paid-to-delivery tests for SC-003/SC-004 in `tests/performance/pilot-load.test.ts`
- [ ] T105 Execute database backup/isolated restore and projection rebuild drill; record RPO/RTO evidence in `specs/001-telegram-shop-mvp/evidence/restore.md`
- [ ] T106 Write SePay reconciliation and discrepancy operations procedure in `docs/06-operations/RECONCILIATION_RUNBOOK.md`
- [ ] T107 [P] Write supplier outage/unknown/invalid-asset procedure in `docs/06-operations/SUPPLIER_OUTAGE_RUNBOOK.md`
- [ ] T108 [P] Write credential leak, Delivery Bundle revoke, and replacement procedure in `docs/06-operations/CREDENTIAL_INCIDENT_RUNBOOK.md`
- [ ] T109 [P] Write refund/replacement/manual-review procedure and evidence requirements in `docs/06-operations/REFUND_REPLACEMENT_RUNBOOK.md`
- [ ] T110 Create deployment health/readiness checks, safe migration ordering, rollback, and worker-drain procedure in `docs/06-operations/DEPLOYMENT_RUNBOOK.md`
- [ ] T111 Record numeric owner ID verification, supplier authorization per active SKU, SePay production setup, warranty/refund SLA, and Telegram policy decision in `specs/001-telegram-shop-mvp/launch-gates.md`
- [ ] T112 Run `quickstart.md` end-to-end in staging and attach exact command/results to `specs/001-telegram-shop-mvp/evidence/quickstart.md`
- [ ] T113 Run Spec Kit cross-artifact analysis again and resolve all Critical/High findings in `specs/001-telegram-shop-mvp/analysis.md`
- [ ] T114 Run independent code/security review and document residual risk in `specs/001-telegram-shop-mvp/review.md`

## Dependencies & Execution Order

- Phase 1 precedes Phase 2; Phase 2 blocks every user story.
- US1 can complete independently after Phase 2.
- US2 depends on catalog variant data but not US1 Telegram presenters; it may start after catalog domain/repository tasks T029–T031.
- US3 depends on US2 `PaymentSettled` contract and paid Order state.
- US4 depends on Order/support foundations but can proceed parallel to late US3 work.
- US5 depends only on Phase 2 and can proceed parallel to US1–US4 in separate files.
- Phase 8 begins after the selected pilot stories are complete; launch gates block production, not local test development.

## Parallel Opportunities

- Test fixtures, schema constraint tests, observability/redaction, and Telegram ingress tests can run in parallel during Phase 2.
- Within each story, tasks marked `[P]` touch independent files and precede implementation tasks using their results.
- US1, US4, and US5 have largely independent module/file ownership after foundational work.
- No parallel task may mutate the same migration or shared command envelope without explicit coordination.

## Implementation Strategy

1. Complete Setup + Foundational and demonstrate durable no-op ingress/outbox recovery.
2. Complete US1 and validate customer discovery independently.
3. Complete US2 and stop at a paid Order with no fulfillment.
4. Complete US3 for the saleable walking skeleton and run replay/concurrency/redaction gates.
5. Add US4 and US5 recovery/operations surfaces.
6. Complete all hardening and dated launch gates before production activation.

## Format Validation

- Total tasks: 114 (`T001`–`T114`).
- Every task has a checkbox, sequential ID, concrete action, and exact file path.
- User-story tasks carry `[US1]`–`[US5]`; parallel markers are limited to independent files.
- All test tasks precede related implementation tasks.
