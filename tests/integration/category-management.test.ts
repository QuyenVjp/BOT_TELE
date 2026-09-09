import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { startPostgresContainer, type PgTestContext } from "../helpers/pg-container.js";
import {
  createCategory,
  ensureDefaultCategories,
  getOrCreateUncategorizedCategory,
  listCategoriesWithCounts,
  listAdminCategories,
  listPublicRootCategories,
  listPublicCategoryPage,
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

  it("seeds customer taxonomy roots and brands and is idempotent", async () => {
    await ensureDefaultCategories(ctx.db);
    const first = await listAdminCategories(ctx.db);
    const slugs = first.map((c) => c.slug);
    expect(slugs).toEqual(
      expect.arrayContaining(["ai", "vpn", "claude", "chatgpt", "expressvpn", "hma"]),
    );
    expect(first.length).toBeGreaterThanOrEqual(16);
    await ensureDefaultCategories(ctx.db);
    expect(await listAdminCategories(ctx.db)).toHaveLength(first.length);
  });

  it("maps customer brands under AI/VPN and hides fulfillment buckets", async () => {
    const bucket = await createCategory(ctx.db, { nameVi: "Tài khoản AI" });
    const claudeId = newId();
    const vpnId = newId();
    const randomId = newId();
    await sql`insert into product (id, category_id, name_vi, slug, is_active, sort_order) values
      (${claudeId}, ${bucket.id}, 'Claude Pro', 'claude-pro', true, 1),
      (${vpnId}, ${bucket.id}, 'ExpressVPN 1 tháng', 'expressvpn-1m', true, 2),
      (${randomId}, ${bucket.id}, 'Gói lẻ khác', 'goi-le-khac', true, 3)`.execute(ctx.db);
    await sql`
      insert into product_variant
        (id, product_id, sku, name_vi, price_vnd, duration_code, delivery_type, warranty_days,
         stock_policy, resale_evidence_id, is_active, sort_order, fulfillment_type)
      values
        (${newId()}, ${claudeId}, 'CLAUDE-PRO-1M', '1 tháng', 250000, 'P1M', 'CREDENTIAL', 30,
         'LOCAL_ONLY', 'RES-CLAUDE', true, 1, 'STOCK_ACCOUNT'),
        (${newId()}, ${vpnId}, 'EXPRESS-1M', '1 tháng', 150000, 'P1M', 'LICENSE', 30,
         'LOCAL_ONLY', 'RES-VPN', true, 1, 'STOCK_CODE')
    `.execute(ctx.db);
    await ensureDefaultCategories(ctx.db);
    const claude = (
      await sql<{
        category_id: string;
        parent_id: string | null;
        slug: string;
        parent_slug: string | null;
      }>`
        select p.category_id, c.parent_id, c.slug, parent.slug as parent_slug
        from product p
        join category c on c.id = p.category_id
        left join category parent on parent.id = c.parent_id
        where p.id = ${claudeId}
      `.execute(ctx.db)
    ).rows[0];
    expect(claude?.slug).toBe("claude");
    expect(claude?.parent_slug).toBe("ai");
    const leftover = (
      await sql<{ slug: string }>`
        select c.slug from product p join category c on c.id = p.category_id where p.id = ${randomId}
      `.execute(ctx.db)
    ).rows[0];
    expect(leftover?.slug).toBe("khac");
    const aliases = (
      await sql<{ normalized_alias: string }>`select normalized_alias from product_alias`.execute(
        ctx.db,
      )
    ).rows.map((row) => row.normalized_alias);
    expect(aliases).not.toContain("vpn");
    const publicRoots = await listPublicRootCategories(ctx.db);
    expect(publicRoots.map((c) => c.slug)).not.toEqual(
      expect.arrayContaining(["tai-khoan-ai", "tai-khoan"]),
    );
    expect(publicRoots.some((c) => c.slug === "ai")).toBe(true);
    const vpn = publicRoots.find((c) => c.slug === "vpn");
    expect(vpn).toBeDefined();
    const vpnPage = await listPublicCategoryPage(ctx.db, vpn!.id);
    expect(vpnPage?.children.map((c) => c.slug)).toEqual(expect.arrayContaining(["expressvpn"]));
    const ai = publicRoots.find((c) => c.slug === "ai");
    const aiPage = await listPublicCategoryPage(ctx.db, ai!.id);
    expect(aiPage?.children.map((c) => c.slug)).toEqual(expect.arrayContaining(["claude"]));
  });
  it("creates and reuses an active uncategorized category", async () => {
    const first = await getOrCreateUncategorizedCategory(ctx.db);
    expect(first.name_vi).toBe("📦 Khác");
    await setCategoryActive(ctx.db, first.id, false);
    const second = await getOrCreateUncategorizedCategory(ctx.db);
    expect(second.id).toBe(first.id);
    expect(second.is_active).toBe(true);
  });
});
