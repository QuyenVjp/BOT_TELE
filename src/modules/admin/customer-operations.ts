import { sql } from "kysely";
import type { Executor } from "../../infrastructure/db/transaction.js";
import { withTransaction, type Db } from "../../infrastructure/db/transaction.js";
import { appendAuditEvent } from "../identity/audit.js";
import { newId, isId } from "../../shared/ids/index.js";

export type AdminCustomerFilter =
  "recent" | "top_spend" | "unreachable" | "support_open" | "payment_review";
export type AdminStateKind =
  | "CUSTOMER_DETAIL"
  | "CUSTOMER_MESSAGE_PROMPT"
  | "CUSTOMER_SEARCH_PROMPT"
  | "CUSTOMER_PAGE"
  | "ORDER_DETAIL"
  | "ORDER_PAGE"
  | "ORDER_MESSAGE_PROMPT"
  | "MANUAL_TASK_COMPLETE"
  | "FILE_ARTIFACT_IMPORT_CONFIRM"
  | "QUANTITY_STOCK_ADJUST_CONFIRM"
  | "ADMIN_VARIANT_UPDATE"
  | "TEST_CUSTOMER_ADD"
  | "CATEGORY_CREATE"
  | "CATEGORY_RENAME"
  | "WIZARD_CATEGORY_CREATE"
  | "WIZARD_CUSTOM_FIELD"
  | "WIZARD_ADVANCED"
  | "WIZARD_DESC_CUSTOM"
  | "ADMIN_PRODUCT_CONTENT_EDIT"
  /** Goal §26: the owner types an adjusted refund amount with its reason. */
  | "WARRANTY_REFUND_ADJUST_PROMPT";

export interface AdminCustomerListItem {
  id: string;
  stateId: string;
  telegramUserId: string | null;
  username: string | null;
  displayName: string | null;
  phoneNumber: string | null;
  reachable: boolean;
  orderCount: number;
  totalSpendVnd: bigint;
  lastSeenAt: string;
  lastOrderNumber: string | null;
  lastOrderStatus: string | null;
}

export interface AdminCustomerListPage {
  items: AdminCustomerListItem[];
  nextStateId: string | null;
  filter: AdminCustomerFilter;
  query: string | null;
}

interface CustomerRow {
  id: string;
  telegram_user_id: string | null;
  username: string | null;
  display_name: string | null;
  phone_number: string | null;
  reachable: boolean | null;
  order_count: number;
  total_spend_vnd: string | number;
  last_seen_at: Date | string;
  last_order_number: string | null;
  last_order_status: string | null;
}

function clampLimit(limit?: number): number {
  return Number.isInteger(limit) ? Math.max(1, Math.min(10, limit!)) : 8;
}

function cleanQuery(query?: string | null): string | null {
  const q = query?.trim();
  return q ? q.slice(0, 80) : null;
}

function parseCursor(
  cursor?: string | null,
): { id: string; lastSeenAt: string; totalSpendVnd: string } | null {
  if (!cursor) return null;
  try {
    const parsed = JSON.parse(cursor) as Partial<{
      id: string;
      lastSeenAt: string;
      totalSpendVnd: string;
    }>;
    return parsed.id && isId(parsed.id) && parsed.lastSeenAt && parsed.totalSpendVnd !== undefined
      ? { id: parsed.id, lastSeenAt: parsed.lastSeenAt, totalSpendVnd: parsed.totalSpendVnd }
      : null;
  } catch {
    return isId(cursor)
      ? { id: cursor, lastSeenAt: "9999-12-31T23:59:59.999Z", totalSpendVnd: "0" }
      : null;
  }
}

function cursorFor(row: CustomerRow): string {
  return JSON.stringify({
    id: row.id,
    lastSeenAt: new Date(row.last_seen_at).toISOString(),
    totalSpendVnd: String(row.total_spend_vnd),
  });
}

function mapCustomer(row: CustomerRow, stateId: string): AdminCustomerListItem {
  return {
    id: row.id,
    stateId,
    telegramUserId: row.telegram_user_id,
    username: row.username,
    displayName: row.display_name,
    phoneNumber: row.phone_number,
    reachable: row.reachable ?? false,
    orderCount: row.order_count,
    totalSpendVnd: BigInt(row.total_spend_vnd),
    lastSeenAt: new Date(row.last_seen_at).toISOString(),
    lastOrderNumber: row.last_order_number,
    lastOrderStatus: row.last_order_status,
  };
}

export async function createAdminCallbackState(
  exec: Executor,
  input: {
    adminTelegramUserId: string;
    kind: AdminStateKind;
    payload: Record<string, unknown>;
    ttlMinutes?: number;
  },
): Promise<string> {
  const id = newId();
  await sql`
    insert into admin_callback_state (id, admin_telegram_user_id, kind, payload_redacted, expires_at)
    values (${id}, ${input.adminTelegramUserId}, ${input.kind}, ${JSON.stringify(input.payload)}::jsonb, now() + (${input.ttlMinutes ?? 30} * interval '1 minute'))
  `.execute(exec);
  return id;
}

export async function resolveAdminCallbackState(
  exec: Executor,
  input: { adminTelegramUserId: string; stateId: string },
): Promise<{ kind: AdminStateKind; payload: Record<string, unknown> } | null> {
  if (!isId(input.stateId)) return null;
  const row = await sql<{ kind: AdminStateKind; payload_redacted: Record<string, unknown> }>`
    select kind, payload_redacted
    from admin_callback_state
    where id = ${input.stateId}
      and admin_telegram_user_id = ${input.adminTelegramUserId}
      and expires_at > now()
    limit 1
  `.execute(exec);
  const found = row.rows[0];
  return found ? { kind: found.kind, payload: found.payload_redacted } : null;
}

export async function startAdminCustomerMessageDraft(
  exec: Executor,
  input: { adminTelegramUserId: string; customerId: string },
): Promise<void> {
  await sql`
    insert into admin_customer_message_draft (admin_telegram_user_id, customer_id, expires_at)
    values (${input.adminTelegramUserId}, ${input.customerId}, now() + interval '30 minutes')
    on conflict (admin_telegram_user_id) do update set
      customer_id = excluded.customer_id,
      expires_at = excluded.expires_at,
      updated_at = now()
  `.execute(exec);
}

export async function consumeAdminCustomerMessageDraft(
  exec: Executor,
  adminTelegramUserId: string,
): Promise<{ customerId: string } | null> {
  const row = await sql<{ customer_id: string }>`
    delete from admin_customer_message_draft
    where admin_telegram_user_id = ${adminTelegramUserId}
      and expires_at > now()
    returning customer_id
  `.execute(exec);
  return row.rows[0] ? { customerId: row.rows[0].customer_id } : null;
}

export async function listAdminCustomers(
  exec: Executor,
  input: {
    adminTelegramUserId: string;
    filter?: AdminCustomerFilter;
    query?: string | null;
    cursor?: string | null;
    limit?: number;
  },
): Promise<AdminCustomerListPage> {
  const filter = input.filter ?? "recent";
  const query = cleanQuery(input.query);
  const limit = clampLimit(input.limit);
  const cursor = parseCursor(input.cursor);
  const fetchLimit = limit + 1;
  const like = query ? `%${query.toLowerCase()}%` : null;
  const numeric = query && /^\d{4,20}$/.test(query) ? query : null;
  const orderNo = query && /^ORD-/i.test(query) ? query.toUpperCase() : null;

  const filterWhere =
    filter === "unreachable"
      ? sql`and coalesce(cps.reachable, false) = false`
      : filter === "support_open"
        ? sql`and exists (select 1 from support_ticket st where st.customer_id = c.id and st.status in ('OPEN','WAITING_SHOP','WAITING_CUSTOMER','MANUAL_REVIEW'))`
        : filter === "payment_review"
          ? sql`and exists (select 1 from "order" po where po.customer_id = c.id and po.status = 'PAYMENT_NEEDS_REVIEW')`
          : sql``;

  const queryWhere = query
    ? sql`and (
      (${numeric}::text is not null and (cps.telegram_user_id = ${numeric} or cps.chat_id = ${numeric} or ci.channel_user_id = ${numeric}))
      or (${like}::text is not null and lower(coalesce(cps.username, ci.observed_username, '')) like ${like})
      or (${like}::text is not null and cps.phone_shared_at is not null and lower(coalesce(cps.phone_number, '')) like ${like})
      or (${orderNo}::text is not null and exists (select 1 from "order" oq where oq.customer_id = c.id and upper(oq.order_number) like ${`%${orderNo ?? ""}%`}))
    )`
    : sql``;

  const cursorWhere = cursor
    ? filter === "top_spend"
      ? sql`where (total_spend_vnd < ${cursor.totalSpendVnd}::bigint or (total_spend_vnd = ${cursor.totalSpendVnd}::bigint and id > ${cursor.id}))`
      : sql`where (last_seen_at < ${cursor.lastSeenAt}::timestamptz or (last_seen_at = ${cursor.lastSeenAt}::timestamptz and id > ${cursor.id}))`
    : sql``;
  const orderBy =
    filter === "top_spend" ? sql`total_spend_vnd desc, id asc` : sql`last_seen_at desc, id asc`;

  const rows = await sql<CustomerRow>`
    with customer_base as (
      select c.id,
        coalesce(cps.telegram_user_id, ci.channel_user_id) as telegram_user_id,
        coalesce(cps.username, ci.observed_username) as username,
        cps.display_name,
        case when cps.phone_shared_at is not null then cps.phone_number end as phone_number,
        cps.reachable,
        greatest(c.last_seen_at, coalesce(cps.last_seen_at, c.last_seen_at), coalesce(ci.last_seen_at, c.last_seen_at)) as last_seen_at,
        (select count(*)::int from "order" o where o.customer_id = c.id) as order_count,
        coalesce((select sum(o.price_vnd)::bigint from "order" o where o.customer_id = c.id and o.status in ('PAID','PROCESSING','COMPLETED','REFUND_PENDING')), 0) as total_spend_vnd,
        (select o.order_number from "order" o where o.customer_id = c.id order by o.created_at desc, o.id desc limit 1) as last_order_number,
        (select o.status from "order" o where o.customer_id = c.id order by o.created_at desc, o.id desc limit 1) as last_order_status
      from customer c
      left join customer_profile_snapshot cps on cps.customer_id = c.id
      left join channel_identity ci on ci.customer_id = c.id and ci.channel = 'TELEGRAM'
      where c.status = 'ACTIVE'
        ${filterWhere}
        ${queryWhere}
    )
    select * from customer_base
    ${cursorWhere}
    order by ${orderBy}
    limit ${fetchLimit}
  `.execute(exec);

  const visible = rows.rows.slice(0, limit);
  const items = await Promise.all(
    visible.map(async (row) =>
      mapCustomer(
        row,
        await createAdminCallbackState(exec, {
          adminTelegramUserId: input.adminTelegramUserId,
          kind: "CUSTOMER_DETAIL",
          payload: { customerId: row.id },
        }),
      ),
    ),
  );
  const last = visible.at(-1);
  const nextStateId =
    rows.rows.length > limit && last
      ? await createAdminCallbackState(exec, {
          adminTelegramUserId: input.adminTelegramUserId,
          kind: "CUSTOMER_PAGE",
          payload: { filter, query, cursor: cursorFor(last) },
        })
      : null;
  return { items, nextStateId, filter, query };
}

export async function queueAdminCustomerMessage(
  db: Db,
  input: { customerId: string; content: string; actorId: string; correlationId: string },
) {
  return withTransaction(db, async (trx) => {
    const target = await sql<{ chat_id: string }>`
      select cps.chat_id
      from customer c
      join customer_profile_snapshot cps on cps.customer_id = c.id and cps.reachable
      where c.id = ${input.customerId} and c.status = 'ACTIVE'
      limit 1
    `.execute(trx);
    const chatId = target.rows[0]?.chat_id;
    if (!chatId) return false;
    const campaignId = `admin-message:${input.customerId}:${input.correlationId}`;
    await sql`insert into notification_campaign(id, class, content, status, created_by, idempotency_key) values (${campaignId}, 'CRITICAL_SERVICE', ${input.content}, 'QUEUED', ${input.actorId}, ${campaignId}) on conflict (idempotency_key) do nothing`.execute(
      trx,
    );
    await sql`insert into notification_delivery(id, campaign_id, customer_id, chat_id) values (${newId()}, ${campaignId}, ${input.customerId}, ${chatId}) on conflict (campaign_id, customer_id) do nothing`.execute(
      trx,
    );
    await appendAuditEvent(trx, {
      actorType: "ROOT_ADMIN",
      actorId: input.actorId,
      action: "customer.message",
      targetType: "Customer",
      targetId: input.customerId,
      reason: "Root admin queued customer notification",
      correlationId: input.correlationId,
      metadataRedacted: { length: input.content.length, chatIdStored: true },
    });
    return true;
  });
}
