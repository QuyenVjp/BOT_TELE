# Codex continuation prompt — recover after app crash

Continue work in:

`C:\Users\ADMIN\Documents\Codex\2026-07-16\nghi`

Use Codex only. Follow the project-local Spec Kit artifacts as feature truth and use the smallest
matching workflow skills: `using-superpowers`, `harness-work`, Matt Pocock `tdd`,
`karpathy-guidelines`, `speckit-analyze`, `speckit-implement`, then `requesting-code-review` /
`harness-review` before claiming the slice complete.

## Recovery checkpoint

The previous Codex app crashed after writing the final remediation artifacts at approximately
2026-07-17 09:00 local time. Preserve all existing files; do not revert or regenerate unrelated
work.

Current recorded progress:

- T154–T157 are checked after the remediation run.
- T158–T160 have not started and remain unchecked.
- Raw task status is 126 checked / 45 open / 171 task rows. Historical superseded pointers no
  longer inflate the count.
- Existing evidence records a final-source run of 333 tests / 64 files on the Windows host and a
  Node 24.18.0 container, plus static/build/production-audit gates.
- Feature 001 remains `REQUEST_CHANGES`; `.git` is invalid, so no result is SHA-bound CI evidence.

Independent post-crash verification performed after those writes:

- `npm run typecheck`: PASS.
- `npm run format:check`: PASS.
- `npm run lint`: PASS.
- `npm run secret-scan`: PASS.
- `npm run build`: PASS; three migrations copied.
- `npm audit --omit=dev`: PASS, zero production vulnerabilities.
- Full audit still reports 1 high + 3 moderate through the dev-only
  `testcontainers -> dockerode/undici/uuid` chain.
- A new full `npm test -- --reporter=dot` could not reproduce the container suites because Docker
  Desktop stopped during/after the app crash. The current Docker context is `desktop-linux`, but
  `npipe:////./pipe/dockerDesktopLinuxEngine` is missing. The run produced 188 passing pure tests;
  28 suites failed during Testcontainers runtime discovery and 145 tests were not executed. These
  are environment/setup failures, not assertion failures. Do not replace the earlier 333/64
  evidence with a fake code failure, but do not claim a fresh green run until Docker is restored and
  the exact final source is rerun.

## Reviewer corrections before T158

Make these small, test-first corrections before starting the idempotency slice.

### 1. Delivered history must include terminal credential states

`findDeliveredAssetHistoryForOrder` currently requires `status = 'DELIVERED'`. The documented asset
state machine allows `DELIVERED -> COMPROMISED | REVOKED`, precisely the states that commonly trigger
an account replacement. A compromised or revoked delivered credential must not disappear from
replacement history.

Write failing PostgreSQL tests first, then update the deterministic history query so:

- the original asset is selected by `delivered_order_id`;
- eligible historical states include `DELIVERED`, `COMPROMISED`, and `REVOKED` unless the canonical
  state model proves a narrower set;
- an Order containing an old compromised/revoked delivered asset plus a new active replacement hold
  links `replacement_case.original_asset_id` to the original historical asset;
- fulfillment re-entry still selects only the active `RESERVED|READY` hold;
- selection is deterministic and does not depend on row order.

Update the Spec Kit data model/contract only if the current normative text does not already express
this invariant. Do not weaken the state machine to fit the query.

### 2. Centralize repeated domain constants and static presenter maps

The previous owner instruction explicitly requires constants and reusable domain logic to live in
one authoritative place.

- Remove the duplicate untyped `LOCAL_STOCK_POLICIES` Sets from `buy-now.ts` and
  `payments/service.ts`.
- Create one typed stock-policy predicate/allowlist in the appropriate domain module and reuse it in
  Buy Now, payment presentation, catalog repository/search, and any presenter policy decision.
- Keep the distinction explicit between `isFeature001SellablePolicy` and
  `requiresLocalReservation`; do not create one vague helper that hides different rules.
- Move the `Record<StockOutcomeCode, string>` currently allocated inside `presentStockOutcome` to a
  module-level immutable constant.
- Reuse the existing exported `StockOutcomeCode`/predicate instead of redeclaring equivalent string
  unions.
- Do not move user-facing Telegram emoji out of copy constants merely to remove emoji; the goal is
  to eliminate scattered literals and repeated allocation, not damage Vietnamese UX.

Add focused contract tests proving all policy values fail closed and all stock outcome codes have
exactly one presenter copy.

### 3. Restore the runtime gate honestly

- Restore/start Docker Desktop only through the normal host workflow; do not kill unrelated ports or
  processes.
- Confirm `docker info` and one real Testcontainers PostgreSQL probe before running the full suite.
- Run the exact final source under the required Node 24 lane as well as the host lane if the host is
  still Node 20.19.0.
- If Docker cannot be restored, leave all container-gated claims explicitly unverified in this
  resumed session. Do not mark the task complete from skipped tests.
- Do not run `npm audit fix --force`; the suggested Testcontainers 12 upgrade is breaking and belongs
  in its own tested dependency slice.

After these corrections, rerun:

```text
npm run typecheck
npm run lint
npm run format:check
npm run secret-scan
npm run build
npm test -- --reporter=dot
npm audit --omit=dev
```

Append exact current counts and environment facts to the evidence. Never overwrite older evidence as
if it were produced by the resumed run.

## Implement T158–T160 in required order

Only proceed when the correction gate above is green or explicitly environment-blocked without a
code failure.

### T158 — failing tests first

Create/strengthen `tests/integration/buy-now-idempotency.test.ts` and codec contract/property tests.
They must prove with real two-connection PostgreSQL concurrency:

1. Two simultaneous Buy Now calls by the same customer with the same verified checkout nonce produce
   exactly one Order, one active reservation, and one live Payment Intent.
2. Both callers receive the same Order and payment presentation; neither caller receives an aborted
   transaction error.
3. The losing transaction never queries after PostgreSQL has entered `25P02` aborted state.
4. Same nonce with a different request fingerprint (customer, variant, expected price, or action)
   fails closed as a conflict/tamper case; it must not silently return an unrelated Order.
5. Different valid nonces remain independent.
6. Rapid payment presentation calls still produce one active intent and identical transfer content.
7. Tampered, expired, wrong-action, wrong-user, and malformed callback payloads create no Order,
   reservation, Payment Intent, or QR.
8. Every encoded Telegram callback is 1–64 UTF-8 bytes; add boundary/property coverage rather than
   checking only one sample.

Capture the RED evidence before implementation as required by the test-first constitution.

### T159 — conflict-safe winner read

Remove both current query-after-unique-violation paths:

- `src/modules/commerce/repository.ts::insertOrder` catches `23505` then queries inside the aborted
  transaction.
- `src/modules/payments/service.ts::presentPaymentForOrder` catches a live-intent `23505` then queries
  inside the aborted transaction.

Implement `INSERT ... ON CONFLICT DO NOTHING RETURNING` or a properly isolated savepoint/winner-read.
Requirements:

- Never continue querying a PostgreSQL transaction after an unhandled statement error aborts it.
- Identify the exact conflict target/business key; do not swallow unrelated uniqueness violations
  such as order number or transfer-content collisions.
- For Order idempotency, bind the key to a canonical request fingerprint. Replaying the same key with
  different customer/variant/price semantics must fail closed.
- Winner-read must be bounded and deterministic. Account for the case where the winning transaction
  has not committed yet; do not spin forever or return a false not-found.
- Reservation and Order creation remain atomic. A loser must not reserve a second asset for the
  winner Order.
- Payment Intent creation must return the winning live intent without generating a second transfer
  content or QR.
- Preserve append-only transition/audit behavior: the losing idempotent call must not create a second
  `BUY_NOW` transition.

Keep SQL in repository functions. Do not spread raw conflict SQL across bot handlers.

### T160 — stable signed Buy Now callback nonce

Create `src/bot/callback-codec.ts` (it does not currently exist) and carry the verified result through
catalog presentation/Telegram dispatch into `createCheckoutCallbacks`.

Security and UX contract:

- Version the payload and action.
- Use an HMAC key from validated configuration; never hard-code it or reuse the Telegram bot token,
  SePay secret, AI key, delivery signing key, or admin confirmation secret.
- Bind the signature to the numeric Telegram customer ID, variant ID, authoritative expected price,
  nonce, action, and expiry. If the user ID is not serialized due to the 64-byte limit, it must still
  be part of the HMAC input at sign/verify time.
- Verify signature with constant-time comparison after strict length/format validation.
- Enforce expiry and bounded clock skew.
- Derive the Order idempotency key deterministically from the verified, domain-separated nonce and
  customer identity. Do not use `input.idempotencyKey ?? newId()` in the handler.
- Make `BuyNowCallbackInput.idempotencyKey` required at the domain-handler boundary, or accept a
  branded verified callback object instead of a forgeable optional string.
- Ensure callback data is at most Telegram's 64-byte UTF-8 limit for real maximum-length IDs.
- Do not log the HMAC key, full signature, raw callback token, or secrets.
- Support key versioning/rotation in the format without implementing speculative multi-key
  infrastructure beyond what configuration needs now.
- Return one safe Vietnamese retry/reopen message for expired callbacks; never expose verification
  internals.

Avoid a stateful in-memory nonce map: it would break across restarts and replicas. If the chosen
design requires server-side nonce state, it must be durable and explicitly added to the Spec Kit
data model/tasks before implementation. Prefer the smallest stateless signed codec that satisfies
the Telegram byte limit and replay/idempotency contract.

## Completion gate for this slice

Before checking T158–T160:

- Run `$speckit-analyze` and confirm no unresolved Critical/High cross-artifact issue.
- Run all static/build/security gates and the complete 64-file-or-current-equivalent suite on final
  source.
- Run the two-connection concurrency tests repeatedly enough to expose timing failures.
- Run Node 24 verification; Node 20 host output alone is not target-runtime proof.
- Keep Feature 001 as `REQUEST_CHANGES` because T121–T153 and T161–T174 still contain open work.
- Keep `.git`/CI/SHA limitations explicit.
- Do not start T121 or any later slice.
- Stop and report: exact files changed, RED then GREEN evidence, exact counts, contention behavior,
  callback maximum byte length, unresolved risks, and the next canonical task.

Do not claim “all complete”, “pilot ready”, “exactly once”, or “production ready”.
