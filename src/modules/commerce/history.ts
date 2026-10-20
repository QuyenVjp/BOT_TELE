import { sql } from "kysely";
import type { Executor } from "../../infrastructure/db/transaction.js";
import type { Order, OrderStatus } from "./order.js";

/**
 * Customer-scoped Order history + detail read model (T084, FR-018, SR-003).
 *
 * Every query is hard-scoped by `customer_id`. A detail lookup that does not
 * match both order id AND customer id returns null so a guessed foreign id
 * yields no existence oracle (BOLA defense). Pagination is keyset on
 * `(created_at desc, id desc)` — stable across inserts, no OFFSET gaps.
 */

export type CustomerPaymentEvidence =
  "UNVERIFIED" | "SEPAY_SETTLED" | "WALLET_PURCHASED" | "WALLET_REFUNDED";

export interface OrderHistoryItem {
  id: string;
  orderNumber: string;
  customerId: string;
  status: OrderStatus;
  paymentEvidence: CustomerPaymentEvidence;
  productNameVi: string;
  variantNameVi: string;
  priceVnd: string;
  createdAt: string;
}

export interface CustomerOrderDetail extends Order {
  paymentEvidence: CustomerPaymentEvidence;
}

interface HistoryRow {
  id: string;
  order_number: string;
  customer_id: string;
  status: OrderStatus;
  payment_evidence: CustomerPaymentEvidence;
  product_name_vi: string;
  variant_name_vi: string;
  price_vnd: string;
  created_at: Date | string;
}

interface CustomerOrderDetailRow {
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
  fulfillment_type: Order["fulfillmentType"];
  status: OrderStatus;
  expires_at: Date | string | null;
  paid_at: Date | string | null;
  completed_at: Date | string | null;
  created_at: Date | string;
  version: number;
  payment_evidence: CustomerPaymentEvidence;
}

interface OrderTimelineRow {
  status: string;
  occurred_at: Date | string;
}

const CUSTOMER_PAYMENT_EVIDENCE_SQL = sql<CustomerPaymentEvidence>`
  case
    when exists (
      select 1
      from wallet_ledger as refund_ledger
      inner join wallet_account as refund_account
        on refund_account.id = refund_ledger.wallet_account_id
      where refund_account.customer_id = o.customer_id
        and refund_ledger.entry_type = 'CREDIT'
        and refund_ledger.amount_vnd = o.price_vnd
        and refund_ledger.idempotency_key = concat('refund:', o.id)
    ) then 'WALLET_REFUNDED'
    when exists (
      select 1
      from wallet_ledger as purchase_ledger
      inner join wallet_account as purchase_account
        on purchase_account.id = purchase_ledger.wallet_account_id
      where purchase_account.customer_id = o.customer_id
        and purchase_ledger.entry_type = 'DEBIT'
        and purchase_ledger.amount_vnd = o.price_vnd
        and purchase_ledger.idempotency_key like concat('purchase:', o.id, ':%')
    ) then 'WALLET_PURCHASED'
    when exists (
      select 1
      from payment_intent as intent
      inner join payment_allocation as allocation
        on allocation.payment_intent_id = intent.id
      inner join bank_transaction as bank_txn
        on bank_txn.id = allocation.bank_transaction_id
      where intent.order_id = o.id
        and intent.status = 'SUCCEEDED'
        and intent.amount_vnd = o.price_vnd
        and intent.merchant_account_id = bank_txn.merchant_account_id
        and allocation.status = 'SETTLED'
        and allocation.allocated_amount_vnd = o.price_vnd
        and bank_txn.provider = 'sepay'
        and bank_txn.direction = 'IN'
        and bank_txn.amount_vnd = o.price_vnd
        and bank_txn.signature_status = 'VERIFIED'
    ) then 'SEPAY_SETTLED'
    else 'UNVERIFIED'
  end
`;

interface Cursor {
  createdAt: string;
  id: string;
}
function encodeCursor(c: Cursor): string {
  return Buffer.from(`${c.createdAt}|${c.id}`, "utf8").toString("base64url");
}

function decodeCursor(raw: string): Cursor | null {
  try {
    const decoded = Buffer.from(raw, "base64url").toString("utf8");
    const idx = decoded.indexOf("|");
    if (idx < 0) return null;
    const createdAt = decoded.slice(0, idx);
    const id = decoded.slice(idx + 1);
    if (!createdAt || !id) return null;
    return { createdAt, id };
  } catch {
    return null;
  }
}

function toIso(v: Date | string): string {
  return v instanceof Date ? v.toISOString() : new Date(v).toISOString();
}

function mapItem(row: HistoryRow): OrderHistoryItem {
  return {
    id: row.id,
    orderNumber: row.order_number,
    customerId: row.customer_id,
    status: row.status,
    paymentEvidence: row.payment_evidence,
    productNameVi: row.product_name_vi,
    variantNameVi: row.variant_name_vi,
    priceVnd: String(row.price_vnd),
    createdAt: toIso(row.created_at),
  };
}

function mapDetail(row: CustomerOrderDetailRow): CustomerOrderDetail {
  const toNullableIso = (value: Date | string | null): string | null => {
    if (value === null) return null;
    return toIso(value);
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
    expiresAt: toNullableIso(row.expires_at),
    paidAt: toNullableIso(row.paid_at),
    completedAt: toNullableIso(row.completed_at),
    createdAt: toIso(row.created_at),
    version: row.version,
    paymentEvidence: row.payment_evidence,
  };
}

export interface ListOrderHistoryInput {
  customerId: string;
  limit?: number;
  cursor?: string | null;
}

export interface OrderHistoryPage {
  items: OrderHistoryItem[];
  nextCursor: string | null;
}

export interface OrderTimelineEntry {
  status: string;
  occurredAt: string;
}

/**
 * List the customer's orders newest-first, keyset-paginated.
 * Never returns another customer's rows.
 */
export async function listOrderHistory(
  exec: Executor,
  input: ListOrderHistoryInput,
): Promise<OrderHistoryPage> {
  const limit = Math.max(1, Math.min(input.limit ?? 10, 50));
  const cursor = input.cursor ? decodeCursor(input.cursor) : null;
  const fetchLimit = limit + 1;

  const cursorFilter = cursor
    ? sql`and (o.created_at, o.id) < (${cursor.createdAt}::timestamptz, ${cursor.id})`
    : sql``;

  const result = await sql<HistoryRow>`
    select o.id, o.order_number, o.customer_id, o.status,
           ${CUSTOMER_PAYMENT_EVIDENCE_SQL} as payment_evidence,
           o.product_name_vi, o.variant_name_vi, o.price_vnd, o.created_at
    from "order" as o
    where o.customer_id = ${input.customerId}
      ${cursorFilter}
    order by o.created_at desc, o.id desc
    limit ${fetchLimit}
  `.execute(exec);

  const hasMore = result.rows.length > limit;
  const items = result.rows.slice(0, limit).map(mapItem);
  const last = items[items.length - 1];
  const nextCursor =
    hasMore && last ? encodeCursor({ createdAt: last.createdAt, id: last.id }) : null;

  return { items, nextCursor };
}

/**
 * Detail lookup scoped to the customer. Returns null when the order does not
 * exist OR is not owned by the customer — callers get no distinction.
 */
export async function getOrderDetailForCustomer(
  exec: Executor,
  input: { orderId: string; customerId: string },
): Promise<CustomerOrderDetail | null> {
  const result = await sql<CustomerOrderDetailRow>`
    select o.id, o.order_number, o.idempotency_key, o.customer_id, o.variant_id,
           o.product_name_vi, o.variant_name_vi, o.price_vnd, o.duration_code,
           o.delivery_type, o.warranty_days, o.supplier_policy_snapshot,
           o.fulfillment_type, o.status, o.expires_at, o.paid_at, o.completed_at,
           o.created_at, o.version,
           ${CUSTOMER_PAYMENT_EVIDENCE_SQL} as payment_evidence
    from "order" as o
    where o.id = ${input.orderId} and o.customer_id = ${input.customerId}
    limit 1
  `.execute(exec);
  const row = result.rows[0];
  return row ? mapDetail(row) : null;
}

/**
 * Read only persisted order transitions owned by the customer.
 * Orders without transitions return an empty timeline.
 */
export async function getOrderTimelineForCustomer(
  exec: Executor,
  input: { orderId: string; customerId: string },
): Promise<OrderTimelineEntry[]> {
  const result = await sql<OrderTimelineRow>`
    select transition.to_status as status, transition.occurred_at
    from order_transition as transition
    inner join "order" as owned_order on owned_order.id = transition.order_id
    where transition.order_id = ${input.orderId}
      and owned_order.customer_id = ${input.customerId}
    order by transition.occurred_at asc, transition.id asc
    limit 20
  `.execute(exec);

  return result.rows.map((row) => ({
    status: row.status,
    occurredAt: toIso(row.occurred_at),
  }));
}
