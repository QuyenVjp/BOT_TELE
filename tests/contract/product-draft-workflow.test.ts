import { describe, expect, it } from "vitest";
import { createProductDraftWorkflow } from "../../src/modules/catalog/product-draft.js";

describe("product draft workflow", () => {
  it("keeps independent admin drafts and supports cancellation", () => {
    const workflow = createProductDraftWorkflow();
    workflow.start("100");
    workflow.start("200");
    expect(workflow.get("100")?.step).toBe("name");
    workflow.cancel("100");
    expect(workflow.get("100")).toBeNull();
    expect(workflow.get("200")?.step).toBe("name");
  });

  it("expires drafts instead of retaining stale input", () => {
    const workflow = createProductDraftWorkflow();
    workflow.start("100", 1_000);
    expect(workflow.get("100", 1_000 + 15 * 60_000)).toBeNull();
  });
});

import { presentWizardVisibilityStep } from "../../src/bot/presenters/admin-wizard.js";
import { presentProductDraftPreview } from "../../src/bot/presenters/admin.js";

describe("product draft step 8 & preview presenter", () => {
  it("renders Step 8 visibility, featured, preorder, and threshold buttons", () => {
    const message = presentWizardVisibilityStep({
      adminTelegramUserId: "100",
      step: "visibilityFlags",
      expiresAt: Date.now() + 60_000,
      visibility: "TEST_ONLY",
      isFeatured: true,
      preorderEnabled: false,
      lowStockThreshold: 5,
    });
    expect(message.text).toContain("Bước 8/8 — ⚙️ CÀI ĐẶT HIỂN THỊ & BÁN HÀNG");
    expect(message.text).toContain("Hiển thị: Chỉ test");
    expect(message.text).toContain("Ghim nổi bật: Có");
    expect(message.text).toContain("Đặt cọc khi hết hàng: Tắt");
    expect(message.text).toContain("Cảnh báo sắp hết: 5");

    const buttons = message.buttons.flat();
    expect(buttons.find((b) => b.callbackData === "admin:products:vis:test")).toBeDefined();
    expect(buttons.find((b) => b.callbackData === "admin:products:vis:draft")).toBeDefined();
    expect(buttons.find((b) => b.callbackData === "admin:products:vis:public")).toBeDefined();
    expect(
      buttons.find((b) => b.callbackData === "admin:products:vis:toggle_featured"),
    ).toBeDefined();
    expect(
      buttons.find((b) => b.callbackData === "admin:products:vis:toggle_preorder"),
    ).toBeDefined();
    expect(buttons.find((b) => b.callbackData === "admin:products:vis:done")).toBeDefined();
  });

  it("renders clean human-readable preview without leaking raw UUIDs", () => {
    const preview = presentProductDraftPreview({
      name: "Gemini E2E Account",
      sku: "GEMINI-E2E-001",
      variantName: "1 tháng",
      categoryName: "AI / Gemini",
      priceVnd: 2000n,
      fulfillmentType: "STOCK_ACCOUNT",
      inventoryFields: [
        { name: "email", label: "Email", required: true, secret: false, customerVisible: true },
        {
          name: "password",
          label: "Mật khẩu",
          required: true,
          secret: true,
          customerVisible: true,
        },
      ],
      visibility: "TEST_ONLY",
      isFeatured: false,
      preorderEnabled: false,
      lowStockThreshold: 3,
    });
    expect(preview.text).toContain("Tên: Gemini E2E Account");
    expect(preview.text).toContain("Danh mục: AI / Gemini");
    expect(preview.text).toContain("Hiển thị: 🧪 Chỉ test");
    expect(preview.text).not.toContain("existingProductId");
    expect(preview.text).not.toContain("categoryId");
    expect(
      preview.buttons.flat().find((b) => b.callbackData === "admin:products:confirm"),
    ).toBeDefined();
  });

  // The step-8 screen is the only place the owner can configure the warranty, and a grep of the
  // built file cannot tell a rendered button from a string in dead code — so assert the buttons the
  // presenter actually returns.
  it("renders the warranty controls on the settings step", () => {
    const draft = {
      adminTelegramUserId: "1",
      step: "visibilityFlags" as const,
      sku: "SKU-1",
      variantName: "1 tháng",
      priceVnd: 2000n,
      fulfillmentType: "STOCK_ACCOUNT" as const,
      inventoryFields: [],
      visibility: "TEST_ONLY" as const,
      expiresAt: Date.now() + 60_000,
    };
    const off = presentWizardVisibilityStep(draft);
    const offCallbacks = off.buttons.flat().map((button) => button.callbackData);
    expect(offCallbacks).toContain("admin:products:warranty:toggle");
    // the controls that only make sense once it is on stay hidden until then
    expect(offCallbacks.some((value) => value.startsWith("admin:products:warranty:days:"))).toBe(
      false,
    );

    const on = presentWizardVisibilityStep({
      ...draft,
      warrantyEnabled: true,
      warrantyDays: 30,
    });
    const onCallbacks = on.buttons.flat().map((button) => button.callbackData);
    for (const expected of [
      "admin:products:warranty:toggle",
      "admin:products:warranty:days:15",
      "admin:products:warranty:proration",
      "admin:products:warranty:replacement",
      "admin:products:warranty:refund",
      "admin:products:warranty:behavior",
      "admin:products:warranty:text:coverage",
      "admin:products:warranty:text:exclusions",
    ]) {
      expect(onCallbacks).toContain(expected);
    }
    expect(on.text).toContain("Bảo hành: 30 ngày");
  });
});
