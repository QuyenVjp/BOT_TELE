import { Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildRedactedLogger, type Logger } from "../../src/infrastructure/observability/logger.js";
import { describeHandlerError } from "../../src/infrastructure/inbox/error-detail.js";
import {
  loadConfig,
  resetConfigCache,
  SECRET_ENV_KEYS,
  type AppConfig,
} from "../../src/config/index.js";
import {
  REDACTION_MARKER,
  createSecretRegistry,
  registerConfigSecrets,
  scrubError,
  scrubHeaders,
  scrubSecrets,
  scrubValue,
  sharedSecretRegistry,
} from "../../src/infrastructure/observability/redact.js";

/**
 * Value-scanning redaction (SR-001).
 *
 * `REDACT_PATHS` censors secrets that arrive at a *known key*. These tests cover
 * the other half: a secret embedded in free-form text, at an unknown depth, under
 * a key nobody listed, or on its way into durable storage. The guarantee under
 * test is that a registered VALUE never survives scrubbing, wherever it sits.
 */

/**
 * Obvious fakes: long enough for the registry to accept them, and every one carries the
 * `placeholder-value` marker that both scanners are told to ignore. A real credential would
 * never contain that marker, so the allowlist cannot hide one.
 */
const BOT_MATERIAL = "placeholder-value-bot-material-00001";
const VAULT_MATERIAL = "placeholder-value-vault-material-0001";
const HMAC_MATERIAL = "placeholder-value-hmac-material-00001";
const THREE_SECRETS = [BOT_MATERIAL, VAULT_MATERIAL, HMAC_MATERIAL];

/** Nest `leaf` under `depth` plain objects: `nest(2, v)` is `{nested:{nested:v}}`. */
function nest(depth: number, leaf: unknown): Record<string, unknown> {
  let node: Record<string, unknown> = { leaf };
  for (let level = 1; level < depth; level++) node = { nested: node };
  return node;
}

/** Capture one JSON log line emitted by a pino logger. */
function captureLog(run: (logger: Logger) => void): string {
  let captured = "";
  const sink = new Writable({
    write(chunk, _enc, cb) {
      captured += chunk.toString();
      cb();
    },
  });
  const logger = buildRedactedLogger({ level: "info" }, sink);
  run(logger);
  return captured;
}

beforeEach(() => {
  sharedSecretRegistry().clear();
});

afterEach(() => {
  sharedSecretRegistry().clear();
});

describe("secret registry", () => {
  it("replaces a registered value everywhere in a long multi-line string", () => {
    const registry = createSecretRegistry();
    registry.add(BOT_MATERIAL);

    const text = [
      `connect failed for ${BOT_MATERIAL}`,
      "retrying with the same material:",
      `${BOT_MATERIAL}`,
      `tail ${BOT_MATERIAL} and nothing else`,
    ].join("\n");

    const scrubbed = registry.scrub(text);
    expect(scrubbed).not.toContain(BOT_MATERIAL);
    expect(scrubbed.split(REDACTION_MARKER)).toHaveLength(4);
    expect(scrubbed).toContain("connect failed for «redacted»");
  });

  it("ignores values shorter than 8 characters", () => {
    const registry = createSecretRegistry();
    registry.addAll(["short", "abc", "", "   ", undefined, null]);
    expect(registry.size()).toBe(0);

    // A 7-char value is not registered either; the 8-char neighbour is.
    registry.add("1234567");
    expect(registry.size()).toBe(0);
    registry.add("12345678");
    expect(registry.size()).toBe(1);
  });

  it("skips a value containing the marker, so scrubbing cannot loop", () => {
    const registry = createSecretRegistry();
    registry.add(`leading-${REDACTION_MARKER}-trailing`);
    expect(registry.size()).toBe(0);

    const text = `leading-${REDACTION_MARKER}-trailing`;
    expect(registry.scrub(text)).toBe(text);
  });

  it("ignores a duplicate registration", () => {
    const registry = createSecretRegistry();
    registry.add(BOT_MATERIAL);
    registry.add(BOT_MATERIAL);
    expect(registry.size()).toBe(1);
  });

  it("registerConfigSecrets registers usable config values and is idempotent", () => {
    const config: Record<string, unknown> = {
      TELEGRAM_BOT_TOKEN: BOT_MATERIAL,
      VAULT_TOKEN: VAULT_MATERIAL,
      TELEGRAM_WEBHOOK_SECRET: "short",
      SUPPLIER_API_TOKEN: undefined,
      DATABASE_URL: 42,
    };
    const keys = Object.keys(config);

    expect(registerConfigSecrets(config, keys)).toBe(2);
    expect(sharedSecretRegistry().size()).toBe(2);

    // A second boot-time call must be harmless.
    expect(registerConfigSecrets(config, keys)).toBe(2);
    expect(sharedSecretRegistry().size()).toBe(2);
    expect(scrubSecrets(`token ${BOT_MATERIAL}`)).toBe("token «redacted»");
  });

  it("scrubSecrets is safe on undefined and empty input", () => {
    sharedSecretRegistry().add(BOT_MATERIAL);
    expect(scrubSecrets(undefined as unknown as string)).toBe("");
    expect(scrubSecrets("")).toBe("");
  });
});

describe("scrubValue", () => {
  beforeEach(() => {
    sharedSecretRegistry().addAll(THREE_SECRETS);
  });

  it("redacts registered values, sensitive keys, arrays and unknown-depth nesting", () => {
    const scrubbed = scrubValue({
      message: `provider said ${VAULT_MATERIAL}`,
      botToken: "raw-token-x",
      Authorization: `Bearer ${HMAC_MATERIAL}`,
      attempts: [`first ${BOT_MATERIAL}`, "clean"],
      monkey: "banana",
      sessionId: "sid-123",
      vault_ref: "vault/path",
      err: new Error(`boom ${BOT_MATERIAL}`),
    }) as Record<string, unknown>;

    expect(scrubbed.message).toBe("provider said «redacted»");
    expect(scrubbed.botToken).toBe(REDACTION_MARKER);
    expect(scrubbed.Authorization).toBe(REDACTION_MARKER);
    expect(scrubbed.attempts).toEqual(["first «redacted»", "clean"]);
    expect(scrubbed.monkey).toBe("banana");
    expect(scrubbed.sessionId).toBe(REDACTION_MARKER);
    expect(scrubbed.vault_ref).toBe(REDACTION_MARKER);
    expect(JSON.stringify(scrubbed.err)).not.toContain(BOT_MATERIAL);
  });

  it("redacts a value nested 10 levels deep instead of reaching it", () => {
    const deep = nest(10, BOT_MATERIAL);
    const scrubbed = scrubValue(deep);
    const json = JSON.stringify(scrubbed);

    expect(json).not.toContain(BOT_MATERIAL);
    expect(json).toContain(REDACTION_MARKER);

    // With the depth bound lifted the same value is scrubbed by value, not by depth.
    const lifted = JSON.stringify(scrubValue(deep, { maxDepth: 32 }));
    expect(lifted).not.toContain(BOT_MATERIAL);
    expect(lifted).toContain(REDACTION_MARKER);
  });

  it("is cycle-safe and does not hang on a self-referencing object", () => {
    const node: Record<string, unknown> = { label: BOT_MATERIAL };
    node.self = node;

    let scrubbed: unknown;
    expect(() => {
      scrubbed = scrubValue(node);
    }).not.toThrow();

    const json = JSON.stringify(scrubbed);
    expect(json).not.toContain(BOT_MATERIAL);
    expect(json).toContain(REDACTION_MARKER);
  });

  it("does not mutate its input", () => {
    const input = {
      headers: { authorization: `Bearer ${BOT_MATERIAL}` },
      body: { note: `echoed ${VAULT_MATERIAL}` },
    };

    scrubValue(input);

    expect(input.headers.authorization).toBe(`Bearer ${BOT_MATERIAL}`);
    expect(input.body.note).toBe(`echoed ${VAULT_MATERIAL}`);
  });

  it("leaves primitives and non-plain objects alone unless they are strings", () => {
    const when = new Date("2026-01-01T00:00:00.000Z");
    const scrubbed = scrubValue({ count: 3, ok: true, missing: null, when }) as Record<
      string,
      unknown
    >;
    expect(scrubbed).toEqual({ count: 3, ok: true, missing: null, when });
  });
});

describe("scrubHeaders", () => {
  it("redacts whole sensitive header values and keeps innocuous ones readable", () => {
    const headers = scrubHeaders({
      authorization: `Bearer ${BOT_MATERIAL}`,
      cookie: `session=${VAULT_MATERIAL}`,
      "x-sepay-signature": HMAC_MATERIAL,
      "x-telegram-bot-api-secret-token": "telegram-header-secret",
      "content-type": "application/json",
      "user-agent": "curl/8.7.1",
    });

    // Whole value: a `Bearer …` prefix is already the credential.
    expect(headers.authorization).toBe(REDACTION_MARKER);
    expect(headers.cookie).toBe(REDACTION_MARKER);
    expect(headers["x-sepay-signature"]).toBe(REDACTION_MARKER);
    expect(headers["x-telegram-bot-api-secret-token"]).toBe(REDACTION_MARKER);
    expect(headers["content-type"]).toBe("application/json");
    expect(headers["user-agent"]).toBe("curl/8.7.1");

    const json = JSON.stringify(headers);
    for (const secret of THREE_SECRETS) expect(json).not.toContain(secret);
  });
});

describe("durable inbox detail", () => {
  beforeEach(() => {
    sharedSecretRegistry().addAll(THREE_SECRETS);
  });

  it("scrubs registered secrets in the stored detail", () => {
    // The value-scanner is the guarantee for `webhook_inbox.last_error_detail`:
    // a provider error body carries arbitrary text, so key-based scrubbing
    // alone cannot see this one. 15 chars keeps it under the existing
    // high-entropy rule, so only the registry can catch it.
    const shortMaterial = "vaultmat9c11a2f";
    sharedSecretRegistry().add(shortMaterial);

    const detail = describeHandlerError(new Error(`provider refused: ${shortMaterial}`));
    expect(detail).not.toContain(shortMaterial);
    expect(detail).toContain(REDACTION_MARKER);

    // The pre-existing entropy rule still handles long opaque runs.
    expect(describeHandlerError(new Error(`provider refused: ${VAULT_MATERIAL}`))).toBe(
      "Error: provider refused: [redacted]",
    );
    // Non-secret detail keeps the exact existing shape.
    expect(describeHandlerError(new TypeError("no message shape change"))).toBe(
      "TypeError: no message shape change",
    );
  });
});

describe("scrubError", () => {
  beforeEach(() => {
    sharedSecretRegistry().addAll(THREE_SECRETS);
  });

  it("scrubs the message and the stack, and drops the cause chain", () => {
    const cause = new Error(`upstream said ${VAULT_MATERIAL}`);
    const error = Object.assign(new Error(`payment failed: ${BOT_MATERIAL}`), { cause });

    const shape = scrubError(error);
    expect(shape.name).toBe("Error");
    expect(shape.message).toBe("payment failed: «redacted»");
    expect(shape.stack).toBeDefined();
    expect(shape.stack).not.toContain(BOT_MATERIAL);
    // A cause chain is unbounded, usually a provider payload, and never logged.
    expect(Object.keys(shape)).not.toContain("cause");
    expect(JSON.stringify(shape)).not.toContain(VAULT_MATERIAL);
  });

  it("never throws on a non-Error throw", () => {
    expect(scrubError(`thrown ${HMAC_MATERIAL}`)).toEqual({
      name: "Error",
      message: "thrown «redacted»",
    });
    expect(scrubError(undefined)).toMatchObject({ name: "UnknownError" });
    expect(scrubError(null)).toMatchObject({ name: "UnknownError" });
    expect(scrubError(42)).toMatchObject({ message: "42" });
    expect(() =>
      scrubError({
        toJSON() {
          throw new Error("unserializable");
        },
      }),
    ).not.toThrow();
  });
});

describe("logger redaction end to end", () => {
  beforeEach(() => {
    sharedSecretRegistry().addAll(THREE_SECRETS);
  });

  it("scrubs free-form messages, header maps and sensitive keys before serialisation", () => {
    const line = captureLog((logger) => {
      logger.info(
        {
          detail: `provider rejected the request using ${BOT_MATERIAL}`,
          request: { headers: { authorization: `Bearer ${VAULT_MATERIAL}` } },
          botToken: "raw-token-y",
          bot_token: "raw-token-y",
        },
        `webhook failed for ${HMAC_MATERIAL}`,
      );
    });

    for (const secret of THREE_SECRETS) expect(line).not.toContain(secret);
    expect(line).not.toContain("raw-token-y");
    expect(line).toContain(REDACTION_MARKER);
    // The line is still structured JSON with the operator-useful fields intact.
    expect(JSON.parse(line).detail).toBe("provider rejected the request using «redacted»");
  });

  it("scrubs a thrown Error logged under the err key", () => {
    // The most common leak vector: a provider message embedded in an Error.
    const line = captureLog((logger) => {
      logger.error({ err: new Error(`connect failed: ${VAULT_MATERIAL}`) }, "lane failed");
    });

    expect(line).not.toContain(VAULT_MATERIAL);
    expect(line).toContain(REDACTION_MARKER);
    const parsed = JSON.parse(line) as { err: { message: string; stack: string } };
    expect(parsed.err.message).toBe("connect failed: «redacted»");
    expect(parsed.err.stack).not.toContain(VAULT_MATERIAL);
  });

  it("leaks none of three registered secrets through a representative payload", () => {
    const payload = {
      provider: { name: "sepay", responseBody: `denied: ${VAULT_MATERIAL}` },
      headers: {
        authorization: `Bearer ${BOT_MATERIAL}`,
        "content-type": "application/json",
      },
      attempts: [{ errorMessage: HMAC_MATERIAL }],
      nested: { deeper: { deepest: `leaf ${BOT_MATERIAL}` } },
    };

    const json = JSON.stringify(scrubValue(payload));
    for (const secret of THREE_SECRETS) expect(json).not.toContain(secret);
    expect(json).toContain(REDACTION_MARKER);
    // Non-secret context survives: over-redaction would make logs useless.
    expect(json).toContain("sepay");
    expect(json).toContain("application/json");
  });
});

/**
 * The boot contract: `main.ts`/`worker.ts` call `registerConfigSecrets(config, SECRET_ENV_KEYS)`
 * right after building the logger, so the values the config loader actually
 * produces are the values the value-scanner scrubs.
 */
describe("boot registration from the resolved config", () => {
  // Fixture material kept in non-secret-shaped constants: a literal assignment of a long
  // quoted value to a secret-named key trips the repository's own secret scan, and that
  // scan staying green is a release gate.
  const bootBot = "boot-bot-token-material-1234567890ab";
  const bootWebhook = "boot-webhook-material-1234567890abcdef";
  const bootBuyNow = "boot-buy-now-hmac-material-1234567890ab";
  const bootDelivery = "boot-delivery-hmac-material-1234567890ab";
  const bootSePay = "boot-sepay-hmac-material-1234567890abcd";
  const bootDsn = "postgres://shop:boot-db-password@localhost:5432/shop";

  const loadedSecrets: Record<string, string> = {
    TELEGRAM_BOT_TOKEN: bootBot,
    TELEGRAM_WEBHOOK_SECRET: bootWebhook,
    BUY_NOW_CALLBACK_HMAC_KEY: bootBuyNow,
    DELIVERY_SESSION_HMAC_KEY: bootDelivery,
    SEPAY_WEBHOOK_HMAC_SECRET: bootSePay,
    DATABASE_URL: bootDsn,
  };

  beforeEach(() => {
    resetConfigCache();
    sharedSecretRegistry().clear();
  });

  afterEach(() => {
    resetConfigCache();
    sharedSecretRegistry().clear();
  });

  function bootConfig(): AppConfig {
    return loadConfig({
      NODE_ENV: "test",
      APP_BASE_URL: "http://localhost:3000",
      ADMIN_TELEGRAM_USER_ID: "123456789",
      SEPAY_MERCHANT_ACCOUNT_ID: "sepay-merchant-001",
      SEPAY_IP_ALLOWLIST: "172.236.138.20",
      VIETQR_BANK_BIN: "970422",
      VIETQR_ACCOUNT_NUMBER: "0123456789",
      VIETQR_ACCOUNT_NAME: "SHOP DIGITAL",
      VIETQR_BANK_NAME: "MB Bank",
      VAULT_EGRESS_HOST_ALLOWLIST: "vault.example",
      VAULT_EGRESS_PORT_ALLOWLIST: "443",
      VAULT_EGRESS_CIDR_ALLOWLIST: "203.0.113.0/24",
      ...loadedSecrets,
    });
  }

  it("scrubs every loaded secret value after the boot call, and is idempotent", () => {
    const config = bootConfig();

    const registered = registerConfigSecrets(config, SECRET_ENV_KEYS);
    expect(registered).toBe(6);
    expect(sharedSecretRegistry().size()).toBe(6);

    // The exact call the entrypoints make is what protects them.
    for (const value of Object.values(loadedSecrets)) {
      expect(scrubSecrets(`leaked ${value} here`)).toBe(`leaked ${REDACTION_MARKER} here`);
    }
    // Idempotent: tests build loggers too, and a second boot must not double-register.
    expect(registerConfigSecrets(config, SECRET_ENV_KEYS)).toBe(6);
    expect(sharedSecretRegistry().size()).toBe(6);
  });

  it("carries a loaded secret through a logger line without emitting it", () => {
    const config = bootConfig();
    registerConfigSecrets(config, SECRET_ENV_KEYS);

    const line = captureLog((logger) => {
      logger.error(
        { err: new Error(`connect failed: ${config.DATABASE_URL}`) },
        `database unavailable at ${config.DATABASE_URL}`,
      );
    });

    expect(line).not.toContain(config.DATABASE_URL);
    expect(line).not.toContain(loadedSecrets.TELEGRAM_BOT_TOKEN!);
    expect(line).toContain(REDACTION_MARKER);
  });
});
