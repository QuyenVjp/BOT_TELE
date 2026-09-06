import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { newId } from "../../src/shared/ids/index.js";
import { presentAdminCustomerFinancialDetail, queueAdminCustomerMessage } from "../../src/worker.js";
import { createWalletLedgerService } from "../../src/modules/wallet/ledger.js";
import { startPostgresContainer, type PgTestContext } from "../helpers/pg-container.js";

let ctx: PgTestContext;

beforeAll(async () => {
  ctx = await startPostgresContainer();
}, 180_000);

afterAll(async () => { await ctx?.teardown(); });

beforeEach(async () => {
  await sql`truncate table wallet_ledger, wallet_account, notification_delivery, notification_campaign, audit_event, customer_profile_snapshot, channel_identity, payment_intent, "order", product_variant, product, category, customer cascade`.execute(ctx.db);
});

async function seedCustomerDetail() {
  const customerId = newId();
  const categoryId = newId();
  const productId = newId();
  const variantId = newId();
  await sql`insert into customer (id, status, locale) values (${customerId}, 'ACTIVE', 'vi-VN')`.execute(ctx.db);
  await sql`insert into customer_profile_snapshot (customer_id, telegram_user_id, chat_id, username, display_name, reachable, phone_number, phone_shared_at) values (${customerId}, '10001', '10001', 'buyer', 'Buyer Name', true, '+84900000000', now())`.execute(ctx.db);
  await sql`insert into category (id, name_vi, slug, is_active, sort_order) values (${categoryId}, 'C', ${categoryId.slice(-8)}, true, 1)`.execute(ctx.db);
  await sql`insert into product (id, category_id, name_vi, slug, is_active, sort_order) values (${productId}, ${categoryId}, 'P', ${productId.slice(-8)}, true, 1)`.execute(ctx.db);
  await sql`insert into product_variant (id, product_id, sku, name_vi, price_vnd, duration_code, delivery_type, warranty_days, stock_policy, resale_evidence_id, is_active)
    values (${variantId}, ${productId}, ${"SKU-" + variantId.slice(-8)}, 'V', 100000, 'P1M', 'CREDENTIAL', 0, 'LOCAL_ONLY', 'RES-1', true)`.execute(ctx.db);

  const paidOrderId = newId();
  const pendingRefundOrderId = newId();
  const refundedOrderId = newId();
  await sql`insert into "order" (id, order_number, customer_id, variant_id, product_name_vi, variant_name_vi, price_vnd, duration_code, delivery_type, warranty_days, supplier_policy_snapshot, status, paid_at, created_at)
    values
      (${paidOrderId}, 'ORD-PAID', ${customerId}, ${variantId}, 'P', 'Paid', 100000, 'P1M', 'CREDENTIAL', 0, 'LOCAL_ONLY', 'PAID', now(), now() - interval '3 minutes'),
      (${pendingRefundOrderId}, 'ORD-REFUND-PENDING', ${customerId}, ${variantId}, 'P', 'Refund pending', 200000, 'P1M', 'CREDENTIAL', 0, 'LOCAL_ONLY', 'REFUND_PENDING', now(), now() - interval '2 minutes'),
      (${refundedOrderId}, 'ORD-REFUNDED', ${customerId}, ${variantId}, 'P', 'Refunded', 300000, 'P1M', 'CREDENTIAL', 0, 'LOCAL_ONLY', 'REFUNDED', now(), now() - interval '1 minute')`.execute(ctx.db);

  const wallet = createWalletLedgerService(ctx.db);
  await wallet.credit({ customerId, amountVnd: 500000n, idempotencyKey: "topup:seed", correlationId: "seed-credit", reason: "seed topup" });
  await wallet.debit({ customerId, amountVnd: 100000n, idempotencyKey: `purchase:${paidOrderId}:wallet`, correlationId: "seed-debit", reason: "wallet purchase" });
  await wallet.credit({ customerId, amountVnd: 50000n, idempotencyKey: `refund:${paidOrderId}`, correlationId: "seed-refund", reason: "partial refund" });
  return customerId;
}

describe("admin customer wallet detail", () => {

  it("reports missing customers", async () => {
    const detail = await presentAdminCustomerFinancialDetail(ctx.db, "missing-customer");

    expect(detail.text).toContain("Không tìm thấy khách hàng.");
    expect(detail.buttons).toEqual([[{ text: "Admin", callbackData: "admin:menu" }]]);
  });

  it("populates balance, recent order, ledger, and paid spending with refund semantics", async () => {
    const customerId = await seedCustomerDetail();

    const detail = await presentAdminCustomerFinancialDetail(ctx.db, customerId);

    expect(detail.text).toContain(`ID: ${customerId}`);
    expect(detail.text).toContain("Telegram: 10001 (@buyer)");
    expect(detail.text).toContain("SĐT: +84900000000");
    expect(detail.text).toContain("Tên hiển thị: Buyer Name");
    expect(detail.text).toContain("Có thể nhắn: có");
    expect(detail.text).toContain("Số dư ví: 450.000 ₫");
    expect(detail.text).toContain("Số đơn: 3");
    expect(detail.text).toContain("Tổng đã chi qua đơn đã thanh toán: 300.000 ₫");
    expect(detail.text).toContain("Hoàn tiền: đơn REFUNDED không tính vào tổng; REFUND_PENDING vẫn tính đến khi hoàn tất.");
    expect(detail.text).toContain("Chi ròng từ ví: 50.000 ₫");
    expect(detail.text).toContain("Đơn gần nhất: ORD-REFUNDED · REFUNDED · 300.000 ₫");
    expect(detail.text).toContain("CREDIT 50.000 ₫ · partial refund");
    expect(detail.text).toContain("DEBIT 100.000 ₫ · wallet purchase");
  });

  it("hides customer phone until Telegram contact consent is captured", async () => {
    const customerId = newId();
    await sql`insert into customer (id, status, locale) values (${customerId}, 'ACTIVE', 'vi-VN')`.execute(ctx.db);
    await sql`insert into customer_profile_snapshot (customer_id, telegram_user_id, chat_id, display_name, reachable, phone_number) values (${customerId}, '10002', '10002', 'No Consent', false, '+84900000001')`.execute(ctx.db);

    const detail = await presentAdminCustomerFinancialDetail(ctx.db, customerId);

    expect(detail.text).toContain("Tên hiển thị: No Consent");
    expect(detail.text).toContain("Có thể nhắn: không");
    expect(detail.text).toContain("SĐT: chưa chia sẻ");
    expect(detail.text).not.toContain("+84900000001");
  });

  it("queues direct admin messages only for reachable customer profile chat ids", async () => {
    const customerId = newId();
    const fallbackOnlyCustomerId = newId();
    await sql`insert into customer (id, status, locale) values (${customerId}, 'ACTIVE', 'vi-VN'), (${fallbackOnlyCustomerId}, 'ACTIVE', 'vi-VN')`.execute(ctx.db);
    await sql`insert into customer_profile_snapshot (customer_id, telegram_user_id, chat_id, display_name, reachable) values (${customerId}, '10003', '33333', 'Reachable', true)`.execute(ctx.db);
    await sql`insert into channel_identity (id, customer_id, channel, channel_user_id) values (${newId()}, ${fallbackOnlyCustomerId}, 'TELEGRAM', '44444')`.execute(ctx.db);

    const queued = await queueAdminCustomerMessage(ctx.db, { customerId, content: "Xin chào", actorId: "1", correlationId: "corr-1" });
    const fallbackQueued = await queueAdminCustomerMessage(ctx.db, { customerId: fallbackOnlyCustomerId, content: "Xin chào", actorId: "1", correlationId: "corr-2" });
    const deliveries = await sql<{ customer_id: string; chat_id: string }>`select customer_id, chat_id from notification_delivery order by customer_id`.execute(ctx.db);

    expect(queued).toBe(true);
    expect(fallbackQueued).toBe(false);
    expect(deliveries.rows).toEqual([{ customer_id: customerId, chat_id: "33333" }]);
  });
});
