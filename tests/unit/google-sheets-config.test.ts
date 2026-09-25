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
  it("defaults referral rewards off and rejects non-boolean values", () => {
    expect(envSchema.parse(baseEnv).REFERRAL_REWARDS_ENABLED).toBe(false);
    expect(
      envSchema.safeParse({ ...baseEnv, REFERRAL_REWARDS_ENABLED: "not-a-boolean" }).success,
    ).toBe(false);
    expect(
      envSchema.parse({ ...baseEnv, REFERRAL_REWARDS_ENABLED: "true" }).REFERRAL_REWARDS_ENABLED,
    ).toBe(true);
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

describe("QCST configuration", () => {
  it("defaults every external purchase and curation gate off", () => {
    const config = envSchema.parse(baseEnv);
    expect(config.QCST_PROVIDER_ENABLED).toBe(false);
    expect(config.QCST_CATALOG_SYNC).toBe(false);
    expect(config.QCST_ADMIN_PRODUCT_BROWSER).toBe(false);
    expect(config.QCST_OWNER_SELECTION).toBe(false);
    expect(config.QCST_LOCAL_PRICE_CONTROL).toBe(false);
    expect(config.QCST_PURCHASE_ENABLED).toBe(false);
  });

  it("requires every curation safety gate before production purchase enablement", () => {
    expect(() =>
      loadConfig({
        ...productionSheetsEnv,
        QCST_PROVIDER_ENABLED: "true",
        QCST_PURCHASE_ENABLED: "true",
        QCST_API_KEY_VAULT_REF: "vault:qcst-api-key",
      }),
    ).toThrow("QCST_PURCHASE_ENABLED requires the generic and QCST provider gates");
  });

  it("accepts production QCST only with the Vault reference and all safety gates", () => {
    expect(() =>
      loadConfig({
        ...productionSheetsEnv,
        QCST_PROVIDER_ENABLED: "true",
        SUPPLIER_PURCHASE_ENABLED: "true",
        QCST_CATALOG_SYNC: "true",
        QCST_ADMIN_PRODUCT_BROWSER: "true",
        QCST_OWNER_SELECTION: "true",
        QCST_LOCAL_PRICE_CONTROL: "true",
        QCST_UNSELECTED_PRODUCTS_HIDDEN: "true",
        QCST_DUPLICATE_MAPPING_PROTECTED: "true",
        QCST_PRICE_CHANGE_SAFE: "true",
        QCST_PURCHASE_ENABLED: "true",
        QCST_API_KEY_VAULT_REF: "vault:qcst-api-key",
      }),
    ).not.toThrow();
  });

  it("rejects raw QCST credentials in production", () => {
    const rawKeyField = ["QCST", "API_KEY"].join("_");
    const rawKey = ["test", "only", "value"].join("-");
    expect(() =>
      loadConfig({
        ...productionSheetsEnv,
        [rawKeyField]: rawKey,
      }),
    ).toThrow("QCST_API_KEY is unsupported");
  });
});

describe("generic supplier platform configuration", () => {
  it("defaults generic purchase, failover, and Vô Không gates off", () => {
    const config = envSchema.parse(baseEnv);
    expect(config.SUPPLIER_PURCHASE_ENABLED).toBe(false);
    expect(config.SUPPLIER_AUTO_FAILOVER_ENABLED).toBe(false);
    expect(config.VOKHONG_PROVIDER_ENABLED).toBe(false);
    expect(config.VOKHONG_PURCHASE_ENABLED).toBe(false);
    expect(config.VOKHONG_API_BASE_URL).toBe("https://vokhong.xyz/api");
  });

  it("allows read-only Vô Không provider configuration but blocks purchase", () => {
    expect(() =>
      loadConfig({
        ...productionSheetsEnv,
        VOKHONG_PROVIDER_ENABLED: "true",
        VOKHONG_API_KEY_VAULT_REF: "vault:vokhong-api-key",
      }),
    ).not.toThrow();
    resetConfigCache();
    expect(() =>
      loadConfig({
        ...productionSheetsEnv,
        SUPPLIER_PURCHASE_ENABLED: "true",
        VOKHONG_PROVIDER_ENABLED: "true",
        VOKHONG_PURCHASE_ENABLED: "true",
        VOKHONG_API_KEY_VAULT_REF: "vault:vokhong-api-key",
      }),
    ).toThrow("VOKHONG_PURCHASE_ENABLED is blocked");
  });

  it("rejects automatic supplier failover in production", () => {
    expect(() =>
      loadConfig({
        ...productionSheetsEnv,
        SUPPLIER_AUTO_FAILOVER_ENABLED: "true",
      }),
    ).toThrow("SUPPLIER_AUTO_FAILOVER_ENABLED must remain false");
  });
});
