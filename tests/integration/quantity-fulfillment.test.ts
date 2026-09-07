import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "kysely";
import {
  adjustQuantityStock,
  listVariantInventoryHistory,
} from "../../src/modules/catalog/quantity-stock.js";
import { createInMemoryVault } from "../../src/infrastructure/vault/testing-adapter.js";
import { fulfillPaidOrder } from "../../src/modules/digital-goods/fulfillment.js";
import {
  completeManualFulfillmentTask,
  listManualFulfillmentTasks,
} from "../../src/modules/digital-goods/manual-fulfillment.js";
import {
  releaseTypedStockForOrder,
  reserveTypedStockForOrder,
} from "../../src/modules/digital-goods/repository.js";
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
    truncate table manual_fulfillment_task, quantity_stock_ledger, variant_quantity_stock,
      delivery_bundle, digital_asset, order_transition, outbox_event, "order",
      variant_service_fulfillment, product_variant, product, category, customer, audit_event cascade
  `.execute(ctx.db);
});

async function seedQuantityOrder(input: { quantity?: number; threshold?: number } = {}) {
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
       stock_policy, resale_evidence_id, fulfillment_type, low_stock_threshold)
    values (${variantId}, ${productId}, ${`SKU-${variantId}`}, 'V', 100000, 'P1M',
      'CREDENTIAL', 'LOCAL_ONLY', 'RES-1', 'QUANTITY_STOCK', ${input.threshold ?? null})
  `.execute(ctx.db);
  await sql`
    insert into variant_service_fulfillment (variant_id, fulfillment_type, instructions, is_active)
    values (${variantId}, 'QUANTITY_STOCK', 'Ship one physical voucher.', true)
  `.execute(ctx.db);
  await sql`insert into variant_quantity_stock (variant_id, available_quantity) values (${variantId}, ${input.quantity ?? 1})`.execute(
    ctx.db,
  );
  await sql`insert into customer (id, status, locale) values (${customerId}, 'ACTIVE', 'vi')`.execute(
    ctx.db,
  );
  await sql`
    insert into "order" (id, order_number, customer_id, variant_id, product_name_vi, variant_name_vi,
      price_vnd, duration_code, delivery_type, fulfillment_type, status, paid_at)
    values (${orderId}, ${`ORD-${orderId}`}, ${customerId}, ${variantId}, 'P', 'V',
      100000, 'P1M', 'CREDENTIAL', 'QUANTITY_STOCK', 'PAID', now())
  `.execute(ctx.db);
  return { orderId, variantId, customerId };
}

describe("quantity-stock fulfillment", () => {
  it("exposes only selected variant history to private root", async () => {
    const f = await seedQuantityOrder();
    const input = {
      db: ctx.db,
      actor: { numericUserId: 42, chatType: "private" as const },
      config: { adminTelegramUserId: 42, expectedUsername: "owner" },
      variantId: f.variantId,
      correlationId: "history",
    };
    const empty = await listVariantInventoryHistory(input);
    expect(empty.ok && empty.rows).toEqual([]);
    await sql`insert into quantity_stock_ledger(id, variant_id, entry_type, quantity_delta, quantity_after) values (${newId()}, ${f.variantId}, 'ADJUST', 2, 3)`.execute(
      ctx.db,
    );
    const history = await listVariantInventoryHistory(input);
    expect(history.ok && history.rows.map((x) => x.detail)).toEqual(["đổi 2, còn 3"]);
    expect(
      await listVariantInventoryHistory({
        ...input,
        actor: { numericUserId: 7, chatType: "private" },
      }),
    ).toMatchObject({ ok: false, code: "NOT_ROOT_ADMIN" });
    expect(
      await listVariantInventoryHistory({
        ...input,
        actor: { numericUserId: 42, chatType: "group" },
      }),
    ).toMatchObject({ ok: false, code: "WRONG_CONTEXT" });
    expect(await listVariantInventoryHistory({ ...input, variantId: newId() })).toMatchObject({
      ok: false,
      code: "NOT_FOUND",
    });
  });
  it("requires a live reserve before creating the manual task", async () => {
    const f = await seedQuantityOrder();
    const deps = {
      vault: createInMemoryVault(),
      supplier: null,
      deliveryBaseUrl: "https://shop.example/d",
      bundleTtlSeconds: 900,
    };

    const missingReserve = await fulfillPaidOrder(ctx.db, {
      orderId: f.orderId,
      correlationId: "qty-missing",
      deps,
    });
    expect(missingReserve.ok).toBe(false);
    if (!missingReserve.ok) expect(missingReserve.code).toBe("OUT_OF_STOCK");

    const reserve = await reserveTypedStockForOrder(ctx.db, {
      variantId: f.variantId,
      orderId: f.orderId,
      fulfillmentType: "QUANTITY_STOCK",
      reserveUntil: new Date(Date.now() + 15 * 60 * 1000),
      quantity: 1,
    });
    expect(reserve.ok).toBe(true);

    const created = await fulfillPaidOrder(ctx.db, {
      orderId: f.orderId,
      correlationId: "qty-created",
      deps,
    });
    expect(created).toMatchObject({
      ok: true,
      kind: "WAITING_MANUAL",
      fulfillmentType: "QUANTITY_STOCK",
    });

    const [task] = await listManualFulfillmentTasks(ctx.db, { status: "OPEN" });
    const complete = await completeManualFulfillmentTask(ctx.db, {
      taskId: task!.id,
      actor: { numericUserId: 42, chatType: "private", observedUsername: "owner" },
      config: { adminTelegramUserId: 42, expectedUsername: "owner" },
      correlationId: "qty-complete",
    });
    const replay = await completeManualFulfillmentTask(ctx.db, {
      taskId: task!.id,
      actor: { numericUserId: 42, chatType: "private", observedUsername: "owner" },
      config: { adminTelegramUserId: 42, expectedUsername: "owner" },
      correlationId: "qty-complete",
    });

    expect(complete).toMatchObject({ ok: true, alreadyCompleted: false });
    expect(replay).toMatchObject({ ok: true, alreadyCompleted: true });
    const rows = await sql<{
      entry_type: string;
      quantity_delta: number;
      quantity_after: number;
      released_at: Date | null;
    }>`
      select entry_type, quantity_delta::int, quantity_after::int, released_at
      from quantity_stock_ledger
      where order_id = ${f.orderId}
      order by created_at asc, id asc
    `.execute(ctx.db);
    expect(
      rows.rows.map((row) => ({
        entry_type: row.entry_type,
        quantity_delta: row.quantity_delta,
        quantity_after: row.quantity_after,
        released: row.released_at !== null,
      })),
    ).toEqual([
      { entry_type: "RESERVE", quantity_delta: -1, quantity_after: 0, released: false },
      { entry_type: "DELIVER", quantity_delta: 0, quantity_after: 0, released: false },
    ]);
    expect(await releaseTypedStockForOrder(ctx.db, f.orderId)).toBe(false);
    const stock = await sql<{
      available_quantity: number;
    }>`select available_quantity::int from variant_quantity_stock where variant_id = ${f.variantId}`.execute(
      ctx.db,
    );
    expect(stock.rows[0]?.available_quantity).toBe(0);
  });

  it("keeps paid delayed outbox reservations deliverable after reserve ttl", async () => {
    const f = await seedQuantityOrder();
    const reserve = await reserveTypedStockForOrder(ctx.db, {
      variantId: f.variantId,
      orderId: f.orderId,
      fulfillmentType: "QUANTITY_STOCK",
      reserveUntil: new Date(Date.now() - 1_000),
      quantity: 1,
    });
    expect(reserve.ok).toBe(true);

    const created = await fulfillPaidOrder(ctx.db, {
      orderId: f.orderId,
      correlationId: "qty-delayed-paid",
      deps: {
        vault: createInMemoryVault(),
        supplier: null,
        deliveryBaseUrl: "https://shop.example/d",
        bundleTtlSeconds: 900,
      },
    });

    expect(created).toMatchObject({
      ok: true,
      kind: "WAITING_MANUAL",
      fulfillmentType: "QUANTITY_STOCK",
    });
  });

  it("does not complete a quantity task after its reserve was released", async () => {
    const f = await seedQuantityOrder();
    await reserveTypedStockForOrder(ctx.db, {
      variantId: f.variantId,
      orderId: f.orderId,
      fulfillmentType: "QUANTITY_STOCK",
      reserveUntil: new Date(Date.now() + 15 * 60 * 1000),
      quantity: 1,
    });
    const created = await fulfillPaidOrder(ctx.db, {
      orderId: f.orderId,
      correlationId: "qty-release-before-complete",
      deps: {
        vault: createInMemoryVault(),
        supplier: null,
        deliveryBaseUrl: "https://shop.example/d",
        bundleTtlSeconds: 900,
      },
    });
    expect(created.ok).toBe(true);
    await releaseTypedStockForOrder(ctx.db, f.orderId);
    const [task] = await listManualFulfillmentTasks(ctx.db, { status: "OPEN" });

    const complete = await completeManualFulfillmentTask(ctx.db, {
      taskId: task!.id,
      actor: { numericUserId: 42, chatType: "private", observedUsername: "owner" },
      config: { adminTelegramUserId: 42, expectedUsername: "owner" },
      correlationId: "qty-complete-released",
    });

    expect(complete).toEqual({ ok: false, code: "ORDER_NOT_PROCESSING" });
    const state = await sql<{ task_status: string; order_status: string; delivered: number }>`
      select m.status as task_status, o.status as order_status,
        (select count(*)::int from quantity_stock_ledger where order_id = ${f.orderId} and entry_type = 'DELIVER') as delivered
      from manual_fulfillment_task m join "order" o on o.id = m.order_id where m.id = ${task!.id}
    `.execute(ctx.db);
    expect(state.rows[0]).toEqual({
      task_status: "OPEN",
      order_status: "PROCESSING",
      delivered: 0,
    });
  });
});

describe("quantity-stock low-stock alerts", () => {
  it("emits a quantity StockDelta when reservation crosses the variant threshold", async () => {
    const f = await seedQuantityOrder({ quantity: 2, threshold: 1 });

    await expect(
      reserveTypedStockForOrder(ctx.db, {
        variantId: f.variantId,
        orderId: f.orderId,
        fulfillmentType: "QUANTITY_STOCK",
        reserveUntil: new Date(Date.now() + 60_000),
      }),
    ).resolves.toMatchObject({ ok: true, kind: "QUANTITY", remainingQuantity: 1 });

    const events = await sql<{
      aggregate_type: string;
      aggregate_id: string;
      aggregate_version: number;
      payload_redacted: Record<string, unknown>;
    }>`
      select aggregate_type, aggregate_id, aggregate_version, payload_redacted
      from outbox_event
      where event_type = 'StockDelta'
    `.execute(ctx.db);

    expect(events.rows).toHaveLength(1);
    expect(events.rows[0]).toMatchObject({
      aggregate_type: "QuantityStock",
      aggregate_id: f.variantId,
      aggregate_version: 2,
    });
    expect(events.rows[0]?.payload_redacted).toMatchObject({
      variantId: f.variantId,
      source: "QUANTITY",
      delta: -1,
      stockAfter: 1,
      lowStockAlert: true,
      threshold: 1,
    });
  });

  it("re-arms after stock rises above threshold and alerts on the second crossing", async () => {
    const f = await seedQuantityOrder({ quantity: 2, threshold: 1 });
    const firstReserve = await reserveTypedStockForOrder(ctx.db, {
      variantId: f.variantId,
      orderId: f.orderId,
      fulfillmentType: "QUANTITY_STOCK",
      reserveUntil: new Date(Date.now() + 60_000),
    });
    expect(firstReserve).toMatchObject({ ok: true, kind: "QUANTITY", remainingQuantity: 1 });

    await expect(
      sql<{ available_quantity: number; version: number }>`
        select available_quantity::int, version from variant_quantity_stock where variant_id = ${f.variantId}
      `.execute(ctx.db),
    ).resolves.toMatchObject({ rows: [{ available_quantity: 1, version: 2 }] });

    const restock = await adjustQuantityStock({
      db: ctx.db,
      actor: { numericUserId: 42, chatType: "private", observedUsername: "owner" },
      config: { adminTelegramUserId: 42, expectedUsername: "owner" },
      variantId: f.variantId,
      delta: 1,
      expectedStockVersion: 2,
      idempotencyKey: "qty-rearm-restock",
      reason: "restock above threshold",
      correlationId: "qty-rearm-restock-corr",
    });
    expect(restock).toMatchObject({
      ok: true,
      availableQuantity: 2,
      version: 3,
      idempotent: false,
    });

    await expect(
      sql<{ available_quantity: number; version: number }>`
        select available_quantity::int, version from variant_quantity_stock where variant_id = ${f.variantId}
      `.execute(ctx.db),
    ).resolves.toMatchObject({ rows: [{ available_quantity: 2, version: 3 }] });

    const secondOrderId = newId();
    await sql`
      insert into "order" (id, order_number, customer_id, variant_id, product_name_vi, variant_name_vi,
        price_vnd, duration_code, delivery_type, fulfillment_type, status, paid_at)
      values (${secondOrderId}, ${`ORD-${secondOrderId}`}, ${f.customerId}, ${f.variantId}, 'P', 'V',
        100000, 'P1M', 'CREDENTIAL', 'QUANTITY_STOCK', 'PAID', now())
    `.execute(ctx.db);
    const secondReserve = await reserveTypedStockForOrder(ctx.db, {
      variantId: f.variantId,
      orderId: secondOrderId,
      fulfillmentType: "QUANTITY_STOCK",
      reserveUntil: new Date(Date.now() + 60_000),
    });
    expect(secondReserve).toMatchObject({ ok: true, kind: "QUANTITY", remainingQuantity: 1 });

    await expect(
      sql<{ available_quantity: number; version: number }>`
        select available_quantity::int, version from variant_quantity_stock where variant_id = ${f.variantId}
      `.execute(ctx.db),
    ).resolves.toMatchObject({ rows: [{ available_quantity: 1, version: 4 }] });

    const alerts = await sql<{ count: string }>`
      select count(*)::text as count
      from outbox_event
      where event_type = 'StockDelta'
        and payload_redacted->>'source' = 'QUANTITY'
        and payload_redacted->>'lowStockAlert' = 'true'
    `.execute(ctx.db);

    expect(alerts.rows[0]?.count).toBe("2");
  });

  it("does not emit low-stock alerts when the threshold is disabled", async () => {
    const f = await seedQuantityOrder({ quantity: 1, threshold: 0 });

    await reserveTypedStockForOrder(ctx.db, {
      variantId: f.variantId,
      orderId: f.orderId,
      fulfillmentType: "QUANTITY_STOCK",
      reserveUntil: new Date(Date.now() + 60_000),
    });

    const alerts = await sql<{ count: string }>`
      select count(*)::text as count
      from outbox_event
      where event_type = 'StockDelta'
        and payload_redacted->>'lowStockAlert' = 'true'
    `.execute(ctx.db);

    expect(alerts.rows[0]?.count).toBe("0");
  });
});

describe("quantity-stock adjustments", () => {
  const adminConfig = { adminTelegramUserId: 42, expectedUsername: "owner" };
  const adminActor = { numericUserId: 42, chatType: "private" as const, observedUsername: "owner" };

  it("rejects negative adjustments, keeps stock unchanged, and writes no audit row", async () => {
    const f = await seedQuantityOrder();
    const result = await adjustQuantityStock({
      db: ctx.db,
      actor: adminActor,
      config: adminConfig,
      variantId: f.variantId,
      delta: -2,
      expectedStockVersion: 1,
      idempotencyKey: "qty-neg-1",
      reason: "too far",
      correlationId: "qty-neg-corr",
    });

    expect(result).toEqual({ ok: false, code: "NEGATIVE_STOCK" });
    await expect(
      sql<{
        available_quantity: number;
        version: number;
      }>`select available_quantity::int, version::int from variant_quantity_stock where variant_id = ${f.variantId}`.execute(
        ctx.db,
      ),
    ).resolves.toMatchObject({ rows: [{ available_quantity: 1, version: 1 }] });
    await expect(
      sql<{
        count: string;
      }>`select count(*)::text as count from quantity_stock_ledger where variant_id = ${f.variantId} and entry_type = 'ADJUST'`.execute(
        ctx.db,
      ),
    ).resolves.toMatchObject({ rows: [{ count: "0" }] });
    await expect(
      sql<{
        count: string;
      }>`select count(*)::text as count from audit_event where target_id = ${f.variantId} and action = 'quantity_stock.adjusted'`.execute(
        ctx.db,
      ),
    ).resolves.toMatchObject({ rows: [{ count: "0" }] });
  });

  it("replays the same idempotency key without creating duplicate stock or audit rows", async () => {
    const f = await seedQuantityOrder();
    const first = await adjustQuantityStock({
      db: ctx.db,
      actor: adminActor,
      config: adminConfig,
      variantId: f.variantId,
      delta: 1,
      expectedStockVersion: 1,
      idempotencyKey: "qty-replay-1",
      reason: "add one",
      correlationId: "qty-replay-corr",
    });
    const second = await adjustQuantityStock({
      db: ctx.db,
      actor: adminActor,
      config: adminConfig,
      variantId: f.variantId,
      delta: 1,
      expectedStockVersion: 1,
      idempotencyKey: "qty-replay-1",
      reason: "add one",
      correlationId: "qty-replay-corr",
    });

    expect(first).toEqual({
      ok: true,
      variantId: f.variantId,
      previousQuantity: 1,
      availableQuantity: 2,
      version: 2,
      idempotent: false,
    });
    expect(second).toEqual({
      ok: true,
      variantId: f.variantId,
      previousQuantity: 1,
      availableQuantity: 2,
      version: 2,
      idempotent: true,
    });
    await expect(
      sql<{
        count: string;
      }>`select count(*)::text as count from quantity_stock_ledger where variant_id = ${f.variantId} and entry_type = 'ADJUST'`.execute(
        ctx.db,
      ),
    ).resolves.toMatchObject({ rows: [{ count: "1" }] });
    await expect(
      sql<{
        count: string;
      }>`select count(*)::text as count from audit_event where target_id = ${f.variantId} and action = 'quantity_stock.adjusted'`.execute(
        ctx.db,
      ),
    ).resolves.toMatchObject({ rows: [{ count: "1" }] });
  });

  it("serializes concurrent adjustments against the same stock version", async () => {
    const f = await seedQuantityOrder();
    const [first, second] = await Promise.all([
      adjustQuantityStock({
        db: ctx.db,
        actor: adminActor,
        config: adminConfig,
        variantId: f.variantId,
        delta: 1,
        expectedStockVersion: 1,
        idempotencyKey: "qty-concurrent-a",
        reason: "add one",
        correlationId: "qty-concurrent-a",
      }),
      adjustQuantityStock({
        db: ctx.db,
        actor: adminActor,
        config: adminConfig,
        variantId: f.variantId,
        delta: 1,
        expectedStockVersion: 1,
        idempotencyKey: "qty-concurrent-b",
        reason: "add one",
        correlationId: "qty-concurrent-b",
      }),
    ]);

    const outcomes = [first, second].sort((a, b) => (a.ok === b.ok ? 0 : a.ok ? -1 : 1));
    expect(outcomes[0]).toMatchObject({ ok: true, availableQuantity: 2, version: 2 });
    expect(outcomes[1]).toEqual({ ok: false, code: "WRONG_VERSION" });
    await expect(
      sql<{
        available_quantity: number;
        version: number;
      }>`select available_quantity::int, version::int from variant_quantity_stock where variant_id = ${f.variantId}`.execute(
        ctx.db,
      ),
    ).resolves.toMatchObject({ rows: [{ available_quantity: 2, version: 2 }] });
  });

  it("does not touch live reserves when adjusting quantity stock", async () => {
    const f = await seedQuantityOrder();
    const reserve = await reserveTypedStockForOrder(ctx.db, {
      variantId: f.variantId,
      orderId: f.orderId,
      fulfillmentType: "QUANTITY_STOCK",
      reserveUntil: new Date(Date.now() + 15 * 60 * 1000),
      quantity: 1,
    });
    expect(reserve.ok).toBe(true);

    const adjusted = await adjustQuantityStock({
      db: ctx.db,
      actor: adminActor,
      config: adminConfig,
      variantId: f.variantId,
      delta: 2,
      expectedStockVersion: 2,
      idempotencyKey: "qty-reserved-1",
      reason: "top up",
      correlationId: "qty-reserved-corr",
    });

    expect(adjusted).toEqual({
      ok: true,
      variantId: f.variantId,
      previousQuantity: 0,
      availableQuantity: 2,
      version: 3,
      idempotent: false,
    });
    await expect(
      sql<{
        entry_type: string;
        released_at: Date | null;
        quantity_delta: number;
      }>`select entry_type, released_at, quantity_delta::int from quantity_stock_ledger where order_id = ${f.orderId} order by created_at asc, id asc`.execute(
        ctx.db,
      ),
    ).resolves.toMatchObject({
      rows: [{ entry_type: "RESERVE", quantity_delta: -1, released_at: null }],
    });
  });

  it("rejects non-root and group-context callers", async () => {
    const f = await seedQuantityOrder();
    await expect(
      adjustQuantityStock({
        db: ctx.db,
        actor: { numericUserId: 7, chatType: "private" },
        config: adminConfig,
        variantId: f.variantId,
        delta: 1,
        expectedStockVersion: 1,
        idempotencyKey: "qty-denied-1",
        reason: "nope",
        correlationId: "qty-denied-corr",
      }),
    ).resolves.toEqual({ ok: false, code: "NOT_ROOT_ADMIN" });
    await expect(
      adjustQuantityStock({
        db: ctx.db,
        actor: { numericUserId: 42, chatType: "group" },
        config: adminConfig,
        variantId: f.variantId,
        delta: 1,
        expectedStockVersion: 1,
        idempotencyKey: "qty-denied-2",
        reason: "nope",
        correlationId: "qty-denied-corr-2",
      }),
    ).resolves.toEqual({ ok: false, code: "WRONG_CONTEXT" });
    await expect(
      sql<{
        count: string;
      }>`select count(*)::text as count from audit_event where target_id = ${f.variantId} and action = 'quantity_stock.adjusted'`.execute(
        ctx.db,
      ),
    ).resolves.toMatchObject({ rows: [{ count: "0" }] });
  });
});
