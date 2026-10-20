import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { newId } from "../../src/shared/ids/index.js";
import { createHistoryCallbacks } from "../../src/bot/callbacks/history.js";
import { createSupportCallbacks } from "../../src/bot/callbacks/support.js";
import { createTelegramDomainDispatcher } from "../../src/bot/callbacks/telegram-dispatch.js";
import { createCallbackTokenCodec } from "../../src/bot/callback-codec.js";
import { sealPresentedMessageCallbacks } from "../../src/bot/callback-sealer.js";
import { createSupportService } from "../../src/modules/support/service.js";
import { startPostgresContainer, type PgTestContext } from "../helpers/pg-container.js";

/**
 * T083 — History-to-support acceptance journey (User Story 4).
 *
 * Alice and Bob each have Orders. Alice opens history (sees only hers), opens a
 * detail, and creates a structured support ticket linked to her Order. Bob's
 * Orders never surface. The ticket stores a safe summary without a secret.
 */

let ctx: PgTestContext;

beforeAll(async () => {
  ctx = await startPostgresContainer();
}, 180_000);

afterAll(async () => {
  await ctx?.teardown();
});

interface Seeded {
  aliceId: string;
  bobId: string;
  aliceOrderNumber: string;
  aliceOrderId: string;
  variantId: string;
  bobOrderNumber: string;
  bobOrderId: string;
}

async function seedTwoCustomers(): Promise<Seeded> {
  const aliceId = newId();
  const bobId = newId();
  const categoryId = newId();
  const productId = newId();
  const variantId = newId();

  const aliceOrderId = newId();
  const bobOrderId = newId();
  const paymentIntentId = newId();
  const bankTransactionId = newId();
  const allocationId = newId();
  const aliceOrderNumber = "ORD-ALICE-" + aliceOrderId.slice(-6);
  const bobOrderNumber = "ORD-BOB-" + bobOrderId.slice(-6);
  const slug = categoryId.slice(-8);

  await sql`insert into customer (id, status, locale) values (${aliceId}, 'ACTIVE', 'vi')`.execute(
    ctx.db,
  );
  await sql`insert into customer (id, status, locale) values (${bobId}, 'ACTIVE', 'vi')`.execute(
    ctx.db,
  );
  await sql`insert into category (id, name_vi, slug, is_active, sort_order) values (${categoryId}, 'C', ${slug}, true, 1)`.execute(
    ctx.db,
  );
  await sql`insert into product (id, category_id, name_vi, slug, is_active, sort_order) values (${productId}, ${categoryId}, 'Netflix', ${slug}, true, 1)`.execute(
    ctx.db,
  );
  await sql`
    insert into product_variant
      (id, product_id, sku, name_vi, price_vnd, duration_code, delivery_type, stock_policy,
       resale_evidence_id, warranty_days, warranty_enabled)
    values
      (${variantId}, ${productId}, ${"SKU-" + variantId}, 'Premium 1 tháng', 199000, 'P1M',
       'CREDENTIAL', 'LOCAL_ONLY', 'RES-1', 30, true)
  `.execute(ctx.db);
  await sql`
    insert into "order" (id, order_number, customer_id, variant_id, product_name_vi, variant_name_vi,
      price_vnd, duration_code, delivery_type, status, paid_at, warranty_days, completed_at)
    values (${aliceOrderId}, ${aliceOrderNumber}, ${aliceId}, ${variantId}, 'Netflix', 'Premium 1 tháng',
      199000, 'P1M', 'CREDENTIAL', 'COMPLETED', now(), 30, now() - interval '3 hours')
  `.execute(ctx.db);
  await sql`
    insert into bank_transaction
      (id, provider, provider_transaction_id, direction, merchant_account_id,
       amount_vnd, content, transacted_at, raw_hash, signature_status, schema_version)
    values
      (${bankTransactionId}, 'sepay', ${`TX-${bankTransactionId}`}, 'IN', 'JOURNEY-TEST',
       199000, ${aliceOrderNumber}, now(), ${`HASH-${bankTransactionId}`}, 'VERIFIED', 'sepay.v1')
  `.execute(ctx.db);
  await sql`
    insert into payment_intent
      (id, order_id, status, amount_vnd, merchant_account_id, transfer_content, expires_at,
       presented_at, settled_at)
    values
      (${paymentIntentId}, ${aliceOrderId}, 'SUCCEEDED', 199000, 'JOURNEY-TEST',
       ${aliceOrderNumber}, now() + interval '1 hour', now(), now())
  `.execute(ctx.db);
  await sql`
    insert into payment_allocation
      (id, bank_transaction_id, payment_intent_id, allocated_amount_vnd, status,
       decision_code, correlation_id)
    values
      (${allocationId}, ${bankTransactionId}, ${paymentIntentId}, 199000, 'SETTLED',
       'TEST_EXACT', 'support-journey')
  `.execute(ctx.db);
  await sql`
    insert into digital_asset
      (id, variant_id, source_type, vault_ref, fingerprint_hash, status, delivered_order_id)
    values
      (${newId()}, ${variantId}, 'LOCAL', 'vault:alice-original', 'fp-alice-original', 'DELIVERED', ${aliceOrderId})
  `.execute(ctx.db);
  await sql`
    insert into "order" (id, order_number, customer_id, variant_id, product_name_vi, variant_name_vi,
      price_vnd, duration_code, delivery_type, status)
    values (${bobOrderId}, ${bobOrderNumber}, ${bobId}, ${variantId}, 'Netflix', 'Premium 1 tháng',
      199000, 'P1M', 'CREDENTIAL', 'PENDING_PAYMENT')
  `.execute(ctx.db);

  return {
    aliceId,
    bobId,
    aliceOrderNumber,
    aliceOrderId,
    bobOrderNumber,
    bobOrderId,
    variantId,
  };
}

beforeEach(async () => {
  await sql`
    truncate table support_ticket, delivery_bundle, digital_asset, order_transition, outbox_event,
      "order", product_variant, product, category, customer cascade
  `.execute(ctx.db);
});

describe("US4 history → support journey", () => {
  it("Alice sees only her orders and opens a structured ticket without a secret", async () => {
    const seed = await seedTwoCustomers();
    const history = createHistoryCallbacks({ db: ctx.db });
    const support = createSupportCallbacks({ db: ctx.db });

    // 1. History: Alice sees only her order.
    const list = await history.list(seed.aliceId);
    expect(list.text).toContain(seed.aliceOrderNumber);
    expect(list.text).not.toContain(seed.bobOrderNumber);

    // 2. Detail: Alice can open her own order.
    const detail = await history.detail(seed.aliceOrderNumber, seed.aliceId);
    expect(detail.text).toContain(seed.aliceOrderNumber);
    expect(detail.text).toContain("Hoàn tất");
    // Support affordance is present.
    expect(detail.buttons.flat().some((b) => b.callbackData.startsWith("sup:open:"))).toBe(true);

    // 3. BOLA: Alice cannot open Bob's order by number.
    const bobAsAlice = await history.detail(seed.bobOrderNumber, seed.aliceId);
    expect(bobAsAlice.text.toLowerCase()).toMatch(/không|sở hữu|tìm thấy/);

    // 3b. Callback tokens can only carry the internal order id (the callback codec encodes
    // ULIDs, not the public order number), so opening a detail from the history list must
    // work when given the id.
    const byId = await history.detail(seed.aliceOrderId, seed.aliceId);
    expect(byId.text).toContain(seed.aliceOrderNumber);
    const bobById = await history.detail(seed.bobOrderId, seed.aliceId);
    // Owner-scoped lookup: a foreign order reads exactly like a missing one.
    expect(bobById.text).toMatch(/không tìm thấy đơn hàng/i);

    // 4. Structured ticket open linked to Alice's order.
    const ticket = await support.open({
      customerId: seed.aliceId,
      reasonCode: "ASSET_NOT_WORKING",
      orderNumber: seed.aliceOrderNumber,
      description: "Tài khoản báo lỗi đăng nhập. user:pass-SHOULD-NOT-STORE",
      correlationId: "journey-1",
    });
    expect(ticket.text).toContain("ticket");
    expect(ticket.text).toContain(seed.aliceOrderNumber);
    // No secret in the confirmation message.
    expect(ticket.text).not.toContain("SHOULD-NOT-STORE");

    // 5. Ticket row is safe + owned.
    const rows = await sql<{
      id: string;
      customer_id: string;
      order_id: string | null;
      safe_summary: string;
      replacement_case_id: string | null;
    }>`
      select st.id, st.customer_id, st.order_id, st.safe_summary, rc.id as replacement_case_id
      from support_ticket st
      left join replacement_case rc on rc.order_id = st.order_id
    `.execute(ctx.db);
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]?.customer_id).toBe(seed.aliceId);
    expect(rows.rows[0]?.order_id).toBe(seed.aliceOrderId);
    expect(rows.rows[0]?.safe_summary).not.toContain("SHOULD-NOT-STORE");
    expect(rows.rows[0]?.replacement_case_id).toBeTruthy();

    const ticketId = rows.rows[0]?.id;
    expect(ticketId).toBeDefined();
    if (!ticketId) return;

    // 6. Alice can discover her ticket, then open a customer-safe detail.
    const aliceTickets = await support.list(seed.aliceId);
    expect(aliceTickets.text).toContain("📋 Ticket của bạn");
    expect(aliceTickets.text).toContain("Tài khoản không dùng được");
    expect(aliceTickets.text).toContain("Mở");
    expect(aliceTickets.buttons.flat().some((b) => b.callbackData === `sup:view:${ticketId}`)).toBe(
      true,
    );

    const aliceTicketDetail = await support.view(ticketId, seed.aliceId);
    expect(aliceTicketDetail.text).toContain("Trạng thái: Mở");
    expect(aliceTicketDetail.text).toContain("Nội dung: Tài khoản báo lỗi đăng nhập. [đã ẩn]");
    expect(aliceTicketDetail.text).toContain(seed.aliceOrderNumber);
    expect(aliceTicketDetail.text).not.toContain("ASSET_NOT_WORKING");
    expect(aliceTicketDetail.text).not.toContain(seed.aliceOrderId);
    expect(aliceTicketDetail.text).not.toContain("SHOULD-NOT-STORE");

    // 7. Customer scoping keeps Alice's ticket and summary private from Bob.
    const bobTickets = await support.list(seed.bobId);
    expect(bobTickets.text).toContain("Bạn chưa có ticket hỗ trợ nào.");
    expect(bobTickets.text).not.toContain("Tài khoản báo lỗi đăng nhập");
    expect(bobTickets.text).not.toContain(seed.aliceOrderNumber);

    const aliceTicketAsBob = await support.view(ticketId, seed.bobId);
    expect(aliceTicketAsBob.text).toContain("Không tìm thấy ticket.");
    expect(aliceTicketAsBob.text).not.toContain("Tài khoản báo lỗi đăng nhập");
    expect(aliceTicketAsBob.text).not.toContain(seed.aliceOrderNumber);
  });
  it("routes sealed support callbacks and refuses a stale close after status changes", async () => {
    const seed = await seedTwoCustomers();
    const support = createSupportCallbacks({ db: ctx.db });
    const codec = createCallbackTokenCodec({
      key: "test-only-support-callback-key-material-123456",
      keyVersion: 1,
      ttlSeconds: 900,
      clockSkewSeconds: 5,
    });
    const messages: string[] = [];
    const screen = async () => ({ text: "home", buttons: [] });
    const dispatcher = createTelegramDomainDispatcher({
      codec,
      resolveCustomerId: async (telegramUserId) =>
        telegramUserId === "700000001"
          ? seed.aliceId
          : telegramUserId === "700000002"
            ? seed.bobId
            : null,
      resolveOrderByIdForOwner: async () => null,
      resolveOrderIdByNumber: async () => null,
      resolveCatalogPage: async () => null,
      catalog: {
        mainMenu: screen,
        categoryList: screen,
        categoryView: screen,
        variantDetail: screen,
        search: screen,
      },
      checkout: {
        buyNowFromCallback: screen,
        refresh: screen,
        reopen: screen,
        cancel: screen,
      },
      history: { list: screen, detail: screen },
      support,
      responder: {
        ack: async () => {},
        send: async ({ message }) => {
          messages.push(message.text);
          return null;
        },
      },
    });
    const dispatch = (callbackData: string, actorUserId: string, updateId: number) =>
      dispatcher.handle({
        actorUserId,
        chatId: actorUserId,
        chatType: "private",
        messageId: String(updateId),
        action: "CATALOG",
        callbackData,
        callbackQueryId: `support-${updateId}`,
      });

    const opened = await support.open({
      customerId: seed.aliceId,
      reasonCode: "GENERAL_QUESTION",
      description: "Cần hỗ trợ",
      correlationId: "callback-route-open",
    });
    const rows = await sql<{ id: string }>`
      select id from support_ticket where customer_id = ${seed.aliceId} order by created_at desc limit 1
    `.execute(ctx.db);
    const ticketId = rows.rows[0]?.id;
    expect(opened.text).toContain("ticket");
    expect(ticketId).toBeDefined();
    if (!ticketId) return;

    await dispatch(
      codec.issue({ action: "SUPPORT_TICKET_LIST", telegramUserId: "700000001" }),
      "700000001",
      1,
    );
    expect(messages.at(-1)).toContain("Ticket của bạn");

    await dispatch(
      codec.issue({
        action: "SUPPORT_TICKET_VIEW",
        resourceId: ticketId,
        telegramUserId: "700000001",
      }),
      "700000001",
      2,
    );
    expect(messages.at(-1)).toContain("Trạng thái: Mở");

    await sql`update support_ticket set status = 'RESOLVED' where id = ${ticketId}`.execute(ctx.db);
    const staleClose = codec.issue({
      action: "SUPPORT_TICKET_CLOSE",
      resourceId: ticketId,
      telegramUserId: "700000001",
    });
    await sql`update support_ticket set status = 'OPEN' where id = ${ticketId}`.execute(ctx.db);
    const staleResult = await createSupportService(ctx.db).closeTicket({
      ticketId,
      customerId: seed.aliceId,
      correlationId: "stale-close",
    });
    expect(staleResult).toEqual({
      ok: false,
      code: "NOT_FOUND",
      message: "Không tìm thấy ticket.",
    });

    const bobClose = codec.issue({
      action: "SUPPORT_TICKET_CLOSE",
      resourceId: ticketId,
      telegramUserId: "700000002",
    });
    await dispatch(bobClose, "700000002", 3);
    const stillOpen = await sql<{ status: string }>`
      select status from support_ticket where id = ${ticketId}
    `.execute(ctx.db);
    expect(stillOpen.rows[0]?.status).toBe("OPEN");

    await sql`update support_ticket set status = 'RESOLVED' where id = ${ticketId}`.execute(ctx.db);
    await dispatch(staleClose, "700000001", 4);
    expect(messages.at(-1)).toContain("Đã đóng ticket hỗ trợ");
    const closed = await sql<{ status: string }>`
      select status from support_ticket where id = ${ticketId}
    `.execute(ctx.db);
    expect(closed.rows[0]?.status).toBe("CLOSED");
  });
  it("renders selected-order warranty state and seals the report action to that order", async () => {
    const seed = await seedTwoCustomers();
    const history = createHistoryCallbacks({ db: ctx.db });
    const codec = createCallbackTokenCodec({
      key: "test-only-customer-warranty-callback-key-material-123456",
      keyVersion: 1,
      ttlSeconds: 900,
      clockSkewSeconds: 5,
    });

    const detail = await history.detail(seed.aliceOrderNumber, seed.aliceId);
    expect(detail.text).toMatch(/Bảo hành đến: \d{1,2}\/\d{1,2}\/\d{4}/);
    expect(detail.text).toContain("Đã sử dụng: 0 ngày");
    expect(detail.text).toContain("Còn bảo hành: 30 ngày");

    const sealed = await sealPresentedMessageCallbacks(detail, {
      codec,
      telegramUserId: "700000001",
      resolveOrderId: async (orderNumber) =>
        orderNumber === seed.aliceOrderNumber ? seed.aliceOrderId : null,
    });
    const report = sealed.buttons.flat().find((button) => button.callbackData?.startsWith("cb:"));
    expect(report).toBeDefined();
    const reportToken = codec.verify(report?.callbackData ?? "", {
      telegramUserId: "700000001",
    });
    expect(reportToken).toMatchObject({
      ok: true,
      value: { action: "WARRANTY_REPORT", resourceId: seed.aliceOrderId },
    });
    expect(codec.verify(report?.callbackData ?? "", { telegramUserId: "700000002" })).toEqual({
      ok: false,
      code: "INVALID_SIGNATURE",
    });

    await sql`update "order" set status = 'REFUND_PENDING' where id = ${seed.aliceOrderId}`.execute(
      ctx.db,
    );
    const refundDetail = await history.detail(seed.aliceOrderNumber, seed.aliceId);
    expect(refundDetail.text).not.toContain("Bảo hành đến:");
    expect(
      refundDetail.buttons
        .flat()
        .some((button) => button.callbackData?.startsWith("warranty:report:")),
    ).toBe(false);
  });
  it("binds warranty reports to the selected order when a customer has two orders of one variant", async () => {
    const seed = await seedTwoCustomers();
    const secondOrderId = newId();
    const secondOrderNumber = "ORD-ALICE-" + secondOrderId.slice(-6);
    await sql`
      insert into "order" (id, order_number, customer_id, variant_id, product_name_vi, variant_name_vi,
        price_vnd, duration_code, delivery_type, status, paid_at, warranty_days, completed_at)
      values (${secondOrderId}, ${secondOrderNumber}, ${seed.aliceId}, ${seed.variantId}, 'Netflix',
        'Premium 1 tháng', 199000, 'P1M', 'CREDENTIAL', 'COMPLETED', now(),
        30, now() - interval '1 hour')
    `.execute(ctx.db);

    const history = createHistoryCallbacks({ db: ctx.db });
    const reportCallback = async (orderId: string) => {
      const detail = await history.detail(orderId, seed.aliceId);
      return detail.buttons
        .flat()
        .find((button) => button.callbackData?.startsWith("warranty:report:"))?.callbackData;
    };

    expect(await reportCallback(seed.aliceOrderId)).toBe(`warranty:report:${seed.aliceOrderId}`);
    expect(await reportCallback(secondOrderId)).toBe(`warranty:report:${secondOrderId}`);
  });
});
