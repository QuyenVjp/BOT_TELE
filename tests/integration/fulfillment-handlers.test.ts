import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { newId } from "../../src/shared/ids/index.js";
import { createInMemoryVault } from "../../src/infrastructure/vault/testing-adapter.js";
import { enqueueOutboxEvent } from "../../src/infrastructure/outbox/repository.js";
import { drainOutboxOnce } from "../../src/infrastructure/outbox/worker.js";
import { createFulfillmentOutboxHandler } from "../../src/modules/digital-goods/handlers.js";
import { createFulfillmentTelemetry } from "../../src/modules/digital-goods/telemetry.js";
import type { TelegramDocumentSender } from "../../src/modules/digital-goods/file-delivery.js";
import { startPostgresContainer, type PgTestContext } from "../helpers/pg-container.js";

/**
 * T076 — Payment outbox → fulfillment worker (FR-013, SR-006).
 *
 * Draining an OrderPaid outbox event claims the local asset, issues a Delivery
 * Bundle, and notifies the customer. Replaying the same event is a no-op on
 * domain effects (one asset, one bundle).
 */

let ctx: PgTestContext;
let storageRoot: string;
const DELIVERY_SESSION_CONFIG = {
  key: "test-only-handler-delivery-session-key-material-123456",
  keyVersion: 1,
  audience: "delivery-reveal",
};

beforeAll(async () => {
  ctx = await startPostgresContainer();
  storageRoot = await mkdtemp(join(tmpdir(), "bot-tele-handler-file-"));
}, 180_000);

afterAll(async () => {
  await ctx?.teardown();
  if (storageRoot) await rm(storageRoot, { recursive: true, force: true });
});

interface Fixture {
  orderId: string;
  customerId: string;
  assetId: string;
  vault: ReturnType<typeof createInMemoryVault>;
}

async function seedPaidWithAsset(): Promise<Fixture> {
  const categoryId = newId();
  const productId = newId();
  const variantId = newId();
  const customerId = newId();
  const orderId = newId();
  const assetId = newId();
  const vault = createInMemoryVault();
  const vaultRef = await vault.write("HANDLER-SECRET");
  const slug = categoryId.slice(-8);

  await sql`insert into category (id, name_vi, slug, is_active, sort_order) values (${categoryId}, 'C', ${slug}, true, 1)`.execute(
    ctx.db,
  );
  await sql`insert into product (id, category_id, name_vi, slug, is_active, sort_order) values (${productId}, ${categoryId}, 'P', ${slug}, true, 1)`.execute(
    ctx.db,
  );
  await sql`
    insert into product_variant (id, product_id, sku, name_vi, price_vnd, duration_code, delivery_type, stock_policy, resale_evidence_id)
    values (${variantId}, ${productId}, ${"SKU-" + variantId}, 'V', 100000, 'P1M', 'CREDENTIAL', 'LOCAL_ONLY', 'RES-1')
  `.execute(ctx.db);
  await sql`insert into customer (id, status, locale) values (${customerId}, 'ACTIVE', 'vi')`.execute(
    ctx.db,
  );
  await sql`
    insert into channel_identity (id, customer_id, channel, channel_user_id)
    values (${newId()}, ${customerId}, 'TELEGRAM', '123456789')
  `.execute(ctx.db);
  await sql`
    insert into "order" (id, order_number, customer_id, variant_id, product_name_vi, variant_name_vi,
      price_vnd, duration_code, delivery_type, status, paid_at)
    values (${orderId}, ${"ORD-" + orderId}, ${customerId}, ${variantId}, 'P', 'V',
      100000, 'P1M', 'CREDENTIAL', 'PAID', now())
  `.execute(ctx.db);
  await sql`
    insert into digital_asset
      (id, variant_id, source_type, vault_ref, fingerprint_hash, status)
    values
      (${assetId}, ${variantId}, 'LOCAL', ${vaultRef}, ${"fp-" + newId()}, 'AVAILABLE')
  `.execute(ctx.db);

  return { orderId, customerId, assetId, vault };
}

beforeEach(async () => {
  await sql`
    truncate table file_delivery_job, variant_file_artifact,
      delivery_capability_compensation, delivery_notification_handoff,
      delivery_session, delivery_bundle,
      customer_profile_snapshot, channel_identity, digital_asset, order_transition, outbox_event, "order",
      product_variant, product, category, customer cascade
  `.execute(ctx.db);
});

describe("fulfillment outbox handlers (T076)", () => {
  it("OrderPaid drains into a claimed asset + Delivery Bundle + notification", async () => {
    const f = await seedPaidWithAsset();

    const orderPaidEventId = newId();
    await enqueueOutboxEvent(ctx.db, {
      id: orderPaidEventId,
      aggregateType: "Order",
      aggregateId: f.orderId,
      aggregateVersion: 2,
      eventType: "OrderPaid",
      payloadRedacted: {
        orderId: f.orderId,
        correlationId: "h1",
      },
    });

    const telemetry = createFulfillmentTelemetry();
    const handler = createFulfillmentOutboxHandler({
      db: ctx.db,
      vault: f.vault,
      supplier: null,
      deliveryBaseUrl: "https://shop.example/d",
      bundleTtlSeconds: 900,
      telemetry,
      deliverySession: {
        config: DELIVERY_SESSION_CONFIG,
        ttlSeconds: 300,
      },
    });

    let orderPaidPublished = false;
    let totalPublished = 0;
    for (let i = 0; i < 10 && !orderPaidPublished; i += 1) {
      const drain = await drainOutboxOnce(ctx.db, {
        batchSize: 10,
        maxAttempts: 5,
        handler,
      });
      totalPublished += drain.published;
      const orderPaidEvent = await sql<{ published: boolean }>`
        select (published_at is not null) as published from outbox_event where id = ${orderPaidEventId}
      `.execute(ctx.db);
      orderPaidPublished = orderPaidEvent.rows[0]?.published === true;
    }
    expect(totalPublished).toBeGreaterThanOrEqual(1);
    expect(orderPaidPublished).toBe(true);
    const asset = await sql<{ status: string; reserved_order_id: string | null }>`
      select status, reserved_order_id from digital_asset where id = ${f.assetId}
    `.execute(ctx.db);
    expect(["RESERVED", "READY", "DELIVERED"]).toContain(asset.rows[0]?.status);
    expect(asset.rows[0]?.reserved_order_id).toBe(f.orderId);

    const bundles = await sql<{ count: string }>`
      select count(*)::text as count from delivery_bundle where order_id = ${f.orderId}
    `.execute(ctx.db);
    expect(Number(bundles.rows[0]?.count)).toBe(1);
    const handoffs = await sql<{ customer_id: string; telegram_chat_id: string }>`
      select customer_id, telegram_chat_id from delivery_notification_handoff
    `.execute(ctx.db);
    expect(handoffs.rows).toEqual([{ customer_id: f.customerId, telegram_chat_id: "123456789" }]);
  });

  it("replaying OrderPaid is idempotent (one asset, one bundle)", async () => {
    const f = await seedPaidWithAsset();
    const eventId = newId();
    // First publish.
    await enqueueOutboxEvent(ctx.db, {
      id: eventId,
      aggregateType: "Order",
      aggregateId: f.orderId,
      aggregateVersion: 2,
      eventType: "OrderPaid",
      payloadRedacted: { orderId: f.orderId, correlationId: "h1" },
    });

    const handler = createFulfillmentOutboxHandler({
      db: ctx.db,
      vault: f.vault,
      supplier: null,
      deliveryBaseUrl: "https://shop.example/d",
      bundleTtlSeconds: 900,
    });

    let orderPaidPublished = false;
    for (let i = 0; i < 10; i += 1) {
      const drain = await drainOutboxOnce(ctx.db, { batchSize: 10, maxAttempts: 5, handler });
      const orderPaid = await sql<{ published: boolean }>`
        select (published_at is not null) as published from outbox_event where id = ${eventId}
      `.execute(ctx.db);
      orderPaidPublished = orderPaid.rows[0]?.published === true;
      if (orderPaidPublished) break;
      expect(drain.claimed).toBeGreaterThan(0);
    }
    expect(orderPaidPublished).toBe(true);

    // Manually re-invoke the handler (simulates at-least-once redelivery after
    // a crash between effect and ack).
    await handler({
      id: eventId,
      aggregateType: "Order",
      aggregateId: f.orderId,
      aggregateVersion: 2,
      eventType: "OrderPaid",
      payloadRedacted: { orderId: f.orderId, correlationId: "h1" },
      attemptCount: 1,
      claimedBy: "replay-fixture",
      generation: 1,
    });

    const assets = await sql<{ count: string }>`
      select count(*)::text as count from digital_asset where reserved_order_id = ${f.orderId}
    `.execute(ctx.db);
    expect(Number(assets.rows[0]?.count)).toBe(1);
    const bundles = await sql<{ count: string }>`
      select count(*)::text as count from delivery_bundle where order_id = ${f.orderId}
    `.execute(ctx.db);
    expect(Number(bundles.rows[0]?.count)).toBe(1);
  });
});

function hash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function seedPaidFileOrder(input: { cached?: boolean } = {}) {
  const bytes = new TextEncoder().encode("handler digital file");
  const categoryId = newId();
  const productId = newId();
  const variantId = newId();
  const customerId = newId();
  const orderId = newId();
  const artifactId = newId();
  const filePath = join(storageRoot, `${artifactId}.bin`);
  await writeFile(filePath, bytes);
  await sql`insert into category (id, name_vi, slug, is_active, sort_order) values (${categoryId}, 'Files', ${categoryId.slice(-8)}, true, 1)`.execute(
    ctx.db,
  );
  await sql`insert into product (id, category_id, name_vi, slug, is_active, sort_order) values (${productId}, ${categoryId}, 'P', ${productId.slice(-8)}, true, 1)`.execute(
    ctx.db,
  );
  await sql`insert into product_variant (id, product_id, sku, name_vi, price_vnd, duration_code, delivery_type, stock_policy, fulfillment_type) values (${variantId}, ${productId}, ${`SKU-${variantId}`}, 'V', 100000, 'P1M', 'MANUAL_REVIEW', 'LOCAL_ONLY', 'DIGITAL_FILE')`.execute(
    ctx.db,
  );
  await sql`insert into customer (id, status, locale) values (${customerId}, 'ACTIVE', 'vi')`.execute(
    ctx.db,
  );
  await sql`insert into customer_profile_snapshot (customer_id, telegram_user_id, chat_id, display_name, reachable) values (${customerId}, '123456789', '123456789', 'Buyer', true)`.execute(
    ctx.db,
  );
  await sql`insert into "order" (id, order_number, customer_id, variant_id, product_name_vi, variant_name_vi, price_vnd, duration_code, delivery_type, fulfillment_type, status, paid_at) values (${orderId}, ${`ORD-${orderId}`}, ${customerId}, ${variantId}, 'P', 'V', 100000, 'P1M', 'MANUAL_REVIEW', 'DIGITAL_FILE', 'PAID', now())`.execute(
    ctx.db,
  );
  await sql`
    insert into variant_file_artifact
      (id, variant_id, version, filename, mime_type, size_bytes, sha256, storage_reference, telegram_file_id, telegram_file_unique_id, is_active)
    values
      (${artifactId}, ${variantId}, 1, 'file.bin', 'application/octet-stream', ${String(bytes.byteLength)}, ${hash(bytes)}, ${filePath},
       ${input.cached ? "cached_handler_file_id_1234567890" : null}, ${input.cached ? "cached_unique" : null}, true)
  `.execute(ctx.db);
  return { orderId, artifactId, bytes };
}

function fileSender(fileId: string): TelegramDocumentSender & {
  calls: Array<Parameters<TelegramDocumentSender["sendDocument"]>[0]>;
} {
  const calls: Array<Parameters<TelegramDocumentSender["sendDocument"]>[0]> = [];
  return {
    calls,
    async sendDocument(input) {
      calls.push(input);
      return { fileId, fileUniqueId: "handler_unique" };
    },
  };
}

describe("file delivery handler integration", () => {
  it("OrderPaid sends the selected DIGITAL_FILE artifact and publishes the event", async () => {
    const f = await seedPaidFileOrder();
    const sender = fileSender("handler_file_id_1234567890");
    const eventId = newId();
    await enqueueOutboxEvent(ctx.db, {
      id: eventId,
      aggregateType: "Order",
      aggregateId: f.orderId,
      aggregateVersion: 2,
      eventType: "OrderPaid",
      payloadRedacted: { orderId: f.orderId, correlationId: "file-h1" },
    });
    await sql`update outbox_event set occurred_at = now() - interval '1 millisecond' where id = ${eventId}`.execute(
      ctx.db,
    );
    const handler = createFulfillmentOutboxHandler({
      db: ctx.db,
      vault: createInMemoryVault(),
      supplier: null,
      deliveryBaseUrl: "https://shop.example/d",
      bundleTtlSeconds: 900,
      fileDelivery: { storageRoots: [storageRoot], sender },
    });

    for (let i = 0; i < 5; i += 1) {
      await drainOutboxOnce(ctx.db, { batchSize: 5, maxAttempts: 5, handler });
      const event = await sql<{
        published: boolean;
      }>`select (published_at is not null) as published from outbox_event where id = ${eventId}`.execute(
        ctx.db,
      );
      if (event.rows[0]?.published) break;
    }
    expect(sender.calls).toHaveLength(1);
    expect(sender.calls[0]?.source.kind).toBe("bytes");
    const state = await sql<{
      order_status: string;
      job_status: string;
      cached: string | null;
      published: boolean;
      last_error_code: string | null;
    }>`
      select o.status as order_status, j.status as job_status, a.telegram_file_id as cached,
        (e.published_at is not null) as published, e.last_error_code
      from "order" o join file_delivery_job j on j.order_id = o.id join variant_file_artifact a on a.id = ${f.artifactId}
      join outbox_event e on e.id = ${eventId}
      where o.id = ${f.orderId}
    `.execute(ctx.db);
    expect(state.rows[0]).toEqual({
      order_status: "COMPLETED",
      job_status: "SENT",
      cached: "handler_file_id_1234567890",
      published: true,
      last_error_code: null,
    });
  });

  it("OrderPaid reuses cached Telegram file_id for a DIGITAL_FILE artifact", async () => {
    const f = await seedPaidFileOrder({ cached: true });
    const sender = fileSender("cached_handler_file_id_1234567890");
    const eventId = newId();
    await enqueueOutboxEvent(ctx.db, {
      id: eventId,
      aggregateType: "Order",
      aggregateId: f.orderId,
      aggregateVersion: 2,
      eventType: "OrderPaid",
      payloadRedacted: { orderId: f.orderId, correlationId: "file-h2" },
    });
    await sql`update outbox_event set occurred_at = now() - interval '1 millisecond' where id = ${eventId}`.execute(
      ctx.db,
    );
    const handler = createFulfillmentOutboxHandler({
      db: ctx.db,
      vault: createInMemoryVault(),
      supplier: null,
      deliveryBaseUrl: "https://shop.example/d",
      bundleTtlSeconds: 900,
      fileDelivery: { storageRoots: [storageRoot], sender },
    });

    for (let i = 0; i < 5; i += 1) {
      await drainOutboxOnce(ctx.db, { batchSize: 5, maxAttempts: 5, handler });
      const event = await sql<{
        published: boolean;
      }>`select (published_at is not null) as published from outbox_event where id = ${eventId}`.execute(
        ctx.db,
      );
      if (event.rows[0]?.published) break;
    }
    const event = await sql<{
      published: boolean;
      last_error_code: string | null;
    }>`select (published_at is not null) as published, last_error_code from outbox_event where id = ${eventId}`.execute(
      ctx.db,
    );
    expect(event.rows[0]).toEqual({ published: true, last_error_code: null });
    expect(sender.calls[0]?.source).toEqual({
      kind: "telegram_file_id",
      fileId: "cached_handler_file_id_1234567890",
    });
  });
});
