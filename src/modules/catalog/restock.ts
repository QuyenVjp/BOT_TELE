import { sql } from "kysely";
import type { Executor } from "../../infrastructure/db/transaction.js";
import { newId } from "../../shared/ids/index.js";
import { VARIANT_READY_SQL } from "./repository.js";
import { catalogVisibilitySql } from "./visibility.js";
import { PUBLIC_BRAND_CATEGORY_SLUGS, PUBLIC_ROOT_CATEGORY_SLUGS } from "./taxonomy.js";
import { RESTOCK_LOCAL_FULFILLMENT_TYPES } from "./domain.js";

const PUBLIC_CATEGORY_SLUG_SQL = sql.join(
  [...PUBLIC_ROOT_CATEGORY_SLUGS, ...PUBLIC_BRAND_CATEGORY_SLUGS].map((slug) => sql`${slug}`),
  sql`, `,
);
const RESTOCK_FULFILLMENT_TYPE_SQL = sql.join(
  RESTOCK_LOCAL_FULFILLMENT_TYPES.map((type) => sql`${type}`),
  sql`, `,
);

/**
 * Current customer-facing restock eligibility. Callers must join product as `p`, variant as `v`,
 * category as `c`, and quantity stock as `q`; the ready predicate covers each local stock type.
 */
export function restockVariantEligibilitySql(variantId?: string) {
  return sql`
    ${variantId === undefined ? sql`` : sql`v.id = ${variantId} and`}
    c.is_active
    and v.is_active
    and p.is_active
    ${catalogVisibilitySql("public")}
    and c.slug in (${PUBLIC_CATEGORY_SLUG_SQL})
    and v.stock_policy in ('LOCAL_ONLY', 'LOCAL_THEN_SUPPLIER')
    and v.fulfillment_type in (${RESTOCK_FULFILLMENT_TYPE_SQL})
    and not coalesce(v.preorder_enabled, false)
    and not (${VARIANT_READY_SQL})
  `;
}
export interface RestockSubscription {
  id: string;
  customerId: string;
  variantId: string;
  active: boolean;
  notifiedGeneration: number;
}

type Row = {
  id: string;
  customer_id: string;
  variant_id: string;
  active: boolean;
  notified_generation: number;
};
function map(row: Row): RestockSubscription {
  return {
    id: row.id,
    customerId: row.customer_id,
    variantId: row.variant_id,
    active: row.active,
    notifiedGeneration: row.notified_generation,
  };
}

/** Idempotent subscribe: only currently public, local, out-of-stock variants may create a row. */
export async function subscribeRestock(
  exec: Executor,
  customerId: string,
  variantId: string,
): Promise<RestockSubscription | null> {
  const id = newId();
  const result = await sql<Row>`
    insert into restock_subscription (id, customer_id, variant_id)
    select ${id}, ${customerId}, v.id
    from product_variant v
    join product p on p.id = v.product_id
    join category c on c.id = p.category_id
    left join variant_quantity_stock q on q.variant_id = v.id
    where ${restockVariantEligibilitySql(variantId)}
    on conflict (customer_id, variant_id) do update set active = true, updated_at = now()
    returning id, customer_id, variant_id, active, notified_generation
  `.execute(exec);
  const row = result.rows[0];
  return row ? map(row) : null;
}

export async function unsubscribeRestock(
  exec: Executor,
  customerId: string,
  variantId: string,
): Promise<boolean> {
  const result = await sql<{
    id: string;
  }>`update restock_subscription set active = false, updated_at = now()
    where customer_id = ${customerId} and variant_id = ${variantId} and active returning id`.execute(
    exec,
  );
  return result.rows.length > 0;
}

export async function listRestockSubscriptions(
  exec: Executor,
  customerId: string,
): Promise<RestockSubscription[]> {
  const result = await sql<Row>`select id, customer_id, variant_id, active, notified_generation
    from restock_subscription where customer_id = ${customerId} and active order by created_at`.execute(
    exec,
  );
  return result.rows.map(map);
}

/** Advances the variant generation only when transitioning OOS -> in-stock. */
export async function markVariantRestocked(
  exec: Executor,
  variantId: string,
  wasOutOfStock: boolean,
  stockAvailable: boolean,
): Promise<number | null> {
  if (!wasOutOfStock || !stockAvailable) return null;
  const result = await sql<{ restock_generation: number }>`update product_variant
    set restock_generation = restock_generation + 1, updated_at = now()
    where id = ${variantId} returning restock_generation`.execute(exec);
  return result.rows[0]?.restock_generation ?? null;
}

/** Atomically claims subscriptions for a generation; repeated calls claim none. */
export async function claimRestockNotifications(
  exec: Executor,
  variantId: string,
  generation: number,
): Promise<RestockSubscription[]> {
  const result =
    await sql<Row>`update restock_subscription set notified_generation = ${generation}, updated_at = now()
    where variant_id = ${variantId} and active and notified_generation < ${generation}
    returning id, customer_id, variant_id, active, notified_generation`.execute(exec);
  return result.rows.map(map);
}
