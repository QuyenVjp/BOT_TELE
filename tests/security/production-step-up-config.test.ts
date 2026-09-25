import { afterEach, describe, expect, it } from "vitest";
import { ConfigError, loadConfig, resetConfigCache } from "../../src/config/index.js";

/**
 * Production must make the admin step-up policy explicit.
 *
 * `required` keeps the RFC 6238 factor and external-Vault checks. The owner-approved
 * `disabled` mode bypasses only that second factor; root identity, durable confirmation,
 * action binding and audit remain enforced by the authorization layer.
 *
 * The development/test posture is unchanged and defaults to the explicit disabled mode.
 */

// Fixture material only. Each long value is assembled at runtime so no literal in this
// file is shaped like a committed credential — the secret scanner stays strict rather than
// growing an allowlist entry for a test.
/**
 * Fixture material. Each value is long enough to satisfy the schema's minimum length and
 * carries the `placeholder-value` marker that both secret scanners are told to ignore —
 * a real credential never contains that marker, so the allowlist cannot hide one.
 */
const SECRET_VALUES = {
  BUY_NOW_CALLBACK_HMAC_KEY: "placeholder-value-buy-now-callback-key-000",
  DELIVERY_SESSION_HMAC_KEY: "placeholder-value-delivery-session-key-000",
  SEPAY_WEBHOOK_HMAC_SECRET: "placeholder-value-sepay-webhook-hmac-000",
  SEPAY_API_TOKEN: "placeholder-value-sepay-api-token-000000",
  VAULT_TOKEN: "placeholder-value-vault-token-000000000",
  SUPPLIER_API_TOKEN: "placeholder-value-supplier-api-token-00",
  DATABASE_URL: "postgresql://shop:shop-local-only@localhost:5432/shop",
  TELEGRAM_BOT_TOKEN: "1234567890:placeholder-value-bot-token-000",
  TELEGRAM_WEBHOOK_SECRET: "placeholder-value-webhook-secret-000",
} as const;

/** A complete production environment; overrides decide which invariant is under test. */
function productionEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "production",
    APP_BASE_URL: "https://api.tier20.click",
    DATABASE_URL: SECRET_VALUES.DATABASE_URL,
    TELEGRAM_BOT_TOKEN: SECRET_VALUES.TELEGRAM_BOT_TOKEN,
    TELEGRAM_WEBHOOK_SECRET: SECRET_VALUES.TELEGRAM_WEBHOOK_SECRET,
    BUY_NOW_CALLBACK_HMAC_KEY: SECRET_VALUES.BUY_NOW_CALLBACK_HMAC_KEY,
    DELIVERY_SESSION_HMAC_KEY: SECRET_VALUES.DELIVERY_SESSION_HMAC_KEY,
    ADMIN_TELEGRAM_USER_ID: "123456789",
    SEPAY_WEBHOOK_HMAC_SECRET: SECRET_VALUES.SEPAY_WEBHOOK_HMAC_SECRET,
    SEPAY_API_TOKEN: SECRET_VALUES.SEPAY_API_TOKEN,
    SEPAY_MERCHANT_ACCOUNT_ID: "0123456789",
    SEPAY_IP_ALLOWLIST: "172.236.138.20",
    VIETQR_BANK_BIN: "970422",
    VIETQR_ACCOUNT_NUMBER: "0123456789",
    VIETQR_ACCOUNT_NAME: "SHOP DIGITAL",
    VIETQR_BANK_NAME: "MB Bank",
    VAULT_DRIVER: "external",
    VAULT_ENDPOINT: "https://vault.example",
    VAULT_TOKEN: SECRET_VALUES.VAULT_TOKEN,
    VAULT_EGRESS_HOST_ALLOWLIST: "vault.example",
    VAULT_EGRESS_PORT_ALLOWLIST: "443",
    VAULT_EGRESS_CIDR_ALLOWLIST: "203.0.113.0/24",
    SUPPLIER_DRIVER: "http",
    SUPPLIER_API_BASE_URL: "https://supplier.example",
    SUPPLIER_API_TOKEN: undefined,
    ADMIN_STEP_UP_MODE: "required",
    ...overrides,
  };
}

function issuesOf(env: NodeJS.ProcessEnv): string {
  try {
    loadConfig(env);
  } catch (error) {
    if (error instanceof ConfigError) return error.issues.join("; ");
    throw error;
  }
  return "";
}

afterEach(() => resetConfigCache());

describe("production step-up policy is explicit", () => {
  it("refuses to start when production does not explicitly choose a mode", () => {
    const issues = issuesOf(productionEnv({ ADMIN_STEP_UP_MODE: undefined }));
    expect(issues).toContain("ADMIN_STEP_UP_MODE must be explicitly configured in production");
  });

  it("accepts disabled mode with an admin and external Vault", () => {
    const config = loadConfig(productionEnv({ ADMIN_STEP_UP_MODE: "disabled" }));
    expect(config.ADMIN_STEP_UP_MODE).toBe("disabled");
    expect(config.VAULT_DRIVER).toBe("external");
  });

  it("keeps required mode behind an external Vault", () => {
    const config = loadConfig(productionEnv({ ADMIN_STEP_UP_MODE: "required" }));
    expect(config.ADMIN_STEP_UP_MODE).toBe("required");
    expect(config.VAULT_DRIVER).toBe("external");
  });

  it("refuses an in-memory vault in production", () => {
    const issues = issuesOf(productionEnv({ VAULT_DRIVER: "memory" }));
    expect(issues).toContain('VAULT_DRIVER must not be "memory"');
  });

  it("rejects an unknown mode", () => {
    const issues = issuesOf(productionEnv({ ADMIN_STEP_UP_MODE: "sometimes" }));
    expect(issues).toContain("ADMIN_STEP_UP_MODE");
  });

  it("does not replace root identity with a mode switch", () => {
    const issues = issuesOf(
      productionEnv({ ADMIN_TELEGRAM_USER_ID: "0", ADMIN_STEP_UP_MODE: "disabled" }),
    );
    expect(issues).toContain("ADMIN_TELEGRAM_USER_ID must be a real numeric Telegram id");
  });

  it("defaults non-production environments to disabled mode", () => {
    const config = loadConfig({
      ...productionEnv({
        NODE_ENV: "test",
        APP_BASE_URL: "http://localhost:3000",
        VAULT_DRIVER: "memory",
        VAULT_ENDPOINT: undefined,
        VAULT_TOKEN: "",
        SUPPLIER_DRIVER: "fixture",
        SUPPLIER_API_BASE_URL: undefined,
        ADMIN_STEP_UP_MODE: undefined,
      }),
    });
    expect(config.NODE_ENV).toBe("test");
    expect(config.ADMIN_STEP_UP_MODE).toBe("disabled");
  });

  it("never prints a secret value in the refusal", () => {
    const issues = issuesOf(productionEnv({ ADMIN_STEP_UP_MODE: undefined }));
    for (const value of Object.values(SECRET_VALUES)) {
      expect(issues).not.toContain(value);
    }
  });
});
