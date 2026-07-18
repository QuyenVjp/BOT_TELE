# Deployment, Health, Migration, Rollback, Worker-Drain Runbook

## Pre-deploy checklist

- [ ] `npm ci` installs from the lockfile (CI does this).
- [ ] `npm run typecheck`, `lint`, `format:check`, `secret-scan`, `audit` all green.
- [ ] Unit / contract / property / security / integration / acceptance / performance suites green.
- [ ] Migrations reviewed; no destructive change without a forward-compatible plan.
- [ ] Production env has real values for: `ADMIN_TELEGRAM_USER_ID`, SePay secrets, vault endpoint,
      supplier credentials, Telegram bot token / webhook secret. `loadConfig` fails closed if
      production still has `memory`/`fixture` drivers or a zero admin id.

## Health and readiness

| Endpoint / signal | Meaning |
|---|---|
| Process alive (main) | HTTP server accepting Telegram / SePay / delivery routes |
| Process alive (worker) | Outbox poller interval running |
| DB connectivity | Migration head applied; a trivial `select 1` succeeds |
| Outbox lag | Pending outbox count and oldest age under the alert threshold |
| Vault reachability | External vault endpoint answers (production driver) |

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
# 1. Install + build
npm ci
npm run build

# 2. Migrate (against the target DATABASE_URL)
npm run migrate

# 3. Restart worker first so outbox drain continues during the cutover
npm run start:worker

# 4. Restart the HTTP process
npm run start
```

## Worker drain

Before a rolling restart or scale-in:

1. Stop accepting new outbox work (stop the poller interval / SIGTERM the worker).
2. Wait until in-flight handlers finish (outbox rows move to `PROCESSED` or stay `PENDING` for the
   next worker — never partially-applied domain effects; handlers are idempotent).
3. Confirm no handler is mid-transaction (process exit after the current tick).
4. Start the new worker.

Handlers are designed for at-least-once delivery + domain unique keys = exactly-once effects
(settled bank transaction, claimed asset, active delivery bundle).

## Rollback

1. Prefer **forward fix**. If a code rollback is required, redeploy the previous build artifact.
2. Schema rollback: only if the new migration is expandable; otherwise leave the expanded schema
   and roll the code back to a dual-write/dual-read version.
3. Never restore a production database from backup as a "quick rollback" without an incident
   decision — that is a restore drill (`evidence/restore.md`), not a deploy step.
4. After rollback, re-drain the outbox and re-check health signals.

## Post-deploy

- Confirm Telegram webhook path + secret still verify.
- Confirm SePay webhook HMAC still verifies with a known test event (staging) or a canary.
- Confirm owner root-admin self-test: private chat, low-risk catalog action, audit write.
- Watch fulfillment lag, reconciliation lag, and invalid-asset counters for one pilot window.
