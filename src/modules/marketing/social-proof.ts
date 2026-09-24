import { createHmac } from "node:crypto";
import { sql } from "kysely";
import type { Executor } from "../../infrastructure/db/transaction.js";

export const TRUST_PAGE_SIZE = 5;
export const TRUST_MAX_PAGE_SIZE = 10;

export interface RealStoreStats {
  completedOrders: number;
  totalCustomers: number;
  automatedDeliveries: number;
}

export interface TrustSale {
  customerAlias: string;
  productName: string;
  variantName: string;
  amountVnd: number;
  completedAt: string;
}

export interface TrustScreenData {
  page: number;
  pageSize: number;
  rows: TrustSale[];
  completed24h: number;
  completed7d: number;
  completedAll: number;
  hasPrevious: boolean;
  hasNext: boolean;
}

function clampPageSize(pageSize: number | undefined): number {
  return Number.isInteger(pageSize)
    ? Math.max(1, Math.min(TRUST_MAX_PAGE_SIZE, pageSize!))
    : TRUST_PAGE_SIZE;
}

function clampPage(page: number | undefined): number {
  return Number.isInteger(page) ? Math.max(0, Math.min(255, page!)) : 0;
}

function requireAliasKey(aliasKey: string): string {
  if (typeof aliasKey !== "string" || Buffer.byteLength(aliasKey, "utf8") < 32)
    throw new Error("SOCIAL_PROOF_HMAC_KEY_REQUIRED");
  return aliasKey;
}

/** Stable, non-reversible pseudonym. Public callers must supply the configured secret key. */
export function generateCustomerAlias(customerId: string, aliasKey: string): string {
  const hmac = createHmac("sha256", requireAliasKey(aliasKey)).update(customerId).digest("hex");
  return `Khách #${hmac.slice(0, 4).toUpperCase()}`;
}

export function renderSocialProofMessage(input: {
  customerAlias: string;
  productName: string;
  variantName: string;
  priceVnd: number;
}): string {
  return [
    "🛒 CÓ KHÁCH VỪA MUA HÀNG",
    "",
    `👤 ${input.customerAlias}`,
    `📦 ${input.productName} · ${input.variantName}`,
    `💰 ${input.priceVnd.toLocaleString("vi-VN")} ₫`,
    "✅ Giao hàng thành công",
    "",
    "Cảm ơn bạn đã tin tưởng TIER20.",
  ].join("\n");
}

const ELIGIBLE_SALES = sql`
  from "order" o
  join payment_intent pi on pi.order_id = o.id and pi.status = 'SUCCEEDED'
  join payment_allocation pa on pa.payment_intent_id = pi.id and pa.status = 'SETTLED'
  join bank_transaction bt on bt.id = pa.bank_transaction_id
    and lower(bt.provider) = 'sepay'
    and bt.direction = 'IN'
    and bt.signature_status = 'VERIFIED'
  join product_variant v on v.id = o.variant_id
  join product p on p.id = v.product_id
  where o.status = 'COMPLETED'
    and o.completed_at is not null
    and not p.is_test
    and not p.is_archived
    and p.name_vi not ilike '%canary%'
    and pa.decision_code not ilike 'MANUAL%'
    and pa.decision_code not ilike 'TEST%'
    and not exists (
      select 1
      from discrepancy d
      where d.payment_intent_id = pi.id
        and d.resolution_code ilike 'MANUAL%'
    )
    and not exists (
      select 1
      from test_customer_allowlist a
      join channel_identity ci
        on ci.channel = 'TELEGRAM'
       and ci.channel_user_id = a.telegram_user_id
       and ci.customer_id = o.customer_id
    )
    and (
      exists (
        select 1
        from digital_asset da
        where da.delivered_order_id = o.id and da.status = 'DELIVERED'
      )
      or exists (
        select 1
        from delivery_bundle b
        join digital_asset da on da.id = b.asset_id and da.status = 'DELIVERED'
        where b.order_id = o.id and b.status = 'CONSUMED'
      )
      or exists (select 1 from file_delivery_job f where f.order_id = o.id and f.status = 'SENT')
      or exists (select 1 from manual_fulfillment_task m where m.order_id = o.id and m.status = 'COMPLETED')
    )
`;

/** Truthful store counters. The public screen and counters share the same eligibility predicates. */
export async function getRealStoreStats(exec: Executor): Promise<RealStoreStats> {
  const result = await sql<{
    completed_orders: number;
    total_customers: number;
    automated_deliveries: number;
  }>`
    select
      count(distinct o.id)::int as completed_orders,
      count(distinct o.customer_id)::int as total_customers,
      count(distinct o.id) filter (where exists (
        select 1 from delivery_bundle b
        join digital_asset da on da.id = b.asset_id
        where b.order_id = o.id and b.status = 'CONSUMED' and da.status = 'DELIVERED'
      ))::int as automated_deliveries
    ${ELIGIBLE_SALES}
  `.execute(exec);
  const row = result.rows[0];
  return {
    completedOrders: row?.completed_orders ?? 0,
    totalCustomers: row?.total_customers ?? 0,
    automatedDeliveries: row?.automated_deliveries ?? 0,
  };
}

export async function listTrustScreen(
  exec: Executor,
  input: { page?: number; pageSize?: number; aliasKey: string },
): Promise<TrustScreenData> {
  const page = clampPage(input.page);
  const pageSize = clampPageSize(input.pageSize);
  const aliasKey = requireAliasKey(input.aliasKey);
  const [counts, rows] = await Promise.all([
    sql<{ completed_24h: number; completed_7d: number; completed_all: number }>`
      select
        count(*) filter (where o.completed_at >= now() - interval '24 hours')::int as completed_24h,
        count(*) filter (where o.completed_at >= now() - interval '7 days')::int as completed_7d,
        count(*)::int as completed_all
      ${ELIGIBLE_SALES}
    `.execute(exec),
    sql<{
      customer_id: string;
      product_name: string;
      variant_name: string;
      amount_vnd: string;
      completed_at: Date | string;
    }>`
      select o.customer_id, coalesce(nullif(o.product_name_vi, ''), p.name_vi) as product_name,
        coalesce(nullif(o.variant_name_vi, ''), v.name_vi) as variant_name,
        o.price_vnd::text as amount_vnd, o.completed_at
      ${ELIGIBLE_SALES}
      order by o.completed_at desc, o.id desc
      offset ${page * pageSize} limit ${pageSize + 1}
    `.execute(exec),
  ]);
  const count = counts.rows[0];
  const hasNext = rows.rows.length > pageSize;
  const visibleRows = rows.rows.slice(0, pageSize).map((row) => ({
    customerAlias: generateCustomerAlias(row.customer_id, aliasKey),
    productName: row.product_name,
    variantName: row.variant_name,
    amountVnd: Number(row.amount_vnd),
    completedAt: new Date(row.completed_at).toISOString(),
  }));
  return {
    page,
    pageSize,
    rows: visibleRows,
    completed24h: count?.completed_24h ?? 0,
    completed7d: count?.completed_7d ?? 0,
    completedAll: count?.completed_all ?? 0,
    hasPrevious: page > 0,
    hasNext,
  };
}
