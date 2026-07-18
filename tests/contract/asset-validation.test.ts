import { describe, expect, it } from "vitest";
import { validateAssetEnvelope } from "../../src/modules/digital-goods/asset-validation.js";
import type { AssetEnvelope } from "../../src/modules/supplier/port.js";

/**
 * T070 — Supplier asset envelope validation + quarantine (FR-016).
 *
 * Supplier output must be validated for expected SKU/type, expiry/duration,
 * region, and usability before delivery. A mismatch quarantines the asset
 * (SUPPLIER_NEEDS_REVIEW) rather than delivering it. The validator is pure:
 * it compares a canonical envelope against the order's expectations and returns
 * an accept/quarantine decision with a stable reason code — never the secret.
 */

const BASE_ENVELOPE: AssetEnvelope = {
  deliveryType: "CREDENTIAL",
  expectedSku: "NF-1M-PREMIUM",
  region: "VN",
  durationCode: "P1M",
  expiresAt: null,
  supplierAssetId: "sa-1",
  fingerprint: "fp-abc",
  vaultRef: "vault:01TESTREF000000000000000",
};

const EXPECT = {
  expectedSku: "NF-1M-PREMIUM",
  deliveryType: "CREDENTIAL",
  durationCode: "P1M",
  region: "VN",
  now: new Date("2026-07-16T00:00:00.000Z"),
};

describe("asset envelope validation (FR-016)", () => {
  it("accepts a matching envelope", () => {
    const decision = validateAssetEnvelope(BASE_ENVELOPE, EXPECT);
    expect(decision.ok).toBe(true);
  });

  it("quarantines a SKU mismatch", () => {
    const decision = validateAssetEnvelope({ ...BASE_ENVELOPE, expectedSku: "OTHER-SKU" }, EXPECT);
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.reasonCode).toBe("SKU_MISMATCH");
  });

  it("quarantines a delivery-type mismatch", () => {
    const decision = validateAssetEnvelope({ ...BASE_ENVELOPE, deliveryType: "LICENSE" }, EXPECT);
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.reasonCode).toBe("DELIVERY_TYPE_MISMATCH");
  });

  it("quarantines a duration mismatch", () => {
    const decision = validateAssetEnvelope({ ...BASE_ENVELOPE, durationCode: "P12M" }, EXPECT);
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.reasonCode).toBe("DURATION_MISMATCH");
  });

  it("quarantines a wrong-region asset", () => {
    const decision = validateAssetEnvelope({ ...BASE_ENVELOPE, region: "US" }, EXPECT);
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.reasonCode).toBe("REGION_MISMATCH");
  });

  it("allows a null region when no region is expected", () => {
    const decision = validateAssetEnvelope(
      { ...BASE_ENVELOPE, region: null },
      { ...EXPECT, region: null },
    );
    expect(decision.ok).toBe(true);
  });

  it("quarantines an already-expired asset", () => {
    const decision = validateAssetEnvelope(
      { ...BASE_ENVELOPE, expiresAt: "2026-07-15T00:00:00.000Z" },
      EXPECT,
    );
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.reasonCode).toBe("EXPIRED");
  });

  it("accepts an asset expiring in the future", () => {
    const decision = validateAssetEnvelope(
      { ...BASE_ENVELOPE, expiresAt: "2026-08-16T00:00:00.000Z" },
      EXPECT,
    );
    expect(decision.ok).toBe(true);
  });

  it("never echoes the vault ref or any secret in a quarantine reason", () => {
    const decision = validateAssetEnvelope({ ...BASE_ENVELOPE, expectedSku: "X" }, EXPECT);
    if (!decision.ok) {
      expect(decision.reason).not.toContain(BASE_ENVELOPE.vaultRef);
      expect(decision.reason.toLowerCase()).not.toMatch(/secret|password|token/);
    }
  });
});
