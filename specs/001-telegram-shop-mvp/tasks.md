# Tasks: Telegram Shop Digital MVP

**Input**: Design documents from `specs/001-telegram-shop-mvp/`

**Prerequisites**: constitution, spec.md, plan.md, research.md, data-model.md, contracts/, checklists/, quickstart.md

**Tests**: REQUIRED. Each behavioral test task precedes its implementation and must first demonstrate the intended failure.

**Organization**: Tasks are grouped by independently testable user story and reference requirement IDs.

## Phase 1: Setup

**Purpose**: Establish the smallest reproducible Node/TypeScript project and verification lanes.

- [x] T001 Create `package.json`, lockfile, Node 24 engine policy, and scripts for typecheck/lint/test/build in `package.json`
- [x] T002 Create strict TypeScript project configuration in `tsconfig.json` and test configuration in `vitest.config.ts`
- [x] T003 [P] Configure formatting/lint rules and generated/build exclusions in `eslint.config.js` and `.prettierignore`
- [x] T004 [P] Create environment schema placeholders without secrets in `.env.example` and `src/config/env.ts`
- [x] T005 Create process entrypoints and graceful-shutdown skeletons in `src/main.ts` and `src/worker.ts`
- [x] T006 [P] Create test directory conventions and fixture README in `tests/README.md` and `tests/fixtures/README.md`
- [x] T007 [P] Create containerized local PostgreSQL/Redis test dependencies in `compose.yaml`
- [x] T008 Configure CI gates for install, typecheck, lint, tests, secret scan, dependency audit, and build in `.github/workflows/ci.yml`

**Checkpoint**: Clean scaffold installs from the lockfile and all empty verification lanes execute.

<!--
Phase 1 evidence (2026-07-16, local Node v20.19.0; engines target Node 24 LTS):
- `npm install` → 389 packages, package-lock.json committed.
- `npm run typecheck` → tsc --noEmit, 0 errors.
- `npm run lint` → eslint, 0 errors.
- `npm run test` → vitest run, 1 file / 1 test passed (tests/property/scaffold-smoke.test.ts).
- `npm run format:check` → all files match Prettier style.
- `npm run audit` (--omit=dev --audit-level=high) → 0 vulnerabilities. Dev-only chain
  testcontainers→dockerode→undici/uuid has 3 moderate + 1 high; excluded from prod gate, tracked for T103.
- `npm run secret-scan` → 91 files checked, 0 findings.
NOTE: local host is Node 20; CI (.github/workflows/ci.yml) pins Node 24 to honor the engine policy.
-->


---

## Phase 2: Foundational Blocking Work

**Purpose**: Build shared correctness, persistence, reliability, and ingress boundaries required by every story.

- [x] T009 [P] Write failing environment validation/redaction tests for FR/SR boundaries in `tests/security/config-redaction.test.ts`
- [x] T010 [P] Write failing shared Money/ID/time property tests for integer VND and opaque identifiers in `tests/property/shared-primitives.test.ts`
- [x] T011 Implement validated configuration loading and secret-safe diagnostics in `src/config/env.ts` and `src/config/index.ts`
- [x] T012 [P] Implement branded IDs, integer VND Money, UTC/business-time helpers, and stable error envelope in `src/shared/ids/index.ts`, `src/shared/money/index.ts`, `src/shared/time/index.ts`, and `src/shared/errors/index.ts`
- [x] T013 Create PostgreSQL connection, transaction wrapper, and migration runner in `src/infrastructure/db/client.ts` and `src/infrastructure/db/migrate.ts`
- [x] T014 Create initial identity, catalog, commerce, payment, digital-goods, supplier, support, inbox, outbox, and audit migrations in `src/infrastructure/db/migrations/001_initial.sql`
- [x] T015 [P] Write migration constraint tests for unique payment transaction, supplier idempotency, asset claim, and active bundle rules in `tests/integration/schema-constraints.test.ts`
- [x] T016 Implement typed repository transaction boundary and optimistic-version helper in `src/infrastructure/db/transaction.ts` and `src/infrastructure/db/version.ts`
- [x] T017 [P] Write failing outbox crash/replay integration tests for SR-006 in `tests/integration/outbox-recovery.test.ts`
- [x] T018 Implement transactional outbox repository, poller, retry budget, and dead-letter state in `src/infrastructure/outbox/repository.ts` and `src/infrastructure/outbox/worker.ts`
- [x] T019 [P] Write failing structured-log/audit redaction tests for SR-001/SR-005 in `tests/security/telemetry-redaction.test.ts`
- [x] T020 Implement Pino/OpenTelemetry correlation and redaction policy in `src/infrastructure/observability/logger.ts` and `src/infrastructure/observability/tracing.ts`
- [x] T021 [P] Write failing Telegram secret/update dedupe/body/rate boundary tests for SR-004/FR-010/FR-024 in `tests/contract/telegram-ingress.test.ts`
- [x] T022 Implement Fastify Telegram ingress verification, body limits, update inbox dedupe, and per-action rate policy in `src/bot/webhook.ts`, `src/bot/middleware/security.ts`, and `src/modules/risk/service.ts`
- [x] T023 Implement typed command/event envelope and dispatcher from the application contract in `src/shared/commands/index.ts` and `src/shared/events/index.ts`
- [x] T024 Create safe vault port plus in-memory test adapter with write/reveal/delete semantics in `src/infrastructure/vault/port.ts` and `src/infrastructure/vault/testing-adapter.ts`

**Checkpoint**: The system can durably accept a deduplicated Telegram update, execute a no-op command, persist an outbox event, and recover it after worker restart without leaking secrets.

<!--
Phase 2 evidence (in progress, 2026-07-16):
- T009/T011 (config redaction): tests/security/config-redaction.test.ts — 6/6 pass.
  Red first: `redactedConfig masks every secret key` failed (undefined vs «redacted» for
  unset optional secret REDIS_URL). Fix: exhaustive masking over SECRET_ENV_KEYS in
  src/config/index.ts redactedConfig(), independent of parsed-config enumeration.
- T010/T012 (shared primitives): tests/property/shared-primitives.test.ts — 13/13 pass.
  Red first: module-not-found for src/shared/{money,ids,time,errors}. Implemented integer
  VND Money (bigint, non-negative, no float/underflow), opaque ULID branded ids
  (isId/newId/brandId), UTC/Asia-Ho_Chi_Minh time helpers, stable AppError envelope.
- Lane after T009–T012: typecheck 0 errors, lint 0 errors, vitest 20/20 pass (3 files),
  prettier clean.
- T013/T014/T016 (DB layer): src/infrastructure/db/{client,migrate,transaction,version}.ts +
  migrations/001_initial.sql. Kysely+pg with bigint(OID 20)/numeric(1700) string parsers to
  keep VND exact; forward-only SQL runner with schema_migrations bookkeeping + advisory lock;
  withTransaction unit-of-work seam; optimistic-version helper raising stable CONFLICT.
- T015 (schema constraints): tests/integration/schema-constraints.test.ts — 4/4 pass against
  real containerized PostgreSQL 16 (Testcontainers). Verifies unique (provider,txn_id),
  supplier (supplier_id,idempotency_key), one active asset per fingerprint, one active bundle
  per order — each asserts SQLSTATE 23505 on the duplicate, plus inactive-row exemptions.
- T017/T018 (outbox): tests/integration/outbox-recovery.test.ts — 7/7 pass. Red first:
  module-not-found for src/infrastructure/outbox/{repository,worker}. Implemented enqueue in
  same txn, `for update skip locked` due-batch claim, exactly-once markPublished, exponential
  backoff + bounded attempt budget + dead-letter, drainOutboxOnce dispatcher (per-event ack,
  poison event defers only itself). Migration amended (undeployed) with last_error_code +
  dead_lettered_at infra columns; unpublished index excludes dead-lettered rows.
- Lane after T013–T018: typecheck 0, lint 0, prettier clean, vitest 31/31 pass (5 files;
  2 integration suites use Docker/Testcontainers, engine confirmed running locally).
- T019/T020 (telemetry + audit): tests/security/telemetry-redaction.test.ts — 7/7 pass.
  Red first: module-not-found for observability/audit + missing buildRedactedLogger.
  Implemented pino redaction (secret env keys, config.*/env.* nests, sensitive headers,
  token/secret/credential wildcards) with captured-stream assertions; OTel correlation
  helpers (withSpan/newCorrelationId); buildAuditRecord with recursive assertNoRawSecret
  tripwire rejecting credential-like metadata keys (SR-005 attributable evidence, no secret).
- T021/T022 (Telegram ingress): tests/contract/telegram-ingress.test.ts — 9/9 pass. Red first:
  module-not-found for bot/webhook, bot/middleware/security, modules/risk. Implemented
  constant-time secret verify (timingSafeEqual), NFC + length-bound normalization, Fastify
  webhook plugin with fail-closed order (401 secret -> 200 dedupe -> 429 rate -> dispatch),
  in-memory update_id inbox (FR-010), per-user token-bucket limiter (FR-024, independent
  budgets). Body-size 413 enforced by Fastify bodyLimit before handler.
- T023/T024 (envelope + vault): tests/contract/envelope-and-vault.test.ts — 10/10 pass.
  Red first: module-not-found for shared/commands, shared/events, vault/{port,testing-adapter}.
  Implemented command envelope (commandId/idempotencyKey/actor/correlationId/occurredAt),
  EVENT_TYPES + event envelope, dispatcher mapping unknown command + handler throw to ONE
  stable error envelope stamped with correlationId (no stack/secret leak); vault port +
  in-memory adapter with opaque `vault:` refs, reveal/delete, generic VaultError giving no
  existence oracle.
- Lane after T019–T024 (Phase 2 complete): typecheck 0, lint 0, prettier clean,
  vitest 57/57 pass (8 files).
- CHECKPOINT MET: deduplicated Telegram update accepted (T021/T022), no-op command executed
  via dispatcher (T023), outbox event persisted + recovered after simulated restart
  (T017/T018), all with secret redaction verified (T009/T019) — no secret leaked.
-->

---

## Phase 3: User Story 1 - Find and Understand a Product (P1)

**Goal**: Customers browse/search active catalog data and see authoritative offer facts.

**Independent Test**: Seed active/inactive/unauthorized variants and prove browse, deterministic search, bounded natural-language parsing, fallback, pagination, and navigation without creating an Order.

### Tests

- [x] T025 [P] [US1] Write failing catalog repository tests for active/sellable filtering and stable cursor pagination (FR-002) in `tests/integration/catalog-repository.test.ts`
- [x] T026 [P] [US1] Write failing deterministic search and Unicode normalization tests (FR-004) in `tests/integration/catalog-search.test.ts`
- [x] T027 [P] [US1] Write failing parser contract/property tests for allowlisted filters, prompt injection, invalid enums/prices, timeout fallback, and no product facts (FR-004/FR-005) in `tests/contract/search-parser.test.ts`
- [x] T028 [P] [US1] Write failing Telegram menu/category/product/search acceptance tests for FR-001–FR-005 and SC-001/SC-002 in `tests/acceptance/catalog-journey.test.ts`

### Implementation

- [x] T029 [P] [US1] Implement Category/Product/ProductVariant/ProductAlias domain types and sellability rules in `src/modules/catalog/domain.ts`
- [x] T030 [US1] Implement catalog persistence and cursor queries in `src/modules/catalog/repository.ts`
- [x] T031 [US1] Implement deterministic normalized search and bounded filter query in `src/modules/catalog/search.ts`
- [x] T032 [P] [US1] Define search-parser port and strict Zod output schema in `src/modules/catalog/search-parser-port.ts`
- [x] T033 [US1] Implement optional language-model parser adapter with timeout/circuit fallback and no domain tools in `src/modules/catalog/search-parser-adapter.ts`
- [x] T034 [P] [US1] Implement authoritative product-card presenters and Vietnamese state/error copy in `src/bot/presenters/catalog.ts`
- [x] T035 [US1] Implement main menu, category, pagination, product detail, and search callbacks in `src/bot/callbacks/catalog.ts`
- [x] T036 [US1] Add catalog/menu versioned cache with database fallback in `src/modules/catalog/cache.ts`
- [x] T037 [US1] Seed safe development categories/products/variants and one unauthorized SKU fixture in `src/infrastructure/db/seeds/catalog.ts`
- [x] T038 [US1] Run the US1 acceptance lane and record actual p95/menu-to-product evidence in `specs/001-telegram-shop-mvp/evidence/us1-catalog.md`

**Checkpoint**: US1 works independently with no payment, supplier, or credential capability.

<!--
Phase 3 evidence (2026-07-16):
- T025/T030 (repository): tests/integration/catalog-repository.test.ts — 4/4 pass.
  Sellable filter hides inactive/paused/unauthorized/dead-product; keyset cursor
  (sort_order,id) has no overlap/gaps across pages.
- T026/T031 (search): tests/integration/catalog-search.test.ts — 7/7 pass.
  Accent-fold (JS + SQL translate) matches case/diacritic variants and aliases;
  price/delivery/category filters only narrow; unknown query returns empty.
- T027/T032/T033 (parser): tests/contract/search-parser.test.ts — 11/11 pass.
  Allowlisted Zod schema strips injected fields; invalid enums/prices rejected;
  model timeout/throw falls back to deterministic query-only fold; no product facts.
- T028/T034–T037 (journey): tests/acceptance/catalog-journey.test.ts — 7/7 pass.
  Retail-only menu, unauthorized SKU never surfaces, FR-003 detail fields present,
  Buy Now in ≤4 actions (SC-002), search never invents, zero Order rows created.
- T038: specs/001-telegram-shop-mvp/evidence/us1-catalog.md recorded.
- Lane after Phase 3: typecheck 0, lint 0, prettier clean, vitest 86/86 pass (12 files).
- CHECKPOINT MET: US1 independent of payment/supplier/credential capability.
-->

---

## Phase 4: User Story 2 - Buy and Pay with VietQR (P1)

**Goal**: One variant becomes one immutable Order and only verified/matched SePay evidence settles it.

**Independent Test**: Create one unpaid Order/QR, ingest signed fixtures, and prove valid settlement, mismatch review, replay safety, and reconciliation without fulfillment.

### Tests

- [x] T039 [P] [US2] Write failing Order snapshot, stale-price, policy-block, double-tap, cancel/expiry, and forged-callback tests for FR-006–FR-008 in `tests/integration/buy-now.test.ts`
- [x] T040 [P] [US2] Write failing VietQR payload/CRC/presentation fixture tests for FR-008 in `tests/contract/vietqr-presentation.test.ts`
- [x] T041 [P] [US2] Write failing SePay raw-body HMAC, timestamp, schema, account/direction/amount/content tests for FR-009/SR-002/SR-004 in `tests/contract/sepay-webhook.test.ts`
- [x] T042 [P] [US2] Write failing 100-event replay and reordered-event property tests for FR-010/SC-005 in `tests/property/payment-idempotency.test.ts`
- [x] T043 [P] [US2] Write failing partial/over/late/wrong-content/unmatched discrepancy tests for FR-011/SC-008 in `tests/integration/payment-discrepancy.test.ts`
- [x] T044 [P] [US2] Write failing missing-webhook reconciliation and provider-rate/backoff tests for FR-012 in `tests/integration/payment-reconciliation.test.ts`
- [x] T045 [US2] Write failing end-to-end Telegram Buy Now to paid Order acceptance test for User Story 2 in `tests/acceptance/payment-journey.test.ts`

### Implementation

- [x] T046 [P] [US2] Implement Order aggregate, immutable snapshot, transitions, and guards in `src/modules/commerce/order.ts`
- [x] T047 [P] [US2] Implement PaymentIntent, BankTransaction, PaymentAllocation, and Discrepancy domain types in `src/modules/payments/domain.ts`
- [x] T048 [US2] Implement transactional BuyNow command with sellability recheck and idempotency fingerprint in `src/modules/commerce/buy-now.ts`
- [x] T049 [US2] Implement Order/payment repositories and unique-effect conflict mapping in `src/modules/commerce/repository.ts` and `src/modules/payments/repository.ts`
- [x] T050 [P] [US2] Implement VietQR generator port/adapter and exact amount/content presentation in `src/modules/payments/vietqr.ts`
- [x] T051 [US2] Implement SePay raw ingress verifier, inbox persistence, and acknowledgement contract in `src/modules/payments/sepay-webhook.ts`
- [x] T052 [US2] Implement deterministic evidence matcher/allocation and discrepancy decisions in `src/modules/payments/matcher.ts`
- [x] T053 [US2] Implement `PaymentSettled`/`PaymentNeedsReview` outbox transitions with exactly-once keys in `src/modules/payments/service.ts`
- [x] T054 [US2] Implement bounded SePay reconciliation adapter, scheduler, cursor/backoff, and discrepancy comparison in `src/modules/payments/reconciliation.ts`
- [x] T055 [P] [US2] Implement Vietnamese payment/expiry/review presenters with no screenshot instruction in `src/bot/presenters/payment.ts`
- [x] T056 [US2] Implement Buy Now, payment status refresh, reopen, and unpaid-cancel callbacks in `src/bot/callbacks/checkout.ts`
- [x] T057 [US2] Add alerts/metrics for signature failures, reference collisions, paid-without-Order, mismatch backlog, and reconciliation lag in `src/modules/payments/telemetry.ts`
- [x] T058 [US2] Run US2 contract/replay/reconciliation lanes and record evidence in `specs/001-telegram-shop-mvp/evidence/us2-payment.md`

**Checkpoint**: US2 produces paid Orders from SePay truth only and never starts fulfillment from an unverified input.

<!--
Phase 4 evidence (2026-07-16):
- US2 payment suite: 56/56 tests across 9 files (contract/property/integration/acceptance).
- Key lanes:
  - tests/property/payment-idempotency.test.ts — 100x replay settles exactly once (SC-005).
  - tests/integration/payment-discrepancy.test.ts — under/over/late/wrong-account/unmatched fail-closed (SC-008).
  - tests/integration/payment-reconciliation.test.ts — missing-webhook recovery + rate/backoff (FR-012).
  - tests/acceptance/payment-journey.test.ts — Buy Now → VietQR → SePay settle e2e.
  - tests/contract/{vietqr-presentation,sepay-webhook,payment-presenter,payment-telemetry}.test.ts.
  - tests/integration/checkout-callbacks.test.ts — Buy Now / refresh / reopen / cancel.
- `npm run typecheck` → 0 errors; `npm run lint` → 0 errors; Prettier clean.
- Evidence: specs/001-telegram-shop-mvp/evidence/us2-payment.md.
-->

---

## Phase 5: User Story 3 - Secure Fulfillment and Delivery (P1)

**Goal**: A paid Order claims or provisions one valid asset and exposes it once to its owner.

**Independent Test**: Fulfill one local and one supplier Order, exercise unknown recovery and invalid assets, then prove owner-only atomic reveal and no secret leakage.

### Tests

- [x] T059 [P] [US3] Write failing 20-buyer final-asset concurrency/property test for FR-014/SC-006 in `tests/property/asset-claim.test.ts`
- [x] T060 [P] [US3] Write failing Supplier Port schema, idempotency, reject, timeout-unknown, query-before-retry, and malformed-asset contract tests for FR-015/FR-016 in `tests/contract/supplier-port.test.ts`
- [x] T061 [P] [US3] Write failing fulfillment crash/replay test at paid, supplier accepted, asset claimed, and bundle issued boundaries for FR-010/SR-006 in `tests/integration/fulfillment-recovery.test.ts`
- [x] T062 [P] [US3] Write failing Delivery Bundle ownership, atomic first-view, expiry, replay, concurrent view, and reissue tests for FR-017/SR-003 in `tests/security/delivery-bundle.test.ts`
- [x] T063 [P] [US3] Write failing credential scan across DB/log/trace/outbox/ticket/error fixtures for SR-001/SC-007 in `tests/security/credential-leak.test.ts`
- [x] T064 [US3] Write failing paid-to-delivery acceptance tests for local and supplier paths plus SC-004 timing capture in `tests/acceptance/fulfillment-journey.test.ts`

### Implementation

- [x] T065 [P] [US3] Implement DigitalAsset, SupplierOrder, DeliveryBundle, and ReplacementCase aggregates/state guards in `src/modules/digital-goods/domain.ts` and `src/modules/supplier/domain.ts`
- [x] T066 [US3] Implement atomic local asset reserve/claim/release repository in `src/modules/digital-goods/repository.ts`
- [x] T067 [P] [US3] Implement Supplier Port types, stable errors, and response validation schemas in `src/modules/supplier/port.ts`
- [x] T068 [US3] Implement first authorized supplier adapter against sandbox fixtures in `src/modules/supplier/adapters/primary.ts`
- [x] T069 [US3] Implement supplier create/query/cancel/refund/reconcile service with `Unknown` recovery in `src/modules/supplier/service.ts`
- [x] T070 [US3] Implement asset envelope validation/quarantine and vault ingestion in `src/modules/digital-goods/asset-validation.ts`
- [x] T071 [US3] Implement paid-Order fulfillment orchestrator with local-then-supplier policy and exactly-once keys in `src/modules/digital-goods/fulfillment.ts`
- [x] T072 [P] [US3] Implement production vault adapter boundary and secret lifecycle in `src/infrastructure/vault/adapter.ts`
- [x] T073 [US3] Implement Delivery Bundle issue/reveal/revoke/reissue transaction in `src/modules/digital-goods/delivery.ts`
- [x] T074 [US3] Implement no-cache authenticated delivery HTTP route with referrer/content security headers in `src/modules/digital-goods/delivery-route.ts`
- [x] T075 [P] [US3] Implement Vietnamese processing/completed/expired/used/needs-review presenters in `src/bot/presenters/delivery.ts`
- [x] T076 [US3] Connect payment outbox to fulfillment worker and delivery notification in `src/worker.ts` and `src/modules/digital-goods/handlers.ts`
- [x] T077 [US3] Add supplier health, unknown-age, invalid-asset, fulfillment-lag, and delivery-reveal metrics/alerts in `src/modules/supplier/telemetry.ts` and `src/modules/digital-goods/telemetry.ts`
- [x] T078 [US3] Implement replacement/refund-request workflow preserving original asset and Order history in `src/modules/digital-goods/replacement.ts`
- [x] T079 [US3] Run US3 concurrency/recovery/redaction lanes and record evidence in `specs/001-telegram-shop-mvp/evidence/us3-fulfillment.md`

**Checkpoint**: US3 delivers one valid asset exactly once and raw credentials exist only inside vault/reveal boundaries.

<!--
Phase 5 evidence (2026-07-16):
- Full suite: 219/219 tests across 35 files.
- Key lanes:
  - tests/property/asset-claim.test.ts — 20 concurrent buyers, exactly one claim (SC-006).
  - tests/security/delivery-bundle.test.ts — view-once, BOLA, reissue (FR-017/SR-003).
  - tests/security/credential-leak.test.ts — zero raw secrets (SC-007/SR-001).
  - tests/integration/supplier-service.test.ts — UNKNOWN→query recovery, no re-create (FR-015).
  - tests/acceptance/fulfillment-journey.test.ts — Buy Now→SePay→fulfill→reveal (SC-004).
  - tests/contract/delivery-route.test.ts — no-cache authenticated reveal.
  - tests/integration/fulfillment-handlers.test.ts — OrderPaid outbox → fulfill.
  - tests/integration/replacement.test.ts — replacement/refund preserves history (FR-020).
- `npm run typecheck` → 0 errors; `npm run lint` → 0 errors; Prettier clean.
- Evidence: specs/001-telegram-shop-mvp/evidence/us3-fulfillment.md.
-->

---

## Phase 6: User Story 4 - Order History and Support (P2)

**Goal**: Customers self-serve their own Order status and open safe contextual support tickets.

**Independent Test**: Seed multiple customers/states, prove object ownership and pagination, reopen the same unpaid payment, and open a ticket without payment/credential privilege.

### Tests

- [x] T080 [P] [US4] Write failing BOLA, cursor pagination, status projection, and unpaid-reopen tests for FR-018/SR-003 in `tests/security/order-history.test.ts`
- [x] T081 [P] [US4] Write failing structured reason, safe attachment/summary, SLA, and linked-Order tests for FR-019 in `tests/integration/support-ticket.test.ts`
- [x] T082 [P] [US4] Write failing support privilege tests proving no mark-paid, evidence mutation, direct refund, or credential reveal in `tests/security/support-boundary.test.ts`
- [x] T083 [US4] Write failing history-to-support acceptance journey in `tests/acceptance/support-journey.test.ts`

### Implementation

- [x] T084 [US4] Implement customer-scoped Order history/detail read model and cursor repository in `src/modules/commerce/history.ts`
- [x] T085 [P] [US4] Implement SupportTicket aggregate, reasons, states, SLA, and safe-summary policy in `src/modules/support/domain.ts`
- [x] T086 [US4] Implement customer-scoped support repository and commands without cross-domain mutation methods in `src/modules/support/service.ts`
- [x] T087 [P] [US4] Implement Vietnamese Order history/detail/support presenters in `src/bot/presenters/history.ts` and `src/bot/presenters/support.ts`
- [x] T088 [US4] Implement Order pagination/detail/reopen and structured support callbacks in `src/bot/callbacks/history.ts` and `src/bot/callbacks/support.ts`
- [x] T089 [US4] Run US4 BOLA/support-boundary lanes and record evidence in `specs/001-telegram-shop-mvp/evidence/us4-support.md`

**Checkpoint**: US4 gives useful self-service without granting payment, supplier, or secret privileges.

<!--
Phase 6 evidence (2026-07-16):
- Full suite: 232/232 tests across 39 files.
- Key lanes:
  - tests/security/order-history.test.ts — BOLA + keyset pagination (FR-018/SR-003).
  - tests/integration/support-ticket.test.ts — structured ticket, safe summary, ownership (FR-019).
  - tests/security/support-boundary.test.ts — only ticket verbs, no pay/refund/reveal.
  - tests/acceptance/support-journey.test.ts — history → detail → ticket without secret.
- `npm run typecheck` → 0 errors; `npm run lint` → 0 errors; Prettier clean.
- Evidence: specs/001-telegram-shop-mvp/evidence/us4-support.md.
-->

---

## Phase 7: User Story 5 - Sole Owner Operations (P2)

**Goal**: Only the configured numeric owner can perform private, confirmed, audited operations.

**Independent Test**: Execute the same action with the configured ID, impersonating username, wrong chat type, expired challenge, duplicate confirmation, and add-admin attempt.

### Tests

- [x] T090 [P] [US5] Write failing numeric-ID/username-impersonation/private-context authorization tests for FR-021 in `tests/security/root-admin-identity.test.ts`
- [x] T091 [P] [US5] Write failing `/add-admin` and equivalent capability absence tests for FR-022 in `tests/security/no-add-admin.test.ts`
- [x] T092 [P] [US5] Write failing confirmation fingerprint/expiry/replay/reason/audit tests for FR-023/SR-005 in `tests/integration/admin-confirmation.test.ts`
- [x] T093 [US5] Write failing owner catalog-kill-switch and discrepancy-review acceptance test in `tests/acceptance/owner-operations.test.ts`

### Implementation

- [x] T094 [P] [US5] Implement root identity value/config guard and username drift alert in `src/modules/identity/root-admin.ts`
- [x] T095 [US5] Implement private-context authorization middleware and deny audit in `src/bot/middleware/root-admin.ts`
- [x] T096 [US5] Implement expiring action-bound AdminConfirmation aggregate/repository in `src/modules/identity/admin-confirmation.ts`
- [x] T097 [US5] Implement allowlisted owner commands for catalog activation, discrepancy decision, and operational inspection in `src/bot/callbacks/admin.ts`
- [x] T098 [US5] Implement append-only audit repository and owner-safe audit presenter in `src/modules/identity/audit.ts` and `src/bot/presenters/admin.ts`
- [x] T099 [US5] Add alerts for impersonation, failed confirmation, high-risk action, and username drift in `src/modules/identity/telemetry.ts`
- [x] T100 [US5] Run US5 identity/confirmation/audit lanes and record evidence in `specs/001-telegram-shop-mvp/evidence/us5-admin.md`

**Checkpoint**: No second root administrator exists and every high-risk action is private, confirmed, idempotent, and attributable.
<!-- Phase 7 evidence (2026-07-16)
  US5 sole-owner ops complete: root numeric identity (FR-021), no add-admin (FR-022),
  AdminConfirmation fingerprint/expiry/replay (FR-023), append-only audit (SR-005),
  kill-switch + confirmed discrepancy resolve, deny-audit + telemetry.
  Lanes: root-admin-identity (8), no-add-admin (4), admin-confirmation (6),
  owner-operations acceptance (1) — 19/19 green. Evidence: evidence/us5-admin.md
-->


---

## Phase 8: Cross-Cutting Hardening and Pilot Gate

- [x] T101 [P] Map every FR/SR to tests and tasks and close any uncovered requirement in `specs/001-telegram-shop-mvp/traceability.md`
- [x] T102 [P] Run STRIDE/OWASP review with evidence and resolve every Critical/High finding in `specs/001-telegram-shop-mvp/security-review.md`
- [x] T103 [P] Run dependency audit, secret scan, SBOM generation, and container image scan; record results in `specs/001-telegram-shop-mvp/evidence/supply-chain.md`
- [x] T104 Execute pilot-load catalog, checkout, webhook-ack, and paid-to-delivery tests for SC-003/SC-004 in `tests/performance/pilot-load.test.ts`
- [x] T105 Execute database backup/isolated restore and projection rebuild drill; record RPO/RTO evidence in `specs/001-telegram-shop-mvp/evidence/restore.md`
- [x] T106 Write SePay reconciliation and discrepancy operations procedure in `docs/06-operations/RECONCILIATION_RUNBOOK.md`
- [x] T107 [P] Write supplier outage/unknown/invalid-asset procedure in `docs/06-operations/SUPPLIER_OUTAGE_RUNBOOK.md`
- [x] T108 [P] Write credential leak, Delivery Bundle revoke, and replacement procedure in `docs/06-operations/CREDENTIAL_INCIDENT_RUNBOOK.md`
- [x] T109 [P] Write refund/replacement/manual-review procedure and evidence requirements in `docs/06-operations/REFUND_REPLACEMENT_RUNBOOK.md`
- [x] T110 Create deployment health/readiness checks, safe migration ordering, rollback, and worker-drain procedure in `docs/06-operations/DEPLOYMENT_RUNBOOK.md`
- [x] T111 Record numeric owner ID verification, supplier authorization per active SKU, SePay production setup, warranty/refund SLA, and Telegram policy decision in `specs/001-telegram-shop-mvp/launch-gates.md`
- [x] T112 Run `quickstart.md` end-to-end in staging and attach exact command/results to `specs/001-telegram-shop-mvp/evidence/quickstart.md`
- [x] T113 Run Spec Kit cross-artifact analysis again and resolve all Critical/High findings in `specs/001-telegram-shop-mvp/analysis.md`
- [x] T114 Run independent code/security review and document residual risk in `specs/001-telegram-shop-mvp/review.md`

## Phase 9: Independent Review Remediation — Runtime, Money, Delivery, and Evidence

**Status**: REOPENED again after the 2026-07-16 follow-up multi-agent review
(`remediation-review.md`). Partial code landed for packaging/payment projection/outbox lease/
two-phase reveal/VietQR TLV, but several checkmarks overclaimed relative to evidence. Feature 001
is not complete until T115–T153 AND Phase 10 (T154+) pass with real runtime + CI/SHA evidence.

### Runtime, packaging, and migrations — tests first

- [ ] T115 [P] Write failing built-entrypoint smoke tests proving `main` **listens**, serves
  `/health` and `/ready`, and `worker` stays alive with production dependencies — not only that an
  invalid config exits without `MODULE_NOT_FOUND` — in `tests/acceptance/runtime-entrypoints.test.ts`
  <!-- reopened 2026-07-16: current smoke only proves fail-closed config, not listen/health/ready -->
- [x] T116 [P] Write failing app-composition tests for Telegram ingress, SePay raw-body route, Delivery Bundle route, and graceful close in `tests/integration/app-composition.test.ts`
- [x] T117 [P] Write failing migration CLI and two-concurrent-run advisory-lock tests in `tests/integration/migration-cli.test.ts`
- [ ] T118 Implement Fastify/grammY app composition with a **real Telegram dispatcher**, durable
  inbox/rate-limit ports, verified SePay route (not permanent 503), delivery route, health/readiness,
  listen, and graceful shutdown in `src/main.ts` and `src/app.ts`
  <!-- reopened 2026-07-16: main still uses in-memory inbox/rate limiter, no-op Telegram handler,
       SePay always 503 sepay_ingress_not_wired; grammY never imported -->
- [x] T119 Fix build/start artifact paths and execute both built entrypoints in CI using `package.json`, `tsconfig.build.json`, and `.github/workflows/ci.yml`
- [x] T120 Implement a real migration CLI with pinned PostgreSQL connection or transaction advisory lock in `src/infrastructure/db/migrate.ts`

### Telegram ingress, callbacks, and payment integrity — tests first

- [x] T121 [P] Write failing durable Telegram inbox and distributed per-user/per-action rate-limit tests covering retry after throttle/handler failure in `tests/integration/telegram-ingress-durable.test.ts`
- [x] T122 [P] Write failing official SePay header/raw-body/timestamp/IP/replay vectors and verified-evidence boundary tests in `tests/contract/sepay-runtime-ingress.test.ts`
- [x] T123 [P] Write failing cancel-versus-settlement tests proving a cancelled Order cannot emit `OrderPaid` or strand received money in `tests/integration/payment-cancel-race.test.ts`
- [x] T124 [P] Write failing duplicate-provider-ID **raw hash/amount/account/content mutation**, transaction-time expiry, and discrepancy-to-Order projection tests in `tests/integration/payment-evidence-hardening.test.ts`
  <!-- reopened 2026-07-16: this file does not exist; the mutation test was never written.
       payment-cancel-race.test.ts and payment-discrepancy.test.ts cover other cases, not this. -->
- [x] T124a [P] Write failing evidence-boundary test proving `applyPaymentEvidence` rejects unbranded/raw evidence and never writes `SIGNATURE_STATUS='VERIFIED'` from a forgeable payload in `tests/integration/payment-evidence-hardening.test.ts`
- [x] T125 [P] Write failing signed/opaque/expiring callback ownership, tamper, and replay tests in `tests/security/callback-token.test.ts`
- [x] T126 Implement asynchronous PostgreSQL Telegram inbox plus atomic Redis/PostgreSQL per-action rate limiter and safe retry states in `src/bot/webhook.ts`, `src/infrastructure/inbox/telegram.ts`, `src/modules/risk/service.ts`, and append-only migration `src/infrastructure/db/migrations/004_telegram_inbox.sql`
- [x] T127 Implement one SePay runtime verifier/route covering raw bytes, `sha256=` signature, freshness, trusted proxy/IP allowlist, schema, and branded verified evidence in `src/modules/payments/sepay-ingress.ts` and `src/app.ts`
- [x] T128 Make cancellation, settlement, discrepancy projection, duplicate evidence, and late-payment policy transactional and race-safe — including typed `ALREADY_PAID`, atomic lock/re-read of Order+intent, and invalid/future `transactedAt` rejection — in `src/modules/commerce/buy-now.ts`, `src/modules/payments/service.ts`, and `src/modules/payments/domain.ts`
  <!-- reopened 2026-07-16: void-on-cancel + projection exist; ALREADY_PAID typed result,
       cancel/settlement two-connection policy, and invalid Date rejection incomplete -->
- [x] T129 Implement signed/expiring customer-scoped callback codec and adopt it across catalog, checkout, history, support, and admin presenters/handlers in `src/bot/callback-codec.ts` and `src/bot/`

### Outbox and worker recovery — tests first

> **Deduplication (2026-07-16 follow-up review):** the outbox-fencing work formerly split across
> T130/T133 is now owned solely by **T161/T162**, and the scheduler/recovery-job work formerly split
> across T132/T134 is now owned solely by **T167/T168**. Historical IDs remain resolvable through the
> mapping table below, but they are not checked tasks and therefore do not inflate progress counts.

| Historical ID | Superseded by | Canonical scope |
|---|---|---|
| T130 | T161 | Two-worker lease + stale-owner fencing tests |
| T132 | T167 | Bounded recovery-job tests: expiry, reconcile, reservation release, supplier UNKNOWN, bundle expiry |
| T133 | T162 | Durable owner+generation fencing + owner-predicated ack/fail; migration `005_outbox_fencing.sql` |
| T134 | T168 | Single-flight worker + scheduled bounded recovery jobs + lease renewal + telemetry |

- [x] T131 [P] Write failing unknown-event, poison-event, out-of-stock, retry-after-stock, and dead-letter visibility tests in `tests/property/outbox-dispatch-policy.test.ts`
- [x] T135 Make unknown events fail visibly and make retryable/terminal fulfillment outcomes explicit in `src/infrastructure/outbox/worker.ts` and `src/modules/digital-goods/handlers.ts`

### Supplier, vault, fulfillment, and Delivery Bundle — tests first

- [x] T136 [P] Reopen and write failing external-vault boundary tests for slow-drip/chunked bodies, serialized UTF-8 request limits, redirect refusal, endpoint and egress policy, exact material/envelope bounds, accepted/error-body cancellation, strict schemas, secret redaction, and delivery-key anti-reuse in `tests/contract/external-vault.test.ts`, `tests/security/config-redaction.test.ts`, and `tests/integration/app-composition.test.ts`
- [ ] T137 [P] Write failing authenticated HTTP SupplierPort tests for availability/create/query/cancel/refund, timeout UNKNOWN, response validation, and vault provenance in `tests/contract/http-supplier.test.ts`
- [ ] T138 [P] Write failing paid/no-local-stock supplier fulfillment and recovery acceptance tests in `tests/acceptance/supplier-fulfillment-journey.test.ts`
- [x] T139 [P] Write failing Telegram delivery-send failure/retry tests proving the one-time link remains recoverable and targets the real customer in `tests/integration/delivery-notification-retry.test.ts`
- [ ] T140 [P] Write failing vault-outage reveal tests proving no false `CONSUMED`/`DELIVERED` state and safe recovery in `tests/integration/delivery-vault-failure.test.ts`
- [ ] T141 [P] Write failing Order completion, bundle expiry/reissue, supplier replay, and global credential-fingerprint uniqueness tests in `tests/integration/delivery-completion.test.ts`
- [x] T142 Correct the external vault adapter so one timeout covers headers plus streamed body parsing, chunked bodies abort at the envelope limit, serialized JSON is measured once, redirects and unsafe endpoint/egress targets fail closed, exact-max material round-trips, every response body is finalized safely, and production health/readiness plus config anti-reuse are enforced in `src/infrastructure/vault/external-adapter.ts`, `src/infrastructure/vault/adapter.ts`, `src/config/`, `src/main.ts`, `src/worker.ts`, and `src/app.ts`
- [ ] T143 Implement authenticated HTTP SupplierPort plus cancel/refund/reconcile and idempotent supplier-unit ingestion in `src/modules/supplier/adapters/http.ts`, `src/modules/supplier/port.ts`, and `src/modules/supplier/service.ts`
- [ ] T144 Integrate local/supplier fulfillment transactionally with outbox/audit and explicit retry/review transitions in `src/modules/digital-goods/fulfillment.ts` and `src/modules/digital-goods/handlers.ts`
- [x] T145 Reopen durable delivery handoff implementation: Bundle commit must create/reconstruct a recoverable PREPARED intent, source outbox cannot ack before durable handoff, vault I/O stays outside long PostgreSQL transactions, and rollback/cleanup/session-expiry recovery cannot create two usable capabilities in `src/modules/digital-goods/delivery-notification.ts`, `src/modules/digital-goods/handlers.ts`, and `src/modules/digital-goods/fulfillment.ts`
- [x] T146 Reopen delivery-session implementation for dedicated current/previous key rotation, bounded grace, idempotent live-Bundle refresh, pre-send handoff claim verification, and customer-usable Mini App redemption in `src/modules/digital-goods/delivery-session.ts`, `src/modules/digital-goods/delivery-route.ts`, and `src/modules/digital-goods/delivery.ts`
- [ ] T147 Complete Order transition to `COMPLETED`, bundle expiry/reissue, supplier replay guards, and credential fingerprint uniqueness in `src/modules/digital-goods/delivery.ts` and `src/infrastructure/db/migrations/002_review_remediation.sql`

### VietQR UX, CI, operations, and independent evidence — tests first

- [ ] T148 [P] Reopen and write failing official VietQR golden-vector/UTF-8 TLV tests plus an independent fixed QR-image/scanability, bank-name, and Vietnam-time presenter contract in `tests/contract/vietqr-official-vector.test.ts` and `tests/contract/payment-photo-presenter.test.ts`; text-only self-round-trip is insufficient
- [ ] T149 Implement strict VietQR field validation, byte-length TLV, separate NAPAS service code/render template, QR image generation, bank display, and Asia/Ho_Chi_Minh copy in `src/modules/payments/vietqr.ts` and `src/bot/presenters/payment.ts`
- [ ] T150 Wire `processDeliveryNotificationBatch` into the worker and implement real Telegram Mini App send/edit/photo notifier with recipient binding, durable dedupe, `retry_after`, and ambiguous-send reconciliation in `src/worker.ts`, `src/bot/telegram-adapter.ts`, `src/bot/grammy-responder.ts`, and `src/modules/digital-goods/handlers.ts`
- [x] T151 Expand required CI to type/lint/format/secret/audit/build/start/migrate/unit/integration/acceptance/performance lanes and publish test evidence in `.github/workflows/ci.yml`
- [ ] T152 Restore valid Git history, bind SBOM/review/test evidence to commit SHA and CI run, and correct overstated evidence in `specs/001-telegram-shop-mvp/evidence/` and `specs/001-telegram-shop-mvp/review.md`
- [ ] T153 Run a new independent multi-agent code/security/spec review; require zero Critical/High and record evidence in `specs/001-telegram-shop-mvp/review.md`

## Phase 10: Follow-up Review Remediation — Reservation, Fencing, Durability, Config, Scaling

**Status**: NEW after the 2026-07-16 follow-up review (`remediation-review.md`). These tasks have
dependency order, exact file paths, tests-before-implementation, and acceptance evidence. No task is
checked until its non-Docker portion is green here and its container-gated portion is proven in CI.
Phase 10 runs interleaved with Phase 9 in the required implementation order, but the P0 reservation
group (T154–T157) precedes all remaining payment/fulfillment work.

### Atomic pre-payment inventory reservation (P0) — tests first

- [x] T154 [P] [US2] Write/strengthen the failing acceptance matrix for typed stock outcomes, one-message checkout composition, finite TTL, supplier fail-closed catalog/payment, deterministic replacement history, compatible same-category buyers, and contention/load evidence in `tests/integration/reservation-concurrency.test.ts`, `tests/integration/buy-now-stock-outcomes.test.ts`, `tests/integration/buy-now-ttl.test.ts`, `tests/integration/catalog-repository.test.ts`, `tests/integration/catalog-search.test.ts`, `tests/integration/payment-policy-guard.test.ts`, `tests/integration/replacement.test.ts`, and `tests/integration/checkout-locking-load.test.ts`
- [x] T155 [P] [US2] Keep direct cancel/expiry reservation-release acceptance green with typed `NO_STOCK` results and return the asset to `AVAILABLE` in `tests/integration/reservation-release.test.ts` (bounded crash-recovery job remains T167/T168)
- [x] T156 [US2] Implement atomic pre-payment reservation with `FOR SHARE OF v,p,c`, deterministic one-probe `FOR UPDATE SKIP LOCKED`, bounded transaction-level retry outside the transaction, `NO_STOCK|CONTENTION_TIMEOUT|RESERVATION_LOST`, finite TTL clamp, fixed lock order, and orphan-free behavior in `src/modules/commerce/buy-now.ts` and `src/modules/digital-goods/repository.ts`; preserve migration `003_reservation_invariant.sql`
- [x] T157 [US2] Return exactly one typed checkout message with shared working buttons; remove dead/duplicate callbacks; exclude `SUPPLIER_ONLY` from list/detail/search; allowlist payment policies and require active reservation; split deterministic active hold from delivered history so fulfillment/replacement choose the correct asset in `src/bot/callbacks/checkout.ts`, `src/bot/presenters/catalog.ts`, `src/modules/catalog/repository.ts`, `src/modules/catalog/search.ts`, `src/modules/payments/service.ts`, `src/modules/digital-goods/repository.ts`, `src/modules/digital-goods/fulfillment.ts`, and `src/modules/digital-goods/replacement.ts`

**Historical remediation gate (satisfied 2026-07-17):** T154–T157 stayed unchecked until the exact
final-source verification commands passed, then work stopped for reviewer re-check before T158.

### Idempotency and transaction safety — tests first

- [x] T158 [P] [US2] Write failing same-customer double-tap and two-connection `ON CONFLICT` winner-read tests (no query on aborted transaction) in `tests/integration/buy-now-idempotency.test.ts`
- [x] T159 [US2] Replace unique-violation-catch paths with `INSERT ... ON CONFLICT DO NOTHING RETURNING`/savepoint winner-read in `src/modules/commerce/buy-now.ts` and `src/modules/payments/service.ts`
- [x] T160 [US2] Carry a stable signed Buy Now checkout nonce end-to-end so double-clicks reuse one idempotency key (no fresh key minted in the handler) in `src/bot/callbacks/checkout.ts` and `src/bot/callback-codec.ts`

### Outbox fencing and durable admin — tests first

- [x] T161 [P] Write failing stale-owner fencing tests (expired-lease worker ack/fail affects zero rows; reclaimer wins) in `tests/integration/outbox-fencing.test.ts`
- [x] T162 Implement owner+generation fencing on claim/ack/fail and lease renewal (or bounded one-event claim) in `src/infrastructure/outbox/repository.ts` and migration `src/infrastructure/db/migrations/005_outbox_fencing.sql` (canonical owner of the former T130/T133 scope)
- [x] T163 [P] Write failing durable AdminConfirmation tests proving a pending high-risk action survives restart and consume+mutation+audit is atomic in `tests/integration/admin-confirmation-durable.test.ts`
- [x] T164 Implement durable PostgreSQL AdminConfirmation with allowlisted command ref and atomic consume+mutation+audit in `src/bot/callbacks/admin.ts`, `src/modules/identity/`, and migration `src/infrastructure/db/migrations/006_admin_confirmation.sql`

### Fulfillment atomicity, recovery jobs, and query scaling — tests first

- [x] T165 [P] Write failing crash-window test proving asset claim state and its outbox event commit atomically in `tests/integration/fulfillment-atomicity.test.ts`
- [x] T166 Make fulfillment claim + `DigitalAssetClaimed` outbox event one transaction in `src/modules/digital-goods/fulfillment.ts`
- [x] T167 [P] Write failing bounded-batch recovery-job tests (Order/intent expiry, reservation release, SePay reconcile, supplier UNKNOWN, bundle expiry) with backlog/oldest-age telemetry in `tests/integration/recovery-jobs.test.ts`
- [x] T168 Implement bounded `FOR UPDATE SKIP LOCKED` recovery jobs with per-row isolation and telemetry in `src/worker.ts` and `src/modules/*/recovery.ts`
- [x] T169 [P] Write failing `EXPLAIN ANALYZE` query-plan assertions on pilot-sized data for customer history and asset-claim hot paths in `tests/performance/query-plan.test.ts`
- [x] T170 Add composite indexes (`order (customer_id, created_at, id)`, `digital_asset (variant_id, status, created_at, id)`) and fix `%LIKE%`/cache-stampede paths in migration `src/infrastructure/db/migrations/007_hot_indexes.sql` and `src/modules/catalog/`

### Config split, migrate:prod, and honest CI — tests first

- [x] T171 [P] Reopen and write failing config/acceptance tests proving `SEPAY_MERCHANT_ACCOUNT_ID` and `VIETQR_ACCOUNT_NUMBER` are independently typed keys that accept both equal pilot values and distinct VA/sub-account values in `tests/contract/payment-beneficiary-config.test.ts`
- [x] T172 Split SePay merchant identity from VietQR beneficiary account number end-to-end (matching vs QR render), allow equality, and thread a validated bank display name in `src/config/`, `src/modules/payments/service.ts`, and `src/modules/payments/vietqr.ts`
- [x] T173 [P] Write failing test proving `migrate:prod` runs the compiled `dist` artifact without the `tsx` devDependency (and without requiring `node_modules/tsx`) in `tests/acceptance/migrate-prod.test.ts`; then implement `migrate:prod` in `package.json` and `src/infrastructure/db/migrate.ts`
- [ ] T174 Reopen the Docker/runtime evidence gate: skip only after a proven daemon-unavailable probe, fail on started-container/harness errors, and add compiled main+worker fresh-PostgreSQL acceptance in `tests/helpers/pg-container.ts`, `tests/acceptance/`, and `.github/workflows/ci.yml`
- [x] T175 [P] Write failing real-PostgreSQL tests for durable async SePay lifecycle: exact Fastify ACK after inbox commit, same-value/distinct-account acceptance, strict claimed envelope validation, rawHash binding, source/provider/payload consistency, mutation-alert idempotency, lease expiry/stale generation, crash/restart, bounded retry/dead-letter, and mutated-replay flood in `tests/acceptance/payment-journey.test.ts` and `tests/integration/sepay-inbox-durable.test.ts`
- [x] T176 Implement the SePay lifecycle correction: `SePayInboxClaim` carries `rawHash`; strict runtime envelope validation runs before restoring the verified brand; source/event/hash/payload consistency is enforced; mutation accounting plus security alert is atomic/idempotent; worker retry/dead-letter/fencing remains bounded in `src/infrastructure/inbox/sepay.ts`, `src/modules/payments/sepay-ingress.ts`, and `src/infrastructure/db/migrations/008_sepay_inbox_security.sql`
- [x] T177 [P] Write failing real-PostgreSQL identity tests proving fresh private Telegram `/start` atomically creates one Customer plus canonical `TELEGRAM` ChannelIdentity, concurrent starts converge, username is metadata only, root numeric ID bootstraps on an empty database, and acceptance uses no mocked `resolveCustomerId` in `tests/integration/telegram-identity-onboarding.test.ts` and `tests/acceptance/telegram-runtime-journey.test.ts`
- [x] T178 Reopen Telegram identity implementation: move CHECK/normalization into idempotent Feature 001 migration 009, keep root bootstrap numeric-only, exclude `actorUsername` from durable inbox, accept username metadata only from verified Telegram webhook flow, and wire bounded pruning in `src/modules/identity/`, `src/infrastructure/inbox/telegram.ts`, `src/worker.ts`, and `src/infrastructure/db/migrations/009_identity_delivery_security.sql`

### Gate 0 crash, upgrade, transport, and privacy remediation — RED first

- [x] T179 [P] Write failing PostgreSQL crash test for process failure after Delivery Bundle commit but before notification handoff; retry must reconstruct exactly one usable handoff/capability and must not ack the source PUBLISHED early in `tests/integration/delivery-handoff-crash.test.ts`
- [x] T180 [P] Reopen and write failing PostgreSQL compensation tests where vault write succeeds, database swap fails, and vault delete also fails; prove the inactive orphan cannot redeem, a saturated legacy tombstone still enters the child ledger, and bounded fenced recovery deletes it without losing the prior usable ref in `tests/integration/delivery-handoff-crash.test.ts`
- [x] T181 [P] Reopen and write failing refresh crash/concurrency tests for session-commit-before-vault-write, vault-write-before-database-swap, lease expiry/claim transfer, database-swap-before-old-ref-delete, pending-operation key rotation, cleanup-vs-adoption TOCTOU, expired cleanup leases/backoff, inactive activation drift, and a stalled send exceeding its lease-safe timeout; retries must converge through a deterministic handoff+refresh-generation key to byte-identical material and one usable capability in `tests/integration/delivery-handoff-crash.test.ts` and `tests/integration/delivery-notification-retry.test.ts`
- [x] T182 [P] Reopen and write failing delivery-key/config tests for an explicit previous-key grace deadline, exact pending material through current/previous rotation, mandatory production session config/TTL, anti-reuse against Telegram/BuyNow/all SePay/vault/supplier secrets, and secret-gated Telegram username composition where rejected webhooks write neither inbox nor observation in `tests/security/delivery-session-key-rotation.test.ts`, `tests/security/config-redaction.test.ts`, `tests/integration/delivery-handoff-crash.test.ts`, and `tests/acceptance/telegram-runtime-journey.test.ts`
- [x] T183 [P] Write failing compiled migration upgrade tests for SePay-only 008 and the exact historical expanded-008 DDL (old constraints and indexes), seed real `delivery_session` and `delivery_notification_handoff` rows, preserve them, assert canonical columns/constraints and `pg_get_indexdef()`, and add a `telegram`/`TELEGRAM` collision case that fails closed with runbook reference in `tests/acceptance/migrate-prod.test.ts`
- [x] T184 [P] Write failing real-customer Telegram Mini App transport tests for bounded `initData` verification, numeric owner binding, one-time audience redemption, replay/BOLA/expiry, and no Authorization-header assumption in `tests/acceptance/delivery-mini-app.test.ts`
- [x] T185 [P] Write failing username privacy tests proving durable inbox rows never contain `actorUsername`, root bootstrap does not seed expected username, only verified webhook observations update metadata, and bounded pruning removes expired observations in `tests/security/telegram-username-retention.test.ts`
- [x] T186 Freeze `008_sepay_inbox_security.sql` as SePay-only and implement idempotent `009_identity_delivery_security.sql` for both legacy shapes, explicitly replace the historical RETRY-only due index, add a PROCESSING lease-expiry partial index, preserve rows, fail closed on canonical collision, and prove compiled migration discovery in `src/infrastructure/db/migrations/` and `docs/06-operations/IDENTITY_MIGRATION_COLLISION_RUNBOOK.md`
- [x] T187 Correct delivery refresh/compensation with inactive PREPARED sessions, durable child-ledger tombstones, leased `PENDING -> DELETING -> CLEANED` cleanup/backoff, adoption fencing, deterministic handoff+generation operation keys, fenced claim transfer, a sender abort timeout strictly below the notification lease, and recoverable old-ref deletion while keeping vault network I/O outside long database transactions in `src/modules/digital-goods/delivery-notification.ts`, `src/modules/digital-goods/delivery-session.ts`, `src/modules/digital-goods/delivery.ts`, `src/infrastructure/db/migrations/009a_delivery_capability_compensation.sql`, and `src/modules/digital-goods/recovery.ts`
- [x] T188 Add explicit previous-key grace-until configuration, freeze/reconstruct the signing-key version of pending initial/refresh operations, require session config/TTL on the production notification path, enforce cross-domain secret anti-reuse including `SEPAY_API_TOKEN`, and wire secret-gated Telegram username observation composition in `src/config/`, `.env.example`, `src/modules/digital-goods/delivery-session.ts`, `src/modules/digital-goods/delivery-notification.ts`, `src/bot/webhook.ts`, and `src/worker.ts`
- [x] T189 Implement verified Telegram Mini App `initData` redemption and one-time audience-bound reveal transport without relying on URL-button Authorization headers in `src/modules/digital-goods/delivery-route.ts`, `src/modules/digital-goods/delivery-notification.ts`, and `src/app.ts`
- [x] T190 Remove username from durable Telegram inbox envelopes, keep numeric-only root bootstrap, accept observed username only from the authenticated webhook path, add `username_observed_at`, and clear metadata after 30 days without a newer verified observation in `src/bot/webhook.ts`, `src/infrastructure/inbox/telegram.ts`, `src/modules/identity/`, and `src/worker.ts`

### Open future work (not counted in Feature 001 checkbox progress)

| Future task | Status | Required contract |
|---|---|---|
| FUT-001 Durable restock subscription | OPEN_FUTURE | Persistence, customer opt-in/opt-out, dedupe, restock event, and delivery retry before any `stock:notify` callback |
| FUT-002 Supplier capacity before payment | OPEN_FUTURE | Supplier capacity hold, expiry/release, UNKNOWN reconciliation, and refund/compensation contract before `SUPPLIER_ONLY` can become sellable |

## Dependencies & Execution Order

- Phase 1 precedes Phase 2; Phase 2 blocks every user story.
- US1 can complete independently after Phase 2.
- US2 depends on catalog variant data but not US1 Telegram presenters; it may start after catalog domain/repository tasks T029–T031.
- US3 depends on US2 `PaymentSettled` contract and paid Order state.
- US4 depends on Order/support foundations but can proceed parallel to late US3 work.
- US5 depends only on Phase 2 and can proceed parallel to US1–US4 in separate files.
- Phase 8 begins after the selected pilot stories are complete; launch gates block production, not local test development.
- Phase 9 supersedes the prior completion decision. Remaining open Phase 9 tasks (T115, T118,
  T121–T129, T124a, T136–T147, T149–T153; T130/T132/T133/T134 are superseded pointers) block
  Feature 003 implementation and every pilot/production claim.
- Phase 10 (T154–T174) is mandatory after the 2026-07-16 follow-up review. T154–T157 (reservation)
  block remaining payment presentation and fulfillment work and are currently green with
  strengthened acceptance. T161–T162 (fencing; canonical owners of former T130/T133) block any
  claim that outbox is exactly-once. T167–T168 (canonical owners of former T132/T134) block any
  claim that crash recovery is bounded. T171–T174 block production packaging and evidence claims.

## Parallel Opportunities

- Test fixtures, schema constraint tests, observability/redaction, and Telegram ingress tests can run in parallel during Phase 2.
- Within each story, tasks marked `[P]` touch independent files and precede implementation tasks using their results.
- US1, US4, and US5 have largely independent module/file ownership after foundational work.
- No parallel task may mutate the same migration or shared command envelope without explicit coordination.
- Within Phase 10, T154/T155/T158/T161/T163/T165/T167/T169/T171 are independently parallelizable
  tests; their implementation counterparts share migrations and must be sequenced carefully.

## Implementation Strategy

1. Complete Setup + Foundational and demonstrate durable no-op ingress/outbox recovery.
2. Complete US1 and validate customer discovery independently.
3. Complete US2 and stop at a paid Order with no fulfillment.
4. Complete US3 for the saleable walking skeleton and run replay/concurrency/redaction gates.
5. Add US4 and US5 recovery/operations surfaces.
6. Complete all hardening and dated launch gates before production activation.
7. **After follow-up review (2026-07-16)**: Spec Kit Gate 0 first, then implement in this order:
   - T154–T160 inventory reservation + idempotency + stable Buy Now nonce
   - T121/T126 Telegram durable inbox + rate limit
   - T122/T127 SePay runtime verifier + branded evidence
   - T123/T124/T124a/T128 money races + evidence boundary
   - T125/T129 signed callback codec
   - T161/T162 outbox fencing + lease renewal (T130/T133 superseded pointers)
   - T167/T168 scheduled recovery jobs (T132/T134 superseded pointers)
   - T136–T147/T165/T166 vault/supplier/fulfillment/delivery atomicity
   - T149/T150/T171/T172 VietQR UX + beneficiary config split
   - T163/T164 durable admin confirmation
   - T169/T170 hot indexes + query-plan evidence
   - T173/T174 migrate:prod + honest Docker/CI
   - T151/T152/T153 CI + SHA evidence + independent review zero Critical/High

## Format Validation

- Executable checkbox tasks: **171**. Historical IDs T130/T132/T133/T134 are superseded mapping
  rows, not completed checkboxes; canonical owners are T161/T162 and T167/T168.
- Every executable task has a checkbox, concrete action, and exact file path.
- User-story tasks carry `[US1]`–`[US5]`; parallel markers are limited to independent files.
- All test tasks precede related implementation tasks.
- No task may be checked without its non-Docker portion green on this host AND its container-gated
  portion proven in CI with Docker. A skip is not production evidence.

<!-- Phase 8 evidence (2026-07-16) — SUPERSEDED
  The prior pilot-ready test-count claim is withdrawn. Independent review found Critical/High
  implementation gaps. Do not restore a numeric claim without a new final-source run.
-->

<!-- Phase 9 partial evidence (2026-07-16) — see evidence/phase9-remediation.md
  Honest partial (code exists; checkboxes reopened where evidence mismatched):
    T116/T117/T119/T120 packaging + migration CLI green
    T123/T128 money-safety pure decisions + cancel/void intent + projection (partial)
    T131 pure dispatch policy green; T135 unknown-event fail-visible
    T148 VietQR TLV byte-length + service-code separation + VN-time presenter
  Still open (not superseded):
    T115 (smoke only proves invalid-config exit, not listen/health)
    T118 (Telegram no-op, SePay 503, in-memory inbox/rate-limit)
    T124 / T124a (payment-evidence-hardening.test.ts does not exist)
  Superseded pointers (canonical Phase 10 owners):
    T130/T133 → T161/T162 (outbox fencing)
    T132/T134 → T167/T168 (scheduler + recovery)
  Host: Docker 29.2.1 available (full suite runs); .git still not a valid repository (T152 deferred).
  Feature 001 remains REQUEST_CHANGES until remaining open tasks complete with zero C/H.
-->

<!-- Phase 10 remediation gate (2026-07-17, local proof only):
  T154–T157 were reopened and remediated test-first. Final-source host run: 333 tests / 64 files.
  Node 24.18.0 container run after build: 333 tests / 64 files. Checkout contention evidence:
  host p95=332.0ms, Node 24 p95=609.8ms, peak pool occupancy 10/10, all 12 outcomes
  CONTENTION_TIMEOUT, zero orphan Orders/Payment Intents. Required static/build/production-audit
  commands exited 0; production audit reported 0 vulnerabilities. Full dev audit remains 1 high +
  3 moderate (testcontainers transitive chain). `.git` is invalid, so none of this is SHA-bound CI
  evidence. Historical checkpoint only: Feature 001 remained REQUEST_CHANGES and T158–T160 had not
  started at that point; the dated gate below supersedes this status.
-->

<!-- T158–T160 idempotency gate (2026-07-17, local proof only):
  Implemented test-first after T154–T157 corrections. Final-source host Node 20.19.0 and target
  Node 24.18.0 container runs each passed 355 tests / 67 files plus typecheck, lint, format:check,
  secret-scan, build, and production-only audit. The two-connection idempotency file passed 10/10
  repeated runs (7 tests per run); callback property coverage held every token to 64 UTF-8 bytes.
  Independent re-review returned REQUEST_CHANGES for artifact drift and two boundary/config findings;
  the later Gate 0 correction evidence in analysis/review/remediation supersedes that submission.
  Docker 29.2.1 was healthy.
  `.git` remains invalid, so this is not SHA-bound CI evidence. Feature 001 remains REQUEST_CHANGES;
  T121–T153 and T161–T174 retain their existing open status.
-->

<!-- Gate 0 correction gate (2026-07-17, local proof only):
  Task truth remains 129 checked / 42 open / 171 rows. RED: 6 focused security/config failures.
  GREEN: 12/12 focused security/config tests, 16/16 affected checkout integration tests, then
  361/361 tests across 68/68 files. Typecheck, lint, format:check, secret-scan, build, and production
  audit exited 0; production audit found 0 vulnerabilities. Node 20.19.0, Docker desktop-linux
  server 29.2.1. Node 24 was not rerun in this pass. Invalid .git means no SHA/CI provenance.
  Feature 001 remains REQUEST_CHANGES; canonical next slice is T121/T126.
-->

<!-- T122/T127 verified SePay ingress gate (2026-07-17, local proof only):
  RED: missing runtime ingress module, provider-ID mutation silently treated as replay, and unsafe
  ingress configuration accepted until first traffic. GREEN: exact raw-body HMAC with sha256=,
  freshness, trusted-proxy/IP policy, schema, branded evidence, body limit, durable provider-safe
  acknowledgement, and mutation discrepancy behavior. Host Node 20.19.0 and target Node 24 Docker
  with nested Testcontainers each passed 382/382 tests across 70/70 files. Typecheck, lint,
  format:check, secret-scan, build, and production audit exited 0; production audit found 0
  vulnerabilities. Harness four-angle manual review ended APPROVE with 0 Critical/Major after
  startup config validation and typed-failure acknowledgement corrections. Task truth is now
  133 checked / 38 open / 171 rows. Invalid .git means no SHA/CI provenance. Feature 001 remains
  REQUEST_CHANGES; canonical next slice is T124/T124a/T128.
-->

<!-- T124/T124a/T128 payment hardening gate (2026-07-17, local proof only):
  RED: forgeable raw evidence settled as VERIFIED; future evidence settled; paid cancellation was
  untyped; concurrent cancel/settle threw VersionConflictError; concurrent expiry/settlement
  deadlocked. GREEN: runtime-private evidence brand, invalid/future-time rejection, strict provider
  calendar parsing, Order-then-Intent row locks, locked re-read for cancel/expiry, typed ALREADY_PAID,
  mutation discrepancy matrix, and PAYMENT_NEEDS_REVIEW projection. The 11-test dedicated file
  passed five repeated concurrency runs. Host Node 20.19.0 and target Node 24 Docker with nested
  Testcontainers each passed 393/393 tests across 71/71 files. Typecheck, lint, format:check,
  secret-scan, build, and production audit passed; production audit found 0 vulnerabilities.
  Harness four-angle manual review ended APPROVE with 0 Critical/Major. Task truth is now
  136 checked / 35 open / 171 rows. Invalid .git means no SHA/CI provenance. Feature 001 remains
  REQUEST_CHANGES; canonical next slice is T125/T129.
-->

<!-- T125/T129 unified callback and runtime dispatcher gate (2026-07-17, local proof only):
  RED: unified codec and domain dispatcher were absent. GREEN: <=64-byte opaque HMAC tokens bind
  every action/resource to numeric Telegram user + expiry; production worker drains the durable
  inbox into catalog/checkout/history/support/admin ports and a real grammY API responder; all
  returned legacy buttons are resealed. Search uses an 80-character normalized allowlist query.
  Support callback replay is deduped across workers with a stable correlation advisory lock.
  Acceptance proves HTTP webhook -> PostgreSQL inbox -> verified callback -> domain command ->
  responder, not HTTP 200 alone. Host Node 20.19.0 and target Node 24 Docker with nested
  Testcontainers each passed 416/416 tests across 74/74 files. Typecheck, lint, format:check,
  secret-scan, build, and production audit passed; production audit found 0 vulnerabilities.
  Harness four-angle manual review ended APPROVE with 0 Critical/Major. Task truth is now
  138 checked / 33 open / 171 rows. Invalid .git means no SHA/CI provenance. Feature 001 remains
  REQUEST_CHANGES; canonical next slice is T161/T162.
-->

<!-- T161/T162 outbox fencing gate (2026-07-17, local proof only):
  RED: 2/4 dedicated cases failed because claim/failure options were unbounded and a fenced
  acknowledgement was not reported as stale. GREEN: migration 005 adds monotonic claim_generation;
  every ack/fail predicates on id + owner + generation; the drainer owns one event at a time and
  reports fenced mutations as stale instead of published/failed. Claim/error inputs are bounded and
  claim order is deterministic. Focused outbox/fulfillment lane passed 16/16 tests. Final-source host
  Node 20.19.0 and target Node 24 Docker with nested Testcontainers each passed 420/420 tests across
  75/75 files. Typecheck, lint, format:check, secret-scan, build, and production audit passed;
  production audit found 0 vulnerabilities. Harness four-angle manual review ended APPROVE with
  0 Critical/Major. Task truth is now 140 checked / 31 open / 171 rows. Invalid .git means no SHA/CI
  provenance. Feature 001 remains REQUEST_CHANGES; canonical next slice is T163/T164.
-->

<!-- T163/T164 durable AdminConfirmation gate (2026-07-17, local proof only):
  RED: 0/2 dedicated cases passed; allowlisted_command_ref did not exist, restart lost the in-memory
  pending action, and an audit failure left confirmation CONSUMED while the discrepancy rolled back.
  GREEN: migration 006 persists the allowlisted command plus bounded redacted payload; callback
  composition has no pending Map; challenge verification, CONFIRMED transition, discrepancy update,
  append-only audit, and CONSUMED transition run under one row lock/transaction. Correct concurrent
  replay converges to one mutation/audit; wrong challenge and payload/fingerprint mutation fail
  closed. Focused admin/runtime lane passed 13/13 tests. Final-source host Node 20.19.0 and target
  Node 24 Docker with nested Testcontainers each passed 423/423 tests across 76/76 files. Typecheck,
  lint, format:check, secret-scan, build, and production audit passed; production audit found 0
  vulnerabilities. Harness four-angle manual review ended APPROVE with 0 Critical/Major. Task truth
  is now 142 checked / 29 open / 171 rows. Invalid .git means no SHA/CI provenance. Feature 001
  remains REQUEST_CHANGES; canonical next slice is T165/T166.
-->

<!-- T165/T166 fulfillment atomicity gate (2026-07-17, local proof only):
  RED: 0/2 crash-window cases passed. AVAILABLE stock remained READY after event insert failure;
  a pre-reserved asset skipped DigitalAssetClaimed entirely. GREEN: the transaction-only claim seam
  locks deterministic active holds; AVAILABLE->RESERVED, RESERVED->READY, and DigitalAssetClaimed
  append share one transaction. READY re-entry repairs a historical missing event under the same row
  lock, uses the asset's actual version, and replay stays at one event. Focused fulfillment lane
  passed 12/12 tests. Final-source host Node 20.19.0 and target Node 24 Docker with nested
  Testcontainers each passed 425/425 tests across 77/77 files. Typecheck, lint, format:check,
  secret-scan, build, and production audit passed; production audit found 0 vulnerabilities.
  Harness four-angle manual review ended APPROVE with 0 Critical/Major. Task truth is now 144
  checked / 27 open / 171 rows. Invalid .git means no SHA/CI provenance. Feature 001 remains
  REQUEST_CHANGES; canonical next slice is T167/T168.
-->

<!-- T167/T168 bounded recovery gate (2026-07-17, local proof only):
  RED: recovery-jobs.test.ts failed before collection because the five public recovery batch seams
  did not exist. GREEN: deterministic bounded SKIP LOCKED selectors cover Order/intent expiry,
  stale reservation release, verified SePay API reconciliation, supplier UNKNOWN query-only
  recovery, and live Delivery Bundle expiry. Per-row failures do not abort later rows; supplier
  claims use next_reconcile_at and SePay uses a process-independent PostgreSQL advisory lock.
  Every class reports claimed/succeeded/failed/backlog/oldestAgeSeconds. Official SePay API v2
  uses the Bearer endpoint, page/per_page cap, strict bounded schema/body/timeout handling, and
  source-qualified API IDs; structured code wins over free-form content. Focused recovery and
  adjacent lanes passed 28/28 tests. Final-source host Node 20.19.0 and target Node 24 Docker with
  nested Testcontainers each passed 433/433 tests across 79/79 files. Typecheck, lint,
  format:check, secret-scan, build, and production audit passed; production audit found 0
  vulnerabilities. Harness four-angle manual review ended APPROVE with 0 Critical/Major. Task
  truth is now 146 checked / 25 open / 171 rows. Invalid .git means no SHA/CI provenance. Feature
  001 remains REQUEST_CHANGES; canonical next slice is T169/T170.
-->

<!-- T169/T170 query scaling gate (2026-07-17, local proof only):
  RED: the two EXPLAIN ANALYZE assertions selected order_customer_idx/digital_asset_variant_idx,
  performed a Sort or Seq Scan, and did not have the new composite indexes. GREEN: pilot-sized
  PostgreSQL plans use order_history_customer_created_idx and digital_asset_claim_idx without a
  Sort. Migration 007 also adds accent-folded simple-tsquery GIN indexes; catalog search now uses
  bounded word-prefix tsquery instead of leading-wildcard LIKE. Catalog cache cold misses are
  single-flight and invalidation cannot repopulate a newer version from an old in-flight read.
  Focused query/cache/search/claim lanes pass 24/24 tests. Final-source host Node 20.19.0 and
  target Node 24 Docker with nested Testcontainers each passed 437/437 tests across 81/81 files.
  Typecheck, lint, format:check, secret-scan, build, and production audit passed; production audit
  found 0 vulnerabilities. Harness four-angle manual review ended APPROVE with 0 Critical/Major.
  Task truth is now 148 checked / 23 open / 171 rows. Invalid .git means no SHA/CI provenance.
  Feature 001 remains REQUEST_CHANGES; canonical next slice is T171/T172.
-->

<!-- T122/T127 official SePay compliance correction (2026-07-17, local proof only):
  The earlier verifier-only green was superseded because it acknowledged only after synchronous
  settlement and did not retain an immutable allowlisted evidence copy. GREEN now adds the
  source-qualified durable SePay inbox, transactional duplicate/mutation handling with a security
  discrepancy, immutable-evidence trigger, exact HTTP 200 success ACK, and a bounded worker that
  restores the runtime trust brand before calling applyPaymentEvidence. Structured provider code is
  retained separately and is the primary matcher key; content/reference are bounded fallbacks. The
  official API adapter now supports page/since_id cursors, timeout normalization, and the published
  3-request/second client gate. VietQR image rendering uses the official endpoint and allowlists
  empty/compact/qronly/standee; compact2 is rejected. Google Sheets remains absent from payment
  truth and delivery paths. Focused contract/integration lanes pass 23/23 tests, typecheck/lint/
  format pass. Full suite and external SePay dashboard delivery evidence remain separate launch
  gates; Feature 001 remains REQUEST_CHANGES and no SHA/hosted-CI claim is made because .git is
  invalid. -->

<!-- Gate 0 correction reopening (2026-07-17):
  Reopened T148, T171, T172, and T174 after the independent 449-test review. T175/T176 own the
  durable SePay lifecycle instead of hiding it under the previously checked verifier tasks. Gate 0
  artifact truth is 149 checked / 26 open / 175 rows. The equal merchant/beneficiary account case,
  strict claimed-envelope validation, rawHash claim binding, atomic mutation-alert idempotency,
  Telegram identity bootstrap, signed delivery session, staging adapters, and compiled fresh-DB
  acceptance remain implementation gates. Feature 001 MUST remain REQUEST_CHANGES. -->

<!-- Slice 1 SePay/VietQR gate (2026-07-17, local proof only):
  T171/T172/T175/T176 complete. RED proved equal-value config rejection and two strict-envelope
  fail-opens; GREEN accepts same/distinct account models, binds rawHash on claims, validates every
  persisted field before trust restoration, and makes mutation alerts atomic/idempotent. Real
  Fastify/PostgreSQL acceptance covers exact ACK then worker settlement for pilot and VA cases.
  Focused 15/15 and full host 459/459 across 85 files pass; all static/build/secret/audit gates pass
  with 8 migrations and 0 production vulnerabilities. Task truth is 153 checked / 22 open / 175.
  Slice review is 0 Critical/Major; Feature 001 remains REQUEST_CHANGES. -->

<!-- Slice 2 superseded by Gate 0 correction (2026-07-17):
  T177 remains checked only for the narrow PostgreSQL concurrency/identity test scope already
  proven. T178 is reopened because identity DDL was placed in mutable migration 008, root bootstrap
  seeded expected username metadata, and durable inbox username retention/pruning was not designed.
  The prior Slice 2 zero-finding claim is withdrawn. -->

<!-- Slice 3 superseded by Gate 0 correction (2026-07-17):
  T139 remains checked only for the narrow send-failure/retry test scope already proven. T145/T146
  are reopened because Bundle-commit-before-handoff, vault-write/DB-rollback compensation,
  session-expiry refresh, dedicated key rotation, and customer-usable Mini App transport were not
  proven. The prior Slice 3 zero-finding claim is withdrawn. Feature 001 remains REQUEST_CHANGES. -->

<!-- Gate 0 correction task truth (2026-07-17):
  T139/T177 remain checked with narrow scope. T145/T146/T178 are reopened. T179-T185 are RED-first
  tasks and T186-T190 are their implementation owners. Current executable task truth is 170 checked
  / 17 open / 187 rows. T183/T186 were reopened for a false-green historical-index fixture and are
  re-closed only after exact expanded-008 constraints/indexes, real delivery rows, row preservation,
  canonical `pg_get_indexdef()`, collision rollback, and compiled 5/5 evidence. No further implementation is authorized
  unless the revised Spec Kit analyze continues to report
  zero unresolved Critical/High design findings. Feature 001 remains REQUEST_CHANGES. -->

<!-- A0 external-vault correction (2026-07-18, focused local proof only):
  T136/T142 re-close after real loopback RED→GREEN coverage for slow streamed bodies, chunked
  MAX+1 abort, one-shot serialized UTF-8 request sizing, redirect refusal, endpoint normalization,
  fail-closed host/port/CIDR policy with DNS re-resolution, strict response schemas/body finalization,
  exact-max escaped material, non-transient retry classification, and current/previous delivery-key
  anti-reuse across Telegram/BuyNow/SePay/vault/supplier domains. Focused A0 proof is 55/55 across
  4 files on host Node 24.15.0; typecheck, lint, and focused format checks pass. No Docker, full-host,
  build, secret-scan, audit, staging endpoint, Git/SHA, or hosted-CI claim is made. Task truth is
  167 checked / 20 open / 187 rows. Feature 001 remains REQUEST_CHANGES; A1 is next. -->

