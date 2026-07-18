import { describe, expect, it } from "vitest";
import {
  createFulfillmentTelemetry,
  type FulfillmentTelemetry,
} from "../../src/modules/digital-goods/telemetry.js";

/**
 * T077 — Supplier/fulfillment metrics + alerts (FR-016, SR-006).
 *
 * Tracks supplier health, unknown-order age, invalid-asset quarantines,
 * fulfillment lag, and delivery reveals. Alerts fire on threshold crossings.
 * Payloads carry only references/counts — never a raw secret.
 */

function snap(t: FulfillmentTelemetry) {
  return t.snapshot();
}

describe("fulfillment telemetry (T077)", () => {
  it("counts invalid-asset quarantines and alerts at the threshold", () => {
    const t = createFulfillmentTelemetry({ invalidAssetAlertAt: 2 });
    t.recordInvalidAsset({ reasonCode: "SKU_MISMATCH" });
    expect(snap(t).invalidAssets).toBe(1);
    expect(snap(t).alerts).toHaveLength(0);
    t.recordInvalidAsset({ reasonCode: "EXPIRED" });
    expect(snap(t).alerts.some((a) => a.code === "INVALID_ASSET_THRESHOLD")).toBe(true);
  });

  it("tracks unknown supplier-order age and alerts beyond the SLA", () => {
    const t = createFulfillmentTelemetry({ unknownAgeAlertSeconds: 600 });
    t.recordUnknownAge({ supplierOrderId: "so-1", ageSeconds: 120 });
    expect(snap(t).alerts).toHaveLength(0);
    t.recordUnknownAge({ supplierOrderId: "so-2", ageSeconds: 900 });
    expect(snap(t).alerts.some((a) => a.code === "SUPPLIER_UNKNOWN_AGE")).toBe(true);
  });

  it("records fulfillment lag and alerts when it exceeds the SLA", () => {
    const t = createFulfillmentTelemetry({ fulfillmentLagAlertSeconds: 300 });
    t.recordFulfillmentLag({ orderId: "o1", lagSeconds: 60 });
    expect(snap(t).lastFulfillmentLagSeconds).toBe(60);
    expect(snap(t).alerts).toHaveLength(0);
    t.recordFulfillmentLag({ orderId: "o2", lagSeconds: 600 });
    expect(snap(t).alerts.some((a) => a.code === "FULFILLMENT_LAG")).toBe(true);
  });

  it("counts delivery reveals and supplier health failures", () => {
    const t = createFulfillmentTelemetry({ supplierFailureAlertAt: 3 });
    t.recordDeliveryReveal({ bundleId: "b1" });
    expect(snap(t).deliveryReveals).toBe(1);
    t.recordSupplierFailure({ supplier: "primary" });
    t.recordSupplierFailure({ supplier: "primary" });
    expect(snap(t).alerts).toHaveLength(0);
    t.recordSupplierFailure({ supplier: "primary" });
    expect(snap(t).alerts.some((a) => a.code === "SUPPLIER_HEALTH")).toBe(true);
  });

  it("never embeds a raw secret in an alert payload", () => {
    const t = createFulfillmentTelemetry({ invalidAssetAlertAt: 1 });
    t.recordInvalidAsset({
      reasonCode: "SKU_MISMATCH",
      // Attempt to smuggle secret-shaped fields; telemetry must drop them.
      vaultRef: "vault:leak",
      secret: "raw-secret-xyz",
    } as { reasonCode: "SKU_MISMATCH" });
    const blob = JSON.stringify(snap(t));
    expect(blob).not.toContain("raw-secret-xyz");
    expect(blob).not.toContain("vault:leak");
  });
});
