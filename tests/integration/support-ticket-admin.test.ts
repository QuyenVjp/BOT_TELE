import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { newId } from "../../src/shared/ids/index.js";
import {
  createSupportService,
  getAdminTicket,
  listOpenTickets,
  setTicketStatus,
} from "../../src/modules/support/service.js";
import { startPostgresContainer, type PgTestContext } from "../helpers/pg-container.js";

/**
 * Owner ticket management: the queue the shop works from and the guarded status
 * move. The state machine is the authority — a status the customer-facing flow
 * never allows must not be reachable through the admin screen either.
 */

let ctx: PgTestContext;

beforeAll(async () => {
  ctx = await startPostgresContainer();
}, 180_000);

afterAll(async () => {
  await ctx?.teardown();
});

beforeEach(async () => {
  await sql`
    truncate table support_ticket, delivery_bundle, digital_asset, order_transition, "order",
      product_variant, product, category, customer, outbox_event, audit_event cascade
  `.execute(ctx.db);
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

async function openTicket(): Promise<{ customerId: string; ticketId: string }> {
  const { customerId, orderId } = await seedCustomerWithOrder();
  const result = await createSupportService(ctx.db).openTicket({
    customerId,
    orderId,
    reasonCode: "DELIVERY_NOT_RECEIVED",
    description: "Chưa nhận được tài khoản.",
    correlationId: "admin-support-1",
  });
  if (!result.ok) throw new Error(`openTicket failed: ${result.code}`);
  return { customerId, ticketId: result.ticketId };
}

describe("owner support ticket queue", () => {
  it("lists an open ticket with a short label, its order and its SLA", async () => {
    const { customerId, ticketId } = await openTicket();

    const rows = await listOpenTickets(ctx.db);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(ticketId);
    expect(rows[0]?.customerLabel).toBe(`Khách ${customerId.slice(-4).toUpperCase()}`);
    expect(rows[0]?.reasonCode).toBe("DELIVERY_NOT_RECEIVED");
    expect(rows[0]?.status).toBe("OPEN");
    expect(rows[0]?.safeSummary).toBe("Chưa nhận được tài khoản.");
    expect(rows[0]?.orderNumber).toBeTruthy();
    expect(rows[0]?.dueAt).toBeTruthy();
  });

  it("drops a ticket from the queue once it is closed", async () => {
    const { ticketId } = await openTicket();
    await setTicketStatus({
      db: ctx.db,
      ticketId,
      toStatus: "RESOLVED",
      actorId: "admin-1",
      correlationId: "admin-support-resolve",
    });
    await setTicketStatus({
      db: ctx.db,
      ticketId,
      toStatus: "CLOSED",
      actorId: "admin-1",
      correlationId: "admin-support-close",
    });

    expect(await listOpenTickets(ctx.db)).toEqual([]);
  });
});

describe("owner status move", () => {
  it("applies a legal transition, records it, and keeps the version moving", async () => {
    const { customerId, ticketId } = await openTicket();

    const result = await setTicketStatus({
      db: ctx.db,
      ticketId,
      toStatus: "WAITING_SHOP",
      actorId: "admin-1",
      correlationId: "admin-support-shop",
    });

    expect(result).toEqual({
      ok: true,
      from: "OPEN",
      to: "WAITING_SHOP",
      customerId,
    });
    const row = await sql<{ status: string; version: number }>`
      select status, version from support_ticket where id = ${ticketId}
    `.execute(ctx.db);
    expect(row.rows[0]?.status).toBe("WAITING_SHOP");
    expect(row.rows[0]?.version).toBe(2);

    const audit = await sql<{ action: string; actor_id: string | null; metadata: unknown }>`
      select action, actor_id, metadata_redacted as metadata
      from audit_event
      where target_type = 'SupportTicket' and target_id = ${ticketId}
    `.execute(ctx.db);
    expect(audit.rows[0]?.action).toBe("support.ticket.status");
    expect(audit.rows[0]?.actor_id).toBe("admin-1");
    expect(audit.rows[0]?.metadata).toEqual({ from: "OPEN", to: "WAITING_SHOP" });

    const detail = await getAdminTicket(ctx.db, ticketId);
    expect(detail?.status).toBe("WAITING_SHOP");
  });

  it("refuses a transition the state machine forbids and leaves the row alone", async () => {
    const { ticketId } = await openTicket();
    await setTicketStatus({
      db: ctx.db,
      ticketId,
      toStatus: "RESOLVED",
      actorId: "admin-1",
      correlationId: "admin-support-resolve",
    });

    const result = await setTicketStatus({
      db: ctx.db,
      ticketId,
      toStatus: "MANUAL_REVIEW",
      actorId: "admin-1",
      correlationId: "admin-support-illegal",
    });

    expect(result).toEqual({ ok: false, code: "ILLEGAL_STATE" });
    const row = await sql<{ status: string; version: number }>`
      select status, version from support_ticket where id = ${ticketId}
    `.execute(ctx.db);
    expect(row.rows[0]?.status).toBe("RESOLVED");
    expect(row.rows[0]?.version).toBe(2);
  });

  it("rejects a status that is not part of the machine", async () => {
    const { ticketId } = await openTicket();

    const result = await setTicketStatus({
      db: ctx.db,
      ticketId,
      toStatus: "REFUNDED",
      actorId: "admin-1",
      correlationId: "admin-support-bogus",
    });

    expect(result).toEqual({ ok: false, code: "ILLEGAL_STATE" });
  });

  it("reports an unknown ticket instead of inventing one", async () => {
    const result = await setTicketStatus({
      db: ctx.db,
      ticketId: newId(),
      toStatus: "WAITING_SHOP",
      actorId: "admin-1",
      correlationId: "admin-support-missing",
    });

    expect(result).toEqual({ ok: false, code: "NOT_FOUND" });
    expect(await getAdminTicket(ctx.db, newId())).toBeNull();
  });
});
