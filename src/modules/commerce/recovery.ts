import { sql } from "kysely";
import type { Db } from "../../infrastructure/db/transaction.js";
import { withTransaction } from "../../infrastructure/db/transaction.js";
import { releaseReservationForOrder } from "../digital-goods/repository.js";
import { voidLiveIntentsForOrder } from "../payments/repository.js";
import {
  ageSeconds,
  validateRecoveryBatchSize,
  type RecoveryTelemetry,
} from "../recovery-result.js";
import { findOrderByIdForUpdate, transitionOrder } from "./repository.js";

export async function recoverExpiredOrdersBatch(
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
          select id from "order"
          where status = 'PENDING_PAYMENT'
            and expires_at is not null
            and expires_at < ${now.toISOString()}
            ${excludedFilter}
          order by expires_at asc, id asc
          limit 1
          for update skip locked
        `.execute(trx);
        selectedId = candidate.rows[0]?.id ?? null;
        if (selectedId === null) return false;

        const order = await findOrderByIdForUpdate(trx, selectedId);
        if (
          !order ||
          order.status !== "PENDING_PAYMENT" ||
          order.expiresAt === null ||
          new Date(order.expiresAt).getTime() >= now.getTime()
        ) {
          return false;
        }
        await transitionOrder(trx, order, "EXPIRED", "TTL_EXPIRED", "system-recovery", {
          type: "system",
          id: "recovery",
        });
        await voidLiveIntentsForOrder(trx, order.id);
        await releaseReservationForOrder(trx, order.id);
        return true;
      });
      if (selectedId === null) break;
      claimed += 1;
      excluded.push(selectedId);
      if (processed) succeeded += 1;
    } catch {
      if (selectedId === null) throw new Error("order recovery failed before selecting a row");
      claimed += 1;
      failed += 1;
      excluded.push(selectedId);
    }
  }

  const remaining = await sql<{ backlog: number; oldest: Date | string | null }>`
    select count(*)::int as backlog, min(expires_at) as oldest
    from "order"
    where status = 'PENDING_PAYMENT'
      and expires_at is not null
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
