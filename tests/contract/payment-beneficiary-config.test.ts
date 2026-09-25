import { afterEach, describe, expect, it } from "vitest";
import { ConfigError, loadConfig, resetConfigCache } from "../../src/config/index.js";

function validEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "test",
    APP_BASE_URL: "http://localhost:3000",
    DATABASE_URL: "postgres://user:password@localhost:5432/shop",
    TELEGRAM_BOT_TOKEN: "123456:token",
    TELEGRAM_WEBHOOK_SECRET: "webhook-secret",
    BUY_NOW_CALLBACK_HMAC_KEY: "buy-now-callback-key-material-123456",
    ADMIN_TELEGRAM_USER_ID: "123456789",
    SEPAY_WEBHOOK_HMAC_SECRET: "test-sepay-hmac-secret-do-not-use-in-prod",
    SEPAY_MERCHANT_ACCOUNT_ID: "sepay-merchant-identity",
    SEPAY_IP_ALLOWLIST: "172.236.138.20",
    VIETQR_BANK_BIN: "970422",
    VIETQR_ACCOUNT_NUMBER: "0123456789",
    VIETQR_ACCOUNT_NAME: "SHOP DIGITAL",
    VIETQR_BANK_NAME: "MB Bank",
    ...overrides,
  };
}

afterEach(() => resetConfigCache());

describe("payment beneficiary configuration contract (T171)", () => {
  it("keeps SePay merchant identity and VietQR beneficiary number independently configured", () => {
    const config = loadConfig(
      validEnv({
        SEPAY_MERCHANT_ACCOUNT_ID: "sepay-merchant-001",
        VIETQR_ACCOUNT_NUMBER: "0123456789",
      }),
    );

    expect(config.SEPAY_MERCHANT_ACCOUNT_ID).toBe("sepay-merchant-001");
    expect(config.VIETQR_ACCOUNT_NUMBER).toBe("0123456789");
    expect(config.SEPAY_MERCHANT_ACCOUNT_ID).not.toBe(config.VIETQR_ACCOUNT_NUMBER);
    expect(config.VIETQR_BANK_NAME).toBe("MB Bank");
  });

  it("rejects an empty SePay merchant identity", () => {
    expect(() => loadConfig(validEnv({ SEPAY_MERCHANT_ACCOUNT_ID: "" }))).toThrow(ConfigError);
  });

  it("rejects an empty VietQR beneficiary account number", () => {
    expect(() => loadConfig(validEnv({ VIETQR_ACCOUNT_NUMBER: "" }))).toThrow(ConfigError);
  });

  it("accepts a pilot where the SePay identity equals the VietQR beneficiary number", () => {
    const config = loadConfig(
      validEnv({
        SEPAY_MERCHANT_ACCOUNT_ID: "0123456789",
        VIETQR_ACCOUNT_NUMBER: "0123456789",
      }),
    );
    expect(config.SEPAY_MERCHANT_ACCOUNT_ID).toBe(config.VIETQR_ACCOUNT_NUMBER);
  });

  it("rejects a blank or overlong bank display name", () => {
    expect(() => loadConfig(validEnv({ VIETQR_BANK_NAME: "   " }))).toThrow(ConfigError);
    expect(() => loadConfig(validEnv({ VIETQR_BANK_NAME: "x".repeat(101) }))).toThrow(ConfigError);
  });
  it("fails closed in production if SEPAY_MERCHANT_ACCOUNT_ID does not match VIETQR_ACCOUNT_NUMBER", () => {
    const prodEnv = {
      ...validEnv({
        NODE_ENV: "production",
        APP_BASE_URL: "https://api.tier20.click",
        VAULT_DRIVER: "external",
        VAULT_ENDPOINT: "https://127.0.0.1:8443",
        VAULT_TOKEN: "vault-token-material-12345678901234567890",
        VAULT_EGRESS_HOST_ALLOWLIST: "127.0.0.1",
        VAULT_EGRESS_PORT_ALLOWLIST: "8443",
        VAULT_EGRESS_CIDR_ALLOWLIST: "127.0.0.1/32",
        SUPPLIER_DRIVER: "http",
        SUPPLIER_API_BASE_URL: "https://supplier.example.com",
        SEPAY_API_TOKEN: "sepay-api-token-material-1234567890",
        DELIVERY_SESSION_HMAC_KEY: "delivery-session-key-material-12345678",
        BUY_NOW_CALLBACK_HMAC_KEY: "buy-now-callback-key-material-12345678",
        ADMIN_STEP_UP_MODE: "required",
        SEPAY_MERCHANT_ACCOUNT_ID: "0123456789",
        VIETQR_ACCOUNT_NUMBER: "0335920306",
      }),
    };
    expect(() => loadConfig(prodEnv)).toThrow(ConfigError);
    try {
      loadConfig(prodEnv);
    } catch (err) {
      const message = (err as ConfigError).issues.join("; ");
      expect(message).toBe(
        "SEPAY_MERCHANT_ACCOUNT_ID must match VIETQR_ACCOUNT_NUMBER in production",
      );
      expect(message).not.toContain("0123456789");
      expect(message).not.toContain("0335920306");
    }
  });
});
