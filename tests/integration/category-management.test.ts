import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { startPostgresContainer, type PgTestContext } from "../helpers/pg-container.js";
import {
  createCategory,
  ensureDefaultCategories,
  getOrCreateUncategorizedCategory,
  listCategoriesWithCounts,
  listAdminCategories,
  renameCategory,
  reorderCategory,
  setCategoryActive,
} from "../../src/modules/catalog/repository.js";
import { newId } from "../../src/shared/ids/index.js";

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

describe("category management repository", () => {
  it("supports CRUD, counts, active picker, and reordering", async () => {
    const first = await createCategory(ctx.db, { nameVi: "Công cụ AI" });
    const second = await createCategory(ctx.db, { nameVi: "Dịch vụ đám mây" });
    const productId = newId();
    await sql`insert into product (id, category_id, name_vi, slug, is_active, sort_order) values (${productId}, ${first.id}, 'Bot', 'bot', true, 1)`.execute(
      ctx.db,
    );
    expect(
      (await listCategoriesWithCounts(ctx.db)).find((c) => c.id === first.id)?.product_count,
    ).toBe(1);
    await renameCategory(ctx.db, second.id, "VPS");
    await setCategoryActive(ctx.db, second.id, false);
    expect((await listAdminCategories(ctx.db)).map((c) => c.id)).toEqual([first.id]);
    await setCategoryActive(ctx.db, second.id, true);
    await reorderCategory(ctx.db, second.id, "up");
    expect((await listAdminCategories(ctx.db)).map((c) => c.id)).toEqual([second.id, first.id]);
  });

  it("seeds five defaults only when no active category exists and is idempotent", async () => {
    await ensureDefaultCategories(ctx.db);
    expect(await listAdminCategories(ctx.db)).toHaveLength(5);
    await ensureDefaultCategories(ctx.db);
    expect(await listAdminCategories(ctx.db)).toHaveLength(5);
  });

  it("creates and reuses an active uncategorized category", async () => {
    const first = await getOrCreateUncategorizedCategory(ctx.db);
    expect(first.name_vi).toBe("📁 Khác");
    await setCategoryActive(ctx.db, first.id, false);
    const second = await getOrCreateUncategorizedCategory(ctx.db);
    expect(second.id).toBe(first.id);
    expect(second.is_active).toBe(true);
  });
});
