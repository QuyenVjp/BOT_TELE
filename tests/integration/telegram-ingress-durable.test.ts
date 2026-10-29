import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { sql } from "kysely";
import { createCallbackTokenCodec } from "../../src/bot/callback-codec.js";
import { createApp } from "../../src/app.js";
import { createTelegramDomainDispatcher } from "../../src/bot/callbacks/telegram-dispatch.js";
import {
  createPostgresTelegramInbox,
  processTelegramInboxBatch,
  type TelegramCommandEnvelope,
  type TelegramInbox,
} from "../../src/infrastructure/inbox/telegram.js";
import { newId } from "../../src/shared/ids/index.js";
import { createPostgresRateLimiter } from "../../src/modules/risk/service.js";
import type { Vault } from "../../src/infrastructure/vault/port.js";
import { createSupportCallbacks } from "../../src/bot/callbacks/support.js";
import {
  createOwnerPromptTextIngress,
  createRootProductDraftTextIngress,
  createSupportDescriptionTextIngress,
} from "../../src/bot/telegram-ingress-resolvers.js";
import type {
  AdminOwnerPromptTextIngress,
  RootProductDraftTextIngress,
  SupportDescriptionTextIngress,
} from "../../src/bot/webhook.js";
import { startPostgresContainer, type PgTestContext } from "../helpers/pg-container.js";

const WEBHOOK_HEADER_VALUE = "telegram-webhook-fixture-value";
const HEADERS = {
  "content-type": "application/json",
  "x-telegram-bot-api-secret-token": WEBHOOK_HEADER_VALUE,
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

function envelope(overrides: Partial<TelegramCommandEnvelope> = {}): TelegramCommandEnvelope {
  return {
    actorUserId: "123456789",
    chatId: "123456789",
    chatType: "private",
    messageId: "10",
    action: "BUY_NOW",
    callbackData: "buy:opaque-signed-token",
    ...overrides,
  };
}

function fakeVault(): Vault {
  return {
    write: vi.fn(),
    reveal: vi.fn(),
    delete: vi.fn(),
  } as unknown as Vault;
}

async function seedSupportDescriptionState(input: {
  telegramUserId: string;
  pendingCount?: number;
  channel?: string;
}): Promise<{ customerId: string; ticketIds: string[] }> {
  const customerId = newId();
  const ticketIds: string[] = [];
  await sql`
    insert into customer (id, status, locale)
    values (${customerId}, 'ACTIVE', 'vi')
  `.execute(ctx.db);
  await sql`
    insert into channel_identity (id, customer_id, channel, channel_user_id)
    values (${newId()}, ${customerId}, ${input.channel ?? "TELEGRAM"}, ${input.telegramUserId})
  `.execute(ctx.db);
  for (let index = 0; index < (input.pendingCount ?? 0); index += 1) {
    const ticketId = newId();
    ticketIds.push(ticketId);
    await sql`
      insert into support_ticket
        (id, customer_id, reason_code, status, safe_summary)
      values
        (${ticketId}, ${customerId}, 'OTHER', 'WAITING_CUSTOMER', 'Đang chờ mô tả.')
    `.execute(ctx.db);
  }
  return { customerId, ticketIds };
}

async function seedRootProductDraftState(input: {
  adminTelegramUserId: string;
  remediationPrompt?: boolean;
}): Promise<void> {
  const expiresAt = new Date(Date.now() + 60_000);
  await sql`
    insert into admin_workflow (admin_telegram_user_id, step, expires_at)
    values (${input.adminTelegramUserId}, 'sku', ${expiresAt})
  `.execute(ctx.db);
  if (input.remediationPrompt) {
    await sql`
      insert into admin_callback_state
        (id, admin_telegram_user_id, kind, expires_at)
      values
        (${newId()}, ${input.adminTelegramUserId}, 'ADMIN_RESALE_EVIDENCE_PROMPT', ${expiresAt})
    `.execute(ctx.db);
  }
}

async function createSupportIngressApp(
  inbox: TelegramInbox,
  options: {
    rootProductDraftText?: RootProductDraftTextIngress;
    supportDescriptionText?: SupportDescriptionTextIngress;
    ownerPromptText?: AdminOwnerPromptTextIngress;
  } = {},
) {
  return createApp({
    db: ctx.db,
    vault: fakeVault(),
    telegram: {
      path: "/telegram/webhook",
      secretToken: WEBHOOK_HEADER_VALUE,
      inbox,
      ...(options.rootProductDraftText
        ? { rootProductDraftText: options.rootProductDraftText }
        : {}),
      ...(options.ownerPromptText ? { ownerPromptText: options.ownerPromptText } : {}),
      supportDescriptionText:
        options.supportDescriptionText ??
        createSupportDescriptionTextIngress({
          db: ctx.db,
          logger: { error: vi.fn() },
        }),
    },
    sepay: { path: "/sepay", handler: vi.fn() },
    bodyLimitBytes: 16_384,
    logger: false,
  });
}
function createDbSupportDispatcher() {
  const search = vi.fn().mockResolvedValue({ text: "catalog", buttons: [] });
  const send = vi.fn().mockResolvedValue(null);
  const ownerPromptText = vi.fn().mockResolvedValue({ text: "owner prompt handled", buttons: [] });
  const dispatcher = createTelegramDomainDispatcher({
    codec: createCallbackTokenCodec({
      key: "test-only-support-dispatch-key-material",
      keyVersion: 1,
      ttlSeconds: 900,
      clockSkewSeconds: 5,
    }),
    resolveCustomerId: async (telegramUserId) => {
      const row = await sql<{ customer_id: string }>`
        select customer_id
        from channel_identity
        where channel = 'TELEGRAM' and channel_user_id = ${telegramUserId}
        limit 1
      `.execute(ctx.db);
      return row.rows[0]?.customer_id ?? null;
    },
    resolveOrderByIdForOwner: vi.fn().mockResolvedValue(null),
    resolveOrderIdByNumber: vi.fn().mockResolvedValue(null),
    resolveCatalogPage: vi.fn().mockResolvedValue(null),
    catalog: {
      mainMenu: vi.fn().mockResolvedValue({ text: "home", buttons: [] }),
      categoryList: vi.fn().mockResolvedValue({ text: "categories", buttons: [] }),
      categoryView: vi.fn().mockResolvedValue({ text: "category", buttons: [] }),
      variantDetail: vi.fn().mockResolvedValue({ text: "variant", buttons: [] }),
      search,
    },
    checkout: {
      buyNowFromCallback: vi.fn(),
      refresh: vi.fn(),
      reopen: vi.fn(),
      cancel: vi.fn(),
    },
    history: {
      list: vi.fn(),
      detail: vi.fn(),
    },
    support: createSupportCallbacks({ db: ctx.db }),
    admin: {
      handleToken: vi.fn().mockResolvedValue({ text: "admin token handled", buttons: [] }),
      ownerPromptText,
    },
    responder: { send },
  });
  return { dispatcher, search, send, ownerPromptText };
}

describe("durable Telegram inbox T121/T126", () => {
  it("commits a bounded envelope before HTTP acknowledgement and stores no raw message text", async () => {
    const inbox = createPostgresTelegramInbox(ctx.db);
    const app = await createApp({
      db: ctx.db,
      vault: fakeVault(),
      telegram: {
        path: "/telegram/webhook",
        secretToken: WEBHOOK_HEADER_VALUE,
        inbox,
      },
      sepay: { path: "/sepay", handler: vi.fn() },
      bodyLimitBytes: 4096,
      logger: false,
    });
    try {
      const raw = JSON.stringify({
        update_id: 101,
        message: {
          message_id: 10,
          from: { id: 123456789, username: "must-not-persist" },
          chat: { id: 123456789, type: "private" },
          text: "/support pasted-secret-must-not-persist",
        },
      });
      const response = await app.inject({
        method: "POST",
        url: "/telegram/webhook",
        headers: HEADERS,
        payload: raw,
      });
      expect(response.statusCode).toBe(200);
      const stored = await sql<{
        processing_status: string;
        envelope: TelegramCommandEnvelope;
        raw_hash: string;
      }>`select processing_status, envelope, raw_hash from webhook_inbox where source_event_id = '101'`.execute(
        ctx.db,
      );
      expect(stored.rows[0]?.processing_status).toBe("RETRY");
      expect(stored.rows[0]?.envelope).toMatchObject({
        actorUserId: "123456789",
        action: "SUPPORT",
      });
      expect(JSON.stringify(stored.rows[0])).not.toContain("pasted-secret");
      expect(JSON.stringify(stored.rows[0])).not.toContain("must-not-persist");
      expect(stored.rows[0]?.raw_hash).toMatch(/^[a-f0-9]{64}$/);
    } finally {
      await app.close();
    }
  });
  it("admits one active private support description as a marked redacted envelope", async () => {
    const actorUserId = "701234501";
    const state = await seedSupportDescriptionState({
      telegramUserId: actorUserId,
      pendingCount: 1,
    });
    const inbox = createPostgresTelegramInbox(ctx.db);
    const app = await createSupportIngressApp(inbox);
    const secret = "test-placeholder-value";
    try {
      const quotedSecret = "quoted-placeholder-value";
      const response = await app.inject({
        method: "POST",
        url: "/telegram/webhook",
        headers: HEADERS,
        payload: {
          update_id: 111,
          message: {
            message_id: 12,
            from: { id: Number(actorUserId) },
            chat: { id: Number(actorUserId), type: "private" },
            text: `Mật khẩu\u200B= ${secret}; tài khoản không đăng nhập được.`,
            reply_to_message: {
              message_id: 11,
              from: { id: Number(actorUserId) },
              text: `Thông tin trích dẫn: ${quotedSecret}`,
            },
          },
        },
      });
      expect(response.statusCode).toBe(200);

      const stored = await sql<{ envelope: TelegramCommandEnvelope }>`
        select envelope
        from webhook_inbox
        where source_event_id = '111'
      `.execute(ctx.db);
      const durableEnvelope = stored.rows[0]?.envelope;
      expect(durableEnvelope).toMatchObject({
        action: "SUPPORT",
        supportDescriptionText: true,
        supportDescriptionTicketId: state.ticketIds[0],
      });
      const summary = durableEnvelope?.messageText ?? "";
      expect(summary).not.toContain(secret);
      expect(summary).not.toMatch(/[\p{Cc}\p{Cf}]/u);
      expect(summary.length).toBeLessThanOrEqual(500);
      expect(JSON.stringify(durableEnvelope)).not.toContain(secret);
      expect(JSON.stringify(durableEnvelope)).not.toContain(quotedSecret);
      expect(durableEnvelope?.replyToText).toBeUndefined();

      const claimed: TelegramCommandEnvelope[] = [];
      const processed = await processTelegramInboxBatch({
        inbox,
        limiter: {
          tryConsume: vi.fn().mockResolvedValue({ allowed: true, retryAfterSeconds: 0 }),
        },
        handler: async (claimedEnvelope) => {
          claimed.push(claimedEnvelope);
        },
        owner: "support-description-ingress",
        batchSize: 1,
      });
      expect(processed.processed).toBe(1);
      expect(claimed[0]).toMatchObject({
        supportDescriptionText: true,
        supportDescriptionTicketId: state.ticketIds[0],
      });
    } finally {
      await app.close();
    }
  });

  it("gives active admin text prompts precedence over support descriptions", async () => {
    const actorUserId = "701234509";
    await seedSupportDescriptionState({
      telegramUserId: actorUserId,
      pendingCount: 1,
    });
    await seedRootProductDraftState({ adminTelegramUserId: actorUserId });
    const inbox = createPostgresTelegramInbox(ctx.db);
    const app = await createSupportIngressApp(inbox, {
      rootProductDraftText: createRootProductDraftTextIngress({
        db: ctx.db,
        adminTelegramUserId: Number(actorUserId),
      }),
    });
    try {
      const invalid = await app.inject({
        method: "POST",
        url: "/telegram/webhook",
        headers: HEADERS,
        payload: {
          update_id: 119,
          message: {
            message_id: 19,
            from: { id: Number(actorUserId) },
            chat: { id: Number(actorUserId), type: "private" },
            text: "invalid SKU!",
          },
        },
      });
      expect(invalid.statusCode).toBe(200);
      expect(
        await sql`select 1 from webhook_inbox where source_event_id = '119'`.execute(ctx.db),
      ).toMatchObject({ rows: [] });

      const valid = await app.inject({
        method: "POST",
        url: "/telegram/webhook",
        headers: HEADERS,
        payload: {
          update_id: 120,
          message: {
            message_id: 20,
            from: { id: Number(actorUserId) },
            chat: { id: Number(actorUserId), type: "private" },
            text: "valid_sku-1",
          },
        },
      });
      expect(valid.statusCode).toBe(200);
      const accepted = await sql<{ envelope: TelegramCommandEnvelope }>`
        select envelope from webhook_inbox where source_event_id = '120'
      `.execute(ctx.db);
      expect(accepted.rows[0]?.envelope).toMatchObject({
        action: "ADMIN",
        rootProductDraftText: true,
        messageText: "valid_sku-1",
      });
      expect(accepted.rows[0]?.envelope.supportDescriptionText).toBeUndefined();
      expect(accepted.rows[0]?.envelope.supportDescriptionTicketId).toBeUndefined();
    } finally {
      await app.close();
    }
  });

  it("routes remediation text ahead of a root draft, dispatches it, then redacts raw text", async () => {
    const actorUserId = "701234515";
    const remediationText = "Ghi chú remediation đã được phê duyệt.";
    await seedRootProductDraftState({
      adminTelegramUserId: actorUserId,
      remediationPrompt: true,
    });
    const inbox = createPostgresTelegramInbox(ctx.db);
    const app = await createSupportIngressApp(inbox, {
      rootProductDraftText: createRootProductDraftTextIngress({
        db: ctx.db,
        adminTelegramUserId: Number(actorUserId),
      }),
      ownerPromptText: createOwnerPromptTextIngress({
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
          update_id: 125,
          message: {
            message_id: 25,
            from: { id: Number(actorUserId) },
            chat: { id: Number(actorUserId), type: "private" },
            text: remediationText,
          },
        },
      });
      expect(response.statusCode).toBe(200);
      const persisted = await sql<{ envelope: TelegramCommandEnvelope }>`
        select envelope from webhook_inbox where source_event_id = '125'
      `.execute(ctx.db);
      expect(persisted.rows[0]?.envelope).toMatchObject({
        action: "ADMIN",
        ownerPromptText: true,
        messageText: remediationText,
      });
      expect(persisted.rows[0]?.envelope.rootProductDraftText).toBeUndefined();

      const { dispatcher, ownerPromptText } = createDbSupportDispatcher();
      const processed = await processTelegramInboxBatch({
        inbox,
        limiter: {
          tryConsume: vi.fn().mockResolvedValue({ allowed: true, retryAfterSeconds: 0 }),
        },
        handler: (claimedEnvelope) => dispatcher.handle(claimedEnvelope),
        owner: "owner-remediation",
        batchSize: 1,
      });
      expect(processed.processed).toBe(1);
      expect(ownerPromptText).toHaveBeenCalledWith(
        expect.objectContaining({
          telegramUserId: actorUserId,
          text: remediationText,
          chatType: "private",
        }),
      );

      const redacted = await sql<{
        processing_status: string;
        envelope: TelegramCommandEnvelope;
      }>`
        select processing_status, envelope
        from webhook_inbox
        where source_event_id = '125'
      `.execute(ctx.db);
      expect(redacted.rows[0]?.processing_status).toBe("PROCESSED");
      expect(redacted.rows[0]?.envelope).toMatchObject({
        action: "ADMIN",
        ownerPromptText: true,
        redactedAt: expect.any(String),
      });
      expect(redacted.rows[0]?.envelope).not.toHaveProperty("messageText");
      expect(JSON.stringify(redacted.rows[0]?.envelope)).not.toContain(remediationText);
    } finally {
      await app.close();
    }
  });

  it("returns retryable 503 when the production support resolver cannot query PostgreSQL", async () => {
    const inbox = createPostgresTelegramInbox(ctx.db);
    const logger = { error: vi.fn() };
    const app = await createSupportIngressApp(inbox, {
      supportDescriptionText: createSupportDescriptionTextIngress({
        db: ctx.db,
        logger,
      }),
    });
    try {
      await sql`alter table support_ticket rename to support_ticket_lookup_failure`.execute(ctx.db);
      try {
        const response = await app.inject({
          method: "POST",
          url: "/telegram/webhook",
          headers: HEADERS,
          payload: {
            update_id: 121,
            message: {
              message_id: 21,
              from: { id: 701234510 },
              chat: { id: 701234510, type: "private" },
              text: "Tôi cần trợ giúp.",
            },
          },
        });
        expect(response.statusCode).toBe(503);
        expect(response.headers["retry-after"]).toBe("1");
        expect(response.json()).toMatchObject({ ok: false, retryable: true });
        expect(response.body).not.toContain("support_ticket_lookup_failure");
        expect(
          await sql`select 1 from webhook_inbox where source_event_id = '121'`.execute(ctx.db),
        ).toMatchObject({ rows: [] });
        expect(logger.error).toHaveBeenCalledWith(
          expect.objectContaining({
            event: "support_description_ticket_lookup_failed",
            errorType: expect.any(String),
          }),
          "support description ticket lookup failed",
        );
      } finally {
        await sql`alter table support_ticket_lookup_failure rename to support_ticket`.execute(
          ctx.db,
        );
      }
    } finally {
      await app.close();
    }
  });
  it("returns retryable 503 when the production owner resolver cannot query PostgreSQL", async () => {
    const actorUserId = "701234516";
    const inbox = createPostgresTelegramInbox(ctx.db);
    const app = await createSupportIngressApp(inbox, {
      ownerPromptText: createOwnerPromptTextIngress({
        db: ctx.db,
        adminTelegramUserId: Number(actorUserId),
      }),
    });
    try {
      await sql`alter table admin_callback_state rename to admin_callback_state_lookup_failure`.execute(
        ctx.db,
      );
      try {
        const response = await app.inject({
          method: "POST",
          url: "/telegram/webhook",
          headers: HEADERS,
          payload: {
            update_id: 126,
            message: {
              message_id: 26,
              from: { id: Number(actorUserId) },
              chat: { id: Number(actorUserId), type: "private" },
              text: "Ghi chú remediation phải thử lại.",
            },
          },
        });
        expect(response.statusCode).toBe(503);
        expect(response.headers["retry-after"]).toBe("1");
        expect(response.json()).toEqual({ ok: false, retryable: true });
        expect(response.body).not.toContain("admin_callback_state_lookup_failure");
        expect(
          await sql`select 1 from webhook_inbox where source_event_id = '126'`.execute(ctx.db),
        ).toMatchObject({ rows: [] });
      } finally {
        await sql`alter table admin_callback_state_lookup_failure rename to admin_callback_state`.execute(
          ctx.db,
        );
      }
    } finally {
      await app.close();
    }
  });

  it("returns retryable 503 when the production root resolver cannot query PostgreSQL", async () => {
    const actorUserId = "701234517";
    const inbox = createPostgresTelegramInbox(ctx.db);
    const app = await createSupportIngressApp(inbox, {
      rootProductDraftText: createRootProductDraftTextIngress({
        db: ctx.db,
        adminTelegramUserId: Number(actorUserId),
      }),
    });
    try {
      await sql`alter table admin_workflow rename to admin_workflow_lookup_failure`.execute(ctx.db);
      try {
        const response = await app.inject({
          method: "POST",
          url: "/telegram/webhook",
          headers: HEADERS,
          payload: {
            update_id: 127,
            message: {
              message_id: 27,
              from: { id: Number(actorUserId) },
              chat: { id: Number(actorUserId), type: "private" },
              text: "Tên sản phẩm phải thử lại.",
            },
          },
        });
        expect(response.statusCode).toBe(503);
        expect(response.headers["retry-after"]).toBe("1");
        expect(response.json()).toEqual({ ok: false, retryable: true });
        expect(response.body).not.toContain("admin_workflow_lookup_failure");
        expect(
          await sql`select 1 from webhook_inbox where source_event_id = '127'`.execute(ctx.db),
        ).toMatchObject({ rows: [] });
      } finally {
        await sql`alter table admin_workflow_lookup_failure rename to admin_workflow`.execute(
          ctx.db,
        );
      }
    } finally {
      await app.close();
    }
  });

  it("does not admit text when no WAITING_CUSTOMER ticket exists", async () => {
    const actorUserId = "701234512";
    await seedSupportDescriptionState({
      telegramUserId: actorUserId,
      pendingCount: 0,
    });
    const inbox = createPostgresTelegramInbox(ctx.db);
    const app = await createSupportIngressApp(inbox);
    try {
      const response = await app.inject({
        method: "POST",
        url: "/telegram/webhook",
        headers: HEADERS,
        payload: {
          update_id: 122,
          message: {
            message_id: 22,
            from: { id: Number(actorUserId) },
            chat: { id: Number(actorUserId), type: "private" },
            text: "Không có ticket đang chờ.",
          },
        },
      });
      expect(response.statusCode).toBe(200);
      expect(
        await sql`select 1 from webhook_inbox where source_event_id = '122'`.execute(ctx.db),
      ).toMatchObject({ rows: [] });
    } finally {
      await app.close();
    }
  });

  it("does not admit text when multiple WAITING_CUSTOMER tickets are active", async () => {
    const actorUserId = "701234513";
    await seedSupportDescriptionState({
      telegramUserId: actorUserId,
      pendingCount: 2,
    });
    const inbox = createPostgresTelegramInbox(ctx.db);
    const app = await createSupportIngressApp(inbox);
    try {
      const response = await app.inject({
        method: "POST",
        url: "/telegram/webhook",
        headers: HEADERS,
        payload: {
          update_id: 123,
          message: {
            message_id: 23,
            from: { id: Number(actorUserId) },
            chat: { id: Number(actorUserId), type: "private" },
            text: "Có nhiều ticket đang chờ.",
          },
        },
      });
      expect(response.statusCode).toBe(200);
      expect(
        await sql`select 1 from webhook_inbox where source_event_id = '123'`.execute(ctx.db),
      ).toMatchObject({ rows: [] });
    } finally {
      await app.close();
    }
  });

  it("does not admit a ticket reached through a non-Telegram channel", async () => {
    const actorUserId = "701234514";
    await seedSupportDescriptionState({
      telegramUserId: actorUserId,
      pendingCount: 1,
      channel: "EMAIL",
    });
    const inbox = createPostgresTelegramInbox(ctx.db);
    const app = await createSupportIngressApp(inbox);
    try {
      const response = await app.inject({
        method: "POST",
        url: "/telegram/webhook",
        headers: HEADERS,
        payload: {
          update_id: 124,
          message: {
            message_id: 24,
            from: { id: Number(actorUserId) },
            chat: { id: Number(actorUserId), type: "private" },
            text: "Ticket không thuộc Telegram.",
          },
        },
      });
      expect(response.statusCode).toBe(200);
      expect(
        await sql`select 1 from webhook_inbox where source_event_id = '124'`.execute(ctx.db),
      ).toMatchObject({ rows: [] });
    } finally {
      await app.close();
    }
  });

  it("dispatches a normal description to the exact persisted ticket id", async () => {
    const actorUserId = "701234507";
    const state = await seedSupportDescriptionState({
      telegramUserId: actorUserId,
      pendingCount: 1,
    });
    const inbox = createPostgresTelegramInbox(ctx.db);
    const app = await createSupportIngressApp(inbox);
    try {
      const response = await app.inject({
        method: "POST",
        url: "/telegram/webhook",
        headers: HEADERS,
        payload: {
          update_id: 117,
          message: {
            message_id: 17,
            from: { id: Number(actorUserId) },
            chat: { id: Number(actorUserId), type: "private" },
            text: "Thiết bị không đăng nhập được.",
          },
        },
      });
      expect(response.statusCode).toBe(200);
      const persisted = await sql<{ envelope: TelegramCommandEnvelope }>`
        select envelope from webhook_inbox where source_event_id = '117'
      `.execute(ctx.db);
      expect(persisted.rows[0]?.envelope).toMatchObject({
        action: "SUPPORT",
        supportDescriptionText: true,
        supportDescriptionTicketId: state.ticketIds[0],
        messageText: "Thiết bị không đăng nhập được.",
      });
      const identity = await sql<{ customer_id: string }>`
        select customer_id from channel_identity
        where channel = 'TELEGRAM' and channel_user_id = ${actorUserId}
      `.execute(ctx.db);
      expect(identity.rows).toEqual([{ customer_id: state.customerId }]);
      const { dispatcher, search } = createDbSupportDispatcher();
      const processed = await processTelegramInboxBatch({
        inbox,
        limiter: {
          tryConsume: vi.fn().mockResolvedValue({ allowed: true, retryAfterSeconds: 0 }),
        },
        handler: (claimedEnvelope) => dispatcher.handle(claimedEnvelope),
        owner: "support-description-normal",
        batchSize: 1,
      });
      expect(processed.processed).toBe(1);
      const ticket = await sql<{ id: string; status: string; safe_summary: string }>`
        select id, status, safe_summary
        from support_ticket
        where id = ${state.ticketIds[0]} and customer_id = ${state.customerId}
      `.execute(ctx.db);
      expect(ticket.rows[0]).toMatchObject({
        id: state.ticketIds[0],
        status: "WAITING_SHOP",
        safe_summary: "Thiết bị không đăng nhập được.",
      });
      expect(search).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("does not retarget a queued description after its original ticket becomes stale", async () => {
    const actorUserId = "701234508";
    const state = await seedSupportDescriptionState({
      telegramUserId: actorUserId,
      pendingCount: 1,
    });
    const inbox = createPostgresTelegramInbox(ctx.db);
    const app = await createSupportIngressApp(inbox);
    try {
      const update = {
        update_id: 118,
        message: {
          message_id: 18,
          from: { id: Number(actorUserId) },
          chat: { id: Number(actorUserId), type: "private" },
          text: "Mô tả đã xếp hàng.",
        },
      };
      const response = await app.inject({
        method: "POST",
        url: "/telegram/webhook",
        headers: HEADERS,
        payload: update,
      });
      expect(response.statusCode).toBe(200);
      const ticketB = newId();
      await sql`
        update support_ticket
        set status = 'CLOSED', updated_at = now(), version = version + 1
        where id = ${state.ticketIds[0]} and customer_id = ${state.customerId}
      `.execute(ctx.db);
      await sql`
        insert into support_ticket
          (id, customer_id, reason_code, status, safe_summary)
        values
          (${ticketB}, ${state.customerId}, 'OTHER', 'WAITING_CUSTOMER', 'Ticket mới đang chờ.')
      `.execute(ctx.db);
      const duplicateResponse = await app.inject({
        method: "POST",
        url: "/telegram/webhook",
        headers: HEADERS,
        payload: update,
      });
      expect(duplicateResponse.statusCode).toBe(200);
      expect(duplicateResponse.json()).toMatchObject({ ok: true, duplicate: true });
      const persisted = await sql<{ envelope: TelegramCommandEnvelope }>`
        select envelope from webhook_inbox where source_event_id = '118'
      `.execute(ctx.db);
      expect(persisted.rows[0]?.envelope.supportDescriptionTicketId).toBe(state.ticketIds[0]);

      const { dispatcher, search, send } = createDbSupportDispatcher();
      const processed = await processTelegramInboxBatch({
        inbox,
        limiter: {
          tryConsume: vi.fn().mockResolvedValue({ allowed: true, retryAfterSeconds: 0 }),
        },
        handler: (claimedEnvelope) => dispatcher.handle(claimedEnvelope),
        owner: "support-description-race",
        batchSize: 1,
      });
      expect(processed.processed).toBe(1);
      const tickets = await sql<{ id: string; status: string; safe_summary: string }>`
        select id, status, safe_summary
        from support_ticket
        where id in (${state.ticketIds[0]}, ${ticketB})
        order by id
      `.execute(ctx.db);
      expect(tickets.rows).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: state.ticketIds[0], status: "CLOSED" }),
          expect.objectContaining({ id: ticketB, status: "WAITING_CUSTOMER" }),
        ]),
      );
      expect(tickets.rows.find((ticket) => ticket.id === ticketB)?.safe_summary).toBe(
        "Ticket mới đang chờ.",
      );
      expect(search).not.toHaveBeenCalled();
      expect(send).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.objectContaining({
            text: "Ticket này đã được gửi hoặc đã đóng.",
          }),
        }),
      );
    } finally {
      await app.close();
    }
  });
  it("drops support descriptions without one exact pending identity or in group chats", async () => {
    const noPendingUserId = "701234502";
    const multiplePendingUserId = "701234503";
    const groupUserId = "701234504";
    const channelUserId = "701234506";
    const missingIdentityUserId = "701234505";
    await seedSupportDescriptionState({ telegramUserId: noPendingUserId });
    await seedSupportDescriptionState({ telegramUserId: multiplePendingUserId, pendingCount: 2 });
    await seedSupportDescriptionState({ telegramUserId: channelUserId, pendingCount: 1 });
    await seedSupportDescriptionState({ telegramUserId: groupUserId, pendingCount: 1 });
    const inbox = createPostgresTelegramInbox(ctx.db);
    const app = await createSupportIngressApp(inbox);
    try {
      for (const input of [
        {
          update_id: 112,
          actor: noPendingUserId,
          chat: { id: Number(noPendingUserId), type: "private" },
        },
        {
          update_id: 113,
          actor: multiplePendingUserId,
          chat: { id: Number(multiplePendingUserId), type: "private" },
        },
        {
          update_id: 114,
          actor: groupUserId,
          chat: { id: -Number(groupUserId), type: "group" },
        },
        {
          update_id: 116,
          actor: channelUserId,
          chat: { id: -Number(channelUserId), type: "channel" },
        },
        {
          update_id: 115,
          actor: missingIdentityUserId,
          chat: { id: Number(missingIdentityUserId), type: "private" },
        },
      ] as const) {
        const response = await app.inject({
          method: "POST",
          url: "/telegram/webhook",
          headers: HEADERS,
          payload: {
            update_id: input.update_id,
            message: {
              message_id: input.update_id,
              from: { id: Number(input.actor) },
              chat: input.chat,
              text: "not admitted",
            },
          },
        });
        expect(response.statusCode).toBe(200);
      }
      const rows = await sql<{ count: number }>`
        select count(*)::int as count
        from webhook_inbox
        where source_event_id in ('112', '113', '114', '115', '116')
      `.execute(ctx.db);
      expect(rows.rows[0]?.count).toBe(0);
    } finally {
      await app.close();
    }
  });
  it("keeps a stale marked support description off catalog search", async () => {
    const submitDescription = vi.fn().mockResolvedValue(null);
    const search = vi.fn().mockResolvedValue({ text: "catalog", buttons: [] });
    const send = vi.fn().mockResolvedValue(null);
    const dispatcher = createTelegramDomainDispatcher({
      codec: createCallbackTokenCodec({
        key: "test-only-support-dispatch-key-material",
        keyVersion: 1,
        ttlSeconds: 900,
        clockSkewSeconds: 5,
      }),
      resolveCustomerId: vi.fn().mockResolvedValue("customer"),
      resolveOrderByIdForOwner: vi.fn().mockResolvedValue(null),
      resolveOrderIdByNumber: vi.fn().mockResolvedValue(null),
      resolveCatalogPage: vi.fn().mockResolvedValue(null),
      catalog: {
        mainMenu: vi.fn().mockResolvedValue({ text: "home", buttons: [] }),
        categoryList: vi.fn().mockResolvedValue({ text: "categories", buttons: [] }),
        categoryView: vi.fn().mockResolvedValue({ text: "category", buttons: [] }),
        variantDetail: vi.fn().mockResolvedValue({ text: "variant", buttons: [] }),
        search,
      },
      checkout: {
        buyNowFromCallback: vi.fn(),
        refresh: vi.fn(),
        reopen: vi.fn(),
        cancel: vi.fn(),
      },
      history: {
        list: vi.fn(),
        detail: vi.fn(),
      },
      support: {
        reasonMenu: vi.fn(() => ({ text: "support", buttons: [] })),
        open: vi.fn(),
        beginDescription: vi.fn(),
        submitDescription,
        cancelDescription: vi.fn(),
        list: vi.fn(),
        view: vi.fn(),
        close: vi.fn(),
      },
      responder: { send },
    });

    await dispatcher.handle({
      actorUserId: "701234506",
      chatId: "701234506",
      chatType: "private",
      messageId: "116",
      action: "SUPPORT",
      messageText: "safe support summary",
      supportDescriptionText: true,
      supportDescriptionTicketId: newId(),
    });

    expect(submitDescription).toHaveBeenCalledWith(
      expect.objectContaining({
        customerId: "customer",
        ticketId: expect.any(String),
        description: "safe support summary",
      }),
    );
    expect(search).not.toHaveBeenCalled();
    await dispatcher.handle({
      actorUserId: "701234506",
      chatId: "701234506",
      chatType: "private",
      messageId: "117",
      action: "SUPPORT",
      messageText: "missing ticket binding",
      supportDescriptionText: true,
    });
    expect(submitDescription).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.objectContaining({
          text: "Không tìm thấy yêu cầu hỗ trợ đang chờ.",
        }),
      }),
    );
  });

  it.each(["SUPPORT_TICKET_CLOSE", "SUPPORT_DESCRIPTION_CANCEL"] as const)(
    "classifies signed %s callbacks as SUPPORT at webhook ingress",
    async (action) => {
      const inbox = createPostgresTelegramInbox(ctx.db);
      const app = await createApp({
        db: ctx.db,
        vault: fakeVault(),
        telegram: {
          path: "/telegram/webhook",
          secretToken: WEBHOOK_HEADER_VALUE,
          inbox,
        },
        sepay: { path: "/sepay", handler: vi.fn() },
        bodyLimitBytes: 4096,
      });
      const callbackData = createCallbackTokenCodec({
        key: "test-only-support-callback-key-material",
        keyVersion: 1,
        ttlSeconds: 900,
        clockSkewSeconds: 5,
      }).issue({
        action,
        resourceId: newId(),
        telegramUserId: "123456789",
      });
      try {
        const response = await app.inject({
          method: "POST",
          url: "/telegram/webhook",
          headers: HEADERS,
          payload: {
            update_id: 102,
            callback_query: {
              id: "support-close-callback",
              from: { id: 123456789 },
              data: callbackData,
              message: {
                message_id: 11,
                chat: { id: 123456789, type: "private" },
              },
            },
          },
        });
        expect(response.statusCode).toBe(200);
        const stored = await sql<{ envelope: TelegramCommandEnvelope }>`
        select envelope
        from webhook_inbox
        where source_event_id = '102'
      `.execute(ctx.db);

        expect(stored.rows[0]?.envelope).toMatchObject({ action: "SUPPORT" });
      } finally {
        await app.close();
      }
    },
  );

  it("returns retryable non-2xx when durable receipt fails", async () => {
    const app = await createApp({
      db: ctx.db,
      vault: fakeVault(),
      telegram: {
        path: "/telegram/webhook",
        secretToken: WEBHOOK_HEADER_VALUE,
        inbox: {
          accept: vi.fn().mockRejectedValue(new Error("database unavailable")),
        },
      },
      sepay: { path: "/sepay", handler: vi.fn() },
      bodyLimitBytes: 4096,
      logger: false,
    });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/telegram/webhook",
        headers: HEADERS,
        payload: {
          update_id: 102,
          message: { from: { id: 123 }, chat: { id: 123, type: "private" }, text: "/start" },
        },
      });
      expect(response.statusCode).toBe(503);
    } finally {
      await app.close();
    }
  });

  it("distinguishes an exact duplicate from an update-id hash mutation", async () => {
    const inbox = createPostgresTelegramInbox(ctx.db);
    const first = await inbox.accept({
      sourceEventId: "103",
      rawHash: "a".repeat(64),
      envelope: envelope(),
    });
    const duplicate = await inbox.accept({
      sourceEventId: "103",
      rawHash: "a".repeat(64),
      envelope: envelope(),
    });
    const mutation = await inbox.accept({
      sourceEventId: "103",
      rawHash: "b".repeat(64),
      envelope: envelope(),
    });
    expect(first.kind).toBe("ACCEPTED");
    expect(duplicate.kind).toBe("DUPLICATE");
    expect(mutation.kind).toBe("MUTATION");
    const rows = await sql<{
      count: number;
      mutation_count: number;
      last_mutation_at: Date | null;
    }>`
      select count(*)::int as count, max(mutation_count)::int as mutation_count,
             max(last_mutation_at) as last_mutation_at
      from webhook_inbox
    `.execute(ctx.db);
    expect(rows.rows[0]?.count).toBe(1);
    expect(rows.rows[0]?.mutation_count).toBe(1);
    expect(rows.rows[0]?.last_mutation_at).toBeTruthy();
  });

  it("allows only one of two independently constructed workers to claim a due row", async () => {
    const producer = createPostgresTelegramInbox(ctx.db);
    await producer.accept({ sourceEventId: "104", rawHash: "c".repeat(64), envelope: envelope() });
    const workerA = createPostgresTelegramInbox(ctx.db);
    const workerB = createPostgresTelegramInbox(ctx.db);
    const [a, b] = await Promise.all([
      workerA.claimDue({ owner: "worker-a", batchSize: 1, leaseSeconds: 30 }),
      workerB.claimDue({ owner: "worker-b", batchSize: 1, leaseSeconds: 30 }),
    ]);
    expect(a.length + b.length).toBe(1);
  });

  it("fences a stale owner after lease expiry", async () => {
    const inbox = createPostgresTelegramInbox(ctx.db);
    await inbox.accept({ sourceEventId: "105", rawHash: "d".repeat(64), envelope: envelope() });
    const [oldClaim] = await inbox.claimDue({ owner: "old", batchSize: 1, leaseSeconds: 1 });
    expect(oldClaim).toBeTruthy();
    await sql`update webhook_inbox set claim_expires_at = now() - interval '1 second'`.execute(
      ctx.db,
    );
    const [newClaim] = await inbox.claimDue({ owner: "new", batchSize: 1, leaseSeconds: 30 });
    expect(newClaim?.generation).toBeGreaterThan(oldClaim!.generation);
    expect(await inbox.markProcessed(oldClaim!)).toBe(false);
    expect(await inbox.markProcessed(newClaim!)).toBe(true);
  });

  it("defers throttled work and later converges to exactly one business effect", async () => {
    const inbox = createPostgresTelegramInbox(ctx.db);
    await inbox.accept({ sourceEventId: "106", rawHash: "e".repeat(64), envelope: envelope() });
    const limiter = createPostgresRateLimiter(ctx.db, {
      BUY_NOW: { capacity: 1, refillPerSecond: 1 },
    });
    expect(
      (await limiter.tryConsume({ principal: "user:123456789", action: "BUY_NOW" })).allowed,
    ).toBe(true);
    const handler = vi.fn().mockResolvedValue(undefined);
    const telemetry: unknown[] = [];
    const first = await processTelegramInboxBatch({
      inbox,
      limiter,
      handler,
      owner: "worker-a",
      batchSize: 5,
      onTelemetry: (event) => telemetry.push(event),
    });
    expect(first.throttled).toBe(1);
    expect(handler).not.toHaveBeenCalled();
    await sql`update webhook_inbox set next_attempt_at = now() - interval '1 second'`.execute(
      ctx.db,
    );
    await sql`update telegram_rate_limit_bucket set updated_at = now() - interval '2 seconds'`.execute(
      ctx.db,
    );
    const second = await processTelegramInboxBatch({
      inbox,
      limiter,
      handler,
      owner: "worker-b",
      batchSize: 5,
    });
    expect(second.processed).toBe(1);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(telemetry).toHaveLength(1);
    expect(telemetry[0]).toMatchObject({ throttled: 1, backlog: { due: 0, dead: 0 } });
    expect(JSON.stringify(telemetry)).not.toContain("callbackData");
  });

  it("isolates per-user and per-action budgets with typed retry-after", async () => {
    const limiterA = createPostgresRateLimiter(ctx.db, {
      BUY_NOW: { capacity: 1, refillPerSecond: 0.5 },
      SUPPORT: { capacity: 1, refillPerSecond: 0.5 },
      PAID_ORDER_RECOVERY: { capacity: 2, refillPerSecond: 1 },
    });
    const limiterB = createPostgresRateLimiter(ctx.db, {
      BUY_NOW: { capacity: 1, refillPerSecond: 0.5 },
      SUPPORT: { capacity: 1, refillPerSecond: 0.5 },
      PAID_ORDER_RECOVERY: { capacity: 2, refillPerSecond: 1 },
    });
    expect((await limiterA.tryConsume({ principal: "user:1", action: "BUY_NOW" })).allowed).toBe(
      true,
    );
    const denied = await limiterB.tryConsume({ principal: "user:1", action: "BUY_NOW" });
    expect(denied.allowed).toBe(false);
    if (!denied.allowed) expect(denied.retryAfterSeconds).toBeGreaterThan(0);
    expect((await limiterB.tryConsume({ principal: "user:2", action: "BUY_NOW" })).allowed).toBe(
      true,
    );
    expect((await limiterB.tryConsume({ principal: "user:1", action: "SUPPORT" })).allowed).toBe(
      true,
    );
    expect(
      (await limiterB.tryConsume({ principal: "user:1", action: "PAID_ORDER_RECOVERY" })).allowed,
    ).toBe(true);
  });

  it("bounds retries, dead-letters poison work, and stores only a safe error code", async () => {
    const inbox = createPostgresTelegramInbox(ctx.db);
    await inbox.accept({ sourceEventId: "107", rawHash: "f".repeat(64), envelope: envelope() });
    for (let attempt = 0; attempt < 3; attempt++) {
      const [claim] = await inbox.claimDue({
        owner: `worker-${attempt}`,
        batchSize: 1,
        leaseSeconds: 30,
      });
      expect(claim).toBeTruthy();
      await inbox.markFailed(claim!, {
        errorCode: "HANDLER_FAILED",
        maxAttempts: 3,
        retryAfterSeconds: 0,
      });
    }
    const row = await sql<{
      processing_status: string;
      last_error_code: string;
      dead_lettered_at: Date | null;
    }>`
      select processing_status, last_error_code, dead_lettered_at from webhook_inbox where source_event_id = '107'
    `.execute(ctx.db);
    expect(row.rows[0]).toMatchObject({
      processing_status: "DEAD",
      last_error_code: "HANDLER_FAILED",
    });
    expect(row.rows[0]?.dead_lettered_at).toBeTruthy();
    expect(JSON.stringify(row.rows[0])).not.toContain("secret");
  });

  it("prunes processed rows in bounded retention batches", async () => {
    const inbox = createPostgresTelegramInbox(ctx.db);
    for (const [sourceEventId, suffix] of [
      ["201", "1"],
      ["202", "2"],
      ["203", "3"],
    ] as const) {
      await inbox.accept({
        sourceEventId,
        rawHash: suffix.repeat(64),
        envelope: envelope(),
      });
      const [claim] = await inbox.claimDue({
        owner: `retention-${sourceEventId}`,
        batchSize: 1,
        leaseSeconds: 30,
      });
      await inbox.markProcessed(claim!);
    }
    await sql`update webhook_inbox set processed_at = now() - interval '8 days'`.execute(ctx.db);
    expect(
      await inbox.prune({ processedRetentionDays: 7, deadRetentionDays: 30, batchSize: 2 }),
    ).toBe(2);
    const remaining = await sql<{ count: number }>`
      select count(*)::int as count from webhook_inbox
    `.execute(ctx.db);
    expect(remaining.rows[0]?.count).toBe(1);
  });

  it("rejects wrong secret, non-private identity, invalid update bounds, and oversized bodies", async () => {
    const inbox = createPostgresTelegramInbox(ctx.db);
    const app = await createApp({
      db: ctx.db,
      vault: fakeVault(),
      telegram: {
        path: "/telegram/webhook",
        secretToken: WEBHOOK_HEADER_VALUE,
        inbox,
      },
      sepay: { path: "/sepay", handler: vi.fn() },
      bodyLimitBytes: 512,
      logger: false,
    });
    try {
      const wrongSecret = await app.inject({
        method: "POST",
        url: "/telegram/webhook",
        payload: { update_id: 1 },
      });
      expect(wrongSecret.statusCode).toBe(401);
      const group = await app.inject({
        method: "POST",
        url: "/telegram/webhook",
        headers: HEADERS,
        payload: {
          update_id: 108,
          message: { from: { id: 1 }, chat: { id: -1, type: "group" }, text: "/start" },
        },
      });
      expect(group.statusCode).toBe(200);
      const groupCallback = await app.inject({
        method: "POST",
        url: "/telegram/webhook",
        headers: HEADERS,
        payload: {
          update_id: 110,
          callback_query: {
            id: "group-callback",
            from: { id: 1 },
            data: "buy:opaque",
            message: { message_id: 9, chat: { id: -100, type: "supergroup" } },
          },
        },
      });
      expect(groupCallback.statusCode).toBe(200);
      const invalidId = await app.inject({
        method: "POST",
        url: "/telegram/webhook",
        headers: HEADERS,
        payload: { update_id: -1 },
      });
      expect(invalidId.statusCode).toBe(200);
      const oversized = await app.inject({
        method: "POST",
        url: "/telegram/webhook",
        headers: HEADERS,
        payload: { update_id: 109, message: { text: "x".repeat(1000) } },
      });
      expect(oversized.statusCode).toBe(413);
      const rows = await sql<{
        count: number;
      }>`select count(*)::int as count from webhook_inbox`.execute(ctx.db);
      expect(rows.rows[0]?.count).toBe(0);
    } finally {
      await app.close();
    }
  });
});
