import { describe, expect, it } from "vitest";
import { advanceProductDraft, startProductDraft } from "../../src/modules/catalog/product-draft.js";

describe("admin product draft", () => {
  it("advances validated fields and parses Vietnamese integer price", () => {
    let draft = startProductDraft("123");
    for (const value of ["Test Product", "TEST_001", "category-1", "12.000", "Description", "3"]) {
      const result = advanceProductDraft(draft, value);
      expect(result.ok).toBe(true);
      if (result.ok) draft = result.draft;
    }
    expect(draft.step).toBe("confirm");
    expect(draft.priceVnd).toBe(12000n);
    expect(draft.lowStockThreshold).toBe(3);
  });

  it("rejects malformed monetary input without advancing", () => {
    let draft = startProductDraft("123");
    draft = advanceProductDraft(draft, "Test Product").draft;
    draft = advanceProductDraft(draft, "TEST_001").draft;
    draft = advanceProductDraft(draft, "category-1").draft;
    const result = advanceProductDraft(draft, "12abc");
    expect(result).toMatchObject({ ok: false, error: "INVALID_PRICE" });
    expect(result.draft.step).toBe("price");
  });

  it("keeps product draft ready state stable once confirmation is reached", () => {
    let draft = startProductDraft("123");
    for (const value of ["Test Product", "TEST_001", "category-1", "12.000", "Description", "3"]) {
      const result = advanceProductDraft(draft, value);
      if (!result.ok) throw new Error(result.error);
      draft = result.draft;
    }
    const result = advanceProductDraft(draft, "anything");
    expect(result).toMatchObject({ ok: false, error: "DRAFT_READY" });
  });
});
