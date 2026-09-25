import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { newId } from "../../src/shared/ids/index.js";
import { searchCatalog, type CatalogFilter } from "../../src/modules/catalog/search.js";
import { startPostgresContainer, type PgTestContext } from "../helpers/pg-container.js";

/**
 * T026 — Deterministic search + Unicode normalization (FR-004).
 *
 * Deterministic search matches product name, category, and alias using a
 * fold-normalized form (NFC + lowercase + Vietnamese accent fold), so "chatgpt",
 * "CHATGPT", and an accented category query all resolve. Filters (price range, delivery
 * type, category) are bounded and only ever narrow the authoritative result set;
 * search never invents a product.
 */

let ctx: PgTestContext;

beforeAll(async () => {
  ctx = await startPostgresContainer();
}, 180_000);

afterAll(async () => {
  await ctx?.teardown();
});

beforeEach(async () => {
  await sql`truncate table product_variant, product_alias, product, category cascade`.execute(
    ctx.db,
  );
});

async function seed() {
  const catId = newId();
  const chatgptId = newId();
  const claudeId = newId();
  const supplierId = newId();
  const supplierOkId = newId();
  const supplierSkuId = newId();

  await sql`insert into category (id, name_vi, slug, is_active, sort_order) values (${catId}, 'AI', 'ai', true, 1)`.execute(
    ctx.db,
  );
  await sql`
    insert into product (id, category_id, name_vi, slug, is_active, sort_order) values
      (${chatgptId}, ${catId}, 'ChatGPT', 'chatgpt', true, 1),
      (${claudeId}, ${catId}, 'Claude', 'claude', true, 2),
      (${supplierId}, ${catId}, 'Supplier Blocked', 'supplier-blocked', true, 3),
      (${supplierOkId}, ${catId}, 'Supplier Ready', 'supplier-ready', true, 4)
  `.execute(ctx.db);

  // Tags are plain text terms the owner sets on the product (goal §27/§28).
  await sql`
    update product set tags = array['coding', 'trợ lý'] where id = ${claudeId}
  `.execute(ctx.db);

  // Aliases are pre-normalized (fold form) at write time.
  await sql`
    insert into product_alias (id, product_id, normalized_alias, locale, priority) values
      (${newId()}, ${chatgptId}, 'chatbot', 'vi', 1),
      (${newId()}, ${claudeId}, 'tro ly', 'vi', 1)
  `.execute(ctx.db);

  // Test-only resale evidence + version-bound publication snapshot (fresh fixture versions).
  const publishVariant = async (variantId: string, evidenceId: string) => {
    await sql`
      insert into resale_evidence (id, variant_id, source, reference, summary, created_by)
      values (${evidenceId}, ${variantId}, 'OWNER_ATTESTATION', ${"TEST-REF-" + evidenceId}, 'fixture publication evidence', 'test')
    `.execute(ctx.db);
    await sql`
      update product_variant
         set publication_evidence_id = ${evidenceId},
             publication_product_version = 1,
             publication_variant_version = 1,
             published_at = now(),
             published_by = 'test'
       where id = ${variantId}
    `.execute(ctx.db);
  };

  const mkVariant = async (
    productId: string,
    sku: string,
    price: number,
    delivery: string,
    order: number,
  ) => {
    const variantId = newId();
    const evidenceId = "RES-" + sku;
    await sql`
      insert into product_variant
        (id, product_id, sku, name_vi, price_vnd, duration_code, delivery_type, warranty_days,
         stock_policy, resale_evidence_id, is_active, sort_order)
      values
        (${variantId}, ${productId}, ${sku}, ${sku}, ${price}, 'P1M', ${delivery}, 30,
         'LOCAL_ONLY', ${evidenceId}, true, ${order})
    `.execute(ctx.db);
    await publishVariant(variantId, evidenceId);
  };
  await mkVariant(chatgptId, "CG-1", 100000, "LICENSE", 1);
  await mkVariant(chatgptId, "CG-2", 200000, "ACTIVATION_KEY", 2);
  await mkVariant(claudeId, "CL-1", 150000, "INVITE", 3);
  // Legacy unconfigured supplier-only SKU: intentionally left without evidence → stays hidden.
  await sql`
    insert into product_variant
      (id, product_id, sku, name_vi, price_vnd, duration_code, delivery_type, warranty_days,
       stock_policy, resale_evidence_id, is_active, sort_order)
    values
      (${newId()}, ${supplierId}, 'SUP-1', 'SUP-1', 180000, 'P1M', 'LICENSE', 30,
       'SUPPLIER_ONLY', 'RES-SUP', true, 4)
  `.execute(ctx.db);
  const supplierVariantId = newId();
  await sql`
    insert into product_variant
      (id, product_id, sku, name_vi, price_vnd, duration_code, delivery_type, warranty_days,
       stock_policy, resale_evidence_id, is_active, sort_order, fulfillment_type)
    values
      (${supplierVariantId}, ${supplierOkId}, 'SUP-OK', 'SUP-OK', 180000, 'P1M', 'LICENSE', 30,
       'SUPPLIER_ONLY', 'RES-SUP-OK', true, 5, 'SUPPLIER_API')
  `.execute(ctx.db);
  await publishVariant(supplierVariantId, "RES-SUP-OK");
  await sql`insert into supplier (id, name, adapter_type, credential_vault_ref, status) values (${supplierSkuId}, 'Primary', 'sandbox', 'vault:supplier', 'ACTIVE')`.execute(
    ctx.db,
  );
  await sql`
    insert into supplier_sku (id, supplier_id, variant_id, external_sku, cost_vnd, delivery_type, is_active)
    select ${newId()}, ${supplierSkuId}, id, 'EXT-SUP-OK', 50000, 'LICENSE', true
    from product_variant where sku = 'SUP-OK'
  `.execute(ctx.db);

  await sql`
    update product_variant v
       set supplier_sku_id = ss.id
      from supplier_sku ss
     where v.sku = 'SUP-OK' and ss.variant_id = v.id
  `.execute(ctx.db);

  return { catId, chatgptId, claudeId };
}

async function search(filter: CatalogFilter) {
  return searchCatalog(ctx.db, filter, { limit: 50 });
}

describe("deterministic search (FR-004)", () => {
  it("matches product name case-insensitively", async () => {
    await seed();
    const lower = await search({ query: "chatgpt" });
    const upper = await search({ query: "CHATGPT" });
    expect(lower.items.length).toBeGreaterThan(0);
    expect(lower.items.map((v) => v.sku).sort()).toEqual(upper.items.map((v) => v.sku).sort());
    expect(lower.items.every((v) => v.sku.startsWith("CG-"))).toBe(true);
  });

  it("matches category queries through the normalized search path", async () => {
    await seed();
    const accented = await search({ query: "AI" });
    const folded = await search({ query: "ai" });
    expect(folded.items.length).toBeGreaterThan(0);
    expect(folded.items.map((v) => v.sku).sort()).toEqual(accented.items.map((v) => v.sku).sort());
  });

  it("matches by alias", async () => {
    await seed();
    const byAlias = await search({ query: "chatbot" });
    expect(byAlias.items.every((v) => v.sku.startsWith("CG-"))).toBe(true);
    expect(byAlias.items.length).toBe(2);
  });

  it("applies a bounded price range filter", async () => {
    await seed();
    const midRange = await search({ minPriceVnd: 120000, maxPriceVnd: 180000 });
    expect(midRange.items.map((v) => v.sku).sort()).toEqual(["CL-1", "SUP-OK"]);
  });

  it("applies a delivery-type filter", async () => {
    await seed();
    const invites = await search({ deliveryType: "INVITE" });
    expect(invites.items.map((v) => v.sku)).toEqual(["CL-1"]);
  });

  it("returns nothing for a query that matches no authoritative product (no invention)", async () => {
    await seed();
    const none = await search({ query: "khong-ton-tai-xyz" });
    expect(none.items).toHaveLength(0);
  });

  it("returns configured supplier-only variants but still excludes legacy unconfigured supplier-only", async () => {
    await seed();
    const ready = await search({ query: "supplier ready" });
    expect(ready.items.map((v) => v.sku)).toEqual(["SUP-OK"]);

    const blocked = await search({ query: "supplier blocked" });
    expect(blocked.items).toHaveLength(0);
  });

  it("scopes by category id", async () => {
    const ids = await seed();
    const inCat = await search({ categoryId: ids.catId });
    expect(inCat.items.map((v) => v.sku).sort()).toEqual(["CG-1", "CG-2", "CL-1", "SUP-OK"]);
    const otherCat = await search({ categoryId: newId() });
    expect(otherCat.items).toHaveLength(0);
  });

  it("matches a product by its tags, accent-folded like the other terms", async () => {
    await seed();
    const byTag = await search({ query: "coding" });
    expect(byTag.items.map((v) => v.sku)).toEqual(["CL-1"]);

    const byAccentedTag = await search({ query: "tro ly" });
    expect(byAccentedTag.items.map((v) => v.sku)).toEqual(["CL-1"]);
  });
});
