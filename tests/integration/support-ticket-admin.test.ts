import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { newId } from "../../src/shared/ids/index.js";
import {
  createSupportService,
  getAdminTicket,
  listOpenTickets,
  setTicketStatus,
} from "../../src/modules/support/service.js";
import { drainOutboxOnce } from "../../src/infrastructure/outbox/worker.js";
import { handleNotificationOutboxEvent } from "../../src/modules/notification/service.js";
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
    drop trigger if exists test_fail_support_status_campaign on notification_campaign;
    drop function if exists test_fail_support_status_campaign();
    drop sequence if exists test_support_status_campaign_seq;
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
    expect(rows[0]?.version).toBe(1);
  });

  it("drops a ticket from the queue once it is closed", async () => {
    const { ticketId } = await openTicket();
    await setTicketStatus({
      db: ctx.db,
      ticketId,
      toStatus: "RESOLVED",
      expectedVersion: 1,
      actorId: "admin-1",
      correlationId: "admin-support-resolve",
    });
    await setTicketStatus({
      db: ctx.db,
      ticketId,
      toStatus: "CLOSED",
      expectedVersion: 2,
      actorId: "admin-1",
      correlationId: "admin-support-close",
    });

    expect(await listOpenTickets(ctx.db)).toEqual([]);
  });
});

describe("customer status close", () => {
  it("closes an owned resolved ticket once with its versioned audit and outbox event", async () => {
    const { customerId, ticketId } = await openTicket();
    await setTicketStatus({
      db: ctx.db,
      ticketId,
      toStatus: "RESOLVED",
      expectedVersion: 1,
      actorId: "admin-1",
      correlationId: "customer-close-resolve",
    });

    const stranger = newId();
    await sql`insert into customer (id, status, locale) values (${stranger}, 'ACTIVE', 'vi')`.execute(
      ctx.db,
    );
    const refused = await createSupportService(ctx.db).closeTicket({
      ticketId,
      customerId: stranger,
      correlationId: "customer-close-foreign",
    });
    expect(refused).toEqual({
      ok: false,
      code: "NOT_FOUND",
      message: "Không tìm thấy ticket.",
    });

    const beforeOwnerClose = await sql<{ status: string; version: number }>`
      select status, version from support_ticket where id = ${ticketId}
    `.execute(ctx.db);
    expect(beforeOwnerClose.rows[0]).toEqual({ status: "RESOLVED", version: 2 });

    const svc = createSupportService(ctx.db);
    const closed = await svc.closeTicket({
      ticketId,
      customerId,
      correlationId: "customer-close",
    });
    expect(closed).toEqual({ ok: true });

    const row = await sql<{ customer_id: string; status: string; version: number }>`
      select customer_id, status, version from support_ticket where id = ${ticketId}
    `.execute(ctx.db);
    expect(row.rows[0]).toEqual({ customer_id: customerId, status: "CLOSED", version: 3 });

    const audit = await sql<{
      action: string;
      actor_type: string;
      actor_id: string | null;
      correlation_id: string;
      metadata_redacted: Record<string, unknown>;
    }>`
      select action, actor_type, actor_id, correlation_id, metadata_redacted
      from audit_event
      where target_type = 'SupportTicket'
        and target_id = ${ticketId}
        and action = 'support.ticket.close'
    `.execute(ctx.db);
    expect(audit.rows).toEqual([
      {
        action: "support.ticket.close",
        actor_type: "CUSTOMER",
        actor_id: customerId,
        correlation_id: "customer-close",
        metadata_redacted: { from: "RESOLVED", to: "CLOSED" },
      },
    ]);

    const events = await sql<{
      event_type: string;
      aggregate_version: number;
      payload_redacted: Record<string, unknown>;
    }>`
      select event_type, aggregate_version, payload_redacted
      from outbox_event
      where aggregate_id = ${ticketId}
        and event_type = 'TicketStatusChanged'
      order by aggregate_version
    `.execute(ctx.db);
    expect(events.rows.at(-1)).toEqual({
      event_type: "TicketStatusChanged",
      aggregate_version: 3,
      payload_redacted: {
        ticketId,
        customerId,
        from: "RESOLVED",
        to: "CLOSED",
        version: 3,
        actorId: customerId,
      },
    });

    const duplicate = await svc.closeTicket({
      ticketId,
      customerId,
      correlationId: "customer-close-replay",
    });
    expect(duplicate).toEqual({
      ok: false,
      code: "NOT_FOUND",
      message: "Không tìm thấy ticket.",
    });
    const effects = await sql<{ audits: string; close_events: string }>`
      select
        (select count(*)::text
           from audit_event
          where target_type = 'SupportTicket'
            and target_id = ${ticketId}
            and action = 'support.ticket.close') as audits,
        (select count(*)::text
           from outbox_event
          where aggregate_id = ${ticketId}
            and event_type = 'TicketStatusChanged'
            and aggregate_version = 3) as close_events
    `.execute(ctx.db);
    expect(effects.rows[0]).toEqual({ audits: "1", close_events: "1" });
  });

  it("rolls back the customer close when its status event cannot be enqueued", async () => {
    const { customerId, ticketId } = await openTicket();
    await setTicketStatus({
      db: ctx.db,
      ticketId,
      toStatus: "RESOLVED",
      expectedVersion: 1,
      actorId: "admin-1",
      correlationId: "customer-close-atomic-resolve",
    });
    await sql`
      create or replace function test_fail_customer_close_outbox()
      returns trigger language plpgsql as $$
      begin
        if new.event_type = 'TicketStatusChanged'
           and new.aggregate_version = 3 then
          raise exception 'forced customer close outbox failure';
        end if;
        return new;
      end $$;
      drop trigger if exists test_fail_customer_close_outbox on outbox_event;
      create trigger test_fail_customer_close_outbox
      before insert on outbox_event
      for each row execute function test_fail_customer_close_outbox();
    `.execute(ctx.db);

    try {
      await expect(
        createSupportService(ctx.db).closeTicket({
          ticketId,
          customerId,
          correlationId: "customer-close-atomic",
        }),
      ).rejects.toThrow("forced customer close outbox failure");

      const row = await sql<{ status: string; version: number }>`
        select status, version from support_ticket where id = ${ticketId}
      `.execute(ctx.db);
      expect(row.rows[0]).toEqual({ status: "RESOLVED", version: 2 });

      const effects = await sql<{ audits: string; close_events: string }>`
        select
          (select count(*)::text
             from audit_event
            where target_type = 'SupportTicket'
              and target_id = ${ticketId}
              and action = 'support.ticket.close') as audits,
          (select count(*)::text
             from outbox_event
            where aggregate_id = ${ticketId}
              and event_type = 'TicketStatusChanged'
              and aggregate_version = 3) as close_events
      `.execute(ctx.db);
      expect(effects.rows[0]).toEqual({ audits: "0", close_events: "0" });
    } finally {
      await sql`
        drop trigger if exists test_fail_customer_close_outbox on outbox_event;
        drop function if exists test_fail_customer_close_outbox();
      `.execute(ctx.db);
    }
  });
});

describe("owner status move", () => {
  it("applies a legal transition, records it, and keeps the version moving", async () => {
    const { customerId, ticketId } = await openTicket();

    const result = await setTicketStatus({
      db: ctx.db,
      ticketId,
      toStatus: "WAITING_SHOP",
      expectedVersion: 1,
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
    expect(detail?.version).toBe(2);
  });
  it("keeps a committed status while retrying its durable customer notification", async () => {
    const { customerId, ticketId } = await openTicket();
    await sql`
      insert into customer_profile_snapshot
        (customer_id, telegram_user_id, chat_id, reachable)
      values (${customerId}, '900001', '900001', true)
    `.execute(ctx.db);

    const result = await setTicketStatus({
      db: ctx.db,
      ticketId,
      toStatus: "WAITING_SHOP",
      expectedVersion: 1,
      actorId: "admin-1",
      correlationId: "admin-support-atomic-notification",
    });
    expect(result).toMatchObject({ ok: true, from: "OPEN", to: "WAITING_SHOP" });

    const event = await sql<{
      id: string;
      event_type: string;
      aggregate_version: number;
      payload_redacted: Record<string, unknown>;
    }>`
      select id, event_type, aggregate_version, payload_redacted
      from outbox_event
      where aggregate_id = ${ticketId} and event_type = 'TicketStatusChanged'
    `.execute(ctx.db);
    expect(event.rows).toHaveLength(1);
    expect(event.rows[0]).toMatchObject({
      event_type: "TicketStatusChanged",
      aggregate_version: 2,
      payload_redacted: {
        ticketId,
        customerId,
        from: "OPEN",
        to: "WAITING_SHOP",
        version: 2,
        actorId: "admin-1",
      },
    });
    expect(JSON.stringify(event.rows[0]?.payload_redacted)).not.toContain(
      "Chưa nhận được tài khoản",
    );

    await sql`
      update outbox_event
      set published_at = now()
      where aggregate_id = ${ticketId} and event_type = 'TicketOpened'
    `.execute(ctx.db);
    await sql`
      create sequence test_support_status_campaign_seq;
      create or replace function test_fail_support_status_campaign()
      returns trigger language plpgsql as $$
      begin
        if nextval('test_support_status_campaign_seq') = 1 then
          raise exception 'forced support status notification failure';
        end if;
        return new;
      end $$;
      create trigger test_fail_support_status_campaign
      before insert on notification_campaign
      for each row when (new.id like 'support-ticket-status:%')
      execute function test_fail_support_status_campaign();
    `.execute(ctx.db);

    try {
      const first = await drainOutboxOnce(ctx.db, {
        batchSize: 1,
        maxAttempts: 5,
        handler: (outboxEvent) => handleNotificationOutboxEvent(ctx.db, outboxEvent),
      });
      expect(first).toMatchObject({ claimed: 1, published: 0, failed: 1 });

      const committed = await sql<{ status: string; version: number }>`
        select status, version from support_ticket where id = ${ticketId}
      `.execute(ctx.db);
      expect(committed.rows[0]).toEqual({ status: "WAITING_SHOP", version: 2 });
      const failedEvent = await sql<{ published_at: Date | null; attempt_count: number }>`
        select published_at, attempt_count from outbox_event where id = ${event.rows[0]!.id}
      `.execute(ctx.db);
      expect(failedEvent.rows[0]?.published_at).toBeNull();
      expect(failedEvent.rows[0]?.attempt_count).toBe(1);

      await sql`
        update outbox_event
        set next_attempt_at = now(), dead_lettered_at = null
        where id = ${event.rows[0]!.id}
      `.execute(ctx.db);
      const retry = await drainOutboxOnce(ctx.db, {
        batchSize: 1,
        maxAttempts: 5,
        handler: (outboxEvent) => handleNotificationOutboxEvent(ctx.db, outboxEvent),
      });
      expect(retry).toMatchObject({ claimed: 1, published: 1, failed: 0 });

      await sql`
        update outbox_event
        set published_at = null, next_attempt_at = null, dead_lettered_at = null
        where id = ${event.rows[0]!.id}
      `.execute(ctx.db);
      const replay = await drainOutboxOnce(ctx.db, {
        batchSize: 1,
        maxAttempts: 5,
        handler: (outboxEvent) => handleNotificationOutboxEvent(ctx.db, outboxEvent),
      });
      expect(replay).toMatchObject({ claimed: 1, published: 1, failed: 0 });

      const effects = await sql<{ campaigns: string; deliveries: string }>`
        select
          (select count(*)::text from notification_campaign
            where id = ${`support-ticket-status:${ticketId}:2`}) as campaigns,
          (select count(*)::text from notification_delivery d
            where d.campaign_id = ${`support-ticket-status:${ticketId}:2`}) as deliveries
      `.execute(ctx.db);
      expect(effects.rows[0]).toEqual({ campaigns: "1", deliveries: "1" });
    } finally {
      await sql`
        drop trigger if exists test_fail_support_status_campaign on notification_campaign;
        drop function if exists test_fail_support_status_campaign();
        drop sequence if exists test_support_status_campaign_seq;
      `.execute(ctx.db);
    }
  });

  it("emits one versioned status event when a customer submits a draft", async () => {
    const { customerId, orderId } = await seedCustomerWithOrder();
    const svc = createSupportService(ctx.db);
    const draft = await svc.beginDescription({
      customerId,
      orderId,
      reasonCode: "DELIVERY_NOT_RECEIVED",
      correlationId: "customer-submit-event",
    });
    expect(draft.ok).toBe(true);
    if (!draft.ok) return;

    const result = await svc.submitDescription({
      customerId,
      ticketId: draft.ticketId,
      description: "Mô tả yêu cầu hỗ trợ.",
      correlationId: "customer-submit-event-submit",
    });
    expect(result).toMatchObject({
      ok: true,
      ticketId: draft.ticketId,
      status: "WAITING_SHOP",
    });

    const events = await sql<{
      event_type: string;
      aggregate_version: number;
      payload_redacted: Record<string, unknown>;
    }>`
      select event_type, aggregate_version, payload_redacted
      from outbox_event
      where aggregate_id = ${draft.ticketId} and event_type = 'TicketStatusChanged'
    `.execute(ctx.db);
    expect(events.rows).toEqual([
      {
        event_type: "TicketStatusChanged",
        aggregate_version: 2,
        payload_redacted: {
          ticketId: draft.ticketId,
          customerId,
          from: "WAITING_CUSTOMER",
          to: "WAITING_SHOP",
          version: 2,
          actorId: customerId,
        },
      },
    ]);
  });

  it("emits one versioned status event when a customer cancels a draft", async () => {
    const { customerId, orderId } = await seedCustomerWithOrder();
    const svc = createSupportService(ctx.db);
    const draft = await svc.beginDescription({
      customerId,
      orderId,
      reasonCode: "GENERAL_QUESTION",
      correlationId: "customer-cancel-event",
    });
    expect(draft.ok).toBe(true);
    if (!draft.ok) return;

    const result = await svc.cancelDescription({
      customerId,
      ticketId: draft.ticketId,
      correlationId: "customer-cancel-event-cancel",
    });
    expect(result).toEqual({ ok: true, ticketId: draft.ticketId, status: "RESOLVED" });

    const events = await sql<{
      event_type: string;
      aggregate_version: number;
      payload_redacted: Record<string, unknown>;
    }>`
      select event_type, aggregate_version, payload_redacted
      from outbox_event
      where aggregate_id = ${draft.ticketId} and event_type = 'TicketStatusChanged'
    `.execute(ctx.db);
    expect(events.rows).toEqual([
      {
        event_type: "TicketStatusChanged",
        aggregate_version: 2,
        payload_redacted: {
          ticketId: draft.ticketId,
          customerId,
          from: "WAITING_CUSTOMER",
          to: "RESOLVED",
          version: 2,
          actorId: customerId,
        },
      },
    ]);
  });

  it("repairs a replacement after a legal ticket-status race and reuses it on replay", async () => {
    const { customerId, orderId } = await seedCustomerWithOrder();
    const variant = await sql<{ variant_id: string }>`
      select variant_id from "order" where id = ${orderId}
    `.execute(ctx.db);
    await sql`
      insert into digital_asset
        (id, variant_id, source_type, vault_ref, fingerprint_hash, status,
         reserved_order_id, delivered_order_id)
      values
        (${newId()}, ${variant.rows[0]!.variant_id}, 'LOCAL', 'vault:test-support-race',
         ${newId()}, 'DELIVERED', ${orderId}, ${orderId})
    `.execute(ctx.db);

    await sql`
      create or replace function test_support_status_race()
      returns trigger language plpgsql as $$
      begin
        if new.event_type = 'TicketOpened'
           and new.payload_redacted ->> 'correlationId' = 'support-status-race' then
          update support_ticket
             set status = 'WAITING_SHOP', updated_at = now(), version = version + 1
           where id = new.aggregate_id and status = 'OPEN';
        end if;
        return new;
      end $$;
      drop trigger if exists test_support_status_race on outbox_event;
      create trigger test_support_status_race
        after insert on outbox_event
        for each row execute function test_support_status_race();
    `.execute(ctx.db);

    const input = {
      customerId,
      orderId,
      reasonCode: "ASSET_NOT_WORKING" as const,
      description: "Tài khoản không hoạt động.",
      correlationId: "support-status-race",
    };
    try {
      const first = await createSupportService(ctx.db).openTicket(input);
      expect(first).toMatchObject({ ok: true, status: "WAITING_SHOP" });
      if (!first.ok) return;

      const replacementCount = await sql<{ count: string }>`
        select count(*)::text as count
        from replacement_case
        where order_id = ${orderId}
      `.execute(ctx.db);
      expect(replacementCount.rows[0]?.count).toBe("1");

      const replay = await createSupportService(ctx.db).openTicket(input);
      expect(replay).toMatchObject({ ok: true, ticketId: first.ticketId });
      const replayCount = await sql<{ count: string }>`
        select count(*)::text as count
        from replacement_case
        where order_id = ${orderId}
      `.execute(ctx.db);
      expect(replayCount.rows[0]?.count).toBe("1");
    } finally {
      await sql`
        drop trigger if exists test_support_status_race on outbox_event;
        drop function if exists test_support_status_race();
      `.execute(ctx.db);
    }
  });

  it("retries the intended replacement on an idempotent TicketOpened replay after the first attempt has no asset", async () => {
    const { customerId, orderId } = await seedCustomerWithOrder();
    const input = {
      customerId,
      orderId,
      reasonCode: "ASSET_NOT_WORKING" as const,
      description: "Tài khoản không hoạt động.",
      correlationId: "support-replacement-replay",
    };

    const first = await createSupportService(ctx.db).openTicket(input);
    expect(first).toMatchObject({ ok: true, status: "OPEN" });
    const firstCount = await sql<{ count: string }>`
      select count(*)::text as count from replacement_case where order_id = ${orderId}
    `.execute(ctx.db);
    expect(firstCount.rows[0]?.count).toBe("0");

    const variant = await sql<{ variant_id: string }>`
      select variant_id from "order" where id = ${orderId}
    `.execute(ctx.db);
    const assetId = newId();
    await sql`
      insert into digital_asset
        (id, variant_id, source_type, vault_ref, fingerprint_hash, status,
         reserved_order_id, delivered_order_id)
      values
        (${assetId}, ${variant.rows[0]!.variant_id}, 'LOCAL', 'vault:test-support-replay',
         ${newId()}, 'DELIVERED', ${orderId}, ${orderId})
    `.execute(ctx.db);

    const unrelatedAuditId = newId();
    const existingCaseId = newId();
    await sql`
      insert into audit_event
        (id, actor_type, action, target_type, target_id, reason, correlation_id, metadata_redacted)
      values
        (${unrelatedAuditId}, 'SYSTEM', 'digital.replacement.open', 'ReplacementCase',
         ${existingCaseId}, 'existing replacement audit', 'existing-replacement-audit', '{}'::jsonb)
    `.execute(ctx.db);
    await sql`
      insert into replacement_case
        (id, order_id, original_asset_id, reason_code, status, audit_event_id)
      values
        (${existingCaseId}, ${orderId}, ${assetId}, 'INVALID_CREDENTIAL', 'OPEN', ${unrelatedAuditId})
    `.execute(ctx.db);

    const replay = await createSupportService(ctx.db).openTicket({
      ...input,
      orderId: newId(),
      reasonCode: "GENERAL_QUESTION",
      description: "",
    });
    expect(replay).toMatchObject({ ok: true, ticketId: first.ok ? first.ticketId : undefined });
    if (!first.ok || !replay.ok) return;
    expect(replay.replacementCaseId).toBeTruthy();
    expect(replay.replacementCaseId).toBe(existingCaseId);

    await sql`
      update replacement_case
      set status = 'CLOSED', resolved_at = now()
      where id = ${replay.replacementCaseId}
    `.execute(ctx.db);
    await sql`update "order" set status = 'CANCELLED' where id = ${orderId}`.execute(ctx.db);
    const replayAgain = await createSupportService(ctx.db).openTicket(input);
    expect(replayAgain).toMatchObject({
      ok: true,
      ticketId: first.ticketId,
      replacementCaseId: replay.replacementCaseId,
    });
    const link = await sql<{ audit_event_id: string | null }>`
      select audit_event_id from replacement_case where id = ${existingCaseId}
    `.execute(ctx.db);
    expect(link.rows[0]?.audit_event_id).toBe(unrelatedAuditId);
    const replacementCount = await sql<{ count: string }>`
      select count(*)::text as count
      from replacement_case
      where order_id = ${orderId} and reason_code = 'INVALID_CREDENTIAL'
    `.execute(ctx.db);
    expect(replacementCount.rows[0]?.count).toBe("1");
  });

  it("observes a concurrent owner transition before returning an existing draft", async () => {
    const { customerId, orderId } = await seedCustomerWithOrder();
    const svc = createSupportService(ctx.db);
    const draft = await svc.beginDescription({
      customerId,
      orderId,
      reasonCode: "GENERAL_QUESTION",
      correlationId: "support-draft-owner-race",
    });
    expect(draft.ok).toBe(true);
    if (!draft.ok) return;

    await sql`
      create or replace function test_support_draft_owner_race()
      returns trigger language plpgsql as $$
      begin
        if old.status = 'WAITING_CUSTOMER' and new.status = 'WAITING_SHOP' then
          perform pg_advisory_xact_lock(742003);
        end if;
        return new;
      end $$;
      drop trigger if exists test_support_draft_owner_race on support_ticket;
      create trigger test_support_draft_owner_race
        before update of status on support_ticket
        for each row execute function test_support_draft_owner_race();
    `.execute(ctx.db);

    const blocker = await ctx.handle.pool.connect();
    try {
      await blocker.query("select pg_advisory_lock(742003)");
      const ownerTransition = setTicketStatus({
        db: ctx.db,
        ticketId: draft.ticketId,
        toStatus: "WAITING_SHOP",
        expectedVersion: 1,
        actorId: "admin-draft-race",
        correlationId: "support-draft-owner-race-status",
      });
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const waiting = await sql<{ count: string }>`
          select count(*)::text as count
          from pg_locks
          where locktype = 'advisory' and not granted
        `.execute(ctx.db);
        if (Number(waiting.rows[0]?.count ?? "0") > 0) break;
        if (attempt === 99) throw new Error("owner transition did not reach the advisory lock");
        await Promise.resolve();
      }

      const readDraft = svc.beginDescription({
        customerId,
        orderId,
        reasonCode: "GENERAL_QUESTION",
        correlationId: "support-draft-owner-race-replay",
      });
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const waiting = await sql<{ count: string }>`
          select count(*)::text as count
          from pg_stat_activity
          where datname = current_database()
            and wait_event_type = 'Lock'
            and pid <> pg_backend_pid()
        `.execute(ctx.db);
        if (Number(waiting.rows[0]?.count ?? "0") > 1) break;
        if (attempt === 99) throw new Error("draft read did not reach the row lock");
        await Promise.resolve();
      }
      await blocker.query("select pg_advisory_unlock(742003)");

      await expect(ownerTransition).resolves.toMatchObject({
        ok: true,
        from: "WAITING_CUSTOMER",
        to: "WAITING_SHOP",
      });
      await expect(readDraft).resolves.toMatchObject({
        ok: false,
        code: "ALREADY_SUBMITTED",
      });
    } finally {
      await blocker.query("select pg_advisory_unlock_all()").catch(() => undefined);
      blocker.release();
      await sql`
        drop trigger if exists test_support_draft_owner_race on support_ticket;
        drop function if exists test_support_draft_owner_race();
      `.execute(ctx.db);
    }
  });

  it("rejects a stale status callback after another owner action changes the ticket", async () => {
    const { ticketId } = await openTicket();
    await setTicketStatus({
      db: ctx.db,
      ticketId,
      toStatus: "WAITING_SHOP",
      expectedVersion: 1,
      actorId: "admin-1",
      correlationId: "admin-support-first",
    });

    const staleInput = {
      db: ctx.db,
      ticketId,
      toStatus: "RESOLVED",
      expectedVersion: 1,
      actorId: "admin-1",
      correlationId: "admin-support-stale",
    };
    const result = await setTicketStatus(staleInput);

    expect(result).toEqual({ ok: false, code: "STALE_VERSION" });
    const row = await sql<{ status: string; version: number }>`
      select status, version from support_ticket where id = ${ticketId}
    `.execute(ctx.db);
    expect(row.rows[0]).toEqual({ status: "WAITING_SHOP", version: 2 });
    const audit = await sql<{ count: string }>`
      select count(*)::text as count
      from audit_event
      where target_type = 'SupportTicket' and target_id = ${ticketId}
    `.execute(ctx.db);
    expect(audit.rows[0]?.count).toBe("1");
  });

  it("refuses a transition the state machine forbids and leaves the row alone", async () => {
    const { ticketId } = await openTicket();
    await setTicketStatus({
      db: ctx.db,
      ticketId,
      expectedVersion: 1,
      toStatus: "RESOLVED",
      actorId: "admin-1",
      correlationId: "admin-support-resolve",
    });

    const result = await setTicketStatus({
      db: ctx.db,
      ticketId,
      expectedVersion: 2,
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
      expectedVersion: 1,
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
      expectedVersion: 1,
      actorId: "admin-1",
      correlationId: "admin-support-missing",
    });

    expect(result).toEqual({ ok: false, code: "NOT_FOUND" });
    expect(await getAdminTicket(ctx.db, newId())).toBeNull();
  });
});
