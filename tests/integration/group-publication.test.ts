import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { sql } from "kysely";
import { newId } from "../../src/shared/ids/index.js";
import { startPostgresContainer, type PgTestContext } from "../helpers/pg-container.js";
import {
  advanceRestockGenerations,
  enqueueRestockPublication,
  evaluateSocialProofCandidate,
  listSocialProofCandidates,
  handleGroupPublicationOutboxEvent,
  GROUP_RESTOCK_EVENT,
  GROUP_SOCIAL_PROOF_EVENT,
  type RestockGenerationTick,
} from "../../src/modules/group/publication.js";
import {
  createPostgresRateLimiter,
  DEFAULT_TELEGRAM_RATE_LIMIT_POLICIES,
} from "../../src/modules/risk/service.js";
import type { OutboxEvent } from "../../src/infrastructure/outbox/repository.js";

/**
 * Group publication (F-009): restock generations, social-proof gates, per-chat limiter.
 *
 * These are the guarantees that keep the community channel honest: one "back in stock" post
 * per 0 -> >0 sellable transition, at most one proof post per eligible order, nothing for
 * test/canary orders or opted-out customers, and never more than the documented per-chat
 * rate.
 */

let ctx: PgTestContext;
beforeAll(async () => {
  ctx = await startPostgresContainer();
}, 180_000);
afterAll(async () => ctx?.teardown());
beforeEach(async () => {
  await sql`
    truncate table group_social_proof_publication, group_restock_generation, telegram_rate_limit_bucket,
      outbox_event, delivery_bundle, digital_asset, order_transition, "order", product_variant,
      product, category, customer, group_commerce_settings cascade
  `.execute(ctx.db);
  await sql`
    insert into group_commerce_settings (id, group_chat_id) values ('main', '-1003906082671')
    on conflict (id) do nothing
  `.execute(ctx.db);
});

async function seedVariant(options: { isTest?: boolean; name?: string } = {}) {
  const categoryId = newId();
  const productId = newId();
  const variantId = newId();
  await sql`insert into category (id, name_vi, slug, is_active, sort_order) values (${categoryId}, 'AI', ${categoryId.slice(-8)}, true, 1)`.execute(
    ctx.db,
  );
  await sql`
    insert into product (id, category_id, name_vi, slug, is_active, sort_order, is_test)
    values (${productId}, ${categoryId}, ${options.name ?? "Claude Pro"}, ${productId.slice(-8)}, true, 1, ${options.isTest ?? false})
  `.execute(ctx.db);
  await sql`
    insert into product_variant (id, product_id, sku, name_vi, price_vnd, duration_code, delivery_type, stock_policy, is_active)
    values (${variantId}, ${productId}, ${"SKU-" + variantId.slice(-8)}, '1 tháng', 280000, 'P1M', 'CREDENTIAL', 'LOCAL_ONLY', true)
  `.execute(ctx.db);
  return { categoryId, productId, variantId };
}

async function addAvailableAssets(variantId: string, count: number): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const id = newId();
    ids.push(id);
    await sql`
      insert into digital_asset (id, variant_id, source_type, vault_ref, fingerprint_hash, status)
      values (${id}, ${variantId}, 'LOCAL', ${"vault:" + id}, ${"fp-" + id}, 'AVAILABLE')
    `.execute(ctx.db);
  }
  return ids;
}

async function seedCompletedOrder(options: { isTest?: boolean; name?: string } = {}) {
  const { productId, variantId } = await seedVariant(options);
  const customerId = newId();
  const orderId = newId();
  const orderNumber = "ORD-PUB-" + orderId.slice(-8);
  const assetId = newId();
  await sql`insert into customer (id, status, locale) values (${customerId}, 'ACTIVE', 'vi')`.execute(
    ctx.db,
  );
  await sql`
    insert into "order" (id, order_number, customer_id, variant_id, product_name_vi, variant_name_vi,
      price_vnd, duration_code, delivery_type, status, paid_at, completed_at)
    values (${orderId}, ${orderNumber}, ${customerId}, ${variantId}, ${options.name ?? "Claude Pro"},
      '1 tháng', 280000, 'P1M', 'CREDENTIAL', 'COMPLETED', now(), now())
  `.execute(ctx.db);
  await sql`
    insert into digital_asset (id, variant_id, source_type, vault_ref, fingerprint_hash, status, delivered_order_id)
    values (${assetId}, ${variantId}, 'LOCAL', ${"vault:" + assetId}, ${"fp-" + assetId}, 'DELIVERED', ${orderId})
  `.execute(ctx.db);
  await sql`
    insert into delivery_bundle (id, order_id, customer_id, asset_id, token_hash, status, expires_at)
    values (${newId()}, ${orderId}, ${customerId}, ${assetId}, ${"hash-" + assetId}, 'CONSUMED', now() + interval '1 day')
  `.execute(ctx.db);
  return { orderId, orderNumber, productId, variantId, customerId };
}

function restockEvent(tick: RestockGenerationTick): OutboxEvent {
  return {
    id: newId(),
    aggregateType: "ProductVariant",
    aggregateId: tick.variantId,
    aggregateVersion: tick.generation,
    eventType: GROUP_RESTOCK_EVENT,
    payloadRedacted: { variantId: tick.variantId, generation: tick.generation },
    attemptCount: 0,
    claimedBy: "test",
    generation: 1,
  };
}

describe("restock generations", () => {
  it("publishes once per 0 -> >0 sellable transition and not for later restocks", async () => {
    const { variantId } = await seedVariant();

    // First sighting establishes the baseline; a variant that was never empty is not a restock.
    expect(await advanceRestockGenerations(ctx.db, { batchSize: 100 })).toEqual([]);

    await addAvailableAssets(variantId, 5);
    const first = await advanceRestockGenerations(ctx.db, { batchSize: 100 });
    expect(first).toEqual([{ variantId, generation: 1 }]);

    // 5 -> 8 is more stock, not a restock.
    await addAvailableAssets(variantId, 3);
    expect(await advanceRestockGenerations(ctx.db, { batchSize: 100 })).toEqual([]);

    // 5 -> 0 then 0 -> 3 is a new generation.
    await sql`update digital_asset set status = 'DELIVERED' where variant_id = ${variantId}`.execute(
      ctx.db,
    );
    expect(await advanceRestockGenerations(ctx.db, { batchSize: 100 })).toEqual([]);
    await addAvailableAssets(variantId, 3);
    expect(await advanceRestockGenerations(ctx.db, { batchSize: 100 })).toEqual([
      { variantId, generation: 2 },
    ]);

    const row = await sql<{ generation: number; last_seen_sellable: number }>`
      select generation, last_seen_sellable from group_restock_generation where variant_id = ${variantId}
    `.execute(ctx.db);
    expect(row.rows[0]).toEqual({ generation: 2, last_seen_sellable: 3 });
  });

  it("deduplicates the outbox event for one generation across restarts", async () => {
    const { variantId } = await seedVariant();
    await advanceRestockGenerations(ctx.db, { batchSize: 100 });
    await addAvailableAssets(variantId, 2);
    const [tick] = await advanceRestockGenerations(ctx.db, { batchSize: 100 });
    expect(tick).toBeDefined();

    await enqueueRestockPublication(ctx.db, tick!);
    await enqueueRestockPublication(ctx.db, tick!).catch(() => undefined);

    const rows = await sql<{ n: string }>`
      select count(*)::text as n from outbox_event
      where aggregate_id = ${variantId} and event_type = ${GROUP_RESTOCK_EVENT}
    `.execute(ctx.db);
    expect(rows.rows[0]?.n).toBe("1");
  });
});

describe("social proof gates", () => {
  it("queues exactly one publication for a real completed order", async () => {
    const order = await seedCompletedOrder();
    expect(await listSocialProofCandidates(ctx.db, { batchSize: 50 })).toEqual([order.orderId]);

    const first = await evaluateSocialProofCandidate(ctx.db, { orderId: order.orderId });
    expect(first).toEqual({ queued: true, reason: null });

    const events = await sql<{ n: string; payload: Record<string, unknown> }>`
      select count(*)::text as n, min(payload_redacted::text) as payload from outbox_event
      where event_type = ${GROUP_SOCIAL_PROOF_EVENT}
    `.execute(ctx.db);
    expect(events.rows[0]?.n).toBe("1");

    // The ledger stops rescans, so the order can never be published twice.
    expect(await listSocialProofCandidates(ctx.db, { batchSize: 50 })).toEqual([]);
  });

  it("never queues a test product and records why", async () => {
    const order = await seedCompletedOrder({ isTest: true, name: "🧪 Test Account" });
    expect(await listSocialProofCandidates(ctx.db, { batchSize: 50 })).toEqual([]);
    const outcome = await evaluateSocialProofCandidate(ctx.db, { orderId: order.orderId });
    expect(outcome).toEqual({ queued: false, reason: "TEST_EXCLUDED" });
    const rows = await sql<{ outcome: string; reason: string }>`
      select outcome, reason from group_social_proof_publication where order_id = ${order.orderId}
    `.execute(ctx.db);
    expect(rows.rows[0]).toEqual({ outcome: "SKIPPED", reason: "TEST_EXCLUDED" });
  });

  it("never names the customer: the published text carries only an HMAC alias", async () => {
    const order = await seedCompletedOrder();
    await evaluateSocialProofCandidate(ctx.db, { orderId: order.orderId });
    const row = await sql<{ payload_redacted: Record<string, unknown> }>`
      select payload_redacted from outbox_event where event_type = ${GROUP_SOCIAL_PROOF_EVENT}
    `.execute(ctx.db);
    const payload = row.rows[0]!.payload_redacted;
    expect(String(payload.customerAlias)).toMatch(/^Khách #[0-9A-F]{4}$/);

    // The community only ever sees the rendered message; internal ids may ride the payload
    // for delivery, but nothing identifying may reach the text.
    const published = String(payload.message);
    expect(published).toContain("Khách #");
    for (const forbidden of [order.customerId, order.orderNumber, "example.invalid", "@"]) {
      expect(published).not.toContain(forbidden);
    }
  });
});

describe("group publication delivery", () => {
  const send = vi.fn().mockResolvedValue(undefined);

  function deps(overrides: { membership?: "member" | null; allow?: boolean } = {}) {
    return {
      send,
      botMembership: vi
        .fn()
        .mockResolvedValue(overrides.membership === undefined ? "member" : overrides.membership),
      limiter: {
        tryConsume: vi.fn().mockResolvedValue({
          allowed: overrides.allow ?? true,
          retryAfterSeconds: overrides.allow === false ? 30 : 0,
        }),
      },
    };
  }

  it("sends a restock post for a real generation and stamps the settings", async () => {
    send.mockClear();
    const { variantId, productId } = await seedVariant();
    await advanceRestockGenerations(ctx.db, { batchSize: 100 });
    await addAvailableAssets(variantId, 2);
    const [tick] = await advanceRestockGenerations(ctx.db, { batchSize: 100 });

    const decision = await handleGroupPublicationOutboxEvent(ctx.db, restockEvent(tick!), deps());
    expect(decision).toEqual({ kind: "PUBLISHED" });
    expect(send).toHaveBeenCalledTimes(1);
    const call = send.mock.calls[0]?.[0] as {
      chatId: string;
      message: { text: string; buttons: unknown[][] };
    };
    expect(call.chatId).toBe("-1003906082671");
    expect(call.message.text).toContain("🔥 HÀNG ĐÃ VỀ!");
    expect(JSON.stringify(call.message.buttons)).toContain(productId);
    const settings = await sql<{ last: Date | null }>`
      select last_restock_published_at as last from group_commerce_settings where id = 'main'
    `.execute(ctx.db);
    expect(settings.rows[0]?.last).not.toBeNull();
  });

  it("defers without consuming the failure budget when the limiter denies", async () => {
    send.mockClear();
    const { variantId } = await seedVariant();
    await advanceRestockGenerations(ctx.db, { batchSize: 100 });
    await addAvailableAssets(variantId, 2);
    const [tick] = await advanceRestockGenerations(ctx.db, { batchSize: 100 });

    const decision = await handleGroupPublicationOutboxEvent(
      ctx.db,
      restockEvent(tick!),
      deps({ allow: false }),
    );
    expect(decision).toEqual({ kind: "RETRY", errorCode: "RATE_LIMITED" });
    expect(send).not.toHaveBeenCalled();
  });

  it("waits while the bot is not a member instead of posting into the void", async () => {
    send.mockClear();
    const { variantId } = await seedVariant();
    await advanceRestockGenerations(ctx.db, { batchSize: 100 });
    await addAvailableAssets(variantId, 2);
    const [tick] = await advanceRestockGenerations(ctx.db, { batchSize: 100 });

    const decision = await handleGroupPublicationOutboxEvent(
      ctx.db,
      restockEvent(tick!),
      deps({ membership: null }),
    );
    expect(decision).toEqual({ kind: "RETRY", errorCode: "GROUP_NOT_MEMBER" });
    expect(send).not.toHaveBeenCalled();
  });

  it("does nothing while restock publishing is switched off", async () => {
    send.mockClear();
    await sql`update group_commerce_settings set restock_publishing_enabled = false where id = 'main'`.execute(
      ctx.db,
    );
    const decision = await handleGroupPublicationOutboxEvent(
      ctx.db,
      restockEvent({ variantId: newId(), generation: 1 }),
      deps(),
    );
    expect(decision).toEqual({ kind: "PUBLISHED" });
    expect(send).not.toHaveBeenCalled();
  });
});

describe("group publication rate limit", () => {
  it("caps a chat at GROUP_PUBLICATION_MAX_PER_MINUTE and reports a retry delay", async () => {
    const limiter = createPostgresRateLimiter(ctx.db, DEFAULT_TELEGRAM_RATE_LIMIT_POLICIES);
    expect(DEFAULT_TELEGRAM_RATE_LIMIT_POLICIES.GROUP_PUBLICATION.capacity).toBe(12);

    const results = [];
    for (let i = 0; i < 13; i += 1) {
      results.push(
        await limiter.tryConsume({
          principal: "group:-1003906082671",
          action: "GROUP_PUBLICATION",
        }),
      );
    }
    expect(results.slice(0, 12).every((r) => r.allowed)).toBe(true);
    expect(results[12]?.allowed).toBe(false);
    expect(results[12]?.retryAfterSeconds).toBeGreaterThan(0);

    // A different chat has its own budget — one busy community cannot starve another.
    expect(
      (await limiter.tryConsume({ principal: "group:-1009999999999", action: "GROUP_PUBLICATION" }))
        .allowed,
    ).toBe(true);
  });
});
