import { createHash } from "node:crypto";
import { sql } from "kysely";
import type { Db, Executor } from "../../infrastructure/db/transaction.js";
import { withTransaction } from "../../infrastructure/db/transaction.js";
import {
  ageSeconds,
  validateRecoveryBatchSize,
  type RecoveryTelemetry,
} from "../recovery-result.js";
import type { AdminConfirmationService } from "../identity/admin-confirmation.js";
import type { AuthorizationJsonValue } from "../identity/authorization-payload.js";
import {
  authorizeSensitiveAdminAction,
  SensitiveAuthorizationRefusedError,
  type SensitiveActionDeps,
} from "../identity/sensitive-action.js";
import {
  authorizeRootAction,
  type RootActor,
  type RootAdminConfig,
} from "../identity/root-admin.js";
import { newId } from "../../shared/ids/index.js";
import {
  executeSupplierPurchase,
  recoverSupplierPurchase,
  type SupplierPurchaseRecord,
  type SupplierPurchaseRecordStore,
} from "./purchase-core.js";
import { checkSupplierPurchaseReadiness } from "./readiness.js";
import {
  hasSupplierCapability,
  type NormalizedSupplierBalance,
  type SupplierProvider,
} from "./port.js";
import type { SupplierProviderRegistry } from "./registry.js";

const CANARY_ACTION = "supplier.canary.purchase" as const;
const CANARY_RESOURCE = "SupplierCanaryRun" as const;
const VND = "VND";
const CANARY_RETRY_DELAY_SECONDS = 60;

type CanaryStatus =
  | "PREVIEWED"
  | "AUTHORIZED"
  | "SUBMITTED"
  | "PENDING"
  | "FULFILLED"
  | "UNKNOWN"
  | "REJECTED"
  | "BLOCKED";

interface CanaryRow {
  id: string;
  confirmation_id: string | null;
  supplier_id: string;
  supplier_sku_id: string;
  variant_id: string;
  provider_key: string;
  external_sku: string;
  region: string | null;
  idempotency_key: string;
  query_key: string | null;
  request_fingerprint: string;
  status: CanaryStatus;
  approved_cost_vnd: number | string;
  cost_vnd_snapshot: number | string;
  balance_vnd_snapshot: number | string | null;
  currency: string;
  external_order_id: string | null;
  response_fingerprint: string | null;
  last_error_code: string | null;
  retry_after_seconds: number | null;
  version: number;
  created_by: string;
}

export interface SupplierCanaryOptions {
  db: Db;
  registry: SupplierProviderRegistry;
  confirmation: AdminConfirmationService;
  rootChannelIdentityId: string;
  rootConfig: RootAdminConfig;
  sensitiveDeps: SensitiveActionDeps;
  canaryEnabled: boolean;
  canaryPurchaseEnabled: (providerKey: string) => boolean;
  maxCostVnd: number;
}

export interface SupplierCanaryPrepareInput {
  actor: RootActor;
  supplierSkuId: string;
  correlationId: string;
}

export type SupplierCanaryPrepareResult =
  | {
      ok: true;
      runId: string;
      confirmationId: string;
      challenge: string;
      expiresAt: string;
      providerName: string;
      externalSku: string;
      costVnd: number;
      balanceVnd: number;
      currency: string;
    }
  | { ok: false; code: string; message: string };

export type SupplierCanaryExecutionResult =
  | {
      ok: true;
      runId: string;
      status: "PENDING" | "UNKNOWN" | "FULFILLED" | "REJECTED";
      externalOrderId?: string;
    }
  | { ok: false; runId: string; code: string; message: string };

export type SupplierCanaryConfirmResult =
  | { ok: true; runId: string; execution: SupplierCanaryExecutionResult }
  | { ok: false; code: string; message: string };

function numberValue(value: number | string | null): number | null {
  if (value === null) return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function safeCanaryPayload(row: CanaryRow): AuthorizationJsonValue {
  return {
    runId: row.id,
    supplierId: row.supplier_id,
    supplierSkuId: row.supplier_sku_id,
    variantId: row.variant_id,
    providerKey: row.provider_key,
    externalSku: row.external_sku,
    region: row.region,
    costVnd: String(row.approved_cost_vnd),
    currency: row.currency,
    version: String(row.version),
  };
}

function requestFingerprint(input: {
  supplierId: string;
  supplierSkuId: string;
  variantId: string;
  providerKey: string;
  externalSku: string;
  costVnd: number;
  idempotencyKey: string;
}): string {
  return createHash("sha256")
    .update(
      `${input.supplierId}|${input.supplierSkuId}|${input.variantId}|${input.providerKey}|${input.externalSku}|${input.costVnd}|${input.idempotencyKey}`,
      "utf8",
    )
    .digest("hex");
}

async function loadCanary(exec: Executor, id: string): Promise<CanaryRow | null> {
  const result = await sql<CanaryRow>`
    select id, confirmation_id, supplier_id, supplier_sku_id, variant_id, provider_key,
           external_sku, region, idempotency_key, query_key, request_fingerprint, status,
           approved_cost_vnd, cost_vnd_snapshot, balance_vnd_snapshot, currency,
           external_order_id, response_fingerprint, last_error_code, retry_after_seconds,
           version, created_by
    from supplier_canary_run
    where id = ${id}
    limit 1
  `.execute(exec);
  return result.rows[0] ?? null;
}
async function hasAutomaticDelivery(exec: Executor, supplierSkuId: string): Promise<boolean> {
  const result = await sql<{
    fulfillment_mode: string | null;
    requires_customer_input: boolean;
    customer_inputs_per_item: number;
  }>`
    select fulfillment_mode, requires_customer_input, customer_inputs_per_item
    from supplier_catalog_product
    where supplier_sku_id = ${supplierSkuId}
    limit 1
  `.execute(exec);
  const row = result.rows[0];
  return (
    row?.fulfillment_mode?.trim().toUpperCase() === "AUTOMATIC" &&
    row.requires_customer_input === false &&
    row.customer_inputs_per_item === 0
  );
}

async function markCanaryBlocked(db: Db, id: string, code: string): Promise<void> {
  await sql`
    update supplier_canary_run
    set status = 'BLOCKED', last_error_code = ${code}, retry_after_seconds = null,
        next_reconcile_at = null, updated_at = now(), version = version + 1
    where id = ${id} and status not in ('FULFILLED','REJECTED','BLOCKED')
  `.execute(db);
}

function canaryStore(db: Db): SupplierPurchaseRecordStore {
  const load = (id: string) => loadCanary(db, id);
  const toRecord = (row: CanaryRow): SupplierPurchaseRecord => ({
    id: row.id,
    supplierId: row.supplier_id,
    supplierSkuId: row.supplier_sku_id,
    requestReference: row.id,
    idempotencyKey: row.idempotency_key,
    queryKey: row.query_key,
    requestFingerprint: row.request_fingerprint,
    status:
      row.status === "AUTHORIZED" ||
      row.status === "SUBMITTED" ||
      row.status === "PENDING" ||
      row.status === "FULFILLED" ||
      row.status === "REJECTED" ||
      row.status === "UNKNOWN"
        ? row.status
        : "SUBMITTED",
    externalOrderId: row.external_order_id,
    costVndSnapshot: Number(row.cost_vnd_snapshot),
    version: row.version,
    responseFingerprint: row.response_fingerprint,
    blockCode: row.last_error_code,
  });

  return {
    async findByIdempotency(input) {
      const row = await sql<CanaryRow>`
        select id, confirmation_id, supplier_id, supplier_sku_id, variant_id, provider_key,
               external_sku, region, idempotency_key, query_key, request_fingerprint, status,
               approved_cost_vnd, cost_vnd_snapshot, balance_vnd_snapshot, currency,
               external_order_id, response_fingerprint, last_error_code, retry_after_seconds,
               version, created_by
        from supplier_canary_run
        where supplier_id = ${input.supplierId} and idempotency_key = ${input.idempotencyKey}
        limit 1
      `.execute(db);
      return row.rows[0] ? toRecord(row.rows[0]) : null;
    },
    async findById(id) {
      const row = await load(id);
      return row ? toRecord(row) : null;
    },
    async insertIntent(input) {
      const id = input.requestReference;
      const inserted = await sql<{ id: string }>`
        insert into supplier_canary_run
          (id, supplier_id, supplier_sku_id, variant_id, provider_key, external_sku,
           region, idempotency_key, request_fingerprint, status, approved_cost_vnd,
           cost_vnd_snapshot, currency, created_by, correlation_id)
        select ${id}, ss.supplier_id, ss.id, ss.variant_id, ss.supplier_id, ss.external_sku,
               ss.region, ${input.idempotencyKey}, ${input.requestFingerprint}, 'AUTHORIZED',
               ${input.costCeilingVnd}, ${input.costCeilingVnd}, 'VND', 'system', ${input.requestReference}
        from supplier_sku ss
        where ss.id = ${input.supplierSkuId}
        on conflict (supplier_id, idempotency_key) do nothing
        returning id
      `.execute(db);
      const row = await (inserted.rows.length === 1
        ? load(id)
        : this.findByIdempotency({
            supplierId: input.supplierId,
            idempotencyKey: input.idempotencyKey,
          }).then(async (record) => (record ? load(record.id) : null)));
      if (!row) throw new Error("supplier canary intent was not visible after conflict wait");
      return { inserted: inserted.rows.length === 1, record: toRecord(row) };
    },
    async refreshIntent(id, input) {
      await sql`
        update supplier_canary_run
        set cost_vnd_snapshot = ${input.costCeilingVnd},
            external_sku = coalesce(${input.externalSku ?? null}, external_sku),
            region = coalesce(${input.region ?? null}, region),
            updated_at = now(), version = version + 1
        where id = ${id}
      `.execute(db);
    },
    async markAttempt(id) {
      const result = await sql<{ id: string }>`
        update supplier_canary_run
        set status = 'SUBMITTED', query_key = coalesce(query_key, idempotency_key),
            submitted_at = coalesce(submitted_at, now()),
            last_error_code = null, retry_after_seconds = null, next_reconcile_at = null,
            updated_at = now(), version = version + 1
        where id = ${id} and status = 'AUTHORIZED'
        returning id
      `.execute(db);
      return result.rows.length === 1;
    },
    async markTransportFailure(id, input) {
      await sql`
        update supplier_canary_run
        set last_error_code = ${input.code}, retry_after_seconds = ${input.retryAfterSeconds ?? null},
            next_reconcile_at = ${
              input.retryAfterSeconds === null || input.retryAfterSeconds === undefined
                ? null
                : new Date(Date.now() + input.retryAfterSeconds * 1_000).toISOString()
            },
            updated_at = now(), version = version + 1
        where id = ${id}
      `.execute(db);
    },
    async markResponse(id, fingerprint) {
      await sql`
        update supplier_canary_run
        set response_fingerprint = ${fingerprint}, updated_at = now(), version = version + 1
        where id = ${id}
      `.execute(db);
    },
    async markUnknown(id, input) {
      await sql`
        update supplier_canary_run
        set status = 'UNKNOWN', query_key = ${input.queryKey}, external_order_id = null,
            uncertain_at = now(), last_error_code = ${input.reason},
            retry_after_seconds = ${CANARY_RETRY_DELAY_SECONDS},
            next_reconcile_at = now() + make_interval(secs => ${CANARY_RETRY_DELAY_SECONDS}),
            updated_at = now(), version = version + 1
        where id = ${id}
      `.execute(db);
    },
    async markPending(id, externalOrderId) {
      await sql`
        update supplier_canary_run
        set status = 'PENDING', external_order_id = ${externalOrderId}, query_key = null,
            last_error_code = null, retry_after_seconds = ${CANARY_RETRY_DELAY_SECONDS},
            next_reconcile_at = now() + make_interval(secs => ${CANARY_RETRY_DELAY_SECONDS}),
            updated_at = now(), version = version + 1
        where id = ${id}
      `.execute(db);
    },
    async markFulfilled(id, externalOrderId) {
      await sql`
        update supplier_canary_run
        set status = 'FULFILLED', external_order_id = ${externalOrderId}, query_key = null,
            last_error_code = null, retry_after_seconds = null, next_reconcile_at = null,
            updated_at = now(), version = version + 1
        where id = ${id}
      `.execute(db);
    },
    async markRejected(id) {
      await sql`
        update supplier_canary_run
        set status = 'REJECTED', last_error_code = null, retry_after_seconds = null,
            next_reconcile_at = null, updated_at = now(), version = version + 1
        where id = ${id}
      `.execute(db);
    },
    async markNeedsReview(id, code) {
      await sql`
        update supplier_canary_run
        set status = 'BLOCKED', last_error_code = ${code}, needs_review_at = coalesce(needs_review_at, now()),
            retry_after_seconds = null, next_reconcile_at = null,
            updated_at = now(), version = version + 1
        where id = ${id}
      `.execute(db);
    },
    async markBlocked(id, code) {
      await markCanaryBlocked(db, id, code);
    },
  };
}

function safeFailure(code: string): { ok: false; code: string; message: string } {
  const messages: Record<string, string> = {
    CANARY_DISABLED: "Canary nhà cung cấp đang bị khóa.",
    PURCHASE_GATE_DISABLED: "Gate mua nhà cung cấp chưa được bật.",
    SUPPLIER_NOT_FOUND: "Không tìm thấy mapping nhà cung cấp.",
    PROVIDER_UNAVAILABLE: "Provider nhà cung cấp chưa sẵn sàng.",
    BALANCE_UNSUPPORTED: "Provider chưa công bố capability đọc số dư.",
    BALANCE_UNAVAILABLE: "Không đọc được số dư provider.",
    BALANCE_CURRENCY_UNSUPPORTED: "Provider không trả số dư VND.",
    INSUFFICIENT_BALANCE: "Số dư provider không đủ cho canary.",
    CANARY_MAPPING_CHANGED: "Mapping hoặc region đã thay đổi sau preview; canary bị chặn.",
    COST_TOO_HIGH: "Chi phí canary vượt ngân sách cố định.",
    CANARY_COST_CHANGED: "Chi phí đã thay đổi sau preview; canary bị chặn.",
    AUTOMATIC_DELIVERY_REQUIRED: "SKU phải có fulfillment tự động và không cần input khách.",
    ORDER_CREATE_UNSUPPORTED: "Provider chưa công bố capability đặt hàng.",
    ORDER_READ_UNSUPPORTED: "Provider chưa hỗ trợ tra cứu đơn hàng.",
    CONFIRMATION_FAILED: "Không tạo được xác nhận canary.",
    AUTHORIZATION_REQUIRED: "Canary cần xác thực owner/step-up.",
    CANARY_NOT_AUTHORIZED: "Canary chưa được xác nhận hoặc đã hết hạn.",
    DELIVERY_UNSUPPORTED: "Payload giao hàng provider chưa có schema được chấp nhận.",
  };
  return { ok: false, code, message: messages[code] ?? "Canary bị chặn fail-closed." };
}

interface CanaryRecoveryAttempt {
  execution: SupplierCanaryExecutionResult;
  queried: boolean;
}

async function recoverCanaryRun(
  db: Db,
  registry: SupplierProviderRegistry,
  row: CanaryRow,
): Promise<CanaryRecoveryAttempt> {
  const runId = row.id;
  if (row.status === "FULFILLED" || row.status === "REJECTED") {
    return {
      execution: {
        ok: true,
        runId,
        status: row.status,
        ...(row.external_order_id ? { externalOrderId: row.external_order_id } : {}),
      },
      queried: false,
    };
  }
  if (row.status !== "SUBMITTED" && row.status !== "PENDING" && row.status !== "UNKNOWN") {
    return { execution: { runId, ...safeFailure("CANARY_NOT_AUTHORIZED") }, queried: false };
  }
  const provider = registry.get(row.provider_key);
  if (!provider) {
    return { execution: { runId, ...safeFailure("PROVIDER_UNAVAILABLE") }, queried: false };
  }
  const recovered = await recoverSupplierPurchase({
    store: canaryStore(db),
    recordId: row.id,
    queryKey: row.query_key ?? row.idempotency_key,
    port: provider,
  });
  if (recovered.kind === "BLOCKED") {
    await markCanaryBlocked(db, runId, recovered.code);
    return {
      execution: { runId, ...safeFailure(recovered.code) },
      queried: recovered.code !== "ORDER_READ_UNSUPPORTED" && recovered.code !== "NOT_FOUND",
    };
  }
  if (recovered.kind === "REJECTED") {
    return { execution: { ok: true, runId, status: "REJECTED" }, queried: true };
  }
  if (recovered.kind === "UNKNOWN") {
    const current = await loadCanary(db, runId);
    return {
      execution: {
        ok: true,
        runId,
        status: "UNKNOWN",
        ...(current?.external_order_id ? { externalOrderId: current.external_order_id } : {}),
      },
      queried: true,
    };
  }
  if (recovered.kind === "REPLAY") {
    const current = await loadCanary(db, runId);
    return {
      execution: {
        ok: true,
        runId,
        status: current?.status === "FULFILLED" ? "FULFILLED" : "UNKNOWN",
        ...(current?.external_order_id ? { externalOrderId: current.external_order_id } : {}),
      },
      queried: false,
    };
  }
  return {
    execution: {
      ok: true,
      runId,
      status: "FULFILLED",
      externalOrderId: recovered.externalOrderId,
    },
    queried: true,
  };
}

async function scheduleCanaryRecovery(
  db: Db,
  input: { runId: string; retryDelaySeconds: number; queried: boolean; errorCode: string | null },
): Promise<void> {
  await sql`
    update supplier_canary_run
    set last_queried_at = case when ${input.queried} then now() else last_queried_at end,
        last_error_code = case
          when status in ('FULFILLED','REJECTED') then null
          when status = 'BLOCKED' then last_error_code
          when ${input.errorCode}::text is not null then ${input.errorCode}::text
          else last_error_code
        end,
        retry_after_seconds = case
          when status in ('FULFILLED','REJECTED','BLOCKED') or needs_review_at is not null then null
          else ${input.retryDelaySeconds}::integer
        end,
        next_reconcile_at = case
          when status in ('FULFILLED','REJECTED','BLOCKED') or needs_review_at is not null then null
          else now() + make_interval(secs => ${input.retryDelaySeconds})
        end,
        updated_at = now(), version = version + 1
    where id = ${input.runId}
  `.execute(db);
}

export async function recoverSupplierCanariesBatch(
  db: Db,
  options: {
    batchSize: number;
    now?: Date;
    retryDelaySeconds?: number;
    registry: SupplierProviderRegistry;
  },
): Promise<RecoveryTelemetry> {
  validateRecoveryBatchSize(options.batchSize);
  const now = options.now ?? new Date();
  const retryDelaySeconds = options.retryDelaySeconds ?? CANARY_RETRY_DELAY_SECONDS;
  if (!Number.isInteger(retryDelaySeconds) || retryDelaySeconds < 1 || retryDelaySeconds > 3600) {
    throw new RangeError("supplier canary retryDelaySeconds must be an integer between 1 and 3600");
  }
  const submittedGraceCutoff = new Date(now.getTime() - retryDelaySeconds * 1_000).toISOString();
  const deferUntil = new Date(now.getTime() + retryDelaySeconds * 1_000).toISOString();
  let claimed = 0;
  let succeeded = 0;
  let failed = 0;

  for (let index = 0; index < options.batchSize; index += 1) {
    const candidate = await withTransaction(db, async (trx) => {
      const selected = await sql<{ id: string }>`
        select canary.id
        from supplier_canary_run canary
        where canary.needs_review_at is null
          and canary.status in ('SUBMITTED','PENDING','UNKNOWN')
          and (
            canary.status <> 'SUBMITTED'
            or canary.submitted_at <= ${submittedGraceCutoff}
          )
          and coalesce(
                canary.next_reconcile_at,
                canary.last_queried_at,
                canary.submitted_at,
                canary.created_at
              ) <= ${now.toISOString()}
        order by coalesce(
                   canary.next_reconcile_at,
                   canary.last_queried_at,
                   canary.submitted_at,
                   canary.created_at
                 ),
                 canary.id
        limit 1
        for update of canary skip locked
      `.execute(trx);
      const row = selected.rows[0];
      if (!row) return null;
      await sql`
        update supplier_canary_run
        set next_reconcile_at = ${deferUntil},
            retry_after_seconds = ${retryDelaySeconds},
            updated_at = now(), version = version + 1
        where id = ${row.id}
      `.execute(trx);
      return row;
    });
    if (!candidate) break;
    claimed += 1;

    const row = await loadCanary(db, candidate.id);
    if (!row) {
      failed += 1;
      continue;
    }
    let attempt: CanaryRecoveryAttempt;
    try {
      attempt = await recoverCanaryRun(db, options.registry, row);
    } catch {
      failed += 1;
      await scheduleCanaryRecovery(db, {
        runId: candidate.id,
        retryDelaySeconds,
        queried: true,
        errorCode: "SUPPLIER_QUERY_FAILED",
      });
      continue;
    }
    await scheduleCanaryRecovery(db, {
      runId: row.id,
      retryDelaySeconds,
      queried: attempt.queried,
      errorCode: attempt.execution.ok ? null : attempt.execution.code,
    });
    if (attempt.execution.ok) succeeded += 1;
    else failed += 1;
  }

  const remaining = await sql<{ backlog: number; oldest: Date | string | null }>`
    select count(*)::int as backlog,
           min(coalesce(submitted_at, last_queried_at, created_at)) as oldest
    from supplier_canary_run
    where needs_review_at is null
      and status in ('SUBMITTED','PENDING','UNKNOWN')
  `.execute(db);
  const row = remaining.rows[0];
  return {
    claimed,
    succeeded,
    failed,
    backlog: row?.backlog ?? 0,
    oldestAgeSeconds: ageSeconds(now, row?.oldest),
  };
}
export function createSupplierCanaryService(options: SupplierCanaryOptions) {
  const prepare = async (
    input: SupplierCanaryPrepareInput,
  ): Promise<SupplierCanaryPrepareResult> => {
    const root = authorizeRootAction(input.actor, options.rootConfig);
    if (!root.ok) return safeFailure(root.reason);
    if (!options.canaryEnabled) return safeFailure("CANARY_DISABLED");

    const mapping = await sql<{
      supplier_id: string;
      supplier_sku_id: string;
      variant_id: string;
      external_sku: string;
      region: string | null;
      cost_vnd: string;
      supplier_status: string;
      sku_active: boolean;
    }>`
      select s.id as supplier_id, ss.id as supplier_sku_id, ss.variant_id, ss.external_sku,
             ss.region, ss.cost_vnd::text, s.status as supplier_status, ss.is_active as sku_active
      from supplier_sku ss
      join supplier s on s.id = ss.supplier_id
      where ss.id = ${input.supplierSkuId}
      limit 1
    `.execute(options.db);
    const row = mapping.rows[0];
    if (!row || row.supplier_status !== "ACTIVE" || !row.sku_active)
      return safeFailure("SUPPLIER_NOT_FOUND");

    const provider = options.registry.get(row.supplier_id);
    if (!provider) return safeFailure("PROVIDER_UNAVAILABLE");
    if (!hasSupplierCapability(provider, "ORDER_CREATE"))
      return safeFailure("ORDER_CREATE_UNSUPPORTED");
    if (!options.canaryPurchaseEnabled(row.supplier_id)) {
      return safeFailure("PURCHASE_GATE_DISABLED");
    }
    const readiness = await checkSupplierPurchaseReadiness(options.db, {
      variantId: row.variant_id,
      supplierId: row.supplier_id,
      supplierSkuId: row.supplier_sku_id,
      provider,
      purchaseEnabled: true,
    });
    if (!readiness.ok) return safeFailure(readiness.reason);
    if (!(await hasAutomaticDelivery(options.db, row.supplier_sku_id))) {
      return safeFailure("AUTOMATIC_DELIVERY_REQUIRED");
    }
    if (!Number.isSafeInteger(readiness.costVnd) || readiness.costVnd < 0) {
      return safeFailure("COST_INVALID");
    }
    if (readiness.costVnd > options.maxCostVnd) return safeFailure("COST_TOO_HIGH");

    const balance = await readBalance(provider);
    if (!balance.ok) return safeFailure(balance.code);
    if (balance.value.currency !== VND) return safeFailure("BALANCE_CURRENCY_UNSUPPORTED");
    if (balance.value.available < readiness.costVnd) return safeFailure("INSUFFICIENT_BALANCE");

    const runId = newId();
    const idempotencyKey = `supplier-canary:${runId}`;
    const fingerprint = requestFingerprint({
      supplierId: row.supplier_id,
      supplierSkuId: row.supplier_sku_id,
      variantId: row.variant_id,
      providerKey: row.supplier_id,
      externalSku: readiness.externalSku,
      costVnd: readiness.costVnd,
      idempotencyKey,
    });
    await sql`
      insert into supplier_canary_run
        (id, supplier_id, supplier_sku_id, variant_id, provider_key, external_sku, region,
         idempotency_key, request_fingerprint, status, approved_cost_vnd, cost_vnd_snapshot,
         balance_vnd_snapshot, currency, created_by, correlation_id)
      values
        (${runId}, ${row.supplier_id}, ${row.supplier_sku_id}, ${row.variant_id}, ${row.supplier_id},
         ${readiness.externalSku}, ${readiness.region}, ${idempotencyKey}, ${fingerprint}, 'PREVIEWED',
         ${readiness.costVnd}, ${readiness.costVnd}, ${balance.value.available}, ${balance.value.currency},
         ${String(input.actor.numericUserId)}, ${input.correlationId})
    `.execute(options.db);

    const requestedData = safeCanaryPayload({
      id: runId,
      confirmation_id: null,
      supplier_id: row.supplier_id,
      supplier_sku_id: row.supplier_sku_id,
      variant_id: row.variant_id,
      provider_key: row.supplier_id,
      external_sku: readiness.externalSku,
      region: readiness.region,
      idempotency_key: idempotencyKey,
      query_key: null,
      request_fingerprint: fingerprint,
      status: "PREVIEWED",
      approved_cost_vnd: readiness.costVnd,
      cost_vnd_snapshot: readiness.costVnd,
      balance_vnd_snapshot: balance.value.available,
      currency: balance.value.currency,
      external_order_id: null,
      response_fingerprint: null,
      last_error_code: null,
      retry_after_seconds: null,
      version: 1,
      created_by: String(input.actor.numericUserId),
    });
    const actionFingerprint = `${CANARY_ACTION}:${runId}:${fingerprint}`;
    const authorization = await authorizeSensitiveAdminAction(options.sensitiveDeps, {
      actor: input.actor,
      actionKey: CANARY_ACTION,
      resourceType: CANARY_RESOURCE,
      resourceId: runId,
      correlationId: input.correlationId,
      requestedData,
      consumeGrant: false,
    });
    if (!authorization.ok) {
      await markCanaryBlocked(options.db, runId, authorization.code);
      return safeFailure("AUTHORIZATION_REQUIRED");
    }

    const issued = await options.confirmation.issue({
      rootChannelIdentityId: options.rootChannelIdentityId,
      actionFingerprint,
      correlationId: input.correlationId,
      allowlistedCommandRef: CANARY_ACTION,
      payloadRedacted: {
        runId,
        actorId: String(input.actor.numericUserId),
        supplierId: row.supplier_id,
        supplierSkuId: row.supplier_sku_id,
        variantId: row.variant_id,
        providerKey: row.supplier_id,
        externalSku: readiness.externalSku,
        region: readiness.region,
        approvedCostVnd: String(readiness.costVnd),
        currency: balance.value.currency,
        version: "1",
      },
    });
    if (!issued.ok) {
      await markCanaryBlocked(options.db, runId, "CONFIRMATION_FAILED");
      return safeFailure("CONFIRMATION_FAILED");
    }
    const linked = await sql`
      update supplier_canary_run
      set confirmation_id = ${issued.confirmationId}, updated_at = now()
      where id = ${runId} and status = 'PREVIEWED'
    `.execute(options.db);
    if (Number(linked.numAffectedRows ?? 0) !== 1) {
      await markCanaryBlocked(options.db, runId, "CONFIRMATION_FAILED");
      return safeFailure("CONFIRMATION_FAILED");
    }
    return {
      ok: true,
      runId,
      confirmationId: issued.confirmationId,
      challenge: issued.challenge,
      expiresAt: issued.expiresAt,
      providerName: provider.displayName,
      externalSku: readiness.externalSku,
      costVnd: readiness.costVnd,
      balanceVnd: balance.value.available,
      currency: balance.value.currency,
    };
  };

  const executePending = async (runId: string): Promise<SupplierCanaryExecutionResult> => {
    const row = await loadCanary(options.db, runId);
    if (!row) return { runId, ...safeFailure("SUPPLIER_NOT_FOUND") };
    if (row.status === "FULFILLED" || row.status === "REJECTED") {
      return {
        ok: true,
        runId,
        status: row.status,
        ...(row.external_order_id ? { externalOrderId: row.external_order_id } : {}),
      };
    }
    if (row.status === "SUBMITTED" || row.status === "PENDING" || row.status === "UNKNOWN") {
      return (await recoverCanaryRun(options.db, options.registry, row)).execution;
    }
    if (row.status !== "AUTHORIZED") return { runId, ...safeFailure("CANARY_NOT_AUTHORIZED") };
    if (!options.canaryEnabled || !options.canaryPurchaseEnabled(row.provider_key)) {
      await markCanaryBlocked(options.db, runId, "PURCHASE_GATE_DISABLED");
      return { runId, ...safeFailure("PURCHASE_GATE_DISABLED") };
    }
    const provider = options.registry.get(row.provider_key);
    if (!provider) {
      await markCanaryBlocked(options.db, runId, "PROVIDER_UNAVAILABLE");
      return { runId, ...safeFailure("PROVIDER_UNAVAILABLE") };
    }
    const approvedCost = numberValue(row.approved_cost_vnd);
    if (approvedCost === null || approvedCost > options.maxCostVnd) {
      await markCanaryBlocked(options.db, runId, "COST_TOO_HIGH");
      return { runId, ...safeFailure("COST_TOO_HIGH") };
    }
    const safety = await canarySafety(provider, row, approvedCost);
    if (!safety.ok) {
      await markCanaryBlocked(options.db, runId, safety.code);
      return { runId, ...safeFailure(safety.code) };
    }

    const result = await executeSupplierPurchase({
      supplierId: row.supplier_id,
      supplierSkuId: row.supplier_sku_id,
      requestReference: runId,
      externalSku: row.external_sku,
      costCeilingVnd: approvedCost,
      idempotencyKey: row.idempotency_key,
      correlationId: `canary:${runId}`,
      region: row.region,
      port: provider,
      store: canaryStore(options.db),
      purchaseEnabled: true,
      beforeCreate: async () => {
        const latest = await checkSupplierPurchaseReadiness(options.db, {
          variantId: row.variant_id,
          supplierId: row.supplier_id,
          supplierSkuId: row.supplier_sku_id,
          provider,
          purchaseEnabled: true,
        });
        if (!latest.ok) return { ok: false, code: latest.reason };
        if (!(await hasAutomaticDelivery(options.db, row.supplier_sku_id))) {
          return { ok: false, code: "AUTOMATIC_DELIVERY_REQUIRED" };
        }
        if (latest.externalSku !== row.external_sku || latest.region !== row.region) {
          return { ok: false, code: "CANARY_MAPPING_CHANGED" };
        }
        if (latest.costVnd !== approvedCost) {
          return { ok: false, code: "CANARY_COST_CHANGED" };
        }
        const latestBalance = await readBalance(provider);
        if (!latestBalance.ok) return { ok: false, code: latestBalance.code };
        if (latestBalance.value.currency !== VND || latestBalance.value.available < approvedCost) {
          return { ok: false, code: "INSUFFICIENT_BALANCE" };
        }
        await sql`
          update supplier_canary_run
          set balance_vnd_snapshot = ${latestBalance.value.available}, updated_at = now(), version = version + 1
          where id = ${runId} and status = 'AUTHORIZED'
        `.execute(options.db);
        return {
          ok: true,
          costCeilingVnd: approvedCost,
          externalSku: row.external_sku,
          region: row.region,
        };
      },
    });
    if (result.kind === "BLOCKED") {
      await markCanaryBlocked(options.db, runId, result.code);
      return { runId, ...safeFailure(result.code) };
    }
    if (result.kind === "UNKNOWN") {
      return { ok: true, runId, status: "UNKNOWN" };
    }
    if (result.kind === "ACCEPTED") {
      return { ok: true, runId, status: "PENDING", externalOrderId: result.externalOrderId };
    }
    if (result.kind === "REJECTED") {
      return { ok: true, runId, status: "REJECTED" };
    }
    if (result.kind === "REPLAY") {
      const current = await loadCanary(options.db, runId);
      return {
        ok: true,
        runId,
        status: current?.status === "FULFILLED" ? "FULFILLED" : "UNKNOWN",
        ...(current?.external_order_id ? { externalOrderId: current.external_order_id } : {}),
      };
    }
    // The adapter has already validated the canonical envelope. The canary never
    // stores or presents it; customer publication remains a separate blocked step.
    return { ok: true, runId, status: "FULFILLED", externalOrderId: result.externalOrderId };
  };

  const confirmIfCanary = async (input: {
    confirmationId: string;
    challenge: string;
    actor: RootActor;
    correlationId: string;
  }): Promise<SupplierCanaryConfirmResult | null> => {
    const actionRow = await sql<{
      allowlisted_command_ref: string | null;
      payload_redacted: unknown;
    }>`
      select allowlisted_command_ref, payload_redacted
      from admin_confirmation
      where id = ${input.confirmationId}
      limit 1
    `.execute(options.db);
    if (actionRow.rows[0]?.allowlisted_command_ref !== CANARY_ACTION) return null;
    const payload = parseCanaryAction(actionRow.rows[0].payload_redacted);
    if (!payload)
      return { ok: false, code: "CONFIRMATION_FAILED", message: "Xác nhận canary không hợp lệ." };

    try {
      const executed = await options.confirmation.executeAtomically({
        confirmationId: input.confirmationId,
        rootChannelIdentityId: options.rootChannelIdentityId,
        challenge: input.challenge,
        execute: async (trx, action) => {
          const parsed = parseCanaryAction(action.payloadRedacted);
          if (
            action.commandRef !== CANARY_ACTION ||
            !parsed ||
            parsed.runId !== payload.runId ||
            parsed.actorId !== String(input.actor.numericUserId)
          ) {
            return false;
          }
          const run = await loadCanary(trx, parsed.runId);
          if (
            !run ||
            run.confirmation_id !== input.confirmationId ||
            run.created_by !== parsed.actorId ||
            action.actionFingerprint !== `${CANARY_ACTION}:${run.id}:${run.request_fingerprint}`
          ) {
            return false;
          }
          const authorization = await authorizeSensitiveAdminAction(options.sensitiveDeps, {
            actor: input.actor,
            actionKey: CANARY_ACTION,
            resourceType: CANARY_RESOURCE,
            resourceId: run.id,
            correlationId: action.correlationId,
            requestedData: safeCanaryPayload(run),
            consumeGrant: true,
          });
          if (!authorization.ok) {
            throw new SensitiveAuthorizationRefusedError(authorization.code);
          }
          const changed = await sql<{ id: string }>`
            update supplier_canary_run
            set status = 'AUTHORIZED', updated_at = now(), version = version + 1
            where id = ${run.id} and confirmation_id = ${input.confirmationId} and status = 'PREVIEWED'
            returning id
          `.execute(trx);
          return changed.rows.length === 1;
        },
      });
      if (!executed.ok) return { ok: false, code: executed.code, message: executed.message };
      const execution = await executePending(payload.runId);
      return { ok: true, runId: payload.runId, execution };
    } catch (error) {
      if (error instanceof SensitiveAuthorizationRefusedError) {
        return safeFailure("AUTHORIZATION_REQUIRED");
      }
      return { ok: false, code: "CONFIRMATION_FAILED", message: "Xác nhận canary thất bại." };
    }
  };

  return { prepare, executePending, confirmIfCanary };
}

function parseCanaryAction(value: unknown): {
  runId: string;
  actorId: string;
  supplierId?: string;
  supplierSkuId?: string;
  variantId?: string;
  providerKey?: string;
} | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const payload = value as Record<string, unknown>;
  if (
    typeof payload.runId !== "string" ||
    !/^[-A-Za-z0-9_:.]{1,128}$/.test(payload.runId) ||
    typeof payload.actorId !== "string" ||
    !/^\d{1,20}$/.test(payload.actorId)
  ) {
    return null;
  }
  return {
    runId: payload.runId,
    actorId: payload.actorId,
    ...(typeof payload.supplierId === "string" ? { supplierId: payload.supplierId } : {}),
    ...(typeof payload.supplierSkuId === "string" ? { supplierSkuId: payload.supplierSkuId } : {}),
    ...(typeof payload.variantId === "string" ? { variantId: payload.variantId } : {}),
    ...(typeof payload.providerKey === "string" ? { providerKey: payload.providerKey } : {}),
  };
}

async function readBalance(
  provider: SupplierProvider,
): Promise<{ ok: true; value: NormalizedSupplierBalance } | { ok: false; code: string }> {
  if (
    !hasSupplierCapability(provider, "BALANCE_READ") ||
    typeof provider.getBalance !== "function"
  ) {
    return { ok: false, code: "BALANCE_UNSUPPORTED" };
  }
  try {
    const value = await provider.getBalance();
    if (
      !Number.isSafeInteger(value.available) ||
      value.available < 0 ||
      typeof value.currency !== "string"
    ) {
      return { ok: false, code: "BALANCE_UNAVAILABLE" };
    }
    return { ok: true, value };
  } catch {
    return { ok: false, code: "BALANCE_UNAVAILABLE" };
  }
}

async function canarySafety(
  provider: SupplierProvider,
  row: CanaryRow,
  approvedCost: number,
): Promise<{ ok: true } | { ok: false; code: string }> {
  const latest = await readBalance(provider);
  if (!latest.ok) return latest;
  if (latest.value.currency !== VND) return { ok: false, code: "BALANCE_CURRENCY_UNSUPPORTED" };
  if (latest.value.available < approvedCost) return { ok: false, code: "INSUFFICIENT_BALANCE" };
  const currentCost = numberValue(row.cost_vnd_snapshot);
  if (currentCost !== approvedCost) return { ok: false, code: "CANARY_COST_CHANGED" };
  return { ok: true };
}
