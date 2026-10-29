import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { sql } from "kysely";
import { createApp } from "../../src/app.js";
import {
  createRootProductDraftTextIngress,
  createSupportDescriptionTextIngress,
} from "../../src/bot/telegram-ingress-resolvers.js";
import {
  createPostgresTelegramInbox,
  type TelegramCommandEnvelope,
  type TelegramInbox,
} from "../../src/infrastructure/inbox/telegram.js";
import type { RootProductDraftTextIngress } from "../../src/bot/webhook.js";
import type { Vault } from "../../src/infrastructure/vault/port.js";
import { newId } from "../../src/shared/ids/index.js";
import { startPostgresContainer, type PgTestContext } from "../helpers/pg-container.js";

const WEBHOOK_SECRET = ["telegram", "support", "ingress", "review"].join("-");
const HEADERS = {
  "content-type": "application/json",
  "x-telegram-bot-api-secret-token": WEBHOOK_SECRET,
};

let ctx: PgTestContext;

beforeAll(async () => {
  ctx = await startPostgresContainer();
}, 180_000);

afterAll(async () => {
  await ctx?.teardown();
});

beforeEach(async () => {
  await sql`truncate table telegram_rate_limit_bucket, webhook_inbox`.execute(ctx.db);
});

function fakeVault(): Vault {
  return {
    write: vi.fn(),
    reveal: vi.fn(),
    delete: vi.fn(),
  } as unknown as Vault;
}

async function seedWaitingTicket(telegramUserId: string): Promise<{
  customerId: string;
  ticketId: string;
}> {
  const customerId = newId();
  const ticketId = newId();
  await sql`
    insert into customer (id, status, locale)
    values (${customerId}, 'ACTIVE', 'vi')
  `.execute(ctx.db);
  await sql`
    insert into channel_identity (id, customer_id, channel, channel_user_id)
    values (${newId()}, ${customerId}, 'TELEGRAM', ${telegramUserId})
  `.execute(ctx.db);
  await sql`
    insert into support_ticket
      (id, customer_id, reason_code, status, safe_summary)
    values
      (${ticketId}, ${customerId}, 'OTHER', 'WAITING_CUSTOMER', 'Đang chờ mô tả.')
  `.execute(ctx.db);
  return { customerId, ticketId };
}

async function createIngressApp(
  inbox: TelegramInbox,
  options: {
    rootProductDraftText?: RootProductDraftTextIngress;
    supportDescriptionText?: { resolveTicketId(telegramUserId: string): Promise<string | null> };
  } = {},
) {
  return createApp({
    db: ctx.db,
    vault: fakeVault(),
    telegram: {
      path: "/telegram/webhook",
      secretToken: WEBHOOK_SECRET,
      inbox,
      supportDescriptionText:
        options.supportDescriptionText ??
        createSupportDescriptionTextIngress({
          db: ctx.db,
          logger: { error: vi.fn() },
        }),
      ...(options.rootProductDraftText === undefined
        ? {}
        : { rootProductDraftText: options.rootProductDraftText }),
    },
    sepay: { path: "/sepay", handler: vi.fn() },
    bodyLimitBytes: 16_384,
    logger: false,
  });
}

describe("support-description ingress review regressions", () => {
  it("keeps ticket A in one durable row when an exact replay sees sole waiting ticket B", async () => {
    const actorUserId = "701234601";
    const ticketA = await seedWaitingTicket(actorUserId);
    const inbox = createPostgresTelegramInbox(ctx.db);
    const app = await createIngressApp(inbox);
    const raw = JSON.stringify({
      update_id: 9601,
      message: {
        message_id: 1,
        from: { id: Number(actorUserId) },
        chat: { id: Number(actorUserId), type: "private" },
        text: "Mô tả ticket A.",
      },
    });
    try {
      const first = await app.inject({
        method: "POST",
        url: "/telegram/webhook",
        headers: HEADERS,
        payload: raw,
      });
      expect(first.statusCode).toBe(200);

      await sql`
        update support_ticket
        set status = 'CLOSED', updated_at = now(), version = version + 1
        where id = ${ticketA.ticketId}
      `.execute(ctx.db);
      const ticketB = newId();
      await sql`
        insert into support_ticket
          (id, customer_id, reason_code, status, safe_summary)
        values
          (${ticketB}, ${ticketA.customerId}, 'OTHER', 'WAITING_CUSTOMER', 'B vẫn nguyên vẹn.')
      `.execute(ctx.db);

      const duplicate = await app.inject({
        method: "POST",
        url: "/telegram/webhook",
        headers: HEADERS,
        payload: raw,
      });
      expect(duplicate.statusCode).toBe(200);
      expect(duplicate.json()).toMatchObject({ ok: true, duplicate: true });

      const durable = await sql<{ envelope: TelegramCommandEnvelope }>`
        select envelope
        from webhook_inbox
        where source_event_id = '9601'
      `.execute(ctx.db);
      expect(durable.rows).toHaveLength(1);
      expect(durable.rows[0]?.envelope).toMatchObject({
        supportDescriptionText: true,
        supportDescriptionTicketId: ticketA.ticketId,
      });
      const tickets = await sql<{ id: string; status: string; safe_summary: string }>`
        select id, status, safe_summary
        from support_ticket
        where id in (${ticketA.ticketId}, ${ticketB})
        order by id
      `.execute(ctx.db);
      expect(tickets.rows).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: ticketA.ticketId, status: "CLOSED" }),
          expect.objectContaining({
            id: ticketB,
            status: "WAITING_CUSTOMER",
            safe_summary: "B vẫn nguyên vẹn.",
          }),
        ]),
      );
    } finally {
      await app.close();
    }
  });

  it("omits a quoted reply secret from a marked support envelope", async () => {
    const actorUserId = "701234602";
    const ticket = await seedWaitingTicket(actorUserId);
    const inbox = createPostgresTelegramInbox(ctx.db);
    const app = await createIngressApp(inbox);
    try {
      const response = await app.inject({
        method: "POST",
        url: "/telegram/webhook",
        headers: HEADERS,
        payload: {
          update_id: 9602,
          message: {
            message_id: 2,
            from: { id: Number(actorUserId) },
            chat: { id: Number(actorUserId), type: "private" },
            text: "Không đăng nhập được.",
            reply_to_message: {
              message_id: 1,
              from: { id: 999999999, is_bot: true },
              text: "quoted-secret-fixture-should-not-persist",
            },
          },
        },
      });
      expect(response.statusCode).toBe(200);
      const stored = await sql<{ envelope: TelegramCommandEnvelope }>`
        select envelope from webhook_inbox where source_event_id = '9602'
      `.execute(ctx.db);
      const envelope = stored.rows[0]?.envelope;
      expect(envelope).toMatchObject({
        supportDescriptionText: true,
        supportDescriptionTicketId: ticket.ticketId,
      });
      expect(envelope).not.toHaveProperty("replyToText");
      expect(JSON.stringify(envelope)).not.toContain("quoted-secret-fixture");
    } finally {
      await app.close();
    }
  });

  it("lets an active root product draft claim text before a pending support ticket", async () => {
    const actorUserId = "701234603";
    const ticket = await seedWaitingTicket(actorUserId);
    await sql`
      insert into admin_workflow (admin_telegram_user_id, step, expires_at)
      values (${actorUserId}, 'name', now() + interval '10 minutes')
    `.execute(ctx.db);
    const inbox = createPostgresTelegramInbox(ctx.db);
    const app = await createIngressApp(inbox, {
      rootProductDraftText: createRootProductDraftTextIngress({
        db: ctx.db,
        adminTelegramUserId: Number(actorUserId),
      }),
    });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/telegram/webhook",
        headers: HEADERS,
        payload: {
          update_id: 9603,
          message: {
            message_id: 3,
            from: { id: Number(actorUserId) },
            chat: { id: Number(actorUserId), type: "private" },
            text: "Tên sản phẩm mới",
          },
        },
      });
      expect(response.statusCode).toBe(200);
      const stored = await sql<{ envelope: TelegramCommandEnvelope }>`
        select envelope from webhook_inbox where source_event_id = '9603'
      `.execute(ctx.db);
      expect(stored.rows[0]?.envelope).toMatchObject({
        rootProductDraftText: true,
        messageText: "Tên sản phẩm mới",
      });
      expect(stored.rows[0]?.envelope.supportDescriptionText).toBeUndefined();
      expect(stored.rows[0]?.envelope.supportDescriptionTicketId).toBeUndefined();
      const support = await sql<{ status: string }>`
        select status from support_ticket where id = ${ticket.ticketId}
      `.execute(ctx.db);
      expect(support.rows[0]?.status).toBe("WAITING_CUSTOMER");
    } finally {
      await app.close();
    }
  });

  it("returns retryable 503 when support ticket lookup fails without creating an inbox row", async () => {
    const resolver = vi.fn().mockRejectedValue(new Error("database lookup failed"));
    const inbox = createPostgresTelegramInbox(ctx.db);
    const app = await createIngressApp(inbox, {
      supportDescriptionText: { resolveTicketId: resolver },
    });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/telegram/webhook",
        headers: HEADERS,
        payload: {
          update_id: 9604,
          message: {
            message_id: 4,
            from: { id: 701234604 },
            chat: { id: 701234604, type: "private" },
            text: "Mô tả cần thử lại.",
          },
        },
      });
      expect(response.statusCode).toBe(503);
      expect(response.headers["retry-after"]).toBe("1");
      expect(response.json()).toEqual({ ok: false, retryable: true });
      expect(resolver).toHaveBeenCalledWith("701234604");
      const rows = await sql<{ count: number }>`
        select count(*)::int as count from webhook_inbox where source_event_id = '9604'
      `.execute(ctx.db);
      expect(rows.rows[0]?.count).toBe(0);
    } finally {
      await app.close();
    }
  });
});
