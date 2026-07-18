import { pino, type Logger } from "pino";
import { SECRET_ENV_KEYS, type AppConfig } from "../../config/index.js";

/**
 * Structured logger with a redaction policy.
 *
 * Redaction is defense-in-depth: secrets must never reach the logger in the
 * first place, but if a config or env object is logged by mistake, the paths
 * below are censored. Phase 2 (T020) extends this with OpenTelemetry
 * correlation ids and per-domain redaction. See contracts/* SR-001/SR-005.
 */

/** Field paths pino should censor regardless of where they appear. */
export const REDACT_PATHS: string[] = [
  ...SECRET_ENV_KEYS,
  ...SECRET_ENV_KEYS.map((k) => `config.${k}`),
  ...SECRET_ENV_KEYS.map((k) => `env.${k}`),
  "req.headers.authorization",
  'req.headers["x-telegram-bot-api-secret-token"]',
  'req.headers["x-sepay-signature"]',
  "token",
  "*.token",
  "secret",
  "*.secret",
  "credential",
  "*.credential",
  "vault_ref",
  "assetEnvelope.secret",
];

export interface LoggerOptions {
  level: string;
  /** Included on every line for correlation across the two entrypoints. */
  base?: Record<string, unknown>;
}

/**
 * Build a pino logger with the redaction policy applied. Accepts an optional
 * destination stream so tests can capture output and assert no secret leaks.
 */
export function buildRedactedLogger(
  options: LoggerOptions,
  destination?: NodeJS.WritableStream,
): Logger {
  const opts = {
    level: options.level,
    redact: {
      paths: REDACT_PATHS,
      censor: "«redacted»",
    },
    base: options.base ?? {},
    timestamp: pino.stdTimeFunctions.isoTime,
  };
  return destination ? pino(opts, destination) : pino(opts);
}

export function createLogger(config: Pick<AppConfig, "LOG_LEVEL" | "NODE_ENV">): Logger {
  return buildRedactedLogger({
    level: config.LOG_LEVEL,
    base: { env: config.NODE_ENV },
  });
}

export type { Logger };
