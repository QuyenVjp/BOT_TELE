import { sql } from "kysely";
import { withTransaction, type Db } from "../../infrastructure/db/transaction.js";
import { enqueueOutboxEvent } from "../../infrastructure/outbox/repository.js";
import { appendAuditEvent } from "../identity/audit.js";
import {
  authorizeSensitiveAdminAction,
  SensitiveAuthorizationRefusedError,
  type SensitiveActionDeps,
} from "../identity/sensitive-action.js";
import {
  authorizeRootAction,
  type RootActor,
  type RootAdminConfig,
} from "../identity/root-admin.js";
import type { Executor } from "../../infrastructure/db/transaction.js";
import { newId } from "../../shared/ids/index.js";

export async function emitQuantityStockDeltaEvents(
  exec: Executor,
  input: {
    variantId: string;
    delta: number;
    stockBefore: number;
    stockAfter: number;
    version: number;
    correlationId: string;
  },
): Promise<void> {
  const variant = await sql<{ low_stock_threshold: number | null }>`
    select low_stock_threshold from product_variant where id = ${input.variantId} limit 1
  `.execute(exec);
  const threshold = variant.rows[0]?.low_stock_threshold ?? null;
  const lowStockAlert =
    threshold !== null &&
    threshold > 0 &&
    input.stockBefore > threshold &&
    input.stockAfter <= threshold;
  const restock = input.stockBefore === 0 && input.stockAfter > 0;
  if (!lowStockAlert && !restock) return;
  await enqueueOutboxEvent(exec, {
    id: newId(),
    aggregateType: "QuantityStock",
    aggregateId: input.variantId,
    aggregateVersion: input.version,
    eventType: "StockDelta",
    payloadRedacted: {
      variantId: input.variantId,
      delta: input.delta,
      stockAfter: input.stockAfter,
      source: "QUANTITY",
      correlationId: input.correlationId,
      ...(restock ? { announce: true } : {}),
      ...(lowStockAlert ? { lowStockAlert: true, threshold } : {}),
    },
  });
}

export type QuantityStockAdjustmentResult =
  | {
      ok: true;
      variantId: string;
      previousQuantity: number;
      availableQuantity: number;
      version: number;
      idempotent: boolean;
    }
  | {
      ok: false;
      code:
        | "NOT_FOUND"
        | "WRONG_VERSION"
        | "NEGATIVE_STOCK"
        | "INVALID_DELTA"
        | "NOT_ROOT_ADMIN"
        | "WRONG_CONTEXT";
    };

export interface QuantityStockHistoryRow {
  productId: string;
  variantId: string;
  variantName: string;
  label: string;
  detail: string;
  occurredAt: string;
}

export type QuantityStockHistoryResult =
  | {
      ok: true;
      productId: string;
      variantId: string;
      variantName: string;
      rows: QuantityStockHistoryRow[];
    }
  | { ok: false; code: "NOT_FOUND" | "NOT_ROOT_ADMIN" | "WRONG_CONTEXT" };

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export async function listVariantInventoryHistory(input: {
  db: Db;
  actor: RootActor;
  config: RootAdminConfig;
  variantId: string;
  correlationId: string;
  limit?: number;
}): Promise<QuantityStockHistoryResult> {
  const auth = authorizeRootAction(input.actor, input.config);
  if (!auth.ok) return { ok: false, code: auth.reason };
  const limit = Math.max(1, Math.min(input.limit ?? 10, 20));
  const result = await sql<{
    product_id: string;
    variant_id: string;
    variant_name: string;
    label: string | null;
    detail: string | null;
    occurred_at: Date | string | null;
  }>`
    with variant as (
      select product_id, id as variant_id, name_vi as variant_name
      from product_variant
      where id = ${input.variantId}
      limit 1
    ), history as (
      select
        case entry_type when 'ADJUST' then 'Điều chỉnh số lượng' when 'RESERVE' then 'Giữ hàng' when 'RELEASE' then 'Trả hàng đã giữ' when 'DELIVER' then 'Giao hàng' end as label,
        ('đổi ' || quantity_delta::text || ', còn ' || quantity_after::text) as detail,
        created_at as occurred_at
      from quantity_stock_ledger
      where variant_id = ${input.variantId}
      union all
      select
        'Nhập kho' as label,
        ('mới ' || coalesce((metadata_redacted->>'imported')::int, 0)::text ||
          ', trùng ' || coalesce((metadata_redacted->>'duplicates')::int, 0)::text ||
          ', lỗi ' || coalesce((metadata_redacted->>'invalid')::int, 0)::text) as detail,
        occurred_at
      from audit_event
      where target_type = 'DigitalAsset'
        and target_id = ${input.variantId}
        and action = 'inventory.import'
    )
    select v.product_id, v.variant_id, v.variant_name, h.label, h.detail, h.occurred_at
    from variant v
    left join lateral (
      select label, detail, occurred_at from history order by occurred_at desc limit ${limit}
    ) h on true
    order by h.occurred_at desc nulls last
  `.execute(input.db);
  if (result.rows.length === 0) return { ok: false, code: "NOT_FOUND" };
  const first = result.rows[0];
  if (!first) return { ok: false, code: "NOT_FOUND" };
  return {
    ok: true,
    productId: first.product_id,
    variantId: first.variant_id,
    variantName: first.variant_name,
    rows: result.rows.flatMap((row) =>
      row.label && row.detail && row.occurred_at
        ? [
            {
              productId: row.product_id,
              variantId: row.variant_id,
              variantName: row.variant_name,
              label: row.label,
              detail: row.detail,
              occurredAt: iso(row.occurred_at),
            },
          ]
        : [],
    ),
  };
}

export async function adjustQuantityStock(input: {
  db: Db;
  actor: RootActor;
  config: RootAdminConfig;
  /** Step-up deps for an inventory-value change. Required; see the refusal below. */
  sensitiveDeps?: SensitiveActionDeps;
  variantId: string;
  delta: number;
  expectedStockVersion: number;
  idempotencyKey: string;
  reason: string;
  correlationId: string;
}): Promise<QuantityStockAdjustmentResult> {
  const auth = authorizeRootAction(input.actor, input.config);
  if (!auth.ok) return { ok: false, code: auth.reason };
  if (!Number.isInteger(input.delta) || input.delta === 0 || Math.abs(input.delta) > 1_000_000)
    return { ok: false, code: "INVALID_DELTA" };
  if (!Number.isInteger(input.expectedStockVersion) || input.expectedStockVersion < 1)
    return { ok: false, code: "WRONG_VERSION" };
  const reason = input.reason.trim().slice(0, 200);
  if (!reason) return { ok: false, code: "INVALID_DELTA" };
  // Second factor for inventory value. A missing deps object is a programming error, and a
  // refused grant throws before the UPDATE runs, so neither can silently downgrade this.
  if (!input.sensitiveDeps) throw new Error("STEP_UP_DEPS_MISSING");
  const authorized = await authorizeSensitiveAdminAction(input.sensitiveDeps, {
    actor: input.actor,
    actionKey: "inventory.stock.adjust",
    resourceType: "ProductVariant",
    resourceId: input.variantId,
    correlationId: input.correlationId,
    requestedData: {
      variantId: input.variantId,
      delta: input.delta,
      expectedStockVersion: input.expectedStockVersion,
      idempotencyKey: input.idempotencyKey,
    },
    consumeGrant: true,
  });
  if (!authorized.ok) throw new SensitiveAuthorizationRefusedError(authorized.code);

  return withTransaction(input.db, async (trx) => {
    const priorLedger = await sql<{
      variant_id: string;
      quantity_delta: number;
      quantity_after: number;
    }>`
      select variant_id, quantity_delta::int, quantity_after::int
      from quantity_stock_ledger
      where entry_type = 'ADJUST' and idempotency_key = ${input.idempotencyKey}
      limit 1
      for update
    `.execute(trx);
    const existing = priorLedger.rows[0];
    if (existing) {
      const current = await sql<{ available_quantity: number; version: number }>`
        select available_quantity::int, version::int from variant_quantity_stock where variant_id = ${input.variantId}
      `.execute(trx);
      const stock = current.rows[0];
      if (existing.variant_id !== input.variantId || existing.quantity_delta !== input.delta)
        return { ok: false, code: "INVALID_DELTA" };
      return stock
        ? {
            ok: true,
            variantId: input.variantId,
            previousQuantity: existing.quantity_after - existing.quantity_delta,
            availableQuantity: stock.available_quantity,
            version: stock.version,
            idempotent: true,
          }
        : { ok: false, code: "NOT_FOUND" };
    }

    const current = await sql<{ available_quantity: number; version: number }>`
      select s.available_quantity::int, s.version::int
      from variant_quantity_stock s
      join product_variant v on v.id = s.variant_id and v.fulfillment_type = 'QUANTITY_STOCK' and v.is_active
      where s.variant_id = ${input.variantId}
      for update of s
    `.execute(trx);
    const stock = current.rows[0];
    if (!stock) return { ok: false, code: "NOT_FOUND" };
    const replay = await sql<{
      variant_id: string;
      quantity_delta: number;
      quantity_after: number;
    }>`
      select variant_id, quantity_delta::int, quantity_after::int
      from quantity_stock_ledger
      where entry_type = 'ADJUST' and idempotency_key = ${input.idempotencyKey}
      limit 1
    `.execute(trx);
    const replayed = replay.rows[0];
    if (replayed) {
      if (replayed.variant_id !== input.variantId || replayed.quantity_delta !== input.delta)
        return { ok: false, code: "INVALID_DELTA" };
      return {
        ok: true,
        variantId: input.variantId,
        previousQuantity: replayed.quantity_after - replayed.quantity_delta,
        availableQuantity: stock.available_quantity,
        version: stock.version,
        idempotent: true,
      };
    }
    if (stock.version !== input.expectedStockVersion) return { ok: false, code: "WRONG_VERSION" };
    const nextQuantity = stock.available_quantity + input.delta;
    if (nextQuantity < 0) return { ok: false, code: "NEGATIVE_STOCK" };

    const nextVersion = stock.version + 1;
    await sql`
      update variant_quantity_stock
      set available_quantity = ${nextQuantity}, version = ${nextVersion}, updated_at = now()
      where variant_id = ${input.variantId} and version = ${stock.version}
    `.execute(trx);
    await sql`
      insert into quantity_stock_ledger
        (id, variant_id, entry_type, quantity_delta, quantity_after, idempotency_key)
      values (${newId()}, ${input.variantId}, 'ADJUST', ${input.delta}, ${nextQuantity}, ${input.idempotencyKey})
    `.execute(trx);
    await emitQuantityStockDeltaEvents(trx, {
      variantId: input.variantId,
      delta: input.delta,
      stockBefore: stock.available_quantity,
      stockAfter: nextQuantity,
      version: nextVersion,
      correlationId: input.correlationId,
    });
    await appendAuditEvent(trx, {
      actorType: "ROOT_ADMIN",
      actorId: String(input.actor.numericUserId),
      action: "quantity_stock.adjusted",
      targetType: "ProductVariant",
      targetId: input.variantId,
      reason,
      correlationId: input.correlationId,
      metadataRedacted: {
        delta: input.delta,
        previousQuantity: stock.available_quantity,
        availableQuantity: nextQuantity,
        version: stock.version + 1,
      },
    });
    return {
      ok: true,
      variantId: input.variantId,
      previousQuantity: stock.available_quantity,
      availableQuantity: nextQuantity,
      version: stock.version + 1,
      idempotent: false,
    };
  });
}
