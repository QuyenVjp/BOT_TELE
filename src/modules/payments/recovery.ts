import { sql } from "kysely";
import type { Db } from "../../infrastructure/db/transaction.js";
import {
  ageSeconds,
  validateRecoveryBatchSize,
  type RecoveryTelemetry,
} from "../recovery-result.js";
import {
  createPostgresSePayReconciliationCursorStore,
  reconcileSePay,
  type SePayReconciliationPort,
} from "./reconciliation.js";
import type { RateLimiter } from "../risk/service.js";

const SEPAY_RECOVERY_ADVISORY_LOCK = 7_021_680_412;
const SEPAY_RECOVERY_OVERLAP_SECONDS = 300;

export async function recoverSePayBatch(
  db: Db,
  options: {
    batchSize: number;
    now?: Date;
    port: SePayReconciliationPort;
    rateLimiter?: RateLimiter;
  },
): Promise<RecoveryTelemetry> {
  validateRecoveryBatchSize(options.batchSize);
  const now = options.now ?? new Date();

  const outcome = await db.connection().execute(async (connection) => {
    const lock = await sql<{ acquired: boolean }>`
      select pg_try_advisory_lock(${SEPAY_RECOVERY_ADVISORY_LOCK}) as acquired
    `.execute(connection);
    if (!lock.rows[0]?.acquired) return { claimed: 0, succeeded: 0, failed: 0 };

    try {
      const candidates = await sql<{ created_at: Date | string }>`
        select pi.created_at
        from payment_intent pi
        join "order" o on o.id = pi.order_id
        where pi.status in ('CREATED','PRESENTED')
          and o.status = 'PENDING_PAYMENT'
        order by pi.created_at asc, pi.id asc
        limit ${options.batchSize}
        for update of pi skip locked
      `.execute(connection);
      if (candidates.rows.length === 0) return { claimed: 0, succeeded: 0, failed: 0 };
      const oldest = candidates.rows[0]?.created_at;
      const fromSec = Math.floor(
        (oldest instanceof Date ? oldest.getTime() : new Date(oldest ?? now).getTime()) / 1000,
      );
      const cursorStore = createPostgresSePayReconciliationCursorStore(db);
      const proposedToSec = Math.floor(now.getTime() / 1000);
      const proposedFromSec = Math.min(
        fromSec,
        Math.max(0, proposedToSec - SEPAY_RECOVERY_OVERLAP_SECONDS),
      );
      const cursor = await cursorStore.claim(
        "sepay",
        proposedFromSec,
        proposedToSec,
        Math.min(options.batchSize, 100),
      );
      const summary = await reconcileSePay(db, {
        port: options.port,
        windowFromSec: cursor.windowFromSec,
        windowToSec: cursor.windowToSec,
        maxTransactions: cursor.perPage,
        page: cursor.page,
        now,
        ...(options.rateLimiter ? { rateLimiter: options.rateLimiter } : {}),
      });
      if (summary.windowComplete) {
        const remainingOldest = await sql<{ created_at: Date | string | null }>`
          select min(pi.created_at) as created_at
          from payment_intent pi
          join "order" o on o.id = pi.order_id
          where pi.status in ('CREATED','PRESENTED')
            and o.status = 'PENDING_PAYMENT'
        `.execute(connection);
        const oldestPending = remainingOldest.rows[0]?.created_at;
        const overlapFromSec = Math.max(0, cursor.windowToSec - SEPAY_RECOVERY_OVERLAP_SECONDS);
        const oldestPendingSec = oldestPending
          ? Math.floor(
              (oldestPending instanceof Date
                ? oldestPending.getTime()
                : new Date(oldestPending).getTime()) / 1000,
            )
          : overlapFromSec;
        await cursorStore.completeWindow(
          cursor,
          Math.min(overlapFromSec, oldestPendingSec),
          proposedToSec,
          Math.min(options.batchSize, 100),
        );
      } else if (summary.pageComplete) {
        await cursorStore.advancePage(cursor);
      }
      return {
        claimed: candidates.rows.length,
        succeeded: summary.scanned - summary.errors,
        failed: summary.errors,
      };
    } finally {
      await sql`select pg_advisory_unlock(${SEPAY_RECOVERY_ADVISORY_LOCK})`.execute(connection);
    }
  });

  const remaining = await sql<{ backlog: number; oldest: Date | string | null }>`
    select count(*)::int as backlog, min(pi.created_at) as oldest
    from payment_intent pi
    join "order" o on o.id = pi.order_id
    where pi.status in ('CREATED','PRESENTED')
      and o.status = 'PENDING_PAYMENT'
  `.execute(db);
  const row = remaining.rows[0];
  return {
    ...outcome,
    backlog: row?.backlog ?? 0,
    oldestAgeSeconds: ageSeconds(now, row?.oldest),
  };
}
