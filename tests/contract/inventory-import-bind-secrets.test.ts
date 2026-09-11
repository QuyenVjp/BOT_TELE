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
  it("splits space-separated credentials matching field count (user screenshot case)", () => {
    const fields: InventoryField[] = [
      { name: "email", label: "Email", required: true, secret: false, customerVisible: true },
      { name: "password", label: "Mật khẩu", required: true, secret: true, customerVisible: true },
      {
        name: "recovery",
        label: "Email khôi phục/2FA",
        required: false,
        secret: true,
        customerVisible: true,
      },
    ];
    const input =
      "dorothywrightq356@gmail.com Elon_bacca_musk_3000 Z2CMYMDUS5JVDERG6PLV3PHAGITFUUPL";
    expect(bindSecretsToVariant(input, "var-gpt", fields)).toBe(
      "var-gpt,dorothywrightq356@gmail.com,Elon_bacca_musk_3000,Z2CMYMDUS5JVDERG6PLV3PHAGITFUUPL",
    );
  });

  it("handles multi-line wrapped single account input", () => {
    const fields: InventoryField[] = [
      { name: "email", label: "Email", required: true, secret: false, customerVisible: true },
      { name: "password", label: "Mật khẩu", required: true, secret: true, customerVisible: true },
      {
        name: "recovery",
        label: "Email khôi phục/2FA",
        required: false,
        secret: true,
        customerVisible: true,
      },
    ];
    // 2-line wrapped
    const input2 =
      "dorothywrightq356@gmail.com Elon_bacca_musk_3000\nZ2CMYMDUS5JVDERG6PLV3PHAGITFUUPL";
    expect(bindSecretsToVariant(input2, "var-gpt", fields)).toBe(
      "var-gpt,dorothywrightq356@gmail.com,Elon_bacca_musk_3000,Z2CMYMDUS5JVDERG6PLV3PHAGITFUUPL",
    );
    // 3-line wrapped
    const input3 =
      "dorothywrightq356@gmail.com\nElon_bacca_musk_3000\nZ2CMYMDUS5JVDERG6PLV3PHAGITFUUPL";
    expect(bindSecretsToVariant(input3, "var-gpt", fields)).toBe(
      "var-gpt,dorothywrightq356@gmail.com,Elon_bacca_musk_3000,Z2CMYMDUS5JVDERG6PLV3PHAGITFUUPL",
    );
  });

  it("supports colon-separated, tab-separated, semicolon-separated, and multi-dash delimiters", () => {
    const fields: InventoryField[] = [
      { name: "email", label: "Email", required: true, secret: false, customerVisible: true },
      { name: "password", label: "Password", required: true, secret: true, customerVisible: false },
    ];
    expect(bindSecretsToVariant("user@test.com:pass123", "var-1", fields)).toBe(
      "var-1,user@test.com,pass123",
    );
    expect(bindSecretsToVariant("user@test.com\tpass123", "var-1", fields)).toBe(
      "var-1,user@test.com,pass123",
    );
    expect(bindSecretsToVariant("user@test.com;pass123", "var-1", fields)).toBe(
      "var-1,user@test.com,pass123",
    );
    expect(bindSecretsToVariant("user@test.com --- pass123", "var-1", fields)).toBe(
      "var-1,user@test.com,pass123",
    );
    expect(bindSecretsToVariant("user@test.com // pass123", "var-1", fields)).toBe(
      "var-1,user@test.com,pass123",
    );
  });

  it("parses labeled multi-line input in Vietnamese or English", () => {
    const fields: InventoryField[] = [
      { name: "email", label: "Email", required: true, secret: false, customerVisible: true },
      { name: "password", label: "Mật khẩu", required: true, secret: true, customerVisible: true },
      {
        name: "recovery",
        label: "Email khôi phục/2FA",
        required: false,
        secret: true,
        customerVisible: true,
      },
    ];
    const labeledEn = "Email: user1@gmail.com\nPassword: pass1\nRecovery: key1";
    expect(bindSecretsToVariant(labeledEn, "var-gpt", fields)).toBe(
      "var-gpt,user1@gmail.com,pass1,key1",
    );
    const labeledVi = "Tài khoản: user2@gmail.com\nMật khẩu: pass2\n2FA: key2";
    expect(bindSecretsToVariant(labeledVi, "var-gpt", fields)).toBe(
      "var-gpt,user2@gmail.com,pass2,key2",
    );
  });

  it("handles bulk multi-account imports separated by newlines", () => {
    const fields: InventoryField[] = [
      { name: "email", label: "Email", required: true, secret: false, customerVisible: true },
      { name: "password", label: "Mật khẩu", required: true, secret: true, customerVisible: true },
      {
        name: "recovery",
        label: "Email khôi phục/2FA",
        required: false,
        secret: true,
        customerVisible: true,
      },
    ];
    const bulk = "u1@test.com p1 r1\nu2@test.com p2 r2";
    expect(bindSecretsToVariant(bulk, "var-gpt", fields)).toBe(
      "var-gpt,u1@test.com,p1,r1\nvar-gpt,u2@test.com,p2,r2",
    );
  });
});
