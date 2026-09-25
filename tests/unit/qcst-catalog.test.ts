import { describe, expect, it } from "vitest";
import { parseSupplierCurationText } from "../../src/modules/supplier/catalog.js";

describe("supplier catalog curation input", () => {
  it("parses the bounded Telegram configuration format", () => {
    expect(
      parseSupplierCurationText("Premium VPN | 1 month | 150000 | Gói dùng thử 1 tháng"),
    ).toEqual({
      localNameVi: "Premium VPN",
      localVariantNameVi: "1 month",
      localPriceVnd: 150000n,
      localDescriptionVi: "Gói dùng thử 1 tháng",
    });
  });

  it.each([
    "",
    "too|few|fields",
    "name|variant|not-a-number|description",
    "name|variant|0|description",
    "name|variant|-1|description",
  ])("rejects unsafe curation text: %s", (text) => {
    expect(() => parseSupplierCurationText(text)).toThrow();
  });

  it("bounds local descriptions before they reach the database", () => {
    const tooLong = `name | variant | 150000 | ${"x".repeat(2_001)}`;
    expect(() => parseSupplierCurationText(tooLong)).toThrow("SUPPLIER_LOCAL_DESCRIPTION_INVALID");
  });
});
