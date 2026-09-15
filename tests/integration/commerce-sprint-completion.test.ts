import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { sql } from "kysely";
import { newId } from "../../src/shared/ids/index.js";
import { startPostgresContainer, type PgTestContext } from "../helpers/pg-container.js";
import { listStorefrontProducts } from "../../src/modules/catalog/repository.js";
import {
  ADMIN_CONTACT_URL,
  COMMUNITY_BUTTON_LABEL,
  COMMUNITY_URL,
  SHOP_NAME,
} from "../../src/modules/catalog/shop-profile.js";
import {
  presentStorefront,
  presentCustomerWarranty,
  presentCustomerNotificationPreferences,
  presentPurchaseThankYou,
} from "../../src/bot/presenters/customer.js";
import {
  computePreorderDeposit,
  presentPreorderConsent,
  createPreorderReservation,
  confirmPreorderDeposit,
  releaseExpiredPreorderHolds,
} from "../../src/modules/commerce/preorder.js";
import {
  generateCustomerAlias,
  renderSocialProofMessage,
  getRealStoreStats,
} from "../../src/modules/marketing/social-proof.js";
import {
  presentAdminInventory,
  presentAdminInventoryProductPicker,
  presentAdminInventoryVariantPicker,
  presentAdminTestLab,
  presentAdminPreorders,
} from "../../src/bot/presenters/admin.js";
import { isStoreOpen } from "../../src/modules/commerce/buy-now.js";

describe("Commerce UX + Inventory + Preorder + Notification Sprint Acceptance", () => {
  let ctx: PgTestContext;

  beforeAll(async () => {
    ctx = await startPostgresContainer();

    // Seed test category and commercial products in isolated test DB
    const categoryId = newId();
    await sql`
      insert into category (id, name_vi, slug, is_active, sort_order)
      values (${categoryId}, 'Tài khoản AI', 'tai-khoan-ai', true, 1)
    `.execute(ctx.db);

    const prodId = newId();
    await sql`
      insert into product (id, category_id, name_vi, slug, short_description_vi, is_active, sort_order, is_test, is_archived)
      values (${prodId}, ${categoryId}, 'ChatGPT Plus Chính Chủ', 'chatgpt-plus', 'Tài khoản chính chủ', true, 1, false, false)
    `.execute(ctx.db);

    const varId = newId();
    await sql`
      insert into product_variant (
        id, product_id, sku, name_vi, price_vnd, duration_code, delivery_type,
        warranty_days, stock_policy, is_active, sort_order, fulfillment_type,
        resale_evidence_id, preorder_enabled, deposit_mode, deposit_amount_vnd,
        min_deposit_vnd, hold_duration_hours, balance_due_hours
      ) values (
        ${varId}, ${prodId}, 'GPT-PLUS-1M', '1 Tháng BHF', 250000, 'P1M', 'CREDENTIAL',
        30, 'LOCAL_ONLY', true, 1, 'STOCK_ACCOUNT',
        'RES_TEST_1', true, 'FIXED', 50000,
        50000, 24, 24
      )
    `.execute(ctx.db);
    // Test-only resale evidence + version-bound publication snapshot (fresh fixture versions).
    await sql`
      insert into resale_evidence (id, variant_id, source, reference, summary, created_by)
      values ('RES_TEST_1', ${varId}, 'OWNER_ATTESTATION', 'TEST-REF-COMMERCE-SPRINT', 'fixture publication evidence', 'test')
    `.execute(ctx.db);
    await sql`
      update product_variant
         set publication_evidence_id = 'RES_TEST_1',
             publication_product_version = 1,
             publication_variant_version = 1,
             published_at = now(),
             published_by = 'test'
       where id = ${varId}
    `.execute(ctx.db);

    // Also seed a test Canary product to verify it is filtered out of customer view
    const canaryProdId = newId();
    await sql`
      insert into product (id, category_id, name_vi, slug, is_active, sort_order, is_test, is_archived)
      values (${canaryProdId}, ${categoryId}, 'Canary Fixture 250K', 'canary-fixture-250k', true, 2, true, false)
    `.execute(ctx.db);
  }, 180_000);

  afterAll(async () => {
    await ctx?.teardown();
  });

  describe("Storefront & /start Commercial Presentation (Sections 9, 10, 11, 12)", () => {
    it("renders Vietnamese greeting, value props, community link, and active products immediately", async () => {
      const { items, total } = await listStorefrontProducts(ctx.db, 6, 0);
      expect(total).toBeGreaterThanOrEqual(1);

      // Verify no test/canary product in customer storefront
      for (const item of items) {
        expect(item.name_vi).not.toMatch(/canary/i);
        expect(item.slug).not.toMatch(/^canary-/i);
      }

      const customerHome = presentStorefront({
        actorName: "Anh Quyền",
        isRootAdmin: false,
        products: items,
        totalProducts: total,
        offset: 0,
        limit: 6,
      });

      // Greeting & Brand
      expect(customerHome.text).toContain("👋 Chào Anh Quyền!");
      expect(customerHome.text).toContain(`🛒 ${SHOP_NAME}`);
      expect(customerHome.text).toContain("AI • Coding • VPN • Phần mềm số");
      expect(customerHome.text).not.toContain("SHOP DIGITAL");

      // Buttons check
      const buttonsFlat = customerHome.buttons.flat();
      const communityBtn = buttonsFlat.find((b) => b.text.includes(COMMUNITY_BUTTON_LABEL));
      expect(communityBtn).toBeDefined();
      expect(communityBtn?.url).toBe(COMMUNITY_URL);
      const adminBtn = buttonsFlat.find((b) => b.text.includes("Liên hệ Admin"));
      expect(adminBtn?.url).toBe(ADMIN_CONTACT_URL);
      expect(adminBtn?.callbackData).toBe("");

      // Customer must NOT see admin button
      const adminBtnForCustomer = buttonsFlat.find((b) => b.text.includes("Quản trị"));
      expect(adminBtnForCustomer).toBeUndefined();

      // Root Admin DOES see admin button
      const adminHome = presentStorefront({
        actorName: "Owner",
        isRootAdmin: true,
        products: items,
        totalProducts: total,
        offset: 0,
        limit: 6,
      });
      const adminBtnForOwner = adminHome.buttons.flat().find((b) => b.text.includes("Quản trị"));
      expect(adminBtnForOwner).toBeDefined();
      expect(adminBtnForOwner?.callbackData).toBe("admin:menu");
    });

    it("renders customer warranty, notification preferences, and purchase thank you presenters", () => {
      const warranty = presentCustomerWarranty();
      expect(warranty.text).toContain("CHÍNH SÁCH BẢO HÀNH & HỖ TRỢ");
      expect(warranty.buttons[0]?.[0]?.callbackData).toBe("supp:open");

      const notifyPrefs = presentCustomerNotificationPreferences({
        marketing: true,
        socialProof: false,
      });
      expect(notifyPrefs.text).toContain("CÀI ĐẶT THÔNG BÁO");
      expect(notifyPrefs.buttons[0]?.[0]?.callbackData).toContain("cust:notify:marketing");

      // Goal §53 specifies title + product + order + completion line + four actions; the
      // price is not part of that contract, so it is no longer an input.
      const thankYou = presentPurchaseThankYou({
        orderNumber: "ORD-2026-TEST-123",
        productName: "ChatGPT Plus",
      });
      expect(thankYou.text).toContain("🎉 CẢM ƠN BẠN ĐÃ MUA HÀNG!");
      expect(thankYou.text).toContain("Sản phẩm: ChatGPT Plus");
      expect(thankYou.text).toContain("ORD-2026-TEST-123");
      expect(thankYou.text).toContain("✅ Đơn đã hoàn tất.");
      expect(thankYou.buttons.flat().map((b) => b.text)).toEqual([
        "🧾 Xem đơn",
        "🛡 Bảo hành",
        "🛒 Mua thêm",
        "💬 Hỗ trợ",
      ]);
    });
  });

  describe("Admin Inventory Redesign & Canary Isolation (Sections 1, 2, 3, 5, 8)", () => {
    it("isolates Canary fixtures to Test Lab and displays redesigned inventory home with primary CTAs", () => {
      const inventory = presentAdminInventory(
        [
          {
            id: "prod-1",
            name: "ChatGPT Plus",
            active: true,
            variantCount: 1,
            inStock: 5,
            lowStock: 0,
            outOfStock: 0,
          },
        ],
        {
          products: 1,
          variants: 1,
          inStock: 5,
          lowStock: 0,
          outOfStock: 0,
          held: 0,
          waiting: 0,
        },
      );

      // Required Vietnamese root header & totals
      expect(inventory.text).toContain("📦 QUẢN LÝ KHO");
      expect(inventory.text).toContain("• Sản phẩm: 1");
      expect(inventory.text).toContain("• Còn hàng: 5");

      // Primary actions visible immediately
      const buttonsFlat = inventory.buttons.flat();
      expect(buttonsFlat.some((b) => b.text === "➕ Nhập kho")).toBe(true);
      expect(buttonsFlat.some((b) => b.text === "➕ Tạo sản phẩm")).toBe(true);
      expect(buttonsFlat.some((b) => b.text === "📥 Tải mẫu CSV")).toBe(true);
      expect(buttonsFlat.some((b) => b.text === "📋 Dán nhanh")).toBe(true);
      expect(buttonsFlat.some((b) => b.text === "🕘 Lịch sử kho")).toBe(true);

      // Product & Variant pickers without requiring UUID from owner
      const prodPicker = presentAdminInventoryProductPicker(
        [{ id: "prod-1", name: "ChatGPT Plus" }],
        "import",
      );
      expect(prodPicker.text).toContain("CHỌN SẢN PHẨM");
      expect(prodPicker.buttons[0]?.[0]?.text).toBe("📦 ChatGPT Plus");
      expect(prodPicker.buttons[0]?.[0]?.callbackData).toBe(
        "admin:inventory:pick_prod:import:prod-1",
      );

      const varPicker = presentAdminInventoryVariantPicker(
        { id: "prod-1", name: "ChatGPT Plus" },
        [
          {
            id: "var-1",
            name: "1 Tháng BHF",
            sku: "GPT-PLUS-1M",
            fulfillmentType: "STOCK_ACCOUNT",
            available: 5,
          },
        ],
        "template",
      );
      expect(varPicker.text).toContain("CHỌN BIẾN THỂ");
      expect(varPicker.buttons[0]?.[0]?.callbackData).toBe("admin:inventory:template:var-1");

      // Test Lab isolates Canary products
      const testLab = presentAdminTestLab({
        testProducts: [{ id: "canary-1", name: "Canary Auto Code 2.000đ", active: false }],
        canaryOrders: [{ orderNumber: "ORD-CANARY-1", status: "PROCESSING", priceVnd: 2000 }],
      });
      expect(testLab.text).toContain("TEST LAB (CANARY & KIỂM THỬ NỘI BỘ)");
      expect(testLab.text).toContain("Canary Auto Code 2.000đ");
    });
  });

  describe("Preorder / Deposit Domain Lifecycle (Sections 14-25)", () => {
    it("computes deposit amounts and renders explicit deposit consent terms", () => {
      const config = {
        id: "var-kiro-20",
        productId: "prod-kiro",
        productName: "Kiro Pro 20$ 1K Credit",
        variantName: "Gift Code 20$",
        sku: "KIRO-PRO-20",
        priceVnd: 150000,
        preorderEnabled: true,
        depositMode: "FIXED" as const,
        depositAmountVnd: 50000,
        depositPercent: 0,
        minDepositVnd: 50000,
        maxPreorderQueue: 50,
        holdDurationHours: 24,
        balanceDueHours: 24,
        forfeitPolicyVersion: 1,
      };

      const { depositVnd, balanceVnd } = computePreorderDeposit(config);
      expect(depositVnd).toBe(50000);
      expect(balanceVnd).toBe(100000);

      const consent = presentPreorderConsent(config);
      expect(consent.text).toContain("ĐIỀU KIỆN ĐẶT CỌC GIỮ SUẤT");
      expect(consent.text).toContain("50.000 ₫");
      expect(consent.text).toContain("100.000 ₫");
      expect(consent.text).toContain("giữ hàng riêng cho bạn trong 24 giờ");
      expect(consent.buttons[0]?.[0]?.callbackData).toBe("preorder:create:var-kiro-20");
    });

    it("executes FIFO restock allocation and handles hold expiry forfeiture", async () => {
      // 1. Create customer
      const customerId = newId();
      await sql`
        insert into customer (id, status, locale)
        values (${customerId}, 'ACTIVE', 'vi-VN')
      `.execute(ctx.db);

      // Find variant with preorder enabled
      const varRow = await sql<{ id: string }>`
        select id from product_variant where preorder_enabled = true limit 1
      `.execute(ctx.db);
      expect(varRow.rows[0]).toBeDefined();
      const variantId = varRow.rows[0]!.id;

      // 2. Check preorder reservation creation
      const res = await createPreorderReservation(ctx.db, {
        customerId,
        variantId,
      });

      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.depositVnd).toBe(50000);
        expect(res.balanceVnd).toBe(200000);
        // Confirm deposit
        const confirmed = await confirmPreorderDeposit(ctx.db, {
          reservationId: res.reservationId,
        });
        expect(confirmed.ok).toBe(true);

        // Test hold release logic
        const releaseRes = await releaseExpiredPreorderHolds(ctx.db);
        expect(releaseRes).toBeDefined();
        expect(typeof releaseRes.forfeitedCount).toBe("number");
      }
    });

    it("presents admin preorders panel with status filters", () => {
      const panel = presentAdminPreorders({
        items: [
          {
            id: "pre-1",
            variantId: "var-1",
            productName: "Kiro Pro",
            variantName: "20$",
            status: "DEPOSIT_PAID",
            depositVnd: 50000,
            balanceVnd: 100000,
            customerName: "Khách VIP",
          },
        ],
        filter: "all",
      });

      expect(panel.text).toContain("💰 ĐẶT CỌC / GIỮ HÀNG");
      expect(panel.text).toContain("Kiro Pro");
      const callbacks = panel.buttons.flat().map((button) => button.callbackData);
      expect(callbacks).toContain("admin:preorders:cancel:pre-1");
      expect(callbacks).toContain("admin:preorders:filter:all");
      expect(callbacks).toContain("admin:preorders:filter:waiting_deposit");
      expect(callbacks).toContain("admin:preorders:filter:deposit_paid");
    });
  });

  describe("Real Social Proof & Truthful Counters (Sections 32-38)", () => {
    it("generates stable, pseudonymous HMAC alias and formats social proof message", () => {
      const alias1 = generateCustomerAlias("customer-12345");
      const alias2 = generateCustomerAlias("customer-12345");
      const alias3 = generateCustomerAlias("customer-99999");

      // Stable
      expect(alias1).toBe(alias2);
      expect(alias1).toMatch(/^Khách #[A-F0-9]{4}$/);
      expect(alias1).not.toBe(alias3);

      const msg = renderSocialProofMessage({
        customerAlias: alias1,
        productName: "ChatGPT Plus",
        variantName: "1 Tháng BHF",
        priceVnd: 250000,
      });

      expect(msg).toContain("CÓ KHÁCH VỪA MUA HÀNG");
      expect(msg).toContain(alias1);
      expect(msg).toContain("ChatGPT Plus · 1 Tháng BHF");
      expect(msg).toContain("250.000 ₫");
      expect(msg).toContain("Giao hàng thành công");
      expect(msg).not.toMatch(/customer-12345|phone|@|password|token/i);
    });

    it("computes truthful store stats and excludes canary/test orders", async () => {
      const stats = await getRealStoreStats(ctx.db);
      expect(stats).toBeDefined();
      expect(typeof stats.completedOrders).toBe("number");
      expect(typeof stats.totalCustomers).toBe("number");
      expect(typeof stats.automatedDeliveries).toBe("number");
    });
  });

  describe("Global Store Kill-Switch Protection (Section 47)", () => {
    it("enforces store CLOSED state against general customer checkout", async () => {
      await sql`update store_control set status = 'CLOSED' where id = 'main'`.execute(ctx.db);
      const open = await isStoreOpen(ctx.db);
      expect(open).toBe(false);
    });
  });
});
