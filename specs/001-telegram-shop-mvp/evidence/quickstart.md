# Quickstart Validation Evidence (T112)

**Date**: 2026-07-16
**Scope**: Execute the `quickstart.md` validation lanes and attach actual command results.

> **Superseded on 2026-07-17:** T154–T157 are reopened. The historical per-lane and suite results
> below are not final-source acceptance evidence. New counts and gate outcomes remain intentionally
> blank until every required command has run on the final source; local Docker proof is not SHA-bound
> CI proof while `.git` is invalid.

> Note: These lanes run locally / in CI against disposable PostgreSQL containers (Testcontainers).
> The full staging run against production-shaped infrastructure remains a launch gate (see
> `launch-gates.md` G3/G6/G8).

## 1. Static and configuration

```bash
npm run typecheck   # tsc --noEmit
npm run lint        # eslint .
npm run format:check
npm run secret-scan
npm run audit       # npm audit --omit=dev --audit-level=high
```

Results:

```
typecheck: no errors
lint: clean
format:check: all matched files use Prettier code style
secret-scan: OK (no high-confidence secrets found)
audit: found 0 vulnerabilities
```

## 2. Customer discovery acceptance

```bash
npx vitest run tests/acceptance/catalog-journey.test.ts
```

Result: 7/7 — retail-only menu, active-only listing, unauthorized SKU hidden, product-card fields,
Buy Now within 4 actions (SC-002), deterministic search never invents a product, no Order during
browse.

## 3. Payment contract and replay

```bash
npx vitest run tests/contract/sepay-webhook.test.ts tests/contract/vietqr-presentation.test.ts \
  tests/property/payment-idempotency.test.ts tests/integration/payment-discrepancy.test.ts \
  tests/integration/payment-reconciliation.test.ts tests/acceptance/payment-journey.test.ts
```

Result: signed-webhook contract, VietQR payload/CRC, 100-event replay idempotency, full discrepancy
matrix (under/over/late/wrong-content/wrong-account/unmatched/collision), reconciliation recovery +
backoff, and the Buy Now → paid acceptance journey historically passed in this superseded run.

## 4. Secure fulfillment and delivery

```bash
npx vitest run tests/property/asset-claim.test.ts tests/contract/supplier-port.test.ts \
  tests/integration/fulfillment-recovery.test.ts tests/security/delivery-bundle.test.ts \
  tests/security/credential-leak.test.ts tests/acceptance/fulfillment-journey.test.ts
```

Result: 20-buyer final-asset concurrency (SC-006), supplier schema/idempotency/unknown/query-before-
retry, crash/replay recovery at each boundary, delivery-bundle ownership/atomic-first-view/expiry/
replay, credential-leak scan across DB/log/trace/outbox/ticket/error, and paid→delivery acceptance
(SC-004 timing) historically passed in this superseded run.

## 5. Order history and support

```bash
npx vitest run tests/security/order-history.test.ts tests/integration/support-ticket.test.ts \
  tests/security/support-boundary.test.ts tests/acceptance/support-journey.test.ts
```

Result: BOLA + keyset pagination, structured ticket with safe summary + SLA + ownership, support
privilege boundary, and the history→support journey historically passed in this superseded run.

## 6. Sole-admin authorization

```bash
npx vitest run tests/security/root-admin-identity.test.ts tests/security/no-add-admin.test.ts \
  tests/integration/admin-confirmation.test.ts tests/acceptance/owner-operations.test.ts
```

Result: only the configured numeric identity in private chat succeeds; username impersonation and
group context denied and audited; no add-admin capability; high-risk action requires expiring
confirmation + reason + append-only audit. 19/19 green.

## 7. Pilot-load percentiles

```bash
npx vitest run tests/performance/pilot-load.test.ts
```

Result:

```
[SC-003] catalog p50≈2.8ms p95≈4.1ms  (budget < 1000ms)
[SC-004] paid→delivery p50≈22.6ms p95≈26.1ms  (budget < 60000ms)
```

## Full suite

```bash
npx vitest run
```

2026-07-17 remediation result: **333 tests passed (64 files)** on the Windows host. The same final
source was copied read-only into a `node:24-bookworm-slim` container, built under Node 24.18.0, and
again produced **333 tests passed (64 files)**. `typecheck`, `lint`, `format:check`, `secret-scan`,
`build`, and `npm audit --omit=dev` exited 0; the production audit printed `found 0 vulnerabilities`.
This is local proof only because `.git` is invalid and no CI/SHA binding exists.

2026-07-17 T158–T160 resumed result: after the signed callback and conflict-safe winner-read slice,
the final source passed **355 tests (67 files)** on the Windows Node 20.19.0 host and again under
Node 24.18.0 in `node:24-bookworm-slim`. The same static/build/secret/production-audit gates passed;
the two-connection idempotency file also passed 10 consecutive runs. This remains local proof only:
`.git` is invalid and no result is bound to a commit SHA or CI run.

## Outstanding (launch gates)

Staging run with real SePay canary, external vault, production-sized restore drill, and container
image scan are tracked in `launch-gates.md` and require dated owner sign-off.
