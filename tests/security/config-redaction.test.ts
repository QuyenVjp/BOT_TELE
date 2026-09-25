import { afterEach, describe, expect, it } from "vitest";
import {
  ConfigError,
  loadConfig,
  redactedConfig,
  resetConfigCache,
  SECRET_ENV_KEYS,
} from "../../src/config/index.js";

/**
 * T009 — Environment validation and secret-safe diagnostics (FR/SR boundaries).
 *
 * Guards:
 *  - loader fails closed on missing/invalid required values (SR-002 spirit: no
 *    silent defaults for security-relevant inputs);
 *  - no thrown diagnostic or redacted view ever contains a secret VALUE;
 *  - production rejects local-only vault configuration and raw provider credentials;
 */

const SECRET_VALUES: Record<string, string> = {
  TELEGRAM_BOT_TOKEN: "123456:AA-SECRET-BOT-TOKEN-value",
  TELEGRAM_WEBHOOK_SECRET: "webhook-secret-abcdefgh",
  BUY_NOW_CALLBACK_HMAC_KEY: "buy-now-callback-secret-key-material-123456",
  DELIVERY_SESSION_HMAC_KEY: "delivery-session-secret-key-material-123456",
  DELIVERY_SESSION_PREVIOUS_HMAC_KEY: "previous-delivery-session-key-material-123456",
  SEPAY_WEBHOOK_HMAC_SECRET: "sepay-hmac-fixture-key-material-123456",
  SEPAY_API_TOKEN: "sepay-api-token-secret",
  VAULT_TOKEN: "vault-token-secret",
  DATABASE_URL: "postgres://user:dbpassword-secret@localhost:5432/shop",
  REDIS_URL: "redis://:redispassword-secret@localhost:6379",
};

function validEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "test",
    APP_BASE_URL: "http://localhost:3000",
    DATABASE_URL: SECRET_VALUES.DATABASE_URL,
    TELEGRAM_BOT_TOKEN: SECRET_VALUES.TELEGRAM_BOT_TOKEN,
    TELEGRAM_WEBHOOK_SECRET: SECRET_VALUES.TELEGRAM_WEBHOOK_SECRET,
    BUY_NOW_CALLBACK_HMAC_KEY: SECRET_VALUES.BUY_NOW_CALLBACK_HMAC_KEY,
    DELIVERY_SESSION_HMAC_KEY: SECRET_VALUES.DELIVERY_SESSION_HMAC_KEY,
    ADMIN_TELEGRAM_USER_ID: "123456789",
    SEPAY_WEBHOOK_HMAC_SECRET: SECRET_VALUES.SEPAY_WEBHOOK_HMAC_SECRET,
    SEPAY_MERCHANT_ACCOUNT_ID: "sepay-merchant-001",
    SEPAY_IP_ALLOWLIST: "172.236.138.20",
    VIETQR_BANK_BIN: "970422",
    VIETQR_ACCOUNT_NUMBER: "0123456789",
    VIETQR_ACCOUNT_NAME: "SHOP DIGITAL",
    VIETQR_BANK_NAME: "MB Bank",
    VAULT_EGRESS_HOST_ALLOWLIST: "vault.example",
    VAULT_EGRESS_PORT_ALLOWLIST: "443",
    VAULT_EGRESS_CIDR_ALLOWLIST: "203.0.113.0/24",
    ...overrides,
  };
}

afterEach(() => {
  resetConfigCache();
});

describe("config loader fail-closed", () => {
  it("throws ConfigError listing missing required keys", () => {
    expect(() => loadConfig({ NODE_ENV: "test" })).toThrow(ConfigError);
  });

  it("accepts a complete development/test environment", () => {
    const config = loadConfig(validEnv());
    expect(config.ADMIN_TELEGRAM_USER_ID).toBe(123456789);
    expect(config.VIETQR_BANK_BIN).toBe("970422");
  });

  it("rejects delivery-session key reuse with the Buy Now callback key in production", () => {
    const env = validEnv({
      NODE_ENV: "production",
      APP_BASE_URL: "https://shop.example",
      VAULT_DRIVER: "external",
      VAULT_ENDPOINT: "https://vault.example",
      VAULT_TOKEN: SECRET_VALUES.VAULT_TOKEN!,
      SEPAY_API_TOKEN: SECRET_VALUES.SEPAY_API_TOKEN!,
      DELIVERY_SESSION_HMAC_KEY: SECRET_VALUES.BUY_NOW_CALLBACK_HMAC_KEY!,
    });
    expect(() => loadConfig(env)).toThrow(/DELIVERY_SESSION_HMAC_KEY/);
  });

  it.each([
    ["DELIVERY_SESSION_HMAC_KEY", "TELEGRAM_BOT_TOKEN"],
    ["DELIVERY_SESSION_HMAC_KEY", "TELEGRAM_WEBHOOK_SECRET"],
    ["DELIVERY_SESSION_HMAC_KEY", "SEPAY_WEBHOOK_HMAC_SECRET"],
    ["DELIVERY_SESSION_HMAC_KEY", "SEPAY_API_TOKEN"],
    ["DELIVERY_SESSION_HMAC_KEY", "VAULT_TOKEN"],
    ["DELIVERY_SESSION_PREVIOUS_HMAC_KEY", "TELEGRAM_BOT_TOKEN"],
    ["DELIVERY_SESSION_PREVIOUS_HMAC_KEY", "TELEGRAM_WEBHOOK_SECRET"],
    ["DELIVERY_SESSION_PREVIOUS_HMAC_KEY", "BUY_NOW_CALLBACK_HMAC_KEY"],
    ["DELIVERY_SESSION_PREVIOUS_HMAC_KEY", "SEPAY_WEBHOOK_HMAC_SECRET"],
    ["DELIVERY_SESSION_PREVIOUS_HMAC_KEY", "SEPAY_API_TOKEN"],
    ["DELIVERY_SESSION_PREVIOUS_HMAC_KEY", "VAULT_TOKEN"],
  ] as const)("rejects %s reuse with %s without leaking the value", (deliveryKey, providerKey) => {
    const shared = "shared-cross-domain-key-material-123456";
    const env = validEnv({
      NODE_ENV: "production",
      APP_BASE_URL: "https://shop.example",
      VAULT_DRIVER: "external",
      VAULT_ENDPOINT: "https://vault.example",
      VAULT_TOKEN: SECRET_VALUES.VAULT_TOKEN!,
      SEPAY_API_TOKEN: SECRET_VALUES.SEPAY_API_TOKEN!,
      DELIVERY_SESSION_PREVIOUS_HMAC_KEY: SECRET_VALUES.DELIVERY_SESSION_PREVIOUS_HMAC_KEY!,
      DELIVERY_SESSION_PREVIOUS_KEY_VERSION: "3",
      DELIVERY_SESSION_PREVIOUS_KEY_GRACE_UNTIL: "2026-08-01T00:00:00.000Z",
      [deliveryKey]: shared,
      [providerKey]: shared,
    });

    let thrown: ConfigError | undefined;
    try {
      loadConfig(env);
    } catch (error) {
      thrown = error as ConfigError;
    }
    expect(thrown).toBeInstanceOf(ConfigError);
    expect(thrown?.issues.join(" ")).toContain(deliveryKey);
    expect(thrown?.issues.join(" ")).not.toContain(shared);
  });

  it("parses and redacts the explicit previous delivery-session key grace configuration", () => {
    const config = loadConfig(
      validEnv({
        DELIVERY_SESSION_PREVIOUS_HMAC_KEY: SECRET_VALUES.DELIVERY_SESSION_PREVIOUS_HMAC_KEY!,
        DELIVERY_SESSION_PREVIOUS_KEY_VERSION: "3",
        DELIVERY_SESSION_PREVIOUS_KEY_GRACE_UNTIL: "2026-08-01T00:00:00.000Z",
      }),
    );
    const runtime = config as unknown as Record<string, unknown>;
    expect(runtime.DELIVERY_SESSION_PREVIOUS_HMAC_KEY).toBe(
      SECRET_VALUES.DELIVERY_SESSION_PREVIOUS_HMAC_KEY,
    );
    expect(runtime.DELIVERY_SESSION_PREVIOUS_KEY_VERSION).toBe(3);
    expect(runtime.DELIVERY_SESSION_PREVIOUS_KEY_GRACE_UNTIL).toBe("2026-08-01T00:00:00.000Z");
    expect(redactedConfig(config).DELIVERY_SESSION_PREVIOUS_HMAC_KEY).toBe("«redacted»");
  });

  it("requires the previous delivery key, version, and grace deadline together in production", () => {
    const env = validEnv({
      NODE_ENV: "production",
      APP_BASE_URL: "https://shop.example",
      VAULT_DRIVER: "external",
      VAULT_ENDPOINT: "https://vault.example",
      VAULT_TOKEN: SECRET_VALUES.VAULT_TOKEN!,
      SEPAY_API_TOKEN: SECRET_VALUES.SEPAY_API_TOKEN!,
      DELIVERY_SESSION_PREVIOUS_HMAC_KEY: SECRET_VALUES.DELIVERY_SESSION_PREVIOUS_HMAC_KEY!,
      DELIVERY_SESSION_PREVIOUS_KEY_VERSION: "3",
      DELIVERY_SESSION_PREVIOUS_KEY_GRACE_UNTIL: "",
    });

    expect(() => loadConfig(env)).toThrow(/DELIVERY_SESSION_PREVIOUS_KEY_GRACE_UNTIL/);
  });
});

describe("no secret value leaks in diagnostics", () => {
  it("error message never contains a provided secret value", () => {
    // Supply secrets but break a non-secret required field so validation fails.
    const env = validEnv({ VIETQR_BANK_BIN: "12" }); // too short -> invalid
    let thrown: unknown;
    try {
      loadConfig(env);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ConfigError);
    const serialized = `${(thrown as ConfigError).message} ${(thrown as ConfigError).issues.join(" ")}`;
    for (const value of Object.values(SECRET_VALUES)) {
      expect(serialized).not.toContain(value);
    }
  });

  it("redactedConfig masks every secret key and leaks no secret value", () => {
    const config = loadConfig(validEnv());
    const view = redactedConfig(config);
    for (const key of SECRET_ENV_KEYS) {
      expect(view[key]).toBe("«redacted»");
    }
    const serialized = JSON.stringify(view);
    for (const value of Object.values(SECRET_VALUES)) {
      expect(serialized).not.toContain(value);
    }
  });
});

describe("production hardening fails closed", () => {
  it.each([
    ["TELEGRAM_BOT_TOKEN", "000000000:TEST_PLACEHOLDER_TOKEN_DO_NOT_USE"],
    ["TELEGRAM_WEBHOOK_SECRET", "local-dev-webhook-secret-change-me"],
  ] as const)("rejects the documented %s placeholder", (key, value) => {
    const env = validEnv({
      NODE_ENV: "production",
      APP_BASE_URL: "https://shop.example.com",
      VAULT_DRIVER: "external",
      VAULT_ENDPOINT: "https://vault.example.com",
      VAULT_TOKEN: "vault-token-secret",
      SEPAY_API_TOKEN: "sepay-api-token-secret",
      [key]: value,
    });

    expect(() => loadConfig(env)).toThrow(new RegExp(key));
  });

  it("rejects the memory vault in production", () => {
    const env = validEnv({
      NODE_ENV: "production",
      APP_BASE_URL: "https://shop.example.com",
      VAULT_DRIVER: "memory",
    });
    let thrown: ConfigError | undefined;
    try {
      loadConfig(env);
    } catch (err) {
      thrown = err as ConfigError;
    }
    expect(thrown).toBeInstanceOf(ConfigError);
    expect(thrown?.issues.some((i) => i.includes("VAULT_DRIVER"))).toBe(true);
  });

  it("rejects an external production vault without an explicit egress policy", () => {
    const env = validEnv({
      NODE_ENV: "production",
      APP_BASE_URL: "https://shop.example.com",
      VAULT_DRIVER: "external",
      VAULT_ENDPOINT: "https://vault.example",
      VAULT_TOKEN: SECRET_VALUES.VAULT_TOKEN!,
      VAULT_EGRESS_HOST_ALLOWLIST: "",
      VAULT_EGRESS_PORT_ALLOWLIST: "",
      VAULT_EGRESS_CIDR_ALLOWLIST: "",
      SEPAY_API_TOKEN: SECRET_VALUES.SEPAY_API_TOKEN!,
    });

    expect(() => loadConfig(env)).toThrow(/VAULT_EGRESS_/);
  });

  it("rejects non-https base url in production", () => {
    const env = validEnv({
      NODE_ENV: "production",
      APP_BASE_URL: "http://shop.example.com",
      VAULT_DRIVER: "external",
      VAULT_ENDPOINT: "https://vault.example.com",
      VAULT_TOKEN: "vault-token-secret",
    });
    expect(() => loadConfig(env)).toThrow(/APP_BASE_URL must be https/);
  });

  it("rejects the documented callback placeholder in production", () => {
    const env = validEnv({
      NODE_ENV: "production",
      APP_BASE_URL: "https://shop.example.com",
      VAULT_DRIVER: "external",
      VAULT_ENDPOINT: "https://vault.example.com",
      VAULT_TOKEN: "vault-token-secret",
      BUY_NOW_CALLBACK_HMAC_KEY: "local-dev-buy-now-callback-key-change-me-32bytes",
    });

    expect(() => loadConfig(env)).toThrow(/BUY_NOW_CALLBACK_HMAC_KEY/);
  });

  it.each(["TELEGRAM_BOT_TOKEN", "TELEGRAM_WEBHOOK_SECRET", "SEPAY_WEBHOOK_HMAC_SECRET"] as const)(
    "rejects callback HMAC key reuse with %s",
    (reusedKey) => {
      const sharedSecret = "shared-security-domain-secret-material-123456";
      const env = validEnv({
        NODE_ENV: "production",
        APP_BASE_URL: "https://shop.example.com",
        VAULT_DRIVER: "external",
        VAULT_ENDPOINT: "https://vault.example.com",
        VAULT_TOKEN: "vault-token-secret",
        BUY_NOW_CALLBACK_HMAC_KEY: sharedSecret,
        [reusedKey]: sharedSecret,
      });

      let thrown: ConfigError | undefined;
      try {
        loadConfig(env);
      } catch (error) {
        thrown = error as ConfigError;
      }
      expect(thrown).toBeInstanceOf(ConfigError);
      expect(thrown?.issues.join(" ")).toContain("BUY_NOW_CALLBACK_HMAC_KEY");
      expect(thrown?.issues.join(" ")).not.toContain(sharedSecret);
    },
  );

  it("rejects callback TTL beyond the documented short-lived rotation window", () => {
    const env = validEnv({ BUY_NOW_CALLBACK_TTL_SECONDS: "86401" });
    expect(() => loadConfig(env)).toThrow(/BUY_NOW_CALLBACK_TTL_SECONDS/);
  });

  it("rejects empty SePay allowlist and documented HMAC placeholder in production", () => {
    const env = validEnv({
      NODE_ENV: "production",
      APP_BASE_URL: "https://shop.example.com",
      VAULT_DRIVER: "external",
      VAULT_ENDPOINT: "https://vault.example.com",
      VAULT_TOKEN: "vault-token-secret",
      SEPAY_IP_ALLOWLIST: "",
      SEPAY_WEBHOOK_HMAC_SECRET: "local-dev-sepay-hmac-secret-change-me",
    });
    let thrown: ConfigError | undefined;
    try {
      loadConfig(env);
    } catch (error) {
      thrown = error as ConfigError;
    }
    expect(thrown?.issues.join(" ")).toContain("SEPAY_IP_ALLOWLIST");
    expect(thrown?.issues.join(" ")).toContain("SEPAY_WEBHOOK_HMAC_SECRET");
  });

  it("rejects SePay HMAC reuse with Telegram security domains without leaking the value", () => {
    const shared = "shared-telegram-sepay-key-material-123456";
    const env = validEnv({
      NODE_ENV: "production",
      APP_BASE_URL: "https://shop.example.com",
      VAULT_DRIVER: "external",
      VAULT_ENDPOINT: "https://vault.example.com",
      VAULT_TOKEN: "vault-token-secret",
      TELEGRAM_WEBHOOK_SECRET: shared,
      SEPAY_WEBHOOK_HMAC_SECRET: shared,
    });
    let thrown: ConfigError | undefined;
    try {
      loadConfig(env);
    } catch (error) {
      thrown = error as ConfigError;
    }
    expect(thrown?.issues.join(" ")).toContain("SEPAY_WEBHOOK_HMAC_SECRET");
    expect(thrown?.issues.join(" ")).not.toContain(shared);
  });
});
