import { pino, type Logger } from "pino";
import { SECRET_ENV_KEYS, type AppConfig } from "../../config/index.js";
import { REDACTION_MARKER, scrubSecrets, scrubValue } from "./redact.js";

/**
 * Structured logger with a redaction policy.
 *
 * Redaction is defense-in-depth: secrets must never reach the logger in the
 * first place, but if a config or env object is logged by mistake, the paths
 * below are censored. See contracts/* SR-001/SR-005.
 *
 * The path list only covers secrets at *known* keys. `scrubValue` (hooks below)
 * is the actual guarantee: every logged object is value-scanned for registered
 * secrets and key-scanned for sensitive names before serialisation, so a token
 * inside a free-form message or at an unknown depth is censored too.
 */

/**
 * Additional sensitive key names (snake_case and camelCase) that must be
 * censored at the top level and one level down. Pino's `*` matches exactly one
 * level, so arbitrary depth is left to the `scrubValue` hook below.
 */
const SENSITIVE_KEY_PATHS: string[] = [
  "botToken",
  "bot_token",
  "password",
  "passwd",
  "authorization",
  "cookie",
  "apiKey",
  "api_key",
  "apikey",
  "credentials",
  "privateKey",
  "private_key",
  "privatekey",
  "signingKey",
  "signing_key",
  "hmac",
  "otp",
  "totp",
  "seed",
  "initData",
  "init_data",
  "vaultRef",
  "vault_ref",
  "sessionId",
  "signature",
  "bearer",
];

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
  "assetEnvelope.secret",
  ...SENSITIVE_KEY_PATHS,
  ...SENSITIVE_KEY_PATHS.map((key) => `*.${key}`),
  "req.headers.cookie",
  'req.headers["cookie"]',
  "*.headers.authorization",
  "*.headers.cookie",
];

export interface LoggerOptions {
  level: string;
  /** Included on every line for correlation across the two entrypoints. */
  base?: Record<string, unknown>;
}

/**
 * Pino redaction path list plus the value-scrub hook, ready to spread into
 * `pino()` options. `logMethod` runs first, so it rewrites every logged value —
 * including ones the dotted paths cannot name.
 */
function scrubHook(args: unknown[]): void {
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (typeof arg === "string") args[index] = scrubSecrets(arg);
    else if (arg !== null && typeof arg === "object") args[index] = scrubValue(arg);
  }
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
      censor: REDACTION_MARKER,
    },
    base: options.base ?? {},
    timestamp: pino.stdTimeFunctions.isoTime,
    hooks: {
      logMethod(args: unknown[], method: (...methodArgs: unknown[]) => void) {
        scrubHook(args);
        method.apply(this, args);
      },
    },
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
