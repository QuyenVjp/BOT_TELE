import { sql } from "kysely";
import type { Db } from "../../infrastructure/db/transaction.js";
import { withTransaction } from "../../infrastructure/db/transaction.js";
import type { Vault } from "../../infrastructure/vault/port.js";
import {
  ageSeconds,
  validateRecoveryBatchSize,
  type RecoveryTelemetry,
} from "../recovery-result.js";
import { hasSupplierCapability, type SupplierPort, type SupplierProvider } from "./port.js";
import { recoverUnknownSupplierOrder } from "./service.js";

interface SupplierRecoveryRow {
  id: string;
  supplier_id: string;
  idempotency_key: string;
  external_order_id: string | null;
  external_sku: string;
  delivery_type: string;
  duration_code: string;
  region: string | null;
}

export async function recoverSupplierOrdersBatch(
  db: Db,
  options: {
    batchSize: number;
    now?: Date;
    retryDelaySeconds?: number;
    resolvePort: (supplierId: string) => SupplierPort | null;
    vault: Vault;
  },
): Promise<RecoveryTelemetry> {
  validateRecoveryBatchSize(options.batchSize);
  const now = options.now ?? new Date();
  const retryDelaySeconds = options.retryDelaySeconds ?? 60;
  if (!Number.isInteger(retryDelaySeconds) || retryDelaySeconds < 1 || retryDelaySeconds > 3600) {
    throw new RangeError("supplier retryDelaySeconds must be an integer between 1 and 3600");
  }

  let claimed = 0;
  let succeeded = 0;
  let failed = 0;
  for (let index = 0; index < options.batchSize; index += 1) {
    const candidate = await withTransaction(db, async (trx) => {
      const selected = await sql<SupplierRecoveryRow>`
        select so.id, so.supplier_id, so.idempotency_key, so.external_order_id,
               ss.external_sku, o.delivery_type, o.duration_code, ss.region
        from supplier_order so
        join supplier_sku ss on ss.id = so.supplier_sku_id
        join "order" o on o.id = so.order_id
        where so.needs_review_at is null
          and (
            so.status in ('UNKNOWN','PENDING')
            or (so.status = 'SUBMITTED' and so.submitted_at <= ${new Date(now.getTime() - retryDelaySeconds * 1000).toISOString()})
          )
          and coalesce(so.next_reconcile_at, so.last_queried_at, so.submitted_at, now())
              <= ${now.toISOString()}
        order by coalesce(so.next_reconcile_at, so.last_queried_at, so.submitted_at) asc nulls first,
                 so.id asc
        limit 1
        for update of so skip locked
      `.execute(trx);
      const row = selected.rows[0];
      if (!row) return null;
      await sql`
        update supplier_order
        set next_reconcile_at = ${new Date(now.getTime() + retryDelaySeconds * 1000).toISOString()}
        where id = ${row.id}
      `.execute(trx);
      return row;
    });
    if (!candidate) break;
    claimed += 1;

    try {
      const port = options.resolvePort(candidate.supplier_id);
      if (!port) throw new Error("supplier recovery port unavailable");
      if (
        "capabilities" in port &&
        !hasSupplierCapability(port as SupplierProvider, "ORDER_READ")
      ) {
        await sql`
          update supplier_order
          set last_error_code = 'UNSUPPORTED', needs_review_at = now(), next_reconcile_at = null,
              version = version + 1
          where id = ${candidate.id}
        `.execute(db);
        failed += 1;
        continue;
      }
      const result = await recoverUnknownSupplierOrder(db, {
        supplierOrderId: candidate.id,
        queryKey: candidate.external_order_id ?? candidate.idempotency_key,
        expectedSku: candidate.external_sku,
        deliveryType: candidate.delivery_type,
        durationCode: candidate.duration_code,
        region: candidate.region,
        correlationId: `supplier-recovery:${candidate.id}`,
        port,
        vault: options.vault,
      });
      if (result.ok) succeeded += 1;
      else failed += 1;
    } catch {
      failed += 1;
    }
  }

  const remaining = await sql<{ backlog: number; oldest: Date | string | null }>`
    select count(*)::int as backlog, min(coalesce(submitted_at, last_queried_at)) as oldest
    from supplier_order
    where needs_review_at is null
      and status in ('UNKNOWN','PENDING','SUBMITTED')
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
