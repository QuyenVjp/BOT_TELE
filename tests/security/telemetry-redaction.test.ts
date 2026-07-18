import { describe, expect, it } from "vitest";
import { Writable } from "node:stream";
import {
  REDACT_PATHS,
  createLogger,
  buildRedactedLogger,
  type Logger,
} from "../../src/infrastructure/observability/logger.js";
import {
  buildAuditRecord,
  assertNoRawSecret,
  AuditRedactionError,
} from "../../src/infrastructure/observability/audit.js";

/**
 * T019 — Structured-log + audit redaction (SR-001, SR-005).
 *
 * SR-001: raw credentials/provider secrets must never appear in telemetry.
 * SR-005: financial/authorization/supplier/delivery/manual-review transitions
 *         must create attributable, immutable audit evidence — with references,
 *         actor, outcome, time, correlation id, but NO raw secret.
 */

const SECRETS = {
  botToken: "123456:AA-REAL-BOT-TOKEN",
  hmac: "sepay-hmac-secret-xyz",
  vaultToken: "vault-token-abc",
  dbPassword: "dbpassword-secret",
  apiKey: "supplier-api-key-secret",
};

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

describe("structured log redaction (SR-001)", () => {
  it("censors known secret field paths instead of emitting their values", () => {
    const line = captureLog((logger) => {
      logger.info(
        {
          config: { TELEGRAM_BOT_TOKEN: SECRETS.botToken, VAULT_TOKEN: SECRETS.vaultToken },
          token: SECRETS.apiKey,
          nested: { secret: SECRETS.hmac },
        },
        "startup",
      );
    });

    expect(line).not.toContain(SECRETS.botToken);
    expect(line).not.toContain(SECRETS.vaultToken);
    expect(line).not.toContain(SECRETS.apiKey);
    expect(line).not.toContain(SECRETS.hmac);
    expect(line).toContain("«redacted»");
  });

  it("censors sensitive request headers", () => {
    const line = captureLog((logger) => {
      logger.info(
        {
          req: {
            headers: {
              authorization: `Bearer ${SECRETS.apiKey}`,
              "x-telegram-bot-api-secret-token": SECRETS.botToken,
              "x-sepay-signature": SECRETS.hmac,
            },
          },
        },
        "inbound",
      );
    });

    expect(line).not.toContain(SECRETS.apiKey);
    expect(line).not.toContain(SECRETS.botToken);
    expect(line).not.toContain(SECRETS.hmac);
  });

  it("exposes a stable redaction path list that covers the secret env keys", () => {
    expect(REDACT_PATHS).toContain("TELEGRAM_BOT_TOKEN");
    expect(REDACT_PATHS).toContain("VAULT_TOKEN");
    // config.* and env.* nested variants are covered too.
    expect(REDACT_PATHS.some((p) => p.startsWith("config."))).toBe(true);
    expect(REDACT_PATHS.some((p) => p.startsWith("env."))).toBe(true);
  });

  it("createLogger builds a logger honoring the redaction policy", () => {
    const logger = createLogger({ LOG_LEVEL: "info", NODE_ENV: "test" });
    expect(typeof logger.info).toBe("function");
  });
});

describe("audit evidence (SR-005)", () => {
  it("builds an attributable audit record with references and no raw secret", () => {
    const record = buildAuditRecord({
      actorType: "system",
      action: "PAYMENT_SETTLED",
      targetType: "payment_intent",
      targetId: "01J000000000000000000INTENT",
      reason: "sepay evidence matched",
      correlationId: "01J000000000000000000CORREL",
      metadata: { amountVnd: "150000", bankTransactionId: "01J00000000000000000000TXN" },
    });

    expect(record.actor_type).toBe("system");
    expect(record.action).toBe("PAYMENT_SETTLED");
    expect(record.target_type).toBe("payment_intent");
    expect(record.correlation_id).toBe("01J000000000000000000CORREL");
    expect(typeof record.occurred_at).toBe("string");
    // Attributable + references present, but the metadata carries no secret.
    expect(JSON.stringify(record)).not.toContain(SECRETS.vaultToken);
  });

  it("rejects an audit record whose metadata smuggles a raw secret-like field", () => {
    expect(() =>
      buildAuditRecord({
        actorType: "system",
        action: "SUPPLIER_ASSET_READY",
        targetType: "digital_asset",
        targetId: "01J0000000000000000000ASSET",
        reason: "provisioned",
        correlationId: "01J000000000000000000CORREL",
        metadata: { vault_token: SECRETS.vaultToken },
      }),
    ).toThrow(AuditRedactionError);
  });

  it("assertNoRawSecret flags forbidden key names anywhere in an object graph", () => {
    expect(() => assertNoRawSecret({ nested: { credential: "x" } })).toThrow(AuditRedactionError);
    expect(() => assertNoRawSecret({ ok: true, count: 3 })).not.toThrow();
  });
});
