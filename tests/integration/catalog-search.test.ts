import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { newId } from "../../src/shared/ids/index.js";
import { searchCatalog, type CatalogFilter } from "../../src/modules/catalog/search.js";
import { startPostgresContainer, type PgTestContext } from "../helpers/pg-container.js";

/**
 * T026 — Deterministic search + Unicode normalization (FR-004).
 *
 * Deterministic search matches product name, category, and alias using a
 * fold-normalized form (NFC + lowercase + Vietnamese accent fold), so "netflix",
 * "NETFLIX", and an accented alias all resolve. Filters (price range, delivery
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
  const netflixId = newId();
  const spotifyId = newId();
  const supplierId = newId();
  const supplierOkId = newId();
  const supplierSkuId = newId();

  await sql`insert into category (id, name_vi, slug, is_active, sort_order) values (${catId}, 'Giải trí', 'giai-tri', true, 1)`.execute(
    ctx.db,
  );
  await sql`
    insert into product (id, category_id, name_vi, slug, is_active, sort_order) values
      (${netflixId}, ${catId}, 'Netflix Premium', 'netflix', true, 1),
      (${spotifyId}, ${catId}, 'Spotify Family', 'spotify', true, 2),
      (${supplierId}, ${catId}, 'Supplier Blocked', 'supplier-blocked', true, 3),
      (${supplierOkId}, ${catId}, 'Supplier Ready', 'supplier-ready', true, 4)
  `.execute(ctx.db);

  // Tags are plain text terms the owner sets on the product (goal §27/§28).
  await sql`
    update product set tags = array['4k', 'gia dinh'] where id = ${spotifyId}
  `.execute(ctx.db);

  // Aliases are pre-normalized (fold form) at write time.
  await sql`
    insert into product_alias (id, product_id, normalized_alias, locale, priority) values
      (${newId()}, ${netflixId}, 'phim', 'vi', 1),
      (${spotifyId ? newId() : newId()}, ${spotifyId}, 'nhac', 'vi', 1)
  `.execute(ctx.db);

  const mkVariant = (
    productId: string,
    sku: string,
    price: number,
    delivery: string,
    order: number,
  ) =>
    sql`
      insert into product_variant
        (id, product_id, sku, name_vi, price_vnd, duration_code, delivery_type, warranty_days,
         stock_policy, resale_evidence_id, is_active, sort_order)
      values
        (${newId()}, ${productId}, ${sku}, ${sku}, ${price}, 'P1M', ${delivery}, 30,
         'LOCAL_ONLY', ${"RES-" + sku}, true, ${order})
    `;
  await mkVariant(netflixId, "NF-1", 100000, "LICENSE", 1).execute(ctx.db);
  await mkVariant(netflixId, "NF-2", 200000, "ACTIVATION_KEY", 2).execute(ctx.db);
  await mkVariant(spotifyId, "SP-1", 150000, "INVITE", 3).execute(ctx.db);
  await sql`
    insert into product_variant
      (id, product_id, sku, name_vi, price_vnd, duration_code, delivery_type, warranty_days,
       stock_policy, resale_evidence_id, is_active, sort_order)
    values
      (${newId()}, ${supplierId}, 'SUP-1', 'SUP-1', 180000, 'P1M', 'LICENSE', 30,
       'SUPPLIER_ONLY', 'RES-SUP', true, 4)
  `.execute(ctx.db);
  await sql`
    insert into product_variant
      (id, product_id, sku, name_vi, price_vnd, duration_code, delivery_type, warranty_days,
       stock_policy, resale_evidence_id, is_active, sort_order, fulfillment_type)
    values
      (${newId()}, ${supplierOkId}, 'SUP-OK', 'SUP-OK', 180000, 'P1M', 'LICENSE', 30,
       'SUPPLIER_ONLY', 'RES-SUP-OK', true, 5, 'SUPPLIER_API')
  `.execute(ctx.db);
  await sql`insert into supplier (id, name, adapter_type, credential_vault_ref, status) values (${supplierSkuId}, 'Primary', 'sandbox', 'vault:supplier', 'ACTIVE')`.execute(
    ctx.db,
  );
  await sql`
    insert into supplier_sku (id, supplier_id, variant_id, external_sku, cost_vnd, delivery_type, is_active)
    select ${newId()}, ${supplierSkuId}, id, 'EXT-SUP-OK', 50000, 'LICENSE', true
    from product_variant where sku = 'SUP-OK'
  `.execute(ctx.db);

  return { catId, netflixId, spotifyId };
}

async function search(filter: CatalogFilter) {
  return searchCatalog(ctx.db, filter, { limit: 50 });
}

describe("deterministic search (FR-004)", () => {
  it("matches product name case-insensitively", async () => {
    await seed();
    const lower = await search({ query: "netflix" });
    const upper = await search({ query: "NETFLIX" });
    expect(lower.items.length).toBeGreaterThan(0);
    expect(lower.items.map((v) => v.sku).sort()).toEqual(upper.items.map((v) => v.sku).sort());
    expect(lower.items.every((v) => v.sku.startsWith("NF-"))).toBe(true);
  });

  it("matches accented queries via fold normalization", async () => {
    await seed();
    // "Giải trí" category name matched by unaccented "giai tri".
    const accented = await search({ query: "Giải trí" });
    const folded = await search({ query: "giai tri" });
    expect(folded.items.length).toBeGreaterThan(0);
    expect(folded.items.map((v) => v.sku).sort()).toEqual(accented.items.map((v) => v.sku).sort());
  });

  it("matches by alias", async () => {
    await seed();
    const byAlias = await search({ query: "phim" });
    expect(byAlias.items.every((v) => v.sku.startsWith("NF-"))).toBe(true);
    expect(byAlias.items.length).toBe(2);
  });

  it("applies a bounded price range filter", async () => {
    await seed();
    const midRange = await search({ minPriceVnd: 120000, maxPriceVnd: 180000 });
    expect(midRange.items.map((v) => v.sku).sort()).toEqual(["SP-1", "SUP-OK"]);
  });

  it("applies a delivery-type filter", async () => {
    await seed();
    const invites = await search({ deliveryType: "INVITE" });
    expect(invites.items.map((v) => v.sku)).toEqual(["SP-1"]);
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
    expect(inCat.items.map((v) => v.sku).sort()).toEqual(["NF-1", "NF-2", "SP-1", "SUP-OK"]);
    const otherCat = await search({ categoryId: newId() });
    expect(otherCat.items).toHaveLength(0);
  });

  it("matches a product by its tags, accent-folded like the other terms", async () => {
    await seed();
    const byTag = await search({ query: "4k" });
    expect(byTag.items.map((v) => v.sku)).toEqual(["SP-1"]);

    const byAccentedTag = await search({ query: "gia dinh" });
    expect(byAccentedTag.items.map((v) => v.sku)).toEqual(["SP-1"]);
  });
});
