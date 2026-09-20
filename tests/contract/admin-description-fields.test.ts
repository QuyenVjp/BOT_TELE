import { describe, expect, it } from "vitest";
import {
  WIZARD_DESCRIPTION_FIELDS,
  wizardValidationMessage,
  presentWizardDescriptionFieldPrompt,
  presentWizardDescriptionFields,
  presentWizardDescriptionStep,
  presentWizardCategoryStep,
  presentWizardDeliveryStep,
  wizardDescriptionField,
} from "../../src/bot/presenters/admin-wizard.js";
import type { ProductDraft } from "../../src/modules/catalog/product-draft.js";

/**
 * Goal §76 — the per-field content editor.
 *
 * The menu must show every field the customer contract names, mark the ones already filled, and
 * route each row to its own field key; the prompt must name the field so the owner knows what is
 * being asked. The persistence of each field is proven live in the admin E2E, not here.
 */

const draft = (fields: Partial<ProductDraft>): ProductDraft =>
  ({
    adminTelegramUserId: "1",
    step: "description",
    expiresAt: Date.now() + 60_000,
    ...fields,
  }) as ProductDraft;

describe("wizard description field editor", () => {
  it("lists exactly the seven contract fields, each routing to its own key", () => {
    const message = presentWizardDescriptionFields(draft({}));

    expect(WIZARD_DESCRIPTION_FIELDS.map((f) => f.key)).toEqual([
      "shortDescriptionVi",
      "descriptionVi",
      "whatCustomerReceivesVi",
      "usageInstructionsVi",
      "warrantyVi",
      "deliveryEtaVi",
      "termsVi",
    ]);
    const rows = message.buttons.slice(0, WIZARD_DESCRIPTION_FIELDS.length);
    expect(rows.map((row) => row[0]?.callbackData)).toEqual(
      WIZARD_DESCRIPTION_FIELDS.map((f) => `admin:products:df:edit:${f.key}`),
    );
    expect(message.buttons.flat().map((b) => b.callbackData)).toContain("admin:products:df:done");
  });

  it("marks filled fields and reports how many are still empty", () => {
    const empty = presentWizardDescriptionFields(draft({}));
    expect(empty.text).toContain("Còn 7 mục chưa nhập");

    const partial = presentWizardDescriptionFields(
      draft({ descriptionVi: "có nội dung", warrantyVi: "   " }),
    );
    const labels = partial.buttons.slice(0, 7).map((row) => row[0]!.text);
    expect(labels[1]).toContain("✅"); // description filled
    expect(labels[0]).toContain("⬜");
    expect(labels[4]).toContain("⬜"); // whitespace is not content
    expect(partial.text).toContain("Còn 6 mục chưa nhập");

    const complete = presentWizardDescriptionFields(
      draft(Object.fromEntries(WIZARD_DESCRIPTION_FIELDS.map((f) => [f.key, "x"]))),
    );
    expect(complete.text).toContain("Đã đủ nội dung.");
  });

  it("prompts for one field by name and shows the current value", () => {
    const prompt = presentWizardDescriptionFieldPrompt("warrantyVi", "Bảo hành 12 tháng");
    expect(prompt.text).toContain("🛡 Bảo hành");
    expect(prompt.text).toContain("Chính sách bảo hành.");
    expect(prompt.text).toContain("Bảo hành 12 tháng");
    expect(prompt.buttons.flat().map((b) => b.callbackData)).toContain(
      "admin:products:desc:fields",
    );

    const unknown = presentWizardDescriptionFieldPrompt("not_a_field");
    expect(unknown.text).toContain("Nội dung");
    expect(wizardDescriptionField("not_a_field")).toBeUndefined();
  });
});

describe("wizard step presentations and 2D row shape", () => {
  it("renders sentence-case step title and pairs manual input choices in 2D rows", () => {
    const msg = presentWizardDescriptionStep("STOCK_ACCOUNT");
    expect(msg.text).toContain("Bước 5/8 — 📝 Mô tả & hướng dẫn");
    // Row 0: template option
    expect(msg.buttons[0]).toEqual([
      { text: "✨ Dùng mẫu mô tả", callbackData: "admin:products:desc:template" },
    ]);
    // Row 1: paired manual input choices
    expect(msg.buttons[1]).toEqual([
      { text: "✏️ Tự nhập", callbackData: "admin:products:desc:custom" },
      { text: "🧩 Nhập từng mục", callbackData: "admin:products:desc:fields" },
    ]);
    // Destructive cancel is separate from back
    const cancelRow = msg.buttons.find((r) =>
      r.some((b) => b.callbackData === "admin:products:cancel"),
    );
    expect(cancelRow).toHaveLength(1);
  });

  it("renders sentence-case category step title", () => {
    const msg = presentWizardCategoryStep([{ id: "c1", name: "AI" }]);
    expect(msg.text).toContain("Bước 3/8 — 📂 Chọn danh mục");
  });

  it("pairs custom and advanced field actions in delivery step", () => {
    const msg = presentWizardDeliveryStep(
      draft({ fulfillmentType: "STOCK_ACCOUNT", inventoryFields: [] }),
    );
    expect(msg.text).toContain("Bước 7/8 — 📦 Cách giao hàng / cấu trúc kho");
    const configRow = msg.buttons.find((r) =>
      r.some((b) => b.callbackData === "admin:products:dc:custom"),
    );
    expect(configRow).toEqual([
      { text: "➕ Trường tùy chỉnh", callbackData: "admin:products:dc:custom" },
      { text: "⚙️ Trường nâng cao", callbackData: "admin:products:dc:advanced" },
    ]);
  });
});
describe("wizard validation messages name the field (goal §131)", () => {
  it("never returns a bare invalid-data sentence", () => {
    // Every code the draft machine can return, against a representative step.
    for (const code of [
      "DRAFT_EXPIRED",
      "DRAFT_READY",
      "INVALID_STEP",
      "UNSUPPORTED_FULFILLMENT_TYPE",
      "NO_DRAFT",
      "INVALID_QUANTITY",
      "INVALID_VARIANT",
      "INVALID_SKU",
      "INVALID_SUPPLIER_CONFIG",
      "INVALID_INVENTORY_FIELDS",
      "INVALID_VALUE",
      "SOMETHING_UNMAPPED",
    ]) {
      const message = wizardValidationMessage(code, "variant");
      expect(message).not.toBe("Dữ liệu không hợp lệ, vui lòng thử lại.");
      expect(message).toContain("💰 Giá / biến thể");
      expect(message).toContain("👉");
    }
  });

  it("names the step and the expected input per field", () => {
    expect(wizardValidationMessage("INVALID_VALUE", "name")).toContain("📝 Tên sản phẩm");
    expect(wizardValidationMessage("INVALID_VALUE", "name")).toContain("tối đa 200 ký tự");
    expect(wizardValidationMessage("INVALID_SKU", "sku")).toContain("dấu - hoặc _");
    expect(wizardValidationMessage("INVALID_VARIANT", "variant")).toContain("Tên biến thể | Giá");
    expect(wizardValidationMessage("INVALID_VALUE", "threshold")).toContain("nguyên không âm");
    expect(wizardValidationMessage("INVALID_SUPPLIER_CONFIG", "supplierConfig")).toContain(
      "supplierId | externalSku",
    );
  });

  it("still says something actionable for an unknown step or code", () => {
    const message = wizardValidationMessage("UNKNOWN_CODE", "unknown");
    expect(message).toContain("Nội dung chưa hợp lệ cho bước này.");
    expect(message).not.toContain("👉");
  });
});
