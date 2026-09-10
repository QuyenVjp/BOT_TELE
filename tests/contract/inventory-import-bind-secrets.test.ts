import { describe, expect, it } from "vitest";
import { bindSecretsToVariant } from "../../src/modules/digital-goods/inventory-import-session.js";
import type { InventoryField } from "../../src/modules/catalog/fulfillment-type.js";

const FIELDS: InventoryField[] = [
  { name: "email", label: "Email", required: true, secret: false, customerVisible: true },
  { name: "password", label: "Password", required: true, secret: true, customerVisible: false },
];

describe("bindSecretsToVariant", () => {
  it("prepends the selected variant id to a single secret line", () => {
    expect(bindSecretsToVariant("secret-one", "var-1", FIELDS)).toBe("var-1,secret-one");
  });

  it("wraps an unclosed-quote paste instead of returning empty", () => {
    const out = bindSecretsToVariant('user,"pass', "var-1", FIELDS);
    expect(out.startsWith("var-1,")).toBe(true);
    expect(out.length).toBeGreaterThan(6);
  });

  it("returns empty for blank input", () => {
    expect(bindSecretsToVariant("   ", "var-1", FIELDS)).toBe("");
  });
});
