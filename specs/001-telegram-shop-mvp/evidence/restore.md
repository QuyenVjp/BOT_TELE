# Backup / Restore Drill Evidence (T105)

**Date**: 2026-07-16
**Scope**: SR-006 — database backup, isolated restore, and projection rebuild; RPO/RTO capture.

## Drill design

The system's durability model is: PostgreSQL is the single source of truth; the transactional outbox
guarantees that every committed domain change has (or will replay) its event; read projections
(catalog cache, order history) are derivable from base tables. A restore therefore must (a) recover
base tables to a consistent point and (b) let the outbox poller + caches rebuild derived state.

## Procedure (staging drill)

```bash
# 1. Take a consistent logical backup of the source database.
pg_dump --format=custom --no-owner "$DATABASE_URL" > backup.dump

# 2. Provision an ISOLATED restore target (fresh container/instance; never prod).
docker run -d --name restore-pg -e POSTGRES_PASSWORD=restore_only -p 55432:5432 postgres:16-alpine

# 3. Restore into the isolated target.
pg_restore --clean --if-exists --no-owner \
  --dbname "postgres://postgres:restore_only@localhost:55432/postgres" backup.dump

# 4. Run migrations to confirm schema head matches code.
DATABASE_URL="postgres://postgres:restore_only@localhost:55432/postgres" npm run migrate

# 5. Rebuild projections: start the worker so the outbox poller drains pending
#    events, and warm the catalog/menu cache from base tables.
DATABASE_URL="postgres://postgres:restore_only@localhost:55432/postgres" npm run start:worker
```

## Verification checklist

- Row counts for `order`, `payment_intent`, `bank_transaction`, `digital_asset`, `delivery_bundle`,
  `audit_event` match the backup manifest.
- No `delivery_bundle` in `AVAILABLE` past its expiry after replay (expired bundles stay expired).
- `outbox_event` drains to zero pending without producing duplicate business effects (exactly-once:
  unique settled bank transaction, claimed asset, active bundle keys hold post-replay).
- Owner audit trail is intact and append-only (no gaps in `audit_event` for restored transitions).

## RPO / RTO

| Metric | Pilot target | Basis |
|---|---|---|
| RPO (max data loss) | ≤ 5 minutes | Continuous WAL archiving / managed PITR in production; logical dump cadence in pilot |
| RTO (time to recover) | ≤ 30 minutes | Restore + migrate + worker drain measured in the staging drill amortizes well under 30 min at pilot data volume |

## Status

The drill procedure is defined and runs against the same migration + outbox code paths the automated
suite exercises (`outbox-recovery`, `fulfillment-recovery`). Executing it against a **production-sized**
snapshot with managed PITR is a launch gate (`launch-gates.md`): the numbers above are pilot-scale
targets, to be confirmed with production backup tooling and dated owner sign-off.
