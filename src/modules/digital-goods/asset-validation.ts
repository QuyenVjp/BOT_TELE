import type { AssetEnvelope } from "../supplier/port.js";

/**
 * Supplier asset envelope validation + quarantine decision (T070, FR-016).
 *
 * Pure function: given a schema-validated envelope and the Order's expected
 * SKU/type/duration/region, decide accept vs quarantine. A mismatch never
 * reaches delivery — the orchestrator maps quarantine to SUPPLIER_NEEDS_REVIEW
 * on the asset and FULFILLMENT_NEEDS_REVIEW on the order.
 *
 * The decision payload carries only stable reason codes and a non-secret
 * human message. Vault refs and fingerprints are deliberately excluded so a
 * quarantine log/event can never smuggle a secret.
 */

export type QuarantineReasonCode =
  | "SKU_MISMATCH"
  | "DELIVERY_TYPE_MISMATCH"
  | "DURATION_MISMATCH"
  | "REGION_MISMATCH"
  | "EXPIRED"
  | "UNUSABLE";

export type ValidationDecision =
  { ok: true } | { ok: false; reasonCode: QuarantineReasonCode; reason: string };

export interface ValidationExpectations {
  expectedSku: string;
  deliveryType: string;
  durationCode: string;
  /** null means "no region constraint". */
  region: string | null;
  /** Injectable clock for deterministic expiry tests. */
  now?: Date;
}

/**
 * Validate a supplier asset envelope against the order's expectations.
 * Fail-closed: any mismatch returns a quarantine decision.
 */
export function validateAssetEnvelope(
  envelope: AssetEnvelope,
  expect: ValidationExpectations,
): ValidationDecision {
  if (envelope.expectedSku !== expect.expectedSku) {
    return {
      ok: false,
      reasonCode: "SKU_MISMATCH",
      reason: "Asset SKU does not match the ordered variant",
    };
  }
  if (envelope.deliveryType !== expect.deliveryType) {
    return {
      ok: false,
      reasonCode: "DELIVERY_TYPE_MISMATCH",
      reason: "Asset delivery type does not match the ordered variant",
    };
  }
  if (envelope.durationCode !== expect.durationCode) {
    return {
      ok: false,
      reasonCode: "DURATION_MISMATCH",
      reason: "Asset duration does not match the ordered variant",
    };
  }
  // Region: when the order expects a region, the envelope must match exactly.
  // When the order has no region constraint, any envelope region (incl. null) is fine.
  if (expect.region !== null && envelope.region !== expect.region) {
    return {
      ok: false,
      reasonCode: "REGION_MISMATCH",
      reason: "Asset region does not match the ordered region",
    };
  }
  if (envelope.expiresAt) {
    const now = expect.now ?? new Date();
    const exp = new Date(envelope.expiresAt);
    if (!Number.isNaN(exp.getTime()) && exp.getTime() <= now.getTime()) {
      return {
        ok: false,
        reasonCode: "EXPIRED",
        reason: "Asset already expired before delivery",
      };
    }
  }
  return { ok: true };
}
