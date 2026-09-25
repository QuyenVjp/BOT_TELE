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

## Current production migration head

The source tree currently contains **92** SQL files under `src/infrastructure/db/migrations/`.
The latest source migration is:

- **filename:** `093_supplier_catalog_platform.sql`
- **count:** `92`

The latest protected production record places production at
`091_growth_migration_repair.sql` (**96** migrations). The prior `090_payment_reminders.sql`
record was **95** migrations after applying canonical 085–090 plus six legacy migration
receipts already present in the compiled artifact; migration 091 is the forward-only repair
recorded after that window.

The production ledger retains these six legacy receipt names from the compiled
artifact. They are accounted for by the preflight compatibility count; do not add
duplicate source migrations for them:

- `084_verified_reviews.sql` → canonical `085_verified_reviews.sql`
- `085_promotions.sql` → canonical `086_promotions.sql`
- `086_promotion_drafts.sql` → canonical `087_promotion_drafts.sql`
- `087_referrals.sql` → canonical `088_referrals.sql`
- `088_funnel_events.sql` → canonical `089_funnel_events.sql`
- `089_payment_reminders.sql` → canonical `090_payment_reminders.sql`

The canonical growth migrations remain ordered:

1. `085_verified_reviews.sql`
2. `086_promotions.sql`
3. `087_promotion_drafts.sql`
4. `088_referrals.sql`
5. `089_funnel_events.sql`
6. `090_payment_reminders.sql`
7. `091_growth_migration_repair.sql`

The next forward-only source migrations after the protected production head are:

1. `092_group_publication_admin_command.sql`
2. `093_supplier_catalog_platform.sql`

Both are additive and must be applied in filename order from a clean release
artifact; no older migration file may be edited or replaced.

The release sequence is linear: automated CI and security gates → protected PR merge →
build the exact clean SHA with an empty compiled migration directory → keep the store
`CLOSED` and risky flags off → apply only the ordered migrations → restart the existing
API/worker supervisors → verify `/health`, `/ready`, and `npm run preflight:production`
→ run direct live Telegram/browser smoke → enable one feature flag at a time with
rollback evidence. Migration application must not wait on a first-sale or workbook
write; those are separate acceptance gates.

Production defaults for this growth train are fail-closed:
`SOCIAL_PROOF_ENABLED=false`, `VERIFIED_REVIEWS_ENABLED=false`,
`PROMOTIONS_ENABLED=false`, `REFERRAL_ATTRIBUTION_ENABLED=false`,
`PAYMENT_REMINDERS_ENABLED=false`, `GROWTH_DIGEST_ENABLED=false`,
`ADMIN_PAYMENT_ALERT_MODE=OFF`, and `REFERRAL_REWARDS_ENABLED=false`.

Keep `GOOGLE_SHEETS_INVENTORY_INTAKE_ENABLED=false` in production by owner
decision. Apps Script commissioning, OIDC audience configuration and workbook
acceptance are optional future work, not release or store-opening blockers. Do
not edit older migration files.

## Historical migrations 072–076 — post-merge production procedure

This procedure is **not executed by review**. Run it only after this branch has
merged, the production artifact is built from that merge, and the owner has
scheduled a controlled database window. Keep the store `CLOSED`; do not
activate sales as part of the migration.

1. **Preflight and backup**
   - Run `npm ci`, `npm run build`, and `npm run preflight:production` from the
     exact release checkout. The preflight output must show `storeStatus=CLOSED`,
     a reachable database on `localhost:5432/shop`, and the expected production
     target.
   - Take and verify a fresh production PostgreSQL backup. Record size and
     SHA-256. Do not print or copy `DATABASE_URL`.
   - Record the pre-migration `schema_migrations` head/count. Expected before
     072: head `071_variant_presentation_profile.sql`, count `70`.

2. **Quiesce writers**
   - Keep Telegram/SePay ingress and the store `CLOSED` while the database
     window is active. Do not delete or cancel business rows to make the window
     quiet.

3. **Apply 072–076 and record the operation**
   - Run `npm run preflight:production` again immediately before the migration.
   - Measure the command and retain its exit status:

     ```bash
     started_at=$(date +%s)
     npm run migrate:production
     status=$?
     finished_at=$(date +%s)
     printf 'migration_072_076_exit=%s duration_seconds=%s\n' \
       "$status" "$((finished_at - started_at))"
     test "$status" -eq 0
     ```

   - The pinned production runner acquires the migration advisory lock and
     applies each pending file transactionally in filename order.
   - If the command fails, stop here. Verify the failed file rolled back and
     investigate with a forward migration; do not edit or delete migration
     history.

4. **Verify schema**
   - Query `schema_migrations` and require head
     `076_resale_evidence_revocation.sql` with count `75`.
   - Require the publication/version fields and store transition table from
     072; the payment/outbox disposition columns and guarded checks from 073;
     the admin state/command references from 074–075; and
     `resale_evidence.revocation_request_id` plus its guarded unique index/check
     from 076.
   - Re-check commerce invariants: order/payment-intent relationships,
     quantity-stock ledger continuity, wallet double-entry balance, active
     evidence/publication bindings, and unresolved outbox/discrepancy counts.
   - Do not register evidence, resolve discrepancies, dispose outbox rows, or
     open the store during the migration window. Those are separate owner
     workflows with their own step-up and audit gates.

5. **Resume and close the window**
   - Restart the existing API/worker supervisors from the merged main
     artifact, then verify `/health` (`dirty=false`, merged SHA) and `/ready`.
   - Run `npm run preflight:production` once more; require the same production
     target, `storeStatus=CLOSED`, migration head 076, reachable dependencies,
     and a usable admin step-up factor.
   - Treat any blocked `OPEN` readiness result as expected until the owner has
     completed the evidence-registration and per-product publication workflows;
     do not bypass them with direct SQL or a store-mode override.
   - Existing variants are intentionally not auto-published by these migrations.
     Before reopening the store, the owner must use the protected Telegram
     workflow to register legitimate resale evidence for each intended SKU and
     publish each ready product. Until that work is complete, an empty storefront
     or a blocked `OPEN` readiness check is expected, not a migration failure;
     do not treat it as an abort.
   - Opening the store is a separate owner decision and is not part of this
     procedure.

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
- Verify the Bot API webhook `allowed_updates` is exactly
  `["message", "callback_query", "inline_query", "chosen_inline_result"]`; the application
  registers the receiver only, so compare the deployment control-plane value rather than
  changing production from the worker.
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
