import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { newId } from "../../src/shared/ids/index.js";
import { createSupportService } from "../../src/modules/support/service.js";
import { startPostgresContainer, type PgTestContext } from "../helpers/pg-container.js";

/**
 * T081 — Structured support ticket: reason, safe summary, SLA, linked Order
 * (FR-019).
 *
 * A ticket is created with a structured reason code and a safe summary that
 * never contains the delivered secret. When linked to an Order it must be the
 * customer's own Order (ownership). An SLA due date is set from the reason.
 */

let ctx: PgTestContext;

beforeAll(async () => {
  ctx = await startPostgresContainer();
}, 180_000);

afterAll(async () => {
  await ctx?.teardown();
});

async function seedCustomerWithOrder(): Promise<{ customerId: string; orderId: string }> {
  const customerId = newId();
  const categoryId = newId();
  const productId = newId();
  const variantId = newId();
  const orderId = newId();
  const slug = categoryId.slice(-8);
  await sql`insert into customer (id, status, locale) values (${customerId}, 'ACTIVE', 'vi')`.execute(
    ctx.db,
  );
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
  await sql`
    insert into "order" (id, order_number, customer_id, variant_id, product_name_vi, variant_name_vi,
      price_vnd, duration_code, delivery_type, status, paid_at)
    values (${orderId}, ${"ORD-" + orderId}, ${customerId}, ${variantId}, 'P', 'V',
      100000, 'P1M', 'CREDENTIAL', 'COMPLETED', now())
  `.execute(ctx.db);
  return { customerId, orderId };
}

beforeEach(async () => {
  await sql`
    truncate table support_ticket, delivery_bundle, digital_asset, order_transition, "order",
      product_variant, product, category, customer, outbox_event cascade
  `.execute(ctx.db);
});

describe("support ticket (FR-019)", () => {
  it("opens a structured ticket linked to the customer's own order", async () => {
    const { customerId, orderId } = await seedCustomerWithOrder();
    const svc = createSupportService(ctx.db);
    const res = await svc.openTicket({
      customerId,
      orderId,
      reasonCode: "ASSET_NOT_WORKING",
      description: "Tài khoản đăng nhập báo lỗi.",
      correlationId: "sup-1",
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.status).toBe("OPEN");

    const row = await sql<{
      order_id: string | null;
      reason_code: string;
      safe_summary: string;
      due_at: string | null;
    }>`
      select order_id, reason_code, safe_summary, due_at from support_ticket where id = ${res.ticketId}
    `.execute(ctx.db);
    expect(row.rows[0]?.order_id).toBe(orderId);
    expect(row.rows[0]?.reason_code).toBe("ASSET_NOT_WORKING");
    expect(row.rows[0]?.due_at).toBeTruthy();
  });

  it("never stores a raw secret in the safe summary", async () => {
    const { customerId, orderId } = await seedCustomerWithOrder();
    const svc = createSupportService(ctx.db);
    const secretish = "user@example.com:SuperSecretPass123";
    const res = await svc.openTicket({
      customerId,
      orderId,
      reasonCode: "ASSET_NOT_WORKING",
      description: `Đây là mật khẩu của tôi ${secretish} xin hãy kiểm tra`,
      correlationId: "sup-2",
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const row = await sql<{ safe_summary: string }>`
      select safe_summary from support_ticket where id = ${res.ticketId}
    `.execute(ctx.db);
    // The credential-shaped substring is redacted out of the stored summary.
    expect(row.rows[0]?.safe_summary).not.toContain("SuperSecretPass123");
  });

  it("refuses to link a ticket to another customer's order (ownership)", async () => {
    const { orderId } = await seedCustomerWithOrder();
    const stranger = newId();
    await sql`insert into customer (id, status, locale) values (${stranger}, 'ACTIVE', 'vi')`.execute(
      ctx.db,
    );
    const svc = createSupportService(ctx.db);
    const res = await svc.openTicket({
      customerId: stranger,
      orderId,
      reasonCode: "OTHER",
      description: "not my order",
      correlationId: "sup-3",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("ORDER_NOT_OWNED");
  });

  it("allows an order-less general ticket", async () => {
    const { customerId } = await seedCustomerWithOrder();
    const svc = createSupportService(ctx.db);
    const res = await svc.openTicket({
      customerId,
      reasonCode: "GENERAL_QUESTION",
      description: "Cho hỏi cách dùng",
      correlationId: "sup-4",
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const row = await sql<{ order_id: string | null }>`
      select order_id from support_ticket where id = ${res.ticketId}
    `.execute(ctx.db);
    expect(row.rows[0]?.order_id).toBeNull();
  });

  it("deduplicates replayed structured opens by stable callback correlation", async () => {
    const { customerId } = await seedCustomerWithOrder();
    const svc = createSupportService(ctx.db);
    const input = {
      customerId,
      reasonCode: "GENERAL_QUESTION",
      description: "GENERAL_QUESTION",
      correlationId: "telegram:stable-message-77",
    };
    const [first, replay] = await Promise.all([svc.openTicket(input), svc.openTicket(input)]);
    expect(replay).toEqual(first);
    const rows = await sql<{ count: string }>`
      select count(*)::text as count from support_ticket where customer_id = ${customerId}
    `.execute(ctx.db);
    expect(Number(rows.rows[0]?.count ?? 0)).toBe(1);
  });

  it("lists only the customer's own tickets", async () => {
    const { customerId, orderId } = await seedCustomerWithOrder();
    const other = newId();
    await sql`insert into customer (id, status, locale) values (${other}, 'ACTIVE', 'vi')`.execute(
      ctx.db,
    );
    const svc = createSupportService(ctx.db);
    await svc.openTicket({
      customerId,
      orderId,
      reasonCode: "OTHER",
      description: "a",
      correlationId: "c1",
    });
    await svc.openTicket({
      customerId: other,
      reasonCode: "OTHER",
      description: "b",
      correlationId: "c2",
    });

    const mine = await svc.listTickets({ customerId });
    expect(mine.every((t) => t.customerId === customerId)).toBe(true);
    expect(mine).toHaveLength(1);
  });
});
