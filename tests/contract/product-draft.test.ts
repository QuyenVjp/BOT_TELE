import { describe, expect, it } from "vitest";
import {
  addCustomField,
  advanceProductDraft,
  applyAdvancedRaw,
  generateCustomFieldKey,
  inventoryFieldsForType,
  previousStep,
  removeCustomField,
  setCustomFieldFlags,
  startProductDraft,
  startProductVariantDraft,
  toggleOptionalField,
  type ProductDraft,
} from "../../src/modules/catalog/product-draft.js";

/** Drive a draft through the 8-step wizard with per-step text inputs. */
function advanceAll(values: string[], start: ProductDraft = startProductDraft("123")) {
  let draft = start;
  for (const value of values) {
    const res = advanceProductDraft(draft, value);
    if (!res.ok) throw new Error(`advance failed at step ${draft.step}: ${res.error}`);
    draft = res.draft;
  }
  return draft;
}

const ACCOUNT_FLOW = [
  "GPT Plus 1 tháng", // name
  "gpt-plus-1m", // sku
  "cat-ai", // category
  "ACCOUNT", // productType
  "Tài khoản GPT Plus dùng 1 tháng", // description
  "Gói 1 tháng|250000", // variant name|price
  "ok", // deliveryConfig (ACCOUNT validates preset fields)
  "PUBLIC", // visibilityFlags (Step 8)
];

describe("admin product draft — 8-step wizard", () => {
  it("walks name → sku → category → type → description → variant → delivery → confirm", () => {
    let draft = startProductDraft("123");
    expect(draft.step).toBe("name");

    const steps: string[] = [];
    for (const value of ACCOUNT_FLOW.slice(0, 6)) {
      steps.push(draft.step);
      const res = advanceProductDraft(draft, value);
      expect(res.ok).toBe(true);
      draft = res.draft;
    }
    expect(steps).toEqual(["name", "sku", "category", "productType", "description", "variant"]);
    expect(draft.step).toBe("deliveryConfig");

    // ACCOUNT deliveryConfig validates preset inventory fields, then visibilityFlags.
    const res = advanceProductDraft(draft, "ignored");
    expect(res.ok).toBe(true);
    expect(res.draft.step).toBe("visibilityFlags");
    const res2 = advanceProductDraft(res.draft, "PUBLIC");
    expect(res2.ok).toBe(true);
    expect(res2.draft.step).toBe("confirm");
  });

  it("stores account fulfillment with deliverable credential presets", () => {
    const draft = advanceAll(ACCOUNT_FLOW.slice(0, 6));
    expect(draft.fulfillmentType).toBe("STOCK_ACCOUNT");
    expect(draft.inventoryFields).toEqual([
      { name: "email", label: "Email", required: true, secret: false, customerVisible: true },
      {
        name: "username",
        label: "Tên đăng nhập",
        required: true,
        secret: false,
        customerVisible: true,
      },
      { name: "password", label: "Mật khẩu", required: true, secret: true, customerVisible: true },
    ]);
    expect(draft.deliveryConfig).toEqual({ selectedOptionalFields: [], customFields: [] });
    // password must be deliverable (customerVisible) while redacted in admin views (secret)
    const password = draft.inventoryFields!.find((f) => f.name === "password")!;
    expect(password.secret).toBe(true);
    expect(password.customerVisible).toBe(true);
  });

  it("stores code fulfillment with a single code field", () => {
    const draft = advanceAll([
      "Key Windows 11",
      "key-win11",
      "cat-key",
      "CODE",
      "Key bản quyền",
      "Key 1PC|120000",
    ]);
    expect(draft.fulfillmentType).toBe("STOCK_CODE");
    expect(draft.inventoryFields).toEqual([
      { name: "code", label: "Mã/Key", required: true, secret: true, customerVisible: true },
    ]);
  });

  it("stores quantity stock initial quantity at delivery step", () => {
    const draft = advanceAll([
      "Gói credit",
      "credit-100",
      "cat-misc",
      "QUANTITY",
      "Credit dùng dần",
      "100 credit|50000",
    ]);
    expect(draft.fulfillmentType).toBe("QUANTITY_STOCK");
    expect(draft.inventoryFields).toEqual([]);
    expect(draft.step).toBe("deliveryConfig");
    const res = advanceProductDraft(draft, "10");
    expect(res.ok).toBe(true);
    expect(res.draft.initialQuantity).toBe(10);
    expect(res.draft.step).toBe("visibilityFlags");
    const res2 = advanceProductDraft(res.draft, "PUBLIC");
    expect(res2.ok).toBe(true);
    expect(res2.draft.step).toBe("confirm");
  });

  it("rejects non-numeric quantity without advancing", () => {
    const draft = advanceAll([
      "Gói credit",
      "credit-100",
      "cat-misc",
      "QUANTITY",
      "Credit dùng dần",
      "100 credit|50000",
    ]);
    const res = advanceProductDraft(draft, "mười");
    expect(res).toMatchObject({ ok: false, error: "INVALID_QUANTITY" });
    expect(res.draft.step).toBe("deliveryConfig");
  });

  it("stores manual service instructions at delivery step", () => {
    const draft = advanceAll([
      "Cài đặt tận nơi",
      "svc-install",
      "cat-misc",
      "MANUAL",
      "Nhân viên hỗ trợ cài đặt",
      "1 lần|300000",
    ]);
    expect(draft.fulfillmentType).toBe("MANUAL_FULFILLMENT");
    const res = advanceProductDraft(draft, "Liên hệ khách trong 24h");
    expect(res.ok).toBe(true);
    expect(res.draft.serviceInstructions).toBe("Liên hệ khách trong 24h");
    expect(res.draft.step).toBe("visibilityFlags");
    const res2 = advanceProductDraft(res.draft, "PUBLIC");
    expect(res2.ok).toBe(true);
    expect(res2.draft.step).toBe("confirm");
  });

  it("stores unlimited service instructions without stock", () => {
    const draft = advanceAll([
      "Checklist review CV",
      "svc-cv",
      "cat-misc",
      "UNLIMITED_SERVICE",
      "Dịch vụ review CV không giới hạn",
      "1 tháng|99000",
    ]);
    expect(draft.fulfillmentType).toBe("UNLIMITED_SERVICE");
    const res = advanceProductDraft(draft, "Khách gửi CV qua ticket");
    expect(res.ok).toBe(true);
    expect(res.draft.serviceInstructions).toBe("Khách gửi CV qua ticket");
  });

  it("stores supplier config for supplier-backed products", () => {
    const draft = advanceAll([
      "Netflix via API",
      "netflix-api",
      "cat-misc",
      "SUPPLIER",
      "Tài khoản Netflix từ nhà cung cấp",
      "1 tháng|80000",
    ]);
    expect(draft.fulfillmentType).toBe("SUPPLIER_API");
    const res = advanceProductDraft(draft, "supplier-1|NFLX-1M|50000|VN");
    expect(res.ok).toBe(true);
    expect(res.draft.supplierConfig).toEqual({
      supplierId: "supplier-1",
      externalSku: "NFLX-1M",
      costVnd: 50000n,
      region: "VN",
    });
    expect(res.draft.step).toBe("visibilityFlags");
    const res2 = advanceProductDraft(res.draft, "PUBLIC");
    expect(res2.ok).toBe(true);
    expect(res2.draft.step).toBe("confirm");
  });

  it("parses structured description JSON into commercial fields", () => {
    const json = JSON.stringify({
      description: "Mô tả ngắn",
      what_customer_receives: "Email + mật khẩu",
      usage_instructions: "Đăng nhập và đổi mật khẩu",
      warranty: "Bảo hành 1 tháng",
    });
    const draft = advanceAll([
      "GPT Plus",
      "gpt-plus",
      "cat-ai",
      "ACCOUNT",
      json,
      "Gói 1 tháng|250000",
    ]);
    expect(draft.descriptionVi).toBe("Mô tả ngắn");
    expect(draft.whatCustomerReceivesVi).toBe("Email + mật khẩu");
    expect(draft.usageInstructionsVi).toBe("Đăng nhập và đổi mật khẩu");
    expect(draft.warrantyVi).toBe("Bảo hành 1 tháng");
  });

  it("rejects malformed variant input without advancing", () => {
    const draft = advanceAll(["SP", "sp-1", "cat", "CODE", "Mô tả"]);
    for (const bad of ["không có giá", "ten|abc", "|1000", "ten|"]) {
      const res = advanceProductDraft(draft, bad);
      expect(res).toMatchObject({ ok: false, error: "INVALID_VARIANT" });
      expect(res.draft.step).toBe("variant");
    }
  });

  it("rejects unknown fulfillment types before advancing", () => {
    const draft = advanceAll(["SP", "sp-1", "cat"]);
    const res = advanceProductDraft(draft, "ROCKET");
    expect(res).toMatchObject({ ok: false, error: "UNSUPPORTED_FULFILLMENT_TYPE" });
    expect(res.draft.step).toBe("productType");
  });

  it("accepts full enum names as well as short type aliases", () => {
    const draft = advanceAll(["SP", "sp-1", "cat", "STOCK_ACCOUNT"]);
    expect(draft.fulfillmentType).toBe("STOCK_ACCOUNT");
  });

  it("keeps draft stable once confirmation is reached", () => {
    const draft = advanceAll(ACCOUNT_FLOW);
    expect(draft.step).toBe("confirm");
    const again = advanceProductDraft(draft, "x");
    expect(again).toMatchObject({ ok: false, error: "DRAFT_READY" });
    expect(again.draft.step).toBe("confirm");
  });

  it("variant draft starts at SKU and skips the category step", () => {
    const draft = startProductVariantDraft("123", "product-1");
    expect(draft.step).toBe("sku");
    const res = advanceProductDraft(draft, "new-sku");
    expect(res.ok).toBe(true);
    expect(res.draft.step).toBe("productType");
    expect(res.draft.existingProductId).toBe("product-1");
  });

  it("accepts short and numeric-only SKUs such as 1, 01, 001, 123, GPT1, GPT-PLUS", () => {
    for (const sku of ["1", "01", "001", "123", "GPT1", "GPT-PLUS"]) {
      const draft = advanceAll(["SP"], startProductDraft("123"));
      const res = advanceProductDraft(draft, sku);
      expect(res.ok).toBe(true);
      expect(res.draft.sku).toBe(sku.toUpperCase());
      expect(res.draft.step).toBe("category");
    }
  });

  it("rejects invalid SKUs with INVALID_SKU", () => {
    const draft = advanceAll(["SP"]);
    for (const bad of ["-abc", "a b", "sku!", ""]) {
      const res = advanceProductDraft(draft, bad);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(["INVALID_SKU", "INVALID_VALUE"]).toContain(res.error);
      expect(res.draft.step).toBe("sku");
    }
  });

  it("expires drafts past their TTL", () => {
    const now = Date.now();
    const draft = startProductDraft("123", now);
    const res = advanceProductDraft(draft, "x", now + 16 * 60_000);
    expect(res).toMatchObject({ ok: false, error: "DRAFT_EXPIRED" });
  });
});

describe("delivery config helpers", () => {
  function accountDraft(): ProductDraft {
    return advanceAll(ACCOUNT_FLOW.slice(0, 6));
  }

  it("toggles optional preset fields on and off", () => {
    let draft = accountDraft();
    expect(draft.inventoryFields!.some((f) => f.name === "recovery_email")).toBe(false);
    draft = toggleOptionalField(draft, "recovery_email");
    expect(draft.inventoryFields!.some((f) => f.name === "recovery_email")).toBe(true);
    draft = toggleOptionalField(draft, "recovery_email");
    expect(draft.inventoryFields!.some((f) => f.name === "recovery_email")).toBe(false);
  });

  it("generates safe ascii keys from Vietnamese labels", () => {
    expect(generateCustomFieldKey("Ngày hết hạn")).toBe("ngay_het_han");
    expect(generateCustomFieldKey("Địa chỉ Đà Nẵng")).toBe("dia_chi_da_nang");
    expect(generateCustomFieldKey("!!!")).toBe("truong_tuy_chinh");
  });

  it("adds a custom field with a generated key and tracks it in deliveryConfig", () => {
    let draft = accountDraft();
    draft = addCustomField(draft, { label: "Ngày hết hạn" });
    const field = draft.inventoryFields!.find((f) => f.name === "ngay_het_han")!;
    expect(field).toEqual({
      name: "ngay_het_han",
      label: "Ngày hết hạn",
      required: false,
      secret: false,
      customerVisible: true,
    });
    expect(draft.deliveryConfig!.customFields.map((f) => f.name)).toContain("ngay_het_han");
  });

  it("sets custom field flags (required/secret/customerVisible)", () => {
    let draft = addCustomField(accountDraft(), { label: "Mã PIN" });
    draft = setCustomFieldFlags(draft, "ma_pin", { required: true, secret: true });
    const field = draft.inventoryFields!.find((f) => f.name === "ma_pin")!;
    expect(field.required).toBe(true);
    expect(field.secret).toBe(true);
    expect(field.customerVisible).toBe(true);
    // flags propagate to the deliveryConfig copy
    expect(draft.deliveryConfig!.customFields.find((f) => f.name === "ma_pin")!.secret).toBe(true);
  });

  it("removes custom fields from both the schema and the config tracker", () => {
    let draft = addCustomField(accountDraft(), { label: "Ghi chú riêng" });
    draft = removeCustomField(draft, "ghi_chu_rieng");
    expect(draft.inventoryFields!.some((f) => f.name === "ghi_chu_rieng")).toBe(false);
    expect(draft.deliveryConfig!.customFields).toEqual([]);
  });

  it("advanced raw input builds safe non-executable fields", () => {
    const draft = applyAdvancedRaw(accountDraft(), "Ngày hết hạn, Ghi chú");
    const names = draft.inventoryFields!.map((f) => f.name);
    expect(names).toContain("ngay_het_han");
    expect(names).toContain("ghi_chu");
    for (const f of draft.inventoryFields!) {
      expect(f.name).toMatch(/^[a-z0-9_]+$/);
    }
  });

  it("previousStep walks the wizard order backwards", () => {
    const order = [
      "name",
      "sku",
      "category",
      "productType",
      "description",
      "variant",
      "deliveryConfig",
      "visibilityFlags",
      "confirm",
    ] as const;
    let draft: ProductDraft = { ...startProductDraft("1"), step: "confirm" };
    const seen: string[] = [];
    while (draft.step !== "name") {
      draft = previousStep(draft);
      seen.push(draft.step);
    }
    expect(seen).toEqual([...order].reverse().slice(1));
  });
});

describe("inventory field presets", () => {
  it("account preset carries email/username/password", () => {
    expect(inventoryFieldsForType("STOCK_ACCOUNT").map((f) => f.name)).toEqual([
      "email",
      "username",
      "password",
    ]);
  });

  it("code preset carries a single secret code field", () => {
    expect(inventoryFieldsForType("STOCK_CODE")).toEqual([
      { name: "code", label: "Mã/Key", required: true, secret: true, customerVisible: true },
    ]);
  });

  it("quantity/unlimited/manual/supplier carry no credential fields", () => {
    for (const type of [
      "QUANTITY_STOCK",
      "UNLIMITED_SERVICE",
      "MANUAL_FULFILLMENT",
      "SUPPLIER_API",
    ] as const) {
      expect(inventoryFieldsForType(type)).toEqual([]);
    }
  });
});
