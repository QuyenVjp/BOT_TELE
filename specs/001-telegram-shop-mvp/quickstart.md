# Quickstart Validation: Telegram Shop Digital MVP

> HISTORICAL SPEC. Mini App / WebApp / initData / shop.tier20.click: CANCELLED BY OWNER — DO NOT IMPLEMENT. Canonical architecture is Telegram-bot-only: `docs/architecture/telegram-only-commerce.md`.

This guide defines the evidence required before implementation is considered pilot-ready. Commands
are placeholders until the project scaffold exists; tasks.md must replace them with actual scripts.

## Prerequisites

- Container runtime with isolated PostgreSQL and optional Redis.
- Telegram update fixtures, VietQR expected payload fixtures, signed SePay webhook fixtures, and
  supplier success/reject/unknown fixtures containing no production secret.
- Test vault adapter that can prove reveal/redaction semantics.
- Seed catalog with one local-stock variant, one supplier-only variant, one unauthorized variant,
  and one final-unit concurrency case.

## Required validation lanes

### 1. Static and configuration

```text
install locked dependencies
run typecheck
run lint/format check
run secret scan and dependency audit
validate environment schema with no production values
```

Expected: zero type/lint errors, no committed secret, and all external credentials required through
the environment/secret manager.

### 2. Customer discovery acceptance

```text
/start -> category -> product detail
/start -> natural-language search -> product detail
model parser unavailable -> deterministic search
```

Expected: only the four retail menu actions; product facts match seeded database; inactive and
unauthorized variants cannot be purchased; QR is reachable in no more than four deliberate actions.

### 3. Payment contract and replay

```text
create one unpaid Order and VietQR
submit valid signed SePay fixture
replay identical event 100 times
submit invalid signature, stale timestamp, outbound, wrong-account, wrong-amount, wrong-content,
late, partial, and overpayment fixtures
```

Expected: one settlement for the valid transaction; zero settlement for invalid evidence; every
business mismatch becomes a traceable discrepancy; webhook acknowledgement does not wait for fulfillment.

### 4. Inventory and supplier recovery

```text
race 20 buyers for one local asset
submit supplier success fixture twice
simulate timeout after supplier accepted request
reconcile unknown supplier order
return malformed/revoked/wrong-region asset
```

Expected: one local winner; one upstream create; `Unknown` queried before retry; invalid assets
quarantined; no paid Order disappears.

### 5. Secure delivery and BOLA

```text
issue bundle for owning customer
open concurrently twice
open as another customer
open after expiry
scan DB/log/trace/outbox/ticket/error fixtures for raw secret
```

Expected: exactly one reveal to the owner; all other reveals denied without secret; zero raw secret
outside the test vault/reveal response.

### 6. Sole-admin authorization

```text
run action as configured numeric owner in private chat
run action as same username with different numeric ID
run action in group chat
attempt /add-admin
run high-risk action without and with valid confirmation
```

Expected: only the configured private identity succeeds; no new admin exists; high-risk action is
idempotent and has attributable audit evidence.

### 7. Crash, reconciliation, and restore drill

```text
crash after inbox insert before processing
crash after payment commit before notification
crash after supplier acceptance before response persistence
restart worker and replay outbox
restore PostgreSQL backup to isolated environment
run SePay and supplier reconciliation
```

Expected: no duplicate business effect, projections rebuild, discrepancies are explainable, and
restore evidence records recovery point/time.

## Pilot readiness evidence

- All requirements-quality checklists are complete.
- `analysis.md` has no unresolved Critical/High finding.
- All test lanes above pass with recorded command output in CI/staging.
- Numeric admin ID, supplier authorization, SePay production configuration, warranty/refund policy,
  policy-risk acceptance, and runbooks have dated owner sign-off.
## Gate 0 correction validation

Before implementation, run the RED-only suites for T179–T185. They must fail for the missing
recoverability/upgrade/transport/privacy seams; do not convert these failures into skips.

After implementation, the compiled upgrade lane must run `migrate:prod` against both:

1. a database whose `schema_migrations` contains SePay-only 008; and
2. a fresh database whose 008 was produced by the prior expanded snapshot.

Both paths must preserve existing customers, orders, inbox evidence, and payment rows, create the
canonical Telegram CHECK plus delivery-session/handoff objects, and fail closed with the collision
runbook when both `telegram` and `TELEGRAM` rows collide.

The delivery acceptance must cover: Bundle commit crash before handoff, vault-write/DB-rollback
compensation, live-Bundle session refresh after expiry, current/previous key grace, Mini App
`initData` verification and one-time redemption, 429/ambiguous Telegram send recovery, and absence
of `actorUsername` in durable inbox rows with bounded pruning.
