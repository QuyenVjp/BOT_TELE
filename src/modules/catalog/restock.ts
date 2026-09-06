import { sql } from "kysely";
import type { Executor } from "../../infrastructure/db/transaction.js";
import { newId } from "../../shared/ids/index.js";

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

/** Idempotent subscribe: unique DB key makes concurrent double taps one row. */
export async function subscribeRestock(
  exec: Executor,
  customerId: string,
  variantId: string,
): Promise<RestockSubscription> {
  const id = newId();
  const result = await sql<Row>`insert into restock_subscription (id, customer_id, variant_id)
    values (${id}, ${customerId}, ${variantId})
    on conflict (customer_id, variant_id) do update set active = true, updated_at = now()
    returning id, customer_id, variant_id, active, notified_generation`.execute(exec);
  return map(result.rows[0]!);
}

export async function unsubscribeRestock(
  exec: Executor,
  customerId: string,
  variantId: string,
): Promise<boolean> {
  const result = await sql<{ id: string }>`update restock_subscription set active = false, updated_at = now()
    where customer_id = ${customerId} and variant_id = ${variantId} and active returning id`.execute(exec);
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
