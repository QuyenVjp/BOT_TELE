import { sql } from "kysely";
import type { Executor } from "../../infrastructure/db/transaction.js";
import { isId } from "../../shared/ids/index.js";
import {
  createAdminCallbackState,
  resolveAdminCallbackState,
  type AdminStateKind,
} from "./customer-operations.js";

export type AdminOrderStatusFilter =
  | "all"
  | "pending_payment"
  | "paid"
  | "processing"
  | "completed"
  | "payment_review"
  | "fulfillment_review"
  | "refunds";

export interface AdminOrderListItem {
  id: string;
  stateId: string;
  orderNumber: string;
  customerId: string;
  telegramUserId: string | null;
  displayName: string | null;
  status: string;
  paymentStatus: string | null;
  fulfillmentStatus: string | null;
  priceVnd: bigint;
  productName: string;
  variantName: string;
  createdAt: string;
}

export interface AdminOrderListPage {
  items: AdminOrderListItem[];
  nextStateId: string | null;
  filter: AdminOrderStatusFilter;
  query: string | null;
}

export interface AdminOrderDetail {
  id: string;
  orderNumber: string;
  customerId: string;
  telegramUserId: string | null;
  username: string | null;
  displayName: string | null;
  phoneNumber: string | null;
  reachable: boolean;
  productName: string;
  variantName: string;
  priceVnd: bigint;
  durationCode: string;
  deliveryType: string;
  fulfillmentType: string;
  supplierPolicySnapshot: string | null;
  orderStatus: string;
  paidAt: string | null;
  completedAt: string | null;
  createdAt: string;
  paymentStatus: string | null;
  paymentAmountVnd: bigint | null;
  paymentPresentedAt: string | null;
  paymentSettledAt: string | null;
  fulfillmentStatus: string | null;
  fulfillmentCreatedAt: string | null;
  manualTaskStatus: string | null;
  deliveryReview?: {
    assetStatus: string | null;
    assetRef: string | null;
    bundleStatus: string | null;
    handoffStatus: string | null;
    handoffSentAt: string | null;
    providerMessageIdPresent: boolean;
    providerChatMatches: boolean;
    providerSuccessAt: string | null;
    sendAttemptedAt: string | null;
    evidenceComplete: boolean;
  };
  messageStateId: string;
}

interface OrderRow {
  id: string;
  order_number: string;
  customer_id: string;
  telegram_user_id: string | null;
  display_name: string | null;
  status: string;
  payment_status: string | null;
  fulfillment_status: string | null;
  price_vnd: string | number;
  product_name_vi: string;
  variant_name_vi: string;
  created_at: Date | string;
}

interface OrderDetailRow extends OrderRow {
  username: string | null;
  phone_number: string | null;
  reachable: boolean | null;
  duration_code: string;
  delivery_type: string;
  fulfillment_type: string;
  supplier_policy_snapshot: string | null;
  paid_at: Date | string | null;
  completed_at: Date | string | null;
  payment_amount_vnd: string | number | null;
  payment_presented_at: Date | string | null;
  payment_settled_at: Date | string | null;
  fulfillment_created_at: Date | string | null;
  manual_task_status: string | null;
  allocation_settled: boolean;
  asset_status: string | null;
  asset_ref: string | null;
  review_handoff_status: string | null;
  review_handoff_sent_at: Date | string | null;
  provider_message_id: string | null;
  provider_chat_matches: boolean;
  provider_success_at: string | null;
  send_attempted_at: string | null;
  evidence_complete: boolean;
}

function clampLimit(limit?: number): number {
  return Number.isInteger(limit) ? Math.max(1, Math.min(10, limit!)) : 8;
}

function cleanQuery(query?: string | null): string | null {
  const q = query?.trim();
  return q ? q.slice(0, 80) : null;
}

function parseCursor(cursor?: string | null): { id: string; createdAt: string } | null {
  if (!cursor) return null;
  try {
    const parsed = JSON.parse(cursor) as Partial<{ id: string; createdAt: string }>;
    return parsed.id && isId(parsed.id) && parsed.createdAt
      ? { id: parsed.id, createdAt: parsed.createdAt }
      : null;
  } catch {
    return isId(cursor) ? { id: cursor, createdAt: "9999-12-31T23:59:59.999Z" } : null;
  }
}

function cursorFor(row: OrderRow): string {
  return JSON.stringify({ id: row.id, createdAt: new Date(row.created_at).toISOString() });
}

function statusWhere(filter: AdminOrderStatusFilter) {
  switch (filter) {
    case "pending_payment":
      return sql`and o.status = 'PENDING_PAYMENT'`;
    case "paid":
      return sql`and o.status = 'PAID'`;
    case "processing":
      return sql`and o.status = 'PROCESSING'`;
    case "completed":
      return sql`and o.status = 'COMPLETED'`;
    case "payment_review":
      return sql`and o.status = 'PAYMENT_NEEDS_REVIEW'`;
    case "fulfillment_review":
      return sql`and o.status = 'FULFILLMENT_NEEDS_REVIEW'`;
    case "refunds":
      return sql`and o.status in ('REFUND_PENDING','REFUNDED')`;
    case "all":
      return sql``;
  }
}

export function isAdminOrderStatusFilter(value: string): value is AdminOrderStatusFilter {
  return [
    "all",
    "pending_payment",
    "paid",
    "processing",
    "completed",
    "payment_review",
    "fulfillment_review",
    "refunds",
  ].includes(value);
}

function mapOrder(row: OrderRow, stateId: string): AdminOrderListItem {
  return {
    id: row.id,
    stateId,
    orderNumber: row.order_number,
    customerId: row.customer_id,
    telegramUserId: row.telegram_user_id,
    displayName: row.display_name,
    status: row.status,
    paymentStatus: row.payment_status,
    fulfillmentStatus: row.fulfillment_status,
    priceVnd: BigInt(row.price_vnd),
    productName: row.product_name_vi,
    variantName: row.variant_name_vi,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

export async function listAdminOrders(
  exec: Executor,
  input: {
    adminTelegramUserId: string;
    filter?: AdminOrderStatusFilter;
    query?: string | null;
    cursor?: string | null;
    limit?: number;
  },
): Promise<AdminOrderListPage> {
  const filter = input.filter ?? "all";
  const query = cleanQuery(input.query);
  const limit = clampLimit(input.limit);
  const cursor = parseCursor(input.cursor);
  const fetchLimit = limit + 1;
  const orderNo = query && /^ORD-/i.test(query) ? `%${query.toUpperCase()}%` : null;
  const numeric = query && /^\d{1,20}$/.test(query) ? query : null;
  const queryWhere = query
    ? sql`and (
      (${orderNo}::text is not null and upper(o.order_number) like ${orderNo})
      or (${numeric}::text is not null and (cps.telegram_user_id = ${numeric} or cps.chat_id = ${numeric} or ci.channel_user_id = ${numeric}))
    )`
    : sql``;
  const cursorWhere = cursor
    ? sql`and (o.created_at < ${cursor.createdAt}::timestamptz or (o.created_at = ${cursor.createdAt}::timestamptz and o.id > ${cursor.id}))`
    : sql``;
  const rows = await sql<OrderRow>`
    select o.id, o.order_number, o.customer_id,
      coalesce(cps.telegram_user_id, ci.channel_user_id) as telegram_user_id,
      cps.display_name,
      o.status,
      (select pi.status from payment_intent pi where pi.order_id = o.id order by pi.created_at desc, pi.id desc limit 1) as payment_status,
      coalesce(
        (select db.status from delivery_bundle db where db.order_id = o.id order by db.created_at desc, db.id desc limit 1),
        (select mft.status from manual_fulfillment_task mft where mft.order_id = o.id order by mft.created_at desc, mft.id desc limit 1)
      ) as fulfillment_status,
      o.price_vnd, o.product_name_vi, o.variant_name_vi, o.created_at
    from "order" o
    left join customer_profile_snapshot cps on cps.customer_id = o.customer_id
    left join channel_identity ci on ci.customer_id = o.customer_id and ci.channel = 'TELEGRAM'
    where true
      ${statusWhere(filter)}
      ${queryWhere}
      ${cursorWhere}
    order by o.created_at desc, o.id asc
    limit ${fetchLimit}
  `.execute(exec);

  const visible = rows.rows.slice(0, limit);
  const items = await Promise.all(
    visible.map(async (row) =>
      mapOrder(
        row,
        await createAdminCallbackState(exec, {
          adminTelegramUserId: input.adminTelegramUserId,
          kind: "ORDER_DETAIL",
          payload: { orderId: row.id },
        }),
      ),
    ),
  );
  const last = visible.at(-1);
  const nextStateId =
    rows.rows.length > limit && last
      ? await createAdminCallbackState(exec, {
          adminTelegramUserId: input.adminTelegramUserId,
          kind: "ORDER_PAGE",
          payload: { filter, query, cursor: cursorFor(last) },
        })
      : null;
  return { items, nextStateId, filter, query };
}

export async function resolveAdminOrderState(
  exec: Executor,
  input: { adminTelegramUserId: string; stateId: string },
): Promise<{
  kind: AdminStateKind;
  orderId?: string;
  filter?: AdminOrderStatusFilter;
  query?: string | null;
  cursor?: string | null;
} | null> {
  const state = await resolveAdminCallbackState(exec, input);
  if (!state) return null;
  if (
    (state.kind === "ORDER_DETAIL" || state.kind === "ORDER_MESSAGE_PROMPT") &&
    typeof state.payload.orderId === "string"
  ) {
    return { kind: state.kind, orderId: state.payload.orderId };
  }
  if (state.kind === "ORDER_PAGE") {
    const filter =
      typeof state.payload.filter === "string" && isAdminOrderStatusFilter(state.payload.filter)
        ? state.payload.filter
        : "all";
    return {
      kind: state.kind,
      filter,
      query: typeof state.payload.query === "string" ? state.payload.query : null,
      cursor: typeof state.payload.cursor === "string" ? state.payload.cursor : null,
    };
  }
  return null;
}

export async function getAdminOrderDetail(
  exec: Executor,
  input: { adminTelegramUserId: string; orderId: string },
): Promise<AdminOrderDetail | null> {
  if (!isId(input.orderId)) return null;
  const result = await sql<OrderDetailRow>`
    select o.id, o.order_number, o.customer_id,
      coalesce(cps.telegram_user_id, ci.channel_user_id) as telegram_user_id,
      coalesce(cps.username, ci.observed_username) as username,
      cps.display_name,
      case when cps.phone_shared_at is not null then cps.phone_number end as phone_number,
      cps.reachable,
      o.status,
      o.price_vnd, o.product_name_vi, o.variant_name_vi, o.duration_code, o.delivery_type,
      o.fulfillment_type, o.supplier_policy_snapshot, o.paid_at, o.completed_at, o.created_at,
      pi.status as payment_status, pi.amount_vnd as payment_amount_vnd,
      pi.presented_at as payment_presented_at, pi.settled_at as payment_settled_at,
      exists (
        select 1 from payment_allocation pa
        where pa.payment_intent_id = pi.id and pa.status = 'SETTLED'
      ) as allocation_settled,
      db.status as fulfillment_status, db.created_at as fulfillment_created_at,
      da.status as asset_status, da.id as asset_ref,
      dnh.status as review_handoff_status, dnh.sent_at as review_handoff_sent_at,
      dnh.payload_redacted->>'providerMessageId' as provider_message_id,
      coalesce(
        dnh.payload_redacted->>'providerChatId' is not null
          and dnh.payload_redacted->>'providerChatId' = coalesce(cps.telegram_user_id, ci.channel_user_id),
        false
      ) as provider_chat_matches,
      dnh.payload_redacted->>'providerSucceededAt' as provider_success_at,
      dnh.payload_redacted->>'sendAttemptedAt' as send_attempted_at,
      coalesce(
        pi.status = 'SUCCEEDED'
        and exists (
          select 1 from payment_allocation pa
          where pa.payment_intent_id = pi.id and pa.status = 'SETTLED'
        )
        and db.status = 'EXPIRED'
        and da.status = 'READY'
        and dnh.status = 'SENT'
        and dnh.sent_at is not null
        and dnh.payload_redacted->>'providerMessageId' is not null
        and dnh.payload_redacted->>'providerSucceededAt' is not null
        and dnh.payload_redacted->>'providerChatId' = coalesce(cps.telegram_user_id, ci.channel_user_id),
        false
      ) as evidence_complete,
      mft.status as manual_task_status
    from "order" o
    left join customer_profile_snapshot cps on cps.customer_id = o.customer_id
    left join channel_identity ci on ci.customer_id = o.customer_id and ci.channel = 'TELEGRAM'
    left join lateral (
      select id, status, amount_vnd, presented_at, settled_at
      from payment_intent
      where order_id = o.id
      order by created_at desc, id desc
      limit 1
    ) pi on true
    left join lateral (
      select id, asset_id, status, created_at
      from delivery_bundle
      where order_id = o.id
      order by created_at desc, id desc
      limit 1
    ) db on true
    left join digital_asset da on da.id = db.asset_id
    left join lateral (
      select status, sent_at, payload_redacted
      from delivery_notification_handoff
      where bundle_id = db.id
      order by created_at desc, id desc
      limit 1
    ) dnh on true
    left join lateral (
      select status
      from manual_fulfillment_task
      where order_id = o.id
      order by created_at desc, id desc
      limit 1
    ) mft on true
    where o.id = ${input.orderId}
    limit 1
  `.execute(exec);
  const row = result.rows[0];
  if (!row) return null;
  const messageStateId = await createAdminCallbackState(exec, {
    adminTelegramUserId: input.adminTelegramUserId,
    kind: "ORDER_MESSAGE_PROMPT",
    payload: { orderId: row.id },
  });
  return {
    id: row.id,
    orderNumber: row.order_number,
    customerId: row.customer_id,
    telegramUserId: row.telegram_user_id,
    username: row.username,
    displayName: row.display_name,
    phoneNumber: row.phone_number,
    reachable: row.reachable ?? false,
    productName: row.product_name_vi,
    variantName: row.variant_name_vi,
    priceVnd: BigInt(row.price_vnd),
    durationCode: row.duration_code,
    deliveryType: row.delivery_type,
    fulfillmentType: row.fulfillment_type,
    supplierPolicySnapshot: row.supplier_policy_snapshot,
    orderStatus: row.status,
    paidAt: row.paid_at ? new Date(row.paid_at).toISOString() : null,
    completedAt: row.completed_at ? new Date(row.completed_at).toISOString() : null,
    createdAt: new Date(row.created_at).toISOString(),
    paymentStatus: row.payment_status,
    paymentAmountVnd: row.payment_amount_vnd === null ? null : BigInt(row.payment_amount_vnd),
    paymentPresentedAt: row.payment_presented_at
      ? new Date(row.payment_presented_at).toISOString()
      : null,
    paymentSettledAt: row.payment_settled_at
      ? new Date(row.payment_settled_at).toISOString()
      : null,
    fulfillmentStatus: row.fulfillment_status,
    fulfillmentCreatedAt: row.fulfillment_created_at
      ? new Date(row.fulfillment_created_at).toISOString()
      : null,
    manualTaskStatus: row.manual_task_status,
    ...(row.asset_ref || row.review_handoff_status
      ? {
          deliveryReview: {
            assetStatus: row.asset_status,
            assetRef: row.asset_ref,
            bundleStatus: row.fulfillment_status,
            handoffStatus: row.review_handoff_status,
            handoffSentAt: row.review_handoff_sent_at
              ? new Date(row.review_handoff_sent_at).toISOString()
              : null,
            providerMessageIdPresent: row.provider_message_id !== null,
            providerChatMatches: row.provider_chat_matches,
            providerSuccessAt: row.provider_success_at,
            sendAttemptedAt: row.send_attempted_at,
            evidenceComplete: row.evidence_complete,
          },
        }
      : {}),
    messageStateId,
  };
}

export async function resolveOrderCustomerForRelay(
  exec: Executor,
  input: { adminTelegramUserId: string; stateId: string },
): Promise<{ orderId: string; customerId: string } | null> {
  const state = await resolveAdminOrderState(exec, input);
  if (state?.kind !== "ORDER_MESSAGE_PROMPT" || !state.orderId) return null;
  const row = await sql<{
    customer_id: string;
  }>`select customer_id from "order" where id = ${state.orderId} limit 1`.execute(exec);
  return row.rows[0] ? { orderId: state.orderId, customerId: row.rows[0].customer_id } : null;
}
