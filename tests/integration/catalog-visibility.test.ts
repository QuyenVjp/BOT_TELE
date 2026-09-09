import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { newId } from "../../src/shared/ids/index.js";
import { searchCatalog } from "../../src/modules/catalog/search.js";
import { getVariantById, listSellableVariants } from "../../src/modules/catalog/repository.js";
import { resolveCatalogAudience } from "../../src/modules/catalog/visibility.js";
import {
  addTestCustomer,
  canPurchase,
  setStoreMode,
} from "../../src/modules/commerce/store-mode.js";
import { startPostgresContainer, type PgTestContext } from "../helpers/pg-container.js";

let ctx: PgTestContext;

beforeAll(async () => {
  ctx = await startPostgresContainer();
}, 180_000);

afterAll(async () => {
  await ctx?.teardown();
});

beforeEach(async () => {
  await sql`
    truncate table test_customer_allowlist, store_control, product_variant, product, category, customer cascade
  `.execute(ctx.db);
});

async function seedPair(): Promise<{ publicId: string; testId: string; hiddenId: string }> {
  const categoryId = newId();
  const publicProduct = newId();
  const testProduct = newId();
  const publicId = newId();
  const testId = newId();
  const hiddenId = newId();
  await sql`insert into category (id, name_vi, slug, is_active, sort_order) values (${categoryId}, 'AI', 'ai', true, 1)`.execute(
    ctx.db,
  );
  await sql`
    insert into product (id, category_id, name_vi, slug, is_active, sort_order, is_test, is_archived)
    values
      (${publicProduct}, ${categoryId}, 'GPT Plus', 'gpt-plus', true, 1, false, false),
      (${testProduct}, ${categoryId}, 'GPT Test', 'gpt-test', true, 2, true, false)
  `.execute(ctx.db);
  await sql`
    insert into product_variant
      (id, product_id, sku, name_vi, price_vnd, duration_code, delivery_type, warranty_days,
       stock_policy, resale_evidence_id, is_active, sort_order)
    values
      (${publicId}, ${publicProduct}, 'GPT-PLUS-1M', '1 tháng', 250000, 'P1M', 'CREDENTIAL', 30,
       'LOCAL_ONLY', 'RES-PUBLIC', true, 1),
      (${testId}, ${testProduct}, 'TEST-ACCOUNT-AUTO', 'Test 1 tháng', 250000, 'P1M', 'CREDENTIAL', 30,
       'LOCAL_ONLY', null, true, 2),
      (${hiddenId}, ${publicProduct}, 'NO-EVIDENCE', 'Ẩn', 250000, 'P1M', 'CREDENTIAL', 30,
       'LOCAL_ONLY', null, true, 3)
  `.execute(ctx.db);
  return { publicId, testId, hiddenId };
}

describe("catalog visibility (public vs test)", () => {
  it("keeps frozen canPurchase CLOSED semantics", async () => {
    await setStoreMode(ctx.db, "CLOSED", "test");
    const gate = await canPurchase(ctx.db, {
      telegramUserId: "1",
      isRootAdmin: true,
      variantIsTest: false,
    });
    expect(gate).toEqual({ ok: false, code: "STORE_CLOSED" });
  });

  it("hides is_test and missing-evidence SKUs from public search and getVariantById", async () => {
    const ids = await seedPair();
    const page = await searchCatalog(ctx.db, { query: "gpt" }, { limit: 20 });
    expect(page.items.map((row) => row.id).sort((a, b) => a.localeCompare(b))).toEqual([
      ids.publicId,
    ]);
    expect(await getVariantById(ctx.db, ids.publicId)).not.toBeNull();
    expect(await getVariantById(ctx.db, ids.testId)).toBeNull();
    expect(await getVariantById(ctx.db, ids.hiddenId)).toBeNull();
    const listed = await listSellableVariants(ctx.db, { limit: 50 });
    expect(listed.items.map((row) => row.id)).toEqual([ids.publicId]);
  });

  it("allows TEST allowlist to see test SKUs without changing public browse", async () => {
    const ids = await seedPair();
    await setStoreMode(ctx.db, "TEST", "test");
    await addTestCustomer(ctx.db, "42", "root");
    const audience = await resolveCatalogAudience(ctx.db, {
      telegramUserId: "42",
      isRootAdmin: false,
    });
    expect(audience).toBe("test");
    const page = await searchCatalog(ctx.db, { query: "gpt" }, { limit: 20, audience });
    expect(page.items.map((row) => row.id).sort((a, b) => a.localeCompare(b))).toEqual(
      [ids.publicId, ids.testId].sort((a, b) => a.localeCompare(b)),
    );
    expect(await getVariantById(ctx.db, ids.testId, "test")).not.toBeNull();
    expect(await getVariantById(ctx.db, ids.testId, "public")).toBeNull();
    const listedPublic = await listSellableVariants(ctx.db, { limit: 50, audience: "public" });
    expect(listedPublic.items.map((row) => row.id)).toEqual([ids.publicId]);
    const listedTest = await listSellableVariants(ctx.db, { limit: 50, audience: "test" });
    expect(listedTest.items.map((row) => row.id).sort((a, b) => a.localeCompare(b))).toEqual(
      [ids.publicId, ids.testId].sort((a, b) => a.localeCompare(b)),
    );
    const stranger = await resolveCatalogAudience(ctx.db, { telegramUserId: "99" });
    expect(stranger).toBe("public");
  });
});
