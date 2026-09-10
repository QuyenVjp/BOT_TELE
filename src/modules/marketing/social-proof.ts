import { createHmac } from "node:crypto";
import { sql } from "kysely";
import type { Db, Executor } from "../../infrastructure/db/transaction.js";
import { newId } from "../../shared/ids/index.js";

const DEFAULT_ALIAS_KEY = "tier20-social-proof-customer-masking-salt-2026";

/**
 * Produces a stable, non-reversible pseudonymous alias for public display (FR 33).
 * Example output: "Khách #A7F3"
 */
export function generateCustomerAlias(
  customerId: string,
  salt: string = DEFAULT_ALIAS_KEY,
): string {
  const hmac = createHmac("sha256", salt).update(customerId).digest("hex");
  const code = hmac.slice(0, 4).toUpperCase();
  return `Khách #${code}`;
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
    "Cảm ơn bạn đã tin tưởng TIER20 ❤️",
  ].join("\n");
}

export interface RealStoreStats {
  completedOrders: number;
  totalCustomers: number;
  automatedDeliveries: number;
}

/**
 * Computes truthful stats from real DB records only, strictly excluding test/canary orders (FR 37).
 */
export async function getRealStoreStats(exec: Executor): Promise<RealStoreStats> {
  const result = await sql<{
    completed_orders: number;
    total_customers: number;
    automated_deliveries: number;
  }>`
    with real_completed_orders as (
      select o.id, o.customer_id
      from "order" o
      join product_variant v on v.id = (
        select v2.id from product_variant v2 where v2.product_id in (
          select p.id from product p where p.is_test = false and p.is_archived = false
        ) limit 1
      )
      where o.status = 'COMPLETED'
        and not exists (
          select 1 from digital_asset a
          join product_variant pv on pv.id = a.variant_id
          join product p on p.id = pv.product_id
          where a.delivered_order_id = o.id and (p.is_test = true or p.is_archived = true)
        )
    )
    select
      count(*)::int as completed_orders,
      count(distinct customer_id)::int as total_customers,
      coalesce((select count(*)::int from delivery_bundle where status = 'CONSUMED'), 0)::int as automated_deliveries
    from real_completed_orders
  `.execute(exec);

  const row = result.rows[0];
  return {
    completedOrders: row?.completed_orders ?? 0,
    totalCustomers: row?.total_customers ?? 0,
    automatedDeliveries: row?.automated_deliveries ?? 0,
  };
}

/**
 * Evaluates and publishes social proof event if allowed (FR 32, 33, 35).
 */
export async function evaluateAndPublishSocialProof(
  db: Db,
  input: {
    orderId: string;
    aliasSalt?: string;
  },
): Promise<
  | { ok: true; published: boolean; message?: string }
  | {
      ok: false;
      code: "ORDER_NOT_FOUND" | "ORDER_NOT_COMPLETED" | "TEST_EXCLUDED" | "CUSTOMER_OPT_OUT";
    }
> {
  const result = await sql<{
    order_id: string;
    order_number: string;
    status: string;
    price_vnd: string;
    customer_id: string;
    product_name: string;
    variant_name: string;
    is_test: boolean;
    is_archived: boolean;
    social_proof_opt_in: boolean | null;
  }>`
    select
      o.id as order_id,
      o.order_number,
      o.status,
      o.price_vnd::text,
      o.customer_id,
      p.name_vi as product_name,
      v.name_vi as variant_name,
      p.is_test,
      p.is_archived,
      pref.social_proof_opt_in
    from "order" o
    left join delivery_bundle b on b.order_id = o.id
    left join digital_asset da on da.id = b.asset_id
    left join product_variant v on v.id = da.variant_id
    left join product p on p.id = v.product_id
    left join customer_notification_preference pref on pref.customer_id = o.customer_id
    where o.id = ${input.orderId}
    limit 1
  `.execute(db);

  const row = result.rows[0];
  if (!row) return { ok: false, code: "ORDER_NOT_FOUND" };
  if (row.status !== "COMPLETED") return { ok: false, code: "ORDER_NOT_COMPLETED" };
  if (row.is_test || row.is_archived) return { ok: false, code: "TEST_EXCLUDED" };
  if (row.social_proof_opt_in === false) return { ok: false, code: "CUSTOMER_OPT_OUT" };

  const customerAlias = generateCustomerAlias(row.customer_id, input.aliasSalt);
  const message = renderSocialProofMessage({
    customerAlias,
    productName: row.product_name ?? "Sản phẩm số",
    variantName: row.variant_name ?? "Bản quyền",
    priceVnd: Number(row.price_vnd),
  });

  const eventId = newId();
  await sql`
    insert into outbox_event (
      id, aggregate_type, aggregate_id, aggregate_version, event_type, payload_redacted
    ) values (
      ${eventId}, 'SocialProof', ${row.order_id}, 1, 'SocialProofEventCreated',
      jsonb_build_object(
        'orderId', ${row.order_id}::text,
        'orderNumber', ${row.order_number}::text,
        'customerAlias', ${customerAlias}::text,
        'message', ${message}::text
      )
    )
    on conflict (aggregate_type, aggregate_id, aggregate_version, event_type) do nothing
  `.execute(db);

  return { ok: true, published: true, message };
}
