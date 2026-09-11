import { sql } from "kysely";
import type { Executor } from "../../infrastructure/db/transaction.js";
import type { Order, OrderStatus } from "./order.js";
import { findOrderByIdForOwner } from "./repository.js";

/**
 * Customer-scoped Order history + detail read model (T084, FR-018, SR-003).
 *
 * Every query is hard-scoped by `customer_id`. A detail lookup that does not
 * match both order id AND customer id returns null so a guessed foreign id
 * yields no existence oracle (BOLA defense). Pagination is keyset on
 * `(created_at desc, id desc)` — stable across inserts, no OFFSET gaps.
 */

export interface OrderHistoryItem {
  id: string;
  orderNumber: string;
  customerId: string;
  status: OrderStatus;
  productNameVi: string;
  variantNameVi: string;
  priceVnd: string;
  createdAt: string;
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

interface HistoryRow {
  id: string;
  order_number: string;
  customer_id: string;
  status: OrderStatus;
  product_name_vi: string;
  variant_name_vi: string;
  price_vnd: string;
  created_at: Date | string;
}

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
    productNameVi: row.product_name_vi,
    variantNameVi: row.variant_name_vi,
    priceVnd: String(row.price_vnd),
    createdAt: toIso(row.created_at),
  };
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
    ? sql`and (created_at, id) < (${cursor.createdAt}::timestamptz, ${cursor.id})`
    : sql``;

  const result = await sql<HistoryRow>`
    select id, order_number, customer_id, status, product_name_vi, variant_name_vi,
           price_vnd, created_at
    from "order"
    where customer_id = ${input.customerId}
      ${cursorFilter}
    order by created_at desc, id desc
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
): Promise<Order | null> {
  // Ownership lives in the query, so a foreign order and a missing one are the same `null`.
  return findOrderByIdForOwner(exec, input.orderId, input.customerId);
}
