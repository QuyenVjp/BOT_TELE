# Follow-up Multi-Agent Review — Feature 001

**Date:** 2026-07-16  
**Verdict:** `REQUEST_CHANGES`  
**Review mode:** whole-tree read-only audit. The workspace contains a `.git` directory, but it is not a valid repository, so there is no trustworthy merge-base, commit SHA, or branch diff.  
**Reviewers:** Spec Kit alignment, payment/security, runtime, and Karpathy/Matt Pocock quality passes.

This review supersedes the earlier remediation verdict. The recent changes fix several real defects (build artifact paths, pinned migration lock, payment projection decisions, UTF-8 VietQR TLV length, two-phase vault read, and durable outbox claim direction), but the product is still not safe to pilot.

## Stop-ship findings

### P0 — final-stock checkout can take money from multiple customers

`src/modules/commerce/buy-now.ts:113-157` only revalidates `stock_policy` and inserts a `PENDING_PAYMENT` Order. It does not reserve a concrete `digital_asset` before creating the payment session. The asset is claimed later in `src/modules/digital-goods/fulfillment.ts:72-101`, after verified payment. Two customers can therefore receive VietQR instructions for one final account; the loser can pay and only then become `OUT_OF_STOCK`.

The accepted rule is database-commit order, not human click time: the first transaction that commits an atomic reservation wins. Every loser gets an explicit out-of-stock result, no Payment Intent, no QR, and no charge. Reservation release on cancel/expiry must be atomic and recoverable.

Required proof: 20 concurrent end-to-end `buyNow → reserve → payment presentation` calls against one asset; exactly one reservation and one Payment Intent; 19 losers with no Payment Intent; double-click same customer/order is one effect; cancel/expiry releases safely.

### P1 — runtime ingress is still a skeleton

`src/main.ts:25-56` wires an in-memory inbox, an in-memory rate limiter, a no-op Telegram handler, and a SePay handler that always returns `503 sepay_ingress_not_wired`. `grammy` is installed but never imported in `src/`. The HTTP process can listen, but customers cannot browse/buy and verified SePay settlement cannot enter the domain.

T118 and the evidence must remain partial until the real dispatcher, durable inbox/rate limiter, and verified SePay boundary are wired. The current runtime smoke only proves that invalid configuration exits without `MODULE_NOT_FOUND`; it does not prove listen, `/health`, `/ready`, Telegram dispatch, settlement, or delivery with production dependencies.

### P1 — outbox leases have no owner fencing or renewal

`src/infrastructure/outbox/repository.ts:155-196` acknowledges/fails by `id` only. A slow worker A can lose its 60-second lease, worker B can reclaim the row, and A can still clear B's claim or mark the event published. A batch of 20 events can also outlive the lease because handlers are processed serially. Add a fencing token/generation or `claimed_by + claim_expires_at` predicate to every ack/failure, renew leases for long work or bound claims per event, and test stale-owner completion.

### P1 — payment races and evidence boundary remain fail-open

- `cancelUnpaidOrder` reads the Order before its transaction and has no typed `ALREADY_PAID`/reconciliation result. A concurrent cancel/settlement can be decided by lock timing rather than the verified `transactedAt` policy. An on-time transfer processed after intent void is currently treated as generic unmatched. Lock/re-read Order + intent atomically and record money-for-terminal-order as explicit discrepancy/review.
- `decideMatch` accepts invalid `Date` values as not-late and has no future-skew bound. Runtime SePay parsing is not strict enough.
- `applyPaymentEvidence` accepts structurally forgeable `PaymentEvidence` and writes `SIGNATURE_STATUS='VERIFIED'`; only an opaque/branded value produced by the runtime verifier may reach settlement.
- SePay still lacks `sha256=` normalization, raw-byte/timestamp replay checks, trusted proxy/IP allowlist, strict schema mapping, durable webhook dedupe, and a real route.
- T124 is checked although `tests/integration/payment-evidence-hardening.test.ts` does not exist and mutated duplicate provider-ID evidence is not proven.

### P1 — idempotency and transaction safety are incomplete

- Duplicate Buy Now/payment presentation paths catch a PostgreSQL unique violation and then query on the same aborted transaction (`buy-now.ts:141-157`, `payments/service.ts:113-140`). Use `INSERT ... ON CONFLICT DO NOTHING RETURNING` or a savepoint, then read the winner. Add two-connection concurrency tests.
- `checkout.ts` can generate a fresh idempotency key when the callback omits one, so double-clicks can create multiple Orders. Signed callbacks need a stable action/checkout nonce.
- Fulfillment commits the asset claim and the `DigitalAssetClaimed` outbox event in separate transactions (`fulfillment.ts:80-127`); a crash between them loses the event. Make state + event one transaction.
- High-risk admin confirmation payloads live in `src/bot/callbacks/admin.ts:102-106`. Restart loses the action, and consuming confirmation before applying the effect creates a crash window. Persist an allowlisted command reference or consume + mutation + audit in one transaction/outbox.

### P1 — delivery and supplier paths are not production-safe

- Worker creates only the fixture supplier and no Telegram notifier (`src/worker.ts:38-60`). External vault, HTTP supplier, scheduled recovery, reconciliation, and notification are still absent.
- Delivery notification currently passes `orderId` as `customerId` (`src/modules/digital-goods/handlers.ts:92-104`).
- Delivery auth trusts `x-customer-id` (`src/modules/digital-goods/delivery-route.ts:58-68`), not a signed Telegram-bound session.
- Phase 2 reveal ignores a failed `markAssetDelivered` result (`delivery.ts:260-291`) and can still consume/complete. Lock/check asset owner/status and rollback the bundle if delivery marking fails.
- A send failure after token issue has no durable capability handoff; retries must recover without persisting raw credentials.

### P1 — payment beneficiary configuration is conflated

`SEPAY_MERCHANT_ACCOUNT_ID` and `VIETQR_ACCOUNT_NUMBER` are separate config values, but payment service/checkout passes one `merchantAccountId` into both matching and QR account-number fields. `.env.example` uses different example values. Split canonical SePay account identity from VietQR beneficiary account number and test with deliberately distinct values. Add validated bank display name to the same runtime path; injected presenter-only `bankName` tests are insufficient.

### P2 — recovery, query scaling, and UX quality are unfinished

- Recovery jobs are not wired; expiry reads an unbounded stale list and processes rows serially. Use bounded `FOR UPDATE SKIP LOCKED` batches, per-row conflict isolation, backlog/oldest-age telemetry, and reservation/bundle expiry jobs.
- Hot queries lack composite indexes for customer history and `(variant_id,status,created_at,id)` asset claim. Search uses `%LIKE%` normalization and category cache misses can stampede. Prove fixes with `EXPLAIN ANALYZE` and pilot-sized data, not mock timings.
- QR image generation and Telegram `sendPhoto` are absent. VietQR tests build and parse their own payload, so they are not an independent official golden vector.
- Emoji is confined to presenter files (31 occurrences), so it is not a domain-security defect, but reduce decorative icons to a small UX budget. Do not move every `const` into a global file: keep policy/copy/action constants at the smallest domain boundary and extract only repeated protocol/copy.
- Repeated raw callback strings (about 58 occurrences) must be replaced by the signed typed callback codec, not by a giant constants module.

## Evidence from this host

| Gate | Result |
|---|---|
| `npm run typecheck` | PASS |
| `npm run lint` | PASS |
| `npm run format:check` | PASS |
| `npm run build` | PASS |
| `npm run secret-scan` | PASS (does not inspect `.env`) |
| `npm run audit` | PASS — 0 high vulnerabilities |
| focused runtime/composition/VietQR/outbox tests | PASS — 24 tests |
| `npm run test:unit` | **FAIL as a suite**: 168 passed, 20 skipped, 5 Testcontainers suites failed to start because Docker daemon is unavailable |
| `docker info` | Client present; server unavailable (`dockerDesktopLinuxEngine` pipe missing) |

The “90 pure/composition tests green” statement is not a full acceptance result, and “container-gated suites skip cleanly” is false for the current unit command: several suites attempt to start a container and fail before their skip boundary. CI must either run with a verified Docker service or make the probe and skip behavior reliable; a skipped test is not production evidence.

## Required next gate

Feature 001 remains `REQUEST_CHANGES`. Claude must first update the Spec Kit artifacts with the final-stock reservation, idempotency, fencing, durable admin, and runtime evidence requirements, run cross-artifact analysis with no Critical/High findings, then implement T121–T153 plus the new review tasks test-first. Do not mark a checkbox or claim pilot-ready until CI evidence is bound to a valid commit SHA and a fresh independent review reports zero Critical/High.
