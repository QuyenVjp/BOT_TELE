import { sql } from "kysely";
import type { Executor, Trx } from "../../infrastructure/db/transaction.js";
import { enqueueOutboxEvent } from "../../infrastructure/outbox/repository.js";
import { nextVersion } from "../../infrastructure/db/version.js";
import { newId } from "../../shared/ids/index.js";
import { findOrderByIdForUpdate, transitionOrder } from "../commerce/repository.js";
import { appendAuditEvent } from "../identity/audit.js";

export const manualServicePaymentEvidence = sql<boolean>`
  (
    exists (
      select 1
      from payment_intent pi
      join payment_allocation pa on pa.payment_intent_id = pi.id and pa.status = 'SETTLED'
      join bank_transaction bt on bt.id = pa.bank_transaction_id
        and lower(bt.provider) = 'sepay'
        and bt.direction = 'IN'
        and bt.signature_status = 'VERIFIED'
        and bt.merchant_account_id = pi.merchant_account_id
      where pi.order_id = o.id
        and pi.status = 'SUCCEEDED'
        and pi.amount_vnd = o.price_vnd
        and bt.amount_vnd = pi.amount_vnd
        and pa.allocated_amount_vnd = bt.amount_vnd
    )
    or exists (
      select 1
      from wallet_ledger wl
      join wallet_account wa on wa.id = wl.wallet_account_id
        and wa.customer_id = o.customer_id
      join ledger_transaction lt on lt.wallet_account_id = wa.id
        and lt.idempotency_key = 'wallet_ledger:' || wl.id
        and lt.transaction_type = 'PURCHASE'
        and lt.status = 'POSTED'
      where wl.entry_type = 'DEBIT'
        and wl.amount_vnd = o.price_vnd
        and left(wl.idempotency_key, length('purchase:' || o.id || ':')) =
          'purchase:' || o.id || ':'
        and (select count(*) from ledger_posting p where p.transaction_id = lt.id) = 2
        and exists (
          select 1 from ledger_posting p
          join ledger_account a on a.id = p.account_id
          where p.transaction_id = lt.id
            and p.side = 'DEBIT'
            and p.amount_minor = wl.amount_vnd
            and a.wallet_account_id = wa.id
            and a.account_type = 'LIABILITY'
        )
        and exists (
          select 1 from ledger_posting p
          join ledger_account a on a.id = p.account_id
          where p.transaction_id = lt.id
            and p.side = 'CREDIT'
            and p.amount_minor = wl.amount_vnd
            and a.code = 'SHOP:REVENUE'
            and a.account_type = 'REVENUE'
        )
    )
  )
`;

export type ManualTaskStatus = "OPEN" | "COMPLETED";
export type ManualTaskFulfillmentType =
  "MANUAL_FULFILLMENT" | "UNLIMITED_SERVICE" | "QUANTITY_STOCK";

type ServiceDefinition = {
  fulfillment_type: ManualTaskFulfillmentType;
  instructions: string;
};

type ManualTaskRow = {
  id: string;
  order_id: string;
  customer_id: string;
  variant_id: string;
  fulfillment_type: ManualTaskFulfillmentType;
  instructions: string;
  status: ManualTaskStatus;
  completed_by: string | null;
  completed_at: Date | string | null;
  completion_correlation_id: string | null;
  created_at: Date | string;
  updated_at: Date | string;
  version: number;
};

export interface ManualFulfillmentTask {
  id: string;
  orderId: string;
  customerId: string;
  variantId: string;
  fulfillmentType: ManualTaskFulfillmentType;
  instructions: string;
  status: ManualTaskStatus;
  completedBy: string | null;
  completedAt: string | null;
  completionCorrelationId: string | null;
  createdAt: string;
  updatedAt: string;
  version: number;
}

export interface AdminManualFulfillmentTask {
  taskId: string;
  orderId: string;
  orderNumber: string;
  customerName: string;
  productName: string;
  variantName: string;
  instructions: string;
  amountVnd: string;
  createdAt: string;
  status: ManualTaskStatus;
  fulfillmentType: ManualTaskFulfillmentType;
  taskVersion: number;
  orderVersion: number;
  expectedVersion: string;
}

export interface AdminManualFulfillmentTaskPage {
  tasks: AdminManualFulfillmentTask[];
  offset: number;
  hasMore: boolean;
}

export type CreateManualTaskResult =
  | { ok: true; task: ManualFulfillmentTask; inserted: boolean }
  | { ok: false; code: "NOT_CONFIGURED" };

export type CompleteManualTaskResult =
  | { ok: true; taskId: string; orderId: string; alreadyCompleted: boolean }
  | {
      ok: false;
      code: "NOT_FOUND" | "ORDER_NOT_PROCESSING" | "PAYMENT_NOT_SETTLED" | "STALE";
      message: string;
    };

function toIso(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function mapTask(row: ManualTaskRow): ManualFulfillmentTask {
  return {
    id: row.id,
    orderId: row.order_id,
    customerId: row.customer_id,
    variantId: row.variant_id,
    fulfillmentType: row.fulfillment_type,
    instructions: row.instructions,
    status: row.status,
    completedBy: row.completed_by,
    completedAt: toIso(row.completed_at),
    completionCorrelationId: row.completion_correlation_id,
    createdAt: toIso(row.created_at)!,
    updatedAt: toIso(row.updated_at)!,
    version: row.version,
  };
}

export async function getManualTaskByOrder(
  exec: Executor,
  orderId: string,
): Promise<ManualFulfillmentTask | null> {
  const result = await sql<ManualTaskRow>`
    select * from manual_fulfillment_task where order_id = ${orderId} limit 1
  `.execute(exec);
  return result.rows[0] ? mapTask(result.rows[0]) : null;
}

export async function getManualTaskById(
  exec: Executor,
  taskId: string,
): Promise<ManualFulfillmentTask | null> {
  const result = await sql<ManualTaskRow>`
    select * from manual_fulfillment_task where id = ${taskId} limit 1
  `.execute(exec);
  return result.rows[0] ? mapTask(result.rows[0]) : null;
}

async function getServiceDefinition(
  exec: Executor,
  variantId: string,
): Promise<ServiceDefinition | null> {
  const result = await sql<ServiceDefinition>`
    select fulfillment_type, instructions
    from variant_service_fulfillment
    where variant_id = ${variantId}
      and fulfillment_type in ('MANUAL_FULFILLMENT','UNLIMITED_SERVICE','QUANTITY_STOCK')
      and is_active
    limit 1
  `.execute(exec);
  return result.rows[0] ?? null;
}

export async function createManualFulfillmentTaskForOrder(
  exec: Executor,
  input: { orderId: string; customerId: string; variantId: string; correlationId: string },
): Promise<CreateManualTaskResult> {
  const existing = await getManualTaskByOrder(exec, input.orderId);
  if (existing) return { ok: true, task: existing, inserted: false };

  const service = await getServiceDefinition(exec, input.variantId);
  if (!service) return { ok: false, code: "NOT_CONFIGURED" };

  const id = newId();
  const inserted = await sql<ManualTaskRow>`
    insert into manual_fulfillment_task
      (id, order_id, customer_id, variant_id, fulfillment_type, instructions, status)
    values
      (${id}, ${input.orderId}, ${input.customerId}, ${input.variantId},
       ${service.fulfillment_type}, ${service.instructions}, 'OPEN')
    on conflict (order_id) do nothing
    returning *
  `.execute(exec);
  const row = inserted.rows[0];
  if (!row) {
    const winner = await getManualTaskByOrder(exec, input.orderId);
    if (!winner) throw new Error("manual task idempotency winner was not visible");
    return { ok: true, task: winner, inserted: false };
  }

  await enqueueOutboxEvent(exec, {
    id: newId(),
    aggregateType: "ManualFulfillmentTask",
    aggregateId: row.id,
    aggregateVersion: row.version,
    eventType: "ManualFulfillmentTaskCreated",
    payloadRedacted: {
      taskId: row.id,
      orderId: input.orderId,
      customerId: input.customerId,
      variantId: input.variantId,
      fulfillmentType: row.fulfillment_type,
      correlationId: input.correlationId,
    },
  });

  return { ok: true, task: mapTask(row), inserted: true };
}

export async function listManualFulfillmentTasks(
  exec: Executor,
  input: { status?: ManualTaskStatus; limit?: number } = {},
): Promise<ManualFulfillmentTask[]> {
  const limit = Math.max(1, Math.min(input.limit ?? 50, 200));
  const result = await sql<ManualTaskRow>`
    select m.*
    from manual_fulfillment_task m
    join "order" o on o.id = m.order_id
    where (${input.status ?? null}::text is null or m.status = ${input.status ?? null})
      and (
        m.fulfillment_type not in ('MANUAL_FULFILLMENT', 'UNLIMITED_SERVICE')
        or ${manualServicePaymentEvidence}
      )
    order by m.created_at asc, m.id asc
    limit ${limit}
  `.execute(exec);
  return result.rows.map(mapTask);
}

type AdminManualTaskRow = {
  task_id: string;
  order_id: string;
  order_number: string;
  customer_name: string | null;
  product_name: string;
  variant_name: string;
  instructions: string;
  amount_vnd: string;
  created_at: Date | string;
  status: ManualTaskStatus;
  fulfillment_type: ManualTaskFulfillmentType;
  task_version: number;
  order_version: number;
};

function mapAdminManualTask(row: AdminManualTaskRow): AdminManualFulfillmentTask {
  return {
    taskId: row.task_id,
    orderId: row.order_id,
    orderNumber: row.order_number,
    customerName: row.customer_name ?? "Khách không có tên",
    productName: row.product_name,
    variantName: row.variant_name,
    instructions: row.instructions,
    amountVnd: row.amount_vnd,
    createdAt: toIso(row.created_at)!,
    status: row.status,
    fulfillmentType: row.fulfillment_type,
    taskVersion: row.task_version,
    orderVersion: row.order_version,
    expectedVersion: `${row.order_version}:${row.task_version}`,
  };
}

async function loadAdminManualTaskRows(
  exec: Executor,
  input: { taskId?: string; limit: number; offset: number },
): Promise<AdminManualTaskRow[]> {
  const taskId = input.taskId ?? null;
  const result = await sql<AdminManualTaskRow>`
    select
      m.id as task_id,
      o.id as order_id,
      o.order_number,
      cps.display_name as customer_name,
      coalesce(nullif(o.product_name_vi, ''), p.name_vi) as product_name,
      coalesce(nullif(o.variant_name_vi, ''), v.name_vi) as variant_name,
      m.instructions,
      o.price_vnd::text as amount_vnd,
      m.created_at,
      m.status,
      m.fulfillment_type,
      m.version as task_version,
      o.version as order_version
    from manual_fulfillment_task m
    join "order" o on o.id = m.order_id
    join product_variant v on v.id = o.variant_id
    join product p on p.id = v.product_id
    left join customer_profile_snapshot cps on cps.customer_id = o.customer_id
    where (${taskId}::text is null or m.id = ${taskId})
      and (${taskId}::text is not null or m.status = 'OPEN')
      and (${taskId}::text is not null or o.status = 'PROCESSING')
      and not p.is_test
      and p.name_vi not ilike '%canary%'
      and not exists (
        select 1 from test_customer_allowlist a
        join channel_identity ci
          on ci.channel = 'TELEGRAM'
         and ci.channel_user_id = a.telegram_user_id
         and ci.customer_id = o.customer_id
      )
      and (
        m.fulfillment_type not in ('MANUAL_FULFILLMENT', 'UNLIMITED_SERVICE')
        or ${manualServicePaymentEvidence}
      )
    order by m.created_at asc, m.id asc
    limit ${input.limit} offset ${input.offset}
  `.execute(exec);
  return result.rows;
}

export async function listAdminManualFulfillmentTasks(
  exec: Executor,
  input: { offset?: number; limit?: number } = {},
): Promise<AdminManualFulfillmentTaskPage> {
  const offset = input.offset ?? 0;
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > 10_000)
    throw new RangeError("manual task offset must be 0..10000");
  const limit = Math.min(20, Math.max(1, input.limit ?? 20));
  const rows = await loadAdminManualTaskRows(exec, { limit: limit + 1, offset });
  return {
    tasks: rows.slice(0, limit).map(mapAdminManualTask),
    offset,
    hasMore: rows.length > limit,
  };
}

export async function getAdminManualFulfillmentTask(
  exec: Executor,
  taskId: string,
): Promise<AdminManualFulfillmentTask | null> {
  const [row] = await loadAdminManualTaskRows(exec, { taskId, limit: 1, offset: 0 });
  return row ? mapAdminManualTask(row) : null;
}

export async function completeManualFulfillmentTaskInTransaction(
  trx: Trx,
  input: {
    taskId: string;
    actorId: string;
    correlationId: string;
    expectedVersion: string;
  },
): Promise<CompleteManualTaskResult> {
  const expected = /^(0|[1-9][0-9]*):(0|[1-9][0-9]*)$/.exec(input.expectedVersion);
  if (!expected)
    return { ok: false, code: "STALE", message: "Tác vụ đã thay đổi. Vui lòng mở lại danh sách." };
  const existing = await getManualTaskById(trx, input.taskId);
  if (!existing) return { ok: false, code: "NOT_FOUND", message: "Không tìm thấy tác vụ." };

  const order = await findOrderByIdForUpdate(trx, existing.orderId);
  if (!order) return { ok: false, code: "NOT_FOUND", message: "Không tìm thấy đơn hàng." };

  const taskResult = await sql<ManualTaskRow>`
    select * from manual_fulfillment_task where id = ${input.taskId} for update
  `.execute(trx);
  const task = taskResult.rows[0];
  if (!task) return { ok: false, code: "NOT_FOUND", message: "Không tìm thấy tác vụ." };
  if (task.order_id !== order.id)
    return {
      ok: false,
      code: "ORDER_NOT_PROCESSING",
      message: "Trạng thái đơn hàng không còn phù hợp.",
    };
  if (task.status === "COMPLETED")
    return { ok: true, taskId: task.id, orderId: task.order_id, alreadyCompleted: true };

  if (order.version !== Number(expected[1]) || task.version !== Number(expected[2]))
    return { ok: false, code: "STALE", message: "Tác vụ đã thay đổi. Vui lòng mở lại danh sách." };
  if (order.status !== "PROCESSING")
    return {
      ok: false,
      code: "ORDER_NOT_PROCESSING",
      message: "Trạng thái đơn hàng không còn phù hợp.",
    };

  if (
    task.fulfillment_type === "MANUAL_FULFILLMENT" ||
    task.fulfillment_type === "UNLIMITED_SERVICE"
  ) {
    const payment = await sql<{ verified: boolean }>`
      select ${manualServicePaymentEvidence} as verified
      from "order" o
      where o.id = ${order.id}
    `.execute(trx);
    if (!payment.rows[0]?.verified)
      return {
        ok: false,
        code: "PAYMENT_NOT_SETTLED",
        message: "Đơn chưa xác nhận thanh toán.",
      };
  }

  let quantityReserve: { id: string; variant_id: string; quantity_after: number } | null = null;
  if (task.fulfillment_type === "QUANTITY_STOCK") {
    const reserved = await sql<{ id: string; variant_id: string; quantity_after: number }>`
      select r.id, r.variant_id, s.available_quantity::int as quantity_after
      from quantity_stock_ledger r
      join variant_quantity_stock s on s.variant_id = r.variant_id
      where r.order_id = ${task.order_id}
        and r.entry_type = 'RESERVE'
        and r.released_at is null
        and not exists (select 1 from quantity_stock_ledger d where d.parent_ledger_id = r.id and d.entry_type = 'DELIVER')
      limit 1
      for update of r, s
    `.execute(trx);
    quantityReserve = reserved.rows[0] ?? null;
    if (!quantityReserve)
      return {
        ok: false,
        code: "ORDER_NOT_PROCESSING",
        message: "Trạng thái đơn hàng không còn phù hợp.",
      };
  }

  const newTaskVersion = nextVersion(task.version);
  const completed = await sql<ManualTaskRow>`
    update manual_fulfillment_task
    set status = 'COMPLETED',
        completed_by = ${input.actorId},
        completed_at = now(),
        completion_correlation_id = ${input.correlationId},
        updated_at = now(),
        version = ${newTaskVersion}
    where id = ${task.id} and version = ${task.version} and status = 'OPEN'
    returning *
  `.execute(trx);
  if (!completed.rows[0]) throw new Error("manual task completion lost its row lock");

  if (quantityReserve) {
    await sql`
      insert into quantity_stock_ledger
        (id, variant_id, order_id, entry_type, quantity_delta, quantity_after, parent_ledger_id)
      values (${newId()}, ${quantityReserve.variant_id}, ${task.order_id}, 'DELIVER', 0, ${quantityReserve.quantity_after}, ${quantityReserve.id})
      on conflict do nothing
    `.execute(trx);
  }

  const completedOrder = await transitionOrder(
    trx,
    order,
    "COMPLETED",
    "MANUAL_FULFILLMENT_COMPLETED",
    input.correlationId,
    { type: "ROOT_ADMIN", id: input.actorId },
  );

  await appendAuditEvent(trx, {
    actorType: "ROOT_ADMIN",
    actorId: input.actorId,
    action: "manual_fulfillment.complete",
    targetType: "ManualFulfillmentTask",
    targetId: task.id,
    reason: "manual fulfillment completed",
    correlationId: input.correlationId,
    metadataRedacted: {
      orderId: task.order_id,
      orderVersion: completedOrder.version,
      taskVersion: newTaskVersion,
      fulfillmentType: task.fulfillment_type,
    },
  });

  await enqueueOutboxEvent(trx, {
    id: newId(),
    aggregateType: "ManualFulfillmentTask",
    aggregateId: task.id,
    aggregateVersion: newTaskVersion,
    eventType: "ManualFulfillmentTaskCompleted",
    payloadRedacted: {
      taskId: task.id,
      orderId: task.order_id,
      customerId: task.customer_id,
      completedBy: input.actorId,
      correlationId: input.correlationId,
    },
  });

  return { ok: true, taskId: task.id, orderId: task.order_id, alreadyCompleted: false };
}
