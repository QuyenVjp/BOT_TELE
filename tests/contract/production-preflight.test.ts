import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig, resetConfigCache } from "../../src/config/index.js";
import { runProductionPreflight } from "../../src/scripts/production-preflight.js";

const preflightTestState = vi.hoisted(() => ({
  factor: "valid" as "valid" | "missing" | "dangling" | "plaintext",
  seed: "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP",
}));

vi.mock("pg", () => ({
  default: {
    Pool: class {
      async query(sql: string): Promise<{ rows: Record<string, unknown>[] }> {
        if (sql.includes("admin_step_up_secret")) {
          if (preflightTestState.factor === "missing") return { rows: [] };
          return {
            rows: [
              {
                vault_ref:
                  preflightTestState.factor === "plaintext"
                    ? preflightTestState.seed
                    : "vault:admin-step-up",
                created_at: "2026-01-01T00:00:00.000Z",
                rotated_at: null,
              },
            ],
          };
        }
        if (sql.includes("store_control")) return { rows: [{ status: "CLOSED" }] };
        // Fixture only: unit tests call preflight with probeLiveDependencies
        // off, so this row is not compared to source migrations. It is not the
        // current production head (071). Stale-head detection is the live
        // preflight path, not these config/MFA unit cases.
        if (sql.includes("schema_migrations")) {
          return { rows: [{ filename: "069_step_up_authorization_binding.sql", count: "68" }] };
        }
        if (sql.includes("product_variant")) return { rows: [{ required: false }] };
        return { rows: [] };
      }

      async end(): Promise<void> {}
    },
  },
}));

vi.mock("../../src/infrastructure/vault/adapter.js", () => ({
  createVault: () => ({
    async reveal(): Promise<string> {
      if (preflightTestState.factor === "dangling") throw new Error("missing vault ref");
      return preflightTestState.seed;
    },
    async health(): Promise<void> {},
    async write(): Promise<string> {
      return "vault:test";
    },
    async delete(): Promise<void> {},
  }),
}));

const DB_PASS = ["shop", "local", "only"].join("-");

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
    // The fixture exercises the required mode; disabled mode is tested separately
    // and deliberately skips only the factor probe.
    ADMIN_STEP_UP_MODE: "required",
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
    BOT_TELE_EXPECTED_DB: "localhost:5432/shop",
    ...overrides,
  };
}

afterEach(() => {
  preflightTestState.factor = "valid";
  resetConfigCache();
});

describe("production preflight", () => {
  it("fails closed when required mode has no usable admin factor", async () => {
    preflightTestState.factor = "missing";
    const result = await runProductionPreflight(productionEnv());

    expect(result.ok).toBe(false);
    expect(result.issues.join("; ")).toContain("admin step-up factor");
  });

  it("fails closed when the required-mode Vault reference is dangling", async () => {
    preflightTestState.factor = "dangling";
    const result = await runProductionPreflight(productionEnv());

    expect(result.ok).toBe(false);
    expect(result.issues.join("; ")).toContain("admin step-up factor");
  });

  it("rejects plaintext factor material in required mode", async () => {
    preflightTestState.factor = "plaintext";
    const result = await runProductionPreflight(productionEnv());

    expect(result.ok).toBe(false);
    expect(result.issues.join("; ")).toContain("admin step-up factor");
    expect(JSON.stringify(result)).not.toContain(preflightTestState.seed);
  });

  it("does not probe a factor when production mode is disabled", async () => {
    preflightTestState.factor = "missing";
    const result = await runProductionPreflight(productionEnv({ ADMIN_STEP_UP_MODE: "disabled" }));

    expect(result.ok, result.issues.join("; ")).toBe(true);
    expect(result.fingerprint.adminStepUpMode).toBe("disabled");
    expect(JSON.stringify(result)).not.toContain(preflightTestState.seed);
  });

  it("fails closed when production selects the memory vault", async () => {
    const result = await runProductionPreflight(
      productionEnv({ VAULT_DRIVER: "memory", VAULT_ENDPOINT: "", VAULT_TOKEN: "" }),
    );

    expect(result.ok).toBe(false);
    expect(result.issues.join("; ")).toMatch(/VAULT_DRIVER/);
  });

  it("accepts a current factor whose secret resolves through the vault", async () => {
    const result = await runProductionPreflight(productionEnv());

    expect(result.ok, result.issues.join("; ")).toBe(true);
  });

  it("does not add a production factor requirement outside production", async () => {
    preflightTestState.factor = "missing";
    const result = await runProductionPreflight(
      productionEnv({
        NODE_ENV: "test",
        ADMIN_STEP_UP_MODE: "disabled",
        VAULT_DRIVER: "memory",
        VAULT_ENDPOINT: "",
        VAULT_TOKEN: "",
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.issues.join("; ")).toContain("NODE_ENV must be production");
    expect(result.issues.join("; ")).not.toContain("admin step-up factor");
  });

  it("passes required production config and redacts secrets", async () => {
    const result = await runProductionPreflight(productionEnv());
    expect(result.ok, result.issues.join("; ")).toBe(true);
    expect(result.fingerprint.adminStepUpMode).toBe("required");
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
    expect(JSON.stringify(result)).not.toContain(DB_PASS);
    expect(JSON.stringify(result)).not.toContain("AA-SECRET-BOT-TOKEN");
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

  it("rejects Telegram test mode and SePay sandbox in production", async () => {
    const result = await runProductionPreflight(
      productionEnv({
        TELEGRAM_API_ENVIRONMENT: "test",
        SEPAY_API_BASE_URL: "https://userapi-sandbox.sepay.vn/v2",
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.issues.join("; ")).toMatch(/TELEGRAM_API_ENVIRONMENT/);
    expect(result.issues.join("; ")).toMatch(/Live SePay host/);
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
