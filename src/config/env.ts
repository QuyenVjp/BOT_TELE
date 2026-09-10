import { z } from "zod";

/**
 * Environment schema. No secrets live here — only shape, coercion, and
 * fail-closed rules. `loadConfig` (src/config/index.ts) applies production
 * hardening on top of this schema.
 */

const csvList = z
  .string()
  .optional()
  .transform((v) =>
    (v ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  );

const csvPortList = z
  .string()
  .optional()
  .transform((value, context): number[] => {
    const entries = (value ?? "")
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
    const ports = entries.map(Number);
    if (ports.some((port) => !Number.isInteger(port) || port < 1 || port > 65_535)) {
      context.addIssue({ code: "custom", message: "must be a comma-separated list of TCP ports" });
      return [];
    }
    return ports;
  });

export const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  APP_BASE_URL: z.string().url().default("http://localhost:3000"),

  HTTP_HOST: z.string().default("0.0.0.0"),
  HTTP_PORT: z.coerce.number().int().positive().max(65535).default(3000),
  HTTP_BODY_LIMIT_BYTES: z.coerce.number().int().positive().default(65536),

  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url().optional().or(z.literal("")),

  TELEGRAM_BOT_TOKEN: z.string().min(1),
  TELEGRAM_WEBHOOK_SECRET: z.string().min(8),
  TELEGRAM_WEBHOOK_PATH: z.string().startsWith("/").default("/telegram/webhook"),
  BUY_NOW_CALLBACK_HMAC_KEY: z.string().min(32),
  BUY_NOW_CALLBACK_KEY_VERSION: z.coerce.number().int().min(0).max(15).default(1),
  BUY_NOW_CALLBACK_TTL_SECONDS: z.coerce.number().int().positive().max(86400).default(900),
  BUY_NOW_CALLBACK_CLOCK_SKEW_SECONDS: z.coerce.number().int().nonnegative().max(60).default(5),
  DELIVERY_SESSION_HMAC_KEY: z
    .string()
    .min(32)
    .default("local-dev-delivery-session-key-change-me-32bytes"),
  DELIVERY_SESSION_KEY_VERSION: z.coerce.number().int().min(0).max(255).default(1),
  DELIVERY_SESSION_PREVIOUS_HMAC_KEY: z
    .string()
    .refine((value) => value.length === 0 || Buffer.byteLength(value, "utf8") >= 32)
    .default(""),
  DELIVERY_SESSION_PREVIOUS_KEY_VERSION: z.preprocess(
    (value) => (value === "" || value === undefined ? undefined : value),
    z.coerce.number().int().min(0).max(255).optional(),
  ),
  DELIVERY_SESSION_PREVIOUS_KEY_GRACE_UNTIL: z
    .union([z.literal(""), z.string().datetime({ offset: true })])
    .default(""),
  DELIVERY_SESSION_TTL_SECONDS: z.coerce.number().int().positive().max(86400).default(900),

  ADMIN_TELEGRAM_USER_ID: z.coerce.number().int().nonnegative(),
  ADMIN_EXPECTED_USERNAME: z.string().default("Quyenvjp"),

  SEPAY_WEBHOOK_HMAC_SECRET: z.string().min(32),
  SEPAY_REPLAY_WINDOW_SECONDS: z.coerce.number().int().positive().max(900).default(300),
  SEPAY_MERCHANT_ACCOUNT_ID: z.string().min(1),
  SEPAY_API_BASE_URL: z.string().url().default("https://userapi.sepay.vn/v2"),
  SEPAY_API_TOKEN: z.string().optional().default(""),
  SEPAY_IP_ALLOWLIST: csvList,
  SEPAY_TRUSTED_PROXY_IPS: csvList,

  VIETQR_BANK_BIN: z.string().min(6),
  VIETQR_BANK_ALIAS: z.string().trim().min(2).max(32).default("MB"),
  VIETQR_ACCOUNT_NUMBER: z.string().trim().min(4).max(19),
  VIETQR_ACCOUNT_NAME: z.string().min(1),
  VIETQR_BANK_NAME: z.string().trim().min(2).max(100),
  VIETQR_TEMPLATE: z
    .union([z.literal(""), z.enum(["compact", "qronly", "standee"])])
    .default("compact"),

  PAYMENT_INTENT_TTL_SECONDS: z.coerce.number().int().positive().default(900),
  WALLET_TOPUP_MIN_VND: z.coerce.number().int().positive().default(50_000),
  WALLET_TOPUP_MAX_VND: z.coerce.number().int().positive().default(1_000_000),
  DELIVERY_BUNDLE_TTL_SECONDS: z.coerce.number().int().positive().default(86400),
  PRIVATE_ARTIFACT_ROOT: z.string().default(""),

  VAULT_DRIVER: z.enum(["memory", "external"]).default("memory"),
  VAULT_ENDPOINT: z.string().optional().default(""),
  VAULT_TOKEN: z.string().optional().default(""),
  VAULT_NAMESPACE: z
    .string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/)
    .default("telegram-shop"),
  VAULT_TIMEOUT_MS: z.coerce.number().int().min(10).max(30_000).default(5_000),
  VAULT_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(5).default(3),
  VAULT_EGRESS_HOST_ALLOWLIST: csvList,
  VAULT_EGRESS_PORT_ALLOWLIST: csvPortList,
  VAULT_EGRESS_CIDR_ALLOWLIST: csvList,

  SUPPLIER_DRIVER: z.enum(["fixture", "http"]).default("fixture"),
  SUPPLIER_API_BASE_URL: z.string().optional().default(""),
  SUPPLIER_API_TOKEN: z.string().optional().default(""),
  SUPPLIER_TIMEOUT_MS: z.coerce.number().int().positive().default(8000),

  SEARCH_PARSER_DRIVER: z.enum(["deterministic", "model"]).default("deterministic"),
  SEARCH_PARSER_TIMEOUT_MS: z.coerce.number().int().positive().default(1500),

  OUTBOX_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(500),
  OUTBOX_MAX_ATTEMPTS: z.coerce.number().int().positive().default(10),

  /**
   * Telegram inbox retention. Raw update envelopes can carry admin-pasted inventory
   * credentials, so they are redacted down to delivery metadata as soon as they are
   * durably processed (or dead-lettered, or aged past the retry grace) and the rows
   * themselves are pruned on a bounded schedule. SePay rows in the same table are
   * never touched by these jobs.
   */
  TELEGRAM_INBOX_PROCESSED_RETENTION_DAYS: z.coerce.number().int().min(1).max(365).default(30),
  TELEGRAM_INBOX_DEAD_RETENTION_DAYS: z.coerce.number().int().min(1).max(365).default(90),
  TELEGRAM_INBOX_STALE_RETRY_RETENTION_DAYS: z.coerce.number().int().min(1).max(90).default(7),
  TELEGRAM_INBOX_FAILED_PAYLOAD_GRACE_MINUTES: z.coerce
    .number()
    .int()
    .min(1)
    .max(10_080)
    .default(60),
  TELEGRAM_INBOX_PRUNE_BATCH_SIZE: z.coerce.number().int().min(1).max(1000).default(200),
});

export type Env = z.infer<typeof envSchema>;

/** Keys whose values must never be logged, echoed, or serialized in diagnostics. */
export const SECRET_ENV_KEYS = [
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_WEBHOOK_SECRET",
  "BUY_NOW_CALLBACK_HMAC_KEY",
  "DELIVERY_SESSION_HMAC_KEY",
  "DELIVERY_SESSION_PREVIOUS_HMAC_KEY",
  "SEPAY_WEBHOOK_HMAC_SECRET",
  "SEPAY_API_TOKEN",
  "VAULT_TOKEN",
  "SUPPLIER_API_TOKEN",
  "DATABASE_URL",
  "REDIS_URL",
] as const;

export type SecretEnvKey = (typeof SECRET_ENV_KEYS)[number];
