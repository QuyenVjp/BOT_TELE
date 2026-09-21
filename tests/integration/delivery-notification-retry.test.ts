import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { createInMemoryVault } from "../../src/infrastructure/vault/testing-adapter.js";
import {
  claimDeliveryNotifications,
  createDeliveryNotificationHandoff,
  openTelegramDeliveryHandoff,
  processDeliveryNotificationBatch,
} from "../../src/modules/digital-goods/delivery-notification.js";
import {
  consumeDeliveryBundle,
  issueDeliveryBundle,
} from "../../src/modules/digital-goods/delivery.js";
import { newId } from "../../src/shared/ids/index.js";
import { startPostgresContainer, type PgTestContext } from "../helpers/pg-container.js";
const SESSION_CONFIG = {
  key: "test-only-notification-session-key-material-123456",
  keyVersion: 2,
  audience: "delivery-reveal",
};
const expectedDeliveryValue = "RAW-CREDENTIAL-MUST-NOT-BE-IN-HANDOFF";

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
  const paymentIntentId = newId();
  const bankTransactionId = newId();
  const allocationId = newId();
  const vault = createInMemoryVault();
  const vaultRef = await vault.write(expectedDeliveryValue);
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
      100000, 'P1M', 'CREDENTIAL', 'PROCESSING', now())
  `.execute(ctx.db);
  await sql`
    insert into bank_transaction
      (id, provider, provider_transaction_id, direction, merchant_account_id,
       amount_vnd, content, transacted_at, raw_hash, signature_status, schema_version)
    values
      (${bankTransactionId}, 'TEST', ${"TX-" + bankTransactionId}, 'IN', 'TEST-MERCHANT',
       100000, ${"ORD-" + orderId}, now(), ${"HASH-" + bankTransactionId}, 'VERIFIED', 'test')
  `.execute(ctx.db);
  await sql`
    insert into payment_intent
      (id, order_id, status, amount_vnd, merchant_account_id, transfer_content, expires_at,
       presented_at, settled_at)
    values
      (${paymentIntentId}, ${orderId}, 'SUCCEEDED', 100000, 'TEST-MERCHANT',
       ${"ORD-" + orderId}, now() + interval '1 hour', now(), now())
  `.execute(ctx.db);
  await sql`
    insert into payment_allocation
      (id, bank_transaction_id, payment_intent_id, allocated_amount_vnd, status,
       decision_code, correlation_id)
    values
      (${allocationId}, ${bankTransactionId}, ${paymentIntentId}, 100000, 'SETTLED',
       'TEST_EXACT', 'notification-fixture')
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
  return { ...issued, orderId, customerId, vault, orderNumber: `ORD-${orderId}` };
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

  it("carries the order number and amount into the delivery notification (§36)", async () => {
    const f = await seedBundle();
    await createDeliveryNotificationHandoff(ctx.db, {
      vault: f.vault,
      bundleId: f.bundleId,
      customerId: f.customerId,
      deliveryUrl: `https://shop.example/d/${f.token}`,
      sessionTtlSeconds: 300,
      sessionConfig: SESSION_CONFIG,
    });
    const seen: Array<{
      orderNumber: string;
      amountVnd: string;
      productName: string | null | undefined;
      secret: string;
    }> = [];
    const result = await processDeliveryNotificationBatch({
      db: ctx.db,
      vault: f.vault,
      sender: {
        async send(input) {
          seen.push({
            orderNumber: input.orderNumber,
            amountVnd: input.amountVnd,
            productName: input.product?.name,
            secret: input.secret,
          });
          return {
            chatId: input.chatId,
            messageId: "test-provider-message",
            succeededAt: new Date().toISOString(),
          };
        },
      },
      owner: "notify-order-context",
      batchSize: 1,
      maxAttempts: 3,
      sessionConfig: SESSION_CONFIG,
      sessionTtlSeconds: 300,
    });
    expect(result).toMatchObject({ sent: 1, failed: 0 });
    expect(seen).toEqual([
      {
        orderNumber: f.orderNumber,
        amountVnd: "100000",
        productName: "P",
        secret: expectedDeliveryValue,
      },
    ]);
    const state = await sql<{
      bundle_status: string;
      asset_status: string;
      order_status: string;
      session_used: boolean;
    }>`
      select b.status as bundle_status, a.status as asset_status, o.status as order_status,
        exists (
          select 1 from delivery_session s
          where s.bundle_id = b.id and s.used_at is not null
        ) as session_used
      from delivery_bundle b
      join digital_asset a on a.id = b.asset_id
      join "order" o on o.id = b.order_id
      where b.id = ${f.bundleId}
    `.execute(ctx.db);
    expect(state.rows[0]).toEqual({
      bundle_status: "CONSUMED",
      asset_status: "DELIVERED",
      order_status: "COMPLETED",
      session_used: true,
    });
  });
  it("finalizes after the verified session expires during Telegram send", async () => {
    const f = await seedBundle();
    await createDeliveryNotificationHandoff(ctx.db, {
      vault: f.vault,
      bundleId: f.bundleId,
      customerId: f.customerId,
      deliveryUrl: `https://shop.example/d/${f.token}`,
      sessionTtlSeconds: 2,
      sessionConfig: SESSION_CONFIG,
    });
    const result = await processDeliveryNotificationBatch({
      db: ctx.db,
      vault: f.vault,
      sender: {
        async send(input) {
          await new Promise<void>((resolve) => setTimeout(resolve, 2_200));
          return {
            chatId: input.chatId,
            messageId: "test-provider-message",
            succeededAt: new Date().toISOString(),
          };
        },
      },
      owner: "notify-expired-session",
      batchSize: 1,
      maxAttempts: 1,
      sendTimeoutMs: 5_000,
      sessionConfig: SESSION_CONFIG,
      sessionTtlSeconds: 2,
    });
    const state = await sql<{ bundle_status: string; session_used: boolean }>`
      select b.status as bundle_status,
        exists (
          select 1 from delivery_session s
          where s.bundle_id = b.id and s.used_at is not null
        ) as session_used
      from delivery_bundle b
      where b.id = ${f.bundleId}
    `.execute(ctx.db);
    expect(result).toMatchObject({ sent: 1, failed: 0 });
    expect(state.rows[0]).toEqual({ bundle_status: "CONSUMED", session_used: true });
  });

  it("reconciles a consumed bundle before loading the delivery capability", async () => {
    const f = await seedBundle();
    await createDeliveryNotificationHandoff(ctx.db, {
      vault: f.vault,
      bundleId: f.bundleId,
      customerId: f.customerId,
      deliveryUrl: `https://shop.example/d/${f.token}`,
      sessionTtlSeconds: 300,
      sessionConfig: SESSION_CONFIG,
    });
    const consumed = await consumeDeliveryBundle(ctx.db, {
      bundleId: f.bundleId,
      customerId: f.customerId,
      correlationId: "legacy-consume-before-notification",
    });
    expect(consumed).toMatchObject({ ok: true });

    let sends = 0;
    const result = await processDeliveryNotificationBatch({
      db: ctx.db,
      vault: f.vault,
      sender: {
        async send() {
          sends += 1;
          return {
            chatId: "7788990011",
            messageId: "unused-provider-message",
            succeededAt: new Date().toISOString(),
          };
        },
      },
      owner: "notify-recovery",
      batchSize: 1,
      maxAttempts: 1,
      sessionConfig: SESSION_CONFIG,
      sessionTtlSeconds: 300,
    });
    const handoff = await sql<{ status: string }>`
      select status from delivery_notification_handoff where bundle_id = ${f.bundleId}
    `.execute(ctx.db);
    expect(result).toMatchObject({ sent: 1, failed: 0 });
    expect(sends).toBe(0);
    expect(handoff.rows[0]?.status).toBe("SENT");
  });

  it("keeps order context on the legacy recovery presenter input", async () => {
    const f = await seedBundle();
    const handoff = await createDeliveryNotificationHandoff(ctx.db, {
      vault: f.vault,
      bundleId: f.bundleId,
      customerId: f.customerId,
      deliveryUrl: `https://shop.example/d/${f.token}`,
      sessionTtlSeconds: 300,
      sessionConfig: SESSION_CONFIG,
    });
    const opened = await openTelegramDeliveryHandoff({
      db: ctx.db,
      vault: f.vault,
      sessionConfig: SESSION_CONFIG,
      telegramUserId: "7788990011",
      handoffId: handoff.id,
      correlationId: "legacy-context",
    });
    expect(opened).toMatchObject({
      ok: true,
      orderNumber: f.orderNumber,
      amountVnd: "100000",
    });
  });

  it("parks an ambiguous send failure without a duplicate Telegram attempt", async () => {
    const f = await seedBundle();
    await createDeliveryNotificationHandoff(ctx.db, {
      vault: f.vault,
      bundleId: f.bundleId,
      customerId: f.customerId,
      deliveryUrl: `https://shop.example/d/${f.token}`,
      sessionTtlSeconds: 300,
      sessionConfig: SESSION_CONFIG,
    });
    const seen: string[] = [];
    const result = await processDeliveryNotificationBatch({
      db: ctx.db,
      vault: f.vault,
      sender: {
        async send(input: { chatId: string }) {
          seen.push(input.chatId);
          throw new Error("telegram unavailable");
        },
      },
      owner: "notify-ambiguous",
      batchSize: 1,
      maxAttempts: 5,
      sessionConfig: SESSION_CONFIG,
      sessionTtlSeconds: 300,
    });
    const row = await sql<{
      handoff_status: string;
      last_error_code: string | null;
      order_status: string;
      payload_redacted: { sendAttemptedAt?: string };
    }>`
      select h.status as handoff_status, h.last_error_code, o.status as order_status,
        h.payload_redacted
      from delivery_notification_handoff h
      join delivery_bundle b on b.id = h.bundle_id
      join "order" o on o.id = b.order_id
      limit 1
    `.execute(ctx.db);
    expect(result).toMatchObject({ sent: 0, failed: 1 });
    expect(seen).toEqual(["7788990011"]);
    expect(row.rows[0]).toMatchObject({
      handoff_status: "DEAD",
      last_error_code: "DELIVERY_UNCERTAIN",
      order_status: "FULFILLMENT_NEEDS_REVIEW",
    });
    expect(row.rows[0]?.payload_redacted.sendAttemptedAt).toEqual(expect.any(String));
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
          return {
            chatId: input.chatId,
            messageId: "test-provider-message",
            succeededAt: new Date().toISOString(),
          };
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

  it("self-heals a persisted Telegram success after a crash before finalization", async () => {
    const f = await seedBundle();
    const handoff = await createDeliveryNotificationHandoff(ctx.db, {
      vault: f.vault,
      bundleId: f.bundleId,
      customerId: f.customerId,
      deliveryUrl: `https://shop.example/d/${f.token}`,
      sessionTtlSeconds: 300,
      sessionConfig: SESSION_CONFIG,
    });
    const [claim] = await claimDeliveryNotifications(ctx.db, {
      owner: "crashed-after-provider-success",
      batchSize: 1,
      leaseSeconds: 30,
    });
    expect(claim?.id).toBe(handoff.id);
    const providerSucceededAt = new Date().toISOString();
    await sql`
      update delivery_notification_handoff
      set payload_redacted = payload_redacted || ${JSON.stringify({
        sendAttemptedAt: providerSucceededAt,
        providerChatId: "7788990011",
        providerMessageId: "provider-message-after-crash",
        providerSucceededAt,
      })}::jsonb,
          claim_expires_at = now() - interval '1 second'
      where id = ${handoff.id}
    `.execute(ctx.db);
    let sendCalls = 0;
    const result = await processDeliveryNotificationBatch({
      db: ctx.db,
      vault: f.vault,
      sender: {
        async send() {
          sendCalls += 1;
          throw new Error("duplicate Telegram send");
        },
      },
      owner: "recovery-after-provider-success",
      batchSize: 1,
      maxAttempts: 5,
      sessionConfig: SESSION_CONFIG,
      sessionTtlSeconds: 300,
    });
    const state = await sql<{
      handoff_status: string;
      bundle_status: string;
      asset_status: string;
      order_status: string;
    }>`
      select h.status as handoff_status, b.status as bundle_status,
        a.status as asset_status, o.status as order_status
      from delivery_notification_handoff h
      join delivery_bundle b on b.id = h.bundle_id
      join digital_asset a on a.id = b.asset_id
      join "order" o on o.id = b.order_id
      where h.id = ${handoff.id}
    `.execute(ctx.db);
    expect(result).toMatchObject({ sent: 1, failed: 0 });
    expect(sendCalls).toBe(0);
    expect(state.rows[0]).toEqual({
      handoff_status: "SENT",
      bundle_status: "CONSUMED",
      asset_status: "DELIVERED",
      order_status: "COMPLETED",
    });
  });

  it("parks a send-attempt marker without provider proof for owner review", async () => {
    const f = await seedBundle();
    const handoff = await createDeliveryNotificationHandoff(ctx.db, {
      vault: f.vault,
      bundleId: f.bundleId,
      customerId: f.customerId,
      deliveryUrl: `https://shop.example/d/${f.token}`,
      sessionTtlSeconds: 300,
      sessionConfig: SESSION_CONFIG,
    });
    await claimDeliveryNotifications(ctx.db, {
      owner: "crashed-before-provider-proof",
      batchSize: 1,
      leaseSeconds: 30,
    });
    await sql`
      update delivery_notification_handoff
      set payload_redacted = payload_redacted || ${JSON.stringify({
        sendAttemptedAt: new Date().toISOString(),
      })}::jsonb,
          claim_expires_at = now() - interval '1 second'
      where id = ${handoff.id}
    `.execute(ctx.db);
    let sendCalls = 0;
    const result = await processDeliveryNotificationBatch({
      db: ctx.db,
      vault: f.vault,
      sender: {
        async send() {
          sendCalls += 1;
          throw new Error("duplicate Telegram send");
        },
      },
      owner: "recovery-without-provider-proof",
      batchSize: 1,
      maxAttempts: 5,
      sessionConfig: SESSION_CONFIG,
      sessionTtlSeconds: 300,
    });
    const state = await sql<{ handoff_status: string; order_status: string }>`
      select h.status as handoff_status, o.status as order_status
      from delivery_notification_handoff h
      join delivery_bundle b on b.id = h.bundle_id
      join "order" o on o.id = b.order_id
      where h.id = ${handoff.id}
    `.execute(ctx.db);
    expect(result).toMatchObject({ sent: 0, failed: 1 });
    expect(sendCalls).toBe(0);
    expect(state.rows[0]).toEqual({
      handoff_status: "DEAD",
      order_status: "FULFILLMENT_NEEDS_REVIEW",
    });
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
          return {
            chatId: input.chatId,
            messageId: "test-provider-message",
            succeededAt: new Date().toISOString(),
          };
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
          return {
            chatId: input.chatId,
            messageId: "test-provider-message",
            succeededAt: new Date().toISOString(),
          };
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

  it("parks a timed-out send before its notification lease can expire", async () => {
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
          return {
            chatId: input.chatId,
            messageId: "test-provider-message",
            succeededAt: new Date().toISOString(),
          };
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
      last_error_code: "DELIVERY_UNCERTAIN",
    });
  });

  it("parks provider success when the send lease expires before evidence persistence", async () => {
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
        async send(input) {
          sendStarted();
          await release;
          return {
            chatId: input.chatId,
            messageId: "test-provider-message",
            succeededAt: new Date().toISOString(),
          };
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
    expect(result).toMatchObject({ sent: 0, failed: 1, stale: 0 });
    expect(row.rows[0]?.status).toBe("DEAD");
  });

  it("parks an ambiguous failure when the send lease expires", async () => {
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
    expect(result).toMatchObject({ sent: 0, failed: 1, stale: 0 });
    expect(row.rows[0]?.status).toBe("DEAD");
  });
});
