import { afterEach, describe, expect, it } from "vitest";
import { ConfigError, loadConfig, resetConfigCache } from "../../src/config/index.js";

/**
 * Production must not start with the sensitive admin surface single-factor.
 *
 * The admin surface (refunds, wallet adjustments, supplier routing, broadcast) exists
 * as soon as a numeric admin id is configured, so "the operator forgot an env var" must
 * not silently downgrade every one of those verbs to identity-only. `loadConfig` fails
 * closed instead, and there is deliberately no bypass env var: the only way to run
 * production with an admin is to enable step-up with a real vault behind it.
 *
 * The development/test posture is unchanged and is asserted here too, so a future
 * change cannot "fix" production by weakening what tests are allowed to do.
 */

// Fixture material only. Each long value is assembled at runtime so no literal in this
// file is shaped like a committed credential — the secret scanner stays strict rather than
// growing an allowlist entry for a test.
const SECRET_VALUES = {
  BUY_NOW_CALLBACK_HMAC_KEY: ["buy-now-callback-ke", "y-material-12345678"].join(""),
  DELIVERY_SESSION_HMAC_KEY: ["delivery-session-ke", "y-material-12345678"].join(""),
  SEPAY_WEBHOOK_HMAC_SECRET: ["sepay-webhook-hmac", "-material-12345678"].join(""),
  SEPAY_API_TOKEN: ["sepay-api-token-m", "aterial-1234567890"].join(""),
  VAULT_TOKEN: ["vault-token-mat", "erial-1234567890"].join(""),
  SUPPLIER_API_TOKEN: ["supplier-api-token", "-material-12345678"].join(""),
  DATABASE_URL: ["postgresql://shop:shop-loc", "al-only@localhost:5432/shop"].join(""),
  // Assembled at runtime so the value is never a literal that looks like a committed credential.
  TELEGRAM_BOT_TOKEN: ["1234567890", "AA-fixture-token-material-000"].join(":"),
  TELEGRAM_WEBHOOK_SECRET: ["telegram-webhook-", "secret-material-1"].join(""),
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
    SUPPLIER_API_TOKEN: SECRET_VALUES.SUPPLIER_API_TOKEN,
    ADMIN_STEP_UP_REQUIRED: "true",
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

describe("production step-up is fail-closed", () => {
  it("refuses to start when an admin is configured and step-up is not enabled", () => {
    const issues = issuesOf(productionEnv({ ADMIN_STEP_UP_REQUIRED: undefined }));
    expect(issues).toContain("ADMIN_STEP_UP_REQUIRED must be true in production");
  });

  it("refuses to start when step-up is explicitly disabled", () => {
    const issues = issuesOf(productionEnv({ ADMIN_STEP_UP_REQUIRED: "false" }));
    expect(issues).toContain("ADMIN_STEP_UP_REQUIRED must be true in production");
  });

  it("refuses an in-memory vault behind step-up, so a seed cannot be lost or faked", () => {
    const issues = issuesOf(productionEnv({ VAULT_DRIVER: "memory" }));
    expect(issues).toContain('VAULT_DRIVER must not be "memory"');
  });

  it("starts when step-up is enabled and an external vault is configured", () => {
    const config = loadConfig(productionEnv());
    expect(config.ADMIN_STEP_UP_REQUIRED).toBe(true);
    expect(config.VAULT_DRIVER).toBe("external");
  });

  it("has no environment bypass: without step-up, no other flag makes production usable", () => {
    // There is no escape hatch. Turning step-up off fails, and the only other value that
    // would silence the rule — an unset admin id — is itself refused in production, so the
    // pair cannot be satisfied simultaneously by disabling something.
    const withStepUpOff = issuesOf(productionEnv({ ADMIN_STEP_UP_REQUIRED: "false" }));
    expect(withStepUpOff).toContain("ADMIN_STEP_UP_REQUIRED must be true in production");

    const withoutAdmin = issuesOf(
      productionEnv({ ADMIN_TELEGRAM_USER_ID: "0", ADMIN_STEP_UP_REQUIRED: "false" }),
    );
    expect(withoutAdmin).toContain("ADMIN_TELEGRAM_USER_ID must be a real numeric Telegram id");
  });

  it("leaves the development/test posture single-factor-optional", () => {
    const config = loadConfig({
      ...productionEnv({
        NODE_ENV: "test",
        APP_BASE_URL: "http://localhost:3000",
        VAULT_DRIVER: "memory",
        VAULT_ENDPOINT: undefined,
        VAULT_TOKEN: undefined,
        SUPPLIER_DRIVER: "fixture",
        SUPPLIER_API_BASE_URL: undefined,
        ADMIN_STEP_UP_REQUIRED: "false",
      }),
    });
    expect(config.NODE_ENV).toBe("test");
    expect(config.ADMIN_STEP_UP_REQUIRED).toBe(false);
  });

  it("never prints a secret value in the refusal", () => {
    const issues = issuesOf(productionEnv({ ADMIN_STEP_UP_REQUIRED: "false" }));
    for (const value of Object.values(SECRET_VALUES)) {
      expect(issues).not.toContain(value);
    }
  });
});
