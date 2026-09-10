import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { newId } from "../../src/shared/ids/index.js";
import { startPostgresContainer, type PgTestContext } from "../helpers/pg-container.js";
import {
  buildInlineQueryResults,
  parseNaturalSalesQA,
  getGroupCommerceSettings,
  updateGroupCommerceSettings,
} from "../../src/modules/catalog/group-commerce.js";
import {
  presentGroupShopPanel,
  presentGroupWelcome,
  presentGroupPrivacyNotice,
} from "../../src/bot/presenters/group.js";

let ctx: PgTestContext;
const LINK_SECRET = ["test", "group", "link", "secret", "32chars"].join("-");
const BOT_USERNAME = "tier20ai_bot";

beforeAll(async () => {
  ctx = await startPostgresContainer();
}, 180_000);

afterAll(async () => {
  await ctx?.teardown();
});

beforeEach(async () => {
  await sql`
    truncate table group_commerce_settings, group_acquisition_log, digital_asset, product_variant, product, category cascade
  `.execute(ctx.db);
});

async function seedCatalog() {
  const catAi = newId();
  const catVpn = newId();

  await sql`
    insert into category (id, name_vi, slug, is_active, sort_order)
    values (${catAi}, 'AI', 'ai', true, 1),
           (${catVpn}, 'VPN', 'vpn', true, 2)
  `.execute(ctx.db);

  const prodClaude = newId();
  const prodGpt = newId();
  const prodVpn = newId();
  const prodTest = newId();

  await sql`
    insert into product (id, category_id, name_vi, slug, short_description_vi, is_active, is_test, is_archived, featured_rank, sort_order)
    values
      (${prodClaude}, ${catAi}, 'Claude Pro Chính Chủ', 'claude-pro', 'Tài khoản Claude Pro 1 tháng', true, false, false, 10, 1),
      (${prodGpt}, ${catAi}, 'ChatGPT Plus Chính Chủ', 'chatgpt-plus', 'Tài khoản ChatGPT Plus 1 tháng', true, false, false, 5, 2),
      (${prodVpn}, ${catVpn}, 'ExpressVPN Premium', 'expressvpn-premium', 'VPN tốc độ cao', true, false, false, 0, 3),
      (${prodTest}, ${catAi}, 'Test Private Product', 'test-private', 'Chỉ test', true, true, false, 0, 4)
  `.execute(ctx.db);

  const varClaude = newId();
  const varGpt = newId();
  const varVpn = newId();
  const varTest = newId();

  await sql`
    insert into product_variant (id, product_id, name_vi, sku, duration_code, delivery_type, warranty_days, stock_policy, price_vnd, is_active, fulfillment_type, sort_order)
    values
      (${varClaude}, ${prodClaude}, '1 tháng', 'CLAUDE-1M', 'P1M', 'CREDENTIAL', 30, 'LOCAL_ONLY', 280000, true, 'STOCK_ACCOUNT', 1),
      (${varGpt}, ${prodGpt}, '1 tháng', 'GPT-1M', 'P1M', 'CREDENTIAL', 30, 'LOCAL_ONLY', 250000, true, 'STOCK_ACCOUNT', 1),
      (${varVpn}, ${prodVpn}, '1 năm', 'VPN-1Y', 'P1Y', 'CREDENTIAL', 30, 'LOCAL_ONLY', 350000, true, 'STOCK_ACCOUNT', 1),
      (${varTest}, ${prodTest}, '1 tháng', 'TEST-1M', 'P1M', 'CREDENTIAL', 30, 'LOCAL_ONLY', 1000, true, 'STOCK_ACCOUNT', 1)
  `.execute(ctx.db);

  // Add 1 available stock to Claude
  await sql`
    insert into digital_asset (id, variant_id, source_type, vault_ref, fingerprint_hash, status)
    values (${newId()}, ${varClaude}, 'LOCAL', 'vault:ref:1', 'fp1', 'AVAILABLE')
  `.execute(ctx.db);

  return {
    catAi,
    catVpn,
    prodClaude,
    prodGpt,
    prodVpn,
    prodTest,
    varClaude,
    varGpt,
    varVpn,
    varTest,
  };
}

describe("Group Commerce: Inline Query Handling", () => {
  it("empty query returns featured public products without leaking test products", async () => {
    await seedCatalog();
    const results = await buildInlineQueryResults(ctx.db, {
      query: "",
      botUsername: BOT_USERNAME,
      linkSecret: LINK_SECRET,
    });

    expect(results.length).toBeGreaterThan(0);
    expect(results.some((r) => r.title.includes("Claude Pro"))).toBe(true);
    // Never leak test product to public inline search
    expect(results.some((r) => r.title.includes("Test Private"))).toBe(false);
  });

  it("searching 'claude' returns Claude product with stock and deep link", async () => {
    await seedCatalog();
    const results = await buildInlineQueryResults(ctx.db, {
      query: "claude",
      botUsername: BOT_USERNAME,
      linkSecret: LINK_SECRET,
    });

    expect(results).toHaveLength(1);
    const first = results[0]!;
    expect(first.title).toContain("Claude Pro");
    expect(first.description).toContain("280.000 ₫");
    expect(first.description).toContain("Còn hàng");
    expect(first.reply_markup?.inline_keyboard[0]![0]!.text).toBe("🛒 Mua riêng");
    expect(first.reply_markup?.inline_keyboard[0]![0]!.url).toContain(
      "https://t.me/tier20ai_bot?start=p_",
    );
  });

  it("searching 'vpn' returns ExpressVPN", async () => {
    await seedCatalog();
    const results = await buildInlineQueryResults(ctx.db, {
      query: "vpn",
      botUsername: BOT_USERNAME,
      linkSecret: LINK_SECRET,
    });

    expect(results).toHaveLength(1);
    expect(results[0]?.title).toContain("ExpressVPN");
  });
});

describe("Group Commerce: Natural Sales Q&A", () => {
  it("answers price inquiry accurately from database", async () => {
    await seedCatalog();
    const answer = await parseNaturalSalesQA(ctx.db, {
      question: "giá Claude Pro bao nhiêu?",
      botUsername: BOT_USERNAME,
      linkSecret: LINK_SECRET,
    });

    expect(answer).not.toBeNull();
    expect(answer!.text).toContain("Claude Pro");
    expect(answer!.text).toContain("280.000 ₫");
  });

  it("answers stock availability accurately from database", async () => {
    await seedCatalog();
    // Claude is in stock
    const answerClaude = await parseNaturalSalesQA(ctx.db, {
      question: "Claude Pro còn hàng không?",
      botUsername: BOT_USERNAME,
      linkSecret: LINK_SECRET,
    });
    expect(answerClaude!.text).toContain("CÒN HÀNG");

    // ChatGPT is out of stock (0 digital_asset)
    const answerGpt = await parseNaturalSalesQA(ctx.db, {
      question: "ChatGPT Plus còn hàng không?",
      botUsername: BOT_USERNAME,
      linkSecret: LINK_SECRET,
    });
    expect(answerGpt!.text).toContain("tạm hết hàng");
  });

  it("resolves context when user replies to a Claude product card with 'còn không?'", async () => {
    await seedCatalog();
    const answer = await parseNaturalSalesQA(ctx.db, {
      question: "còn không?",
      replyToText: "🔥 CLAUDE PRO\nTài khoản Claude Pro 1 tháng\n💰 Giá từ: 280.000 ₫",
      botUsername: BOT_USERNAME,
      linkSecret: LINK_SECRET,
    });

    expect(answer).not.toBeNull();
    expect(answer!.text).toContain("Claude Pro");
    expect(answer!.text).toContain("CÒN HÀNG");
  });

  it("answers warranty policy FAQ truthfully", async () => {
    await seedCatalog();
    const answer = await parseNaturalSalesQA(ctx.db, {
      question: "chính sách bảo hành thế nào?",
      botUsername: BOT_USERNAME,
      linkSecret: LINK_SECRET,
    });

    expect(answer).not.toBeNull();
    expect(answer!.text).toContain("bảo hành 1 đổi 1");
  });
});

describe("Group Commerce: Presenters & Privacy", () => {
  it("group shop panel provides compact commercial layout and search in group button", () => {
    const panel = presentGroupShopPanel({ botUsername: BOT_USERNAME });
    expect(panel.text).toContain("TIER20 SHOP");
    expect(panel.buttons[0]![1]!.text).toBe("🔎 Xem sản phẩm");
    expect(panel.buttons[0]![1]!.switchInlineQueryCurrentChat).toBe("");
    const flat = panel.buttons.flat();
    expect(flat.find((button) => button.text === "🛒 Mở Shop")?.url).toBe(
      `https://t.me/${BOT_USERNAME}?start=shop`,
    );
    expect(flat.find((button) => button.text.includes("Admin"))?.url).toContain("t.me/");
  });

  it("privacy notices in group never expose sensitive data and direct to private bot", () => {
    const ordersNotice = presentGroupPrivacyNotice("orders", BOT_USERNAME);
    expect(ordersNotice.text.toLowerCase()).toContain("thông tin đơn hàng");
    expect(ordersNotice.buttons[0]![0]!.text).toBe("🧾 Xem đơn riêng");
    expect(ordersNotice.buttons[0]![0]!.url).toBe("https://t.me/tier20ai_bot?start=orders");

    const walletNotice = presentGroupPrivacyNotice("wallet", BOT_USERNAME);
    expect(walletNotice.text.toLowerCase()).toContain("thông tin số dư ví");
    expect(walletNotice.buttons[0]![0]!.text).toBe("💰 Mở ví riêng");
    expect(walletNotice.buttons[0]![0]!.url).toBe("https://t.me/tier20ai_bot?start=wallet");
  });

  it("group welcome message introduces shop and query examples", () => {
    const welcome = presentGroupWelcome({ memberNames: ["Hùng"], botUsername: BOT_USERNAME });
    expect(welcome.text).toContain("Chào mừng *Hùng*");
    expect(welcome.text).toContain("@tier20ai_bot claude");
  });
});

describe("Group Commerce: Settings Persistence", () => {
  it("loads default settings and updates toggles cleanly", async () => {
    const settings = await getGroupCommerceSettings(ctx.db);
    expect(settings.group_reply_mode).toBe("MENTION_ONLY");
    expect(settings.shop_panel_enabled).toBe(true);

    await updateGroupCommerceSettings(ctx.db, {
      group_reply_mode: "PASSIVE_COMMERCE",
      shop_panel_message_id: "998877",
    });

    const updated = await getGroupCommerceSettings(ctx.db);
    expect(updated.group_reply_mode).toBe("PASSIVE_COMMERCE");
    expect(updated.shop_panel_message_id).toBe("998877");
  });
});
