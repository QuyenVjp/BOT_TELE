import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { createAdminCallbacks } from "../../src/bot/callbacks/admin.js";
import { createAdminConfirmation } from "../../src/modules/identity/admin-confirmation.js";
import { loadSensitiveAuthorizationBinding } from "../../src/modules/identity/authorization-binding.js";
import { createInMemoryVault } from "../../src/infrastructure/vault/testing-adapter.js";
import { withTransaction } from "../../src/infrastructure/db/transaction.js";
import { fulfillPaidOrder } from "../../src/modules/digital-goods/fulfillment.js";
import { createWalletLedgerService } from "../../src/modules/wallet/ledger.js";
import { createWalletPurchaseService } from "../../src/modules/wallet/purchase.js";
import {
  completeManualFulfillmentTaskInTransaction,
  getAdminManualFulfillmentTask,
  listAdminManualFulfillmentTasks,
  listManualFulfillmentTasks,
} from "../../src/modules/digital-goods/manual-fulfillment.js";
import { newId } from "../../src/shared/ids/index.js";
import { startPostgresContainer, type PgTestContext } from "../helpers/pg-container.js";

let ctx: PgTestContext;

beforeAll(async () => {
  ctx = await startPostgresContainer();
}, 180_000);

afterAll(async () => {
  await ctx?.teardown();
});

beforeEach(async () => {
  await sql`
    truncate table admin_confirmation, channel_identity, delivery_bundle, digital_asset,
      order_transition, outbox_event, payment_allocation, payment_intent, bank_transaction,
      "order", variant_service_fulfillment, product_variant, product, category, customer,
      audit_event cascade
  `.execute(ctx.db);
});

async function seedServiceOrder(input: {
  fulfillmentType: "MANUAL_FULFILLMENT" | "UNLIMITED_SERVICE";
  orderStatus?: "PENDING_PAYMENT" | "PAID" | "PROCESSING" | "COMPLETED";
}) {
  const categoryId = newId();
  const productId = newId();
  const variantId = newId();
  const customerId = newId();
  const orderId = newId();

  await sql`insert into category (id, name_vi, slug, is_active, sort_order) values (${categoryId}, 'C', ${categoryId.slice(-8)}, true, 1)`.execute(
    ctx.db,
  );
  await sql`insert into product (id, category_id, name_vi, slug, is_active, sort_order) values (${productId}, ${categoryId}, 'P', ${productId.slice(-8)}, true, 1)`.execute(
    ctx.db,
  );
  await sql`
    insert into product_variant
      (id, product_id, sku, name_vi, price_vnd, duration_code, delivery_type,
       stock_policy, resale_evidence_id, fulfillment_type)
    values
      (${variantId}, ${productId}, ${`SKU-${variantId}`}, 'V', 100000, 'P1M',
       'MANUAL_REVIEW', 'LOCAL_ONLY', 'RES-1', ${input.fulfillmentType})
  `.execute(ctx.db);
  await sql`
    insert into variant_service_fulfillment (variant_id, fulfillment_type, instructions, is_active)
    values (${variantId}, ${input.fulfillmentType}, 'Provision manually after checking customer account.', true)
  `.execute(ctx.db);
  await sql`insert into customer (id, status, locale) values (${customerId}, 'ACTIVE', 'vi')`.execute(
    ctx.db,
  );
  await sql`
    insert into "order" (id, order_number, customer_id, variant_id, product_name_vi, variant_name_vi,
      price_vnd, duration_code, delivery_type, fulfillment_type, status, paid_at)
    values (${orderId}, ${`ORD-${orderId}`}, ${customerId}, ${variantId}, 'P', 'V',
      100000, 'P1M', 'MANUAL_REVIEW', ${input.fulfillmentType},
      ${input.orderStatus ?? "PAID"},
      ${input.orderStatus === "PENDING_PAYMENT" ? null : new Date().toISOString()})
  `.execute(ctx.db);

  return { orderId, variantId, customerId };
}

async function settleManualTestOrder(orderId: string): Promise<{
  intentId: string;
  transactionId: string;
}> {
  const intentId = newId();
  const transactionId = newId();
  const amount = 100000;
  await sql`
    insert into payment_intent (id, order_id, status, amount_vnd, merchant_account_id,
      transfer_content, expires_at, settled_at)
    values (${intentId}, ${orderId}, 'SUCCEEDED', ${amount}, 'SEPAY-TEST',
      ${`TIER20-${intentId}`}, now() + interval '1 day', now())
  `.execute(ctx.db);
  await sql`
    insert into bank_transaction (id, provider, provider_transaction_id, direction,
      merchant_account_id, amount_vnd, content, reference, transacted_at, raw_hash,
      signature_status, schema_version)
    values (${transactionId}, 'sepay', ${`manual-test-${transactionId}`}, 'IN',
      'SEPAY-TEST', ${amount}, ${`TIER20-${intentId}`}, ${`REF-${transactionId}`},
      now(), ${`hash-${transactionId}`}, 'VERIFIED', 'test')
  `.execute(ctx.db);
  await sql`
    insert into payment_allocation (id, bank_transaction_id, payment_intent_id,
      allocated_amount_vnd, status, decision_code, correlation_id)
    values (${newId()}, ${transactionId}, ${intentId}, ${amount}, 'SETTLED',
      'EXACT_MATCH', ${`manual-test-${intentId}`})
  `.execute(ctx.db);
  return { intentId, transactionId };
}

async function createRootAdmin(stepUpEnabled = false) {
  const customerId = newId();
  const rootChannelIdentityId = newId();
  await sql`insert into customer (id, status, locale)
    values (${customerId}, 'ACTIVE', 'vi')`.execute(ctx.db);
  await sql`
    insert into channel_identity (id, customer_id, channel, channel_user_id, observed_username)
    values (${rootChannelIdentityId}, ${customerId}, 'TELEGRAM', '42', 'owner')
  `.execute(ctx.db);
  return createAdminCallbacks({
    db: ctx.db,
    rootConfig: { adminTelegramUserId: 42, expectedUsername: "owner" },
    rootChannelIdentityId,
    confirmation: createAdminConfirmation(ctx.db),
    stepUpEnabled,
  });
}

const rootActor = { numericUserId: 42, chatType: "private" as const, observedUsername: "owner" };

function fulfillmentDeps() {
  return {
    vault: createInMemoryVault(),
    supplier: null,
    deliveryBaseUrl: "https://shop.example/d",
    bundleTtlSeconds: 900,
  };
}

async function expectedTaskVersion(taskId: string): Promise<string> {
  const result = await sql<{ order_version: number; task_version: number }>`
    select o.version as order_version, m.version as task_version
    from manual_fulfillment_task m join "order" o on o.id = m.order_id
    where m.id = ${taskId}
  `.execute(ctx.db);
  const row = result.rows[0];
  if (!row) throw new Error("manual test task missing");
  return `${row.order_version}:${row.task_version}`;
}
describe("manual fulfillment tasks", () => {
  it.each(["MANUAL_FULFILLMENT", "UNLIMITED_SERVICE"] as const)(
    "fulfillPaidOrder creates one %s task without a delivery bundle",
    async (fulfillmentType) => {
      const f = await seedServiceOrder({ fulfillmentType });
      await settleManualTestOrder(f.orderId);
      const deps = {
        vault: createInMemoryVault(),
        supplier: null,
        deliveryBaseUrl: "https://shop.example/d",
        bundleTtlSeconds: 900,
      };

      const first = await fulfillPaidOrder(ctx.db, {
        orderId: f.orderId,
        correlationId: "manual-1",
        deps,
      });
      const second = await fulfillPaidOrder(ctx.db, {
        orderId: f.orderId,
        correlationId: "manual-1",
        deps,
      });

      expect(first).toMatchObject({ ok: true, kind: "WAITING_MANUAL", orderId: f.orderId });
      expect(second).toMatchObject({ ok: true, kind: "WAITING_MANUAL", orderId: f.orderId });

      const rows = await sql<{ status: string; instructions: string }>`
        select status, instructions from manual_fulfillment_task where order_id = ${f.orderId}
      `.execute(ctx.db);
      expect(rows.rows).toEqual([
        { status: "OPEN", instructions: "Provision manually after checking customer account." },
      ]);

      const outbox = await sql<{ count: number }>`
        select count(*)::int as count from outbox_event
        where event_type = 'ManualFulfillmentTaskCreated'
          and aggregate_id in (
            select id from manual_fulfillment_task where order_id = ${f.orderId}
          )
      `.execute(ctx.db);
      expect(outbox.rows[0]?.count).toBe(1);

      const bundles = await sql<{ count: number }>`
        select count(*)::int as count from delivery_bundle where order_id = ${f.orderId}
      `.execute(ctx.db);
      expect(bundles.rows[0]?.count).toBe(0);

      const order = await sql<{
        status: string;
      }>`select status from "order" where id = ${f.orderId}`.execute(ctx.db);
      expect(order.rows[0]?.status).toBe("PROCESSING");
    },
  );

  it("creates one task and transition when fulfillment runs concurrently for the same paid order", async () => {
    const f = await seedServiceOrder({ fulfillmentType: "MANUAL_FULFILLMENT" });
    await settleManualTestOrder(f.orderId);
    const deps = fulfillmentDeps();

    const results = await Promise.all([
      fulfillPaidOrder(ctx.db, {
        orderId: f.orderId,
        correlationId: "manual-race-1",
        deps,
      }),
      fulfillPaidOrder(ctx.db, {
        orderId: f.orderId,
        correlationId: "manual-race-2",
        deps,
      }),
    ]);

    expect(results).toEqual([
      expect.objectContaining({ ok: true, kind: "WAITING_MANUAL", orderId: f.orderId }),
      expect.objectContaining({ ok: true, kind: "WAITING_MANUAL", orderId: f.orderId }),
    ]);
    const taskIds = results.map((result) =>
      result.ok && result.kind === "WAITING_MANUAL" ? result.taskId : null,
    );
    expect(taskIds[0]).toBe(taskIds[1]);

    const state = await sql<{
      tasks: number;
      createdEvents: number;
      processingTransitions: number;
      orderStatus: string;
    }>`
      select
        (select count(*)::int from manual_fulfillment_task where order_id = ${f.orderId}) as tasks,
        (select count(*)::int from outbox_event
          where event_type = 'ManualFulfillmentTaskCreated'
            and aggregate_id in (select id from manual_fulfillment_task where order_id = ${f.orderId})
        ) as "createdEvents",
        (select count(*)::int from order_transition
          where order_id = ${f.orderId} and to_status = 'PROCESSING'
        ) as "processingTransitions",
        o.status as "orderStatus"
      from "order" o where o.id = ${f.orderId}
    `.execute(ctx.db);
    expect(state.rows[0]).toEqual({
      tasks: 1,
      createdEvents: 1,
      processingTransitions: 1,
      orderStatus: "PROCESSING",
    });
  });

  it("does not create a manual task for an unpaid order", async () => {
    const f = await seedServiceOrder({
      fulfillmentType: "MANUAL_FULFILLMENT",
      orderStatus: "PENDING_PAYMENT",
    });

    const result = await fulfillPaidOrder(ctx.db, {
      orderId: f.orderId,
      correlationId: "manual-pending",
      deps: fulfillmentDeps(),
    });

    expect(result).toMatchObject({ ok: false, code: "NOT_PAID" });
    const rows = await sql<{ count: number }>`
      select count(*)::int as count from manual_fulfillment_task where order_id = ${f.orderId}
    `.execute(ctx.db);
    expect(rows.rows[0]?.count).toBe(0);
  });

  it("keeps the paid order on the original service task snapshot after variant config changes", async () => {
    const f = await seedServiceOrder({ fulfillmentType: "UNLIMITED_SERVICE" });
    await settleManualTestOrder(f.orderId);
    const deps = {
      vault: createInMemoryVault(),
      supplier: null,
      deliveryBaseUrl: "https://shop.example/d",
      bundleTtlSeconds: 900,
    };
    const first = await fulfillPaidOrder(ctx.db, {
      orderId: f.orderId,
      correlationId: "manual-snapshot-1",
      deps,
    });
    expect(first).toMatchObject({
      ok: true,
      kind: "WAITING_MANUAL",
      fulfillmentType: "UNLIMITED_SERVICE",
    });

    await sql`update product_variant set fulfillment_type = 'STOCK_ACCOUNT' where id = ${f.variantId}`.execute(
      ctx.db,
    );
    const replay = await fulfillPaidOrder(ctx.db, {
      orderId: f.orderId,
      correlationId: "manual-snapshot-2",
      deps,
    });
    expect(replay).toMatchObject({
      ok: true,
      kind: "WAITING_MANUAL",
      fulfillmentType: "UNLIMITED_SERVICE",
    });
  });

  it("completes concurrent requests for one manual task as a single audited event", async () => {
    const f = await seedServiceOrder({ fulfillmentType: "UNLIMITED_SERVICE" });
    await settleManualTestOrder(f.orderId);
    await fulfillPaidOrder(ctx.db, {
      orderId: f.orderId,
      correlationId: "manual-2",
      deps: fulfillmentDeps(),
    });

    const tasks = await listManualFulfillmentTasks(ctx.db, { status: "OPEN" });
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      orderId: f.orderId,
      status: "OPEN",
      fulfillmentType: "UNLIMITED_SERVICE",
    });
    const safeTask = await getAdminManualFulfillmentTask(ctx.db, tasks[0]!.id);
    expect(safeTask?.orderNumber).toBe(`ORD-${f.orderId}`);
    expect(safeTask?.instructions).toBe("Provision manually after checking customer account.");

    const input = {
      taskId: tasks[0]!.id,
      actorId: "42",
      correlationId: "complete-1",
      expectedVersion: safeTask!.expectedVersion,
    };
    const results = await Promise.all([
      withTransaction(ctx.db, (trx) => completeManualFulfillmentTaskInTransaction(trx, input)),
      withTransaction(ctx.db, (trx) => completeManualFulfillmentTaskInTransaction(trx, input)),
    ]);
    expect(results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ ok: true, alreadyCompleted: false, orderId: f.orderId }),
        expect.objectContaining({ ok: true, alreadyCompleted: true, orderId: f.orderId }),
      ]),
    );

    const state = await sql<{
      task_status: string;
      completed_by: string | null;
      order_status: string;
      transitions: number;
      audits: number;
      completionEvents: number;
    }>`
      select m.status as task_status, m.completed_by,
        o.status as order_status,
        (select count(*)::int from order_transition where order_id = o.id and to_status = 'COMPLETED') as transitions,
        (select count(*)::int from audit_event where target_type = 'ManualFulfillmentTask' and target_id = m.id and action = 'manual_fulfillment.complete') as audits,
        (select count(*)::int from outbox_event
          where aggregate_type = 'ManualFulfillmentTask' and aggregate_id = m.id
            and event_type = 'ManualFulfillmentTaskCompleted') as "completionEvents"
      from manual_fulfillment_task m join "order" o on o.id = m.order_id where m.id = ${tasks[0]!.id}
    `.execute(ctx.db);
    expect(state.rows[0]).toEqual({
      task_status: "COMPLETED",
      completed_by: "42",
      order_status: "COMPLETED",
      transitions: 1,
      audits: 1,
      completionEvents: 1,
    });
  });

  it("completes concurrent durable confirmation attempts for one manual task exactly once", async () => {
    const f = await seedServiceOrder({ fulfillmentType: "MANUAL_FULFILLMENT" });
    await settleManualTestOrder(f.orderId);
    await fulfillPaidOrder(ctx.db, {
      orderId: f.orderId,
      correlationId: "manual-durable-concurrent-fulfillment",
      deps: fulfillmentDeps(),
    });

    const [task] = await listManualFulfillmentTasks(ctx.db, { status: "OPEN" });
    const view = await getAdminManualFulfillmentTask(ctx.db, task!.id);
    expect(view?.expectedVersion).toBeDefined();
    const admin = await createRootAdmin();
    const issued = await admin.handle({
      command: "manual_fulfillment.complete",
      actor: rootActor,
      targetId: task!.id,
      expectedVersion: view!.expectedVersion,
      reason: "Confirm concurrent manual completion",
      correlationId: "manual-durable-concurrent-issue",
    });
    expect(issued).toMatchObject({ ok: true, needsConfirmation: true });
    if (!issued.ok || !issued.needsConfirmation) return;

    const results = await Promise.all([
      admin.confirm({
        confirmationId: issued.confirmationId,
        challenge: issued.challenge,
        actor: rootActor,
        correlationId: "manual-durable-concurrent-confirm-1",
      }),
      admin.confirm({
        confirmationId: issued.confirmationId,
        challenge: issued.challenge,
        actor: rootActor,
        correlationId: "manual-durable-concurrent-confirm-2",
      }),
    ]);
    expect(results).toEqual([{ ok: true }, { ok: true }]);

    const state = await sql<{
      taskStatus: string;
      orderStatus: string;
      transitions: number;
      audits: number;
      completionEvents: number;
    }>`
      select m.status as "taskStatus", o.status as "orderStatus",
        (select count(*)::int from order_transition
          where order_id = o.id and to_status = 'COMPLETED') as transitions,
        (select count(*)::int from audit_event
          where target_type = 'ManualFulfillmentTask' and target_id = m.id
            and action = 'manual_fulfillment.complete') as audits,
        (select count(*)::int from outbox_event
          where aggregate_type = 'ManualFulfillmentTask' and aggregate_id = m.id
            and event_type = 'ManualFulfillmentTaskCompleted') as "completionEvents"
      from manual_fulfillment_task m join "order" o on o.id = m.order_id
      where m.id = ${task!.id}
    `.execute(ctx.db);
    expect(state.rows[0]).toEqual({
      taskStatus: "COMPLETED",
      orderStatus: "COMPLETED",
      transitions: 1,
      audits: 1,
      completionEvents: 1,
    });
  });

  it("shows and completes a manual service order paid through the real wallet purchase path", async () => {
    const f = await seedServiceOrder({
      fulfillmentType: "MANUAL_FULFILLMENT",
      orderStatus: "PENDING_PAYMENT",
    });
    const funding = await createWalletLedgerService(ctx.db).credit({
      customerId: f.customerId,
      amountVnd: 250_000n,
      idempotencyKey: `topup:manual-task:${f.orderId}`,
      correlationId: `manual-task-fund:${f.orderId}`,
      reason: "manual fulfillment test funding",
    });
    expect(funding.ok).toBe(true);

    const purchase = await createWalletPurchaseService(ctx.db).purchase({
      customerId: f.customerId,
      orderId: f.orderId,
      idempotencyKey: "manual-task",
      correlationId: "manual-wallet-purchase",
    });
    expect(purchase).toMatchObject({ ok: true, kind: "PAID", orderId: f.orderId });

    const fulfilled = await fulfillPaidOrder(ctx.db, {
      orderId: f.orderId,
      correlationId: "manual-wallet-fulfillment",
      deps: fulfillmentDeps(),
    });
    expect(fulfilled).toMatchObject({
      ok: true,
      kind: "WAITING_MANUAL",
      fulfillmentType: "MANUAL_FULFILLMENT",
    });

    const queue = await listAdminManualFulfillmentTasks(ctx.db);
    expect(queue.tasks).toHaveLength(1);
    expect(queue.tasks[0]).toMatchObject({ orderId: f.orderId });
    const task = await getAdminManualFulfillmentTask(ctx.db, queue.tasks[0]!.taskId);
    expect(task?.expectedVersion).toBeDefined();

    const completed = await withTransaction(ctx.db, (trx) =>
      completeManualFulfillmentTaskInTransaction(trx, {
        taskId: queue.tasks[0]!.taskId,
        actorId: "42",
        correlationId: "manual-wallet-complete",
        expectedVersion: task!.expectedVersion,
      }),
    );
    expect(completed).toMatchObject({
      ok: true,
      alreadyCompleted: false,
      orderId: f.orderId,
    });

    const state = await sql<{ taskStatus: string; orderStatus: string }>`
      select m.status as "taskStatus", o.status as "orderStatus"
      from manual_fulfillment_task m join "order" o on o.id = m.order_id
      where m.id = ${queue.tasks[0]!.taskId}
    `.execute(ctx.db);
    expect(state.rows[0]).toEqual({ taskStatus: "COMPLETED", orderStatus: "COMPLETED" });
  });

  it.each([
    ["a second canonical wallet purchase is added", "second-purchase"],
    ["the wallet owner no longer matches the order customer", "wallet-owner"],
    ["the canonical SHOP:REVENUE account code changes", "revenue-account"],
  ] as const)(
    "refuses a durable completion challenge when %s",
    async (_description, invalidEvidence) => {
      const f = await seedServiceOrder({
        fulfillmentType: "MANUAL_FULFILLMENT",
        orderStatus: "PENDING_PAYMENT",
      });
      const wallet = createWalletLedgerService(ctx.db);
      const funding = await wallet.credit({
        customerId: f.customerId,
        amountVnd: 250_000n,
        idempotencyKey: `topup:manual-evidence:${f.orderId}`,
        correlationId: "manual-evidence-fund",
        reason: "manual fulfillment test funding",
      });
      expect(funding.ok).toBe(true);
      const purchase = await createWalletPurchaseService(ctx.db).purchase({
        customerId: f.customerId,
        orderId: f.orderId,
        idempotencyKey: "manual-evidence",
        correlationId: "manual-evidence-purchase",
      });
      expect(purchase).toMatchObject({ ok: true, kind: "PAID", orderId: f.orderId });
      const fulfilled = await fulfillPaidOrder(ctx.db, {
        orderId: f.orderId,
        correlationId: "manual-evidence-fulfillment",
        deps: fulfillmentDeps(),
      });
      expect(fulfilled).toMatchObject({ ok: true, kind: "WAITING_MANUAL" });
      if (!fulfilled.ok || fulfilled.kind !== "WAITING_MANUAL") return;

      const view = await getAdminManualFulfillmentTask(ctx.db, fulfilled.taskId);
      expect(view?.expectedVersion).toBeDefined();
      const admin = await createRootAdmin();
      const issued = await admin.handle({
        command: "manual_fulfillment.complete",
        actor: rootActor,
        targetId: fulfilled.taskId,
        expectedVersion: view!.expectedVersion,
        reason: "Confirm wallet-paid task",
        correlationId: "manual-wallet-evidence-issue",
      });
      expect(issued).toMatchObject({ ok: true, needsConfirmation: true });
      if (!issued.ok || !issued.needsConfirmation) return;

      if (invalidEvidence === "second-purchase") {
        const secondPurchase = await wallet.debit({
          customerId: f.customerId,
          amountVnd: 100_000n,
          idempotencyKey: `purchase:${f.orderId}:second-confirmed-purchase`,
          correlationId: "manual-wallet-second-purchase",
          reason: "additional canonical purchase evidence",
        });
        expect(secondPurchase).toMatchObject({ ok: true, inserted: true });
      } else if (invalidEvidence === "wallet-owner") {
        const otherCustomerId = newId();
        await sql`insert into customer (id, status, locale)
          values (${otherCustomerId}, 'ACTIVE', 'vi')`.execute(ctx.db);
        const changedOwner = await sql<{ customerId: string }>`
          update wallet_account set customer_id = ${otherCustomerId}
          where customer_id = ${f.customerId}
          returning customer_id as "customerId"
        `.execute(ctx.db);
        expect(changedOwner.rows).toEqual([{ customerId: otherCustomerId }]);
      } else {
        const changedAccount = await sql<{ code: string }>`
          update ledger_account set code = 'SHOP:REVENUE_INVALIDATED'
          where code = 'SHOP:REVENUE'
          returning code
        `.execute(ctx.db);
        expect(changedAccount.rows).toEqual([{ code: "SHOP:REVENUE_INVALIDATED" }]);
      }
      expect(await expectedTaskVersion(fulfilled.taskId)).toBe(view!.expectedVersion);

      const before = await sql<{
        taskStatus: string;
        taskVersion: number;
        orderStatus: string;
        orderVersion: number;
        audits: number;
        outboxEvents: number;
        completionEvents: number;
        completionTransitions: number;
      }>`
        select m.status as "taskStatus", m.version as "taskVersion",
          o.status as "orderStatus", o.version as "orderVersion",
          (select count(*)::int from audit_event
            where target_type = 'ManualFulfillmentTask' and target_id = m.id
              and action = 'manual_fulfillment.complete') as audits,
          (select count(*)::int from outbox_event
            where (aggregate_type = 'ManualFulfillmentTask' and aggregate_id = m.id)
              or (aggregate_type = 'Order' and aggregate_id = o.id)) as "outboxEvents",
        (select count(*)::int from outbox_event
          where aggregate_type = 'ManualFulfillmentTask' and aggregate_id = m.id
            and event_type = 'ManualFulfillmentTaskCompleted') as "completionEvents",
        (select count(*)::int from order_transition
          where order_id = o.id and to_status = 'COMPLETED') as "completionTransitions"
        from manual_fulfillment_task m join "order" o on o.id = m.order_id
        where m.id = ${fulfilled.taskId}
      `.execute(ctx.db);
      expect(before.rows[0]).toMatchObject({
        taskStatus: "OPEN",
        taskVersion: view!.taskVersion,
        orderStatus: "PROCESSING",
        orderVersion: view!.orderVersion,
        audits: 0,
        completionEvents: 0,
        completionTransitions: 0,
      });

      const refused = await admin.confirm({
        confirmationId: issued.confirmationId,
        challenge: issued.challenge,
        actor: rootActor,
        correlationId: "manual-wallet-evidence-confirm",
      });
      expect(refused).toMatchObject({ ok: false, code: "ACTION_REFUSED" });
      const after = await sql<{
        taskStatus: string;
        taskVersion: number;
        orderStatus: string;
        orderVersion: number;
        audits: number;
        outboxEvents: number;
        completionEvents: number;
        completionTransitions: number;
      }>`
        select m.status as "taskStatus", m.version as "taskVersion",
          o.status as "orderStatus", o.version as "orderVersion",
          (select count(*)::int from audit_event
            where target_type = 'ManualFulfillmentTask' and target_id = m.id
              and action = 'manual_fulfillment.complete') as audits,
          (select count(*)::int from outbox_event
            where (aggregate_type = 'ManualFulfillmentTask' and aggregate_id = m.id)
              or (aggregate_type = 'Order' and aggregate_id = o.id)) as "outboxEvents",
        (select count(*)::int from outbox_event
          where aggregate_type = 'ManualFulfillmentTask' and aggregate_id = m.id
            and event_type = 'ManualFulfillmentTaskCompleted') as "completionEvents",
        (select count(*)::int from order_transition
          where order_id = o.id and to_status = 'COMPLETED') as "completionTransitions"
        from manual_fulfillment_task m join "order" o on o.id = m.order_id
        where m.id = ${fulfilled.taskId}
      `.execute(ctx.db);
      expect(after.rows[0]).toEqual(before.rows[0]);
    },
  );

  it.each([
    ["wrong customer", "wrong-customer"],
    ["wrong amount", "wrong-amount"],
  ] as const)(
    "hides and refuses direct completion for %s wallet PURCHASE evidence",
    async (_label, invalidEvidence) => {
      const f = await seedServiceOrder({
        fulfillmentType: "MANUAL_FULFILLMENT",
        orderStatus: "PAID",
      });
      const evidenceCustomerId = invalidEvidence === "wrong-customer" ? newId() : f.customerId;
      if (evidenceCustomerId !== f.customerId) {
        await sql`insert into customer (id, status, locale)
          values (${evidenceCustomerId}, 'ACTIVE', 'vi')`.execute(ctx.db);
      }
      const wallet = createWalletLedgerService(ctx.db);
      const funding = await wallet.credit({
        customerId: evidenceCustomerId,
        amountVnd: 250_000n,
        idempotencyKey: `topup:manual-invalid:${f.orderId}:${invalidEvidence}`,
        correlationId: `manual-invalid-fund-${invalidEvidence}`,
        reason: "manual invalid evidence test funding",
      });
      expect(funding.ok).toBe(true);
      const evidence = await wallet.debit({
        customerId: evidenceCustomerId,
        amountVnd: invalidEvidence === "wrong-amount" ? 90_000n : 100_000n,
        idempotencyKey: `purchase:${f.orderId}:${invalidEvidence}`,
        correlationId: `manual-invalid-purchase-${invalidEvidence}`,
        reason: "manual invalid purchase evidence",
      });
      expect(evidence).toMatchObject({ ok: true, inserted: true });

      const fulfilled = await fulfillPaidOrder(ctx.db, {
        orderId: f.orderId,
        correlationId: `manual-invalid-fulfillment-${invalidEvidence}`,
        deps: fulfillmentDeps(),
      });
      expect(fulfilled).toMatchObject({ ok: true, kind: "WAITING_MANUAL" });
      if (!fulfilled.ok || fulfilled.kind !== "WAITING_MANUAL") return;
      expect(await listManualFulfillmentTasks(ctx.db, { status: "OPEN" })).toEqual([]);
      expect(await listAdminManualFulfillmentTasks(ctx.db)).toMatchObject({
        tasks: [],
        hasMore: false,
      });
      expect(await getAdminManualFulfillmentTask(ctx.db, fulfilled.taskId)).toBeNull();

      const expectedVersion = await expectedTaskVersion(fulfilled.taskId);
      const before = await sql<{
        taskStatus: string;
        taskVersion: number;
        orderStatus: string;
        orderVersion: number;
        audits: number;
        outboxEvents: number;
        transitions: number;
      }>`
        select m.status as "taskStatus", m.version as "taskVersion",
          o.status as "orderStatus", o.version as "orderVersion",
          (select count(*)::int from audit_event
            where target_type = 'ManualFulfillmentTask' and target_id = m.id) as audits,
          (select count(*)::int from outbox_event
            where (aggregate_type = 'ManualFulfillmentTask' and aggregate_id = m.id)
              or (aggregate_type = 'Order' and aggregate_id = o.id)) as "outboxEvents",
          (select count(*)::int from order_transition where order_id = o.id) as transitions
        from manual_fulfillment_task m join "order" o on o.id = m.order_id
        where m.id = ${fulfilled.taskId}
      `.execute(ctx.db);
      const direct = await withTransaction(ctx.db, (trx) =>
        completeManualFulfillmentTaskInTransaction(trx, {
          taskId: fulfilled.taskId,
          actorId: "42",
          correlationId: `manual-invalid-complete-${invalidEvidence}`,
          expectedVersion,
        }),
      );
      expect(direct).toMatchObject({ ok: false, code: "PAYMENT_NOT_SETTLED" });
      const after = await sql<{
        taskStatus: string;
        taskVersion: number;
        orderStatus: string;
        orderVersion: number;
        audits: number;
        outboxEvents: number;
        transitions: number;
      }>`
        select m.status as "taskStatus", m.version as "taskVersion",
          o.status as "orderStatus", o.version as "orderVersion",
          (select count(*)::int from audit_event
            where target_type = 'ManualFulfillmentTask' and target_id = m.id) as audits,
          (select count(*)::int from outbox_event
            where (aggregate_type = 'ManualFulfillmentTask' and aggregate_id = m.id)
              or (aggregate_type = 'Order' and aggregate_id = o.id)) as "outboxEvents",
          (select count(*)::int from order_transition where order_id = o.id) as transitions
        from manual_fulfillment_task m join "order" o on o.id = m.order_id
        where m.id = ${fulfilled.taskId}
      `.execute(ctx.db);
      expect(after.rows[0]).toEqual(before.rows[0]);
    },
  );

  it("refuses unauthenticated or non-private manual completion commands", async () => {
    const f = await seedServiceOrder({ fulfillmentType: "MANUAL_FULFILLMENT" });
    await settleManualTestOrder(f.orderId);
    await fulfillPaidOrder(ctx.db, {
      orderId: f.orderId,
      correlationId: "manual-3",
      deps: fulfillmentDeps(),
    });
    const [task] = await listManualFulfillmentTasks(ctx.db, { status: "OPEN" });
    const admin = await createRootAdmin();
    const common = {
      command: "manual_fulfillment.complete" as const,
      targetId: task!.id,
      expectedVersion: await expectedTaskVersion(task!.id),
      reason: "Owner manual delivery",
      correlationId: "denied-1",
    };

    await expect(
      admin.handle({
        ...common,
        actor: { numericUserId: 7, chatType: "private" },
      }),
    ).resolves.toMatchObject({ ok: false, code: "NOT_ROOT_ADMIN" });
    await expect(
      admin.handle({
        ...common,
        actor: { ...rootActor, chatType: "group" },
      }),
    ).resolves.toMatchObject({ ok: false, code: "WRONG_CONTEXT" });

    const state = await sql<{ status: string; order_status: string }>`
      select m.status, o.status as order_status
      from manual_fulfillment_task m join "order" o on o.id = m.order_id
      where m.id = ${task!.id}
    `.execute(ctx.db);
    expect(state.rows[0]).toEqual({ status: "OPEN", order_status: "PROCESSING" });
  });

  it("rejects stale order or task versions without completing either record", async () => {
    const f = await seedServiceOrder({ fulfillmentType: "MANUAL_FULFILLMENT" });
    await settleManualTestOrder(f.orderId);
    await fulfillPaidOrder(ctx.db, {
      orderId: f.orderId,
      correlationId: "manual-stale-version",
      deps: fulfillmentDeps(),
    });
    const [task] = await listManualFulfillmentTasks(ctx.db, { status: "OPEN" });
    const originalVersion = await expectedTaskVersion(task!.id);
    await sql`update manual_fulfillment_task set version = version + 1 where id = ${task!.id}`.execute(
      ctx.db,
    );
    const staleTask = await withTransaction(ctx.db, (trx) =>
      completeManualFulfillmentTaskInTransaction(trx, {
        taskId: task!.id,
        actorId: "42",
        correlationId: "manual-stale-task",
        expectedVersion: originalVersion,
      }),
    );
    expect(staleTask).toMatchObject({ ok: false, code: "STALE" });

    const currentVersion = await expectedTaskVersion(task!.id);
    await sql`update "order" set version = version + 1 where id = ${f.orderId}`.execute(ctx.db);
    const staleOrder = await withTransaction(ctx.db, (trx) =>
      completeManualFulfillmentTaskInTransaction(trx, {
        taskId: task!.id,
        actorId: "42",
        correlationId: "manual-stale-order",
        expectedVersion: currentVersion,
      }),
    );
    expect(staleOrder).toMatchObject({ ok: false, code: "STALE" });
    const state = await sql<{ task_status: string; order_status: string; audits: number }>`
      select m.status as task_status, o.status as order_status,
        (select count(*)::int from audit_event
          where target_type = 'ManualFulfillmentTask' and target_id = m.id
            and action = 'manual_fulfillment.complete') as audits
      from manual_fulfillment_task m join "order" o on o.id = m.order_id
      where m.id = ${task!.id}
    `.execute(ctx.db);
    expect(state.rows[0]).toEqual({
      task_status: "OPEN",
      order_status: "PROCESSING",
      audits: 0,
    });
  });

  it("refuses a durable completion challenge after task and order versions change", async () => {
    const f = await seedServiceOrder({ fulfillmentType: "MANUAL_FULFILLMENT" });
    await settleManualTestOrder(f.orderId);
    await fulfillPaidOrder(ctx.db, {
      orderId: f.orderId,
      correlationId: "manual-stale-challenge",
      deps: fulfillmentDeps(),
    });
    const [task] = await listManualFulfillmentTasks(ctx.db, { status: "OPEN" });
    const view = await getAdminManualFulfillmentTask(ctx.db, task!.id);
    const admin = await createRootAdmin();
    const issued = await admin.handle({
      command: "manual_fulfillment.complete",
      actor: rootActor,
      targetId: task!.id,
      expectedVersion: view!.expectedVersion,
      reason: "Confirm task version",
      correlationId: "manual-stale-challenge-issue",
    });
    expect(issued).toMatchObject({ ok: true, needsConfirmation: true });
    if (!issued.ok || !issued.needsConfirmation) return;

    await sql`update manual_fulfillment_task set version = version + 1 where id = ${task!.id}`.execute(
      ctx.db,
    );
    await sql`update "order" set version = version + 1 where id = ${f.orderId}`.execute(ctx.db);

    const refused = await admin.confirm({
      confirmationId: issued.confirmationId,
      challenge: issued.challenge,
      actor: rootActor,
      correlationId: "manual-stale-challenge-confirm",
    });
    expect(refused).toMatchObject({ ok: false, code: "ACTION_REFUSED" });
    const after = await sql<{
      taskStatus: string;
      taskVersion: number;
      orderStatus: string;
      orderVersion: number;
      audits: number;
      completionEvents: number;
      completionTransitions: number;
    }>`
      select m.status as "taskStatus", m.version as "taskVersion",
        o.status as "orderStatus", o.version as "orderVersion",
        (select count(*)::int from audit_event
          where target_type = 'ManualFulfillmentTask' and target_id = m.id
            and action = 'manual_fulfillment.complete') as audits,
        (select count(*)::int from outbox_event
          where aggregate_type = 'ManualFulfillmentTask' and aggregate_id = m.id
            and event_type = 'ManualFulfillmentTaskCompleted') as "completionEvents",
        (select count(*)::int from order_transition
          where order_id = o.id and to_status = 'COMPLETED') as "completionTransitions"
      from manual_fulfillment_task m join "order" o on o.id = m.order_id
      where m.id = ${task!.id}
    `.execute(ctx.db);
    expect(after.rows[0]).toEqual({
      taskStatus: "OPEN",
      taskVersion: view!.taskVersion + 1,
      orderStatus: "PROCESSING",
      orderVersion: view!.orderVersion + 1,
      audits: 0,
      completionEvents: 0,
      completionTransitions: 0,
    });
  });

  it.each(["MANUAL_FULFILLMENT", "UNLIMITED_SERVICE"] as const)(
    "hides and refuses completion of unpaid %s tasks",
    async (fulfillmentType) => {
      const f = await seedServiceOrder({ fulfillmentType });
      const fulfilled = await fulfillPaidOrder(ctx.db, {
        orderId: f.orderId,
        correlationId: "manual-unpaid",
        deps: fulfillmentDeps(),
      });
      expect(fulfilled).toMatchObject({ ok: true, kind: "WAITING_MANUAL", orderId: f.orderId });
      if (!fulfilled.ok || fulfilled.kind !== "WAITING_MANUAL") return;

      expect(await listManualFulfillmentTasks(ctx.db, { status: "OPEN" })).toEqual([]);
      expect(await listAdminManualFulfillmentTasks(ctx.db)).toMatchObject({
        tasks: [],
        hasMore: false,
      });
      expect(await getAdminManualFulfillmentTask(ctx.db, fulfilled.taskId)).toBeNull();

      const expectedVersion = await expectedTaskVersion(fulfilled.taskId);
      const direct = await withTransaction(ctx.db, (trx) =>
        completeManualFulfillmentTaskInTransaction(trx, {
          taskId: fulfilled.taskId,
          actorId: "42",
          correlationId: "manual-unpaid-complete",
          expectedVersion,
        }),
      );
      expect(direct).toMatchObject({ ok: false, code: "PAYMENT_NOT_SETTLED" });

      const admin = await createRootAdmin();
      const issued = await admin.handle({
        command: "manual_fulfillment.complete",
        actor: rootActor,
        targetId: fulfilled.taskId,
        expectedVersion,
        reason: "Owner verifies payment state",
        correlationId: "manual-unpaid-issue",
      });
      expect(issued).toMatchObject({ ok: true, needsConfirmation: true });
      if (!issued.ok || !issued.needsConfirmation) return;
      const refused = await admin.confirm({
        confirmationId: issued.confirmationId,
        challenge: issued.challenge,
        actor: rootActor,
        correlationId: "manual-unpaid-confirm",
      });
      expect(refused).toMatchObject({
        ok: false,
        code: "ACTION_REFUSED",
        message: "Đơn chưa xác nhận thanh toán.",
      });

      const unchanged = await sql<{
        task_status: string;
        order_status: string;
        audits: number;
        completion_events: number;
      }>`
        select m.status as task_status, o.status as order_status,
          (select count(*)::int from audit_event
            where target_type = 'ManualFulfillmentTask' and target_id = m.id
              and action = 'manual_fulfillment.complete') as audits,
          (select count(*)::int from outbox_event
            where aggregate_type = 'ManualFulfillmentTask' and aggregate_id = m.id
              and event_type = 'ManualFulfillmentTaskCompleted') as completion_events
        from manual_fulfillment_task m join "order" o on o.id = m.order_id
        where m.id = ${fulfilled.taskId}
      `.execute(ctx.db);
      expect(unchanged.rows[0]).toEqual({
        task_status: "OPEN",
        order_status: "PROCESSING",
        audits: 0,
        completion_events: 0,
      });
    },
  );

  it.each([
    "unverified signature",
    "mismatched merchant account",
    "payment-intent amount",
    "inbound transaction amount",
    "settled allocation amount",
  ] as const)("refuses durable completion for %s settlement evidence", async (invalidEvidence) => {
    const f = await seedServiceOrder({ fulfillmentType: "MANUAL_FULFILLMENT" });
    const settlement = await settleManualTestOrder(f.orderId);
    await fulfillPaidOrder(ctx.db, {
      orderId: f.orderId,
      correlationId: `manual-invalid-${invalidEvidence}`,
      deps: fulfillmentDeps(),
    });
    const [task] = await listManualFulfillmentTasks(ctx.db, { status: "OPEN" });
    const expectedVersion = await expectedTaskVersion(task!.id);
    const bindingInput = {
      actionKey: "manual_fulfillment.complete",
      resourceType: "ManualFulfillmentTask",
      resourceId: task!.id,
      requestedData: { targetId: task!.id, expectedVersion },
    } as const;
    const validBinding = await loadSensitiveAuthorizationBinding(ctx.db, bindingInput);

    switch (invalidEvidence) {
      case "unverified signature":
        await sql`update bank_transaction set signature_status = 'UNVERIFIED'
          where id = ${settlement.transactionId}`.execute(ctx.db);
        break;
      case "mismatched merchant account":
        await sql`update bank_transaction set merchant_account_id = 'OTHER-TEST'
          where id = ${settlement.transactionId}`.execute(ctx.db);
        break;
      case "payment-intent amount":
        await sql`update payment_intent set amount_vnd = 90000
          where id = ${settlement.intentId}`.execute(ctx.db);
        break;
      case "inbound transaction amount":
        await sql`update bank_transaction set amount_vnd = 90000
          where id = ${settlement.transactionId}`.execute(ctx.db);
        break;
      case "settled allocation amount":
        await sql`update payment_allocation set allocated_amount_vnd = 90000
          where payment_intent_id = ${settlement.intentId}`.execute(ctx.db);
        break;
    }

    const invalidBinding = await loadSensitiveAuthorizationBinding(ctx.db, bindingInput);
    expect(invalidBinding.payloadHash).not.toBe(validBinding.payloadHash);
    expect(await listAdminManualFulfillmentTasks(ctx.db)).toMatchObject({
      tasks: [],
      hasMore: false,
    });

    const admin = await createRootAdmin();
    const issued = await admin.handle({
      command: "manual_fulfillment.complete",
      actor: rootActor,
      targetId: task!.id,
      expectedVersion,
      reason: "Verify exact settlement",
      correlationId: `manual-invalid-issue-${invalidEvidence}`,
    });
    expect(issued).toMatchObject({ ok: true, needsConfirmation: true });
    if (!issued.ok || !issued.needsConfirmation) return;
    const refused = await admin.confirm({
      confirmationId: issued.confirmationId,
      challenge: issued.challenge,
      actor: rootActor,
      correlationId: `manual-invalid-confirm-${invalidEvidence}`,
    });
    expect(refused).toMatchObject({
      ok: false,
      code: "ACTION_REFUSED",
      message: "Đơn chưa xác nhận thanh toán.",
    });

    const state = await sql<{
      taskStatus: string;
      orderStatus: string;
      audits: number;
      completionEvents: number;
    }>`
      select m.status as "taskStatus", o.status as "orderStatus",
        (select count(*)::int from audit_event
          where target_type = 'ManualFulfillmentTask' and target_id = m.id
            and action = 'manual_fulfillment.complete') as audits,
        (select count(*)::int from outbox_event
          where aggregate_type = 'ManualFulfillmentTask' and aggregate_id = m.id
            and event_type = 'ManualFulfillmentTaskCompleted') as "completionEvents"
      from manual_fulfillment_task m join "order" o on o.id = m.order_id
      where m.id = ${task!.id}
    `.execute(ctx.db);
    expect(state.rows[0]).toEqual({
      taskStatus: "OPEN",
      orderStatus: "PROCESSING",
      audits: 0,
      completionEvents: 0,
    });
  });

  it.each([
    ["the bank transaction provider changes away from SePay", "provider"],
    ["the bank transaction direction changes to OUT", "direction"],
    ["the payment intent status changes to FAILED", "intent-status"],
    ["the payment allocation status changes to REJECTED", "allocation-status"],
    ["the intent is re-associated with another valid order", "intent-order"],
    ["the signature status becomes UNVERIFIED", "signature-status"],
  ] as const)(
    "refuses a durable completion challenge when %s without version changes",
    async (_description, invalidEvidence) => {
      const f = await seedServiceOrder({ fulfillmentType: "MANUAL_FULFILLMENT" });
      const settlement = await settleManualTestOrder(f.orderId);
      await fulfillPaidOrder(ctx.db, {
        orderId: f.orderId,
        correlationId: "manual-settlement-challenge",
        deps: fulfillmentDeps(),
      });
      const [task] = await listManualFulfillmentTasks(ctx.db, { status: "OPEN" });
      const view = await getAdminManualFulfillmentTask(ctx.db, task!.id);
      expect(view?.expectedVersion).toBeDefined();
      const admin = await createRootAdmin();
      const issued = await admin.handle({
        command: "manual_fulfillment.complete",
        actor: rootActor,
        targetId: task!.id,
        expectedVersion: view!.expectedVersion,
        reason: "Confirm exact settlement",
        correlationId: "manual-settlement-challenge-issue",
      });
      expect(issued).toMatchObject({ ok: true, needsConfirmation: true });
      if (!issued.ok || !issued.needsConfirmation) return;

      if (invalidEvidence === "provider") {
        const changed = await sql<{ provider: string }>`
          update bank_transaction set provider = 'not-sepay'
          where id = ${settlement.transactionId}
          returning provider
        `.execute(ctx.db);
        expect(changed.rows).toEqual([{ provider: "not-sepay" }]);
      } else if (invalidEvidence === "direction") {
        const changed = await sql<{ direction: string }>`
          update bank_transaction set direction = 'OUT'
          where id = ${settlement.transactionId}
          returning direction
        `.execute(ctx.db);
        expect(changed.rows).toEqual([{ direction: "OUT" }]);
      } else if (invalidEvidence === "intent-status") {
        const changed = await sql<{ status: string }>`
          update payment_intent set status = 'FAILED'
          where id = ${settlement.intentId}
          returning status
        `.execute(ctx.db);
        expect(changed.rows).toEqual([{ status: "FAILED" }]);
      } else if (invalidEvidence === "allocation-status") {
        const changed = await sql<{ status: string }>`
          update payment_allocation set status = 'REJECTED'
          where payment_intent_id = ${settlement.intentId}
          returning status
        `.execute(ctx.db);
        expect(changed.rows).toEqual([{ status: "REJECTED" }]);
      } else if (invalidEvidence === "intent-order") {
        const otherOrder = await seedServiceOrder({ fulfillmentType: "MANUAL_FULFILLMENT" });
        const changed = await sql<{ orderId: string }>`
          update payment_intent set order_id = ${otherOrder.orderId}
          where id = ${settlement.intentId}
          returning order_id as "orderId"
        `.execute(ctx.db);
        expect(changed.rows).toEqual([{ orderId: otherOrder.orderId }]);
      } else {
        const changed = await sql<{ signatureStatus: string }>`
          update bank_transaction set signature_status = 'UNVERIFIED'
          where id = ${settlement.transactionId}
          returning signature_status as "signatureStatus"
        `.execute(ctx.db);
        expect(changed.rows).toEqual([{ signatureStatus: "UNVERIFIED" }]);
      }
      expect(await expectedTaskVersion(task!.id)).toBe(view!.expectedVersion);

      const refused = await admin.confirm({
        confirmationId: issued.confirmationId,
        challenge: issued.challenge,
        actor: rootActor,
        correlationId: "manual-settlement-challenge-confirm",
      });
      expect(refused).toMatchObject({
        ok: false,
        code: "ACTION_REFUSED",
      });
      expect(await listAdminManualFulfillmentTasks(ctx.db)).toMatchObject({
        tasks: [],
        hasMore: false,
      });
      const after = await sql<{
        taskStatus: string;
        taskVersion: number;
        orderStatus: string;
        orderVersion: number;
        audits: number;
        completionEvents: number;
        completionTransitions: number;
      }>`
        select m.status as "taskStatus", m.version as "taskVersion",
          o.status as "orderStatus", o.version as "orderVersion",
          (select count(*)::int from audit_event
            where target_type = 'ManualFulfillmentTask' and target_id = m.id
              and action = 'manual_fulfillment.complete') as audits,
          (select count(*)::int from outbox_event
            where aggregate_type = 'ManualFulfillmentTask' and aggregate_id = m.id
              and event_type = 'ManualFulfillmentTaskCompleted') as "completionEvents",
          (select count(*)::int from order_transition
            where order_id = o.id and to_status = 'COMPLETED') as "completionTransitions"
        from manual_fulfillment_task m join "order" o on o.id = m.order_id
        where m.id = ${task!.id}
      `.execute(ctx.db);
      expect(after.rows[0]).toEqual({
        taskStatus: "OPEN",
        taskVersion: view!.taskVersion,
        orderStatus: "PROCESSING",
        orderVersion: view!.orderVersion,
        audits: 0,
        completionEvents: 0,
        completionTransitions: 0,
      });
    },
  );

  it("I. repeated authorized owner completion mutates completion and delivery once", async () => {
    const f = await seedServiceOrder({ fulfillmentType: "MANUAL_FULFILLMENT" });
    await settleManualTestOrder(f.orderId);
    await fulfillPaidOrder(ctx.db, {
      orderId: f.orderId,
      correlationId: "manual-paid",
      deps: fulfillmentDeps(),
    });
    const [task] = await listManualFulfillmentTasks(ctx.db, { status: "OPEN" });
    const page = await listAdminManualFulfillmentTasks(ctx.db);
    expect(page.tasks).toHaveLength(1);
    expect(page.tasks[0]).toMatchObject({ orderId: f.orderId, orderNumber: `ORD-${f.orderId}` });
    const view = await getAdminManualFulfillmentTask(ctx.db, task!.id);
    const admin = await createRootAdmin();
    const issued = await admin.handle({
      command: "manual_fulfillment.complete",
      actor: rootActor,
      targetId: task!.id,
      expectedVersion: view!.expectedVersion,
      reason: "Verified customer delivery",
      correlationId: "manual-paid-complete",
    });
    expect(issued).toMatchObject({ ok: true, needsConfirmation: true });
    if (!issued.ok || !issued.needsConfirmation) return;

    const action = {
      confirmationId: issued.confirmationId,
      challenge: issued.challenge,
      actor: rootActor,
      correlationId: "manual-paid-confirm",
    };
    await expect(admin.confirm(action)).resolves.toEqual({ ok: true });
    await expect(
      admin.confirm({ ...action, correlationId: "manual-paid-replay" }),
    ).resolves.toEqual({
      ok: true,
    });
    const state = await sql<{
      task_status: string;
      completed_by: string | null;
      completed_at: Date | null;
      completion_correlation_id: string | null;
      task_version: number;
      order_status: string;
      order_version: number;
      audits: number;
      audit_actor_type: string | null;
      audit_actor_id: string | null;
      audit_time: Date | null;
      audit_order_version: string | null;
      audit_task_version: string | null;
      audit_metadata: string | null;
      completion_events: number;
      completion_payload: string | null;
    }>`
      select m.status as task_status, m.completed_by, m.completed_at,
        m.completion_correlation_id, m.version as task_version,
        o.status as order_status, o.version as order_version,
        (select count(*)::int from audit_event where target_type = 'ManualFulfillmentTask'
          and target_id = m.id and action = 'manual_fulfillment.complete') as audits,
        (select actor_type from audit_event where target_type = 'ManualFulfillmentTask'
          and target_id = m.id and action = 'manual_fulfillment.complete' limit 1) as audit_actor_type,
        (select actor_id from audit_event where target_type = 'ManualFulfillmentTask'
          and target_id = m.id and action = 'manual_fulfillment.complete' limit 1) as audit_actor_id,
        (select occurred_at from audit_event where target_type = 'ManualFulfillmentTask'
          and target_id = m.id and action = 'manual_fulfillment.complete' limit 1) as audit_time,
        (select metadata_redacted->>'orderVersion' from audit_event
          where target_type = 'ManualFulfillmentTask' and target_id = m.id
            and action = 'manual_fulfillment.complete' limit 1) as audit_order_version,
        (select metadata_redacted->>'taskVersion' from audit_event
          where target_type = 'ManualFulfillmentTask' and target_id = m.id
            and action = 'manual_fulfillment.complete' limit 1) as audit_task_version,
        (select metadata_redacted::text from audit_event where target_type = 'ManualFulfillmentTask'
          and target_id = m.id and action = 'manual_fulfillment.complete' limit 1) as audit_metadata,
        (select count(*)::int from outbox_event
          where aggregate_type = 'ManualFulfillmentTask' and aggregate_id = m.id
            and event_type = 'ManualFulfillmentTaskCompleted') as completion_events,
        (select payload_redacted::text from outbox_event
          where aggregate_type = 'ManualFulfillmentTask' and aggregate_id = m.id
            and event_type = 'ManualFulfillmentTaskCompleted' limit 1) as completion_payload
      from manual_fulfillment_task m join "order" o on o.id = m.order_id
      where m.id = ${task!.id}
    `.execute(ctx.db);
    const completed = state.rows[0]!;
    expect(completed).toMatchObject({
      task_status: "COMPLETED",
      completed_by: "42",
      completion_correlation_id: "manual-paid-complete",
      order_status: "COMPLETED",
      audits: 1,
      audit_actor_type: "ROOT_ADMIN",
      audit_actor_id: "42",
      audit_order_version: String(completed.order_version),
      audit_task_version: String(completed.task_version),
      completion_events: 1,
    });
    expect(completed.completed_at).toBeInstanceOf(Date);
    expect(completed.audit_time).toBeInstanceOf(Date);
    expect(JSON.parse(completed.audit_metadata!)).toEqual({
      orderId: f.orderId,
      orderVersion: completed.order_version,
      taskVersion: completed.task_version,
      fulfillmentType: "MANUAL_FULFILLMENT",
    });
    expect(Object.keys(JSON.parse(completed.completion_payload!)).sort()).toEqual([
      "completedBy",
      "correlationId",
      "customerId",
      "orderId",
      "taskId",
    ]);
  });

  it("completes through durable owner confirmation without requiring TOTP", async () => {
    const f = await seedServiceOrder({ fulfillmentType: "MANUAL_FULFILLMENT" });
    await settleManualTestOrder(f.orderId);
    await fulfillPaidOrder(ctx.db, {
      orderId: f.orderId,
      correlationId: "manual-no-totp",
      deps: fulfillmentDeps(),
    });
    const [task] = await listManualFulfillmentTasks(ctx.db, { status: "OPEN" });
    const view = await getAdminManualFulfillmentTask(ctx.db, task!.id);
    const admin = await createRootAdmin(true);
    const issued = await admin.handle({
      command: "manual_fulfillment.complete",
      actor: rootActor,
      targetId: task!.id,
      expectedVersion: view!.expectedVersion,
      reason: "Manual service handed off",
      correlationId: "manual-no-totp-confirm",
    });
    expect(issued).toMatchObject({ ok: true, needsConfirmation: true });
    if (!issued.ok || !issued.needsConfirmation) return;

    await expect(
      admin.confirm({
        confirmationId: issued.confirmationId,
        challenge: issued.challenge,
        actor: rootActor,
        correlationId: "manual-no-totp-confirmed",
      }),
    ).resolves.toEqual({ ok: true });
  });

  it("pages verified manual orders oldest-first and excludes unpaid orders", async () => {
    const first = await seedServiceOrder({ fulfillmentType: "MANUAL_FULFILLMENT" });
    const second = await seedServiceOrder({ fulfillmentType: "MANUAL_FULFILLMENT" });
    await Promise.all([first, second].map((f) => settleManualTestOrder(f.orderId)));
    await Promise.all(
      [first, second].map((f) =>
        fulfillPaidOrder(ctx.db, {
          orderId: f.orderId,
          correlationId: `queue-${f.orderId}`,
          deps: fulfillmentDeps(),
        }),
      ),
    );
    const tasks = await listManualFulfillmentTasks(ctx.db, { status: "OPEN" });
    const firstTask = tasks.find((task) => task.orderId === first.orderId)!;
    const secondTask = tasks.find((task) => task.orderId === second.orderId)!;
    await sql`update manual_fulfillment_task set created_at = '2026-01-01T00:00:00Z'
      where id = ${firstTask.id}`.execute(ctx.db);
    await sql`update manual_fulfillment_task set created_at = '2026-01-02T00:00:00Z'
      where id = ${secondTask.id}`.execute(ctx.db);

    const oldest = await listAdminManualFulfillmentTasks(ctx.db, { offset: 0, limit: 1 });
    const next = await listAdminManualFulfillmentTasks(ctx.db, { offset: 1, limit: 1 });
    expect(oldest).toMatchObject({ offset: 0, hasMore: true });
    expect(oldest.tasks.map((row) => row.orderId)).toEqual([first.orderId]);
    expect(next).toMatchObject({ offset: 1, hasMore: false });
    expect(next.tasks.map((row) => row.orderId)).toEqual([second.orderId]);
  });
});
