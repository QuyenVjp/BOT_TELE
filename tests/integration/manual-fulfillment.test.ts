import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { createInMemoryVault } from "../../src/infrastructure/vault/testing-adapter.js";
import { fulfillPaidOrder } from "../../src/modules/digital-goods/fulfillment.js";
import {
  completeManualFulfillmentTask,
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
    truncate table delivery_bundle, digital_asset, order_transition, outbox_event, "order",
      variant_service_fulfillment, product_variant, product, category, customer, audit_event cascade
  `.execute(ctx.db);
});

async function seedServiceOrder(input: {
  fulfillmentType: "MANUAL_FULFILLMENT" | "UNLIMITED_SERVICE";
  orderStatus?: "PAID" | "PROCESSING" | "COMPLETED";
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
      price_vnd, duration_code, delivery_type, status, paid_at)
    values (${orderId}, ${`ORD-${orderId}`}, ${customerId}, ${variantId}, 'P', 'V',
      100000, 'P1M', 'MANUAL_REVIEW', ${input.orderStatus ?? "PAID"}, now())
  `.execute(ctx.db);

  return { orderId, variantId, customerId };
}

describe("manual fulfillment tasks", () => {
  it.each(["MANUAL_FULFILLMENT", "UNLIMITED_SERVICE"] as const)(
    "fulfillPaidOrder creates one %s task without a delivery bundle",
    async (fulfillmentType) => {
      const f = await seedServiceOrder({ fulfillmentType });
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

  it("keeps the paid order on the original service task snapshot after variant config changes", async () => {
    const f = await seedServiceOrder({ fulfillmentType: "UNLIMITED_SERVICE" });
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

  it("lists open tasks and completes exactly once with root private audit", async () => {
    const f = await seedServiceOrder({ fulfillmentType: "UNLIMITED_SERVICE" });
    const deps = {
      vault: createInMemoryVault(),
      supplier: null,
      deliveryBaseUrl: "https://shop.example/d",
      bundleTtlSeconds: 900,
    };
    const created = await fulfillPaidOrder(ctx.db, {
      orderId: f.orderId,
      correlationId: "manual-2",
      deps,
    });
    expect(created.ok && created.kind).toBe("WAITING_MANUAL");

    const tasks = await listManualFulfillmentTasks(ctx.db, { status: "OPEN" });
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      orderId: f.orderId,
      status: "OPEN",
      fulfillmentType: "UNLIMITED_SERVICE",
    });

    const actor = { numericUserId: 42, chatType: "private" as const, observedUsername: "owner" };
    const config = { adminTelegramUserId: 42, expectedUsername: "owner" };
    const complete = await completeManualFulfillmentTask(ctx.db, {
      taskId: tasks[0]!.id,
      actor,
      config,
      correlationId: "complete-1",
    });
    const replay = await completeManualFulfillmentTask(ctx.db, {
      taskId: tasks[0]!.id,
      actor,
      config,
      correlationId: "complete-1",
    });

    expect(complete).toMatchObject({ ok: true, alreadyCompleted: false, orderId: f.orderId });
    expect(replay).toMatchObject({ ok: true, alreadyCompleted: true, orderId: f.orderId });

    const state = await sql<{
      task_status: string;
      completed_by: string | null;
      order_status: string;
      transitions: number;
      audits: number;
    }>`
      select m.status as task_status, m.completed_by,
        o.status as order_status,
        (select count(*)::int from order_transition where order_id = o.id and to_status = 'COMPLETED') as transitions,
        (select count(*)::int from audit_event where target_type = 'ManualFulfillmentTask' and target_id = m.id and action = 'manual_fulfillment.complete') as audits
      from manual_fulfillment_task m join "order" o on o.id = m.order_id where m.id = ${tasks[0]!.id}
    `.execute(ctx.db);
    expect(state.rows[0]).toEqual({
      task_status: "COMPLETED",
      completed_by: "42",
      order_status: "COMPLETED",
      transitions: 1,
      audits: 1,
    });
  });

  it("denies non-root or non-private completion without completing the task", async () => {
    const f = await seedServiceOrder({ fulfillmentType: "MANUAL_FULFILLMENT" });
    const deps = {
      vault: createInMemoryVault(),
      supplier: null,
      deliveryBaseUrl: "https://shop.example/d",
      bundleTtlSeconds: 900,
    };
    await fulfillPaidOrder(ctx.db, { orderId: f.orderId, correlationId: "manual-3", deps });
    const [task] = await listManualFulfillmentTasks(ctx.db, { status: "OPEN" });

    const denied = await completeManualFulfillmentTask(ctx.db, {
      taskId: task!.id,
      actor: { numericUserId: 7, chatType: "private" },
      config: { adminTelegramUserId: 42, expectedUsername: "owner" },
      correlationId: "denied-1",
    });

    expect(denied).toEqual({ ok: false, code: "NOT_ROOT_ADMIN" });
    const state = await sql<{ status: string; order_status: string }>`
      select m.status, o.status as order_status from manual_fulfillment_task m join "order" o on o.id = m.order_id where m.id = ${task!.id}
    `.execute(ctx.db);
    expect(state.rows[0]).toEqual({ status: "OPEN", order_status: "PROCESSING" });
  });
});
