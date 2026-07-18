import { sql } from "kysely";
import type { Db } from "../../infrastructure/db/transaction.js";
import { withTransaction } from "../../infrastructure/db/transaction.js";
import {
  ageSeconds,
  validateRecoveryBatchSize,
  type RecoveryTelemetry,
} from "../recovery-result.js";
import { releaseReservedAsset } from "./repository.js";

export async function recoverStaleReservationsBatch(
  db: Db,
  options: { batchSize: number; now?: Date },
): Promise<RecoveryTelemetry> {
  validateRecoveryBatchSize(options.batchSize);
  const now = options.now ?? new Date();
  const excluded: string[] = [];
  let claimed = 0;
  let succeeded = 0;
  let failed = 0;

  for (let index = 0; index < options.batchSize; index += 1) {
    let selectedId: string | null = null;
    try {
      const processed = await withTransaction(db, async (trx) => {
        const excludedFilter =
          excluded.length === 0
            ? sql``
            : sql`and id not in (${sql.join(excluded.map((id) => sql`${id}`))})`;
        const candidate = await sql<{ id: string; version: number }>`
          select id, version from digital_asset
          where status = 'RESERVED'
            and reserved_until is not null
            and reserved_until < ${now.toISOString()}
            ${excludedFilter}
          order by reserved_until asc, id asc
          limit 1
          for update skip locked
        `.execute(trx);
        const selected = candidate.rows[0];
        selectedId = selected?.id ?? null;
        if (!selected) return false;
        return releaseReservedAsset(trx, selected.id, selected.version);
      });
      if (selectedId === null) break;
      claimed += 1;
      excluded.push(selectedId);
      if (processed) succeeded += 1;
    } catch {
      if (selectedId === null)
        throw new Error("reservation recovery failed before selecting a row");
      claimed += 1;
      failed += 1;
      excluded.push(selectedId);
    }
  }

  const remaining = await sql<{ backlog: number; oldest: Date | string | null }>`
    select count(*)::int as backlog, min(reserved_until) as oldest
    from digital_asset
    where status = 'RESERVED'
      and reserved_until is not null
      and reserved_until < ${now.toISOString()}
  `.execute(db);
  const row = remaining.rows[0];
  return {
    claimed,
    succeeded,
    failed,
    backlog: row?.backlog ?? 0,
    oldestAgeSeconds: ageSeconds(now, row?.oldest),
  };
}

export async function recoverExpiredDeliveryBundlesBatch(
  db: Db,
  options: { batchSize: number; now?: Date },
): Promise<RecoveryTelemetry> {
  validateRecoveryBatchSize(options.batchSize);
  const now = options.now ?? new Date();
  const excluded: string[] = [];
  let claimed = 0;
  let succeeded = 0;
  let failed = 0;

  for (let index = 0; index < options.batchSize; index += 1) {
    let selectedId: string | null = null;
    try {
      const processed = await withTransaction(db, async (trx) => {
        const excludedFilter =
          excluded.length === 0
            ? sql``
            : sql`and id not in (${sql.join(excluded.map((id) => sql`${id}`))})`;
        const candidate = await sql<{ id: string }>`
          select id from delivery_bundle
          where status in ('CREATED','AVAILABLE','VIEWED')
            and expires_at < ${now.toISOString()}
            ${excludedFilter}
          order by expires_at asc, id asc
          limit 1
          for update skip locked
        `.execute(trx);
        selectedId = candidate.rows[0]?.id ?? null;
        if (selectedId === null) return false;
        const updated = await sql`
          update delivery_bundle
          set status = 'EXPIRED', version = version + 1
          where id = ${selectedId}
            and status in ('CREATED','AVAILABLE','VIEWED')
            and expires_at < ${now.toISOString()}
        `.execute(trx);
        return Number(updated.numAffectedRows ?? 0) === 1;
      });
      if (selectedId === null) break;
      claimed += 1;
      excluded.push(selectedId);
      if (processed) succeeded += 1;
    } catch {
      if (selectedId === null) throw new Error("bundle recovery failed before selecting a row");
      claimed += 1;
      failed += 1;
      excluded.push(selectedId);
    }
  }

  const remaining = await sql<{ backlog: number; oldest: Date | string | null }>`
    select count(*)::int as backlog, min(expires_at) as oldest
    from delivery_bundle
    where status in ('CREATED','AVAILABLE','VIEWED')
      and expires_at < ${now.toISOString()}
  `.execute(db);
  const row = remaining.rows[0];
  return {
    claimed,
    succeeded,
    failed,
    backlog: row?.backlog ?? 0,
    oldestAgeSeconds: ageSeconds(now, row?.oldest),
  };
}
