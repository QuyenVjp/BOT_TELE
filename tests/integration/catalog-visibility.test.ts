import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { newId } from "../../src/shared/ids/index.js";
import { searchCatalog } from "../../src/modules/catalog/search.js";
import {
  getVariantById,
  listAdminCategories,
  listPublicCategoryPage,
  listPublicRootCategories,
  listSellableVariants,
} from "../../src/modules/catalog/repository.js";
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

async function insertCategory(input: {
  name: string;
  slug: string;
  parentId?: string;
  sortOrder?: number;
}): Promise<string> {
  const id = newId();
  await sql`
    insert into category (id, name_vi, slug, is_active, sort_order, parent_id)
    values (${id}, ${input.name}, ${input.slug}, true, ${input.sortOrder ?? 1}, ${input.parentId ?? null})
  `.execute(ctx.db);
  return id;
}

async function insertSellable(input: {
  categoryId: string;
  name: string;
  slug: string;
  isTest?: boolean;
  isArchived?: boolean;
  evidence?: string | null;
}): Promise<void> {
  const productId = newId();
  const variantId = newId();
  await sql`
    insert into product (id, category_id, name_vi, slug, is_active, sort_order, is_test, is_archived)
    values (
      ${productId}, ${input.categoryId}, ${input.name}, ${input.slug}, true, 1,
      ${input.isTest ?? false}, ${input.isArchived ?? false}
    )
  `.execute(ctx.db);
  await sql`
    insert into product_variant
      (id, product_id, sku, name_vi, price_vnd, duration_code, delivery_type, warranty_days,
       stock_policy, resale_evidence_id, is_active, sort_order)
    values (
      ${variantId}, ${productId}, ${input.slug.toUpperCase()}, '1 tháng', 250000, 'P1M', 'CREDENTIAL', 30,
      'LOCAL_ONLY', ${input.evidence === undefined ? "RES-PUBLIC" : input.evidence}, true, 1
    )
  `.execute(ctx.db);
}

describe("public category visibility", () => {
  it("hides empty roots from public listings and empty category pages", async () => {
    const emptyId = await insertCategory({ name: "Gemini", slug: "gemini" });
    expect(await listPublicRootCategories(ctx.db, "public")).toEqual([]);
    expect(await listPublicCategoryPage(ctx.db, emptyId, "public")).toBeNull();
    expect((await listAdminCategories(ctx.db)).map((row) => row.slug)).toContain("gemini");
  });

  it("hides roots that only have is_test descendants from public, not from test audience", async () => {
    const rootId = await insertCategory({ name: "Khác", slug: "khac" });
    await insertSellable({
      categoryId: rootId,
      name: "Canary",
      slug: "canary-test",
      isTest: true,
      evidence: null,
    });
    expect(await listPublicRootCategories(ctx.db, "public")).toEqual([]);
    expect(await listPublicCategoryPage(ctx.db, rootId, "public")).toBeNull();
    const testRoots = await listPublicRootCategories(ctx.db, "test");
    expect(testRoots.map((row) => row.slug)).toEqual(["khac"]);
    expect(await listPublicCategoryPage(ctx.db, rootId, "test")).not.toBeNull();
  });

  it("hides roots that only have archived descendants from public and test audiences", async () => {
    const rootId = await insertCategory({ name: "Cloud / VPS", slug: "cloud" });
    await insertSellable({
      categoryId: rootId,
      name: "Old VPS",
      slug: "old-vps",
      isArchived: true,
    });
    expect(await listPublicRootCategories(ctx.db, "public")).toEqual([]);
    expect(await listPublicRootCategories(ctx.db, "test")).toEqual([]);
    expect(await listPublicCategoryPage(ctx.db, rootId, "public")).toBeNull();
    expect(await listPublicCategoryPage(ctx.db, rootId, "test")).toBeNull();
  });

  it("shows a root with an active public product", async () => {
    const rootId = await insertCategory({ name: "AI", slug: "ai" });
    await insertSellable({ categoryId: rootId, name: "Claude Pro", slug: "claude-pro" });
    const roots = await listPublicRootCategories(ctx.db, "public");
    expect(roots.map((row) => row.slug)).toEqual(["ai"]);
    expect(await listPublicCategoryPage(ctx.db, rootId, "public")).not.toBeNull();
  });

  it("shows a parent when a child has a public product and hides empty sibling brands", async () => {
    const parentId = await insertCategory({ name: "AI", slug: "ai" });
    const claudeId = await insertCategory({
      name: "Claude",
      slug: "claude",
      parentId,
      sortOrder: 1,
    });
    const geminiId = await insertCategory({
      name: "Gemini",
      slug: "gemini",
      parentId,
      sortOrder: 2,
    });
    await insertSellable({ categoryId: claudeId, name: "Claude Pro", slug: "claude-pro" });
    const roots = await listPublicRootCategories(ctx.db, "public");
    expect(roots.map((row) => row.slug)).toEqual(["ai"]);
    const page = await listPublicCategoryPage(ctx.db, parentId, "public");
    expect(page?.children.map((row) => row.slug)).toEqual(["claude"]);
    expect(await listPublicCategoryPage(ctx.db, claudeId, "public")).not.toBeNull();
    expect(await listPublicCategoryPage(ctx.db, geminiId, "public")).toBeNull();
  });

  it("keeps TEST-only categories hidden from CLOSED/OPEN public browse", async () => {
    const rootId = await insertCategory({ name: "Khác", slug: "khac" });
    await insertSellable({
      categoryId: rootId,
      name: "Canary",
      slug: "canary-test",
      isTest: true,
      evidence: null,
    });
    await addTestCustomer(ctx.db, "42", "root");
    for (const mode of ["CLOSED", "OPEN"] as const) {
      await setStoreMode(ctx.db, mode, "test");
      expect(await resolveCatalogAudience(ctx.db, { telegramUserId: "42" })).toBe("public");
      expect(await listPublicRootCategories(ctx.db, "public")).toEqual([]);
    }
    await setStoreMode(ctx.db, "TEST", "test");
    expect(await resolveCatalogAudience(ctx.db, { telegramUserId: "42", isRootAdmin: false })).toBe(
      "test",
    );
    expect(await resolveCatalogAudience(ctx.db, { telegramUserId: "99" })).toBe("public");
    expect((await listPublicRootCategories(ctx.db, "test")).map((row) => row.slug)).toEqual([
      "khac",
    ]);
    expect(await listPublicRootCategories(ctx.db, "public")).toEqual([]);
  });
});
