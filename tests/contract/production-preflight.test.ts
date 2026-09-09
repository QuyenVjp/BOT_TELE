import { afterEach, describe, expect, it } from "vitest";
import { loadConfig, resetConfigCache } from "../../src/config/index.js";
import { runProductionPreflight } from "../../src/scripts/production-preflight.js";

const DB_PASS = ["shop", "local", "only"].join("-");
const SUPPLIER_TOKEN = ["supplier", "token", "with", "spaces"].join(" ");

function productionEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "production",
    APP_BASE_URL: "https://api.tier20.click",
    HTTP_HOST: "127.0.0.1",
    HTTP_PORT: "3000",
    DATABASE_URL: `postgres://shop:${DB_PASS}@localhost:5432/shop`,
    REDIS_URL: "redis://127.0.0.1:6379",
    TELEGRAM_BOT_TOKEN: "123456:AA-SECRET-BOT-TOKEN-value",
    TELEGRAM_WEBHOOK_SECRET: "webhook-secret-abcdefgh",
    BUY_NOW_CALLBACK_HMAC_KEY: "buy-now-callback-key-material-12345678",
    DELIVERY_SESSION_HMAC_KEY: "delivery-session-key-material-12345678",
    ADMIN_TELEGRAM_USER_ID: "123456789",
    SEPAY_WEBHOOK_HMAC_SECRET: "test-sepay-hmac-secret-do-not-use-in-prod",
    SEPAY_API_TOKEN: ["sepay", "api", "token", "material"].join("-"),
    SEPAY_MERCHANT_ACCOUNT_ID: "0123456789",
    SEPAY_IP_ALLOWLIST: "127.0.0.1",
    VIETQR_BANK_BIN: "970422",
    VIETQR_BANK_ALIAS: "MB",
    VIETQR_ACCOUNT_NUMBER: "0123456789",
    VIETQR_ACCOUNT_NAME: "NGUYEN VAN TEST",
    VIETQR_BANK_NAME: "MB Bank",
    VAULT_DRIVER: "external",
    VAULT_ENDPOINT: "https://127.0.0.1:8443",
    VAULT_TOKEN: ["vault", "token", "material"].join("-"),
    VAULT_EGRESS_HOST_ALLOWLIST: "127.0.0.1",
    VAULT_EGRESS_PORT_ALLOWLIST: "8443",
    VAULT_EGRESS_CIDR_ALLOWLIST: "127.0.0.1/32",
    SUPPLIER_DRIVER: "http",
    SUPPLIER_API_BASE_URL: "https://supplier.example.com",
    SUPPLIER_API_TOKEN: SUPPLIER_TOKEN,
    BOT_TELE_EXPECTED_DB: "localhost:5432/shop",
    ...overrides,
  };
}

afterEach(() => resetConfigCache());

describe("production preflight", () => {
  it("passes required production config and redacts secrets", async () => {
    const result = await runProductionPreflight(productionEnv());
    expect(result.ok, result.issues.join("; ")).toBe(true);
    expect(result.fingerprint.nodeEnv).toBe("production");
    expect(result.fingerprint.appBaseUrl).toBe("https://api.tier20.click");
    expect(result.fingerprint.httpHost).toBe("127.0.0.1");
    expect(result.fingerprint.httpPort).toBe("3000");
    expect(result.fingerprint.databaseTarget).toBe("localhost:5432/shop");
    expect(result.fingerprint.database).toEqual({
      host: "localhost",
      port: "5432",
      database: "shop",
      user: "shop",
    });
    expect(result.fingerprint.redis).toEqual({ host: "127.0.0.1", port: "6379" });
    expect(result.fingerprint.redisStatus).toBe("CONFIGURED");
    expect(result.fingerprint.telegramToken).toBe("CONFIGURED");
    expect(result.fingerprint.telegramWebhook).toBe("CONFIGURED");
    expect(result.fingerprint.merchantMatch).toBe("YES");
    expect(result.fingerprint.vietQrBankAlias).toBe("MB");
    expect(result.fingerprint.vaultDriver).toBe("external");
    expect(result.fingerprint.vaultEndpointHost).toBe("127.0.0.1");
    expect(result.fingerprint.supplierToken).toBe("CONFIGURED");
    expect(JSON.stringify(result)).not.toContain(DB_PASS);
    expect(JSON.stringify(result)).not.toContain("AA-SECRET-BOT-TOKEN");
    expect(JSON.stringify(result)).not.toContain(SUPPLIER_TOKEN);
    expect(loadConfig(productionEnv()).VIETQR_ACCOUNT_NAME).toBe("NGUYEN VAN TEST");
  });

  it("fails closed when required production config is missing", async () => {
    const result = await runProductionPreflight(productionEnv({ TELEGRAM_BOT_TOKEN: "" }));
    expect(result.ok).toBe(false);
    expect(result.issues.join("; ")).toMatch(/TELEGRAM_BOT_TOKEN/);
    expect(result.fingerprint.telegramToken).toBe("MISSING");
    expect(JSON.stringify(result)).not.toContain(DB_PASS);
  });

  it("fails closed when REDIS_URL is missing or unparseable", async () => {
    const missing = await runProductionPreflight(productionEnv({ REDIS_URL: "" }));
    expect(missing.ok).toBe(false);
    expect(missing.issues.join("; ")).toMatch(/REDIS_URL/);
    expect(missing.fingerprint.redis).toBeNull();
    expect(missing.fingerprint.redisStatus).toBe("MISSING");
    expect(JSON.stringify(missing)).not.toContain(DB_PASS);

    const invalid = await runProductionPreflight(
      productionEnv({ REDIS_URL: "http://127.0.0.1:6379" }),
    );
    expect(invalid.ok).toBe(false);
    expect(invalid.issues.join("; ")).toMatch(/REDIS_URL/);
    expect(invalid.fingerprint.redis).toBeNull();
    expect(invalid.fingerprint.redisStatus).toBe("MISSING");
    expect(JSON.stringify(invalid)).not.toContain(DB_PASS);
  });

  it("reports merchant mismatch without account numbers", async () => {
    const merchant = "1111111111";
    const vietqr = "2222222222";
    const result = await runProductionPreflight(
      productionEnv({
        SEPAY_MERCHANT_ACCOUNT_ID: merchant,
        VIETQR_ACCOUNT_NUMBER: vietqr,
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.fingerprint.merchantMatch).toBe("NO");
    const blob = `${result.issues.join("; ")}\n${JSON.stringify(result)}`;
    expect(blob).toMatch(
      /SEPAY_MERCHANT_ACCOUNT_ID must match VIETQR_ACCOUNT_NUMBER|SEPAY merchant does not match/,
    );
    expect(blob).not.toContain(merchant);
    expect(blob).not.toContain(vietqr);
  });

  it("distinguishes production and local database fingerprints", async () => {
    const result = await runProductionPreflight(
      productionEnv({
        DATABASE_URL: `postgres://shop:${DB_PASS}@localhost:5433/shop`,
        BOT_TELE_EXPECTED_DB: "localhost:5432/shop",
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.fingerprint.databaseTarget).toBe("localhost:5433/shop");
    expect(result.issues.join("; ")).toContain("database target mismatch");
    expect(result.issues.join("; ")).toContain("localhost:5432/shop");
    expect(result.issues.join("; ")).toContain("localhost:5433/shop");
    expect(JSON.stringify(result)).not.toContain(DB_PASS);
  });
});
