/**
 * Digital-goods domain: DigitalAsset + DeliveryBundle aggregates and guards
 * (FR-014, FR-017, SR-001, SR-003).
 *
 * A DigitalAsset holds a vault reference to secret material — never the
 * plaintext. Its lifecycle enforces single-allocation: an asset moves from
 * AVAILABLE to RESERVED (claimed by exactly one Order), then READY, then
 * DELIVERED. The unique active-fingerprint index makes double-allocation
 * impossible at the storage layer; these guards keep the transitions explicit.
 *
 * A DeliveryBundle binds one asset to one customer+order with a hashed reveal
 * token, an expiry, and view-once semantics (see delivery.md).
 */

export type AssetStatus =
  | "AVAILABLE"
  | "RESERVED"
  | "READY"
  | "DELIVERED"
  | "EXPIRED"
  | "PROVISIONING"
  | "SUPPLIER_NEEDS_REVIEW"
  | "FAILED"
  | "COMPROMISED"
  | "REVOKED";

export type AssetSourceType = "LOCAL" | "SUPPLIER";

export type DeliveryBundleStatus =
  "CREATED" | "AVAILABLE" | "VIEWED" | "CONSUMED" | "EXPIRED" | "REVOKED";

/** Statuses in which an asset is actively bound to an order (unique per fingerprint). */
export const ACTIVE_ASSET_STATUSES: readonly AssetStatus[] = ["RESERVED", "READY", "DELIVERED"];

/** True when the asset is bound to an order and cannot be claimed by another. */
export function isAssetActivelyHeld(status: AssetStatus): boolean {
  return ACTIVE_ASSET_STATUSES.includes(status);
}

const ASSET_ALLOWED: Record<AssetStatus, readonly AssetStatus[]> = {
  AVAILABLE: ["RESERVED", "EXPIRED", "REVOKED", "COMPROMISED"],
  PROVISIONING: ["READY", "SUPPLIER_NEEDS_REVIEW", "FAILED", "REVOKED"],
  RESERVED: ["READY", "AVAILABLE", "DELIVERED", "EXPIRED", "REVOKED", "COMPROMISED"],
  READY: ["DELIVERED", "AVAILABLE", "EXPIRED", "REVOKED", "COMPROMISED"],
  DELIVERED: ["REVOKED", "COMPROMISED"],
  SUPPLIER_NEEDS_REVIEW: ["READY", "FAILED", "REVOKED"],
  EXPIRED: [],
  FAILED: [],
  COMPROMISED: [],
  REVOKED: [],
};

export function canAssetTransition(from: AssetStatus, to: AssetStatus): boolean {
  return (ASSET_ALLOWED[from] ?? []).includes(to);
}

export function assertAssetTransition(from: AssetStatus, to: AssetStatus): void {
  if (!canAssetTransition(from, to)) {
    throw new Error(`Illegal asset transition ${from} -> ${to}`);
  }
}

/** Statuses in which a delivery bundle is still live (one active per order). */
export const ACTIVE_BUNDLE_STATUSES: readonly DeliveryBundleStatus[] = [
  "CREATED",
  "AVAILABLE",
  "VIEWED",
];

/** A bundle that may still reveal its secret (not consumed/expired/revoked). */
export function isBundleRevealable(status: DeliveryBundleStatus): boolean {
  return status === "CREATED" || status === "AVAILABLE" || status === "VIEWED";
}
