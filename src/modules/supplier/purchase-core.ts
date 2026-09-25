import { createHash } from "node:crypto";
import {
  hasSupplierCapability,
  SupplierPortError,
  type AssetEnvelope,
  type CreateOrderResult,
  type QueryOrderResult,
  type SupplierPort,
  type SupplierProvider,
} from "./port.js";

export type SupplierPurchaseRecordStatus =
  "AUTHORIZED" | "SUBMITTED" | "PENDING" | "FULFILLED" | "REJECTED" | "UNKNOWN";

export interface SupplierPurchaseRecord {
  id: string;
  supplierId: string;
  supplierSkuId: string;
  requestReference: string;
  idempotencyKey: string;
  requestFingerprint: string;
  status: SupplierPurchaseRecordStatus;
  externalOrderId: string | null;
  queryKey?: string | null;
  costVndSnapshot: number;
  version: number;
  responseFingerprint?: string | null;
  blockCode?: string | null;
}

export interface SupplierPurchaseInsertInput {
  supplierId: string;
  supplierSkuId: string;
  requestReference: string;
  idempotencyKey: string;
  requestFingerprint: string;
  costCeilingVnd: number;
}

export interface SupplierPurchaseRecordStore {
  findByIdempotency(input: {
    supplierId: string;
    idempotencyKey: string;
  }): Promise<SupplierPurchaseRecord | null>;
  findById(id: string): Promise<SupplierPurchaseRecord | null>;
  insertIntent(input: SupplierPurchaseInsertInput): Promise<{
    inserted: boolean;
    record: SupplierPurchaseRecord;
  }>;
  refreshIntent(
    id: string,
    input: { costCeilingVnd: number; externalSku?: string; region?: string | null },
  ): Promise<void>;
  markAttempt(id: string): Promise<boolean>;
  markTransportFailure(
    id: string,
    input: { code: string; retryAfterSeconds?: number | null },
  ): Promise<void>;
  markResponse(id: string, fingerprint: string): Promise<void>;
  markUnknown(id: string, input: { queryKey: string; reason: string }): Promise<void>;
  markPending(id: string, externalOrderId: string): Promise<void>;
  markFulfilled(id: string, externalOrderId: string): Promise<void>;
  markRejected(id: string): Promise<void>;
  markNeedsReview(id: string, code: string): Promise<void>;
  markBlocked(id: string, code: string): Promise<void>;
}

export type SupplierPurchasePreSubmitDecision =
  | {
      ok: true;
      costCeilingVnd: number;
      externalSku?: string;
      region?: string | null;
    }
  | { ok: false; code: string };
export interface SupplierPurchaseFulfillmentInput {
  record: SupplierPurchaseRecord;
  externalOrderId: string;
  assetEnvelope: AssetEnvelope;
}

export type SupplierPurchaseFulfillmentHandler = (
  input: SupplierPurchaseFulfillmentInput,
) => Promise<void>;

export interface SupplierPurchaseInput {
  supplierId: string;
  supplierSkuId: string;
  requestReference: string;
  externalSku: string;
  costCeilingVnd: number;
  idempotencyKey: string;
  correlationId: string;
  region: string | null;
  port: SupplierPort | SupplierProvider;
  store: SupplierPurchaseRecordStore;
  /** Required runtime gate. A false value prevents even intent creation. */
  purchaseEnabled: boolean;
  /** Re-read all caller-specific gates immediately before the upstream POST. */
  beforeCreate?: () => Promise<SupplierPurchasePreSubmitDecision>;
  onFulfilled?: SupplierPurchaseFulfillmentHandler;
}

export type SupplierPurchaseResult =
  | { kind: "BLOCKED"; code: string; record: SupplierPurchaseRecord | null }
  | { kind: "UNKNOWN"; record: SupplierPurchaseRecord; queryKey: string }
  | { kind: "ACCEPTED"; record: SupplierPurchaseRecord; externalOrderId: string }
  | {
      kind: "FULFILLED";
      record: SupplierPurchaseRecord;
      externalOrderId: string;
      assetEnvelope: AssetEnvelope;
    }
  | { kind: "REJECTED"; record: SupplierPurchaseRecord }
  | { kind: "REPLAY"; record: SupplierPurchaseRecord };

function requestFingerprint(input: SupplierPurchaseInput): string {
  return createHash("sha256")
    .update(
      `${input.supplierId}|${input.supplierSkuId}|${input.requestReference}|${input.idempotencyKey}|${input.externalSku}|${input.costCeilingVnd}`,
      "utf8",
    )
    .digest("hex");
}

function isAmbiguousTransport(error: unknown): error is SupplierPortError {
  return (
    error instanceof SupplierPortError &&
    ["TRANSPORT_TIMEOUT", "TRANSPORT_ERROR", "DNS_RESOLUTION_FAILED"].includes(error.supplierCode)
  );
}

function responseFingerprint(value: CreateOrderResult | QueryOrderResult): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function hasCreateCapability(port: SupplierPort | SupplierProvider): boolean {
  return !("capabilities" in port && !hasSupplierCapability(port, "ORDER_CREATE"));
}

function hasReadCapability(port: SupplierPort | SupplierProvider): boolean {
  return !("capabilities" in port && !hasSupplierCapability(port, "ORDER_READ"));
}

function unknownResult(record: SupplierPurchaseRecord, queryKey: string): SupplierPurchaseResult {
  return { kind: "UNKNOWN", record, queryKey };
}

export async function executeSupplierPurchase(
  input: SupplierPurchaseInput,
): Promise<SupplierPurchaseResult> {
  if (input.purchaseEnabled !== true) {
    return { kind: "BLOCKED", code: "PURCHASE_DISABLED", record: null };
  }
  if (!hasCreateCapability(input.port)) {
    return { kind: "BLOCKED", code: "ORDER_CREATE_UNSUPPORTED", record: null };
  }

  const existing = await input.store.findByIdempotency({
    supplierId: input.supplierId,
    idempotencyKey: input.idempotencyKey,
  });
  if (existing) {
    if (existing.status === "FULFILLED" || existing.status === "REJECTED") {
      return { kind: "REPLAY", record: existing };
    }
    if (existing.status === "UNKNOWN" || existing.status === "PENDING") {
      return recoverSupplierPurchase({
        store: input.store,
        recordId: existing.id,
        queryKey: existing.queryKey ?? existing.externalOrderId ?? input.idempotencyKey,
        port: input.port,
        ...(input.onFulfilled ? { onFulfilled: input.onFulfilled } : {}),
      });
    }
    if (existing.status === "SUBMITTED") {
      return unknownResult(
        existing,
        existing.queryKey ?? existing.externalOrderId ?? input.idempotencyKey,
      );
    }
    // AUTHORIZED is the canary post-confirmation state. It is the only existing
    // state that may proceed to create without inserting a second intent.
    if (existing.status !== "AUTHORIZED") {
      return unknownResult(
        existing,
        existing.queryKey ?? existing.externalOrderId ?? input.idempotencyKey,
      );
    }
  }

  let record: SupplierPurchaseRecord;
  let inserted = false;
  if (existing) {
    record = existing;
  } else {
    const claimed = await input.store.insertIntent({
      supplierId: input.supplierId,
      supplierSkuId: input.supplierSkuId,
      requestReference: input.requestReference,
      idempotencyKey: input.idempotencyKey,
      requestFingerprint: requestFingerprint(input),
      costCeilingVnd: input.costCeilingVnd,
    });
    record = claimed.record;
    inserted = claimed.inserted;
    if (!inserted) {
      if (record.status === "FULFILLED" || record.status === "REJECTED") {
        return { kind: "REPLAY", record };
      }
      return unknownResult(
        record,
        record.queryKey ?? record.externalOrderId ?? input.idempotencyKey,
      );
    }
  }

  const beforeCreate = input.beforeCreate
    ? await input.beforeCreate()
    : ({
        ok: true,
        costCeilingVnd: input.costCeilingVnd,
      } satisfies SupplierPurchasePreSubmitDecision);
  if (!beforeCreate.ok) {
    await input.store.markBlocked(record.id, beforeCreate.code);
    const blocked = await input.store.findById(record.id);
    return { kind: "BLOCKED", code: beforeCreate.code, record: blocked ?? record };
  }

  const externalSku = beforeCreate.externalSku ?? input.externalSku;
  const region = beforeCreate.region === undefined ? input.region : beforeCreate.region;
  await input.store.refreshIntent(record.id, {
    costCeilingVnd: beforeCreate.costCeilingVnd,
    externalSku,
    region,
  });
  const claimed = await input.store.markAttempt(record.id);
  if (!claimed) {
    const current = await input.store.findById(record.id);
    return unknownResult(current ?? record, current?.externalOrderId ?? input.idempotencyKey);
  }

  let result: CreateOrderResult;
  try {
    result = await input.port.createOrder({
      idempotencyKey: input.idempotencyKey,
      supplierSku: externalSku,
      costCeilingVnd: beforeCreate.costCeilingVnd,
      orderId: input.requestReference,
      ...(region === null ? {} : { region: region ?? undefined }),
    });
  } catch (error) {
    if (!isAmbiguousTransport(error)) throw error;
    const retryAfterSeconds = (error as SupplierPortError & { retryAfterSeconds?: unknown })
      .retryAfterSeconds;
    await input.store.markTransportFailure(record.id, {
      code: error.supplierCode,
      retryAfterSeconds:
        typeof retryAfterSeconds === "number" && Number.isInteger(retryAfterSeconds)
          ? retryAfterSeconds
          : null,
    });
    await input.store.markUnknown(record.id, {
      queryKey: input.idempotencyKey,
      reason: error.supplierCode,
    });
    const uncertain = await input.store.findById(record.id);
    return unknownResult(uncertain ?? record, input.idempotencyKey);
  }

  await input.store.markResponse(record.id, responseFingerprint(result));
  switch (result.kind) {
    case "FULFILLED":
      if (input.onFulfilled) {
        await input.onFulfilled({
          record,
          externalOrderId: result.externalOrderId,
          assetEnvelope: result.assetEnvelope,
        });
      }
      await input.store.markFulfilled(record.id, result.externalOrderId);
      return {
        kind: "FULFILLED",
        record: (await input.store.findById(record.id)) ?? record,
        externalOrderId: result.externalOrderId,
        assetEnvelope: result.assetEnvelope,
      };
    case "UNKNOWN":
      await input.store.markUnknown(record.id, {
        queryKey: result.queryKey,
        reason: result.reason,
      });
      return unknownResult((await input.store.findById(record.id)) ?? record, result.queryKey);
    case "REJECTED":
      await input.store.markRejected(record.id);
      return { kind: "REJECTED", record: (await input.store.findById(record.id)) ?? record };
    case "ACCEPTED":
      await input.store.markPending(record.id, result.externalOrderId);
      return {
        kind: "ACCEPTED",
        record: (await input.store.findById(record.id)) ?? record,
        externalOrderId: result.externalOrderId,
      };
  }
}

export async function recoverSupplierPurchase(input: {
  store: SupplierPurchaseRecordStore;
  recordId: string;
  queryKey: string;
  port: SupplierPort | SupplierProvider;
  onFulfilled?: SupplierPurchaseFulfillmentHandler;
}): Promise<SupplierPurchaseResult> {
  const record = await input.store.findById(input.recordId);
  if (!record) return { kind: "BLOCKED", code: "NOT_FOUND", record: null };
  if (record.status === "FULFILLED" || record.status === "REJECTED") {
    return { kind: "REPLAY", record };
  }
  if (!hasReadCapability(input.port)) {
    await input.store.markNeedsReview(record.id, "ORDER_READ_UNSUPPORTED");
    return { kind: "BLOCKED", code: "ORDER_READ_UNSUPPORTED", record };
  }

  let observed: QueryOrderResult;
  try {
    const queryKey = record.queryKey ?? (record.status === "UNKNOWN" ? input.queryKey : null);
    observed = await input.port.queryOrder({
      ...(record.externalOrderId && queryKey === null
        ? { externalOrderId: record.externalOrderId }
        : {}),
      ...(queryKey !== null ? { queryKey } : {}),
    });
  } catch (error) {
    if (error instanceof SupplierPortError && error.supplierCode === "DELIVERY_UNSUPPORTED") {
      await input.store.markNeedsReview(record.id, "DELIVERY_UNSUPPORTED");
      return { kind: "BLOCKED", code: "DELIVERY_UNSUPPORTED", record };
    }
    throw error;
  }

  await input.store.markResponse(record.id, responseFingerprint(observed));
  switch (observed.status) {
    case "FULFILLED":
      if (input.onFulfilled) {
        await input.onFulfilled({
          record,
          externalOrderId: observed.externalOrderId,
          assetEnvelope: observed.assetEnvelope,
        });
      }
      await input.store.markFulfilled(record.id, observed.externalOrderId);
      return {
        kind: "FULFILLED",
        record: (await input.store.findById(record.id)) ?? record,
        externalOrderId: observed.externalOrderId,
        assetEnvelope: observed.assetEnvelope,
      };
    case "REJECTED":
    case "CANCELLED":
    case "REFUNDED":
      await input.store.markRejected(record.id);
      return { kind: "REJECTED", record: (await input.store.findById(record.id)) ?? record };
    case "PENDING":
      await input.store.markPending(record.id, observed.externalOrderId);
      return unknownResult(
        (await input.store.findById(record.id)) ?? record,
        observed.externalOrderId,
      );
  }
}
