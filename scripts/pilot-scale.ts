import { performance } from "node:perf_hooks";
import { sql } from "kysely";
import { listSellableVariants, getVariantById } from "../src/modules/catalog/repository.js";
import { startPostgresContainer, type PgTestContext } from "../tests/helpers/pg-container.js";

const CUSTOMER_COUNT = 1_000;
const VARIANT_COUNT = 10_000;
const PRODUCT_COUNT = 100;
const CATALOG_READS = 40;

interface PlanRow {
  "QUERY PLAN": unknown;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function percentile(values: number[], p: number): number {
  assert(values.length > 0, "percentile requires at least one measurement");
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[idx]!;
}

function summarize(name: string, values: number[]): void {
  console.log(
    `${name}: n=${values.length} p50=${percentile(values, 50).toFixed(2)}ms p95=${percentile(values, 95).toFixed(2)}ms`,
  );
}

function collectPlanNodes(plan: unknown): Record<string, unknown>[] {
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
  return nodes;
}

function planText(plan: unknown): string {
  return JSON.stringify(collectPlanNodes(plan));
}

function indexEvidence(plan: unknown): string {
  const indexes = collectPlanNodes(plan)
    .map((node) => node["Index Name"])
    .filter((name): name is string => typeof name === "string");
  return indexes.length > 0 ? indexes.join(", ") : "no index node reported";
}

async function timed<T>(name: string, run: () => Promise<T>): Promise<T> {
  const started = performance.now();
  const result = await run();
  console.log(`${name}: ${(performance.now() - started).toFixed(1)}ms`);
  return result;
}

async function rowCount(ctx: PgTestContext, table: string): Promise<number> {
  const result = await sql<{
    count: string;
  }>`select count(*)::text as count from ${sql.table(table)}`.execute(ctx.db);
  return Number(result.rows[0]?.count ?? "0");
}

async function seed(
  ctx: PgTestContext,
): Promise<{ categoryId: string; firstProductId: string; firstVariantId: string }> {
  const categoryId = "pilot-category";
  const firstProductId = "pilot-product-001";
  const firstVariantId = "pilot-variant-00001";

  await sql`insert into category (id, name_vi, slug, is_active, sort_order) values (${categoryId}, 'Pilot Category', 'pilot-category', true, 1)`.execute(
    ctx.db,
  );
  await sql`
    insert into product (id, category_id, name_vi, slug, is_active, sort_order)
    select
      'pilot-product-' || lpad(g::text, 3, '0'),
      ${categoryId},
      'Pilot Product ' || g::text,
      'pilot-product-' || lpad(g::text, 3, '0'),
      true,
      g
    from generate_series(1, ${PRODUCT_COUNT}) as s(g)
  `.execute(ctx.db);

  await sql`
    insert into customer (id, status, locale)
    select 'pilot-customer-' || lpad(g::text, 4, '0'), 'ACTIVE', 'vi'
    from generate_series(1, ${CUSTOMER_COUNT}) as s(g)
  `.execute(ctx.db);

  await sql`
    insert into product_variant
      (id, product_id, sku, name_vi, price_vnd, duration_code, delivery_type,
       stock_policy, resale_evidence_id, is_active, sort_order)
    select
      'pilot-variant-' || lpad(g::text, 5, '0'),
      'pilot-product-' || lpad((((g - 1) / 100)::int + 1)::text, 3, '0'),
      'PILOT-SKU-' || lpad(g::text, 5, '0'),
      'Pilot Variant ' || g::text,
      100000 + g,
      'P1M',
      'CREDENTIAL',
      'LOCAL_ONLY',
      'pilot-resale-' || g::text,
      true,
      g
    from generate_series(1, ${VARIANT_COUNT}) as s(g)
  `.execute(ctx.db);

  await sql`
    insert into digital_asset (id, variant_id, source_type, vault_ref, fingerprint_hash, status)
    select
      'pilot-asset-' || lpad(g::text, 5, '0'),
      'pilot-variant-' || lpad(g::text, 5, '0'),
      'LOCAL',
      'vault:pilot-asset-' || lpad(g::text, 5, '0'),
      'pilot-fingerprint-' || lpad(g::text, 5, '0'),
      'AVAILABLE'
    from generate_series(1, ${VARIANT_COUNT}) as s(g)
  `.execute(ctx.db);

  await sql`analyze category`.execute(ctx.db);
  await sql`analyze product`.execute(ctx.db);
  await sql`analyze product_variant`.execute(ctx.db);
  await sql`analyze customer`.execute(ctx.db);
  await sql`analyze digital_asset`.execute(ctx.db);

  return { categoryId, firstProductId, firstVariantId };
}

async function explainCatalog(ctx: PgTestContext, productId: string): Promise<unknown> {
  const result = await sql<PlanRow>`
    explain (analyze, buffers, format json)
    select
      v.id, v.product_id, p.name_vi as product_name_vi, v.sku, v.name_vi,
      v.price_vnd, v.duration_code, v.delivery_type, v.warranty_days,
      v.stock_policy, v.sort_order, v.fulfillment_type,
      q.available_quantity::int as available_quantity,
      case
        when v.fulfillment_type in ('STOCK_ACCOUNT','STOCK_CODE') then exists (
          select 1 from digital_asset a where a.variant_id = v.id and a.status = 'AVAILABLE'
        )
        else false
      end as is_ready
    from product_variant v
    join product p on p.id = v.product_id
    join category c on c.id = p.category_id
    left join variant_quantity_stock q on q.variant_id = v.id
    where c.is_active
      and p.is_active
      and v.is_active
      and v.price_vnd > 0
      and v.resale_evidence_id is not null
      and v.stock_policy in ('LOCAL_ONLY','LOCAL_THEN_SUPPLIER')
      and v.fulfillment_type <> 'SUPPLIER_API'
      and v.product_id = ${productId}
    order by v.sort_order asc, v.id asc
    limit 11
  `.execute(ctx.db);
  return result.rows[0]?.["QUERY PLAN"];
}

async function main(): Promise<void> {
  let ctx: PgTestContext | undefined;
  try {
    ctx = await startPostgresContainer();
    const ids = await timed(
      "seed 1000 synthetic customers and 10000 synthetic catalog variants across 100 products",
      () => seed(ctx!),
    );

    const customers = await rowCount(ctx, "customer");
    const variants = await rowCount(ctx, "product_variant");
    const products = await rowCount(ctx, "product");
    const assets = await rowCount(ctx, "digital_asset");
    console.log(
      `row counts: customers=${customers} products=${products} variants=${variants} digital_assets=${assets}`,
    );
    assert(customers === CUSTOMER_COUNT, `expected ${CUSTOMER_COUNT} customers, got ${customers}`);
    assert(products === PRODUCT_COUNT, `expected ${PRODUCT_COUNT} products, got ${products}`);
    assert(variants === VARIANT_COUNT, `expected ${VARIANT_COUNT} variants, got ${variants}`);
    assert(assets === VARIANT_COUNT, `expected ${VARIANT_COUNT} digital assets, got ${assets}`);

    const firstPage = await listSellableVariants(ctx.db, {
      productId: ids.firstProductId,
      limit: 10,
    });
    const firstVariant = await getVariantById(ctx.db, ids.firstVariantId);
    assert(
      firstPage.items.length === 10,
      `expected 10 catalog rows, got ${firstPage.items.length}`,
    );
    assert(firstPage.nextCursor, "expected catalog next cursor");
    assert(firstVariant?.id === ids.firstVariantId, "expected first variant detail read");

    const catalogLatencies: number[] = [];
    for (let i = 0; i < CATALOG_READS; i += 1) {
      const started = performance.now();
      const page = await listSellableVariants(ctx.db, { productId: ids.firstProductId, limit: 10 });
      const detail = await getVariantById(
        ctx.db,
        `pilot-variant-${String((i % VARIANT_COUNT) + 1).padStart(5, "0")}`,
      );
      assert(page.items.length === 10, "catalog page size changed during reads");
      assert(detail, "catalog detail read returned null");
      catalogLatencies.push(performance.now() - started);
    }
    summarize("indexed catalog reads (list + detail)", catalogLatencies);

    const catalogPlan = await explainCatalog(ctx, ids.firstProductId);
    const catalogText = planText(catalogPlan);
    console.log(`catalog EXPLAIN indexes: ${indexEvidence(catalogPlan)}`);
    assert(
      catalogText.includes("product_variant_product_idx"),
      "catalog plan did not report product_variant_product_idx",
    );

    console.log(
      "Disposable pilot-scale check complete. Synthetic non-PII only; no Telegram/SePay/supplier transport; not a production SLO.",
    );
  } finally {
    await ctx?.teardown();
  }
}

await main();
