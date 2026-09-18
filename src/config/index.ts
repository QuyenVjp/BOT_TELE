import { envSchema, SECRET_ENV_KEYS, type Env, type SecretEnvKey } from "./env.js";

/**
 * Validated configuration loader.
 *
 * - Parses and coerces `process.env` through the Zod schema (fail-closed).
 * - In production, forbids memory/fixture drivers that are only safe for local
 *   development and tests, so missing production values cannot silently ship.
 * - Never throws with secret values in the message; only key names are surfaced.
 *
 * Phase 2 (T011) hardens diagnostics further; the schema itself lives in env.ts.
 */

export type AppConfig = Env;

export class ConfigError extends Error {
  readonly issues: string[];
  constructor(issues: string[]) {
    super(`Invalid configuration: ${issues.join("; ")}`);
    this.name = "ConfigError";
    this.issues = issues;
  }
}

let cached: AppConfig | undefined;

export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  if (cached) return cached;

  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    // Only expose field paths, never the offending values.
    const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
    throw new ConfigError(issues);
  }

  const config = parsed.data;
  const productionIssues = productionHardeningIssues(config, source);
  if (productionIssues.length > 0) {
    throw new ConfigError(productionIssues);
  }

  cached = config;
  return config;
}

/** Test/reset hook so config caching does not bleed across test files. */
export function resetConfigCache(): void {
  cached = undefined;
}

/**
 * Production must fail closed when local-only stand-ins are still configured.
 * These are launch gates, not local blockers (see launch-gates.md).
 */
function productionHardeningIssues(config: AppConfig, source: NodeJS.ProcessEnv): string[] {
  if (config.NODE_ENV !== "production") return [];
  const issues: string[] = [];
  if (!source.ADMIN_STEP_UP_MODE?.trim()) {
    issues.push("ADMIN_STEP_UP_MODE must be explicitly configured in production");
  }
  if (config.TELEGRAM_API_ENVIRONMENT === "test") {
    issues.push("TELEGRAM_API_ENVIRONMENT must be prod in production");
  }
  const sepayUrl = new URL(config.SEPAY_API_BASE_URL);
  if (
    sepayUrl.protocol !== "https:" ||
    !["userapi.sepay.vn", "userapi-sandbox.sepay.vn"].includes(sepayUrl.hostname)
  ) {
    issues.push("SEPAY_API_BASE_URL must use an official HTTPS SePay host");
  } else if (sepayUrl.hostname === "userapi-sandbox.sepay.vn") {
    issues.push("SEPAY_API_BASE_URL must use the Live SePay host in production");
  }

  if (config.VAULT_DRIVER === "memory") {
    issues.push('VAULT_DRIVER must not be "memory" in production');
  }
  if (
    config.VAULT_DRIVER === "external" &&
    (config.VAULT_EGRESS_HOST_ALLOWLIST.length === 0 ||
      config.VAULT_EGRESS_PORT_ALLOWLIST.length === 0 ||
      config.VAULT_EGRESS_CIDR_ALLOWLIST.length === 0)
  ) {
    issues.push(
      "VAULT_EGRESS_HOST_ALLOWLIST, VAULT_EGRESS_PORT_ALLOWLIST, and VAULT_EGRESS_CIDR_ALLOWLIST must be explicit in production",
    );
  }
  if (config.SUPPLIER_DRIVER === "fixture") {
    issues.push('SUPPLIER_DRIVER must not be "fixture" in production');
  }
  if (config.ADMIN_TELEGRAM_USER_ID === 0) {
    issues.push("ADMIN_TELEGRAM_USER_ID must be a real numeric Telegram id in production");
  }
  if (config.TELEGRAM_BOT_TOKEN === "000000000:TEST_PLACEHOLDER_TOKEN_DO_NOT_USE") {
    issues.push("TELEGRAM_BOT_TOKEN must not use the documented placeholder in production");
  }
  if (config.TELEGRAM_WEBHOOK_SECRET === "local-dev-webhook-secret-change-me") {
    issues.push("TELEGRAM_WEBHOOK_SECRET must not use the documented placeholder in production");
  }
  if (!config.APP_BASE_URL.startsWith("https://")) {
    issues.push("APP_BASE_URL must be https in production");
  }
  if (config.SEPAY_IP_ALLOWLIST.length === 0) {
    issues.push("SEPAY_IP_ALLOWLIST must not be empty in production");
  }
  if (config.SEPAY_API_TOKEN.length === 0) {
    issues.push("SEPAY_API_TOKEN must not be empty in production");
  }
  if (config.SEPAY_WEBHOOK_HMAC_SECRET === "local-dev-sepay-hmac-secret-change-me") {
    issues.push("SEPAY_WEBHOOK_HMAC_SECRET must not use the documented placeholder in production");
  }
  for (const key of ["TELEGRAM_BOT_TOKEN", "TELEGRAM_WEBHOOK_SECRET"] as const) {
    if (config.SEPAY_WEBHOOK_HMAC_SECRET === config[key]) {
      issues.push(`SEPAY_WEBHOOK_HMAC_SECRET must not reuse ${key}`);
    }
  }
  if (config.BUY_NOW_CALLBACK_HMAC_KEY === "local-dev-buy-now-callback-key-change-me-32bytes") {
    issues.push("BUY_NOW_CALLBACK_HMAC_KEY must not use the documented placeholder in production");
  }
  if (config.DELIVERY_SESSION_HMAC_KEY === "local-dev-delivery-session-key-change-me-32bytes") {
    issues.push("DELIVERY_SESSION_HMAC_KEY must not use the documented placeholder in production");
  }
  const previousDeliveryFields = [
    config.DELIVERY_SESSION_PREVIOUS_HMAC_KEY.length > 0,
    config.DELIVERY_SESSION_PREVIOUS_KEY_VERSION !== undefined,
    config.DELIVERY_SESSION_PREVIOUS_KEY_GRACE_UNTIL.length > 0,
  ];
  if (previousDeliveryFields.some(Boolean) && !previousDeliveryFields.every(Boolean)) {
    issues.push(
      "DELIVERY_SESSION_PREVIOUS_HMAC_KEY, DELIVERY_SESSION_PREVIOUS_KEY_VERSION, and DELIVERY_SESSION_PREVIOUS_KEY_GRACE_UNTIL must be configured together",
    );
  }
  if (
    config.DELIVERY_SESSION_PREVIOUS_KEY_VERSION !== undefined &&
    config.DELIVERY_SESSION_PREVIOUS_KEY_VERSION === config.DELIVERY_SESSION_KEY_VERSION
  ) {
    issues.push("DELIVERY_SESSION_PREVIOUS_KEY_VERSION must differ from current key version");
  }
  const reusedCallbackKey = [
    "TELEGRAM_BOT_TOKEN",
    "TELEGRAM_WEBHOOK_SECRET",
    "SEPAY_WEBHOOK_HMAC_SECRET",
  ] as const satisfies readonly (keyof AppConfig)[];
  for (const key of reusedCallbackKey) {
    if (config.BUY_NOW_CALLBACK_HMAC_KEY === config[key]) {
      issues.push(`BUY_NOW_CALLBACK_HMAC_KEY must not reuse ${key}`);
    }
  }
  const reusedDeliveryKey = [
    "TELEGRAM_BOT_TOKEN",
    "TELEGRAM_WEBHOOK_SECRET",
    "BUY_NOW_CALLBACK_HMAC_KEY",
    "SEPAY_WEBHOOK_HMAC_SECRET",
    "SEPAY_API_TOKEN",
    "VAULT_TOKEN",
    "SUPPLIER_API_TOKEN",
  ] as const satisfies readonly (keyof AppConfig)[];
  for (const key of reusedDeliveryKey) {
    if (config.DELIVERY_SESSION_HMAC_KEY === config[key]) {
      issues.push(`DELIVERY_SESSION_HMAC_KEY must not reuse ${key}`);
    }
  }
  if (
    config.DELIVERY_SESSION_PREVIOUS_HMAC_KEY.length > 0 &&
    config.DELIVERY_SESSION_PREVIOUS_HMAC_KEY === config.DELIVERY_SESSION_HMAC_KEY
  ) {
    issues.push("DELIVERY_SESSION_PREVIOUS_HMAC_KEY must not reuse DELIVERY_SESSION_HMAC_KEY");
  }
  if (config.DELIVERY_SESSION_PREVIOUS_HMAC_KEY.length > 0) {
    for (const key of reusedDeliveryKey) {
      if (config.DELIVERY_SESSION_PREVIOUS_HMAC_KEY === config[key]) {
        issues.push(`DELIVERY_SESSION_PREVIOUS_HMAC_KEY must not reuse ${key}`);
      }
    }
  }
  const normalizedMerchant = config.SEPAY_MERCHANT_ACCOUNT_ID.trim();
  const normalizedVietQr = config.VIETQR_ACCOUNT_NUMBER.trim();
  if (normalizedMerchant !== normalizedVietQr) {
    issues.push("SEPAY_MERCHANT_ACCOUNT_ID must match VIETQR_ACCOUNT_NUMBER in production");
  }
  return issues;
}

/**
 * Redacted view of the resolved config, safe to log at startup.
 * Secret keys are replaced with a fixed marker.
 */
export function redactedConfig(config: AppConfig): Record<string, unknown> {
  const secretSet = new Set<string>(SECRET_ENV_KEYS as readonly string[]);
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config)) {
    out[key] = secretSet.has(key) ? "«redacted»" : value;
  }
  // Exhaustively mask every known secret key, even if it was optional/absent in
  // the parsed config. A secret must never be missing from the redacted view
  // (which would happen for unset optional secrets) nor leak if the shape drifts.
  for (const key of SECRET_ENV_KEYS) {
    out[key] = "«redacted»";
  }
  return out;
}

export { SECRET_ENV_KEYS };
export type { SecretEnvKey };
