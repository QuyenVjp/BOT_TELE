import { sql } from "kysely";
import { guardRootAction } from "../../bot/middleware/root-admin.js";
import type { Executor, Db } from "../../infrastructure/db/transaction.js";
import { withTransaction } from "../../infrastructure/db/transaction.js";
import { enqueueOutboxEvent } from "../../infrastructure/outbox/repository.js";
import { nextVersion } from "../../infrastructure/db/version.js";
import { newId } from "../../shared/ids/index.js";
import { findOrderByIdForUpdate, transitionOrder } from "../commerce/repository.js";
import type { RootActor, RootAdminConfig } from "../identity/root-admin.js";
import { appendAuditEvent } from "../identity/audit.js";

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

export type CreateManualTaskResult =
  | { ok: true; task: ManualFulfillmentTask; inserted: boolean }
  | { ok: false; code: "NOT_CONFIGURED" };

export type CompleteManualTaskResult =
  | { ok: true; taskId: string; orderId: string; alreadyCompleted: boolean }
  | { ok: false; code: "NOT_FOUND" | "ORDER_NOT_PROCESSING" | "NOT_ROOT_ADMIN" | "WRONG_CONTEXT" };

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
    select * from manual_fulfillment_task
    where (${input.status ?? null}::text is null or status = ${input.status ?? null})
    order by created_at asc, id asc
    limit ${limit}
  `.execute(exec);
  return result.rows.map(mapTask);
}

export async function completeManualFulfillmentTaskInTransaction(
  trx: Executor,
  input: { taskId: string; actorId: string; correlationId: string },
): Promise<CompleteManualTaskResult> {
  const existing = await getManualTaskById(trx, input.taskId);
  if (!existing) return { ok: false, code: "NOT_FOUND" };

  const order = await findOrderByIdForUpdate(trx, existing.orderId);
  if (!order || (order.status !== "PROCESSING" && order.status !== "COMPLETED")) {
    return { ok: false, code: "ORDER_NOT_PROCESSING" };
  }

  const taskResult = await sql<ManualTaskRow>`
    select * from manual_fulfillment_task where id = ${input.taskId} for update
  `.execute(trx);
  const task = taskResult.rows[0];
  if (!task) return { ok: false, code: "NOT_FOUND" };
  if (task.order_id !== order.id) return { ok: false, code: "ORDER_NOT_PROCESSING" };

  if (task.status === "COMPLETED") {
    return { ok: true, taskId: task.id, orderId: task.order_id, alreadyCompleted: true };
  }
  if (order.status !== "PROCESSING") return { ok: false, code: "ORDER_NOT_PROCESSING" };

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
    if (!quantityReserve) return { ok: false, code: "ORDER_NOT_PROCESSING" };
  }

  const newVersion = nextVersion(task.version);
  const completed = await sql<ManualTaskRow>`
    update manual_fulfillment_task
    set status = 'COMPLETED',
        completed_by = ${input.actorId},
        completed_at = now(),
        completion_correlation_id = ${input.correlationId},
        updated_at = now(),
        version = ${newVersion}
    where id = ${task.id} and version = ${task.version} and status = 'OPEN'
    returning *
  `.execute(trx);
  const completedTask = completed.rows[0];
  if (!completedTask) throw new Error("manual task completion lost its row lock");

  if (quantityReserve) {
    await sql`
      insert into quantity_stock_ledger
        (id, variant_id, order_id, entry_type, quantity_delta, quantity_after, parent_ledger_id)
      values (${newId()}, ${quantityReserve.variant_id}, ${task.order_id}, 'DELIVER', 0, ${quantityReserve.quantity_after}, ${quantityReserve.id})
      on conflict do nothing
    `.execute(trx);
  }

  await transitionOrder(
    trx,
    order,
    "COMPLETED",
    "MANUAL_FULFILLMENT_COMPLETED",
    input.correlationId,
    {
      type: "ROOT_ADMIN",
      id: input.actorId,
    },
  );

  await appendAuditEvent(trx, {
    actorType: "ROOT_ADMIN",
    actorId: input.actorId,
    action: "manual_fulfillment.complete",
    targetType: "ManualFulfillmentTask",
    targetId: task.id,
    reason: "manual fulfillment completed",
    correlationId: input.correlationId,
    metadataRedacted: { orderId: task.order_id, fulfillmentType: task.fulfillment_type },
  });

  await enqueueOutboxEvent(trx, {
    id: newId(),
    aggregateType: "ManualFulfillmentTask",
    aggregateId: task.id,
    aggregateVersion: newVersion,
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

export async function completeManualFulfillmentTask(
  db: Db,
  input: {
    taskId: string;
    actor: RootActor;
    config: RootAdminConfig;
    correlationId: string;
  },
): Promise<CompleteManualTaskResult> {
  const gate = await guardRootAction(db, {
    actor: input.actor,
    config: input.config,
    correlationId: input.correlationId,
    action: "manual_fulfillment.complete",
    targetType: "ManualFulfillmentTask",
    targetId: input.taskId,
  });
  if (!gate.ok) return { ok: false, code: gate.reason };

  return withTransaction(db, (trx) =>
    completeManualFulfillmentTaskInTransaction(trx, {
      taskId: input.taskId,
      actorId: String(input.actor.numericUserId),
      correlationId: input.correlationId,
    }),
  );
}
