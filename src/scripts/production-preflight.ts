import { pathToFileURL } from "node:url";
import pg from "pg";
import { ConfigError, loadConfig } from "../config/index.js";
import {
  formatDatabaseFingerprint,
  parseDatabaseUrl,
  parseEndpointHost,
  parseRedisUrl,
  secretStatus,
  type DatabaseFingerprint,
} from "../config/safe-fingerprint.js";

export interface ProductionPreflightResult {
  ok: boolean;
  issues: string[];
  fingerprint: {
    nodeEnv: string | null;
    appBaseUrl: string | null;
    httpHost: string | null;
    httpPort: string | null;
    database: DatabaseFingerprint | null;
    databaseTarget: string | null;
    redis: { host: string; port: string } | null;
    redisStatus: "CONFIGURED" | "MISSING";
    telegramToken: "CONFIGURED" | "MISSING";
    telegramWebhook: "CONFIGURED" | "MISSING";
    sepayBaseHost: string | null;
    merchantMatch: "YES" | "NO";
    vietQrBankAlias: string | null;
    vaultDriver: string | null;
    vaultEndpointHost: string | null;
    supplierBaseHost: string | null;
    supplierToken: "CONFIGURED" | "MISSING";
    storeStatus: string | null;
    migrationHead: { filename: string; count: number } | null;
  };
}

function emptyFingerprint(): ProductionPreflightResult["fingerprint"] {
  return {
    nodeEnv: null,
    appBaseUrl: null,
    httpHost: null,
    httpPort: null,
    database: null,
    databaseTarget: null,
    redis: null,
    redisStatus: "MISSING",
    telegramToken: "MISSING",
    telegramWebhook: "MISSING",
    sepayBaseHost: null,
    merchantMatch: "NO",
    vietQrBankAlias: null,
    vaultDriver: null,
    vaultEndpointHost: null,
    supplierBaseHost: null,
    supplierToken: "MISSING",
    storeStatus: null,
    migrationHead: null,
  };
}

function fillSafeFingerprint(
  env: NodeJS.ProcessEnv,
  fingerprint: ProductionPreflightResult["fingerprint"],
): void {
  fingerprint.nodeEnv = env.NODE_ENV?.trim() || null;
  fingerprint.appBaseUrl = env.APP_BASE_URL?.trim() || null;
  fingerprint.httpHost = env.HTTP_HOST?.trim() || null;
  fingerprint.httpPort = env.HTTP_PORT?.trim() || null;
  fingerprint.telegramToken = secretStatus(env.TELEGRAM_BOT_TOKEN);
  fingerprint.telegramWebhook = secretStatus(env.TELEGRAM_WEBHOOK_SECRET);
  fingerprint.sepayBaseHost = parseEndpointHost(env.SEPAY_API_BASE_URL ?? "");
  fingerprint.vietQrBankAlias = env.VIETQR_BANK_ALIAS?.trim() || null;
  fingerprint.vaultDriver = env.VAULT_DRIVER?.trim() || null;
  fingerprint.vaultEndpointHost = parseEndpointHost(env.VAULT_ENDPOINT ?? "");
  fingerprint.supplierBaseHost = parseEndpointHost(env.SUPPLIER_API_BASE_URL ?? "");
  fingerprint.supplierToken = secretStatus(env.SUPPLIER_API_TOKEN);
  fingerprint.redis = parseRedisUrl(env.REDIS_URL ?? "");
  fingerprint.redisStatus = fingerprint.redis ? "CONFIGURED" : "MISSING";
  const merchant = env.SEPAY_MERCHANT_ACCOUNT_ID?.trim() ?? "";
  const vietQr = env.VIETQR_ACCOUNT_NUMBER?.trim() ?? "";
  fingerprint.merchantMatch = merchant.length > 0 && merchant === vietQr ? "YES" : "NO";
  try {
    if (env.DATABASE_URL?.trim()) {
      fingerprint.database = parseDatabaseUrl(env.DATABASE_URL);
      fingerprint.databaseTarget = formatDatabaseFingerprint(fingerprint.database);
    }
  } catch {
    fingerprint.database = null;
    fingerprint.databaseTarget = null;
  }
}

export async function runProductionPreflight(
  env: NodeJS.ProcessEnv,
): Promise<ProductionPreflightResult> {
  const fingerprint = emptyFingerprint();
  fillSafeFingerprint(env, fingerprint);
  const issues: string[] = [];
  let config: ReturnType<typeof loadConfig> | undefined;
  try {
    config = loadConfig(env);
  } catch (error) {
    if (error instanceof ConfigError) issues.push(...error.issues);
    else issues.push("configuration failed to load");
  }

  if (fingerprint.nodeEnv !== "production") issues.push("NODE_ENV must be production");
  if (fingerprint.appBaseUrl !== "https://api.tier20.click") {
    issues.push("APP_BASE_URL must be https://api.tier20.click");
  }
  if (fingerprint.httpHost !== "127.0.0.1") issues.push("HTTP_HOST must be 127.0.0.1");
  if (!env.HTTP_PORT?.trim()) issues.push("HTTP_PORT must be set");
  if (!fingerprint.database) issues.push("DATABASE_URL fingerprint is invalid");
  if (!fingerprint.redis) issues.push("REDIS_URL is missing or invalid");
  if (fingerprint.telegramToken === "MISSING") issues.push("TELEGRAM_BOT_TOKEN is missing");
  if (fingerprint.telegramWebhook === "MISSING") issues.push("TELEGRAM_WEBHOOK_SECRET is missing");
  if (fingerprint.merchantMatch === "NO") {
    issues.push("SEPAY merchant does not match VietQR account");
  }
  if (fingerprint.vaultDriver === "external" && !fingerprint.vaultEndpointHost) {
    issues.push("VAULT_ENDPOINT host is required for external vault");
  }
  if (
    (env.SUPPLIER_DRIVER ?? "").trim() === "http" &&
    (!fingerprint.supplierBaseHost || fingerprint.supplierToken === "MISSING")
  ) {
    issues.push("SUPPLIER_DRIVER=http requires base URL and token");
  }
  const expected = env.BOT_TELE_EXPECTED_DB?.trim();
  if (expected && fingerprint.databaseTarget && expected !== fingerprint.databaseTarget) {
    issues.push(
      `database target mismatch: expected ${expected}, actual ${fingerprint.databaseTarget}`,
    );
  }

  if (config) {
    fingerprint.vietQrBankAlias = config.VIETQR_BANK_ALIAS;
    fingerprint.vaultDriver = config.VAULT_DRIVER;
    fingerprint.httpHost = config.HTTP_HOST;
    fingerprint.httpPort = String(config.HTTP_PORT);
    fingerprint.nodeEnv = config.NODE_ENV;
    fingerprint.appBaseUrl = config.APP_BASE_URL;
  }

  if (fingerprint.database && env.DATABASE_URL) {
    const pool = new pg.Pool({
      connectionString: env.DATABASE_URL,
      max: 1,
      connectionTimeoutMillis: 2000,
    });
    try {
      const store = await pool.query<{ status: string }>(
        "select status from store_control where id = 'main' limit 1",
      );
      fingerprint.storeStatus = store.rows[0]?.status ?? null;
      const head = await pool.query<{ filename: string; count: string }>(
        "select max(filename) as filename, count(*)::text as count from schema_migrations",
      );
      const row = head.rows[0];
      if (row?.filename) {
        fingerprint.migrationHead = { filename: row.filename, count: Number(row.count) };
      }
    } catch {
      // Database evidence is best-effort; configuration safety remains authoritative.
    } finally {
      await pool.end();
    }
  }

  return { ok: issues.length === 0, issues, fingerprint };
}

async function cliMain(): Promise<void> {
  const result = await runProductionPreflight(process.env);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (!result.ok) process.exitCode = 1;
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  void cliMain().catch(() => {
    process.stderr.write("production preflight failed\n");
    process.exitCode = 1;
  });
}
