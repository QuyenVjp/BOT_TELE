import { pathToFileURL } from "node:url";
import { lookup } from "node:dns/promises";
import { createConnection, type Socket } from "node:net";
import { connect as tlsConnect } from "node:tls";
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
import { listMigrationFiles } from "../infrastructure/db/migrate.js";
import { createVault } from "../infrastructure/vault/adapter.js";
export interface ProductionPreflightOptions {
  /** Probe live dependencies; disabled for pure config/unit tests. */
  probeLiveDependencies?: boolean;
}

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
    databaseHealth: "REACHABLE" | "UNREACHABLE" | "NOT_CHECKED";
    redis: { host: string; port: string } | null;
    redisStatus: "CONFIGURED" | "MISSING";
    redisHealth: "REACHABLE" | "UNREACHABLE" | "NOT_CHECKED";
    telegramEnvironment: "prod" | "test" | null;
    telegramToken: "CONFIGURED" | "MISSING";
    telegramWebhook: "CONFIGURED" | "MISSING";
    telegramApi: "REACHABLE" | "UNREACHABLE" | "NOT_CHECKED";
    sepayBaseHost: string | null;
    sepayApi: "REACHABLE" | "UNREACHABLE" | "NOT_CHECKED";
    merchantMatch: "YES" | "NO";
    vietQrBankAlias: string | null;
    vaultDriver: string | null;
    vaultEndpointHost: string | null;
    vaultHealth: "REACHABLE" | "UNREACHABLE" | "NOT_CHECKED";
    supplierBaseHost: string | null;
    supplierToken: "CONFIGURED" | "MISSING";
    supplierDns: "RESOLVED" | "UNRESOLVED" | "NOT_CHECKED";
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
    databaseHealth: "NOT_CHECKED",
    redis: null,
    redisStatus: "MISSING",
    redisHealth: "NOT_CHECKED",
    telegramEnvironment: null,
    telegramToken: "MISSING",
    telegramWebhook: "MISSING",
    telegramApi: "NOT_CHECKED",
    sepayBaseHost: null,
    sepayApi: "NOT_CHECKED",
    merchantMatch: "NO",
    vietQrBankAlias: null,
    vaultDriver: null,
    vaultEndpointHost: null,
    vaultHealth: "NOT_CHECKED",
    supplierBaseHost: null,
    supplierToken: "MISSING",
    supplierDns: "NOT_CHECKED",
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
  fingerprint.telegramEnvironment =
    env.TELEGRAM_API_ENVIRONMENT?.trim() === "test" ? "test" : "prod";
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
function redisFrame(parts: readonly string[]): string {
  return `*${parts.length}\r\n${parts
    .map((part) => `$${Buffer.byteLength(part, "utf8")}\r\n${part}\r\n`)
    .join("")}`;
}

async function probeRedis(url: string): Promise<boolean> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "redis:" && parsed.protocol !== "rediss:") return false;
  const password = parsed.password ? decodeURIComponent(parsed.password) : null;
  const username = parsed.username ? decodeURIComponent(parsed.username) : null;
  const commands = password
    ? [username ? ["AUTH", username, password] : ["AUTH", password], ["PING"]]
    : [["PING"]];

  return new Promise((resolve) => {
    let settled = false;
    let response = "";
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };
    const onData = (chunk: Buffer) => {
      response += chunk.toString("utf8");
      if (response.includes("+PONG")) finish(true);
      else if (response.startsWith("-")) finish(false);
    };
    const socket: Socket =
      parsed.protocol === "rediss:"
        ? tlsConnect({
            host: parsed.hostname,
            port: Number(parsed.port || "6379"),
            rejectUnauthorized: true,
          })
        : createConnection({
            host: parsed.hostname,
            port: Number(parsed.port || "6379"),
          });
    socket.setTimeout(2_000);
    socket.once("error", () => finish(false));
    socket.once("timeout", () => finish(false));
    socket.on("data", onData);
    const writeCommands = () => socket.write(commands.map(redisFrame).join(""));
    socket.once(parsed.protocol === "rediss:" ? "secureConnect" : "connect", writeCommands);
  });
}

async function probeHttp(url: string, headers?: Record<string, string>): Promise<boolean> {
  try {
    const init: RequestInit = {
      redirect: "error",
      signal: AbortSignal.timeout(5_000),
    };
    if (headers) init.headers = headers;
    const response = await fetch(url, init);
    return response.ok;
  } catch {
    return false;
  }
}

async function probeSupplierDns(host: string | null): Promise<boolean> {
  if (!host) return false;
  try {
    await lookup(host);
    return true;
  } catch {
    return false;
  }
}

async function probeVaultHealth(config: ReturnType<typeof loadConfig>): Promise<boolean> {
  if (config.VAULT_DRIVER !== "external") return true;
  try {
    const vault = createVault({
      driver: config.VAULT_DRIVER,
      endpoint: config.VAULT_ENDPOINT,
      token: config.VAULT_TOKEN,
      namespace: config.VAULT_NAMESPACE,
      timeoutMs: config.VAULT_TIMEOUT_MS,
      maxAttempts: 1,
      egressPolicy: {
        allowedHosts: config.VAULT_EGRESS_HOST_ALLOWLIST,
        allowedPorts: config.VAULT_EGRESS_PORT_ALLOWLIST,
        allowedCidrs: config.VAULT_EGRESS_CIDR_ALLOWLIST,
      },
    });
    await vault.health?.();
    return true;
  } catch {
    return false;
  }
}

export async function runProductionPreflight(
  env: NodeJS.ProcessEnv,
  options: ProductionPreflightOptions = {},
): Promise<ProductionPreflightResult> {
  const fingerprint = emptyFingerprint();
  fillSafeFingerprint(env, fingerprint);
  const issues: string[] = [];
  let config: ReturnType<typeof loadConfig> | undefined;
  let supplierRequired = false;
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
  if (fingerprint.telegramEnvironment === "test") {
    issues.push("TELEGRAM_API_ENVIRONMENT must be prod in production");
  }
  if (fingerprint.telegramToken === "MISSING") issues.push("TELEGRAM_BOT_TOKEN is missing");
  if (fingerprint.telegramWebhook === "MISSING") issues.push("TELEGRAM_WEBHOOK_SECRET is missing");
  if (fingerprint.merchantMatch === "NO") {
    issues.push("SEPAY merchant does not match VietQR account");
  }
  if (fingerprint.vaultDriver === "external" && !fingerprint.vaultEndpointHost) {
    issues.push("VAULT_ENDPOINT host is required for external vault");
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
  if (options.probeLiveDependencies) {
    if (fingerprint.redis && !(await probeRedis(env.REDIS_URL ?? ""))) {
      fingerprint.redisHealth = "UNREACHABLE";
      issues.push("REDIS_URL connectivity probe failed");
    } else if (fingerprint.redis) {
      fingerprint.redisHealth = "REACHABLE";
    }

    if (fingerprint.telegramToken === "CONFIGURED") {
      const telegramApiRoot = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}`;
      const telegramApiUrl = `${telegramApiRoot}/${fingerprint.telegramEnvironment === "test" ? "test/" : ""}getMe`;
      const telegramOk = await probeHttp(telegramApiUrl);
      fingerprint.telegramApi = telegramOk ? "REACHABLE" : "UNREACHABLE";
      if (!telegramOk) issues.push("Telegram Bot API probe failed");
    }

    if (fingerprint.sepayBaseHost && secretStatus(env.SEPAY_API_TOKEN) === "CONFIGURED") {
      try {
        const endpoint = new URL(env.SEPAY_API_BASE_URL ?? "");
        endpoint.pathname = `${endpoint.pathname.replace(/\/$/u, "")}/transactions`;
        endpoint.search = "?per_page=1&page=1";
        const sepayOk = await probeHttp(endpoint.toString(), {
          authorization: `Bearer ${env.SEPAY_API_TOKEN}`,
          accept: "application/json",
        });
        fingerprint.sepayApi = sepayOk ? "REACHABLE" : "UNREACHABLE";
        if (!sepayOk) issues.push("SePay API probe failed");
      } catch {
        fingerprint.sepayApi = "UNREACHABLE";
        issues.push("SePay API URL is invalid");
      }
    } else {
      fingerprint.sepayApi = "UNREACHABLE";
      issues.push("SePay API token or base URL is missing");
    }

    if (config) {
      const vaultOk = await probeVaultHealth(config);
      fingerprint.vaultHealth = vaultOk ? "REACHABLE" : "UNREACHABLE";
      if (!vaultOk) issues.push("external vault health probe failed");
    }
  }

  if (fingerprint.database && env.DATABASE_URL) {
    const pool = new pg.Pool({
      connectionString: env.DATABASE_URL,
      max: 1,
      connectionTimeoutMillis: 2_000,
    });
    try {
      const store = await pool.query<{ status: string }>(
        "select status from store_control where id = 'main' limit 1",
      );
      fingerprint.storeStatus = store.rows[0]?.status ?? null;
      if (options.probeLiveDependencies) {
        fingerprint.databaseHealth = "REACHABLE";
        if (fingerprint.storeStatus !== "CLOSED") {
          issues.push("store_control must be CLOSED during production commissioning");
        }
      }

      const head = await pool.query<{ filename: string; count: string }>(
        "select max(filename) as filename, count(*)::text as count from schema_migrations",
      );
      const row = head.rows[0];
      if (row?.filename) {
        fingerprint.migrationHead = { filename: row.filename, count: Number(row.count) };
      }
      if (options.probeLiveDependencies) {
        const migrationFiles = await listMigrationFiles();
        const expectedHead = migrationFiles[migrationFiles.length - 1];
        if (
          !row?.filename ||
          Number(row.count) !== migrationFiles.length ||
          row.filename !== expectedHead
        ) {
          issues.push("database migration head/count does not match source migrations");
        }
      }
      const supplierRows = await pool.query<{ required: boolean }>(`
        select exists (
          select 1
          from product_variant v
          join product p on p.id = v.product_id
          where v.fulfillment_type = 'SUPPLIER_API'
            and v.is_active
            and p.is_active
            and not p.is_archived
            and not p.is_test
        ) as required
      `);
      supplierRequired = supplierRows.rows[0]?.required === true;
    } catch {
      fingerprint.databaseHealth = options.probeLiveDependencies ? "UNREACHABLE" : "NOT_CHECKED";
      if (options.probeLiveDependencies) issues.push("database connectivity probe failed");
    } finally {
      await pool.end();
    }
  }
  if (options.probeLiveDependencies && supplierRequired) {
    if (
      (env.SUPPLIER_DRIVER ?? "").trim() === "http" &&
      (!fingerprint.supplierBaseHost || fingerprint.supplierToken === "MISSING")
    ) {
      issues.push("SUPPLIER_DRIVER=http requires base URL and token");
    }
    if ((env.SUPPLIER_DRIVER ?? "").trim() === "http") {
      const supplierOk = await probeSupplierDns(fingerprint.supplierBaseHost);
      fingerprint.supplierDns = supplierOk ? "RESOLVED" : "UNRESOLVED";
      if (!supplierOk) issues.push("supplier API host DNS probe failed");
    }
  }

  return { ok: issues.length === 0, issues, fingerprint };
}

async function cliMain(): Promise<void> {
  const result = await runProductionPreflight(process.env, { probeLiveDependencies: true });
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
