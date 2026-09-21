import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { newId } from "../../src/shared/ids/index.js";
import { withTransaction } from "../../src/infrastructure/db/transaction.js";
import {
  keepPaidDeliveryUncertainInTransaction,
  reconcilePaidDeliveryDeliveredInTransaction,
  reconcilePaidDeliveryInTransaction,
} from "../../src/modules/digital-goods/recovery.js";
import { startPostgresContainer, type PgTestContext } from "../helpers/pg-container.js";

let ctx: PgTestContext;

interface Fixture {
  orderId: string;
  assetId: string;
  bundleId: string;
}

beforeAll(async () => {
  ctx = await startPostgresContainer();
}, 180_000);

afterAll(async () => {
  await ctx?.teardown();
});

beforeEach(async () => {
  await sql`
    truncate table
      delivery_notification_handoff,
      delivery_bundle,
      digital_asset,
      payment_allocation,
      payment_intent,
      bank_transaction,
      audit_event,
      order_transition,
      outbox_event,
      "order",
      product_variant,
      product,
      category,
      customer
    cascade
  `.execute(ctx.db);
});

async function seedAnomaly(): Promise<Fixture> {
  const categoryId = newId();
  const productId = newId();
  const variantId = newId();
  const customerId = newId();
  const orderId = newId();
  const assetId = newId();
  const bundleId = newId();
  const handoffId = newId();
  const intentId = newId();
  const bankTransactionId = newId();
  const allocationId = newId();
  const now = new Date();

  await sql`
    insert into category (id, name_vi, slug, is_active, sort_order)
    values (${categoryId}, 'C', ${categoryId.slice(-8)}, true, 1)
  `.execute(ctx.db);
  await sql`
    insert into product (id, category_id, name_vi, slug, is_active, sort_order)
    values (${productId}, ${categoryId}, 'P', ${productId.slice(-8)}, true, 1)
  `.execute(ctx.db);
  await sql`
    insert into product_variant
      (id, product_id, sku, name_vi, price_vnd, duration_code, delivery_type, stock_policy, resale_evidence_id)
    values
      (${variantId}, ${productId}, ${"SKU-" + variantId}, 'V', 100000, 'P1M', 'CREDENTIAL', 'LOCAL_ONLY', 'RES-1')
  `.execute(ctx.db);
  await sql`
    insert into customer (id, status, locale)
    values (${customerId}, 'ACTIVE', 'vi')
  `.execute(ctx.db);
  await sql`
    insert into channel_identity
      (id, customer_id, channel, channel_user_id)
    values (${newId()}, ${customerId}, 'TELEGRAM', '10001')
  `.execute(ctx.db);
  await sql`
    insert into "order"
      (id, order_number, customer_id, variant_id, product_name_vi, variant_name_vi,
       price_vnd, duration_code, delivery_type, status, paid_at)
    values
      (${orderId}, ${"ORD-" + orderId}, ${customerId}, ${variantId}, 'P', 'V',
       100000, 'P1M', 'CREDENTIAL', 'PROCESSING', ${now})
  `.execute(ctx.db);
  await sql`
    insert into order_transition
      (id, order_id, from_status, to_status, reason_code, actor_type, actor_id, correlation_id)
    values
      (${newId()}, ${orderId}, 'PAID', 'PROCESSING', 'FULFILLMENT_STARTED', 'SYSTEM', 'test', 'seed')
  `.execute(ctx.db);
  await sql`
    insert into bank_transaction
      (id, provider, provider_transaction_id, direction, merchant_account_id,
       amount_vnd, content, transacted_at, raw_hash, signature_status, schema_version)
    values
      (${bankTransactionId}, 'sepay', ${"txn-" + bankTransactionId}, 'IN', 'merchant-test',
       100000, 'ORD', ${now}, ${"hash-" + bankTransactionId}, 'VERIFIED', '1')
  `.execute(ctx.db);
  await sql`
    insert into payment_intent
      (id, order_id, status, amount_vnd, merchant_account_id, transfer_content,
       expires_at, presented_at, settled_at)
    values
      (${intentId}, ${orderId}, 'SUCCEEDED', 100000, 'merchant-test', ${"PAY-" + orderId},
       ${new Date(now.getTime() + 60_000)}, ${now}, ${now})
  `.execute(ctx.db);
  await sql`
    insert into payment_allocation
      (id, bank_transaction_id, payment_intent_id, allocated_amount_vnd,
       status, decision_code, correlation_id)
    values
      (${allocationId}, ${bankTransactionId}, ${intentId}, 100000,
       'SETTLED', 'EXACT_MATCH', 'seed')
  `.execute(ctx.db);
  await sql`
    insert into digital_asset
      (id, variant_id, source_type, vault_ref, fingerprint_hash, status,
       reserved_order_id, reserved_until)
    values
      (${assetId}, ${variantId}, 'LOCAL', ${"vault-ref-" + assetId}, ${"fp-" + assetId}, 'READY',
       ${orderId}, ${new Date(now.getTime() + 60_000)})
  `.execute(ctx.db);
  await sql`
    insert into delivery_bundle
      (id, order_id, customer_id, asset_id, token_hash, status, expires_at, version)
    values
      (${bundleId}, ${orderId}, ${customerId}, ${assetId}, ${"token-hash-" + bundleId}, 'EXPIRED',
       ${new Date(now.getTime() - 60_000)}, 2)
  `.execute(ctx.db);
  await sql`
    insert into delivery_notification_handoff
      (id, bundle_id, customer_id, telegram_chat_id, capability_key, payload_redacted,
       status, sent_at)
    values
      (${handoffId}, ${bundleId}, ${customerId}, '10001', ${"cap-" + handoffId},
       ${JSON.stringify({
         providerChatId: "10001",
         providerMessageId: "provider-message-fixture",
         providerSucceededAt: now.toISOString(),
       })}::jsonb,
       'SENT', ${now})
  `.execute(ctx.db);
  return { orderId, assetId, bundleId };
}

const inputFor = (fixture: Fixture, requestId = "request-1") => ({
  orderId: fixture.orderId,
  expectedOrderVersion: 1,
  actorId: "123456789",
  reason: "Đưa sai lệch giao hàng vào rà soát owner.",
  correlationId: "reconcile-test",
  requestId,
});

describe("paid delivery reconciliation", () => {
  it("parks the exact ambiguous handoff tuple and preserves delivery evidence", async () => {
    const fixture = await seedAnomaly();

    const result = await withTransaction(ctx.db, (trx) =>
      reconcilePaidDeliveryInTransaction(trx, inputFor(fixture)),
    );

    expect(result).toEqual({
      ok: true,
      orderId: fixture.orderId,
      status: "FULFILLMENT_NEEDS_REVIEW",
      previousStatus: "PROCESSING",
      alreadyApplied: false,
    });
    const rows = await sql<{
      order_status: string;
      order_version: number;
      asset_status: string;
      reserved_order_id: string | null;
      bundle_status: string;
      handoff_status: string;
    }>`
      select
        o.status as order_status,
        o.version as order_version,
        a.status as asset_status,
        a.reserved_order_id,
        b.status as bundle_status,
        h.status as handoff_status
      from "order" o
      join digital_asset a on a.id = ${fixture.assetId}
      join delivery_bundle b on b.id = ${fixture.bundleId}
      join delivery_notification_handoff h on h.bundle_id = b.id
      where o.id = ${fixture.orderId}
    `.execute(ctx.db);
    expect(rows.rows[0]).toMatchObject({
      order_status: "FULFILLMENT_NEEDS_REVIEW",
      order_version: 2,
      asset_status: "READY",
      reserved_order_id: fixture.orderId,
      bundle_status: "EXPIRED",
      handoff_status: "SENT",
    });
    const audit = await sql<{ action: string; request_id: string }>`
      select action, metadata_redacted->>'requestId' as request_id
      from audit_event
      where target_type = 'Order' and target_id = ${fixture.orderId}
        and action = 'fulfillment.reconcile'
    `.execute(ctx.db);
    expect(audit.rows).toEqual([{ action: "fulfillment.reconcile", request_id: "request-1" }]);
  });

  it("replays the same request without a second transition", async () => {
    const fixture = await seedAnomaly();
    const input = inputFor(fixture);

    await withTransaction(ctx.db, (trx) => reconcilePaidDeliveryInTransaction(trx, input));
    const replay = await withTransaction(ctx.db, (trx) =>
      reconcilePaidDeliveryInTransaction(trx, input),
    );

    expect(replay).toMatchObject({ ok: true, alreadyApplied: true });
    const transitions = await sql<{ count: number }>`
      select count(*)::int as count
      from order_transition
      where order_id = ${fixture.orderId}
        and reason_code = 'PAID_FULFILLMENT_RECONCILIATION_REVIEW'
    `.execute(ctx.db);
    expect(transitions.rows[0]?.count).toBe(1);
  });

  it("refuses a non-exact tuple without changing the order", async () => {
    const fixture = await seedAnomaly();
    await sql`update delivery_bundle set status = 'AVAILABLE' where id = ${fixture.bundleId}`.execute(
      ctx.db,
    );

    const result = await withTransaction(ctx.db, (trx) =>
      reconcilePaidDeliveryInTransaction(trx, inputFor(fixture)),
    );

    expect(result).toEqual({ ok: false, code: "RECONCILIATION_NOT_SAFE" });
    const order = await sql<{ status: string; version: number }>`
      select status, version from "order" where id = ${fixture.orderId}
    `.execute(ctx.db);
    expect(order.rows[0]).toEqual({ status: "PROCESSING", version: 1 });
  });

  it("refuses a stale order version before touching evidence", async () => {
    const fixture = await seedAnomaly();
    const result = await withTransaction(ctx.db, (trx) =>
      reconcilePaidDeliveryInTransaction(trx, { ...inputFor(fixture), expectedOrderVersion: 2 }),
    );

    expect(result).toEqual({ ok: false, code: "STALE", message: "Đơn hàng đã thay đổi." });
    const order = await sql<{ status: string; version: number }>`
      select status, version from "order" where id = ${fixture.orderId}
    `.execute(ctx.db);
    expect(order.rows[0]).toEqual({ status: "PROCESSING", version: 1 });
  });

  it("refuses system finalization without the active handoff lease fence", async () => {
    const fixture = await seedAnomaly();
    await sql`
      update delivery_notification_handoff
      set status = 'PROCESSING', sent_at = null, claimed_by = null,
        claim_expires_at = null
      where bundle_id = ${fixture.bundleId}
    `.execute(ctx.db);

    const result = await withTransaction(ctx.db, (trx) =>
      reconcilePaidDeliveryDeliveredInTransaction(trx, {
        ...inputFor(fixture, "request-system-without-lease"),
        actorId: "delivery-worker",
        actorType: "SYSTEM",
      }),
    );
    expect(result).toEqual({ ok: false, code: "RECONCILIATION_NOT_SAFE" });
    const state = await sql<{
      order_status: string;
      asset_status: string;
      bundle_status: string;
      handoff_status: string;
    }>`
      select o.status as order_status, a.status as asset_status,
        b.status as bundle_status, h.status as handoff_status
      from "order" o
      join digital_asset a on a.id = ${fixture.assetId}
      join delivery_bundle b on b.id = ${fixture.bundleId}
      join delivery_notification_handoff h on h.bundle_id = b.id
      where o.id = ${fixture.orderId}
    `.execute(ctx.db);
    expect(state.rows[0]).toEqual({
      order_status: "PROCESSING",
      asset_status: "READY",
      bundle_status: "EXPIRED",
      handoff_status: "PROCESSING",
    });
  });

  it("completes an exact paid delivery from the owner review state", async () => {
    const fixture = await seedAnomaly();
    const parked = await withTransaction(ctx.db, (trx) =>
      reconcilePaidDeliveryInTransaction(trx, inputFor(fixture)),
    );
    expect(parked.ok).toBe(true);

    const result = await withTransaction(ctx.db, (trx) =>
      reconcilePaidDeliveryDeliveredInTransaction(trx, {
        ...inputFor(fixture, "request-delivered"),
        expectedOrderVersion: 2,
        actorType: "ROOT_ADMIN",
      }),
    );
    expect(result).toMatchObject({
      ok: true,
      orderId: fixture.orderId,
      status: "COMPLETED",
      previousStatus: "FULFILLMENT_NEEDS_REVIEW",
      alreadyApplied: false,
    });
    const rows = await sql<{
      order_status: string;
      asset_status: string;
      bundle_status: string;
      bundle_version: number;
      handoff_status: string;
      delivered_events: number;
    }>`
      select o.status as order_status, a.status as asset_status,
        b.status as bundle_status, b.version as bundle_version, h.status as handoff_status,
        (select count(*)::int from outbox_event
         where event_type = 'DigitalAssetDelivered'
           and payload_redacted->>'orderId' = o.id) as delivered_events
      from "order" o
      join digital_asset a on a.id = ${fixture.assetId}
      join delivery_bundle b on b.id = ${fixture.bundleId}
      join delivery_notification_handoff h on h.bundle_id = b.id
      where o.id = ${fixture.orderId}
    `.execute(ctx.db);
    expect(rows.rows[0]).toEqual({
      order_status: "COMPLETED",
      asset_status: "DELIVERED",
      bundle_status: "CONSUMED",
      bundle_version: 3,
      handoff_status: "SENT",
      delivered_events: 1,
    });
  });

  it("keeps an uncertain paid delivery in owner review without fulfillment mutation", async () => {
    const fixture = await seedAnomaly();
    const parked = await withTransaction(ctx.db, (trx) =>
      reconcilePaidDeliveryInTransaction(trx, inputFor(fixture)),
    );
    expect(parked).toMatchObject({ ok: true, status: "FULFILLMENT_NEEDS_REVIEW" });

    const result = await withTransaction(ctx.db, (trx) =>
      keepPaidDeliveryUncertainInTransaction(trx, {
        ...inputFor(fixture, "request-keep"),
        expectedOrderVersion: 2,
      }),
    );
    expect(result).toMatchObject({
      ok: true,
      orderId: fixture.orderId,
      status: "FULFILLMENT_NEEDS_REVIEW",
      alreadyApplied: false,
    });
    const order = await sql<{ status: string; version: number }>`
      select status, version from "order" where id = ${fixture.orderId}
    `.execute(ctx.db);
    expect(order.rows[0]).toEqual({
      status: "FULFILLMENT_NEEDS_REVIEW",
      version: 2,
    });
  });
});
