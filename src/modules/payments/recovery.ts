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
import { SePayApiError } from "./sepay-api.js";

const SEPAY_RECOVERY_ADVISORY_LOCK = 7_021_680_412;
const SEPAY_RECOVERY_OVERLAP_SECONDS = 300;

function errorClassOf(error: unknown): string {
  if (error instanceof SePayApiError) return error.code;
  return "HTTP_ERROR";
}

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
      const retryGate = await sql<{ retry_after_until: Date | string | null }>`
        select retry_after_until
        from sepay_reconciliation_cursor
        where provider = 'sepay'
        limit 1
      `.execute(connection);
      const retryAfterUntil = retryGate.rows[0]?.retry_after_until;
      const retryAfterMs =
        retryAfterUntil instanceof Date
          ? retryAfterUntil.getTime()
          : retryAfterUntil
            ? new Date(retryAfterUntil).getTime()
            : NaN;
      if (Number.isFinite(retryAfterMs) && retryAfterMs > now.getTime()) {
        return { claimed: 0, succeeded: 0, failed: 0 };
      }

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
      const proposedToSec = Math.floor(now.getTime() / 1000);
      const overlapFromSec = Math.max(0, proposedToSec - SEPAY_RECOVERY_OVERLAP_SECONDS);
      const oldest = candidates.rows[0]?.created_at;
      const fromSec = oldest
        ? Math.floor(
            (oldest instanceof Date ? oldest.getTime() : new Date(oldest).getTime()) / 1000,
          )
        : overlapFromSec;
      const proposedFromSec = oldest ? Math.min(fromSec, overlapFromSec) : overlapFromSec;
      const cursorStore = createPostgresSePayReconciliationCursorStore(db);
      const cursor = await cursorStore.claim(
        "sepay",
        proposedFromSec,
        proposedToSec,
        Math.min(options.batchSize, 100),
      );
      await sql`
        update sepay_reconciliation_cursor
        set last_started_at = ${now.toISOString()}::timestamptz, updated_at = now()
        where provider = 'sepay'
      `.execute(connection);

      let summary;
      try {
        summary = await reconcileSePay(db, {
          port: options.port,
          windowFromSec: cursor.windowFromSec,
          windowToSec: cursor.windowToSec,
          maxTransactions: cursor.perPage,
          page: cursor.page,
          now,
          ...(options.rateLimiter ? { rateLimiter: options.rateLimiter } : {}),
        });
      } catch (error) {
        const errorClass = errorClassOf(error);
        const retryAfterSeconds = error instanceof SePayApiError ? error.retryAfterSeconds : null;
        const retryAfterUntil =
          retryAfterSeconds == null
            ? null
            : new Date(now.getTime() + Math.max(0, retryAfterSeconds) * 1000).toISOString();
        await sql`
          update sepay_reconciliation_cursor
          set consecutive_failures = consecutive_failures + 1,
              last_error_class = ${errorClass},
              failed = failed + 1,
              retry_after_until = ${retryAfterUntil}::timestamptz,
              updated_at = now()
          where provider = 'sepay'
        `.execute(connection);
        return { claimed: candidates.rows.length, succeeded: 0, failed: 1 };
      }

      if (summary.errors > 0) {
        await sql`
          update sepay_reconciliation_cursor
          set consecutive_failures = consecutive_failures + 1,
              last_error_class = 'APPLY_FAILED',
              pages_scanned = pages_scanned + 1,
              transactions_scanned = transactions_scanned + ${summary.scanned},
              failed = failed + ${summary.errors},
              retry_after_until = null,
              updated_at = now()
        `.execute(connection);
        return {
          claimed: candidates.rows.length,
          succeeded: Math.max(0, summary.scanned - summary.errors),
          failed: summary.errors,
        };
      }

      await sql`
        update sepay_reconciliation_cursor
        set last_success_at = ${now.toISOString()}::timestamptz,
            consecutive_failures = 0,
            last_error_class = null,
            retry_after_until = null,
            pages_scanned = pages_scanned + 1,
            transactions_scanned = transactions_scanned + ${summary.scanned},
            missing_found = missing_found + ${summary.recovered},
            backfilled = backfilled + ${summary.recovered},
            unmatched = unmatched + ${summary.discrepancies},
            last_provider_cursor = coalesce(${summary.lastProviderCursor}::text, last_provider_cursor),
            updated_at = now()
        where provider = 'sepay'
      `.execute(connection);

      if (summary.windowComplete) {
        const remainingOldest = await sql<{ created_at: Date | string | null }>`
          select min(pi.created_at) as created_at
          from payment_intent pi
          join "order" o on o.id = pi.order_id
          where pi.status in ('CREATED','PRESENTED')
            and o.status = 'PENDING_PAYMENT'
        `.execute(connection);
        const oldestPending = remainingOldest.rows[0]?.created_at;
        const nextOverlapFromSec = Math.max(0, cursor.windowToSec - SEPAY_RECOVERY_OVERLAP_SECONDS);
        const oldestPendingSec = oldestPending
          ? Math.floor(
              (oldestPending instanceof Date
                ? oldestPending.getTime()
                : new Date(oldestPending).getTime()) / 1000,
            )
          : nextOverlapFromSec;
        await cursorStore.completeWindow(
          cursor,
          Math.min(nextOverlapFromSec, oldestPendingSec),
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
