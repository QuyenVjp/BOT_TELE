# Deployment, Health, Migration, Rollback, Worker-Drain Runbook

## Current architecture and runtime prerequisites

This is a TypeScript modular monolith. PostgreSQL is the authoritative store; the HTTP
process durably accepts Telegram and SePay webhooks, while the worker drains independent
Telegram, payment, delivery/outbox, and recovery lanes. VietQR generates payment-initiation
payloads/images only; verified SePay evidence is required before settlement or delivery.

Production requires Node.js >=24, npm 10, PostgreSQL with `DATABASE_URL`, configured Telegram
bot token/webhook secret, SePay credentials, vault endpoint/credentials, supplier credentials,
and a non-zero `ADMIN_TELEGRAM_USER_ID`. Production must not use `memory` or `fixture` drivers.
Docker/OrbStack is needed only for container-backed integration/migration tests; it is not
needed for local pure-path checks.

## Local benchmark (no external services)

Run the reproducible local seams benchmark:

```bash
BENCHMARK_ITERATIONS=100 npm exec tsx scripts/local-benchmark.ts
```

It reports p50/p95/p99 for local VietQR payload + PNG presentation and worker scheduler lane
dispatch. These measurements intentionally exclude PostgreSQL, Telegram, SePay, supplier,
network, and outbox effects; they are not production SLOs. End-to-end/payment or migration
benchmarks are unavailable unless those services are provisioned. The existing
`npm run test:performance` suite includes PostgreSQL-container tests and therefore requires
Docker/OrbStack.

## Pre-deploy checklist

- [ ] `npm ci` installs from the lockfile (CI does this).
- [ ] `npm run typecheck`, `lint`, `format:check`, `secret-scan`, `audit` all green.
- [ ] Unit / contract / property / security / integration / acceptance / performance suites green.
- [ ] Migrations reviewed; no destructive change without a forward-compatible plan.
- [ ] Production env has real values for: `ADMIN_TELEGRAM_USER_ID`, SePay secrets, vault endpoint,
      supplier credentials, Telegram bot token / webhook secret. `loadConfig` fails closed if
      production still has `memory`/`fixture` drivers or a zero admin id.

## Health and readiness

| Endpoint / signal      | Meaning                                                       |
| ---------------------- | ------------------------------------------------------------- |
| Process alive (main)   | HTTP server accepting Telegram / SePay / delivery routes      |
| Process alive (worker) | Outbox poller interval running                                |
| DB connectivity        | Migration head applied; a trivial `select 1` succeeds         |
| Outbox lag             | Pending outbox count and oldest age under the alert threshold |
| Vault reachability     | External vault endpoint answers (production driver)           |

Do not route traffic to a replica that has not finished migrations.

## Safe migration ordering

1. **Expand**: add new columns/tables as nullable / with defaults; deploy code that writes both old
   and new shapes if needed.
2. **Migrate data**: backfill in batches; never hold a long exclusive lock on hot tables.
3. **Contract**: deploy code that reads the new shape exclusively.
4. **Contract schema**: add NOT NULL / drop old columns only after the contract step is stable.

All schema lives in `src/infrastructure/db/migrations/*.sql` and is applied by `npm run migrate`
(idempotent migration runner). Never edit a shipped migration; add a new one.

## Deploy steps (pilot)

```bash
npm ci
npm run build
npm run migrate
npm run start:worker
npm run start
```

## Worker drain

Before a rolling restart or scale-in, stop accepting new outbox work, wait for in-flight handlers
to finish, confirm no handler is mid-transaction, then start the new worker. Handlers are designed
for at-least-once delivery plus domain unique keys = exactly-once effects.

## Rollback

Prefer a forward fix. If code rollback is required, redeploy the previous build artifact. Leave an
expanded schema in place when necessary; never restore production backup as a quick rollback.
After rollback, re-drain the outbox and re-check health signals.

## Post-deploy

- Confirm Telegram webhook path + secret still verify.
- Confirm SePay webhook HMAC still verifies with a known test event (staging) or a canary.
- Confirm owner root-admin self-test: private chat, low-risk catalog action, audit write.
- Watch fulfillment lag, reconciliation lag, and invalid-asset counters for one pilot window.

## Isolated backup and restore drill

Run `npm exec tsx scripts/backup-restore-drill.ts` with Docker/OrbStack available. The script creates a disposable PostgreSQL container, migrates a source database, inserts synthetic customer/order/payment/inventory/wallet/audit rows, runs `pg_dump -Fc`, and restores into a second database with `pg_restore --exit-on-error`.

It checks row counts, commerce relationships, ledger balance, primary-key enforcement and nonnegative balance constraints, then removes its container. It does not accept a production database URL or export customer data. A successful synthetic drill proves this schema/tool path, not production backup freshness, encryption, retention, external vault recovery or a production RTO/RPO.
