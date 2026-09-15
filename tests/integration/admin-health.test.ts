import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { newId } from "../../src/shared/ids/index.js";
import { getAdminHealthFacts } from "../../src/modules/admin/health.js";
import { listTerminalOutboxOrphans } from "../../src/infrastructure/outbox/disposition.js";
import { startPostgresContainer, type PgTestContext } from "../helpers/pg-container.js";

/**
 * Admin health queues (goal §135). The screen must render even when the database it reports on
 * is unreachable, and every count must be a read-only, secret-free number.
 */

let ctx: PgTestContext;

beforeAll(async () => {
  ctx = await startPostgresContainer();
}, 180_000);

afterAll(async () => {
  await ctx?.teardown();
});

describe("admin health facts", () => {
  it("reports ok with zeroed queues on a freshly migrated database", async () => {
    const facts = await getAdminHealthFacts(ctx.db);
    expect(facts.database).toBe("ok");
    expect(facts.queues.outboxBacklog).toBe(0);
    expect(facts.queues.openDiscrepancies).toBe(0);
    expect(facts.queues.openSupportTickets).toBe(0);
  });

  it("counts a published outbox row as done and an unpublished one as backlog", async () => {
    const pending = newId();
    const sent = newId();
    const resolvedDeadLetter = newId();
    await sql`
      insert into outbox_event (id, aggregate_type, aggregate_id, aggregate_version, event_type, payload_redacted, occurred_at)
      values (${pending}, 'Order', ${newId()}, 1, 'OrderPaid', '{}'::jsonb, now())
    `.execute(ctx.db);
    await sql`
      insert into outbox_event (id, aggregate_type, aggregate_id, aggregate_version, event_type, payload_redacted, occurred_at, published_at)
      values (${sent}, 'Order', ${newId()}, 1, 'OrderPaid', '{}'::jsonb, now(), now())
    `.execute(ctx.db);
    await sql`
      insert into outbox_event
        (id, aggregate_type, aggregate_id, aggregate_version, event_type, payload_redacted, occurred_at,
         dead_lettered_at, disposition_status, disposition_code, dispositioned_at, dispositioned_by)
      values
        (${resolvedDeadLetter}, 'Order', ${newId()}, 1, 'OrderPaid', '{}'::jsonb, now(),
         now(), 'RESOLVED', 'HANDLED_MANUALLY', now(), 'admin')
    `.execute(ctx.db);

    const facts = await getAdminHealthFacts(ctx.db);
    expect(facts.queues.outboxBacklog).toBe(1);
    expect(facts.queues.outboxDeadLettered).toBe(0);
    // The already-closed dead letter is reported as retained history, so the
    // operator can see the disposition happened without the row looking like work.
    expect(facts.queues.outboxDeadLetteredDisposed).toBe(1);
    await sql`delete from outbox_event where id in (${pending}, ${sent}, ${resolvedDeadLetter})`.execute(
      ctx.db,
    );
  });

  it("counts an unresolved discrepancy and a new ticket as operator work", async () => {
    const customerId = newId();
    await sql`insert into customer (id, status, locale) values (${customerId}, 'ACTIVE', 'vi')`.execute(
      ctx.db,
    );
    await sql`
      insert into discrepancy (id, type, status, reason, owner, due_at, source)
      values (${newId()}, 'UNMATCHED', 'OPEN', 'seed', 'ops', now(), 'WEBHOOK')
    `.execute(ctx.db);
    await sql`
      insert into support_ticket (id, customer_id, reason_code, status, safe_summary, due_at)
      values (${newId()}, ${customerId}, 'OTHER', 'OPEN', 'seed', now())
    `.execute(ctx.db);

    const facts = await getAdminHealthFacts(ctx.db);
    expect(facts.queues.openDiscrepancies).toBe(1);
    expect(facts.queues.openSupportTickets).toBe(1);
  });

  it("separates actionable dead letters from retained disposition history", async () => {
    const actionable = newId();
    const published = newId();
    const disposed = newId();

    await sql`
      insert into outbox_event
        (id, aggregate_type, aggregate_id, aggregate_version, event_type, payload_redacted,
         occurred_at, dead_lettered_at)
      values (${actionable}, 'Order', ${newId()}, 1, 'OrderPaid', '{}'::jsonb, now(), now())
    `.execute(ctx.db);
    // Delivered after being parked: no longer an actionable orphan.
    await sql`
      insert into outbox_event
        (id, aggregate_type, aggregate_id, aggregate_version, event_type, payload_redacted,
         occurred_at, dead_lettered_at, published_at)
      values (${published}, 'Order', ${newId()}, 1, 'OrderPaid', '{}'::jsonb, now(), now(), now())
    `.execute(ctx.db);
    // Closed by a real disposition: retained evidence, not work.
    await sql`
      insert into outbox_event
        (id, aggregate_type, aggregate_id, aggregate_version, event_type, payload_redacted,
         occurred_at, dead_lettered_at, disposition_status, disposition_code, dispositioned_at,
         dispositioned_by)
      values (${disposed}, 'Order', ${newId()}, 1, 'OrderPaid', '{}'::jsonb, now(), now(), 'RESOLVED',
              'HANDLED_MANUALLY', now(), 'admin')
    `.execute(ctx.db);

    const facts = await getAdminHealthFacts(ctx.db);
    // Actionable is exactly the predicate the disposition command acts on: the
    // published row is excluded (it delivered) and the disposed row is history.
    expect(facts.queues.outboxDeadLettered).toBe(1);
    expect(facts.queues.outboxDeadLetteredDisposed).toBe(1);

    // Parity with the operator queue: the screen's actionable count equals the
    // set of rows `listTerminalOutboxOrphans` hands the disposition flow.
    const orphans = await listTerminalOutboxOrphans(ctx.db, 20);
    expect(orphans.map((row) => row.id)).toEqual([actionable]);

    await sql`
      delete from outbox_event where id in (${actionable}, ${published}, ${disposed})
    `.execute(ctx.db);
  });

  it("counts a resolved discrepancy as retained history, not as open work", async () => {
    const before = await getAdminHealthFacts(ctx.db);
    const resolved = newId();
    await sql`
      insert into discrepancy (id, type, status, reason, owner, due_at, source, resolved_at, resolution_code)
      values (${resolved}, 'UNMATCHED', 'RESOLVED', 'seed', 'ops', now(), 'WEBHOOK',
              now(), 'NO_ACTION_REQUIRED')
    `.execute(ctx.db);
    await sql`
      insert into discrepancy (id, type, status, reason, owner, due_at, source)
      values (${newId()}, 'AMBIGUOUS_CORRELATION', 'OPEN', 'seed', 'ops', now(), 'WEBHOOK')
    `.execute(ctx.db);

    const facts = await getAdminHealthFacts(ctx.db);
    // History is reported, never added to the open queue — and an ambiguous
    // classification stays open; no counter may imply it was disposed of.
    expect(facts.queues.openDiscrepancies).toBe(before.queues.openDiscrepancies + 1);
    expect(facts.queues.resolvedDiscrepancies).toBe(before.queues.resolvedDiscrepancies + 1);
  });

  it("splits support tickets into informational open work and critical manual review", async () => {
    const customerId = newId();
    await sql`insert into customer (id, status, locale) values (${customerId}, 'ACTIVE', 'vi')`.execute(
      ctx.db,
    );
    const before = await getAdminHealthFacts(ctx.db);
    // A ticket waiting on the customer is ordinary work.
    await sql`
      insert into support_ticket (id, customer_id, reason_code, status, safe_summary, due_at)
      values (${newId()}, ${customerId}, 'OTHER', 'WAITING_CUSTOMER', 'seed', now())
    `.execute(ctx.db);
    // MANUAL_REVIEW is the escalation status and must never be hidden inside
    // the informational count.
    await sql`
      insert into support_ticket (id, customer_id, reason_code, status, safe_summary, due_at)
      values (${newId()}, ${customerId}, 'OTHER', 'MANUAL_REVIEW', 'seed', now())
    `.execute(ctx.db);

    const facts = await getAdminHealthFacts(ctx.db);
    expect(facts.queues.openSupportTickets).toBe(before.queues.openSupportTickets + 1);
    expect(facts.queues.criticalSupportTickets).toBe(before.queues.criticalSupportTickets + 1);
  });

  it("excludes a test-order payment intent from the operator queue", async () => {
    const customerId = newId();
    const categoryId = newId();
    const productId = newId();
    const variantId = newId();
    const orderId = newId();
    await sql`insert into customer (id, status, locale) values (${customerId}, 'ACTIVE', 'vi')`.execute(
      ctx.db,
    );
    await sql`insert into category (id, name_vi, slug, is_active, sort_order) values (${categoryId}, 'AI', ${categoryId.slice(-8)}, true, 1)`.execute(
      ctx.db,
    );
    await sql`
      insert into product (id, category_id, name_vi, slug, is_active, sort_order, is_test)
      values (${productId}, ${categoryId}, '🧪 Test', ${categoryId.slice(-8) + "t"}, true, 1, true)
    `.execute(ctx.db);
    await sql`
      insert into product_variant (id, product_id, sku, name_vi, price_vnd, duration_code, delivery_type, stock_policy)
      values (${variantId}, ${productId}, ${"SKU-" + variantId}, '1 tháng', 2000, 'P1M', 'CREDENTIAL', 'LOCAL_ONLY')
    `.execute(ctx.db);
    await sql`
      insert into "order" (id, order_number, customer_id, variant_id, product_name_vi, variant_name_vi,
        price_vnd, duration_code, delivery_type, status, expires_at, fulfillment_type)
      values (${orderId}, ${"ORD-" + orderId.slice(-10)}, ${customerId}, ${variantId}, '🧪 Test', '1 tháng',
        2000, 'P1M', 'CREDENTIAL', 'PENDING_PAYMENT', now() + interval '15 minutes', 'STOCK_ACCOUNT')
    `.execute(ctx.db);
    await sql`
      insert into payment_intent (id, order_id, status, amount_vnd, merchant_account_id, transfer_content, expires_at)
      values (${newId()}, ${orderId}, 'PRESENTED', 2000, 'acct', ${"ORD-" + orderId.slice(-10)}, now() + interval '15 minutes')
    `.execute(ctx.db);

    const facts = await getAdminHealthFacts(ctx.db);
    // A TEST-mode purchase creates a real intent row; the operator queue must not show it.
    expect(facts.queues.intentsAwaitingSettlement).toBe(0);
    expect(facts.queues.paymentsNeedingReview).toBe(0);
  });

  it("reports the durable ingress dead letters, not just the outbound outbox ones", async () => {
    for (const [source, status, id] of [
      ["telegram", "DEAD", newId()],
      ["telegram", "RETRY", newId()],
      ["sepay", "DEAD", newId()],
    ] as const) {
      await sql`
        insert into webhook_inbox (id, source, source_event_id, raw_hash, signature_status, received_at, processing_status)
        values (${id}, ${source}, ${"evt-" + id}, ${"hash-" + id}, 'VALID', now(), ${status})
      `.execute(ctx.db);
    }

    const facts = await getAdminHealthFacts(ctx.db);
    // The outbox queue is empty here on purpose: the ingress DLQ is the one that answers
    // "did we lose an update", and reporting only the outbox figure understates the backlog.
    expect(facts.queues.inboxDeadLetteredTelegram).toBe(1);
    expect(facts.queues.inboxDeadLetteredSePay).toBe(1);
    expect(facts.queues.inboxPendingTelegram).toBe(1);
  });

  it("reports down with zeroed queues instead of throwing when the database is gone", async () => {
    const broken = {
      executeQuery: async () => {
        throw new Error("connection refused");
      },
    };
    const facts = await getAdminHealthFacts(broken as never);
    expect(facts.database).toBe("down");
    expect(facts.queues).toEqual({
      outboxBacklog: 0,
      outboxDeadLettered: 0,
      outboxDeadLetteredDisposed: 0,
      inboxDeadLetteredTelegram: 0,
      inboxDeadLetteredSePay: 0,
      inboxPendingTelegram: 0,
      inboxPendingSePay: 0,
      openDiscrepancies: 0,
      resolvedDiscrepancies: 0,
      intentsAwaitingSettlement: 0,
      paymentsNeedingReview: 0,
      openSupportTickets: 0,
      criticalSupportTickets: 0,
    });
  });
});
