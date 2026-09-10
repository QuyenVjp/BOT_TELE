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

  // The paste prompt tells the owner the fields are pipe-separated. A pipe line that is not split
  // lands entirely in the first field, and the customer then receives one unlabelled blob instead
  // of the configured fields.
  it("splits the pipe format the paste prompt documents into per-field values", () => {
    expect(
      bindSecretsToVariant("a@example.invalid|PASS-1\na2@example.invalid|PASS-2", "var-1", FIELDS),
    ).toBe("var-1,a@example.invalid,PASS-1\nvar-1,a2@example.invalid,PASS-2");
  });

  it("keeps a single-field variant on the whole-line path", () => {
    const code: InventoryField = {
      name: "code",
      label: "Mã",
      required: true,
      secret: true,
      customerVisible: true,
    };
    expect(bindSecretsToVariant("CODE-1|CODE-2", "var-1", [code])).toBe("var-1,CODE-1|CODE-2");
  });
});
