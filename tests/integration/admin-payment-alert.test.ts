import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "kysely";
import {
  handleNotificationOutboxEvent,
  claimNotificationDeliveries,
  processNotificationDeliveryClaim,
} from "../../src/modules/notification/service.js";
import { createInMemoryVault } from "../../src/infrastructure/vault/testing-adapter.js";
import { createFulfillmentOutboxHandler } from "../../src/modules/digital-goods/handlers.js";
import { listAdminManualFulfillmentTasks } from "../../src/modules/digital-goods/manual-fulfillment.js";
import { createWalletLedgerService } from "../../src/modules/wallet/ledger.js";
import { newId } from "../../src/shared/ids/index.js";
import { startPostgresContainer, type PgTestContext } from "../helpers/pg-container.js";

let ctx: PgTestContext;
const ROOT_TELEGRAM_ID = 99887766;

beforeAll(async () => {
  ctx = await startPostgresContainer();
}, 180_000);

afterAll(async () => {
  await ctx?.teardown();
});

beforeEach(async () => {
  await sql`
    truncate table notification_delivery, notification_campaign, notification_preference,
      channel_identity, customer_profile_snapshot, payment_allocation, payment_intent,
      bank_transaction, order_transition, outbox_event, manual_fulfillment_task,
      variant_service_fulfillment, "order", product_variant, product, category, customer cascade
  `.execute(ctx.db);
});

async function seedFixture(): Promise<{ orderId: string; rootCustomerId: string }> {
  const rootCustomerId = newId();
  const buyerId = newId();
  const categoryId = newId();
  const productId = newId();
  const variantId = newId();
  const orderId = newId();
  const intentId = newId();
  const transactionId = newId();
  const allocationId = newId();
  await sql`insert into customer (id, status, locale)
    values (${rootCustomerId}, 'ACTIVE', 'vi'), (${buyerId}, 'ACTIVE', 'vi')`.execute(ctx.db);
  await sql`insert into channel_identity (id, customer_id, channel, channel_user_id)
    values
      (${newId()}, ${rootCustomerId}, 'TELEGRAM', ${String(ROOT_TELEGRAM_ID)}),
      (${newId()}, ${buyerId}, 'TELEGRAM', ${String(ROOT_TELEGRAM_ID + 1)})`.execute(ctx.db);
  await sql`insert into category (id, name_vi, slug)
    values (${categoryId}, 'AI', ${`ai-${categoryId.slice(-8)}`})`.execute(ctx.db);
  await sql`insert into product (id, category_id, name_vi, slug, is_active, is_test, is_archived)
    values (${productId}, ${categoryId}, 'ChatGPT Plus', ${`chatgpt-${productId.slice(-8)}`}, true, false, false)`.execute(
    ctx.db,
  );
  await sql`insert into product_variant (id, product_id, sku, name_vi, price_vnd, duration_code,
      delivery_type, stock_policy, resale_evidence_id)
    values (${variantId}, ${productId}, ${`SKU-${variantId}`}, '1 tháng', 250000, 'P1M',
      'CREDENTIAL', 'LOCAL_ONLY', 'RES-1')`.execute(ctx.db);
  await sql`insert into "order" (id, order_number, customer_id, variant_id, product_name_vi,
      variant_name_vi, price_vnd, duration_code, delivery_type, warranty_days, status, paid_at, version)
    values (${orderId}, 'ORD-ALERT-1', ${buyerId}, ${variantId}, 'ChatGPT Plus', '1 tháng',
      250000, 'P1M', 'CREDENTIAL', 0, 'PAID', now(), 1)`.execute(ctx.db);
  await sql`insert into payment_intent (id, order_id, status, amount_vnd, merchant_account_id,
      transfer_content, expires_at, settled_at)
    values (${intentId}, ${orderId}, 'SUCCEEDED', 250000, 'SEPAY-ACCOUNT', 'TIER20-ALERT',
      now() + interval '1 day', now())`.execute(ctx.db);
  await sql`insert into bank_transaction (id, provider, provider_transaction_id, direction,
      merchant_account_id, amount_vnd, content, reference, transacted_at, raw_hash, signature_status,
      schema_version)
    values (${transactionId}, 'sepay', 'provider-alert-1', 'IN', 'SEPAY-ACCOUNT', 250000,
      'safe-content', 'safe-reference', now(), ${"a".repeat(64)}, 'VERIFIED', 'v1')`.execute(
    ctx.db,
  );
  await sql`insert into payment_allocation (id, bank_transaction_id, payment_intent_id,
      allocated_amount_vnd, status, decision_code, correlation_id)
    values (${allocationId}, ${transactionId}, ${intentId}, 250000, 'SETTLED', 'EXACT_MATCH',
      'alert-test')`.execute(ctx.db);
  return { orderId, rootCustomerId };
}

function event(eventType: string, orderId: string) {
  return {
    id: newId(),
    aggregateType: "PaymentIntent",
    aggregateId: newId(),
    aggregateVersion: 1,
    eventType,
    payloadRedacted: { orderId, correlationId: "alert-test" },
    attemptCount: 0,
    claimedBy: "test",
    generation: 1,
  } as const;
}

async function prepareManualOrder(orderId: string): Promise<number> {
  const order = await sql<{ variant_id: string; price_vnd: string }>`
    select variant_id, price_vnd::text from "order" where id = ${orderId}
  `.execute(ctx.db);
  const { variant_id: variantId, price_vnd: priceVnd } = order.rows[0]!;
  await sql`
    delete from payment_allocation
    where payment_intent_id in (select id from payment_intent where order_id = ${orderId})
  `.execute(ctx.db);
  await sql`delete from payment_intent where order_id = ${orderId}`.execute(ctx.db);
  await sql`delete from bank_transaction`.execute(ctx.db);
  await sql`update product_variant set fulfillment_type = 'MANUAL_FULFILLMENT'
    where id = ${variantId}`.execute(ctx.db);
  await sql`update "order" set fulfillment_type = 'MANUAL_FULFILLMENT',
    status = 'PENDING_PAYMENT', paid_at = null where id = ${orderId}`.execute(ctx.db);
  await sql`
    insert into variant_service_fulfillment
      (variant_id, fulfillment_type, instructions, is_active)
    values (${variantId}, 'MANUAL_FULFILLMENT',
      'Provision manually after checking customer account.', true)
  `.execute(ctx.db);
  return Number(priceVnd);
}

function fulfillmentOutboxHandler() {
  return createFulfillmentOutboxHandler({
    db: ctx.db,
    vault: createInMemoryVault(),
    supplier: null,
    deliveryBaseUrl: "https://shop.example/d",
    bundleTtlSeconds: 900,
  });
}

function paidOrderEvent(orderId: string, correlationId: string) {
  return {
    id: newId(),
    aggregateType: "Order",
    aggregateId: orderId,
    aggregateVersion: 2,
    eventType: "OrderPaid",
    payloadRedacted: { orderId, correlationId },
    attemptCount: 0,
    claimedBy: "test",
    generation: 1,
  } as const;
}

async function settleManualOrder(orderId: string, amount: number): Promise<void> {
  const intentId = newId();
  const transactionId = newId();
  await sql`
    insert into payment_intent (id, order_id, status, amount_vnd, merchant_account_id,
      transfer_content, expires_at, settled_at)
    values (${intentId}, ${orderId}, 'SUCCEEDED', ${amount}, 'SEPAY-ACCOUNT',
      'TIER20-MANUAL', now() + interval '1 day', now())
  `.execute(ctx.db);
  await sql`
    insert into bank_transaction (id, provider, provider_transaction_id, direction,
      merchant_account_id, amount_vnd, content, reference, transacted_at, raw_hash,
      signature_status, schema_version)
    values (${transactionId}, 'sepay', ${`manual-${transactionId}`}, 'IN', 'SEPAY-ACCOUNT',
      ${amount}, 'safe-content', 'safe-reference', now(), ${"b".repeat(64)}, 'VERIFIED', 'v1')
  `.execute(ctx.db);
  await sql`
    insert into payment_allocation (id, bank_transaction_id, payment_intent_id,
      allocated_amount_vnd, status, decision_code, correlation_id)
    values (${newId()}, ${transactionId}, ${intentId}, ${amount}, 'SETTLED', 'EXACT_MATCH',
      'manual-alert-test')
  `.execute(ctx.db);
  await sql`update "order" set status = 'PAID', paid_at = now(), version = version + 1
    where id = ${orderId}`.execute(ctx.db);
}

describe("admin payment alert", () => {
  it("does not alert on an unverified or unmatched settlement payload", async () => {
    const { orderId } = await seedFixture();
    await sql`update bank_transaction set signature_status = 'UNVERIFIED'`.execute(ctx.db);
    const result = await handleNotificationOutboxEvent(ctx.db, event("PaymentSettled", orderId), {
      rootTelegramUserId: ROOT_TELEGRAM_ID,
    });
    expect(result).toMatchObject({ kind: "PUBLISHED" });
    const campaigns =
      await sql`select id from notification_campaign where id like 'admin-payment-%'`.execute(
        ctx.db,
      );
    expect(campaigns.rows).toHaveLength(0);
  });

  it("suppresses admin alerts without changing settlement handling when mode is OFF", async () => {
    const { orderId } = await seedFixture();
    const result = await handleNotificationOutboxEvent(ctx.db, event("PaymentSettled", orderId), {
      rootTelegramUserId: ROOT_TELEGRAM_ID,
      adminAlertMode: "OFF",
    });
    expect(result).toMatchObject({ kind: "PUBLISHED" });
    const campaigns =
      await sql`select id from notification_campaign where id like 'admin-payment-%'`.execute(
        ctx.db,
      );
    expect(campaigns.rows).toHaveLength(0);
  });

  it("deduplicates settlement, persists message identity, and edits on completion", async () => {
    const { orderId } = await seedFixture();
    const settled = event("PaymentSettled", orderId);
    expect(
      await handleNotificationOutboxEvent(ctx.db, settled, {
        rootTelegramUserId: ROOT_TELEGRAM_ID,
      }),
    ).toMatchObject({ kind: "PUBLISHED" });
    expect(
      await handleNotificationOutboxEvent(ctx.db, settled, {
        rootTelegramUserId: ROOT_TELEGRAM_ID,
      }),
    ).toMatchObject({ kind: "PUBLISHED" });
    const count = await sql<{
      count: string;
    }>`select count(*)::text as count from notification_delivery`.execute(ctx.db);
    expect(count.rows[0]?.count).toBe("1");

    const [claim] = await claimNotificationDeliveries(ctx.db, 1);
    await processNotificationDeliveryClaim(ctx.db, claim!, {
      send: async (input) => {
        expect(input.messageId).toBeNull();
        return { chatId: input.chatId, messageId: "telegram-101" };
      },
    });
    const sent = await sql<{
      message_id: string;
    }>`select message_id from notification_delivery`.execute(ctx.db);
    expect(sent.rows[0]?.message_id).toBe("telegram-101");

    await sql`update "order" set status = 'COMPLETED', completed_at = now(), version = 2 where id = ${orderId}`.execute(
      ctx.db,
    );
    expect(
      await handleNotificationOutboxEvent(ctx.db, event("FulfillmentCompleted", orderId), {
        rootTelegramUserId: ROOT_TELEGRAM_ID,
      }),
    ).toMatchObject({ kind: "PUBLISHED" });
    const [updateClaim] = await claimNotificationDeliveries(ctx.db, 1);
    let editedMessageId: string | null = null;
    await processNotificationDeliveryClaim(ctx.db, updateClaim!, {
      send: async (input) => {
        editedMessageId = input.messageId;
        return { chatId: input.chatId, messageId: "telegram-101" };
      },
    });
    expect(editedMessageId).toBe("telegram-101");
    const campaign = await sql<{
      content: string;
    }>`select content from notification_campaign where id = ${`admin-payment-settled:${orderId}`}`.execute(
      ctx.db,
    );
    expect(campaign.rows[0]?.content).toContain("Đã hoàn tất");
  });
  it("G. an ambiguous paid manual alert leaves exactly one task visible in the owner queue", async () => {
    const { orderId } = await seedFixture();
    const amount = await prepareManualOrder(orderId);
    await settleManualOrder(orderId, amount);
    await handleNotificationOutboxEvent(ctx.db, event("PaymentSettled", orderId), {
      rootTelegramUserId: ROOT_TELEGRAM_ID,
    });
    const [claim] = await claimNotificationDeliveries(ctx.db, 1);
    expect(claim).toBeDefined();
    const alertOutcome = await processNotificationDeliveryClaim(ctx.db, claim!, {
      send: async () => {
        throw new Error("provider timed out after request submission");
      },
    });
    expect(alertOutcome).toBe("SEND_UNCERTAIN");
    expect(await claimNotificationDeliveries(ctx.db, 1)).toEqual([]);

    const fulfill = fulfillmentOutboxHandler();
    const first = await fulfill(paidOrderEvent(orderId, "manual-alert-uncertain"));
    const replay = await fulfill(paidOrderEvent(orderId, "manual-alert-uncertain-replay"));
    const queue = await listAdminManualFulfillmentTasks(ctx.db);
    const state = await sql<{
      tasks: number;
      task_status: string;
      order_status: string;
      alert_status: string;
    }>`
      select
        (select count(*)::int from manual_fulfillment_task where order_id = ${orderId}) as tasks,
        (select status from manual_fulfillment_task where order_id = ${orderId} limit 1) as task_status,
        (select status from "order" where id = ${orderId}) as order_status,
        (select status from notification_delivery where id = ${claim!.id}) as alert_status
    `.execute(ctx.db);

    expect(first).toEqual({ kind: "PUBLISHED" });
    expect(replay).toEqual({ kind: "PUBLISHED" });
    expect(queue.tasks.map((task) => task.orderId)).toEqual([orderId]);
    expect(state.rows[0]).toEqual({
      tasks: 1,
      task_status: "OPEN",
      order_status: "PROCESSING",
      alert_status: "SEND_UNCERTAIN",
    });
  });

  it("H. duplicate PaymentSettled events keep one manual task and one logical owner alert", async () => {
    const { orderId } = await seedFixture();
    const amount = await prepareManualOrder(orderId);
    await settleManualOrder(orderId, amount);

    for (let attempt = 0; attempt < 2; attempt += 1) {
      expect(
        await handleNotificationOutboxEvent(ctx.db, event("PaymentSettled", orderId), {
          rootTelegramUserId: ROOT_TELEGRAM_ID,
        }),
      ).toMatchObject({ kind: "PUBLISHED" });
    }
    const fulfill = fulfillmentOutboxHandler();
    expect(await fulfill(paidOrderEvent(orderId, "manual-duplicate-settlement"))).toEqual({
      kind: "PUBLISHED",
    });
    expect(await fulfill(paidOrderEvent(orderId, "manual-duplicate-settlement-replay"))).toEqual({
      kind: "PUBLISHED",
    });

    const taskCount = await sql<{ count: number }>`
      select count(*)::int as count from manual_fulfillment_task where order_id = ${orderId}
    `.execute(ctx.db);
    const alerts = await sql<{ campaign_id: string; deliveries: number }>`
      select c.id as campaign_id, count(d.id)::int as deliveries
      from notification_campaign c
      left join notification_delivery d on d.campaign_id = c.id
      where c.id = ${`admin-payment-settled:${orderId}`}
      group by c.id
    `.execute(ctx.db);
    const queue = await listAdminManualFulfillmentTasks(ctx.db);

    expect(taskCount.rows[0]?.count).toBe(1);
    expect(queue.tasks.map((task) => task.orderId)).toEqual([orderId]);
    expect(alerts.rows).toEqual([
      { campaign_id: `admin-payment-settled:${orderId}`, deliveries: 1 },
    ]);
  });
  it("does not refresh a sent admin payment alert on fulfillment completion when mode is OFF", async () => {
    const { orderId } = await seedFixture();
    await handleNotificationOutboxEvent(ctx.db, event("PaymentSettled", orderId), {
      rootTelegramUserId: ROOT_TELEGRAM_ID,
    });
    const [claim] = await claimNotificationDeliveries(ctx.db, 1);
    await processNotificationDeliveryClaim(ctx.db, claim!, {
      send: async (input) => {
        expect(input.messageId).toBeNull();
        return { chatId: input.chatId, messageId: "telegram-202" };
      },
    });
    const before = await sql<{ content: string; status: string; message_id: string }>`
      select c.content, d.status, d.message_id
      from notification_campaign c
      join notification_delivery d on d.campaign_id = c.id
      where c.id = ${`admin-payment-settled:${orderId}`}
    `.execute(ctx.db);
    expect(before.rows[0]).toMatchObject({ status: "SENT", message_id: "telegram-202" });
    expect(before.rows[0]?.content).not.toContain("Đã hoàn tất");

    await sql`update "order" set status = 'COMPLETED', completed_at = now(), version = 2 where id = ${orderId}`.execute(
      ctx.db,
    );
    expect(
      await handleNotificationOutboxEvent(ctx.db, event("FulfillmentCompleted", orderId), {
        rootTelegramUserId: ROOT_TELEGRAM_ID,
        adminAlertMode: "OFF",
      }),
    ).toMatchObject({ kind: "PUBLISHED" });

    const after = await sql<{ content: string; status: string; message_id: string }>`
      select c.content, d.status, d.message_id
      from notification_campaign c
      join notification_delivery d on d.campaign_id = c.id
      where c.id = ${`admin-payment-settled:${orderId}`}
    `.execute(ctx.db);
    expect(after.rows[0]).toEqual(before.rows[0]);
    expect(after.rows[0]).toMatchObject({ status: "SENT", message_id: "telegram-202" });
  });

  it("accepts exact canonical wallet purchase evidence for manual-order alerts", async () => {
    const { orderId, rootCustomerId } = await seedFixture();
    const amount = await prepareManualOrder(orderId);
    const order = await sql<{ customer_id: string }>`
      select customer_id from "order" where id = ${orderId}
    `.execute(ctx.db);
    const customerId = order.rows[0]!.customer_id;
    const wallet = createWalletLedgerService(ctx.db);

    await wallet.credit({
      customerId: rootCustomerId,
      amountVnd: BigInt(amount),
      idempotencyKey: `topup:wrong-customer:${orderId}`,
      correlationId: "wallet-alert-wrong-customer",
      reason: "test wallet funding",
    });
    await wallet.debit({
      customerId: rootCustomerId,
      amountVnd: BigInt(amount),
      idempotencyKey: `purchase:${orderId}:wrong-customer`,
      correlationId: "wallet-alert-wrong-customer",
      reason: "test wallet purchase",
    });
    await wallet.credit({
      customerId,
      amountVnd: BigInt(amount) * 2n,
      idempotencyKey: `topup:wrong-amount:${orderId}`,
      correlationId: "wallet-alert-wrong-amount",
      reason: "test wallet funding",
    });
    await wallet.debit({
      customerId,
      amountVnd: BigInt(amount) - 1n,
      idempotencyKey: `purchase:${orderId}:wrong-amount`,
      correlationId: "wallet-alert-wrong-amount",
      reason: "test wallet purchase",
    });
    await sql`update "order" set status = 'PAID', paid_at = now() where id = ${orderId}`.execute(
      ctx.db,
    );
    const taskCreated = event("ManualFulfillmentTaskCreated", orderId);
    await handleNotificationOutboxEvent(ctx.db, taskCreated, {
      rootTelegramUserId: ROOT_TELEGRAM_ID,
    });
    const unmatched = await sql<{ content: string }>`
      select content from notification_campaign
      where id = ${`admin-payment-settled:${orderId}`}
    `.execute(ctx.db);
    expect(unmatched.rows[0]?.content).toContain("⏳ Chưa xác nhận");

    await wallet.debit({
      customerId,
      amountVnd: BigInt(amount),
      idempotencyKey: `purchase:${orderId}:exact`,
      correlationId: "wallet-alert-exact",
      reason: "test wallet purchase",
    });
    await handleNotificationOutboxEvent(ctx.db, event("ManualFulfillmentTaskCreated", orderId), {
      rootTelegramUserId: ROOT_TELEGRAM_ID,
    });
    const matched = await sql<{ content: string }>`
      select content from notification_campaign
      where id = ${`admin-payment-settled:${orderId}`}
    `.execute(ctx.db);
    expect(matched.rows[0]?.content).toContain("Thanh toán: ✅ Ví đã ghi sổ");
    expect(matched.rows[0]?.content).not.toContain("SePay đã xác minh");
  });

  it("keeps a manual alert unpaid when wallet purchase postings are noncanonical", async () => {
    const { orderId } = await seedFixture();
    const amount = await prepareManualOrder(orderId);
    const order = await sql<{ customer_id: string }>`
      select customer_id from "order" where id = ${orderId}
    `.execute(ctx.db);
    const customerId = order.rows[0]!.customer_id;
    const wallet = createWalletLedgerService(ctx.db);
    await wallet.credit({
      customerId,
      amountVnd: BigInt(amount),
      idempotencyKey: `topup:noncanonical:${orderId}`,
      correlationId: "wallet-alert-noncanonical",
      reason: "test wallet funding",
    });
    await wallet.debit({
      customerId,
      amountVnd: BigInt(amount),
      idempotencyKey: `purchase:${orderId}:noncanonical`,
      correlationId: "wallet-alert-noncanonical",
      reason: "test wallet purchase",
    });
    const transaction = await sql<{ id: string }>`
      select lt.id
      from wallet_ledger wl
      join ledger_transaction lt on lt.idempotency_key = 'wallet_ledger:' || wl.id
      where wl.idempotency_key = ${`purchase:${orderId}:noncanonical`}
    `.execute(ctx.db);
    const transactionId = transaction.rows[0]!.id;
    await sql`
      insert into ledger_posting (id, transaction_id, account_id, side, amount_minor)
      select ${newId()}, ${transactionId}, id, 'DEBIT', cast(${amount} as bigint)
      from ledger_account where code = 'SHOP:ADJUSTMENT_EXPENSE'
      union all
      select ${newId()}, ${transactionId}, id, 'CREDIT', cast(${amount} as bigint)
      from ledger_account where code = 'SHOP:ADJUSTMENT_INCOME'
    `.execute(ctx.db);
    await sql`update "order" set status = 'PAID', paid_at = now() where id = ${orderId}`.execute(
      ctx.db,
    );

    await handleNotificationOutboxEvent(ctx.db, event("ManualFulfillmentTaskCreated", orderId), {
      rootTelegramUserId: ROOT_TELEGRAM_ID,
    });
    const campaign = await sql<{ content: string }>`
      select content from notification_campaign
      where id = ${`admin-payment-settled:${orderId}`}
    `.execute(ctx.db);
    expect(campaign.rows[0]?.content).toContain("Thanh toán: ⏳ Chưa xác nhận");
    expect(campaign.rows[0]?.content).not.toContain("Ví đã ghi sổ");
  });

  it("keeps a manual alert unpaid when the SePay merchant account does not match", async () => {
    const { orderId } = await seedFixture();
    const amount = await prepareManualOrder(orderId);
    await settleManualOrder(orderId, amount);
    await sql`
      update bank_transaction
      set merchant_account_id = 'OTHER-ACCOUNT'
      where provider_transaction_id like 'manual-%'
    `.execute(ctx.db);

    await handleNotificationOutboxEvent(ctx.db, event("PaymentSettled", orderId), {
      rootTelegramUserId: ROOT_TELEGRAM_ID,
    });
    const campaign = await sql<{ content: string }>`
      select content from notification_campaign
      where id = ${`admin-payment-settled:${orderId}`}
    `.execute(ctx.db);
    expect(campaign.rows[0]?.content).toContain("Thanh toán: ⏳ Chưa xác nhận");
    expect(campaign.rows[0]?.content).not.toContain("SePay đã xác minh");
  });

  it("edits an in-flight manual alert with the latest verified settlement", async () => {
    const { orderId, rootCustomerId } = await seedFixture();
    const amount = await prepareManualOrder(orderId);
    const created = event("OrderCreated", orderId);
    expect(
      await handleNotificationOutboxEvent(ctx.db, created, {
        rootTelegramUserId: ROOT_TELEGRAM_ID,
      }),
    ).toMatchObject({ kind: "PUBLISHED" });
    expect(
      await handleNotificationOutboxEvent(ctx.db, created, {
        rootTelegramUserId: ROOT_TELEGRAM_ID,
      }),
    ).toMatchObject({ kind: "PUBLISHED" });

    const unpaid = await sql<{ content: string }>`
      select content from notification_campaign
      where id = ${`admin-payment-settled:${orderId}`}
    `.execute(ctx.db);
    expect(unpaid.rows[0]?.content).toContain("Chưa xác nhận");
    expect(unpaid.rows[0]?.content).toContain("ORD-ALERT-1");
    expect(unpaid.rows[0]?.content).not.toContain(orderId);
    expect(unpaid.rows[0]?.content).not.toContain("Mã khách");

    const recipients = await sql<{ customer_id: string; chat_id: string }>`
      select customer_id, chat_id from notification_delivery
      where campaign_id = ${`admin-payment-settled:${orderId}`}
    `.execute(ctx.db);
    expect(recipients.rows).toEqual([
      { customer_id: rootCustomerId, chat_id: String(ROOT_TELEGRAM_ID) },
    ]);

    const [initialClaim] = await claimNotificationDeliveries(ctx.db, 1);
    let notifyFirstSendStarted!: () => void;
    let releaseFirstSend!: (response: unknown) => void;
    const firstSendStarted = new Promise<void>((resolve) => {
      notifyFirstSendStarted = resolve;
    });
    const firstSendResponse = new Promise<unknown>((resolve) => {
      releaseFirstSend = resolve;
    });
    let firstMessageId: string | null = null;
    let firstContent = "";
    const firstSend = processNotificationDeliveryClaim(ctx.db, initialClaim!, {
      send: async (input) => {
        firstMessageId = input.messageId;
        firstContent = input.message.text;
        notifyFirstSendStarted();
        return firstSendResponse;
      },
    });
    await firstSendStarted;
    expect(firstMessageId).toBeNull();
    expect(firstContent).toContain("Chưa xác nhận");

    await settleManualOrder(orderId, amount);
    expect(
      await handleNotificationOutboxEvent(ctx.db, event("PaymentSettled", orderId), {
        rootTelegramUserId: ROOT_TELEGRAM_ID,
      }),
    ).toMatchObject({ kind: "PUBLISHED" });
    // A replayed creation event must read canonical paid state, not restore unpaid copy.
    expect(
      await handleNotificationOutboxEvent(ctx.db, created, {
        rootTelegramUserId: ROOT_TELEGRAM_ID,
      }),
    ).toMatchObject({ kind: "PUBLISHED" });

    const paid = await sql<{ content: string; count: string }>`
      select c.content, count(d.id)::text as count
      from notification_campaign c
      join notification_delivery d on d.campaign_id = c.id
      where c.id = ${`admin-payment-settled:${orderId}`}
      group by c.content
    `.execute(ctx.db);
    expect(paid.rows[0]?.content).toContain("SePay đã xác minh");
    expect(paid.rows[0]?.content).not.toContain("Chưa xác nhận");
    expect(paid.rows[0]?.count).toBe("1");

    releaseFirstSend({
      chatId: String(ROOT_TELEGRAM_ID),
      messageId: "owner-manual-alert-1",
    });
    expect(await firstSend).toBe("RETRY");

    const afterStaleSend = await sql<{
      content: string;
      status: string;
      message_id: string;
      count: string;
    }>`
      select c.content, d.status, d.message_id, count(*) over ()::text as count
      from notification_campaign c
      join notification_delivery d on d.campaign_id = c.id
      where c.id = ${`admin-payment-settled:${orderId}`}
    `.execute(ctx.db);
    expect(afterStaleSend.rows).toHaveLength(1);
    expect(afterStaleSend.rows[0]?.content).toContain("SePay đã xác minh");
    expect(afterStaleSend.rows[0]?.count).toBe("1");
    expect(afterStaleSend.rows[0]?.status).toBe("RETRY");
    expect(afterStaleSend.rows[0]?.message_id).toBe("owner-manual-alert-1");
    const campaigns = await sql`
      select id from notification_campaign
      where id = ${`admin-payment-settled:${orderId}`}
    `.execute(ctx.db);
    expect(campaigns.rows).toHaveLength(1);

    const [updateClaim] = await claimNotificationDeliveries(ctx.db, 1);
    let editedMessageId: string | null = null;
    let editedContent = "";
    expect(
      await processNotificationDeliveryClaim(ctx.db, updateClaim!, {
        send: async (input) => {
          editedMessageId = input.messageId;
          editedContent = input.message.text;
          return { chatId: input.chatId, messageId: "owner-manual-alert-1" };
        },
      }),
    ).toBe("SENT");
    expect(editedMessageId).toBe("owner-manual-alert-1");
    expect(editedContent).toContain("SePay đã xác minh");
    expect(editedContent).not.toContain("Chưa xác nhận");
  });

  it("refreshes an in-flight owner alert only after its first Telegram identity is persisted", async () => {
    const { orderId } = await seedFixture();
    const amount = await prepareManualOrder(orderId);
    await handleNotificationOutboxEvent(ctx.db, event("OrderCreated", orderId), {
      rootTelegramUserId: ROOT_TELEGRAM_ID,
    });

    const [initialClaim] = await claimNotificationDeliveries(ctx.db, 1);
    let notifySendStarted!: () => void;
    let releaseSend!: (response: unknown) => void;
    const sendStarted = new Promise<void>((resolve) => {
      notifySendStarted = resolve;
    });
    const sendResponse = new Promise<unknown>((resolve) => {
      releaseSend = resolve;
    });
    const firstSend = processNotificationDeliveryClaim(ctx.db, initialClaim!, {
      send: async () => {
        notifySendStarted();
        return sendResponse;
      },
    });
    await sendStarted;

    await settleManualOrder(orderId, amount);
    await handleNotificationOutboxEvent(ctx.db, event("PaymentSettled", orderId), {
      rootTelegramUserId: ROOT_TELEGRAM_ID,
    });

    const uncertain = await sql<{
      status: string;
      claim_generation: string;
      claimed_by: string | null;
      claim_expires_at: string | null;
      message_id: string | null;
    }>`
      select status, claim_generation::text, claimed_by, claim_expires_at::text, message_id
      from notification_delivery where id = ${initialClaim!.id}
    `.execute(ctx.db);
    expect(uncertain.rows[0]).toEqual({
      status: "SEND_UNCERTAIN",
      claim_generation: String(initialClaim!.generation),
      claimed_by: null,
      claim_expires_at: null,
      message_id: null,
    });
    expect(await claimNotificationDeliveries(ctx.db, 1)).toEqual([]);

    releaseSend({
      chatId: String(ROOT_TELEGRAM_ID),
      messageId: "owner-manual-late-ack",
    });
    expect(await firstSend).toBe("RETRY");
    const afterLateAck = await sql<{
      status: string;
      claim_generation: string;
      claimed_by: string | null;
      claim_expires_at: string | null;
      message_id: string | null;
    }>`
      select status, claim_generation::text, claimed_by, claim_expires_at::text, message_id
      from notification_delivery where id = ${initialClaim!.id}
    `.execute(ctx.db);
    expect(afterLateAck.rows[0]).toEqual({
      status: "RETRY",
      claim_generation: String(initialClaim!.generation),
      claimed_by: null,
      claim_expires_at: null,
      message_id: "owner-manual-late-ack",
    });

    const [refreshedClaim] = await claimNotificationDeliveries(ctx.db, 1);
    expect(refreshedClaim!.generation).toBeGreaterThan(initialClaim!.generation);
    let editedMessageId: string | null = null;
    let editedContent = "";
    expect(
      await processNotificationDeliveryClaim(ctx.db, refreshedClaim!, {
        send: async (input) => {
          editedMessageId = input.messageId;
          editedContent = input.message.text;
          return { chatId: input.chatId, messageId: "owner-manual-late-ack" };
        },
      }),
    ).toBe("SENT");
    expect(editedMessageId).toBe("owner-manual-late-ack");
    expect(editedContent).toContain("SePay đã xác minh");
    expect(editedContent).not.toContain("Chưa xác nhận");

    await sql`
      update "order" set status = 'COMPLETED', completed_at = now(), version = version + 1
      where id = ${orderId}
    `.execute(ctx.db);
    await handleNotificationOutboxEvent(ctx.db, event("ManualFulfillmentTaskCompleted", orderId), {
      rootTelegramUserId: ROOT_TELEGRAM_ID,
    });

    const [completionClaim] = await claimNotificationDeliveries(ctx.db, 1);
    let completionMessageId: string | null = null;
    let completionContent = "";
    expect(
      await processNotificationDeliveryClaim(ctx.db, completionClaim!, {
        send: async (input) => {
          completionMessageId = input.messageId;
          completionContent = input.message.text;
          return { chatId: input.chatId, messageId: "owner-manual-late-ack" };
        },
      }),
    ).toBe("SENT");
    expect(completionMessageId).toBe("owner-manual-late-ack");
    expect(completionContent).toContain("✅ Đã hoàn tất");
    expect(await claimNotificationDeliveries(ctx.db, 1)).toEqual([]);
  });

  it("does not create or refresh manual alerts when admin alert mode is OFF", async () => {
    const { orderId } = await seedFixture();
    const amount = await prepareManualOrder(orderId);
    const created = event("OrderCreated", orderId);
    expect(
      await handleNotificationOutboxEvent(ctx.db, created, {
        rootTelegramUserId: ROOT_TELEGRAM_ID,
        adminAlertMode: "OFF",
      }),
    ).toMatchObject({ kind: "PUBLISHED" });
    const suppressed = await sql`
      select id from notification_campaign where id = ${`admin-payment-settled:${orderId}`}
    `.execute(ctx.db);
    expect(suppressed.rows).toHaveLength(0);
    const noDelivery = await sql`
      select id from notification_delivery
      where campaign_id = ${`admin-payment-settled:${orderId}`}
    `.execute(ctx.db);
    expect(noDelivery.rows).toHaveLength(0);

    expect(
      await handleNotificationOutboxEvent(ctx.db, created, {
        rootTelegramUserId: ROOT_TELEGRAM_ID,
      }),
    ).toMatchObject({ kind: "PUBLISHED" });
    const original = await sql<{ content: string }>`
      select content from notification_campaign
      where id = ${`admin-payment-settled:${orderId}`}
    `.execute(ctx.db);
    expect(original.rows[0]?.content).toContain("Chưa xác nhận");

    await settleManualOrder(orderId, amount);
    expect(
      await handleNotificationOutboxEvent(ctx.db, event("PaymentSettled", orderId), {
        rootTelegramUserId: ROOT_TELEGRAM_ID,
        adminAlertMode: "OFF",
      }),
    ).toMatchObject({ kind: "PUBLISHED" });
    const unchanged = await sql<{ content: string; count: string; status: string }>`
      select c.content, count(d.id)::text as count, d.status
      from notification_campaign c
      join notification_delivery d on d.campaign_id = c.id
      where c.id = ${`admin-payment-settled:${orderId}`}
      group by c.content, d.status
    `.execute(ctx.db);
    expect(unchanged.rows[0]?.content).toBe(original.rows[0]?.content);
    expect(unchanged.rows[0]?.count).toBe("1");
    expect(unchanged.rows[0]?.status).toBe("PENDING");
  });
});
