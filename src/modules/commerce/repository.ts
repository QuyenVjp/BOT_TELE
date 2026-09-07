import { sql } from "kysely";
import type { Executor } from "../../infrastructure/db/transaction.js";
import { newId } from "../../shared/ids/index.js";
import { nextVersion, assertVersionUpdated } from "../../infrastructure/db/version.js";
import { assertTransition, type Order, type OrderSnapshot, type OrderStatus } from "./order.js";
import type { FulfillmentType } from "../catalog/fulfillment-type.js";

/**
 * Order persistence + unique-effect conflict mapping (T049).
 *
 * Writes always go through the typed transaction boundary so the order row, the
 * order_transition audit row, and any outbox event commit together. The exact
 * (customer_id, idempotency_key) conflict target uses ON CONFLICT DO NOTHING;
 * unrelated uniqueness failures still abort instead of being swallowed.
 */

export interface InsertOrderInput {
  customerId: string;
  variantId: string;
  idempotencyKey: string | null;
  snapshot: OrderSnapshot;
  status: OrderStatus;
  expiresAt: Date | null;
  correlationId: string;
  actorType: string;
  actorId: string | null;
}

function mapRow(row: {
  id: string;
  order_number: string;
  idempotency_key: string | null;
  customer_id: string;
  variant_id: string;
  product_name_vi: string;
  variant_name_vi: string;
  price_vnd: string;
  duration_code: string;
  delivery_type: string;
  warranty_days: number;
  supplier_policy_snapshot: string | null;
  fulfillment_type: FulfillmentType;
  status: OrderStatus;
  expires_at: Date | string | null;
  paid_at: Date | string | null;
  completed_at: Date | string | null;
  created_at: Date | string;
  version: number;
}): Order {
  const toIso = (v: Date | string | null): string | null => {
    if (v === null) return null;
    return v instanceof Date ? v.toISOString() : new Date(v).toISOString();
  };
  return {
    id: row.id,
    orderNumber: row.order_number,
    idempotencyKey: row.idempotency_key,
    customerId: row.customer_id,
    variantId: row.variant_id,
    productNameVi: row.product_name_vi,
    variantNameVi: row.variant_name_vi,
    priceVnd: String(row.price_vnd),
    durationCode: row.duration_code,
    deliveryType: row.delivery_type,
    warrantyDays: row.warranty_days,
    supplierPolicySnapshot: row.supplier_policy_snapshot,
    fulfillmentType: row.fulfillment_type,
    status: row.status,
    expiresAt: toIso(row.expires_at),
    paidAt: toIso(row.paid_at),
    completedAt: toIso(row.completed_at),
    createdAt: toIso(row.created_at) ?? new Date().toISOString(),
    version: row.version,
  };
}

/** Public order number: ORD-YYYYMMDD-XXXXXXXX (non-secret, human-friendly). */
export function generateOrderNumber(now: Date = new Date()): string {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  const d = String(now.getUTCDate()).padStart(2, "0");
  const suffix = newId().slice(-8);
  return `ORD-${y}${m}${d}-${suffix}`;
}

export async function findOrderByIdempotency(
  exec: Executor,
  customerId: string,
  idempotencyKey: string,
): Promise<Order | null> {
  const result = await sql<Parameters<typeof mapRow>[0]>`
    select * from "order"
    where customer_id = ${customerId} and idempotency_key = ${idempotencyKey}
    limit 1
  `.execute(exec);
  const row = result.rows[0];
  return row ? mapRow(row) : null;
}

export async function findOrderById(exec: Executor, orderId: string): Promise<Order | null> {
  const result = await sql<Parameters<typeof mapRow>[0]>`
    select * from "order" where id = ${orderId} limit 1
  `.execute(exec);
  const row = result.rows[0];
  return row ? mapRow(row) : null;
}

/** Lock and re-read an Order before money-sensitive state transitions. */
export async function findOrderByIdForUpdate(
  exec: Executor,
  orderId: string,
): Promise<Order | null> {
  const result = await sql<Parameters<typeof mapRow>[0]>`
    select * from "order" where id = ${orderId} limit 1 for update
  `.execute(exec);
  const row = result.rows[0];
  return row ? mapRow(row) : null;
}

/** Resolve an order by its public order number (used by callback tokens). */
export async function findOrderByNumber(
  exec: Executor,
  orderNumber: string,
): Promise<Order | null> {
  const result = await sql<Parameters<typeof mapRow>[0]>`
    select * from "order" where order_number = ${orderNumber} limit 1
  `.execute(exec);
  const row = result.rows[0];
  return row ? mapRow(row) : null;
}

/**
 * Insert a new Order + the first transition in one transaction unit.
 * On unique-violation of the idempotency key, re-reads and returns the
 * existing order (exactly-once business effect).
 */
export interface InsertOrderResult {
  order: Order;
  inserted: boolean;
}

export async function insertOrder(
  exec: Executor,
  input: InsertOrderInput,
): Promise<InsertOrderResult> {
  const id = newId();
  const orderNumber = generateOrderNumber();
  const s = input.snapshot;

  const inserted = await sql<Parameters<typeof mapRow>[0]>`
      insert into "order"
        (id, order_number, idempotency_key, customer_id, variant_id,
         product_name_vi, variant_name_vi, price_vnd, duration_code, delivery_type,
         warranty_days, supplier_policy_snapshot, fulfillment_type, status, expires_at)
      values
        (${id}, ${orderNumber}, ${input.idempotencyKey}, ${input.customerId}, ${input.variantId},
         ${s.productNameVi}, ${s.variantNameVi}, ${s.priceVnd}, ${s.durationCode}, ${s.deliveryType},
         ${s.warrantyDays}, ${s.supplierPolicySnapshot}, ${s.fulfillmentType}, ${input.status},
         ${input.expiresAt ? input.expiresAt.toISOString() : null})
      on conflict (customer_id, idempotency_key)
        where idempotency_key is not null
        do nothing
      returning *
    `.execute(exec);

  const insertedRow = inserted.rows[0];
  if (!insertedRow) {
    if (!input.idempotencyKey) {
      throw new Error("order insert returned no row without an idempotency key");
    }
    // ON CONFLICT waits for an uncommitted winner before returning. This next
    // READ COMMITTED statement therefore sees the committed winner without a
    // spin loop and without querying an aborted transaction.
    const winner = await findOrderByIdempotency(exec, input.customerId, input.idempotencyKey);
    if (!winner) throw new Error("idempotency winner was not visible after conflict wait");
    return { order: winner, inserted: false };
  }

  await sql`
    insert into order_transition
      (id, order_id, from_status, to_status, reason_code, actor_type, actor_id, correlation_id)
    values
      (${newId()}, ${id}, 'DRAFT', ${input.status}, 'BUY_NOW',
       ${input.actorType}, ${input.actorId}, ${input.correlationId})
  `.execute(exec);

  return { order: mapRow(insertedRow), inserted: true };
}

export async function transitionOrder(
  exec: Executor,
  order: Order,
  to: OrderStatus,
  reasonCode: string,
  correlationId: string,
  actor: { type: string; id: string | null },
): Promise<Order> {
  assertTransition(order.status, to);
  const newVersion = nextVersion(order.version);

  const result = await sql`
    update "order"
    set status = ${to},
        version = ${newVersion},
        updated_at = now(),
        paid_at = case when ${to} = 'PAID' then now() else paid_at end,
        completed_at = case when ${to} = 'COMPLETED' then now() else completed_at end
    where id = ${order.id} and version = ${order.version}
  `.execute(exec);

  assertVersionUpdated(
    { numUpdatedRows: BigInt(result.numAffectedRows ?? 0) },
    "order",
    order.id,
    order.version,
  );

  await sql`
    insert into order_transition
      (id, order_id, from_status, to_status, reason_code, actor_type, actor_id, correlation_id)
    values
      (${newId()}, ${order.id}, ${order.status}, ${to}, ${reasonCode},
       ${actor.type}, ${actor.id}, ${correlationId})
  `.execute(exec);

  const updated = await findOrderById(exec, order.id);
  if (!updated) throw new Error("order vanished after transition");
  return updated;
}

/** Find unpaid orders whose expires_at is in the past. */
export async function findExpirableOrders(exec: Executor, now: Date): Promise<Order[]> {
  const result = await sql<Parameters<typeof mapRow>[0]>`
    select * from "order"
    where status = 'PENDING_PAYMENT'
      and expires_at is not null
      and expires_at < ${now.toISOString()}
  `.execute(exec);
  return result.rows.map(mapRow);
}
