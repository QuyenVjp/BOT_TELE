import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { seedCatalog } from "../../src/infrastructure/db/seeds/catalog.js";
import { createCatalogCallbacks } from "../../src/bot/callbacks/catalog.js";
import { createBuyNowCallbackCodec } from "../../src/bot/callback-codec.js";
import { createSearchParser } from "../../src/modules/catalog/search-parser-adapter.js";
import { startPostgresContainer, type PgTestContext } from "../helpers/pg-container.js";

/**
 * T028 — Catalog journey acceptance (FR-001–FR-005, SC-001/SC-002).
 *
 * Drives the full US1 slice through the callback layer against a real database
 * seeded with safe fixtures (including one unauthorized SKU that must never
 * surface). Proves a first-time customer can: open the menu, browse a category,
 * open a product, and search — all without creating an Order and without any
 * payment/supplier/credential capability.
 *
 * SC-002: the happy path reaches the Buy Now action in <= 4 deliberate actions
 * from the main menu (menu -> category -> variant list -> variant detail[Buy Now]).
 */

let ctx: PgTestContext;
let callbacks: ReturnType<typeof createCatalogCallbacks>;
const TELEGRAM_USER_ID = "123456789";

beforeAll(async () => {
  ctx = await startPostgresContainer();
}, 180_000);

afterAll(async () => {
  await ctx?.teardown();
});

beforeEach(async () => {
  await sql`truncate table digital_asset, product_variant, product_alias, product, category cascade`.execute(
    ctx.db,
  );
  await seedCatalog(ctx.db);
  await sql`
    insert into digital_asset (id, variant_id, source_type, vault_ref, fingerprint_hash, status)
    select gen_random_uuid()::text, id, 'LOCAL', 'vault:' || id, 'fp-' || id, 'AVAILABLE'
    from product_variant
    where sku in ('NF-1M', 'NF-3M', 'SP-1M')
  `.execute(ctx.db);
  callbacks = createCatalogCallbacks({
    db: ctx.db,
    parser: createSearchParser({ driver: "deterministic", timeoutMs: 100 }),
    callbackCodec: createBuyNowCallbackCodec({
      key: "test-only-buy-now-callback-key-material-v1",
      keyVersion: 1,
      ttlSeconds: 900,
      clockSkewSeconds: 5,
    }),
  });
});

describe("catalog journey (US1)", () => {
  it("presents a retail-only main menu (FR-001)", async () => {
    const menu = await callbacks.mainMenu();
    expect(menu.text).toContain("TIER20 SHOP");
    const labels = menu.buttons.flat().map((b) => b.text.toLowerCase());
    // Retail-only: no wallet/top-up/reseller/api/supplier/admin controls.
    for (const forbidden of ["ví", "nạp", "đại lý", "api", "quản trị", "supplier"]) {
      expect(labels.join(" ")).not.toContain(forbidden);
    }
  });

  it("lists only active categories (FR-002)", async () => {
    const list = await callbacks.categoryList();
    // Seed has at least one active category and one inactive one.
    expect(list.buttons.length).toBeGreaterThan(0);
    expect(list.text.toLowerCase()).not.toContain("ẩn");
  });

  it("browses a category to sellable variants, hiding the unauthorized SKU (FR-002/SR-007)", async () => {
    const categories = await callbacks.listCategoryIds();
    const first = categories[0]!;
    const page = await callbacks.categoryView(first);
    expect(page.buttons.length).toBeGreaterThan(0);
    expect(page.text).not.toContain("Chưa được phép");
    expect(page.text.toLowerCase()).not.toContain("tài khoản");
  });

  it("opens a product detail showing all FR-003 authoritative fields", async () => {
    const variantId = await callbacks.firstSellableVariantId();
    const detail = await callbacks.variantDetail(variantId, TELEGRAM_USER_ID);
    for (const field of ["Giá:", "Tình trạng:", "Thời hạn:", "Loại giao:"]) {
      expect(detail.text).toContain(field);
    }
    // Buy Now is reachable from detail.
    const hasBuy = detail.buttons.flat().some((b) => b.callbackData.startsWith("buy:"));
    expect(hasBuy).toBe(true);
  });

  it("reaches Buy Now within 4 deliberate actions (SC-002)", async () => {
    const menu = await callbacks.mainMenu();
    expect(menu).toBeTruthy();
    const categories = await callbacks.listCategoryIds();
    const list = await callbacks.categoryView(categories[0]!);
    const productBtn = list.buttons.flat().find((b) => b.callbackData.startsWith("shop:product:"));
    expect(productBtn).toBeTruthy();
    const productId = productBtn!.callbackData.split(":")[2]!;
    const detail = await callbacks.productDetail(productId, TELEGRAM_USER_ID);
    const buyBtn = detail.buttons.flat().find((b) => b.callbackData.startsWith("buy:"));
    expect(buyBtn).toBeTruthy();
    // Target product-detail copy: exact price/stock lines, never a raw enum or "Tạm hết hàng".
    expect(detail.text).toContain("💰 Giá từ: ");
    expect(detail.text).toMatch(/(🟢|🟡|🔴) Tình trạng: /u);
    expect(detail.text).not.toContain("Tạm hết hàng");
  });

  it("deterministic search finds a seeded product and never invents one (FR-004/FR-005)", async () => {
    const hit = await callbacks.search("netflix");
    expect(hit.buttons.flat().some((b) => b.callbackData.startsWith("var:view:"))).toBe(true);

    const miss = await callbacks.search("khong-ton-tai-xyz-999");
    expect(miss.buttons.flat().some((b) => b.callbackData.startsWith("var:view:"))).toBe(false);
    // Exact empty state: no fabricated product card, retry and home only.
    expect(miss.text).toBe("Không tìm thấy sản phẩm phù hợp.");
    expect(miss.buttons.flat().map((b) => b.text)).toEqual(["🔎 Tìm lại", "🏠 Trang chủ"]);
  });

  it("never creates an Order during browsing/search (US1 independence)", async () => {
    await callbacks.mainMenu();
    const variantId = await callbacks.firstSellableVariantId();
    await callbacks.variantDetail(variantId, TELEGRAM_USER_ID);
    await callbacks.search("netflix");
    const orders = await sql<{
      count: string;
    }>`select count(*)::text as count from "order"`.execute(ctx.db);
    expect(Number(orders.rows[0]?.count ?? "0")).toBe(0);
  });
});
