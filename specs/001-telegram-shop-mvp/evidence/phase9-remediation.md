# Phase 9 Remediation Evidence (T115–T153) + Phase 10 Gate 0

**Date**: 2026-07-16
**Status**: IN PROGRESS. Follow-up multi-agent review reopened Feature 001 at
`REQUEST_CHANGES` (`remediation-review.md`). Several Phase 9 checkmarks were
overclaimed and have been reopened. Phase 10 (`T154`–`T174`) was added for
final-stock reservation, outbox fencing, durable admin, and related gaps.

This file records exactly what has been changed and what was verified **on this
host**. Docker daemon **is available** (29.2.1) as of the evening of 2026-07-16;
full Testcontainers suites run against real PostgreSQL. `.git` is still not a
valid repository, so commit-SHA / CI-run provenance cannot be bound here and
remains deferred to CI (T152).

## Host verification limits (must not be overstated)

- `docker info` → available (Docker 29.2.1). Full Testcontainers suites run here.
- `.git` → not a repository. No commit SHA / CI run can bind this evidence.
- Verifiable locally: typecheck, lint, format, secret-scan, build, pure/unit
  tests, Fastify `app.inject()` composition tests, AND full integration suites.

Static gates at last reservation re-fix: typecheck/lint/format/build/secret-scan
PASS; production audit (`--omit=dev`) 0 vulnerabilities; full-dep audit 1 high
(`undici` via `testcontainers@10`, dev-only, tracked under T151).

## Completed and locally verified

### T115–T120 Runtime, packaging, migrations
- `src/app.ts` — real Fastify composition: `/health` (no DB), `/ready` (DB ping,
  503 fail-closed), Telegram webhook (secret-gated), SePay webhook with **raw
  body preserved** for HMAC, delivery route, graceful `close`.
- `src/main.ts` — builds the app, `listen`, redacted startup log, SIGTERM/SIGINT
  graceful shutdown (http close + db close).
- Build path fix: `tsconfig.build.json` now `rootDir: "src"` so `npm start`'s
  `dist/main.js` resolves (was emitting `dist/src/main.js` → MODULE_NOT_FOUND).
- `scripts/copy-migrations.mjs` — packages `.sql` migrations into `dist` (tsc
  drops non-TS files; production `runMigrations` would otherwise find none).
- `src/infrastructure/db/migrate.ts` — real CLI entrypoint; advisory lock now on
  a **pinned `pg.Client` connection** (lock+unlock on the same session), not the
  pool. `npm run migrate` runs and reports applied/already counts.
- Tests: `tests/acceptance/runtime-entrypoints.test.ts` (built entrypoints
  resolve + fail closed, **green**), `tests/integration/app-composition.test.ts`
  (**green**, 5 cases), `tests/integration/migration-cli.test.ts` (structural CLI
  test green; concurrent-lock test Docker-gated, skips here).
- CI: `.github/workflows/ci.yml` adds acceptance lane, built-entrypoint smoke,
  and `npm run migrate` smoke.

### T123 / T124 / T128 Money-safety (payment)
- `src/modules/payments/projection.ts` (pure) — `projectSettlement` returns
  SETTLE_AND_PAY / SETTLE_ALREADY_PAID / **MONEY_FOR_DEAD_ORDER**;
  `projectDiscrepancyOrderStatus` freezes a pending order under review.
- `applyPaymentEvidence` — emits `OrderPaid` **only** on the payable projection;
  money for a cancelled/expired order records a discrepancy (never OrderPaid).
  A live-intent discrepancy transitions the Order to `PAYMENT_NEEDS_REVIEW`.
- `presentPaymentForOrder` — refuses to mint a QR unless the order is still
  `PENDING_PAYMENT` (refresh cannot mint a second QR under review).
- `cancelUnpaidOrder` / `expireOverdueOrders` — atomically void live intents
  (`voidLiveIntentsForOrder` → FAILED) so a later transfer cannot settle.
- `decideMatch` — late-payment judged by **`evidence.transactedAt`** with a
  bounded skew (`LATE_PAYMENT_SKEW_MS`), not processing wall-clock.
- Tests: `tests/property/payment-projection.test.ts` (**green**, 8 cases);
  `tests/integration/payment-cancel-race.test.ts` and updated
  `payment-discrepancy.test.ts` (Docker-gated; assert no OrderPaid after cancel,
  transfer-time late classification, order frozen under review).

### T130 / T133 / T134 / T135 Outbox & worker recovery
- Migration `002_review_remediation.sql` — durable claim lease columns
  (`claimed_by`, `claimed_at`, `claim_expires_at`) + claimable index.
- `claimDueOutboxBatch` — atomic `UPDATE … FROM (SELECT … FOR UPDATE SKIP
  LOCKED) RETURNING` stamping a lease; concurrent claimers never double-own; an
  expired lease is reclaimable (crash recovery). Replaces the autocommit
  row-lock that released the instant the SELECT returned.
- `src/infrastructure/outbox/dispatch-policy.ts` (pure) — typed decisions:
  PUBLISHED / RETRY / TERMINAL_REVIEW / UNKNOWN_EVENT; `classifyFulfillmentOutcome`
  makes OUT_OF_STOCK/NEEDS_REVIEW **RETRY** (not silent ack).
- `drainOutboxOnce` — rejects unknown event types **visibly** (never ack), maps
  decisions to publish/defer/dead-letter, catches handler throws as retryable.
- `src/worker.ts` — **single-flight** polling (no overlapping setInterval
  cycles), stable owner id for the lease, bounded in-flight drain on shutdown
  before closing the pool.
- Tests: `tests/property/outbox-dispatch-policy.test.ts` (**green**, 7 cases);
  updated `outbox-recovery.test.ts` (lease semantics + unknown-event fail);
  `tests/integration/outbox-concurrency.test.ts` (Docker-gated: two-worker
  partition + exactly-once dispatch).

### T140 / T146 / T147 Delivery crash-safety & completion
Historical baseline only; T146 is reopened by the 2026-07-17 Gate 0 correction for dedicated
delivery keys, Mini App transport, expiry refresh, and handoff recovery. This section is not a
current approval claim.
- `revealDeliveryBundle` — **two-phase**: read+VIEWED, reveal vault BEFORE
  consuming, then CONSUMED+DELIVERED under a guard. A vault failure leaves the
  bundle revealable (no burned link). Order → **COMPLETED** on first successful
  reveal (was stranded at PROCESSING).
- Migration 002 widens the live credential fingerprint unique index to include
  `AVAILABLE` (duplicate sellable stock was previously allowed).
- `fulfillment-journey.test.ts` updated to require COMPLETED (Docker-gated).

### T148 / T149 (partial) VietQR correctness
- TLV length is now UTF-8 **byte** length (Vietnamese accented names no longer
  produce an unscannable QR).
- NAPAS service code is QRIBFTTA/QRIBFTTC only; the image render template
  `compact2` is deliberately ignored and never enters the EMVCo payload.
- `parseEmvTlv` helper for golden-vector round-trips.
- Presenter formats expiry in **Asia/Ho_Chi_Minh (GMT+7)** and shows bank name
  when provided.
- Tests: `tests/contract/vietqr-official-vector.test.ts` (**green**, 5 cases),
  `tests/contract/payment-photo-presenter.test.ts` (**green**, 3 cases).
- NOT yet: actual QR image generation / Telegram `sendPhoto` (T149 remainder +
  T150).

## Spec Kit Gate 0 (2026-07-16 follow-up) — DONE for artifacts

Artifacts updated before any further implementation:

| Artifact | Change |
|---|---|
| `constitution.md` | No change — Principle IV already requires Inventory Reservation |
| `spec.md` | FR-006a–d, FR-025–027; tightened FR-008/009/011/013/014/023, SR-002/003, SC-006; US2 scenarios; edge cases |
| `plan.md` | Buy Now phase requires pre-payment reservation; Complexity Tracking table; runtime evidence contract |
| `data-model.md` | Inventory Reservation rules; PaymentIntent merchant vs VietQR account split; Outbox fencing generation; durable AdminConfirmation; two-phase DeliveryBundle |
| `contracts/application-commands.md` | BuyNow reservation contract; branded evidence; CancelUnpaidOrder; claim+outbox atomicity |
| `checklists/requirements.md` | CHK101–CHK113 |
| `checklists/security.md` | CHK021–CHK025 |
| `tasks.md` | Reopened T115/T118/T124/T128/T130/T133/T134; added T124a; Phase 10 T154–T174 |
| `analysis.md` | Superseded post-impl claim; Gate 0 re-analysis with 0 design Critical/High |

Design/spec Critical/High: **0**. Implementation Critical/High: **open**, tracked by Phase 9 reopened + Phase 10.

## Reopened checkmarks (evidence mismatch)

| Task | Why reopened |
|---|---|
| T115 | Smoke only proves invalid-config exit, not listen/health/ready |
| T118 | Telegram no-op, SePay permanent 503, in-memory inbox/rate-limit |
| T124 | `payment-evidence-hardening.test.ts` does not exist |
| T128 | ALREADY_PAID typed result + invalid Date rejection incomplete |
| T130/T133 | Superseded pointers → canonical owners T161/T162 (outbox fencing) |
| T132/T134 | Superseded pointers → canonical owners T167/T168 (scheduler/recovery) |

## Phase 10 P0 reservation (T154–T157) — REOPENED then RE-FIXED (2026-07-16 evening)

The first pass of T154–T157 was reported green but a second review pass found four defects that made
the "green" partly false. All four are now fixed with dedicated tests. Docker 29.2.1 is available;
these suites run against real PostgreSQL Testcontainers.

### Defects found on re-review and how they were fixed
1. **TOCTOU between revalidation and reservation** — `loadLiveVariant` + `revalidate` ran OUTSIDE the
   Buy Now transaction, so an admin price change / pause / policy flip in the window could produce a
   mispriced or unreserved-but-chargeable Order. **Fix:** `loadLiveVariant(trx, id, lock=true)` uses
   `for update of v` and both the load and revalidation now run INSIDE the transaction that inserts
   the Order and reserves the asset. Proof: `tests/integration/buy-now-toctou.test.ts` (stale price →
   `PRICE_CHANGED` no Order; paused → `OUT_OF_STOCK` no Order; no asset → `OUT_OF_STOCK` no Order).
2. **T154 was false-green for Payment Intent/QR** — the old test asserted `intents <= 1` without ever
   calling `presentPaymentForOrder`, so it passed at zero. **Fix:** the concurrency test now presents
   payment for the winner and asserts exactly ONE Payment Intent with a real EMVCo payload, and zero
   loser Orders/intents. `tests/integration/reservation-concurrency.test.ts`.
3. **Payment guard accepted invalid reservations** — `orderHasActiveReservation` matched
   RESERVED/READY/DELIVERED by `reserved_order_id` only. **Fix:** it now requires
   `reserved_order_id = order` AND `variant_id = order.variant` AND `status = 'RESERVED'` AND
   `reserved_until > now`; `presentPaymentForOrder` additionally rejects an order past `expires_at`.
   Proof: `tests/integration/reservation-invariant.test.ts` (expired reservation / DELIVERED /
   wrong-variant / expired-order all refuse).
4. **SKIP LOCKED could report false OOS** — if the last unit was locked by a transaction that then
   rolled back, a single attempt returned null. **Fix:** bounded recheck distinguishes true OOS
   (zero AVAILABLE rows visible) from contention (rows exist but are locked) and retries.
   Proof: `tests/integration/reservation-recheck.test.ts` (lock-holder rollback → winner reserves).

### Also landed
- **DB invariant** `003_reservation_invariant.sql`: unique partial index on `reserved_order_id` over
  `RESERVED|READY|DELIVERED` → at most one active reservation per Order (second reservation → 23505).
- **T155 re-scoped** to direct `cancelUnpaidOrder` / `expireOverdueOrders` release only; the bounded
  SKIP-LOCKED crash-recovery job is explicitly T167/T168, not claimed here.
- **LOCAL_THEN_SUPPLIER settled** (data-model stock-policy table): MVP treats it as `LOCAL_ONLY`
  pre-payment (no supplier reservation before payment); supplier fallback is post-payment/deferred.
- **Loser presenter** `presentLastUnitLoser`: truthful copy + three actions (notify-when-restocked,
  view alternatives, back to catalog). Durable restock SUBSCRIPTION is a separate later task.

### Tests green under Docker (this slice)
- `reservation-concurrency.test.ts` (2), `reservation-release.test.ts` (2),
  `buy-now-toctou.test.ts` (3), `reservation-recheck.test.ts` (1),
  `reservation-invariant.test.ts` (5), `last-unit-loser-presenter.test.ts` (3).
- Regression re-run: `buy-now`, `payment-journey`, `checkout-callbacks`, `payment-reconciliation`,
  `fulfillment-journey`, `migration-cli` historically passed in that partial run; this is not the
  2026-07-17 final-source gate.

## Historical not-yet-done snapshot before T158 (superseded below)

- T158–T160: `ON CONFLICT DO NOTHING RETURNING` winner-read + stable signed Buy Now nonce
- T121/T122/T125/T126/T127/T129: durable inbox, rate-limit, SePay verifier, callback codec
- T123/T124/T124a/T128: money races + evidence boundary completion
- T161/T162: outbox owner+generation fencing (now planned as migration `005_outbox_fencing.sql`)
- T167/T168: scheduled bounded recovery jobs
- T136–T147/T165/T166: vault/supplier/fulfillment/delivery
- T149/T150/T171/T172: QR image, Telegram media, beneficiary config split
- T163/T164: durable admin confirmation
- T169/T170: hot indexes + EXPLAIN ANALYZE evidence
- T173/T174: migrate:prod (test-first) + honest Docker skip/CI
- T151/T152/T153: CI lanes + SHA evidence + independent review zero Critical/High

## T154–T157 reviewer remediation gate (2026-07-17)

- Final-source host suite: 333 tests passed across 64 files.
- Node 24.18.0 container suite, after `npm run build`: 333 tests passed across 64 files.
- Checkout contention load: host p95 332.0ms; Node 24 p95 609.8ms; peak pool occupancy 10/10;
  12/12 typed `CONTENTION_TIMEOUT`; zero orphan Orders/Payment Intents.
- `npm run typecheck`, `npm run lint`, `npm run format:check`, `npm run secret-scan`,
  `npm run build`, and `npm audit --omit=dev` exited 0 on final source.
- Production audit output: `found 0 vulnerabilities`. Full dev/test audit remains 1 high + 3
  moderate through `testcontainers -> dockerode/undici/uuid`.
- `.git` is invalid. The results above are local Docker proof, not commit-SHA or CI provenance.
- At this historical checkpoint Feature 001 remained `REQUEST_CHANGES`; T158–T160 had not started.
  The dated T158–T160 and Gate 0 sections below supersede that status.

No task is checked off in `tasks.md` unless its non-Docker portion is green here;
container-gated assertions await a CI run with Docker. A failed container start is
not a pass, and a skip is not production evidence.

## T158–T160 idempotency and signed-callback gate (2026-07-17 resumed run)

This section supersedes only the earlier “not yet done” status for T158–T160. Older T154–T157
evidence above is preserved as the historical checkpoint.

### RED evidence

- Reviewer correction RED: focused replacement/stock-policy/presenter run produced 11 failing tests
  across 2 failing files. Missing typed stock-policy exports caused 9 failures; `COMPROMISED` and
  `REVOKED` delivered-history cases both returned no replacement asset.
- T158 RED: both new suites failed to import because `src/bot/callback-codec.ts` did not exist.
- First Node 24 full run after the initial implementation found a real timing defect: 1 failed / 352
  passed. Rapid payment presentation could hit `payment_intent_active_content_uq` before the
  active-order conflict arbiter. The final implementation uses non-aborting `ON CONFLICT DO NOTHING`
  and accepts only an exact same-Order live winner; an unrelated transfer-content collision is an
  explicit regression test and fails closed.

### GREEN evidence on final source

- Runtime restored through Docker Desktop normal startup. `docker info` and a real Testcontainers
  PostgreSQL probe passed; Docker server `29.2.1`, context `desktop-linux`.
- Host runtime: Node `20.19.0`, npm `10.8.2`.
- Target runtime: `node:24-bookworm-slim`, Node `24.18.0`, source copied read-only while excluding
  host `node_modules`, `dist`, and invalid `.git`.
- Host and Node 24 each passed: `npm run typecheck`, `npm run lint`, `npm run format:check`,
  `npm run secret-scan`, `npm run build`, `npm test -- --reporter=dot`, and
  `npm audit --omit=dev`.
- Final complete suite on both runtimes: **355 tests passed across 67 files**.
- Final two-connection idempotency/concurrency file: **10/10 repeated runs green**, 7 tests per run,
  with one Order, one active reservation, one live Payment Intent, one `BUY_NOW` transition, the
  same Order/transfer presentation for the loser, no `25P02`, and unrelated uniqueness conflicts
  rejected rather than swallowed.
- Signed callback property coverage: 200 bounded price/nonce cases; every Telegram callback was
  exactly **64 UTF-8 bytes**. Tampered, expired, wrong-action, wrong-user, malformed, and unresolvable
  identity cases created zero Order/reservation/Payment Intent/QR state.
- The submitted Harness/code re-review initially claimed APPROVE, but the independent follow-up
  returned `REQUEST_CHANGES` for artifact drift, an unsigned bot seam, callback-key production
  hardening, and migration-order collisions. Full grammY reply/ack composition remains canonical
  open task T129 and was not pulled into this slice.
- Production-only audit: zero vulnerabilities. Full dev/test audit remains **1 high + 3 moderate**
  through `testcontainers -> dockerode/undici/uuid`; the breaking Testcontainers 12 upgrade was not
  forced.

### Provenance and remaining status

`.git` is still invalid, so these are local host/container results, not commit-SHA-bound CI proof.
Raw task status after checking T158–T160 is **129 checked / 42 open / 171 task rows**. Feature 001
remains `REQUEST_CHANGES`; T121–T153 and T161–T174 remain open. The master execution order
supersedes numeric ordering: the next canonical slice is T121/T126, not T161.

## Gate 0 correction evidence after T158–T160 review (2026-07-17)

- RED before correction: 6/12 focused security/config assertions failed as expected: unsigned
  `CheckoutCallbacks.buyNow`, documented callback placeholder, three cross-domain key-reuse cases,
  and callback TTL above 24 hours.
- GREEN after correction: 12/12 focused security/config tests passed; 16/16 affected checkout
  integration tests passed against PostgreSQL Testcontainers.
- The production bot adapter no longer exports unsigned Buy Now orchestration. Existing presenter
  tests now enter through a Telegram-user-bound signed callback and authoritative customer lookup.
- Production callback configuration rejects the documented placeholder and equality with Telegram
  token/webhook or SePay HMAC domains, caps TTL at 86400 seconds, emits key names only, and documents
  one-active-key rotation that intentionally invalidates old short-lived tokens.
- Planned migrations are now append-only after deployed `001`–`003`: T126 `004`, outbox `005`, admin
  `006`, hot indexes `007`, SePay inbox `008`, Feature 003 `009`, Feature 002 `010`.

## Gate 0 source-of-truth correction (2026-07-17)

The current independent review reopened T148, T171, T172, and T174. T175/T176 now explicitly own
the durable SePay lifecycle rather than relying on the earlier verifier-only checkbox. The Gate 0
Spec Kit sequence is recorded as constitution check -> specify delta -> clarify not required -> plan
-> checklist -> tasks -> analyze. The corrected source of truth permits equal SePay/VietQR account
values for a pilot while retaining distinct VA support, requires strict rawHash-bound claim
validation and atomic mutation-alert idempotency, and renumbers later migrations to 009/010. Gate 0
design analysis has no unresolved Critical/High finding; implementation, staging, and release gates
remain open and Feature 001 stays `REQUEST_CHANGES`.

## Slice 1 SePay/VietQR correctness evidence (2026-07-17)

- RED: equal account config failed; the strict envelope matrix allowed nested unknown fields and
  auth timestamp zero; rawHash was absent from claims.
- GREEN: separate keys accept equal or distinct values; claims carry rawHash; strict schema and
  source/provider/payload/time consistency precede trust restoration; mutation alerting is atomic
  and unique per incoming raw hash.
- Acceptance: same-account pilot and distinct VA requests traverse signed SePay -> Fastify ->
  PostgreSQL commit -> exact 200 success -> worker -> matcher -> settlement.
- PostgreSQL recovery: 20 mutated replays produce one alert, expired leases reclaim with a newer
  generation, stale ack changes zero rows, and poison evidence dead-letters at the bounded budget.
- Verification: focused 15/15; host 459/459 across 85 files; typecheck/lint/format/secret/build/audit
  pass, build packages 8 migrations, production audit reports 0 vulnerabilities.
- Task truth: 153 checked / 22 open / 175 rows. Feature 001 remains REQUEST_CHANGES.
- Full host gate: **361/361 tests across 68/68 files**; typecheck, lint, format check, secret scan,
  build, and production audit exited 0; production audit found 0 vulnerabilities.
- Runtime/provenance: Node `20.19.0`, npm `10.8.2`, Docker context `desktop-linux`, server `29.2.1`.
  Node 24 was not rerun for this pass. `.git` is invalid, so this is local evidence only.
- Verdict remains `REQUEST_CHANGES`. Gate 0 cross-artifact Critical/High count is 0; canonical next
  slice is T121/T126.

## T121/T126 durable Telegram ingress evidence (2026-07-17)

- RED: `telegram-ingress-durable.test.ts` failed to import because the durable inbox module did not
  exist.
- GREEN matrix: 10/10 dedicated Testcontainers cases cover durable ack, retryable DB failure,
  duplicate-vs-mutation, two-instance claim exclusion, stale-owner fencing, throttle recovery,
  user/action isolation, bounded dead-letter, retention, safe telemetry, private callback context,
  identity/update/callback/body bounds, and no raw text/username persistence.
- Concurrency/retry lane: five consecutive pre-review runs passed; final full suites passed after all
  review corrections.
- Runtime: host Node `20.19.0` and target Node 24 (Docker socket plus
  `TESTCONTAINERS_HOST_OVERRIDE=host.docker.internal`) each passed **371/371 tests across 69/69
  files**. The first Node 24 attempt without a mounted Docker socket failed 30 suite setups and was
  correctly treated as environment setup failure, not code failure; the corrected real-Docker run
  passed.
- Static/build: typecheck, lint, format check, secret scan, build, and production audit pass;
  production audit found 0 vulnerabilities. Build output contains `004_telegram_inbox.sql`.
- Four-angle manual review accepted/fixed: group callback private-context bypass, missing durable
  mutation evidence, catalog/unknown budget bypass, and permissive/no-op composition plus missing
  retention/telemetry. Final slice result: APPROVE, 0 Critical/Major.
- Task truth: **131 checked / 40 open / 171 rows**. `.git` remains invalid, so no SHA/CI claim.
  Feature 001 remains `REQUEST_CHANGES`; canonical next slice is T122/T127.

## T122/T127 verified SePay ingress evidence (2026-07-17)

- RED: runtime ingress import was missing; mutated provider transaction IDs silently returned
  `ALREADY_APPLIED`; unsafe IP trust configuration did not fail during composition.
- GREEN: exact raw-body `sha256=` HMAC, safe timestamp freshness, post-HMAC schema validation,
  trusted direct-proxy/IP allowlist, branded `VerifiedSePayEvidence`, pre-verifier body limit, and
  secret/body-safe provider responses are covered. Only a committed application result receives
  success; typed failure/exception receives retryable 500.
- Persistence: exact duplicate evidence is idempotent. Same provider transaction ID with changed
  raw hash, amount, account, direction, or content creates one `REFERENCE_COLLISION` discrepancy.
- Runtime: host Node `20.19.0` and target Node 24 with Docker socket plus
  `TESTCONTAINERS_HOST_OVERRIDE=host.docker.internal` each passed **382/382 tests across 70/70
  files**, including real PostgreSQL Testcontainers.
- Static/build: typecheck, lint, format check, secret scan, build, and production audit pass;
  production audit found 0 vulnerabilities and build output retains all four migrations.
- Four-angle manual review fixed startup trust-config validation and typed-failure provider
  acknowledgement. Final slice result: APPROVE, 0 Critical/Major.
- Task truth: **133 checked / 38 open / 171 rows**. `.git` remains invalid, so no SHA/CI claim.
  Feature 001 remains `REQUEST_CHANGES`; canonical next slice is T124/T124a/T128.

## T124/T124a/T128 payment hardening evidence (2026-07-17)

- RED: raw evidence forged through a cast settled and wrote a VERIFIED row; evidence 61 seconds in
  the future settled; cancellation after settlement returned generic `ORDER_NOT_CANCELLABLE`;
  concurrent cancel/settle threw `VersionConflictError`; expiry/settlement deadlocked.
- GREEN: private runtime evidence symbol plus service guard, strict SePay calendar parsing,
  invalid/future-time rejection before persistence, Order-then-Intent `FOR UPDATE` lock order,
  locked cancel/expiry re-read, and typed `ALREADY_PAID`.
- Dedicated matrix: 11/11 tests cover five provider-ID mutation dimensions, raw/unbranded evidence,
  late/future/invalid time, review projection, two-connection cancel/settle convergence, and expiry
  convergence. The file passed five consecutive runs after the final fixes.
- Runtime: host Node `20.19.0` and target Node 24 Docker with nested PostgreSQL Testcontainers each
  passed **393/393 tests across 71/71 files**.
- Static/build: typecheck, lint, format check, secret scan, build, and production audit pass;
  production audit found 0 vulnerabilities and the build retains four migrations.
- Four-angle manual review result: APPROVE, 0 Critical/Major.
- Task truth: **136 checked / 35 open / 171 rows**. `.git` remains invalid, so no SHA/CI claim.
  Feature 001 remains `REQUEST_CHANGES`; canonical next slice is T125/T129.

## T125/T129 unified callback and runtime dispatcher evidence (2026-07-17)

- RED: `createCallbackTokenCodec` and `createTelegramDomainDispatcher` did not exist; 16/17 token
  cases and both dispatcher tests failed at the missing runtime boundary.
- GREEN codec: compact action schemas cover catalog, checkout, history, support, and admin with an
  8-byte HMAC tag, numeric-user binding, expiry/skew, key version, canonical ULIDs, and <=64 bytes.
- GREEN runtime: worker drains the durable PostgreSQL Telegram inbox through the distributed
  limiter into domain callbacks; all output buttons are resealed; a real grammY `Api` responder
  acknowledges callbacks and sends the resulting message.
- Replay: Buy Now keeps its stable nonce; cancel/payment remain transactional; support opens now
  serialize stable correlations and return the existing ticket across concurrent callback replay.
- Acceptance: a signed callback traverses real HTTP webhook receipt, PostgreSQL claim, verification,
  domain menu, output resealing, and responder invocation.
- Runtime: host Node `20.19.0` and target Node 24 Docker with nested Testcontainers each passed
  **416/416 tests across 74/74 files**.
- Static/build: typecheck, lint, format check, secret scan, build, and production audit pass; 0
  production vulnerabilities.
- Four-angle manual review result: APPROVE, 0 Critical/Major.
- Task truth: **138 checked / 33 open / 171 rows**. `.git` remains invalid, so no SHA/CI claim.
  Feature 001 remains `REQUEST_CHANGES`; canonical next slice is T161/T162.

## T161/T162 outbox fencing evidence (2026-07-17)

- RED: dedicated fencing run finished 2 passed / 2 failed. Unsafe batch size resolved instead of
  rejecting, and a fenced acknowledgement returned no `stale` accounting.
- GREEN: migration `005_outbox_fencing.sql` adds monotonic `claim_generation`; claims increment it;
  ack/fail require matching row ID, owner, and generation and return whether exactly one row changed.
- Concurrency: worker A generation 1 expires; worker B reclaims generation 2; stale A ack and fail
  each change zero rows; current B ack succeeds. Current-generation failure applies once and replay
  changes zero rows.
- Bounded worker: the drainer claims one event at a time up to the requested bounded batch, holds a
  database-time cutoff, reports fenced outcomes as `stale`, and logs the counter in production.
- Defensive bounds: claim batch 1–100, owner 1–128 characters, lease 1–300 seconds, error code
  1–128 characters, and attempt budget 1–10000. Candidate ordering is `occurred_at, id`.
- Focused verification: outbox fencing, recovery, concurrency, and fulfillment handlers pass
  **16/16 tests across 4/4 files**.
- Runtime: final-source host Node `20.19.0` and target Node 24 Docker with nested PostgreSQL
  Testcontainers each pass **420/420 tests across 75/75 files**.
- Static/build: typecheck, lint, format check, secret scan, build, and production audit pass;
  production audit found 0 vulnerabilities and build output contains five migrations.
- Four-angle manual review result: APPROVE, 0 Critical/Major.
- Task truth: **140 checked / 31 open / 171 rows**. `.git` remains invalid, so no SHA/CI claim.
  Feature 001 remains `REQUEST_CHANGES`; canonical next slice is T163/T164.

## T163/T164 durable AdminConfirmation evidence (2026-07-17)

- RED: dedicated run finished **0/2**. `allowlisted_command_ref` was missing, a fresh callback
  composition lost the pending action, and forced audit failure left the confirmation `CONSUMED`
  while the discrepancy mutation rolled back.
- Persistence: migration `006_admin_confirmation.sql` adds an allowlisted command reference with a
  database check plus bounded `payload_redacted`; TypeScript uses the same one-command durable
  allowlist and production callback composition contains no pending `Map`.
- Atomicity: `FOR UPDATE` locks the confirmation; challenge verification, CREATED -> CONFIRMED,
  discrepancy update, append-only audit, and CONFIRMED -> CONSUMED commit in one transaction.
- Recovery/replay: a fresh service/callback composition confirms the pre-restart action. Two
  concurrent correct confirmations converge to one mutation and one audit; later correct replay is
  idempotent, while wrong challenge or mutated payload/fingerprint fails without consuming.
- Rollback proof: a PostgreSQL audit trigger raises after the discrepancy update. The call rejects,
  discrepancy remains `OPEN`, confirmation remains `CREATED`, and retry succeeds after removing the
  fault with exactly one audit row.
- Focused verification: admin confirmation, owner acceptance, Telegram domain dispatch, and runtime
  acceptance pass **13/13 tests across 5/5 files**.
- Runtime: final-source host Node `20.19.0` and target Node 24 Docker with nested PostgreSQL
  Testcontainers each pass **423/423 tests across 76/76 files**.
- Static/build: typecheck, lint, format check, secret scan, build, and production audit pass;
  production audit found 0 vulnerabilities and build output contains six migrations.
- Four-angle manual review result: APPROVE, 0 Critical/Major.
- Task truth: **142 checked / 29 open / 171 rows**. `.git` remains invalid, so no SHA/CI claim.
  Feature 001 remains `REQUEST_CHANGES`; canonical next slice is T165/T166.

## T165/T166 fulfillment atomicity evidence (2026-07-17)

- RED: dedicated run finished **0/2**. When the claim-event insert failed, AVAILABLE stock remained
  committed as READY. A normal pre-reserved asset never attempted `DigitalAssetClaimed` at all.
- Atomic path: transaction-only claim locks the order's deterministic active hold or one AVAILABLE
  asset; AVAILABLE -> RESERVED, RESERVED -> READY, and outbox append commit together.
- Crash proof: a PostgreSQL trigger rejects `DigitalAssetClaimed`. AVAILABLE returns to AVAILABLE
  with no owner; pre-reserved returns to RESERVED for the same Order; neither leaves an event or
  Delivery Bundle. Removing the fault makes retry succeed.
- Replay/version: the event aggregate version equals READY asset version 2 in both entry paths.
  READY re-entry repairs a historical missing event under row lock, while later replay remains one
  event and one bundle.
- Focused verification: fulfillment atomicity, recovery, handler replay, asset concurrency, and
  acceptance pass **12/12 tests across 5/5 files**.
- Runtime: final-source host Node `20.19.0` and target Node 24 Docker with nested PostgreSQL
  Testcontainers each pass **425/425 tests across 77/77 files**.
- Static/build: typecheck, lint, format check, secret scan, build, and production audit pass;
  production audit found 0 vulnerabilities.
- Four-angle manual review result: APPROVE, 0 Critical/Major.
- Task truth: **144 checked / 27 open / 171 rows**. `.git` remains invalid, so no SHA/CI claim.
  Feature 001 remains `REQUEST_CHANGES`; canonical next slice is T167/T168.

## T167/T168 bounded recovery evidence (2026-07-17)

- RED: `tests/integration/recovery-jobs.test.ts` failed before collection because the five public
  recovery modules did not exist. The official SePay API adapter and structured-code tests also
  failed before their production seams were added.
- Order/intent expiry: oldest-first SKIP LOCKED selection is bounded; Order transition, live-intent
  void, and reservation release share one transaction.
- Reservation/bundle: stale reservations recover per row despite a forced PostgreSQL poison trigger;
  concurrent bundle workers split expired live rows and never mutate CONSUMED.
- Supplier: UNKNOWN/PENDING rows receive a durable retry deadline before network work; recovery calls
  `queryOrder` only, never `createOrder`, and one provider failure does not stop the next row.
- SePay: one database advisory fence protects a bounded provider window. The official v2 adapter
  uses the exact HTTPS host, Bearer credential, date/page/per-page bounds, ISO timestamps, bounded
  body/schema parsing, source-qualified IDs, and 429 `Retry-After` metadata. Every accepted row still
  passes `applyPaymentEvidence`; structured `code` wins over noisy content when present.
- Telemetry: every configured class reports claimed, succeeded, failed, backlog, and oldest age;
  worker scheduling remains single-flight and runs recovery every 60 seconds.
- Focused verification: recovery, reconciliation, reservation, supplier, delivery, config, and
  runtime lanes pass **28/28 tests**.
- Runtime: final-source host Node `20.19.0` and target Node 24 Docker with nested PostgreSQL
  Testcontainers each pass **433/433 tests across 79/79 files**.
- Static/build: typecheck, lint, format check, secret scan, build, and production audit pass;
  production audit found 0 vulnerabilities and build output contains six migrations.
- Four-angle manual review result: APPROVE, 0 Critical/Major.
- Task truth: **146 checked / 25 open / 171 rows**. `.git` remains invalid, so no SHA/CI claim.
  Feature 001 remains `REQUEST_CHANGES`; canonical next slice is T169/T170.

## T169/T170 query-plan and cache evidence (2026-07-17)

- RED: `query-plan.test.ts` initially observed `order_customer_idx` + Sort for history and a
  `digital_asset` Seq Scan + Sort for deterministic claim.
- GREEN: migration `007_hot_indexes.sql` adds `order_history_customer_created_idx` and
  `digital_asset_claim_idx`; pilot-sized `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` now selects each
  composite index with no Sort node.
- Search: the previous leading-wildcard `%LIKE%` path is replaced by bounded Unicode tokenization,
  accent-folded simple-tsquery word prefixes, and GIN expression indexes for product/category/alias.
- Cache: 20 simultaneous cold reads share one authoritative load; invalidating during an in-flight
  read prevents that stale result from repopulating the newer cache version.
- Focused verification: query-plan, cache, search, repository, history, and asset-claim lanes pass
  **24/24 tests**.
- Runtime: final-source host Node `20.19.0` and target Node 24 Docker with nested PostgreSQL
  Testcontainers each pass **437/437 tests across 81/81 files**.
- Static/build: typecheck, lint, format check, secret scan, build, and production audit pass;
  production audit found 0 vulnerabilities and build output contains seven migrations.
- Four-angle manual review result: APPROVE, 0 Critical/Major.
- Task truth: **148 checked / 23 open / 171 rows**. `.git` remains invalid, so no SHA/CI claim.
Feature 001 remains `REQUEST_CHANGES`; canonical next slice is T171/T172.

## T171/T172 beneficiary identity split evidence (2026-07-17)

- RED: `tests/contract/payment-beneficiary-config.test.ts` initially failed **3/5** because the
  bank display-name field, equality guard, and bounded bank-name validation were absent.
- Config contract: `SEPAY_MERCHANT_ACCOUNT_ID` and `VIETQR_ACCOUNT_NUMBER` are both required,
  independently validated, and rejected when equal. `VIETQR_BANK_NAME` is trimmed and bounded to
  a non-blank display value; `.env.example` documents the field without owner credentials.
- Settlement boundary: `presentPaymentForOrder` persists the SePay merchant identity and the
  canonical matcher continues to compare verified evidence against that value.
- QR boundary: fresh, reused, and unique-conflict presentation paths pass an explicit
  `beneficiaryAccountNumber` to VietQR; no path derives the QR account number from the SePay
  identity. The payment presenter carries the validated bank display name.
- Runtime wiring: `src/worker.ts` maps both configured identities and bank name into checkout;
  `MerchantConfig` keeps the split explicit end-to-end.
- Focused verification: config, VietQR, presenter, and callback boundary lanes pass **25/25 tests
  across 4/4 files**; the distinct acceptance journey proves settlement with the SePay identity
  and QR rendering with the separate beneficiary account.
- Runtime: final-source host Node `20.19.0` and target Node 24 Docker with nested PostgreSQL
  Testcontainers each pass **442/442 tests across 82/82 files**.
- Static/build: typecheck, lint, format check, secret scan, build, and production audit pass;
  production audit found 0 vulnerabilities.
- Four-angle manual review result: **APPROVE**, 0 Critical/Major. Task truth: **150 checked / 21
  open / 171 rows**. `.git` remains invalid, so no SHA/CI claim. Feature 001 remains
`REQUEST_CHANGES`; canonical next slice is T173/T174.

## T173/T174 compiled migration and honest Docker CI evidence (2026-07-17)

- RED: `tests/acceptance/migrate-prod.test.ts` failed because `package.json` had no
  `migrate:prod` script.
- GREEN: `migrate:prod` now runs `node dist/infrastructure/db/migrate.js`; the compiled artifact
  resolves copied migrations and completes against a real Testcontainers PostgreSQL instance
  without `tsx`.
- Docker semantics: `dockerAvailable()` is a read-only live runtime probe used by gated suites;
  `startPostgres()` cleans up and rethrows if a started container fails migration, so a real
  startup failure cannot become a skip.
- CI workflow: `.github/workflows/ci.yml` now verifies `docker info`, includes `VIETQR_BANK_NAME`,
  builds before compiled migration smoke, and uses `migrate:prod` for the migration gate.
- Runtime: host Node 20.19.0 and target Node 24 Docker each pass **444/444 tests across 83/83
  files**; typecheck, lint, format check, secret scan, build, and production audit pass with 0
  production vulnerabilities.
- Four-angle manual review: **APPROVE**, 0 Critical/Major. `.git` remains invalid and no hosted
  CI run was available, so no SHA/CI provenance claim is made. Task truth: **152 checked / 19 open /
 171 rows**. Feature 001 remains `REQUEST_CHANGES`; T151–T153 are next.

## T153 independent review and remediation evidence (2026-07-17)

- Three read-only review angles ran: Spec/Plans, Security, and Regression/Skeptic. The first
  regression pass found a Major clean-CI ordering defect; Build was moved before acceptance and the
  corrected ordering received a focused **APPROVE, 0 Critical/Major** re-review.
- Consolidated verdict remains **REQUEST_CHANGES**: delivery authorization still trusts
  `x-customer-id` instead of a signed Telegram session (Critical); SePay HTTP settlement is still
  synchronous; production vault/supplier/notifier and QR photo paths remain unwired; and valid
  Git/hosted-CI provenance is absent (Major/external gates).
- Remediation completed during the review loop: production rejects documented Telegram placeholders,
  secret scan never prints matched secret material, and failed asset delivery rolls back bundle
  consume/completion with a regression test.
- Final runtime verification after these fixes: host Node 20.19.0 and target Node 24 Docker each
  pass **447/447 tests across 83/83 files**; typecheck, lint, format, secret scan, build, and audit
  pass with 0 production vulnerabilities.
- T115/T118, T136–T150, T152, and T153 remain open; Feature 001 remains `REQUEST_CHANGES` and is
  not pilot/production ready.

## T151 CI lane and JUnit publication evidence (2026-07-17)

- Workflow explicitly probes Docker, builds compiled artifacts, runs `migrate:prod`, and executes
  unit/contract/property, security, integration, acceptance, and performance lanes.
- Each test lane emits JUnit XML; `actions/upload-artifact@v4` publishes the evidence with run id
  and attempt in the artifact name and `if: always()` retention behavior.
- Local security lane passes **73/73 tests across 10/10 files**; local performance lane passes
  **4/4 tests across 2/2 files**. Full host and Node 24 lanes remain **444/444 across 83/83**.
- This proves workflow structure and local commands only. Invalid `.git` and absent hosted CI mean
T152 remains open and no SHA/CI provenance is claimed.

### Superseding runtime count after T153 remediation (2026-07-17)

The earlier 444-test count is superseded: the added Telegram placeholder, asset-version-race, and
compiled-CI checks now yield **447/447 tests across 83/83 files** on host Node 20.19.0 and target
Node 24 Docker. The review verdict remains `REQUEST_CHANGES` because signed delivery auth,
durable/async SePay ingress, production vault/supplier/notifier/QR media, and valid Git/hosted-CI
provenance are not yet closed.

## Gate 0 supersession of Slice 2–3 evidence (2026-07-17)

The prior local test counts remain historical command results only. They do not prove the newly
identified crash, upgrade, transport, rotation, or privacy requirements and carry no approval
meaning. The former Slice 2–3 zero-finding evidence claims are withdrawn.

- T177 remains checked only for atomic numeric identity/concurrency and non-mocked resolver tests.
- T139 remains checked only for the existing send-failure/retry/correct-recipient tests.
- T178 is reopened for migration 009 compatibility, numeric-only root bootstrap, inbox username
  exclusion, verified observation, and pruning.
- T145/T146 are reopened for Bundle-commit-before-handoff recovery, vault-write/DB-rollback
  compensation, session refresh/rotation, pre-send claim verification, and Mini App transport.
- T179–T185 are the required RED gates; T186–T190 own their implementation slices.

No new GREEN or runtime evidence is recorded until Gate 0 analyze has zero unresolved
Critical/High design findings. `.git` remains invalid, no SHA/hosted-CI evidence exists, and Feature
001 remains `REQUEST_CHANGES` and not pilot/production ready.

## Post-Gate 0 focused implementation evidence (2026-07-17)

- RED migration test first failed 0/2 because 009 did not exist and 008 still contained
  identity/delivery DDL.
- GREEN source now freezes 008, adds idempotent/collision-fail-closed 009, strips `actorUsername`
  before durable Telegram persistence, wires dedicated `DELIVERY_SESSION_*` configuration, and
  verifies explicit previous-key/version grace.
- Focused command: migration acceptance + config security + durable Telegram ingress + delivery
  route rotation, **32/32 across 4 files**; `tsc --noEmit` passes.
- The prior compiled `migrate:prod` 5/5 result was superseded as false-green for expanded-008. The
  corrected fixture now contains exact old constraints/indexes plus real session/handoff rows; RED
  failed on the missing lease index. GREEN explicitly replaces the RETRY-only due index, adds the
  PROCESSING lease-expiry index, preserves rows, and asserts `pg_get_indexdef()`. Compiled migration
  passes 5/5 and T183/T186 re-close.
- The first full-host run failed 5/473 and correctly exposed missing `capability_key` writes plus the
  stripped-username identity handoff. After adding the deterministic key write and a separate
  verified username-observation table/consume path, targeted regressions pass 6/6 and the full host
  rerun passes **473/473 tests across 88 files**. Typecheck, lint, format, secret scan, build, and
  production dependency audit pass.
- This remains partial evidence: crash/handoff recovery, vault rollback compensation, expiry
  refresh, Mini App transport, username prune job, full host/Node 24 gates, and SHA/hosted-CI
  evidence remain open.
- Task truth is **157 checked / 30 open / 187 rows**. Feature 001 remains `REQUEST_CHANGES`.

## T179-T190 crash/transport/privacy evidence (2026-07-17)

- Historical migration: the expanded-008 fixture carries the real RETRY-only index, old status
  constraint, and seeded delivery rows. Compiled migration **5/5** proves row preservation, exact
  due/lease index definitions, SePay-only-008 upgrade, and collision rollback.
- Delivery crash recovery: PostgreSQL tests cover Bundle-commit-before-handoff reconstruction,
  vault-write/DB-rollback compensation, STORED recovery, expired-session refresh, current/previous
  key grace, unknown-version rejection, terminal/expired cleanup, and one usable capability.
- Customer transport: Telegram Mini App acceptance verifies bounded/fresh `initData`, numeric owner,
  audience, one-time redemption, replay/BOLA/expiry rejection, and bearer retrieval only after
  vault/session validation. Notification payloads carry a handoff URL, not a session token.
- Identity/privacy: durable Telegram inbox rows contain no username; numeric root bootstrap does not
  seed configured username metadata; only authenticated observations update it; bounded pruning
  clears stale metadata.
- Focused proof includes delivery crash/key/config, Mini App, migration, and username suites. The
  final host Node **20.19.0** run passes **484/484 tests across 92/92 files**.
- Static/build proof: typecheck, lint, format check, secret scan, build with **9 migrations**, and
  production dependency audit with **0 vulnerabilities** pass.
- Evidence boundary: Node 24 Docker, compiled true-staging main+worker, valid Git SHA, hosted CI,
  external vault/supplier, Telegram media worker, and QR scan proof were not rerun or do not yet
  exist. No SHA-bound, staging-ready, pilot-ready, or production-ready claim is made.
- Task truth is **170 checked / 17 open / 187 rows**. Feature 001 and T153 remain
  **`REQUEST_CHANGES`**.

## T136/T142 external-vault evidence (2026-07-17)

- RED 1: `tests/contract/external-vault.test.ts` failed **4/5** because configured external mode
  still threw the permanent "not wired" startup error.
- RED 2: the expanded contract failed on oversized material; strict response content type and the
  65536-byte boundary were then implemented.
- RED 3: readiness tests proved the old Kysely executor double always returned 503; the double was
  corrected, then the test failed because vault health was not part of `/ready`.
- GREEN: the real loopback HTTP contract covers Bearer auth, health, namespaced deterministic PUT,
  reveal, idempotent delete, transient retry, timeout, foreign-provenance rejection, strict JSON,
  size bounds, and redacted errors. Main/worker startup and Fastify readiness fail closed on vault
  health.
- Focused verification: external vault, base vault, app composition, delivery crash, config
  redaction, and compiled entrypoint lanes pass. Final host Node **20.19.0** passes **492/492 tests
  across 93/93 files**.
- Typecheck, lint, format check, secret scan, build with **9 migrations**, and production dependency
  audit with **0 vulnerabilities** pass.
- No true staging endpoint, Node 24 Docker rerun, valid Git SHA, or hosted CI evidence is claimed.
  T140 and the other 14 open tasks remain blockers. Task truth is **172 checked / 15 open / 187
  rows**; overall verdict remains **`REQUEST_CHANGES`**.

## Reviewer false-green evidence supersession (2026-07-18)

- The earlier 492/492 host run is retained as historical evidence for its exact source snapshot only.
  It does not exercise the newly required slow-body, chunked-envelope, redirect, egress, double-delete
  failure, refresh-window, grace-deadline, or secret-gated composition cases.
- T136/T142/T180/T181/T182/T187/T188 are reopened before any new code change. T185/T190 remain
  checked only for durable-inbox username exclusion, numeric root bootstrap, verified observation
  application at the narrower seam, and bounded pruning.
- Current task truth is **165 checked / 22 open / 187 rows**. No new RED failure has yet been recorded
  for A0/A1 at this Gate 0 point.
- No Docker, Node 24, Git/SHA, hosted CI, staging endpoint, rotated credential, or launch-gate evidence
  is inferred from the historical local suite.
- Verdict remains **`REQUEST_CHANGES`**; the next permitted implementation is A0 external-vault RED.

## A0 corrected external-vault evidence (2026-07-18)

- RED boundary capture: external-vault plus config tests initially reported **16 failed / 23
  passed** across the intended slow-body, chunked-body, serialized-size, redirect, egress, strict
  schema, and cross-domain key-reuse gaps. After the first transport rewrite, external-vault was
  still **6 failed / 6 passed** because root endpoint normalization produced a protocol-relative
  `//healthz` target. The isolated Node URL probe confirmed the target host became `healthz`.
- RED composition capture: config plus base-adapter tests reported **9 failed / 24 passed** until
  explicit egress policy fields were parsed and wired. A final retry-classification RED reported
  **1 failed / 12 passed** because a strict HTTP 400 was attempted three times.
- GREEN network/config proof: `npm test -- tests/integration/app-composition.test.ts
  tests/contract/external-vault.test.ts tests/contract/vault-adapter.test.ts
  tests/security/config-redaction.test.ts` passes **55/55 across 4 files**.
- Static focused proof: `npm run typecheck`, `npm run lint`, and focused `prettier --check` all exit
  0 on host Node **24.15.0**.
- Proven behavior: one deadline through streamed body plus parse/validation, MAX+1 early destroy,
  exact-max escaped material round-trip, one serialized request buffer, terminal redirects and
  non-transient responses, safe base-path normalization, strict health/write/reveal/delete/error
  envelopes, full body finalization, per-request DNS policy/re-resolution, startup/readiness policy
  wiring, generic redaction, and current/previous delivery-key separation from all named domains.
- Evidence boundary: no full-host suite, Docker/Node-24-container, build, secret scan, dependency
  audit, real staging vault, valid Git SHA, hosted CI, or credential-rotation result is claimed.
  T136/T142 re-close only; A1 and later slices remain open.
- Task truth is **167 checked / 20 open / 187 rows**. Feature 001 and T153 remain
  **`REQUEST_CHANGES`**.

## A1 corrected delivery compensation/rotation evidence (2026-07-18)

- RED captured on current work: initial generation retry reused one vault operation key instead of
  two; a send timeout returned `SENT`; expired send owners still wrote `SENT`/`RETRY`; persisted chat
  mutation still sent; concurrent terminal cleaners duplicated delete; terminal delete failure had no
  ledger/backoff; exact previous-key deadline was accepted.
- GREEN delivery/security proof: sequential `vitest` runs pass **75/75 across 8 focused files**:
  delivery crash/compensation 18, notification lease/recipient retry 8, delivery key rotation 5,
  config redaction 32, Telegram runtime 1, migration CLI 3, static upgrade path 3, and compiled
  migrate-prod upgrade/collision 5. PostgreSQL/Testcontainers ran against Docker, with zero skipped in
  these files.
- Correctness: PREPARED sessions are inactive; the real reveal seam denies the double-failure orphan;
  initial/refresh generations freeze deterministic material; stale owner ACK/fail affects zero rows;
  persisted Bundle/Customer/chat/ref is rechecked; terminal/expired refs transfer to the child ledger;
  cleanup is owner/generation fenced with delayed exponential backoff; previous-key equality at the
  grace deadline fails closed.
- Static/build proof: typecheck, lint, full format check, secret scan, build, and production audit all
  exit 0; build copies **10 migrations** and production audit reports **0 vulnerabilities**.
- Docker incident was not hidden: an overly parallel eight-file Testcontainers run exhausted Node
  workers and dropped the Docker pipe. Docker Desktop was recovered by stopping its processes,
  `wsl --shutdown`, and one hidden restart; Engine **29.2.1** plus `hello-world` passed. The final
  focused evidence above ran sequentially and passed.
- Independent A1 re-review: Spec/Traceability, Security/Concurrency, and Regression/Skeptic return
  **0 Critical / 0 High** for the corrected A1 scope. Residual cleanup audit-event and generic error
  code observations remain non-release evidence.
- Evidence boundary: no full-host suite, Node 24 Docker suite, true staging vault/supplier/Telegram
  media runtime, valid Git SHA, hosted CI, rotated credential, or owner launch-signature claim is
  made. Task truth is **172 checked / 15 open / 187 rows**. Feature 001 and T153 remain
  **`REQUEST_CHANGES`**; next slice is T137 RED -> T143 GREEN.
