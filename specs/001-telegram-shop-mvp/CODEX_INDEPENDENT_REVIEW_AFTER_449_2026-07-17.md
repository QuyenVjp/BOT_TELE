# Independent review after current 449-test snapshot — REQUEST_CHANGES

**Date**: 2026-07-17  
**Scope**: current full workspace snapshot; no valid Git base/diff is available  
**Team review mode**: three read-only passes — Security/Delivery, Runtime/Adapters,
Spec/Regression — plus primary-agent verification  
**Verdict**: `REQUEST_CHANGES`

## Verification on the final stable snapshot

The workspace changed during the first review pass because another process was still implementing
the SePay durable inbox. Review was restarted after source file timestamps stayed unchanged for 30
seconds.

Final local verification:

| Gate | Result |
|---|---|
| Typecheck | PASS |
| Lint | PASS |
| Format check | PASS |
| Secret scan | PASS |
| Build | PASS — 8 migrations copied |
| Production dependency audit | PASS — 0 vulnerabilities |
| Full host suite | PASS — 449/449 tests, 83/83 files |
| Git/hosted CI provenance | FAIL — `.git` is invalid; no SHA or hosted run |

The previous 447-test/7-migration claim is superseded by this 449-test/8-migration snapshot.

Task ledger currently reports 153 checked / 18 open / 171 total. That count is mechanically
correct but no longer fully truthful: new SePay async-inbox code has no corresponding tasks/evidence,
and T148 plus T171/T172 need reopening.

## Critical findings

### C1 — Delivery route trusts caller-supplied customer identity

`src/modules/digital-goods/delivery-route.ts` still reads `x-customer-id` directly from the public
HTTP request and passes it to the reveal command. There is no signed Telegram-bound session or
trusted authentication middleware. The current tests only prove that a random wrong ID fails; they
do not prove that an attacker cannot submit the real owner ID.

Required correction:

- remove the public caller-controlled identity header;
- use a short-lived signed delivery session bound to Telegram numeric identity, Delivery Bundle,
  audience, expiry and nonce, or an equivalent authenticated Telegram-bound middleware;
- verify signature, expiry, audience, ownership and replay before revealing;
- add BOLA/tamper/replay/concurrent-reveal tests.

This blocks any production credential delivery.

### C2 — A fresh Telegram user cannot become a customer and buy

The production worker only queries an existing `channel_identity`; there is no runtime upsert for a
new Telegram user. Tests seed or mock the identity resolver, hiding the failure. There is also
channel-case drift: the worker queries `TELEGRAM`, while test fixtures commonly store `telegram`,
and the schema does not enforce a canonical value.

Consequences:

- new customers receive an identity resolution failure instead of being onboarded;
- a fresh root-admin deployment can fail to construct admin callbacks;
- concurrent `/start` or first-message updates can race if onboarding is added without a unique,
  transactional upsert.

Required correction:

- atomic customer + channel-identity upsert keyed by numeric Telegram user ID;
- canonical channel constant and DB constraint/migration;
- username stored as mutable metadata only, never authorization;
- concurrent first-contact and fresh-root-admin acceptance tests using the real SQL resolver.

### C3 — T171/T172 rejects the real SePay/VietQR account relationship

The current environment schema rejects
`SEPAY_MERCHANT_ACCOUNT_ID === VIETQR_ACCOUNT_NUMBER`. That confuses separation of configuration
keys with forced inequality of their values.

For the pilot, the VietQR beneficiary account and SePay webhook `accountNumber` can legitimately be
the same bank account. `sepay-ingress.ts` maps payload `accountNumber` to merchant identity and the
payment matcher compares it exactly. If operators invent a different merchant value merely to pass
validation, every real payment becomes `WRONG_ACCOUNT`.

Required correction:

- keep the two configuration keys semantically separate;
- validate each independently but allow equal values;
- reopen T171/T172;
- add an end-to-end official-shaped SePay test with equal merchant/beneficiary account values,
  through verifier → durable inbox → worker → matcher;
- keep a distinct-value test for deployments that use VA/sub-account mapping.

## Major findings

### M1 — New async SePay inbox is untracked and has integrity gaps

The old “SePay settlement is synchronous” finding is now stale. Current source verifies the webhook,
persists a PostgreSQL inbox event, ACKs `{"success":true}`, and processes evidence in the worker.

However:

- task/spec/evidence artifacts do not own this new migration and lifecycle;
- worker reconstruction brands JSON loaded from the DB without verifying that
  `claim.sourceEventId === evidence.providerTransactionId` and
  `claim.rawHash === evidence.rawHash`;
- the persisted envelope is not revalidated before restoring the verified trust brand;
- duplicate-mutation update and discrepancy creation are separate autocommit statements, so a crash
  can lose the alert or create repeated discrepancy rows;
- contract tests largely use a fake inbox and do not prove PostgreSQL crash/restart/lease recovery.

Required correction:

- add explicit Spec Kit tasks for the async SePay lifecycle;
- validate/hash-bind the persisted envelope before rebranding;
- make mutation accounting + security discrepancy atomic and idempotent;
- add real PostgreSQL tests for durable accept, quick ACK, restart, fenced claim, retry, dead-letter,
  identical duplicate and mutated duplicate;
- synchronize analysis, traceability, review and evidence.

### M2 — Delivery notification can permanently strand a paid customer

The one-time token exists only when a bundle is first created. Re-entering issuance returns an empty
token. The worker currently has no Telegram notifier, and the handler can publish the event without
sending a message. If a future notifier throws after the first token is created, retry sees the
existing bundle with an empty token and silently skips the send. The dormant notifier path also uses
`orderId` as `customerId`.

Required correction:

- T145 must create a durable notification/capability handoff, not retain the token only on the call
  stack;
- bind recipient to the real customer/channel identity;
- ambiguous Telegram sends, crash-after-send, 429/retry-after and multi-worker replay must be
  idempotent;
- never put raw credentials in Telegram or outbox.

### M3 — Production vault is intentionally unavailable

Production forbids the memory vault, while the external vault branch always throws and has no
health/readiness implementation. `/ready` only checks PostgreSQL.

T136/T142 remain valid blockers. Production must have a real approved vault adapter, namespaced
references, fail-closed health check, timeout/retry policy, redaction and startup/readiness proof.

### M4 — Supplier resale is not wired

`SUPPLIER_DRIVER=http` currently leaves `supplier = null`. There is no HTTP adapter and fulfillment
does not invoke the SupplierPort when local stock is unavailable. The port is also incomplete for
cancel/refund/reconcile.

Required correction:

- production config must require HTTPS supplier base URL and token when the HTTP driver is chosen;
- implement contract-tested authenticated HTTP adapter;
- integrate supplier availability/create/query/cancel/refund/reconcile with timeout `UNKNOWN`,
  query-before-retry and idempotency;
- connect supplier fulfillment transactionally to asset ingestion, outbox and delivery.

### M5 — T148 is false-green; QR image/photo does not exist

T148 claims QR-image/golden-vector tests but current tests only exercise text presentation and a
self-round-trip parser. There is no independent fixed official payload/CRC vector, PNG/image output,
scan verification, `sendPhoto`, `editMessageMedia`, retry-after or Telegram media fallback.

Required correction:

- reopen T148;
- implement T149/T150 with an actual image renderer and independent official-shaped vector;
- verify MB alias/BIN, URL encoding, exact amount/content, image type and scanability;
- use send/edit/photo paths with delivery dedupe and 429 handling.

### M6 — Telegram responder can spam duplicates

The responder always sends a new message, ignores the supplied message ID, has no send ledger or
dedupe key, and does not distinguish ambiguous network failure from a confirmed Telegram rejection.
If the worker crashes after Telegram accepts the message but before inbox completion, reclaim can
send it again.

T139/T145/T150 must cover edit-in-place, ambiguous send, callback answer failure, 429,
crash-after-send and multi-worker duplicate suppression.

### M7 — T115/T118 are only partial

T118 is no longer a no-op: main uses a durable Telegram inbox and worker has a real domain
dispatcher/grammY API. Do not redo that working slice.

It is still incomplete because:

- identity onboarding is mocked/absent;
- production notifier/vault/supplier/QR adapters are missing;
- the compiled entrypoint test only proves that a module loads and fails invalid config, not that
  main listens, health/ready work, the worker stays alive, or the two processes complete a real
  customer journey.

Update stale T118 comments, then close T115/T118 only with compiled main + worker acceptance.

### M8 — T174 still permits false local pass/skip

The Docker probe catches broad Testcontainers errors and returns unavailable, so runtime discovery,
permission or socket/API mismatches can become skipped suites. `migrate-prod.test.ts` returns early
when Docker is unavailable and is reported as passed rather than skipped.

CI `docker info` reduces hosted risk but does not make local evidence truthful. Reopen or correct
T174 so only a proven daemon-unavailable condition skips, while a started-container or harness error
fails.

### M9 — Feature migration numbering is stale

Current source has `008_sepay_inbox_security.sql`, while later feature tasks still plan migration
prefixes that collide or sort before the current history. Before Feature 003 or AI begins, assign
monotonic prefixes after 008 according to the chosen implementation order.

### M10 — Runnable local configuration is still incomplete

The local environment has no `BUY_NOW_CALLBACK_HMAC_KEY` and no `VIETQR_BANK_NAME`. The current
schema requires both, so loading `.env` fails before main/worker can listen unless the process
environment injects them separately.

Generate and inject a rotated unique key through the secret manager/local ignored env. Do not copy a
bot, SePay, vault, supplier or AI key and do not commit the value. Add the validated bank display
name through the same ignored deployment configuration; it is display metadata, not payment truth.

## CI/evidence disposition

- T151 workflow structure is materially improved and may remain checked as workflow implementation.
- T151 is not hosted-CI proof; T152 remains open.
- CI currently runs the security suite in both the unit group and a security lane, producing
  duplicate work/JUnit evidence; clean this up when stabilizing CI.
- T173 compiled migration path exists and current build succeeds.
- T152 cannot close until valid Git history, rotated credentials, hosted CI and SHA-bound evidence.
- T153 cannot close until a fresh independent review finds zero Critical/High.

## Canonical next order

1. Gate 0: synchronize Spec Kit truth; reopen T148, T171/T172 and the unresolved T174 scope; add
   tasks for async SePay inbox and Telegram identity onboarding; fix later-feature migration numbers.
2. Correct merchant/beneficiary semantics and harden async SePay inbox with real PostgreSQL tests.
3. Implement atomic Telegram customer/channel onboarding and canonical channel values.
4. Implement signed Telegram-bound delivery authentication.
5. Implement durable notification capability handoff and idempotent Telegram send/edit/photo.
6. Implement external vault + readiness.
7. Implement HTTP supplier adapter + supplier fulfillment orchestration.
8. Implement independent QR image/golden-vector path.
9. Complete compiled main+worker acceptance and close T115/T118.
10. Restore Git/hosted CI/SHA evidence, rotate exposed credentials, then run final T153 review.

Do not begin Feature 003, AI, wallet/top-up or Reseller API until Feature 001 has zero unresolved
Critical/Major and release evidence is bound to a valid source snapshot.
