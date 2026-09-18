# SECURITY_HARDENING — implemented controls, remaining risk, operations

Companion to [`THREAT_MODEL.md`](./THREAT_MODEL.md). This file states what is
**implemented** (code + test), what is **statically verified**, and what is
**not verified** in this environment. A control is only listed as implemented
when a test exercises it.

Scope of this pass: branch `release/wallet-broadcast-acceptance`.

---

## 1. Implemented controls

### SEC-002 — Ledger integrity (double-entry)

`063_double_entry_ledger.sql`, `src/modules/wallet/ledger.ts`.

`wallet_ledger` remains the customer-facing movement list and the historical
idempotency scope. Underneath it, every movement now also writes an immutable,
balanced posting set:

| Table                    | Role                                                                      |
| ------------------------ | ------------------------------------------------------------------------- |
| `ledger_account`         | Chart of accounts: 5 system accounts + one `LIABILITY` account per wallet |
| `ledger_transaction`     | One business event; **globally unique** `idempotency_key`                 |
| `ledger_posting`         | Immutable DEBIT/CREDIT legs, `amount_minor` bigint (exact minor units)    |
| `ledger_account_balance` | Derived view; the postings, not the view, are authoritative               |

Enforced in the database, not only in TypeScript:

- a deferred constraint trigger refuses any commit where `SUM(DEBIT) ≠ SUM(CREDIT)` per transaction;
- a second deferred trigger refuses any commit where `wallet_account.balance_vnd` disagrees with the ledger — so the cached balance cannot drift, including via a direct `UPDATE`;
- postings and transactions are append-only (`before update or delete` triggers raise);
- an account may appear at most once per side per transaction.

Corrections are new compensating transactions. History is never edited.

Movement mapping (`planLedgerMovement`) is pure and unit-tested:

| Movement (idempotency-key prefix) | Counter-account                    |
| --------------------------------- | ---------------------------------- |
| `topup:` credit                   | `EXTERNAL:BANK_SETTLEMENT` (DEBIT) |
| `purchase:` debit                 | `SHOP:REVENUE` (CREDIT)            |
| `refund:` credit                  | `SHOP:REFUND_EXPENSE` (DEBIT)      |
| other credit                      | `SHOP:ADJUSTMENT_EXPENSE` (DEBIT)  |
| other debit                       | `SHOP:ADJUSTMENT_INCOME` (CREDIT)  |

Tests: `tests/integration/wallet-double-entry.test.ts` (10) — balanced-set
assertions, idempotent replay, unbalanced commit refused, cache-drift commit
refused, append-only, 100 concurrent debits cannot overspend, randomised
balanced-ledger invariant over 120 movements, and a backfill test that builds a
pre-063 schema with representative single-entry history and applies the real
runner.

### SEC-001 / SEC-005 — Payment evidence and replay

Already present and **unchanged**, verified by existing suites:
raw-body HMAC-SHA256 with constant-time compare, bounded timestamp window,
allowlisted schema parsed only after the signature passes, transport IP
allowlist read only through a trusted proxy, durable `webhook_inbox` keyed by
`(source, source_event_id)` with a raw-hash collision detector that raises a
`REFERENCE_COLLISION` discrepancy, and a worker that never settles from the
ingress path.

### SEC-006 — SSRF

`src/infrastructure/net/outbound-policy.ts` (new). Every outbound request
resolves the hostname and classifies **each** resolved address before a socket
opens: loopback, RFC1918, link-local, multicast, unspecified, cloud metadata
(`169.254.169.254`, `fd00:ec2::254`), CGNAT, documentation and benchmark ranges,
and IPv4-mapped IPv6 are all refused. `https:` only, no credentials in the URL,
port allowlist, `redirect: "error"`, re-resolution per attempt.

Wired into every configurable outbound target: Telegram file downloads,
SePay API, supplier HTTP, and external vault. The transport supplies the exact
approved A/AAAA address to the real Node socket lookup, preserves TLS SNI and
hostname verification, rejects redirects, and re-resolves/revalidates each
retry.

Tests: `tests/security/outbound-ssrf.test.ts` (81) + `tests/security/outbound-pinning.test.ts` (8) — every named bypass class
including DNS rebinding, mixed public+private answers, alternate IP encodings,
and the loopback test-mode escape hatch.

### SEC-007 / SEC-016 — Admin step-up (TOTP)

`src/modules/identity/step-up.ts`, `064_admin_step_up.sql`, `069_step_up_authorization_binding.sql`.

RFC 6238 TOTP (HMAC-SHA1, 6 digits, 30 s, ±1 step drift) via `node:crypto`
only. The seed is written through the **existing vault boundary** under
namespace `admin-totp`; `admin_step_up_secret` stores only a `vault_ref`. There
is no read path that returns the seed.

- Verification is server-side. Failed attempts are recorded in an append-only
  `admin_step_up_attempt` table, counted over a rolling window, so a restart
  cannot reset the counter; exceeding the limit locks the admin out.
- A successful verification issues a short-lived v2 grant bound to the admin
  numeric id, action key, resource type/id, current resource version, canonical
  requested-data SHA-256, category, and expiry. Migration `069` revokes every
  legacy v1 category-only grant; preview and consume query only live v2 rows.
- `consume` marks the exact grant used under `for update`, so one grant
  authorises exactly one matching mutation, once. The grant is consumed before
  the business transaction and is intentionally not restored if that mutation
  later fails.
- Root admin identity is unchanged: the configured **numeric** Telegram user id
  in a private context. Step-up is additional, never a replacement, and adds no
  new way to become admin.

Tests: `tests/security/admin-step-up.test.ts` (11, incl. all six RFC 6238
Appendix B vectors and a "no exported result contains the seed" sweep) and
`tests/integration/admin-step-up.test.ts` (10) — lockout across service
instances, single-use grant, category binding, expiry, append-only attempts.

Production policy is explicit: `ADMIN_STEP_UP_MODE=required` keeps the external
Vault-backed factor and the preflight factor probe; `ADMIN_STEP_UP_MODE=disabled`
skips only TOTP enrollment/verification, attempts, and grants. In disabled mode,
the numeric private-chat root-admin check, durable expiring confirmation, exact
action/resource/version binding, idempotency, replay/stale checks, and audit remain
mandatory. Existing factor and recovery rows are retained and inert until the
mode is changed back to `required`.

### SEC-007 — Privileged admin authorization (one gate, actually wired)

`src/modules/identity/sensitive-action.ts` (new) + `src/bot/callbacks/admin.ts` +
`src/worker.ts`.

There is exactly **one** place a sensitive admin action is authorised:
`authorizeSensitiveAdminAction`. The order is mandatory and fail-closed:

1. numeric root identity through the existing `authorizeRootAction` (wrong id and
   wrong chat context both refuse as `NOT_ROOT_ADMIN`, so the refusal leaks
   nothing);
2. resolve the step-up category for the action key from the declarative
   `SENSITIVE_ACTION_POLICY` table;
3. re-read the authoritative resource and requested values, then derive the
   current resource version and canonical payload hash;
4. **preview step** (`handle()`): prove a live, unconsumed, unexpired v2 grant
   exists for this exact binding, without spending it — then, and only then,
   mint the durable confirmation;
5. **mutating step** (`confirm()`): consume that exact grant immediately before
   the mutation. A refusal throws before the mutation, so an unverified or stale
   mutation is impossible. Consumption is fail-closed and is not rolled back
   with the business write.

The policy table covers `wallet.refund`, `manual_fulfillment.complete`,
`support.replacement.approve`, `warranty.refund.approve`,
`warranty.refund.adjust` (→ `REFUND`), `warranty.replacement.approve`
(→ `DELIVERY_REISSUE`), `discrepancy.resolve`
(→ `PAYMENT_OVERRIDE`), `store.open`, `store.close`, `catalog.activate`,
`catalog.deactivate` (→ `PERMISSION_CHANGE`), the price/deposit/commercial
variant changes (→ `BULK_PRICE_CHANGE`), inventory stock adjustment
(→ `STOCK_ADJUSTMENT`), the three `supplier.mapping.*` verbs
(→ `SUPPLIER_CONFIG`), `preorder.cancel` (→ `REFUND`), and
`broadcast.confirm` (→ `BROADCAST`).

Telegram is not an MFA channel: production `/enroll_2fa` and `/verify` are
refused without revealing a seed, URI, or OTP. The separate `npm run
admin:step-up` operator CLI reads the TOTP only from a hidden TTY prompt and
prints the enrollment URI only to that terminal. The CLI verifies a grant
against the latest audited challenge; Telegram can only display the action and
confirm after the server has derived its state.

Tests: `tests/security/sensitive-action-authorization.test.ts` (6) and
`tests/integration/admin-step-up-gating.test.ts` (14). The load-bearing assertion
in every refusal is the **absence of the business side effect** — the ledger, the
order status and `notification_delivery` are compared before and after. Covered:
no grant, wrong TOTP, correct TOTP → executes exactly once, wrong-category grant,
expired grant, sequential reuse, **concurrent reuse of one grant via
`Promise.all` against real PostgreSQL** (at most one mutation), a grant bound to a
different admin, and the mutation throwing after authorisation (grant stays
consumed — consumed-but-not-mutated, the fail-closed direction).

`tests/security/privileged-verb-gating.test.ts` (8) is the regression guard: every
verb in `OWNER_COMMANDS` must be either in the policy table or in an explicit
low-risk allowlist, so adding a privileged verb without a gate fails the build.

**A redundant signed admin callback codec (`adm:`) was removed.** An independent
audit found it had zero production callers. The live admin callbacks are already
gated by stronger controls — Telegram guarantees `callback_query.from.id` is
authentic and the actor id is never read from the payload, every handler runs the
numeric-id root gate, high-risk verbs require the durable expiring confirmation,
and the money/audience verbs now require step-up. Keeping a second, unproven
signing scheme would have been a third mechanism to keep correct, so it was
deleted rather than left dead; the regression test above fails if it reappears.

### SEC-007 — Broadcast confirmation

`src/modules/notification/service.ts`, `065_broadcast_confirmation.sql`.

`confirmBroadcast` is a single fail-closed path: campaign exists → owned by this
admin → still `DRAFT` → was previewed → content still hashes to the previewed
content → the frozen preview audience still matches the live audience → large
audience respects a cooldown → then deliveries are materialised from the **frozen
set**, with the `CONFIRMED` snapshot written in the same transaction.

- `notification_campaign_audience` freezes and identifies the recipient set; it
  is append-only once confirmed.
- A large/global send is rate limited by `broadcast_throttle`, so a mistyped or
  malicious broadcast cannot be repeated immediately at scale.
- Confirmation and cancellation append audit events carrying the revision,
  audience count and audience hash — never message content in raw form.
- `enqueueBroadcastRecipients` remains for existing callers and now also freezes
  the snapshot, so the invariant holds on both paths.

Execution is additionally behind the sensitive-action layer: `marketing:confirm:`
now runs the audited root gate and then spends a live `BROADCAST` grant before
calling `confirmBroadcast`, so a stale preview is refused by the campaign check
AND an unverified send never reaches it. A spoofed actor id is denied and the
denial is audited.

Tests: `tests/integration/broadcast-confirmation.test.ts` (12) — content/audience
binding, stale-preview refusal (both content and audience), idempotent repeat,
ownership, never-previewed, cooldown window, audit payload shape, frozen
audience surviving a later preference change, append-only evidence, empty
audience.

### SEC-008 — Secret redaction

`src/infrastructure/observability/redact.ts` (new) + logger integration.

Path-based pino redaction only catches known keys. The new registry scans
**values**: JSON-serialisable payloads are deep-scrubbed (cycle-safe,
depth-bounded), sensitive key names are matched case-insensitively across
`_`/`-`/camelCase variants, headers are redacted wholesale for
authorization/cookie, and thrown errors are reduced to a log-safe shape without
a `cause` chain.

Tests: `tests/security/secret-redaction.test.ts` plus the pre-existing
`config-redaction`, `telemetry-redaction`, `credential-leak` and
`inbox-error-detail` suites, all green.

### SEC-003 / SEC-004 — BOLA and abuse

Owner-scoped repository functions (`…ForOwner`, 9 of them across commerce,
payments and digital-goods) constrain ownership **in the query** rather than by
a caller-side comparison, and a non-owned object is indistinguishable from a
missing one — same `null`, no throw, no existence oracle.

Rate limiting was **audited, not rebuilt**. The repo already had a durable,
replica-safe token-bucket limiter (`src/modules/risk/service.ts`,
`telegram_rate_limit_bucket` from migration `004`) wired into the Telegram inbox
at `src/infrastructure/inbox/telegram.ts`, so no second limiter was added. The
audit found no ungated reachable action: `TelegramRateLimitAction` has 10 members
and `DEFAULT_TELEGRAM_RATE_LIMIT_POLICIES` is declared
`as const satisfies Record<TelegramRateLimitAction, …>`, which makes a missing
policy a compile error — the gap cannot reopen silently.

Tests: `tests/security/bola-ownership.test.ts` (14) and
`tests/security/rate-limit-coverage.test.ts` (6, including 3× capacity
concurrent spends via `Promise.all` against real PostgreSQL).

**Not done, and deliberately:** the new `…ForOwner` functions are an _additive_
cutover. Existing channel handlers still call the pre-existing
`find*ById` functions and compare ownership themselves. The migration of those
call sites lives in `src/bot/**` and is listed as remaining risk below — a
half-migrated call site would be worse than an honestly listed one.

### SEC-014 — Supply chain

`.github/workflows/ci.yml` now triggers on `release/**` (previously the release
branch ran no CI at all) and every `uses:` is pinned to a verified 40-char
commit SHA with a human-readable version comment. `.github/workflows/security.yml`
adds CodeQL, OSV-Scanner, Gitleaks, CycloneDX SBOM, Trivy (fs, HIGH/CRITICAL,
`ignore-unfixed`) and OpenSSF Scorecard, each with its own least-privilege
permissions block. Semgrep is deliberately omitted as redundant with CodeQL.
`.github/dependabot.yml` covers `npm` and `github-actions`.

See [`CI_SUPPLY_CHAIN.md`](./CI_SUPPLY_CHAIN.md) for the trigger matrix, the pin
refresh procedure and the per-job permission model.

Tests: `tests/security/ci-supply-chain.test.ts` (17), including a
mutation-verified assertion set.

---

## 2. Trust assumptions

- **PostgreSQL is authoritative.** The ledger, not a cache, decides balances.
- **The root admin is one numeric Telegram user id.** Usernames are display
  labels used only for drift alerting; there is no add-admin path.
- **A valid signature is not authorization.** Every signed artifact is followed
  by server-derived permission checks.
- **The vault is the only home for secret material.** TOTP seeds and supplier
  credentials live behind vault references.
- The audience hash and content hash are **integrity identities, not MACs**.
  They detect drift between preview and confirmation; they are not secrets and
  they do not authenticate anything.
- Audit integrity is _append-only_, not tamper-proof against an attacker who
  already holds database superuser. A hash stored beside mutable data does not
  defeat a compromised DBA. We do not claim otherwise.

## 3. Remaining risk (explicit)

| #   | Item                                                                                                                                                                                                                                                                                                  | Severity | Status                                     |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------------------------------------------ |
| 1   | **TOTP is policy-configurable.** Production explicitly selects `required` or the owner-approved `disabled` mode. Disabled mode reduces the second-factor defense but keeps root identity, durable confirmation, binding, idempotency, audit, and all payment-evidence protections.                    | High     | Accepted for current commissioning posture |
| 2   | **Step-up gates the real handlers.** Warranty refunds and broadcast confirm call the layer; every `OWNER_COMMANDS` verb that moves money, permissions, supplier routing or the audience is in the policy table and proven by integration tests that assert the side effect did NOT happen on refusal. | —        | Closed                                     |
| 3   | **BOLA cutover is complete on the customer-facing paths.** Checkout refresh/cancel/reopen, order detail, support, replacement, warranty and preorder payment all resolve ownership inside the query; a foreign object and a missing one are the same refusal.                                         | —        | Closed                                     |
| 4   | SePay's published protocol is followed as implemented; if SePay changes its signing contract, the verifier must be updated in lockstep.                                                                                                                                                               | Medium   | Monitored                                  |

Nothing above is marked implemented without a test. The two remaining risks are
operational, not code-level: a provider contract change, and the repository
settings only the GitHub owner can enable (see `CI_SUPPLY_CHAIN.md`).

## 4. Operations

### TOTP / step-up enrolment and mode

1. For the owner-approved no-TOTP posture, set `ADMIN_STEP_UP_MODE=disabled` explicitly and restart. Preflight does not require a usable factor, but every sensitive action still requires the numeric private-chat root-admin identity and durable confirmation.
   In production disabled mode, `admin:step-up enroll`, `replace`, `verify`, and
   `recover` refuse before factor or database work; existing factor and recovery
   rows are retained.
2. To enforce TOTP, set `ADMIN_STEP_UP_MODE=required` and `VAULT_DRIVER=external`; production preflight then requires a current `vault:` factor reference whose Vault value is a valid 20-byte Base32 seed.
3. Enrol from the private admin chat; the bot returns only an `otpauth://` URI. Scan it into an authenticator app. The seed is never displayed again and can never be read back.
4. Verify one successful code, keep `ADMIN_STEP_UP_MODE=required`, and restart. The operator CLI reads codes only from a hidden local TTY.
5. Lockout defaults: 5 failed attempts per 15 minutes → 15-minute lockout. Override with `ADMIN_STEP_UP_MAX_ATTEMPTS` / `ADMIN_STEP_UP_LOCKOUT_MINUTES`.
6. Lost authenticator: rotate the stored secret through the Vault, re-enrol, and review `admin_step_up_attempt` plus `audit_event` for the lockout window. Switching to `disabled` does not delete factor or recovery data.

### Key rotation

For application-controlled signing keys (callback / delivery session):

1. Move the current key to the _previous_ slot and set
   `DELIVERY_SESSION_PREVIOUS_HMAC_KEY`, `…_PREVIOUS_KEY_VERSION`, and a
   `…_PREVIOUS_KEY_GRACE_UNTIL` deadline. The loader requires all three together
   and requires the versions to differ.
2. Deploy the new current key.
3. After the grace deadline, clear the previous triplet. Tokens signed with the
   retired key then fail closed.

SePay's key is externally controlled and is **not** rotated by this procedure —
rotate it in the SePay console and update `SEPAY_WEBHOOK_HMAC_SECRET`.

### Ledger invariant checks

Run these after any migration and on a schedule:

```sql
-- Every posted transaction balances.
select transaction_id
from ledger_posting
group by transaction_id
having coalesce(sum(amount_minor) filter (where side = 'DEBIT'), 0)
    <> coalesce(sum(amount_minor) filter (where side = 'CREDIT'), 0);

-- The cached wallet balance agrees with the ledger.
select w.id, w.balance_vnd, coalesce(sum(
         case when p.side = 'CREDIT' then p.amount_minor else -p.amount_minor end), 0) as ledger
from wallet_account w
join ledger_account a on a.wallet_account_id = w.id
left join ledger_posting p on p.account_id = a.id
group by w.id, w.balance_vnd
having w.balance_vnd <> coalesce(sum(
         case when p.side = 'CREDIT' then p.amount_minor else -p.amount_minor end), 0);

-- No orphan postings.
select p.id from ledger_posting p
left join ledger_transaction t on t.id = p.transaction_id
where t.id is null;
```

All three must return zero rows. Migration `063` runs the same checks and
**fails loudly** rather than shipping an inconsistent ledger.

### Broadcast emergency cancellation

`cancelBroadcast(campaignId, { actorId, correlationId })` marks the campaign
`CANCELLED`, suppresses every `PENDING`/`RETRY` delivery and appends an audit
event. A cancelled campaign cannot be revived: confirmation requires `DRAFT`.

### Backup and restore

A restore must preserve `ledger_account`, `ledger_transaction` and
`ledger_posting` **together** with `wallet_account`; restoring a cached balance
without its postings is refused by the deferred trigger at the first commit.
After a restore, run the three invariant queries above before serving traffic.
`notification_campaign_audience` (stage `CONFIRMED`) is the audit evidence for
who a broadcast reached and is append-only — restore it with the campaign.

### Credential incident

Unchanged: see
[`CREDENTIAL_INCIDENT_RUNBOOK.md`](../06-operations/CREDENTIAL_INCIDENT_RUNBOOK.md).
Rotate the affected secret, re-enrol TOTP if the vault was in scope, and review
`audit_event` for the exposure window.
