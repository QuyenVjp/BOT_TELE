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
});
