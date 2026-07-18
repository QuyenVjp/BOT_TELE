import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { newId } from "../../src/shared/ids/index.js";
import { startPostgresContainer, type PgTestContext } from "../helpers/pg-container.js";

/** T169 — query-plan proof on pilot-sized data, not mock timings. */

let ctx: PgTestContext;

beforeAll(async () => {
  ctx = await startPostgresContainer();
}, 180_000);

afterAll(async () => {
  await ctx?.teardown();
});

beforeEach(async () => {
  await sql`
    truncate table delivery_bundle, digital_asset, payment_allocation, discrepancy,
      bank_transaction, payment_intent, order_transition, outbox_event, "order",
      product_variant, product, category, customer cascade
  `.execute(ctx.db);
});

function planText(plan: unknown): string {
  const nodes: Record<string, unknown>[] = [];
  const visit = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    const record = node as Record<string, unknown>;
    nodes.push(record);
    const children = Array.isArray(record["Plans"]) ? record["Plans"] : [];
    for (const child of children) visit(child);
  };
  const envelope = Array.isArray(plan) ? plan[0] : null;
  const root =
    envelope && typeof envelope === "object" ? (envelope as Record<string, unknown>)["Plan"] : plan;
  visit(root);
  return JSON.stringify(nodes);
}

async function seedPilotData(): Promise<{ customerId: string; variantId: string }> {
  const customerId = newId();
  const categoryId = newId();
  const productId = newId();
  const variantId = newId();
  const slug = categoryId.slice(-8);
  await sql`insert into customer (id, status, locale) values (${customerId}, 'ACTIVE', 'vi')`.execute(
    ctx.db,
  );
  await sql`insert into category (id, name_vi, slug, is_active, sort_order) values (${categoryId}, 'C', ${slug}, true, 1)`.execute(
    ctx.db,
  );
  await sql`insert into product (id, category_id, name_vi, slug, is_active, sort_order) values (${productId}, ${categoryId}, 'P', ${slug}, true, 1)`.execute(
    ctx.db,
  );
  await sql`
    insert into product_variant
      (id, product_id, sku, name_vi, price_vnd, duration_code, delivery_type,
       stock_policy, resale_evidence_id, is_active, sort_order)
    values
      (${variantId}, ${productId}, ${"SKU-" + variantId}, 'V', 150000, 'P1M', 'CREDENTIAL',
       'LOCAL_ONLY', 'RES-1', true, 1)
  `.execute(ctx.db);

  await sql`
    insert into customer (id, status, locale)
    select 'customer-plan-' || g::text, 'ACTIVE', 'vi'
    from generate_series(1, 10000) as s(g)
    where g > 1
  `.execute(ctx.db);
  // 10,000 orders make a missing customer composite index visible to the planner.
  await sql`
    insert into "order"
      (id, order_number, customer_id, variant_id, product_name_vi, variant_name_vi,
       price_vnd, duration_code, delivery_type, status, created_at, updated_at)
    select
      'ord-plan-' || g::text,
      'ORD-PLAN-' || g::text,
      case when g = 1 then ${customerId} else 'customer-plan-' || g::text end,
      ${variantId}, 'P', 'V', 150000, 'P1M', 'CREDENTIAL', 'COMPLETED',
      now() - (g || ' seconds')::interval,
      now() - (g || ' seconds')::interval
    from generate_series(1, 10000) as s(g)
  `.execute(ctx.db);
  await sql`
    insert into digital_asset
      (id, variant_id, source_type, vault_ref, fingerprint_hash, status, created_at, updated_at)
    select
      'asset-plan-' || g::text, ${variantId}, 'LOCAL', 'vault:asset-plan-' || g::text,
      'fp-plan-' || g::text, 'AVAILABLE', now() - (g || ' seconds')::interval,
      now() - (g || ' seconds')::interval
    from generate_series(1, 5000) as s(g)
  `.execute(ctx.db);
  await sql`analyze "order"`.execute(ctx.db);
  await sql`analyze digital_asset`.execute(ctx.db);
  return { customerId, variantId };
}

describe("pilot query plans (T169)", () => {
  it("uses the customer history composite index without a sort", async () => {
    const { customerId } = await seedPilotData();
    const result = await sql<{ "QUERY PLAN": unknown }>`
      explain (analyze, buffers, format json)
      select id, order_number, status, created_at
      from "order"
      where customer_id = ${customerId}
      order by created_at desc, id desc
      limit 11
    `.execute(ctx.db);
    const text = planText(result.rows[0]?.["QUERY PLAN"]);
    expect(text).toContain("order_history_customer_created_idx");
    expect(text).not.toContain('"Node Type":"Sort"');
  });

  it("uses the asset claim composite index for deterministic bounded stock allocation", async () => {
    const { variantId } = await seedPilotData();
    const result = await sql<{ "QUERY PLAN": unknown }>`
      explain (analyze, buffers, format json)
      select id, vault_ref, fingerprint_hash, version
      from digital_asset
      where variant_id = ${variantId}
        and status = 'AVAILABLE'
      order by created_at asc, id asc
      limit 1
      for update skip locked
    `.execute(ctx.db);
    const text = planText(result.rows[0]?.["QUERY PLAN"]);
    expect(text).toContain("digital_asset_claim_idx");
    expect(text).not.toContain('"Node Type":"Sort"');
  });
});
