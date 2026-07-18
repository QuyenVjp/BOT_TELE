/**
 * Supplier telemetry re-export (T077).
 *
 * Supplier health / unknown-age / invalid-asset / fulfillment-lag counters live
 * on the shared fulfillment telemetry port so one sink covers both the supplier
 * and digital-goods paths. This module re-exports that port under the supplier
 * package so callers can depend on either surface.
 */

export {
  createFulfillmentTelemetry as createSupplierTelemetry,
  type FulfillmentTelemetry as SupplierTelemetry,
  type FulfillmentTelemetryOptions as SupplierTelemetryOptions,
  type FulfillmentTelemetrySnapshot as SupplierTelemetrySnapshot,
  type FulfillmentAlert as SupplierAlert,
  type FulfillmentAlertCode as SupplierAlertCode,
} from "../digital-goods/telemetry.js";
