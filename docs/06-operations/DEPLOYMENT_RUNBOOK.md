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
locally (loads repo `.env`). Never edit a shipped migration; add a new one.

Production schema changes use `npm run migrate:production` (`node --env-file=` of
`$HOME/.config/bot-tele-production/production.env`). Do not `source` that file.
See `docs/06-operations/PRODUCTION_ENV.md`.

## Deploy steps (pilot)

```bash
npm ci
npm run build
npm run migrate
npm run start:worker
npm run start
```

## Production migrate

```bash
npm run preflight:production
npm run migrate:production
```

## Migration 070 — post-merge production procedure

This procedure is **not executed by the Phase 2 review**. Run it only after the
migration has merged, the production artifact is built, and the owner has
scheduled a controlled database window. Keep the store `CLOSED`; do not activate
sales as part of the migration.

1. **Preflight and backup**
   - Run `npm ci`, `npm run build`, and `npm run preflight:production` from the
     exact release checkout. The preflight output must show `storeStatus=CLOSED`,
     a reachable database, and the expected production target.
   - Take and verify the normal production PostgreSQL backup/snapshot. Record its
     provider receipt, timestamp, and retention. Do not print or copy
     `DATABASE_URL`; the repository's production wrappers load
     `$HOME/.config/bot-tele-production/production.env` without sourcing it.
   - Record the pre-migration `schema_migrations` head/count, row counts for
     `quantity_stock_ledger` and `payment_intent`, and
     `pg_total_relation_size` for those tables. Save only counts, sizes, and
     timestamps in the change record.

2. **Quiesce writers**
   - Stop accepting new commerce/admin writes using the existing supervisor and
     worker-drain procedure. Let in-flight handlers finish and confirm no
     handler is mid-transaction.
   - Keep Telegram/SePay ingress and the store `CLOSED` while the database
     window is active. Do not delete or cancel business rows to make the window
     quiet.

3. **Apply 070 and record the operation**
   - Run `npm run preflight:production` again immediately before the migration.
   - Measure the command from the terminal and retain its exit status and
     duration:

     ```bash
     started_at=$(date +%s)
     npm run migrate:production
     status=$?
     finished_at=$(date +%s)
     printf 'migration_070_exit=%s duration_seconds=%s\n' \
       "$status" "$((finished_at - started_at))"
     test "$status" -eq 0
     ```

   - The pinned production runner acquires the migration advisory lock and
     applies `070_phase2_hot_indexes.sql` transactionally. The migration uses
     regular `CREATE INDEX`, so schedule a quiet window: concurrent writes can
     wait while each index is built.
   - If the command fails, stop here. Verify the transaction rolled back, the
     migration head remains `069_step_up_authorization_binding.sql`, and neither
     new index is recorded as valid. Do not drop an existing index or restore a
     backup as a first response; investigate and ship a forward fix.

4. **Verify schema and query plan**
   - Query `schema_migrations` and require head
     `070_phase2_hot_indexes.sql` with count `69`.
   - Require valid indexes
     `quantity_stock_variant_created_idx` and
     `payment_intent_order_created_idx`; record their sizes.
   - Re-run the pre-migration row-count/table-size queries and representative
     inventory-by-variant and payment-by-order `EXPLAIN (ANALYZE, BUFFERS)`
     checks. The plans must use the new indexes for the newest-first lookups;
     record execution time, shared-hit/read blocks, and any lock/wait evidence.
   - Re-check commerce invariants: order/payment-intent relationships,
     quantity-stock ledger continuity, wallet double-entry balance, and
     absence of unexpected `PENDING`/`RETRY` growth. Migration 070 must change
     indexes only, not business-row counts or statuses.

5. **Resume and close the window**
   - Restart the existing API/worker supervisors, resume drained lanes, and
     verify `/health` and `/ready`.
   - Run `npm run preflight:production` once more; require the same production
     target, `storeStatus=CLOSED`, migration head 070, reachable dependencies,
     and a usable admin step-up factor.
   - Watch webhook, outbox, notification, payment-reconciliation, and
     fulfillment lag for the pilot window. Opening the store is a separate
     owner decision and is not part of this procedure.

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

## Production external Vault profile and recovery

The current single-host production profile uses the repository's encrypted HTTPS
provider behind the existing `com.bot-tele.vault` LaunchAgent. It binds only to
`127.0.0.1:8443`; API and worker use the same endpoint and explicit host/port/CIDR
egress allowlists. The encrypted state is
`$HOME/.local/state/bot-tele-external-vault/store.json`; token, master key, TLS key,
certificate, and CA remain outside the repository under
`$HOME/.config/bot-tele-external-vault`. This profile is durable for a single host,
not an HA or multi-host Vault service.

Keep the store `CLOSED` during recovery. Back up only the encrypted state file to a
mode-`0600` destination; never decrypt, print, or move secret material through a
shell variable, log, database field, or chat. Restart the existing supervisor after
backup or restore:

```bash
uid=$(id -u)
launchctl kickstart -k "gui/$uid/com.bot-tele.vault"
NODE_EXTRA_CA_CERTS="$HOME/.config/bot-tele-external-vault/ca.crt" \
  npm run preflight:production
```

For restore, stop the LaunchAgent, atomically replace the encrypted state file with
the verified backup while preserving mode `0600`, bootstrap the same plist again,
then run the restart and preflight commands above. Verify `/health` and `/ready`,
the migration head, and the admin step-up factor before any owner activation.
The release drill must include write/reveal, supervisor restart/reveal, encrypted
backup, isolated restore/reveal, and deletion of all disposable material.
