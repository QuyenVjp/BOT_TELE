# Codex continuation prompt — T158–T160 re-review, then T121/T126

Continue in:

`C:\Users\ADMIN\Documents\Codex\2026-07-16\nghi`

Use Codex only. Apply `using-superpowers`, `harness-work`, Matt Pocock `tdd`,
`karpathy-guidelines`, the project-local Spec Kit skills, and `harness-review` before making any
completion claim.

## Independent review result

`REQUEST_CHANGES` for the submitted completion report. The core T158–T160 implementation is largely
sound and the current host gate is green, but the claimed “APPROVE with 0 Critical/Major” is not yet
supportable because Spec Kit/evidence state is stale, the reported next task contradicts the required
implementation order, and two security boundaries remain too easy to misuse.

Independent verification on the exact current workspace:

- Docker Desktop context `desktop-linux`, server `29.2.1`: healthy.
- Host runtime: Node `20.19.0`, npm `10.8.2`.
- `npm run typecheck`: PASS.
- `npm run lint`: PASS.
- `npm run format:check`: PASS.
- `npm run secret-scan`: PASS.
- `npm run build`: PASS; three migrations copied.
- `npm audit --omit=dev`: PASS; zero production vulnerabilities.
- `npm test -- --reporter=dot`: **355/355 tests, 67/67 files PASS**.
- Independent observed load evidence: catalog p95 `9.3ms`, paid-to-delivery p95 `117.8ms`, checkout
  contention p95 `671.9ms`, pool occupancy `10/10`, 12 typed `CONTENTION_TIMEOUT` outcomes.
- `.git` remains invalid; no evidence is bound to a commit SHA or CI run.
- This review did not independently rerun the Node 24 container lane. Preserve its existing local
  evidence, but do not present it as independently re-proven by this review.

Confirmed good in the current code:

- Order and live Payment Intent creation use non-aborting `ON CONFLICT DO NOTHING RETURNING` flows.
- Same-key request-fingerprint mismatch fails closed.
- Two-connection duplicate Buy Now does not create a second Order, reservation, intent, or
  `BUY_NOW` transition.
- Buy Now callback HMAC binds action/version/key-version, Telegram numeric identity, variant, price,
  nonce, and expiry; verification uses strict length/format checks and `timingSafeEqual`.
- The callback property lane covers the Telegram 64-byte limit.
- Delivered history includes `DELIVERED|COMPROMISED|REVOKED`; fulfillment re-entry remains limited to
  `RESERVED|READY`.
- Stock-policy predicates and stock-outcome copies are centralized.

## Mandatory corrections before starting another implementation task

### 1. Synchronize Spec Kit and review evidence

The following current statements are false after checking T158–T160:

- `analysis.md` says T158–T160 remain untouched and the workflow stops before T158.
- `traceability.md` says T158 has not started and only records 333 tests / 64 files.
- `review.md` says work stops before T158 and only records the T154–T157 checkpoint.
- Historical comments/sections in `tasks.md` and `phase9-remediation.md` still say T158–T160 are not
  started. A later section supersedes some of them, but the historical boundary must be labelled
  unambiguously so a reader cannot treat it as current status.

Update `analysis.md`, `traceability.md`, and `review.md` with a dated superseding T158–T160 section:

- 129 checked / 42 open / 171 task rows;
- current 355 tests / 67 files result;
- T158–T160 complete locally;
- current independent review findings and remaining `REQUEST_CHANGES` status;
- host/container/SHA provenance kept distinct;
- no “production ready”, “pilot ready”, or Feature 001 approval language.

Then run `$speckit-analyze`. It cannot honestly report zero High while these cross-artifact status
contradictions remain.

### 2. Correct the canonical next task

The submitted report says the next task is T161. This contradicts the required implementation order
in `tasks.md:533–540` and `plan.md:226–228`.

The next slice is:

1. **T121** — failing durable Telegram inbox and distributed per-user/per-action rate-limit tests.
2. **T126** — asynchronous PostgreSQL inbox plus atomic Redis/PostgreSQL rate limiter and safe retry
   states.

Only after T121/T126 come T122/T127, payment evidence hardening, T125/T129, and then T161/T162.
Do not skip runtime ingress to work on outbox fencing merely because T161 is numerically next.

### 3. Close the unsigned checkout orchestration seam

`CheckoutCallbacks` still publicly exposes both:

- `buyNowFromCallback`, which verifies the signed Telegram-bound callback and resolves customer
  identity authoritatively; and
- `buyNow`, which accepts a caller-provided `customerId`, price, and idempotency key.

Only tests currently call the direct method, but leaving it on the production callback interface
undermines the report’s statement that no caller-controlled internal customer ID can cross the bot
boundary. A future T129 router can accidentally wire the weaker method.

Write a failing boundary test, then:

- remove the direct unsigned `buyNow` method from the exported production `CheckoutCallbacks`
  interface;
- keep the domain `buyNow` command directly testable in the commerce module;
- make the shared checkout orchestration function private to the module, or expose it only through
  an explicitly internal/test-only adapter that cannot be injected into Telegram routing;
- prove every production Telegram Buy Now route reaches callback verification and authoritative
  `telegramUserId -> customerId` resolution first;
- prove a forged internal customer ID is not accepted by any exported bot adapter API.

Do not weaken the signed route merely to preserve old tests; update old checkout tests to exercise
the commerce domain service or the signed route at the correct seam.

### 4. Harden callback-key production configuration

The codec itself is sound, but production config currently validates only HMAC-key length. Add
failing security tests and production hardening so:

- known `.env.example` placeholder values are rejected in `NODE_ENV=production`;
- `BUY_NOW_CALLBACK_HMAC_KEY` cannot equal/reuse Telegram webhook secret, Telegram bot token, SePay
  HMAC secret, delivery signing material, or another configured security domain key;
- callback TTL has a sane explicit upper bound, not merely a positive integer that can fail later
  during token issuance;
- key version and rotation behavior are documented honestly: the current implementation validates
  one active key version and intentionally invalidates old short-lived tokens on rotation; do not
  claim a multi-key verification ring unless one exists;
- diagnostics mention only configuration key names, never values.

Keep these changes surgical. Do not build a speculative vault/key-management subsystem in this
slice.

Rerun the complete 355-test-or-current-equivalent gate after all four corrections. Do not check or
start T121 until the corrected artifacts and source are green.

## T121 — write the failing ingress and abuse-control matrix first

After the correction gate, use `$speckit-analyze` once more. If no unresolved Critical/High remains,
implement T121 test-first in `tests/integration/telegram-ingress-durable.test.ts`.

The RED matrix must use real PostgreSQL Testcontainers and at least two independently constructed app
or worker instances. Cover:

1. A valid Telegram update is acknowledged only after the inbox record commits durably.
2. Database failure before durable insert returns a retryable non-2xx response; Telegram can resend
   the update without losing it.
3. Exact duplicate `(source, update_id, raw_hash)` deliveries produce one business effect and return
   a successful duplicate acknowledgement.
4. Same `(source, update_id)` with a different raw hash is a mutation/security discrepancy, never a
   silent duplicate and never a second business effect.
5. A process crash or handler failure after durable receipt leaves the item retryable; another worker
   can safely reclaim it.
6. A rate-limited update is not lost. The current broken sequence `claim -> 429 -> duplicate 200`
   must be reproduced as RED: the retry must eventually execute once after the budget resets.
7. Two instances consuming the same due inbox row cannot execute the business handler concurrently.
8. A stale owner after lease expiry cannot mark a newer owner’s work processed/failed.
9. Retry state has bounded exponential backoff/jitter, attempt budget, terminal `DEAD`, and
   inspectable `last_error_code` without raw payload/PII leakage.
10. Per-user/per-action limits isolate users and actions: button spam does not block another customer;
    catalog browsing, Buy Now, payment check, support, and paid-Order recovery can have separate
    budgets.
11. Paid-Order recovery and support retain an authenticated bounded route under abuse controls; a
    global limiter cannot lock a legitimate buyer out of recovering a paid order.
12. Anonymous/malformed/bot-origin updates receive bounded safe handling and cannot create unbounded
    principal keys.
13. Numeric Telegram identity, private-chat policy, update ID bounds, body limits, and secret-header
    validation are tested at the HTTP seam.
14. Telemetry records safe counters/latency/backlog/oldest-age/retry/dead outcomes without callback
    token, message text, Telegram secret, or customer data.

Capture the RED evidence before implementing T126.

## T126 — durable inbox and distributed rate limiter

Implement only after the T121 RED matrix exists.

### Spec/data-model clarification required before code

The existing `webhook_inbox` table stores a hash and status but no replayable command/payload, so it
cannot by itself support asynchronous processing. Also, migration 001 uses
`PENDING|PROCESSING|PROCESSED|FAILED|DEAD`, while `data-model.md` says
`RECEIVED|PROCESSING|PROCESSED|RETRY|DEAD`.

Resolve this explicitly in Spec Kit before implementation:

- define one canonical state vocabulary and transition table;
- define exactly what durable replayable envelope is stored;
- do not persist the entire raw Telegram payload or free-form message text in plaintext, because
  customers may paste credentials or other secrets;
- normalize the verified update at ingress into the smallest allowlisted command envelope needed by
  the dispatcher: numeric actor/chat/message references, action type, opaque signed callback data,
  and redacted/validated command fields;
- for free text needed by search/support, define a bounded redaction/encryption/retention policy
  before persisting it; never assume Telegram text is non-sensitive;
- define retention/deletion for processed/dead inbox data and hashes.

Do not mutate already-applied migration 001 silently. Add a new migration for the inbox claim/replay
fields and update future migration filenames/numbers in `tasks.md` before coding so the planned
outbox/admin migrations do not collide. Keep migrations append-only and ensure build packaging copies
the new file.

### Required implementation behavior

- Replace the synchronous boolean `UpdateInbox.claim()` contract with an async durable repository
  API.
- HTTP path: verify Telegram secret, parse/validate bounded update, normalize safe envelope, insert
  with `ON CONFLICT` semantics, then acknowledge quickly.
- Duplicate same-hash event: 200 and no re-execution.
- Hash mutation: owned security discrepancy/telemetry; never silently overwrite the original.
- DB/unavailable durability failure: retryable non-2xx so Telegram retries.
- Worker claim: bounded `FOR UPDATE SKIP LOCKED` selection with owner + generation/lease fencing,
  `next_attempt_at`, and deterministic ordering.
- Ack/fail predicates include row ID, owner, and generation. Stale owners affect zero rows.
- Handler failure and throttle defer the durable row; they do not permanently consume it.
- Use server/database time for lease and retry decisions where possible.
- Add backlog count, oldest due age, attempt count, throttled count, dead count, and handler latency
  telemetry.
- The ingress path must not wait on slow business handlers.

For rate limiting:

- provide an atomic distributed implementation, preferably Redis Lua for ephemeral budgets with a
  tested PostgreSQL fallback where required by the approved plan;
- key by normalized numeric user + allowlisted action, never username or raw callback data;
- use bounded key cardinality and TTL;
- return typed retry-after information;
- define fail-open/fail-closed policy per action. High-risk mutations fail closed; authenticated
  paid-Order recovery retains a restricted fallback path;
- no in-memory limiter or permissive default may be reachable in production;
- local test adapters remain explicit and production config rejects them.

### Scope boundary

- Do not implement SePay T122/T127 yet.
- Do not pull full T129 callback adoption into this slice.
- Do not implement outbox T161/T162 yet.
- Do not claim exactly-once delivery; claim durable at-least-once processing plus idempotent business
  effects and fenced inbox ownership only.

## Completion gate

Before checking T121/T126:

- show RED then GREEN evidence for the durable ingress matrix;
- run typecheck, lint, format, secret scan, build, production audit, full suite, and Node 24 target
  lane;
- run concurrency/retry tests repeatedly to expose timing failures;
- prove the built artifact packages every new migration;
- update `tasks.md`, `analysis.md`, `traceability.md`, `review.md`, and remediation evidence with exact
  current counts and honest provenance;
- keep Feature 001 `REQUEST_CHANGES`;
- stop for independent review before T122/T127.

Do not claim runtime readiness merely because the webhook returns 200. The acceptance bar is durable
receipt, safe retry after crash/throttle, distributed abuse control, and no dropped paid-customer
recovery path.
