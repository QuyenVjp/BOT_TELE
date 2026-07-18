import { describe, expect, it } from "vitest";
import {
  CreateOrderResultSchema,
  QueryOrderResultSchema,
  AssetEnvelopeSchema,
  parseCreateOrderResult,
  parseQueryOrderResult,
  parseAssetEnvelope,
  SupplierPortError,
  type SupplierPort,
  type CreateOrderInput,
} from "../../src/modules/supplier/port.js";
import { createSandboxSupplierAdapter } from "../../src/modules/supplier/adapters/primary.js";

/**
 * T060 — Supplier Port schema, idempotency, reject, timeout→UNKNOWN,
 * query-before-retry, malformed-asset (FR-015/FR-016, contracts/supplier-port.md).
 *
 * All supplier responses are untrusted and schema-validated. Transport timeout
 * after submission maps to UNKNOWN (never REJECTED, never auto-retry). Create
 * retries reuse the original idempotency key and only proceed after query/
 * reconciliation permits them. A HTTP-success without a complete valid
 * assetEnvelope is SUPPLIER_NEEDS_REVIEW, never a silent delivery.
 */

const BASE_CREATE: CreateOrderInput = {
  idempotencyKey: "idem-1",
  supplierSku: "NF-1M-PREMIUM",
  costCeilingVnd: 150000,
  orderId: "ord-1",
  region: "VN",
};

describe("Supplier Port response schemas (allowlisted)", () => {
  it("accepts a valid ACCEPTED create result", () => {
    const parsed = parseCreateOrderResult({
      kind: "ACCEPTED",
      externalOrderId: "ext-1",
      status: "PENDING",
    });
    expect(parsed.kind).toBe("ACCEPTED");
    if (parsed.kind === "ACCEPTED") {
      expect(parsed.externalOrderId).toBe("ext-1");
    }
  });

  it("accepts a valid FULFILLED create result with a complete asset envelope", () => {
    const envelope = {
      deliveryType: "CREDENTIAL",
      expectedSku: "NF-1M-PREMIUM",
      region: "VN",
      durationCode: "P1M",
      expiresAt: "2026-08-16T00:00:00.000Z",
      supplierAssetId: "sa-1",
      fingerprint: "fp-abc",
      // Secret material is a vault ref — never plaintext past the adapter.
      vaultRef: "vault:01TESTREF000000000000000",
    };
    const parsed = parseCreateOrderResult({
      kind: "FULFILLED",
      externalOrderId: "ext-2",
      assetEnvelope: envelope,
    });
    expect(parsed.kind).toBe("FULFILLED");
  });

  it("accepts a REJECTED result with a stable code", () => {
    const parsed = parseCreateOrderResult({
      kind: "REJECTED",
      code: "OUT_OF_STOCK",
      retryable: false,
    });
    expect(parsed.kind).toBe("REJECTED");
  });

  it("accepts an UNKNOWN result (timeout after submission)", () => {
    const parsed = parseCreateOrderResult({
      kind: "UNKNOWN",
      queryKey: "qk-1",
      reason: "transport_timeout",
    });
    expect(parsed.kind).toBe("UNKNOWN");
  });

  it("rejects a create result missing required fields", () => {
    expect(() => parseCreateOrderResult({ kind: "ACCEPTED" })).toThrow();
  });

  it("rejects an unknown kind", () => {
    expect(() => parseCreateOrderResult({ kind: "MAYBE" })).toThrow();
  });

  it("rejects a FULFILLED result whose asset envelope is incomplete", () => {
    expect(() =>
      parseCreateOrderResult({
        kind: "FULFILLED",
        externalOrderId: "ext-x",
        assetEnvelope: { deliveryType: "CREDENTIAL" }, // missing everything else
      }),
    ).toThrow();
  });

  it("rejects an asset envelope that smuggles raw secret plaintext", () => {
    // The envelope must carry a vault: ref, not a free-form secret body.
    expect(() =>
      parseAssetEnvelope({
        deliveryType: "CREDENTIAL",
        expectedSku: "NF-1M",
        region: "VN",
        durationCode: "P1M",
        expiresAt: null,
        supplierAssetId: "sa-1",
        fingerprint: "fp-1",
        vaultRef: "plaintext-is-not-a-vault-ref",
      }),
    ).toThrow();
  });

  it("query result schema accepts pending / fulfilled / rejected / cancelled", () => {
    for (const status of ["PENDING", "FULFILLED", "REJECTED", "CANCELLED", "REFUNDED"] as const) {
      const base: Record<string, unknown> = { status };
      if (status === "FULFILLED") {
        base.assetEnvelope = {
          deliveryType: "LICENSE",
          expectedSku: "SK",
          region: null,
          durationCode: "P1M",
          expiresAt: null,
          supplierAssetId: "sa",
          fingerprint: "fp",
          vaultRef: "vault:01TESTREF000000000000001",
        };
        base.externalOrderId = "ext";
      } else {
        base.externalOrderId = "ext";
      }
      expect(() => parseQueryOrderResult(base)).not.toThrow();
    }
  });

  it("exports the Zod schemas for adapter composition", () => {
    expect(CreateOrderResultSchema).toBeTruthy();
    expect(QueryOrderResultSchema).toBeTruthy();
    expect(AssetEnvelopeSchema).toBeTruthy();
  });
});

describe("sandbox supplier adapter (FR-015/FR-016)", () => {
  it("createOrder is idempotent on the same idempotency key", async () => {
    const port: SupplierPort = createSandboxSupplierAdapter({ mode: "fulfill" });
    const a = await port.createOrder(BASE_CREATE);
    const b = await port.createOrder(BASE_CREATE);
    expect(a.kind).toBe("FULFILLED");
    expect(b.kind).toBe("FULFILLED");
    if (a.kind === "FULFILLED" && b.kind === "FULFILLED") {
      expect(b.externalOrderId).toBe(a.externalOrderId);
    }
  });

  it("createOrder returns REJECTED for a configured reject SKU", async () => {
    const port = createSandboxSupplierAdapter({ mode: "reject" });
    const res = await port.createOrder({ ...BASE_CREATE, supplierSku: "REJECT-ME" });
    expect(res.kind).toBe("REJECTED");
    if (res.kind === "REJECTED") {
      expect(res.retryable).toBe(false);
    }
  });

  it("createOrder returns UNKNOWN on a configured timeout (never auto-retries)", async () => {
    const port = createSandboxSupplierAdapter({ mode: "timeout" });
    const res = await port.createOrder(BASE_CREATE);
    expect(res.kind).toBe("UNKNOWN");
    if (res.kind === "UNKNOWN") {
      expect(res.queryKey.length).toBeGreaterThan(0);
      expect(res.reason).toMatch(/timeout/i);
    }
  });

  it("queryOrder after UNKNOWN recovers the eventual result (query-before-retry)", async () => {
    const port = createSandboxSupplierAdapter({ mode: "timeout-then-fulfill" });
    const first = await port.createOrder(BASE_CREATE);
    expect(first.kind).toBe("UNKNOWN");
    if (first.kind !== "UNKNOWN") return;

    // Domain rule: do NOT re-create; query first.
    const queried = await port.queryOrder({ queryKey: first.queryKey });
    expect(queried.status).toBe("FULFILLED");
    if (queried.status === "FULFILLED") {
      expect(queried.assetEnvelope.vaultRef.startsWith("vault:")).toBe(true);
    }
  });

  it("a malformed fulfilled envelope is rejected by the schema (never delivered)", () => {
    // Adapter must never hand a raw-secret envelope past the boundary; the
    // schema is the last line of defense.
    expect(() =>
      parseAssetEnvelope({
        deliveryType: "CREDENTIAL",
        expectedSku: "X",
        region: "VN",
        durationCode: "P1M",
        expiresAt: null,
        supplierAssetId: "sa",
        fingerprint: "fp",
        vaultRef: "not-a-vault-ref",
        // smuggled secret field — stripped/rejected by allowlist
        secret: "user:pass",
      }),
    ).toThrow();
  });

  it("SupplierPortError is a stable typed error (no secret in message)", () => {
    const err = new SupplierPortError("SCHEMA_INVALID", "response failed schema validation");
    expect(err.supplierCode).toBe("SCHEMA_INVALID");
    expect(err.message).not.toMatch(/password|secret|token|key/i);
  });
});
