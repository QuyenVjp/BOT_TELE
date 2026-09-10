import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { createInMemoryVault } from "../../src/infrastructure/vault/testing-adapter.js";
import {
  claimDeliveryNotifications,
  createDeliveryNotificationHandoff,
  processDeliveryNotificationBatch,
} from "../../src/modules/digital-goods/delivery-notification.js";
import { issueDeliveryBundle } from "../../src/modules/digital-goods/delivery.js";
import { newId } from "../../src/shared/ids/index.js";
import { startPostgresContainer, type PgTestContext } from "../helpers/pg-container.js";

const SESSION_CONFIG = {
  key: "test-only-notification-session-key-material-123456",
  keyVersion: 2,
  audience: "delivery-reveal",
};

let ctx: PgTestContext;

beforeAll(async () => {
  ctx = await startPostgresContainer();
}, 180_000);

afterAll(async () => {
  await ctx?.teardown();
});

beforeEach(async () => {
  await sql`
    truncate table delivery_capability_compensation, delivery_notification_handoff,
      delivery_session, delivery_bundle,
      channel_identity, digital_asset, outbox_event, "order", product_variant,
      product, category, customer cascade
  `.execute(ctx.db);
});

async function seedBundle() {
  const categoryId = newId();
  const productId = newId();
  const variantId = newId();
  const customerId = newId();
  const orderId = newId();
  const assetId = newId();
  const vault = createInMemoryVault();
  const vaultRef = await vault.write("RAW-CREDENTIAL-MUST-NOT-BE-IN-HANDOFF");
  const slug = categoryId.slice(-8);
  await sql`insert into category (id, name_vi, slug, is_active, sort_order) values (${categoryId}, 'C', ${slug}, true, 1)`.execute(
    ctx.db,
  );
  await sql`insert into product (id, category_id, name_vi, slug, is_active, sort_order) values (${productId}, ${categoryId}, 'P', ${slug}, true, 1)`.execute(
    ctx.db,
  );
  await sql`
    insert into product_variant (id, product_id, sku, name_vi, price_vnd, duration_code,
      delivery_type, stock_policy, resale_evidence_id)
    values (${variantId}, ${productId}, ${"SKU-" + variantId}, 'V', 100000, 'P1M',
      'CREDENTIAL', 'LOCAL_ONLY', 'RES-1')
  `.execute(ctx.db);
  await sql`insert into customer (id) values (${customerId})`.execute(ctx.db);
  await sql`
    insert into channel_identity (id, customer_id, channel, channel_user_id, observed_username)
    values (${newId()}, ${customerId}, 'TELEGRAM', '7788990011', 'metadata_only')
  `.execute(ctx.db);
  await sql`
    insert into "order" (id, order_number, customer_id, variant_id, product_name_vi,
      variant_name_vi, price_vnd, duration_code, delivery_type, status, paid_at)
    values (${orderId}, ${"ORD-" + orderId}, ${customerId}, ${variantId}, 'P', 'V',
      100000, 'P1M', 'CREDENTIAL', 'PAID', now())
  `.execute(ctx.db);
  await sql`
    insert into digital_asset (id, variant_id, source_type, vault_ref, fingerprint_hash,
      status, reserved_order_id)
    values (${assetId}, ${variantId}, 'LOCAL', ${vaultRef}, ${"fp-" + newId()},
      'READY', ${orderId})
  `.execute(ctx.db);
  const issued = await issueDeliveryBundle(ctx.db, {
    orderId,
    customerId,
    assetId,
    ttlSeconds: 900,
    correlationId: "notification-fixture",
  });
  if (!issued.ok) throw new Error("bundle issue failed");
  return { ...issued, orderId, customerId, vault };
}

describe("durable delivery notification handoff (T139/T145)", () => {
  it("targets the canonical Telegram chat and keeps credential/session capability out of rows", async () => {
    const f = await seedBundle();
    const handoff = await createDeliveryNotificationHandoff(ctx.db, {
      vault: f.vault,
      bundleId: f.bundleId,
      customerId: f.customerId,
      deliveryUrl: `https://shop.example/d/${f.token}`,
      sessionTtlSeconds: 300,
      sessionConfig: SESSION_CONFIG,
    });
    const row = await sql<{
      customer_id: string;
      telegram_chat_id: string;
      capability_ref: string;
      payload_redacted: unknown;
    }>`select customer_id, telegram_chat_id, capability_ref, payload_redacted
       from delivery_notification_handoff where id = ${handoff.id}`.execute(ctx.db);
    expect(row.rows[0]).toMatchObject({
      customer_id: f.customerId,
      telegram_chat_id: "7788990011",
      capability_ref: expect.stringMatching(/^vault:/),
    });
    expect(JSON.stringify(row.rows[0])).not.toContain("RAW-CREDENTIAL");
    expect(JSON.stringify(row.rows[0])).not.toContain(f.token);
    expect(JSON.stringify(row.rows[0])).not.toContain("ds1.");
  });

  it("retries a send failure with the same capability and correct recipient", async () => {
    const f = await seedBundle();
    await createDeliveryNotificationHandoff(ctx.db, {
      vault: f.vault,
      bundleId: f.bundleId,
      customerId: f.customerId,
      deliveryUrl: `https://shop.example/d/${f.token}`,
      sessionTtlSeconds: 300,
      sessionConfig: SESSION_CONFIG,
    });
    const seen: Array<{ chatId: string; handoffId: string; idempotencyKey: string }> = [];
    let fail = true;
    const sender = {
      async send(input: { chatId: string; handoffId: string; idempotencyKey: string }) {
        seen.push(input);
        if (fail) {
          fail = false;
          throw new Error("telegram unavailable");
        }
      },
    };
    const first = await processDeliveryNotificationBatch({
      db: ctx.db,
      vault: f.vault,
      sender,
      owner: "notify-a",
      batchSize: 1,
      maxAttempts: 5,
      sessionConfig: SESSION_CONFIG,
      sessionTtlSeconds: 300,
    });
    const second = await processDeliveryNotificationBatch({
      db: ctx.db,
      vault: f.vault,
      sender,
      owner: "notify-b",
      batchSize: 1,
      maxAttempts: 5,
      sessionConfig: SESSION_CONFIG,
      sessionTtlSeconds: 300,
    });
    expect(first).toMatchObject({ failed: 1, sent: 0 });
    expect(second).toMatchObject({ failed: 0, sent: 1 });
    expect(seen.map((item) => item.chatId)).toEqual(["7788990011", "7788990011"]);
    expect(new Set(seen.map((item) => item.handoffId)).size).toBe(1);
    expect(seen[0]?.handoffId).toBeTruthy();
    expect(new Set(seen.map((item) => item.idempotencyKey)).size).toBe(1);
  });

  it("recovers after crash-after-send without minting a second usable capability", async () => {
    const f = await seedBundle();
    await createDeliveryNotificationHandoff(ctx.db, {
      vault: f.vault,
      bundleId: f.bundleId,
      customerId: f.customerId,
      deliveryUrl: `https://shop.example/d/${f.token}`,
      sessionTtlSeconds: 300,
      sessionConfig: SESSION_CONFIG,
    });
    const [claim] = await claimDeliveryNotifications(ctx.db, {
      owner: "crashed-worker",
      batchSize: 1,
      leaseSeconds: 30,
    });
    expect(claim).toBeDefined();
    const delivered = new Set<string>();
    delivered.add(claim!.id);

    await sql`
      update delivery_notification_handoff
      set claim_expires_at = now() - interval '1 second'
      where id = ${claim!.id}
    `.execute(ctx.db);
    const retry = await processDeliveryNotificationBatch({
      db: ctx.db,
      vault: f.vault,
      sender: {
        async send(input) {
          delivered.add(input.idempotencyKey);
        },
      },
      owner: "recovery-worker",
      batchSize: 1,
      maxAttempts: 5,
      sessionConfig: SESSION_CONFIG,
      sessionTtlSeconds: 300,
    });
    const sessions = await sql<{
      count: string;
    }>`select count(*)::text as count from delivery_session`.execute(ctx.db);
    expect(retry.sent).toBe(1);
    expect(delivered.size).toBe(1);
    expect(sessions.rows[0]?.count).toBe("1");
  });

  it("does not send after the notification lease expires during capability loading", async () => {
    const f = await seedBundle();
    const handoff = await createDeliveryNotificationHandoff(ctx.db, {
      vault: f.vault,
      bundleId: f.bundleId,
      customerId: f.customerId,
      deliveryUrl: `https://shop.example/d/${f.token}`,
      sessionTtlSeconds: 300,
      sessionConfig: SESSION_CONFIG,
    });
    let revealStarted!: () => void;
    const revealReady = new Promise<void>((resolve) => {
      revealStarted = resolve;
    });
    let releaseReveal!: () => void;
    const release = new Promise<void>((resolve) => {
      releaseReveal = resolve;
    });
    const gatedVault = {
      ...f.vault,
      async reveal(ref: string) {
        const material = await f.vault.reveal(ref);
        revealStarted();
        await release;
        return material;
      },
    };
    const sent: string[] = [];
    const firstRun = processDeliveryNotificationBatch({
      db: ctx.db,
      vault: gatedVault,
      sender: {
        async send(input) {
          sent.push(input.idempotencyKey);
        },
      },
      owner: "lease-expiry-before-send",
      batchSize: 1,
      maxAttempts: 5,
      sessionConfig: SESSION_CONFIG,
      sessionTtlSeconds: 300,
    });
    await revealReady;
    await sql`
      update delivery_notification_handoff
      set claim_expires_at = now() - interval '1 second'
      where id = ${handoff.id}
    `.execute(ctx.db);
    releaseReveal();
    const result = await firstRun;
    expect(result).toMatchObject({ sent: 0, failed: 0, stale: 1 });
    expect(sent).toEqual([]);
  });

  it("rechecks the persisted bundle/customer/chat mapping immediately before send", async () => {
    const f = await seedBundle();
    const handoff = await createDeliveryNotificationHandoff(ctx.db, {
      vault: f.vault,
      bundleId: f.bundleId,
      customerId: f.customerId,
      deliveryUrl: `https://shop.example/d/${f.token}`,
      sessionTtlSeconds: 300,
      sessionConfig: SESSION_CONFIG,
    });
    let revealStarted!: () => void;
    const revealReady = new Promise<void>((resolve) => {
      revealStarted = resolve;
    });
    let releaseReveal!: () => void;
    const release = new Promise<void>((resolve) => {
      releaseReveal = resolve;
    });
    const gatedVault = {
      ...f.vault,
      async reveal(ref: string) {
        const material = await f.vault.reveal(ref);
        revealStarted();
        await release;
        return material;
      },
    };
    const sent: string[] = [];
    const run = processDeliveryNotificationBatch({
      db: ctx.db,
      vault: gatedVault,
      sender: {
        async send(input) {
          sent.push(input.chatId);
        },
      },
      owner: "recipient-recheck",
      batchSize: 1,
      maxAttempts: 5,
      sessionConfig: SESSION_CONFIG,
      sessionTtlSeconds: 300,
    });
    await revealReady;
    await sql`
      update delivery_notification_handoff set telegram_chat_id = '9988776655'
      where id = ${handoff.id}
    `.execute(ctx.db);
    releaseReveal();
    const result = await run;
    expect(result).toMatchObject({ sent: 0, failed: 1 });
    expect(sent).toEqual([]);
  });

  it("aborts and dead-letters an ambiguous send before its notification lease can expire", async () => {
    const f = await seedBundle();
    await createDeliveryNotificationHandoff(ctx.db, {
      vault: f.vault,
      bundleId: f.bundleId,
      customerId: f.customerId,
      deliveryUrl: `https://shop.example/d/${f.token}`,
      sessionTtlSeconds: 300,
      sessionConfig: SESSION_CONFIG,
    });
    let observedSignal: AbortSignal | undefined;
    const result = await processDeliveryNotificationBatch({
      db: ctx.db,
      vault: f.vault,
      sender: {
        async send(input: {
          chatId: string;
          handoffId: string;
          idempotencyKey: string;
          signal?: AbortSignal;
        }) {
          observedSignal = input.signal;
          await new Promise<void>((resolve, reject) => {
            const fallback = setTimeout(resolve, 150);
            input.signal?.addEventListener(
              "abort",
              () => {
                clearTimeout(fallback);
                reject(input.signal?.reason ?? new Error("aborted"));
              },
              { once: true },
            );
          });
        },
      },
      owner: "bounded-send-worker",
      batchSize: 1,
      maxAttempts: 5,
      sessionConfig: SESSION_CONFIG,
      sessionTtlSeconds: 300,
      sendTimeoutMs: 25,
    });
    const row = await sql<{ status: string; last_error_code: string | null }>`
      select status, last_error_code from delivery_notification_handoff
      limit 1
    `.execute(ctx.db);
    expect(result).toMatchObject({ sent: 0, failed: 1 });
    expect(observedSignal?.aborted).toBe(true);
    expect(row.rows[0]).toMatchObject({
      status: "DEAD",
      last_error_code: "DeliveryNotificationSendTimeoutError",
    });
  });

  it("does not acknowledge SENT after the send lease expires", async () => {
    const f = await seedBundle();
    await createDeliveryNotificationHandoff(ctx.db, {
      vault: f.vault,
      bundleId: f.bundleId,
      customerId: f.customerId,
      deliveryUrl: `https://shop.example/d/${f.token}`,
      sessionTtlSeconds: 300,
      sessionConfig: SESSION_CONFIG,
    });
    let sendStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      sendStarted = resolve;
    });
    let releaseSend!: () => void;
    const release = new Promise<void>((resolve) => {
      releaseSend = resolve;
    });
    const run = processDeliveryNotificationBatch({
      db: ctx.db,
      vault: f.vault,
      sender: {
        async send() {
          sendStarted();
          await release;
        },
      },
      owner: "expired-send-ack",
      batchSize: 1,
      maxAttempts: 5,
      sessionConfig: SESSION_CONFIG,
      sessionTtlSeconds: 300,
    });
    await started;
    await sql`
      update delivery_notification_handoff
      set claim_expires_at = now() - interval '1 second'
      where status = 'PROCESSING'
    `.execute(ctx.db);
    releaseSend();
    const result = await run;
    const row = await sql<{ status: string }>`
      select status from delivery_notification_handoff limit 1
    `.execute(ctx.db);
    expect(result).toMatchObject({ sent: 0, failed: 0, stale: 1 });
    expect(row.rows[0]?.status).toBe("PROCESSING");
  });

  it("does not record RETRY or DEAD after the send lease expires", async () => {
    const f = await seedBundle();
    await createDeliveryNotificationHandoff(ctx.db, {
      vault: f.vault,
      bundleId: f.bundleId,
      customerId: f.customerId,
      deliveryUrl: `https://shop.example/d/${f.token}`,
      sessionTtlSeconds: 300,
      sessionConfig: SESSION_CONFIG,
    });
    let sendStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      sendStarted = resolve;
    });
    let releaseSend!: () => void;
    const release = new Promise<void>((resolve) => {
      releaseSend = resolve;
    });
    const run = processDeliveryNotificationBatch({
      db: ctx.db,
      vault: f.vault,
      sender: {
        async send() {
          sendStarted();
          await release;
          throw new Error("ambiguous send failure");
        },
      },
      owner: "expired-send-fail",
      batchSize: 1,
      maxAttempts: 5,
      sessionConfig: SESSION_CONFIG,
      sessionTtlSeconds: 300,
    });
    await started;
    await sql`
      update delivery_notification_handoff
      set claim_expires_at = now() - interval '1 second'
      where status = 'PROCESSING'
    `.execute(ctx.db);
    releaseSend();
    const result = await run;
    const row = await sql<{ status: string }>`
      select status from delivery_notification_handoff limit 1
    `.execute(ctx.db);
    expect(result).toMatchObject({ sent: 0, failed: 0, stale: 1 });
    expect(row.rows[0]?.status).toBe("PROCESSING");
  });
});
