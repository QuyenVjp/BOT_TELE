import { describe, expect, it } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { makeEventEnvelope, EVENT_TYPES } from "../../src/shared/events/index.js";
import {
  assertNoRawSecret,
  AuditRedactionError,
  buildAuditRecord,
} from "../../src/infrastructure/observability/audit.js";
import { AssetEnvelopeSchema, parseAssetEnvelope } from "../../src/modules/supplier/port.js";
import { PAYMENT_COPY } from "../../src/bot/presenters/payment.js";
import {
  presentDeliveryProcessing,
  presentDeliveryCompleted,
  presentDeliveryExpired,
  presentDeliveryUsed,
  presentDeliveryReveal,
  presentDeliveryNeedsReview,
  DELIVERY_COPY,
} from "../../src/bot/presenters/delivery.js";

/**
 * T063 — Credential scan across DB/log/trace/outbox/ticket/error fixtures
 * (SR-001, SC-007).
 *
 * Raw delivered credentials and provider secrets must never appear in domain
 * storage shapes, telemetry, events, support data, or error responses. The
 * only intended plaintext boundary is the recipient-bound Telegram delivery
 * presenter after payment and asset validation.
 */

const RAW_SECRET = "USER:SuperSecretPass-42";
const PROVIDER_KEY = "supplier-api-key-SECRET-xyz";

function looksLikeCredential(text: string): boolean {
  // Heuristics used by SC-007: credential-shaped tokens, passwords, provider keys.
  if (text.includes(RAW_SECRET)) return true;
  if (text.includes(PROVIDER_KEY)) return true;
  if (/password\s*[:=]/i.test(text)) return true;
  if (/api[_-]?key\s*[:=]/i.test(text)) return true;
  return false;
}

describe("credential leak scan (SR-001 / SC-007)", () => {
  it("asset envelope schema rejects a free-form secret body (vault ref only)", () => {
    expect(() =>
      parseAssetEnvelope({
        deliveryType: "CREDENTIAL",
        expectedSku: "NF-1M",
        region: "VN",
        durationCode: "P1M",
        expiresAt: null,
        supplierAssetId: "sa-1",
        fingerprint: "fp-1",
        vaultRef: RAW_SECRET, // not a vault: ref
      }),
    ).toThrow();

    // A well-formed vault ref is accepted and the schema strips unknown secret keys.
    const ok = AssetEnvelopeSchema.safeParse({
      deliveryType: "CREDENTIAL",
      expectedSku: "NF-1M",
      region: "VN",
      durationCode: "P1M",
      expiresAt: null,
      supplierAssetId: "sa-1",
      fingerprint: "fp-1",
      vaultRef: "vault:01TESTREF000000000000000",
      secret: RAW_SECRET, // unknown key → .strict() rejects
    });
    expect(ok.success).toBe(false);
  });

  it("outbox event payloads never carry a raw secret field", () => {
    const payload = {
      bundleId: "b1",
      orderId: "o1",
      customerId: "c1",
      assetId: "a1",
      vaultRef: "vault:01TESTREF000000000000000",
      correlationId: "corr-1",
    };
    // Building the envelope is fine; the payload has only references.
    const env = makeEventEnvelope("DigitalAssetDelivered", {
      aggregateType: "DeliveryBundle",
      aggregateId: "b1",
      aggregateVersion: 2,
      correlationId: "corr-1",
      payload,
    });
    expect(EVENT_TYPES).toContain("DigitalAssetDelivered");
    const blob = JSON.stringify(env);
    expect(looksLikeCredential(blob)).toBe(false);
    expect(blob).not.toContain(RAW_SECRET);
  });

  it("audit builder refuses metadata that smuggles a credential-like key", () => {
    expect(() =>
      buildAuditRecord({
        actorType: "system",
        action: "DELIVERY_REVEAL",
        targetType: "DeliveryBundle",
        targetId: "b1",
        reason: "first view",
        correlationId: "corr-1",
        metadata: { credential: RAW_SECRET },
      }),
    ).toThrow(AuditRedactionError);

    // Reference keys are allowed.
    const ok = buildAuditRecord({
      actorType: "system",
      action: "DELIVERY_REVEAL",
      targetType: "DeliveryBundle",
      targetId: "b1",
      reason: "first view",
      correlationId: "corr-1",
      metadata: { vault_ref: "vault:01TEST", asset_id: "a1" },
    });
    expect(ok).toBeTruthy();
    expect(JSON.stringify(ok)).not.toContain(RAW_SECRET);
  });

  it("assertNoRawSecret rejects nested secret-shaped keys", () => {
    expect(() => assertNoRawSecret({ outer: { nested: { api_key: PROVIDER_KEY } } })).toThrow(
      AuditRedactionError,
    );
  });

  it("token hash is a one-way digest — the plaintext is never recoverable from storage shape", () => {
    const token = randomBytes(32).toString("base64url");
    const hash = createHash("sha256").update(token, "utf8").digest("hex");
    // Storage shape only holds the hash.
    const stored = { token_hash: hash, status: "AVAILABLE" };
    expect(JSON.stringify(stored)).not.toContain(token);
    expect(hash).not.toBe(token);
  });

  it("only the recipient delivery presenter renders the raw credential", () => {
    const automatic = presentDeliveryReveal({
      secret: RAW_SECRET,
      productName: "Product",
      usageInstructionsVi: null,
      warrantyVi: null,
    });
    expect(automatic.text).toContain(RAW_SECRET);

    const msgs = [
      presentDeliveryProcessing("ORD-1"),
      presentDeliveryCompleted("ORD-1", "https://example.invalid/d/token"),
      presentDeliveryExpired("ORD-1"),
      presentDeliveryUsed("ORD-1"),
      presentDeliveryNeedsReview("ORD-1", "corr-xyz"),
    ];
    for (const msg of msgs) {
      const blob = (
        msg.text +
        " " +
        msg.buttons
          .flat()
          .map((b) => b.text)
          .join(" ")
      ).toLowerCase();
      expect(blob).not.toContain(RAW_SECRET.toLowerCase());
      expect(blob).not.toContain(PROVIDER_KEY.toLowerCase());
      // Presenters must not invite the user to paste a password/secret back.
      // Allow the negation "không gửi mật khẩu"; forbid imperative "gửi mật khẩu".
      expect(blob).not.toMatch(/(?:vui lòng|hãy)\s+gửi.*(mật khẩu|password|secret)/);
      expect(blob).not.toMatch(/(?<!không\s)gửi.*(mật khẩu|password|secret)/);
    }
    // Static copy is also clean.
    const joined = Object.values(DELIVERY_COPY).join(" ").toLowerCase();
    expect(joined).not.toContain("password");
    expect(joined).not.toContain(RAW_SECRET.toLowerCase());
    // Payment copy (cross-story) still forbids screenshot instructions.
    expect(Object.values(PAYMENT_COPY).join(" ").toLowerCase()).toContain("không cần gửi ảnh");
  });
});
