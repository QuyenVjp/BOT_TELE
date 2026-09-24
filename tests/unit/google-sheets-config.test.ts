import { afterEach, describe, expect, it } from "vitest";
import { envSchema } from "../../src/config/env.js";
import { loadConfig, resetConfigCache } from "../../src/config/index.js";

const baseEnv = {
  DATABASE_URL: "postgres://localhost:5432/shop",
  TELEGRAM_BOT_TOKEN: "t".repeat(32),
  TELEGRAM_WEBHOOK_SECRET: "w".repeat(32),
  BUY_NOW_CALLBACK_HMAC_KEY: "b".repeat(32),
  ADMIN_TELEGRAM_USER_ID: "123",
  SEPAY_WEBHOOK_HMAC_SECRET: "s".repeat(32),
  SEPAY_MERCHANT_ACCOUNT_ID: "merchant",
  VIETQR_BANK_BIN: "970422",
  VIETQR_ACCOUNT_NUMBER: "1234567890",
  VIETQR_ACCOUNT_NAME: "SHOP TEST",
  VIETQR_BANK_NAME: "Test Bank",
};

const productionSheetsEnv = {
  ...baseEnv,
  NODE_ENV: "production",
  APP_BASE_URL: "https://api.example.test",
  TELEGRAM_API_ENVIRONMENT: "prod",
  DELIVERY_SESSION_HMAC_KEY: "d".repeat(32),
  SEPAY_API_TOKEN: "p".repeat(32),
  SEPAY_IP_ALLOWLIST: "127.0.0.1",
  SEPAY_MERCHANT_ACCOUNT_ID: "1234567890",
  VAULT_DRIVER: "external",
  VAULT_EGRESS_HOST_ALLOWLIST: "127.0.0.1",
  VAULT_EGRESS_PORT_ALLOWLIST: "443",
  VAULT_EGRESS_CIDR_ALLOWLIST: "127.0.0.1/32",
  SUPPLIER_DRIVER: "http",
  GOOGLE_SHEETS_ENABLED: "true",
  GOOGLE_SHEETS_SPREADSHEET_ID: "spreadsheet-id",
  GOOGLE_SHEETS_CREDENTIAL_VAULT_REF: "vault:google-sheets-service-account",
  GOOGLE_SHEETS_OWNER_ID: "owner@example.test",
  ADMIN_STEP_UP_MODE: "disabled",
};

afterEach(() => resetConfigCache());

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

  it("defaults the inventory intake gate off", () => {
    expect(envSchema.parse(baseEnv).GOOGLE_SHEETS_INVENTORY_INTAKE_ENABLED).toBe(false);
  });

  it("allows the projection worker without intake OIDC configuration", () => {
    expect(() => loadConfig(productionSheetsEnv)).not.toThrow();
  });

  it("requires OIDC audience when inventory intake is enabled", () => {
    expect(() =>
      loadConfig({
        ...productionSheetsEnv,
        GOOGLE_SHEETS_INVENTORY_INTAKE_ENABLED: "true",
      }),
    ).toThrow("GOOGLE_SHEETS_OIDC_AUDIENCE is required when inventory intake is enabled");
  });
});
