/**
 * Fulfillment + supplier telemetry/alerts (T077, FR-016, SR-001).
 *
 * In-process counters for invalid-asset quarantines, unknown-order age,
 * fulfillment lag, delivery reveals, and supplier health failures. Alerts fire
 * when a threshold is crossed. Payloads are deliberately allowlisted — vault
 * refs and raw secrets are never retained.
 */

export type FulfillmentAlertCode =
  "INVALID_ASSET_THRESHOLD" | "SUPPLIER_UNKNOWN_AGE" | "FULFILLMENT_LAG" | "SUPPLIER_HEALTH";

export interface FulfillmentAlert {
  code: FulfillmentAlertCode;
  message: string;
  context: Record<string, string | number | boolean | null>;
  at: string;
}

export interface FulfillmentTelemetrySnapshot {
  invalidAssets: number;
  supplierFailures: number;
  deliveryReveals: number;
  lastFulfillmentLagSeconds: number | null;
  lastUnknownAgeSeconds: number | null;
  alerts: FulfillmentAlert[];
}

export interface FulfillmentTelemetryOptions {
  invalidAssetAlertAt?: number;
  supplierFailureAlertAt?: number;
  unknownAgeAlertSeconds?: number;
  fulfillmentLagAlertSeconds?: number;
  now?: () => Date;
}

export interface FulfillmentTelemetry {
  recordInvalidAsset(input: { reasonCode: string }): void;
  recordUnknownAge(input: { supplierOrderId: string; ageSeconds: number }): void;
  recordFulfillmentLag(input: { orderId: string; lagSeconds: number }): void;
  recordDeliveryReveal(input: { bundleId: string }): void;
  recordSupplierFailure(input: { supplier: string }): void;
  snapshot(): FulfillmentTelemetrySnapshot;
  reset(): void;
}

const DEFAULTS = {
  invalidAssetAlertAt: 10,
  supplierFailureAlertAt: 10,
  unknownAgeAlertSeconds: 900,
  fulfillmentLagAlertSeconds: 600,
} as const;

export function createFulfillmentTelemetry(
  options: FulfillmentTelemetryOptions = {},
): FulfillmentTelemetry {
  const invalidAssetAlertAt = options.invalidAssetAlertAt ?? DEFAULTS.invalidAssetAlertAt;
  const supplierFailureAlertAt = options.supplierFailureAlertAt ?? DEFAULTS.supplierFailureAlertAt;
  const unknownAgeAlertSeconds = options.unknownAgeAlertSeconds ?? DEFAULTS.unknownAgeAlertSeconds;
  const fulfillmentLagAlertSeconds =
    options.fulfillmentLagAlertSeconds ?? DEFAULTS.fulfillmentLagAlertSeconds;
  const clock = options.now ?? (() => new Date());

  let invalidAssets = 0;
  let supplierFailures = 0;
  let deliveryReveals = 0;
  let lastFulfillmentLagSeconds: number | null = null;
  let lastUnknownAgeSeconds: number | null = null;
  const alerts: FulfillmentAlert[] = [];

  function push(
    code: FulfillmentAlertCode,
    message: string,
    context: FulfillmentAlert["context"],
  ): void {
    const idx = alerts.findIndex((a) => a.code === code);
    const alert: FulfillmentAlert = {
      code,
      message,
      context,
      at: clock().toISOString(),
    };
    if (idx >= 0) alerts[idx] = alert;
    else alerts.push(alert);
  }

  return {
    recordInvalidAsset(input) {
      invalidAssets += 1;
      if (invalidAssets >= invalidAssetAlertAt) {
        push("INVALID_ASSET_THRESHOLD", "Invalid supplier assets exceeded threshold", {
          count: invalidAssets,
          // Allowlisted: reason code only, never a vault ref / secret.
          reasonCode: input.reasonCode,
        });
      }
    },

    recordUnknownAge(input) {
      lastUnknownAgeSeconds = input.ageSeconds;
      if (input.ageSeconds >= unknownAgeAlertSeconds) {
        push("SUPPLIER_UNKNOWN_AGE", "Supplier order has been UNKNOWN beyond SLA", {
          supplierOrderId: input.supplierOrderId,
          ageSeconds: input.ageSeconds,
        });
      }
    },

    recordFulfillmentLag(input) {
      lastFulfillmentLagSeconds = input.lagSeconds;
      if (input.lagSeconds >= fulfillmentLagAlertSeconds) {
        push("FULFILLMENT_LAG", "Paid-to-delivery lag exceeds SLA window", {
          orderId: input.orderId,
          lagSeconds: input.lagSeconds,
        });
      }
    },

    recordDeliveryReveal() {
      deliveryReveals += 1;
      // No alert on every reveal — volume counter only.
    },

    recordSupplierFailure(input) {
      supplierFailures += 1;
      if (supplierFailures >= supplierFailureAlertAt) {
        push("SUPPLIER_HEALTH", "Supplier failures exceeded threshold", {
          count: supplierFailures,
          supplier: input.supplier,
        });
      }
    },

    snapshot() {
      return {
        invalidAssets,
        supplierFailures,
        deliveryReveals,
        lastFulfillmentLagSeconds,
        lastUnknownAgeSeconds,
        alerts: alerts.map((a) => ({ ...a, context: { ...a.context } })),
      };
    },

    reset() {
      invalidAssets = 0;
      supplierFailures = 0;
      deliveryReveals = 0;
      lastFulfillmentLagSeconds = null;
      lastUnknownAgeSeconds = null;
      alerts.length = 0;
    },
  };
}
