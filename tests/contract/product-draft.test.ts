import { describe, expect, it } from "vitest";
import {
  advanceProductDraft,
  startProductDraft,
  startProductVariantDraft,
} from "../../src/modules/catalog/product-draft.js";

function advanceAll(values: string[]) {
  let draft = startProductDraft("123");
  for (const value of values) {
    const result = advanceProductDraft(draft, value);
    expect(result.ok).toBe(true);
    if (result.ok) draft = result.draft;
  }
  return draft;
}

describe("admin product draft", () => {
  it("advances validated fields and stores the chosen account fulfillment config", () => {
    const draft = advanceAll([
      "Test Product",
      "TEST_001",
      "Premium 1 tháng",
      "120.000",
      "category-1",
      "STOCK_ACCOUNT",
      "username,password,profile_url",
      "2",
    ]);

    expect(draft).toMatchObject({
      step: "confirm",
      priceVnd: 120000n,
      lowStockThreshold: 2,
      fulfillmentType: "STOCK_ACCOUNT",
      inventoryFields: [
        {
          name: "username",
          label: "Tên đăng nhập",
          required: true,
          secret: false,
          customerVisible: true,
        },
        {
          name: "password",
          label: "Mật khẩu",
          required: true,
          secret: true,
          customerVisible: true,
        },
        {
          name: "profile_url",
          label: "Liên kết hồ sơ",
          required: false,
          secret: false,
          customerVisible: true,
        },
      ],
    });
  });

  it("stores the chosen code fulfillment config without account fields", () => {
    const draft = advanceAll([
      "Test Product",
      "TEST_CODE",
      "Key 1 tháng",
      "120000",
      "category-1",
      "STOCK_CODE",
      "4",
    ]);

    expect(draft.step).toBe("confirm");
    expect(draft.fulfillmentType).toBe("STOCK_CODE");
    expect(draft.inventoryFields).toEqual([
      { name: "code", label: "Mã kích hoạt", required: true, secret: true, customerVisible: true },
    ]);
    expect(draft.lowStockThreshold).toBe(4);
  });

  it("stores manual service instructions", () => {
    const draft = advanceAll([
      "Manual Product",
      "TEST_MANUAL",
      "Manual setup",
      "120000",
      "category-1",
      "MANUAL_FULFILLMENT",
      "Call customer before activation",
    ]);

    expect(draft).toMatchObject({
      step: "confirm",
      fulfillmentType: "MANUAL_FULFILLMENT",
      inventoryFields: [],
      lowStockThreshold: 0,
      serviceInstructions: "Call customer before activation",
    });
  });

  it("stores quantity service instructions and initial stock", () => {
    const draft = advanceAll([
      "Quantity Product",
      "TEST_QTY",
      "Voucher",
      "120000",
      "category-1",
      "QUANTITY_STOCK",
      "Hand over one voucher",
      "5",
      "0",
    ]);

    expect(draft).toMatchObject({
      step: "confirm",
      fulfillmentType: "QUANTITY_STOCK",
      inventoryFields: [],
      lowStockThreshold: 0,
      serviceInstructions: "Hand over one voucher",
      initialQuantity: 5,
    });
  });

  it("requires safe integer quantity and threshold before quantity-stock confirmation", () => {
    let draft = startProductDraft("123");
    for (const value of [
      "Quantity Product",
      "TEST_QTY_SAFE",
      "Voucher",
      "120000",
      "category-1",
      "QUANTITY_STOCK",
      "Hand over one voucher",
    ]) {
      const result = advanceProductDraft(draft, value);
      expect(result.ok).toBe(true);
      if (result.ok) draft = result.draft;
    }

    const unsafeQuantity = advanceProductDraft(draft, String(Number.MAX_SAFE_INTEGER + 1));
    expect(unsafeQuantity).toMatchObject({ ok: false, error: "INVALID_QUANTITY" });
    expect(unsafeQuantity.draft.step).toBe("initialQuantity");

    const safeQuantity = advanceProductDraft(draft, String(2_147_483_647));
    expect(safeQuantity).toMatchObject({
      ok: true,
      draft: { step: "threshold", initialQuantity: 2_147_483_647 },
    });
    if (!safeQuantity.ok) return;

    const unsafeThreshold = advanceProductDraft(
      safeQuantity.draft,
      String(Number.MAX_SAFE_INTEGER + 1),
    );
    expect(unsafeThreshold).toMatchObject({ ok: false, error: "INVALID_THRESHOLD" });
    expect(unsafeThreshold.draft.step).toBe("threshold");

    const safeThreshold = advanceProductDraft(safeQuantity.draft, "0");
    expect(safeThreshold).toMatchObject({
      ok: true,
      draft: { step: "confirm", lowStockThreshold: 0 },
    });
  });

  it("creates digital file drafts as inactive setup variants without fake artifact metadata", () => {
    const draft = advanceAll([
      "File Product",
      "TEST_FILE",
      "Download",
      "120000",
      "category-1",
      "DIGITAL_FILE",
    ]);

    expect(draft).toMatchObject({
      step: "confirm",
      fulfillmentType: "DIGITAL_FILE",
      inventoryFields: [],
      lowStockThreshold: 0,
    });
    expect(draft.fileArtifact).toBeUndefined();
  });

  it("stores unlimited service instructions", () => {
    const draft = advanceAll([
      "Unlimited Product",
      "TEST_UNLIMITED",
      "Recurring",
      "120000",
      "category-1",
      "UNLIMITED_SERVICE",
      "Keep service active until cancellation",
    ]);

    expect(draft).toMatchObject({
      step: "confirm",
      fulfillmentType: "UNLIMITED_SERVICE",
      inventoryFields: [],
      lowStockThreshold: 0,
      serviceInstructions: "Keep service active until cancellation",
    });
  });

  it("stores supplier config for a new supplier-backed variant", () => {
    const draft = advanceAll([
      "Supplier Product",
      "TEST_SUP",
      "Remote SKU",
      "120000",
      "category-1",
      "SUPPLIER_API",
      "supplier-1|EXT-SKU|80000|VN",
    ]);

    expect(draft).toMatchObject({
      step: "confirm",
      fulfillmentType: "SUPPLIER_API",
      inventoryFields: [],
      lowStockThreshold: 0,
      supplierConfig: {
        supplierId: "supplier-1",
        externalSku: "EXT-SKU",
        costVnd: 80000n,
        region: "VN",
      },
    });
  });

  it("rejects malformed monetary input without advancing", () => {
    let draft = startProductDraft("123");
    draft = advanceProductDraft(draft, "Test Product").draft;
    draft = advanceProductDraft(draft, "TEST_001").draft;
    draft = advanceProductDraft(draft, "Premium").draft;
    const result = advanceProductDraft(draft, "12abc");
    expect(result).toMatchObject({ ok: false, error: "INVALID_PRICE" });
    expect(result.draft.step).toBe("price");
  });

  it("rejects unknown fulfillment types before advancing", () => {
    let draft = startProductDraft("123");
    for (const value of ["Test Product", "TEST_001", "Premium", "120000", "category-1"]) {
      const result = advanceProductDraft(draft, value);
      if (!result.ok) throw new Error(result.error);
      draft = result.draft;
    }

    const result = advanceProductDraft(draft, "NOT_A_TYPE");
    expect(result).toMatchObject({ ok: false, error: "UNSUPPORTED_FULFILLMENT_TYPE" });
    expect(result.draft.step).toBe("fulfillmentType");
  });

  it("keeps product draft ready state stable once confirmation is reached", () => {
    const draft = advanceAll([
      "Test Product",
      "TEST_001",
      "Premium 1 tháng",
      "12.000",
      "category-1",
      "STOCK_ACCOUNT",
      "username,password",
      "3",
    ]);
    const result = advanceProductDraft(draft, "anything");
    expect(result).toMatchObject({ ok: false, error: "DRAFT_READY" });
  });

  it("starts an existing-product variant draft at SKU and skips product category", () => {
    let draft = startProductVariantDraft("123", "product-1");
    for (const value of ["NF_ADD", "Extra", "99000", "STOCK_CODE", "1"]) {
      const result = advanceProductDraft(draft, value);
      expect(result.ok).toBe(true);
      if (result.ok) draft = result.draft;
    }

    expect(draft).toMatchObject({
      step: "confirm",
      existingProductId: "product-1",
      sku: "NF_ADD",
      variantName: "Extra",
      priceVnd: 99000n,
      fulfillmentType: "STOCK_CODE",
      lowStockThreshold: 1,
    });
    expect(draft).not.toHaveProperty("categoryId");
  });
});
