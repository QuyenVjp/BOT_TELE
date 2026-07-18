import { newId } from "../ids/index.js";
import { nowUtc } from "../time/index.js";

/**
 * Domain event envelope (contracts/application-commands.md "Domain events").
 *
 * Events are at-least-once and carry NO raw secret. Consumers deduplicate by
 * `eventId` plus aggregate version, and business-effect consumers additionally
 * enforce a domain unique key (settled bank transaction, supplier idempotency
 * key, claimed asset, active delivery bundle).
 */

/** Closed set of event types this MVP emits. */
export const EVENT_TYPES = [
  "OrderCreated",
  "PaymentIntentPresented",
  "PaymentSettled",
  "PaymentNeedsReview",
  "OrderPaid",
  "SupplierFulfillmentRequested",
  "SupplierOrderUnknown",
  "SupplierAssetReady",
  "DigitalAssetClaimed",
  "DeliveryBundleCreated",
  "DigitalAssetDelivered",
  "TicketOpened",
  "ReplacementRequested",
  "RefundRequested",
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

export interface EventEnvelope<TPayload = Record<string, unknown>> {
  eventId: string;
  type: EventType | string;
  aggregateType: string;
  aggregateId: string;
  aggregateVersion: number;
  correlationId: string;
  occurredAt: string;
  payload: TPayload;
}

export interface MakeEventInput<TPayload> {
  aggregateType: string;
  aggregateId: string;
  aggregateVersion: number;
  correlationId: string;
  payload: TPayload;
  /** Override for deterministic tests / replay import. */
  eventId?: string;
  occurredAt?: string;
}

export function makeEventEnvelope<TPayload>(
  type: EventType | string,
  input: MakeEventInput<TPayload>,
): EventEnvelope<TPayload> {
  return {
    eventId: input.eventId ?? newId(),
    type,
    aggregateType: input.aggregateType,
    aggregateId: input.aggregateId,
    aggregateVersion: input.aggregateVersion,
    correlationId: input.correlationId,
    occurredAt: input.occurredAt ?? nowUtc().toISOString(),
    payload: input.payload,
  };
}
