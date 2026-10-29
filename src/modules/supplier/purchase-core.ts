import { createHash } from "node:crypto";
import {
  parseCreateOrderResult,
  parseQueryOrderResult,
  isSupplierProviderFor,
  SupplierPortError,
  type AssetEnvelope,
  type CreateOrderResult,
  type QueryOrderResult,
  type SupplierPort,
  type SupplierProvider,
} from "./port.js";
import type { SupplierOrderStatus } from "./domain.js";

export const SUPPLIER_SUBMITTED_GRACE_SECONDS = 60;
export const SUPPLIER_REQUEST_FINGERPRINT_VERSION_V1 = 1 as const;
export const SUPPLIER_REQUEST_FINGERPRINT_VERSION_V2 = 2 as const;

export type SupplierPurchaseRecordStatus = SupplierOrderStatus | "AUTHORIZED" | "UNRECOGNIZED";

export interface SupplierPurchaseRecord {
  id: string;
  supplierId: string;
  supplierSkuId: string;
  requestReference: string;
  idempotencyKey: string;
  requestFingerprint: string;
  requestFingerprintVersion?: number | null;
  status: SupplierPurchaseRecordStatus;
  externalOrderId: string | null;
  queryKey?: string | null;
  submittedAt?: Date | string | null;
  needsReviewAt?: Date | string | null;
  costVndSnapshot: number;
  version: number;
  responseFingerprint?: string | null;
  attemptCount?: number;
  blockCode?: string | null;
}

export interface SupplierPurchaseInsertInput {
  supplierId: string;
  supplierSkuId: string;
  requestReference: string;
  idempotencyKey: string;
  requestFingerprint: string;
  requestFingerprintVersion?: number;
  costCeilingVnd: number;
  salePriceVnd?: number;
}

export interface SupplierPurchaseRecordStore {
  findByIdempotency(input: {
    supplierId: string;
    idempotencyKey: string;
  }): Promise<SupplierPurchaseRecord | null>;
  findById(id: string): Promise<SupplierPurchaseRecord | null>;
  insertIntent(
    input: SupplierPurchaseInsertInput,
  ): Promise<{ inserted: boolean; record: SupplierPurchaseRecord }>;
  markAttempt(
    id: string,
    input: {
      costCeilingVnd: number;
      requestFingerprint: string;
      requestFingerprintVersion: number;
    },
  ): Promise<boolean>;
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
  | { ok: true; costCeilingVnd: number; externalSku?: string; region?: string | null }
  | { ok: false; code: string };

export interface SupplierPurchaseFulfillmentInput {
  record: SupplierPurchaseRecord;
  externalOrderId: string;
  assetEnvelope: AssetEnvelope;
}
export type SupplierPurchaseFulfillmentHandler = (
  input: SupplierPurchaseFulfillmentInput,
) => Promise<boolean | void>;
export interface SupplierPurchasePostValues {
  externalSku: string;
  costCeilingVnd: number;
  region: string | null;
}
type SupplierPurchaseQueryDecision = { ok: true } | { ok: false; code: string };

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
  purchaseEnabled: boolean;
  beforeCreate?: () => Promise<SupplierPurchasePreSubmitDecision>;
  beforePost?: () => Promise<SupplierPurchasePreSubmitDecision>;
  beforeQuery?: () => Promise<boolean | SupplierPurchaseQueryDecision>;
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

export function supplierPurchaseRequestFingerprintV1(
  input: Pick<
    SupplierPurchaseInput,
    | "supplierId"
    | "supplierSkuId"
    | "requestReference"
    | "idempotencyKey"
    | "externalSku"
    | "costCeilingVnd"
  >,
): string {
  return createHash("sha256")
    .update(
      `${input.supplierId}|${input.supplierSkuId}|${input.requestReference}|${input.idempotencyKey}|${input.externalSku}|${input.costCeilingVnd}`,
      "utf8",
    )
    .digest("hex");
}

export function supplierPurchaseRequestFingerprint(
  input: Pick<
    SupplierPurchaseInput,
    | "supplierId"
    | "supplierSkuId"
    | "requestReference"
    | "idempotencyKey"
    | "externalSku"
    | "costCeilingVnd"
    | "region"
  >,
): string {
  return createHash("sha256")
    .update(
      `${input.supplierId}|${input.supplierSkuId}|${input.requestReference}|${input.idempotencyKey}|${input.externalSku}|${input.costCeilingVnd}|${input.region}`,
      "utf8",
    )
    .digest("hex");
}

function responseFingerprint(value: CreateOrderResult | QueryOrderResult): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function isAmbiguousTransport(error: unknown): error is SupplierPortError {
  return (
    error instanceof SupplierPortError &&
    ["TRANSPORT_TIMEOUT", "TRANSPORT_ERROR", "DNS_RESOLUTION_FAILED"].includes(error.supplierCode)
  );
}

function hasCreateCapability(port: SupplierPort | SupplierProvider): boolean {
  return (
    !("capabilities" in port) ||
    (port.capabilities instanceof Set && port.capabilities.has("ORDER_CREATE"))
  );
}
function hasReadCapability(port: SupplierPort | SupplierProvider): boolean {
  return (
    !("capabilities" in port) ||
    (port.capabilities instanceof Set && port.capabilities.has("ORDER_READ"))
  );
}

function durableQueryKey(record: SupplierPurchaseRecord): string | null {
  if (typeof record.queryKey === "string" && record.queryKey.trim()) return record.queryKey;
  if (typeof record.externalOrderId === "string" && record.externalOrderId.trim())
    return record.externalOrderId;
  return null;
}

function submittedWithinGrace(record: SupplierPurchaseRecord): boolean {
  if (record.status !== "SUBMITTED" || record.submittedAt == null) return false;
  const submittedAt =
    record.submittedAt instanceof Date
      ? record.submittedAt.getTime()
      : Date.parse(record.submittedAt);
  return (
    Number.isFinite(submittedAt) &&
    Date.now() - submittedAt < SUPPLIER_SUBMITTED_GRACE_SECONDS * 1_000
  );
}

function matchesIntent(record: SupplierPurchaseRecord, input: SupplierPurchaseInput): boolean {
  return (
    record.supplierSkuId === input.supplierSkuId &&
    record.requestReference === input.requestReference
  );
}

function blockedByReview(record: SupplierPurchaseRecord): SupplierPurchaseResult | null {
  return record.needsReviewAt == null
    ? null
    : { kind: "BLOCKED", code: "SUPPLIER_ORDER_NOT_QUERYABLE", record };
}

function unknownResult(record: SupplierPurchaseRecord, queryKey: string): SupplierPurchaseResult {
  return { kind: "UNKNOWN", record, queryKey };
}

async function markNeedsReviewAndReload(
  store: SupplierPurchaseRecordStore,
  record: SupplierPurchaseRecord,
  code: string,
): Promise<SupplierPurchaseResult> {
  await store.markNeedsReview(record.id, code);
  return { kind: "BLOCKED", code, record: (await store.findById(record.id)) ?? record };
}

async function markRejectedAndReload(
  store: SupplierPurchaseRecordStore,
  record: SupplierPurchaseRecord,
): Promise<SupplierPurchaseResult> {
  await store.markRejected(record.id);
  const current = (await store.findById(record.id)) ?? record;
  return current.status === "FULFILLED"
    ? { kind: "REPLAY", record: current }
    : { kind: "REJECTED", record: current };
}

function resultAfterClaimLoss(
  current: SupplierPurchaseRecord | null,
  fallback: SupplierPurchaseRecord,
  fallbackQueryKey: string,
): SupplierPurchaseResult {
  if (!current) return unknownResult(fallback, fallbackQueryKey);
  if (current.status === "FULFILLED") return { kind: "REPLAY", record: current };
  if (current.status === "REJECTED") return { kind: "REJECTED", record: current };
  const review = blockedByReview(current);
  if (review) return review;
  if (["PENDING", "UNKNOWN", "SUBMITTED", "AUTHORIZED"].includes(current.status)) {
    return unknownResult(current, current.queryKey ?? fallbackQueryKey);
  }
  return { kind: "BLOCKED", code: "SUPPLIER_ORDER_NOT_ELIGIBLE", record: current };
}

export async function postClaimedSupplierPurchase(
  input: SupplierPurchaseInput,
  record: SupplierPurchaseRecord,
  values: SupplierPurchasePostValues,
  beforePost?: () => Promise<SupplierPurchasePreSubmitDecision>,
): Promise<SupplierPurchaseResult> {
  if (!matchesIntent(record, input))
    return { kind: "BLOCKED", code: "SUPPLIER_ORDER_NOT_ELIGIBLE", record };
  if (!isSupplierProviderFor(input.port, input.supplierId)) {
    return { kind: "BLOCKED", code: "SUPPLIER_PROVIDER_MISMATCH", record };
  }
  if (input.purchaseEnabled !== true) return { kind: "BLOCKED", code: "PURCHASE_DISABLED", record };
  if (beforePost) {
    const latest = await beforePost();
    if (!latest.ok) return markNeedsReviewAndReload(input.store, record, latest.code);
    const latestSku = latest.externalSku ?? values.externalSku;
    const latestRegion = latest.region === undefined ? values.region : latest.region;
    if (
      latestSku !== values.externalSku ||
      latest.costCeilingVnd !== values.costCeilingVnd ||
      latestRegion !== values.region
    ) {
      return markNeedsReviewAndReload(input.store, record, "SUPPLIER_MAPPING_CHANGED");
    }
  }
  if (!hasCreateCapability(input.port))
    return { kind: "BLOCKED", code: "ORDER_CREATE_UNSUPPORTED", record };

  let result: CreateOrderResult;
  try {
    const raw = await input.port.createOrder({
      idempotencyKey: input.idempotencyKey,
      supplierSku: values.externalSku,
      costCeilingVnd: values.costCeilingVnd,
      orderId: input.requestReference,
      ...(values.region === null ? {} : { region: values.region ?? undefined }),
    });
    result = parseCreateOrderResult(raw);
  } catch (error) {
    if (isAmbiguousTransport(error)) {
      await input.store.markTransportFailure(record.id, {
        code: error.supplierCode,
        retryAfterSeconds: error.retryAfterSeconds,
      });
      await input.store.markUnknown(record.id, {
        queryKey: input.idempotencyKey,
        reason: error.supplierCode,
      });
      return unknownResult((await input.store.findById(record.id)) ?? record, input.idempotencyKey);
    }
    if (
      error instanceof SupplierPortError &&
      ["IDENTITY_MISMATCH", "SCHEMA_INVALID"].includes(error.supplierCode)
    ) {
      return markNeedsReviewAndReload(input.store, record, error.supplierCode);
    }
    throw error;
  }

  await input.store.markResponse(record.id, responseFingerprint(result));
  switch (result.kind) {
    case "FULFILLED": {
      const accepted =
        input.onFulfilled === undefined ||
        (await input.onFulfilled({
          record,
          externalOrderId: result.externalOrderId,
          assetEnvelope: result.assetEnvelope,
        })) !== false;
      if (!accepted) {
        const current = await input.store.findById(record.id);
        if (current?.status === "REJECTED") return { kind: "REJECTED", record: current };
        return { kind: "REPLAY", record: current ?? record };
      }
      await input.store.markFulfilled(record.id, result.externalOrderId);
      return {
        kind: "FULFILLED",
        record: (await input.store.findById(record.id)) ?? record,
        externalOrderId: result.externalOrderId,
        assetEnvelope: result.assetEnvelope,
      };
    }
    case "UNKNOWN":
      await input.store.markUnknown(record.id, {
        queryKey: result.queryKey,
        reason: result.reason,
      });
      return unknownResult((await input.store.findById(record.id)) ?? record, result.queryKey);
    case "REJECTED":
      return markRejectedAndReload(input.store, record);
    case "ACCEPTED":
      await input.store.markPending(record.id, result.externalOrderId);
      return {
        kind: "ACCEPTED",
        record: (await input.store.findById(record.id)) ?? record,
        externalOrderId: result.externalOrderId,
      };
  }
}

export async function executeSupplierPurchase(
  input: SupplierPurchaseInput,
): Promise<SupplierPurchaseResult> {
  const existing = await input.store.findByIdempotency({
    supplierId: input.supplierId,
    idempotencyKey: input.idempotencyKey,
  });
  const recoverExisting = (record: SupplierPurchaseRecord) =>
    recoverSupplierPurchase({
      store: input.store,
      recordId: record.id,
      queryKey: durableQueryKey(record) ?? input.idempotencyKey,
      expectedSku: input.externalSku,
      port: input.port,
      ...(input.beforeQuery ? { beforeQuery: input.beforeQuery } : {}),
      ...(input.onFulfilled ? { onFulfilled: input.onFulfilled } : {}),
    });

  if (existing) {
    if (!matchesIntent(existing, input))
      return { kind: "BLOCKED", code: "SUPPLIER_ORDER_NOT_ELIGIBLE", record: existing };
    if (existing.status === "FULFILLED" || existing.status === "REJECTED")
      return { kind: "REPLAY", record: existing };
    const review = blockedByReview(existing);
    if (review) return review;
    if (!isSupplierProviderFor(input.port, input.supplierId)) {
      return {
        kind: "BLOCKED",
        code: "SUPPLIER_PROVIDER_MISMATCH",
        record: existing,
      };
    }
    if (["UNKNOWN", "PENDING"].includes(existing.status)) return recoverExisting(existing);
    if (existing.status === "SUBMITTED") return recoverExisting(existing);
    if (existing.status !== "AUTHORIZED")
      return { kind: "BLOCKED", code: "SUPPLIER_ORDER_NOT_ELIGIBLE", record: existing };
  }

  if (input.purchaseEnabled !== true)
    return { kind: "BLOCKED", code: "PURCHASE_DISABLED", record: null };
  if (!hasCreateCapability(input.port))
    return { kind: "BLOCKED", code: "ORDER_CREATE_UNSUPPORTED", record: null };
  if (!isSupplierProviderFor(input.port, input.supplierId)) {
    return { kind: "BLOCKED", code: "SUPPLIER_PROVIDER_MISMATCH", record: null };
  }

  let record: SupplierPurchaseRecord;
  if (existing) {
    record = existing;
  } else {
    const claimed = await input.store.insertIntent({
      supplierId: input.supplierId,
      supplierSkuId: input.supplierSkuId,
      requestReference: input.requestReference,
      idempotencyKey: input.idempotencyKey,
      requestFingerprint: supplierPurchaseRequestFingerprint(input),
      requestFingerprintVersion: SUPPLIER_REQUEST_FINGERPRINT_VERSION_V2,
      costCeilingVnd: input.costCeilingVnd,
    });
    record = claimed.record;
    if (!claimed.inserted) {
      if (!matchesIntent(record, input))
        return { kind: "BLOCKED", code: "SUPPLIER_ORDER_NOT_ELIGIBLE", record };
      if (record.status === "FULFILLED" || record.status === "REJECTED")
        return { kind: "REPLAY", record };
      if (record.queryKey || (record.attemptCount ?? 0) > 0) return recoverExisting(record);
      return unknownResult(record, input.idempotencyKey);
    }
  }

  const beforeCreate = input.beforeCreate
    ? await input.beforeCreate()
    : { ok: true as const, costCeilingVnd: input.costCeilingVnd };
  if (!beforeCreate.ok) {
    await input.store.markBlocked(record.id, beforeCreate.code);
    const blocked = await input.store.findById(record.id);
    if (blocked?.status === "FULFILLED") return { kind: "REPLAY", record: blocked };
    return { kind: "BLOCKED", code: beforeCreate.code, record: blocked ?? record };
  }

  const externalSku = beforeCreate.externalSku ?? input.externalSku;
  const region = beforeCreate.region === undefined ? input.region : beforeCreate.region;
  const claimed = await input.store.markAttempt(record.id, {
    costCeilingVnd: beforeCreate.costCeilingVnd,
    requestFingerprint: supplierPurchaseRequestFingerprint({
      ...input,
      externalSku,
      costCeilingVnd: beforeCreate.costCeilingVnd,
      region,
    }),
    requestFingerprintVersion: SUPPLIER_REQUEST_FINGERPRINT_VERSION_V2,
  });
  if (!claimed)
    return resultAfterClaimLoss(
      await input.store.findById(record.id),
      record,
      input.idempotencyKey,
    );

  return postClaimedSupplierPurchase(
    input,
    record,
    { externalSku, costCeilingVnd: beforeCreate.costCeilingVnd, region },
    input.beforePost,
  );
}

export async function recoverSupplierPurchase(input: {
  store: SupplierPurchaseRecordStore;
  recordId: string;
  queryKey: string;
  expectedSku: string;
  port: SupplierPort | SupplierProvider;
  beforeQuery?: () => Promise<boolean | SupplierPurchaseQueryDecision>;
  onFulfilled?: SupplierPurchaseFulfillmentHandler;
}): Promise<SupplierPurchaseResult> {
  const record = await input.store.findById(input.recordId);
  if (!record) return { kind: "BLOCKED", code: "NOT_FOUND", record: null };
  if (record.status === "FULFILLED" || record.status === "REJECTED")
    return { kind: "REPLAY", record };
  const review = blockedByReview(record);
  if (review) return review;
  if (!isSupplierProviderFor(input.port, record.supplierId)) {
    return { kind: "BLOCKED", code: "SUPPLIER_PROVIDER_MISMATCH", record };
  }
  if (submittedWithinGrace(record)) {
    return unknownResult(record, durableQueryKey(record) ?? input.queryKey);
  }
  if (!hasReadCapability(input.port)) {
    await input.store.markNeedsReview(record.id, "ORDER_READ_UNSUPPORTED");
    return {
      kind: "BLOCKED",
      code: "ORDER_READ_UNSUPPORTED",
      record: (await input.store.findById(record.id)) ?? record,
    };
  }
  if (input.beforeQuery) {
    const decision = await input.beforeQuery();
    if (decision === false || (typeof decision !== "boolean" && !decision.ok)) {
      const code = typeof decision === "boolean" ? "ORDER_TERMINAL" : decision.code;
      await input.store.markNeedsReview(record.id, code);
      return { kind: "BLOCKED", code, record: (await input.store.findById(record.id)) ?? record };
    }
  }

  const persistedQueryKey = durableQueryKey(record) ?? input.queryKey;
  let observed: QueryOrderResult;
  try {
    const raw = await input.port.queryOrder({
      expectedSku: input.expectedSku,
      ...(record.status !== "UNKNOWN" && record.externalOrderId
        ? { externalOrderId: record.externalOrderId }
        : {}),
      queryKey: persistedQueryKey,
    });
    observed = parseQueryOrderResult(raw);
  } catch (error) {
    if (isAmbiguousTransport(error)) {
      await input.store.markTransportFailure(record.id, {
        code: error.supplierCode,
        retryAfterSeconds: error.retryAfterSeconds,
      });
      await input.store.markUnknown(record.id, {
        queryKey: persistedQueryKey,
        reason: error.supplierCode,
      });
      return unknownResult((await input.store.findById(record.id)) ?? record, persistedQueryKey);
    }
    if (
      error instanceof SupplierPortError &&
      ["DELIVERY_UNSUPPORTED", "IDENTITY_MISMATCH", "SCHEMA_INVALID"].includes(error.supplierCode)
    ) {
      return markNeedsReviewAndReload(input.store, record, error.supplierCode);
    }
    throw error;
  }

  await input.store.markResponse(record.id, responseFingerprint(observed));
  switch (observed.status) {
    case "FULFILLED": {
      const accepted =
        input.onFulfilled === undefined ||
        (await input.onFulfilled({
          record,
          externalOrderId: observed.externalOrderId,
          assetEnvelope: observed.assetEnvelope,
        })) !== false;
      if (!accepted) {
        const current = await input.store.findById(record.id);
        if (current?.status === "REJECTED") return { kind: "REJECTED", record: current };
        return { kind: "REPLAY", record: current ?? record };
      }
      await input.store.markFulfilled(record.id, observed.externalOrderId);
      return {
        kind: "FULFILLED",
        record: (await input.store.findById(record.id)) ?? record,
        externalOrderId: observed.externalOrderId,
        assetEnvelope: observed.assetEnvelope,
      };
    }
    case "REJECTED":
    case "CANCELLED":
    case "REFUNDED":
      return markRejectedAndReload(input.store, record);
    case "PENDING":
      await input.store.markPending(record.id, observed.externalOrderId);
      return resultAfterClaimLoss(
        await input.store.findById(record.id),
        record,
        observed.externalOrderId,
      );
  }
}
