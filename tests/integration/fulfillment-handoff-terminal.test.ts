import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { newId } from "../../src/shared/ids/index.js";
import { createInMemoryVault } from "../../src/infrastructure/vault/testing-adapter.js";
import { enqueueOutboxEvent } from "../../src/infrastructure/outbox/repository.js";
import { drainOutboxOnce } from "../../src/infrastructure/outbox/worker.js";
import { createFulfillmentOutboxHandler } from "../../src/modules/digital-goods/handlers.js";
import { fulfillPaidOrder } from "../../src/modules/digital-goods/fulfillment.js";
import { listTerminalOutboxOrphans } from "../../src/infrastructure/outbox/disposition.js";
import {
  dockerAvailable,
  startPostgresContainer,
  type PgTestContext,
} from "../helpers/pg-container.js";

/**
 * Slice B — delivery handoff classification.
 *
 * `DeliveryBundleCreated` used to RETRY `DELIVERY_HANDOFF_NOT_READY` until the
 * attempt budget ran out, so a handoff that could never be minted looked like a
 * transient blip and stayed invisible. It is now parked as operator review, and
 * the row keeps its payload/attempt evidence. Transient fulfillment outcomes
 * keep retrying exactly as before.
 */

const hasDocker = await dockerAvailable();

describe.skipIf(!hasDocker)("delivery handoff terminal classification", () => {
  let ctx: PgTestContext;

  const BUNDLE_KEY = "test-only-handoff-bundle-key-material-0000000001";
  const ROTATED_KEY = "test-only-handoff-rotated-key-material-00000002";

  beforeAll(async () => {
    ctx = await startPostgresContainer();
  }, 180_000);

  afterAll(async () => {
    await ctx?.teardown();
  });

  beforeEach(async () => {
    await sql`
      truncate table delivery_capability_compensation, delivery_notification_handoff,
        delivery_session, delivery_bundle, channel_identity, digital_asset,
        order_transition, outbox_event, "order", product_variant, product, category, customer cascade
    `.execute(ctx.db);
  });

  async function seedPaidOrder(input: { withAsset: boolean }) {
    const categoryId = newId();
    const productId = newId();
    const variantId = newId();
    const customerId = newId();
    const orderId = newId();
    const vault = createInMemoryVault();

    await sql`insert into category (id, name_vi, slug, is_active, sort_order) values (${categoryId}, 'C', ${categoryId.slice(-8)}, true, 1)`.execute(
      ctx.db,
    );
    await sql`insert into product (id, category_id, name_vi, slug, is_active, sort_order) values (${productId}, ${categoryId}, 'P', ${productId.slice(-8)}, true, 1)`.execute(
      ctx.db,
    );
    await sql`
      insert into product_variant (id, product_id, sku, name_vi, price_vnd, duration_code, delivery_type, stock_policy, resale_evidence_id)
      values (${variantId}, ${productId}, ${`SKU-${variantId}`}, 'V', 100000, 'P1M', 'CREDENTIAL', 'LOCAL_ONLY', 'RES-1')
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
      values (${orderId}, ${`ORD-${orderId}`}, ${customerId}, ${variantId}, 'P', 'V',
        100000, 'P1M', 'CREDENTIAL', 'PAID', now())
    `.execute(ctx.db);
    if (input.withAsset) {
      const vaultRef = await vault.write("HANDOFF-SECRET");
      await sql`
        insert into digital_asset (id, variant_id, source_type, vault_ref, fingerprint_hash, status)
        values (${newId()}, ${variantId}, 'LOCAL', ${vaultRef}, ${`fp-${newId()}`}, 'AVAILABLE')
      `.execute(ctx.db);
    }

    return { orderId, customerId, vault };
  }

  it("parks an unrecoverable handoff as terminal review instead of retrying", async () => {
    const f = await seedPaidOrder({ withAsset: true });

    // First issue uses BUNDLE_KEY; the drainer then runs with a rotated keyring
    // that cannot reconstruct the reveal token — no handoff can be minted.
    const issued = await fulfillPaidOrder(ctx.db, {
      orderId: f.orderId,
      correlationId: "handoff-issue",
      deps: {
        vault: f.vault,
        supplier: null,
        deliveryBaseUrl: "https://shop.example/d",
        bundleTtlSeconds: 900,
        deliveryTokenKeys: [BUNDLE_KEY],
      },
    });
    expect(issued.ok).toBe(true);

    const eventId = newId();
    await enqueueOutboxEvent(ctx.db, {
      id: eventId,
      aggregateType: "DeliveryBundle",
      aggregateId: newId(),
      aggregateVersion: 1,
      eventType: "DeliveryBundleCreated",
      payloadRedacted: { orderId: f.orderId, correlationId: "handoff-drain" },
    });
    await sql`update outbox_event set occurred_at = now() - interval '1 minute' where id = ${eventId}`.execute(
      ctx.db,
    );

    const handler = createFulfillmentOutboxHandler({
      db: ctx.db,
      vault: f.vault,
      supplier: null,
      deliveryBaseUrl: "https://shop.example/d",
      bundleTtlSeconds: 900,
      deliverySession: {
        config: { key: ROTATED_KEY, keyVersion: 1, audience: "delivery-reveal" },
        ttlSeconds: 300,
      },
    });

    const drain = await drainOutboxOnce(ctx.db, { batchSize: 1, maxAttempts: 5, handler });
    expect(drain).toMatchObject({ claimed: 1, terminal: 1, failed: 1, published: 0 });

    const row = await sql<{
      published_at: Date | null;
      dead_lettered_at: Date | null;
      last_error_code: string | null;
      attempt_count: number;
      payload_redacted: Record<string, unknown>;
    }>`
      select published_at, dead_lettered_at, last_error_code, attempt_count, payload_redacted
      from outbox_event where id = ${eventId}
    `.execute(ctx.db);
    const event = row.rows[0]!;
    // Parked, never acked: the operator can still see the event and its payload.
    expect(event.published_at).toBeNull();
    expect(event.dead_lettered_at).toBeInstanceOf(Date);
    expect(event.last_error_code).toBe("DELIVERY_HANDOFF_NOT_READY");
    expect(event.payload_redacted).toMatchObject({ orderId: f.orderId });
    // One attempt, not five: the outcome is deterministic, so it does not spin.
    expect(event.attempt_count).toBe(1);

    const orphans = await listTerminalOutboxOrphans(ctx.db, 10);
    expect(orphans.map((orphan) => orphan.id)).toEqual([eventId]);

    // A parked handoff leaves the bundle itself intact for review/reissue.
    const bundles = await sql<{ count: string }>`
      select count(*)::text as count from delivery_bundle where order_id = ${f.orderId}
    `.execute(ctx.db);
    expect(Number(bundles.rows[0]?.count)).toBe(1);
  });

  it("keeps a transient out-of-stock handoff retryable", async () => {
    const f = await seedPaidOrder({ withAsset: false });

    const eventId = newId();
    await enqueueOutboxEvent(ctx.db, {
      id: eventId,
      aggregateType: "DeliveryBundle",
      aggregateId: newId(),
      aggregateVersion: 1,
      eventType: "DeliveryBundleCreated",
      payloadRedacted: { orderId: f.orderId, correlationId: "handoff-restock" },
    });
    await sql`update outbox_event set occurred_at = now() - interval '1 minute' where id = ${eventId}`.execute(
      ctx.db,
    );

    const handler = createFulfillmentOutboxHandler({
      db: ctx.db,
      vault: f.vault,
      supplier: null,
      deliveryBaseUrl: "https://shop.example/d",
      bundleTtlSeconds: 900,
      deliverySession: {
        config: { key: BUNDLE_KEY, keyVersion: 1, audience: "delivery-reveal" },
        ttlSeconds: 300,
      },
    });

    const drain = await drainOutboxOnce(ctx.db, { batchSize: 1, maxAttempts: 5, handler });
    expect(drain).toMatchObject({ claimed: 1, failed: 1, terminal: 0, published: 0 });

    const row = await sql<{
      dead_lettered_at: Date | null;
      last_error_code: string | null;
      attempt_count: number;
    }>`
      select dead_lettered_at, last_error_code, attempt_count from outbox_event where id = ${eventId}
    `.execute(ctx.db);
    expect(row.rows[0]).toMatchObject({
      dead_lettered_at: null,
      last_error_code: "OUT_OF_STOCK",
      attempt_count: 1,
    });
    expect(await listTerminalOutboxOrphans(ctx.db, 10)).toHaveLength(0);
  });
});
