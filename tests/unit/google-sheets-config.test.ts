import { describe, expect, it } from "vitest";
import { envSchema } from "../../src/config/env.js";

const baseEnv = {
  DATABASE_URL: "postgres://localhost:5432/shop",
  TELEGRAM_BOT_TOKEN: "bot-value",
  TELEGRAM_WEBHOOK_SECRET: "webhook-value",
  BUY_NOW_CALLBACK_HMAC_KEY: "b".repeat(32),
  ADMIN_TELEGRAM_USER_ID: "123",
  SEPAY_WEBHOOK_HMAC_SECRET: "s".repeat(32),
  SEPAY_MERCHANT_ACCOUNT_ID: "merchant",
  VIETQR_BANK_BIN: "970422",
  VIETQR_ACCOUNT_NUMBER: "1234567890",
  VIETQR_ACCOUNT_NAME: "SHOP TEST",
  VIETQR_BANK_NAME: "Test Bank",
};

describe("Google Sheets configuration", () => {
  it("defaults to disabled and parses false/true without coercing arbitrary strings", () => {
    expect(envSchema.parse(baseEnv).GOOGLE_SHEETS_ENABLED).toBe(false);
    expect(
      envSchema.parse({ ...baseEnv, GOOGLE_SHEETS_ENABLED: "false" }).GOOGLE_SHEETS_ENABLED,
    ).toBe(false);
    expect(
      envSchema.parse({ ...baseEnv, GOOGLE_SHEETS_ENABLED: "true" }).GOOGLE_SHEETS_ENABLED,
    ).toBe(true);
    expect(
      envSchema.safeParse({ ...baseEnv, GOOGLE_SHEETS_ENABLED: "not-a-boolean" }).success,
    ).toBe(false);
  });

  it("keeps the credential as an opaque Vault reference", () => {
    const config = envSchema.parse({
      ...baseEnv,
      GOOGLE_SHEETS_ENABLED: "true",
      GOOGLE_SHEETS_SPREADSHEET_ID: "spreadsheet-id",
      GOOGLE_SHEETS_CREDENTIAL_VAULT_REF: "vault:google-sheets-service-account",
      GOOGLE_SHEETS_OWNER_ID: "owner@example.test",
    });
    expect(config.GOOGLE_SHEETS_CREDENTIAL_VAULT_REF).toBe("vault:google-sheets-service-account");
    expect(JSON.stringify(config)).not.toContain("private_key");
  });

  it("requires a Google account email when Sheets is enabled", () => {
    expect(
      envSchema.safeParse({
        ...baseEnv,
        GOOGLE_SHEETS_ENABLED: "true",
        GOOGLE_SHEETS_OWNER_ID: "owner-account",
      }).success,
    ).toBe(false);
  });
});
