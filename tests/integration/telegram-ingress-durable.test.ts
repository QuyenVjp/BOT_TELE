import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { sql } from "kysely";
import { createApp } from "../../src/app.js";
import {
  createPostgresTelegramInbox,
  processTelegramInboxBatch,
  type TelegramCommandEnvelope,
} from "../../src/infrastructure/inbox/telegram.js";
import { createPostgresRateLimiter } from "../../src/modules/risk/service.js";
import type { Vault } from "../../src/infrastructure/vault/port.js";
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
