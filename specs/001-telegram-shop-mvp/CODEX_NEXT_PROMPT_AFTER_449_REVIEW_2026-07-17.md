# Codex continuation prompt — close Feature 001 Critical/Major after 449-test review

Workspace:

`C:\Users\ADMIN\Documents\Codex\2026-07-16\nghi`

Read first:

- `C:\Users\ADMIN\.codex\AGENTS.md`
- `.specify/memory/constitution.md`
- `specs/001-telegram-shop-mvp/CODEX_INDEPENDENT_REVIEW_AFTER_449_2026-07-17.md`
- `specs/001-telegram-shop-mvp/spec.md`
- `specs/001-telegram-shop-mvp/plan.md`
- `specs/001-telegram-shop-mvp/data-model.md`
- `specs/001-telegram-shop-mvp/contracts/`
- `specs/001-telegram-shop-mvp/tasks.md`
- `docs/01-research/SEPAY_WEBHOOK_INTEGRATION_2026-07-17.md`

Use `$karpathy-guidelines`, Spec Kit as feature truth, TDD at testable seams, `$harness-work` for
implementation and `$harness-review` before claiming a slice complete. Do not use Claude commands.

Continue automatically through the canonical slices below. Do not stop after each slice to ask
whether to continue. Stop only for a real owner decision, unavailable production authority, or a
reproduced blocker.

## Current verified baseline

On the final stable snapshot reviewed on 2026-07-17:

- typecheck, lint, format, secret scan, build and production audit pass;
- host full suite passes 449/449 tests across 83/83 files;
- build copies 8 migrations;
- ledger still says 153 checked / 18 open / 171, but it is stale for new SePay code;
- `.git` is invalid; no SHA or hosted CI evidence;
- Feature 001 remains `REQUEST_CHANGES`.

Do not reuse these counts after changing source. Rerun every gate and report the new exact numbers.

## Gate 0 — Spec Kit truth before more implementation

Run the required Spec Kit sequence for corrections:

`constitution -> specify/clarify delta -> plan -> checklist -> tasks -> analyze`

Make the smallest coherent artifact updates:

1. Reopen T171/T172. The keys must remain separate but equal values are valid.
2. Reopen T148 because no independent golden vector or QR image test exists.
3. Reopen/clarify the remaining T174 false-skip scope.
4. Add explicit test/implementation tasks for the durable async SePay inbox lifecycle; do not hide
   it under already-checked T122/T127 without updating their DoD/evidence.
5. Add explicit tasks for atomic Telegram customer/channel onboarding and canonical channel casing.
6. Update T118 comments: durable inbox/dispatcher now exist, but identity onboarding and full
   compiled runtime proof remain open.
7. Synchronize `analysis.md`, `traceability.md`, `review.md`, task comments and evidence to the
   current async SePay source and 8 migrations.
8. Renumber Feature 002/003 planned migrations monotonically after 008; never add a migration that
   sorts before an already deployed file.
9. `$speckit-analyze` must have zero unresolved Critical/High design inconsistencies before code.

## Slice A — payment account semantics and SePay inbox integrity

Write RED tests first, then implement:

### Merchant/beneficiary configuration

- Keep `SEPAY_MERCHANT_ACCOUNT_ID` and `VIETQR_ACCOUNT_NUMBER` as distinct fields.
- Remove the rule requiring their values to differ.
- Validate each independently.
- Add end-to-end same-value acceptance:
  official-shaped signed SePay payload → durable PostgreSQL inbox → worker →
  `applyPaymentEvidence` → exact match/settlement.
- Preserve a distinct-value test for explicit VA/sub-account deployments.
- Do not hardcode the owner's real account number in source, tests or committed docs.

### Durable SePay inbox

- Before restoring the verified brand from PostgreSQL, validate the envelope schema and require:
  `claim.sourceEventId === evidence.providerTransactionId` and
  `claim.rawHash === evidence.rawHash`.
- Validate `transactedAt`, amount, direction, structured code and source namespace after load.
- Make duplicate-mutation accounting and discrepancy/security alert one atomic idempotent
  transaction.
- Real PostgreSQL tests must prove durable accept before quick ACK, identical duplicate success,
  mutated duplicate discrepancy, worker crash/restart, fenced claim/ack/fail, retry/dead-letter and
  zero double settlement.
- Keep webhook HTTP response exact `200 {"success":true}` after durable acceptance; business work
  remains async.
- Record redacted telemetry/backlog/oldest-age without raw financial payload or secrets.

Completion gate for Slice A:

- no cast-through-trust shortcut;
- no fake inbox in the primary acceptance proof;
- focused tests + all static gates + full suite green;
- Spec Kit evidence synchronized;
- independent review finds zero Critical/Major in this slice.

## Slice B — Telegram identity onboarding

Write tests for a completely empty database:

- first `/start`, message or callback atomically creates/reuses `customer` and `channel_identity`;
- unique key is numeric Telegram user ID within canonical channel `telegram`;
- concurrent first contact from the same user produces exactly one identity;
- username/display name updates metadata only and never changes authorization;
- root admin is recognized solely from configured numeric Telegram ID in private context;
- fresh root-admin deployment constructs admin callbacks without seed-only assumptions;
- BOLA: one Telegram user never resolves another customer.

Implement a typed identity repository/service, use one shared channel constant, add a DB constraint
or migration for canonical channel values, and make the worker resolver call the real upsert path.
Acceptance must use the production SQL resolver, not a mock `resolveCustomerId`.

## Slice C — signed delivery session and durable notification capability

### Delivery authentication

- Delete public trust in `x-customer-id`.
- Issue a short-lived signed delivery session bound to Telegram numeric identity/customer, Bundle,
  audience, nonce and expiry.
- Verify signature/expiry/audience/ownership/replay before reveal.
- Never accept caller-supplied customer identity without a verified signature/session.
- Add forged-owner, tamper, expiry, replay, concurrent reveal and no-existence-oracle tests.

### Durable notification handoff

- Do not keep the only plaintext reveal token on a single call stack.
- Create a secure recoverable capability handoff that survives worker crash and Telegram ambiguity
  without storing raw credentials in Telegram/outbox.
- Fix the dormant `orderId`-as-`customerId` bug.
- A failed first notification must retry using the same logical Bundle/capability, never silently
  publish with an empty token.
- Add ambiguous-send, crash-after-send, 429/retry-after, blocked-chat and multi-worker dedupe tests.

## Slice D — production vault and supplier resale

### External vault

- Implement the approved external adapter; `VAULT_DRIVER=external` must not always throw.
- Add health/readiness, timeout/retry, namespace/provenance, redaction and fail-closed startup.
- `/ready` must include required vault health without exposing secret details.
- Production config requires the endpoint/token/provider fields needed by the chosen adapter.

### HTTP supplier

- `SUPPLIER_DRIVER=http` must instantiate a real adapter or fail startup; it must never silently set
  `supplier=null`.
- Require HTTPS base URL and supplier token in production config.
- Contract-test availability/create/query/cancel/refund/reconcile, schema validation, idempotency,
  rate limit, timeout `UNKNOWN`, query-before-retry and malformed assets.
- Integrate supplier fulfillment when the SKU policy allows it; local-only behavior remains
  unchanged.
- Asset ingestion, supplier order transition, outbox and delivery must be transactional/recoverable.

## Slice E — QR image and idempotent Telegram media

- Replace T148 self-round-trip with a fixed independent official-shaped payload/CRC vector.
- Render an actual QR image/PNG or a validated SePay/VietQR image URL according to the approved
  security model.
- Verify MB alias/BIN, URL encoding, exact integer VND amount, transfer code, template allowlist,
  content type and scanability.
- Implement Telegram `sendPhoto`, `editMessageText`/media fallback and caption limits.
- Use a durable delivery/dedupe key; handle `retry_after`, ambiguous send, blocked chats and worker
  restart without spam.
- Payment screen includes QR image, Order code, product/variant, quantity, unit/total VND, bank name,
  account owner/number, transfer content, expiry and check/cancel actions.

## Slice F — compiled production runtime and release evidence

- Close T115/T118 only when compiled main actually listens and serves `/health`/`/ready`, worker
  remains alive, and main+worker complete a real PostgreSQL customer journey with production
  resolver/dispatcher boundaries.
- Tighten Docker probe: only a proven unavailable daemon may skip. Runtime discovery, permission,
  socket/API mismatch or started-container failure must fail. Do not use early return that reports a
  skipped migration acceptance as passed.
- Remove duplicate security-suite execution/JUnit output from CI while preserving required lanes.
- Ensure local/secret-manager environment has a unique generated `BUY_NOW_CALLBACK_HMAC_KEY`; do
  not commit or print it and do not reuse Telegram/SePay/vault/supplier/AI secrets.
- Add the validated `VIETQR_BANK_NAME` deployment value. Current `.env` lacks both this field and the
  callback HMAC key, so current main/worker config loading fails before listen.
- Rotate previously exposed Telegram/QRouter credentials outside source control.
- Restore valid Git history, run hosted CI, bind evidence/SBOM/review to commit SHA, then run T153.

## Code-quality and honesty rules

- Preserve working durable Telegram dispatcher and existing user changes; do not rewrite working
  code merely because old task comments call it a no-op.
- Use existing domain commands/repositories; no channel handler may mutate payment/inventory/
  delivery tables directly.
- Centralize only genuinely reused constants/templates/actions; do not create a generic utils dump.
- Every external call has timeout, bounded retry/backoff, idempotency and typed errors.
- Every DB batch is bounded and deterministically ordered.
- No skipped/fake-primary acceptance, self-round-trip golden vector or weak `<= 1` assertion where
  the expected result is exactly one.
- Do not check a task because a file exists. Check it only when its production path and exact DoD are
  proven.
- Do not report “Feature 001 complete” until zero Critical/Major, valid Git/SHA, hosted CI and launch
  gates are all evidenced.

## Required report format after each canonical slice

```text
Verdict: APPROVE | REQUEST_CHANGES | BLOCKED
Spec/task changes: ...
Completed task IDs: ...
Reopened/open task IDs: ...
Production path proven: ...
Exact verification commands/results: ...
Critical/Major findings: ...
Residual launch gates: ...
Canonical next slice: ...
```

Continue automatically to the next slice when the current slice is green and no owner decision is
required. Feature 003, AI, wallet/top-up and Reseller API remain blocked until Feature 001 closes.
