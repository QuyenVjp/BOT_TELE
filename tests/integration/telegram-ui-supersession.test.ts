import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createCallbackTokenCodec } from "../../src/bot/callback-codec.js";
import { createTelegramDomainDispatcher } from "../../src/bot/callbacks/telegram-dispatch.js";
import { createPostgresUiSurfaceRegistry } from "../../src/bot/ui-surface.js";
import { presentMainMenu } from "../../src/bot/presenters/catalog.js";
import { presentSupportReasonMenu } from "../../src/bot/presenters/support.js";
import { startPostgresContainer, type PgTestContext } from "../helpers/pg-container.js";
import { sql } from "kysely";

/**
 * Telegram UI supersession (F-003).
 *
 * A failed callback is retried with backoff and keeps its original `receivedAt`. By the time
 * the retry lands the operator has usually navigated that same message forward, so the retry
 * must be acknowledged and dropped rather than repaint the current screen.
 */

let ctx: PgTestContext;
beforeAll(async () => {
  ctx = await startPostgresContainer();
}, 180_000);
afterAll(async () => ctx?.teardown());

const codec = createCallbackTokenCodec({
  key: "test-only-telegram-ui-supersession-key-material-1234",
  keyVersion: 1,
  ttlSeconds: 900,
  clockSkewSeconds: 5,
});

function dispatcherFor(uiSurface?: {
  claim(input: { chatId: string; messageId: string; eventReceivedAt: Date }): Promise<boolean>;
}) {
  const ack = vi.fn().mockResolvedValue(undefined);
  const send = vi.fn().mockResolvedValue(undefined);
  const dispatcher = createTelegramDomainDispatcher({
    codec,
    resolveCustomerId: vi.fn().mockResolvedValue("cust"),
    resolveOrderById: vi.fn().mockResolvedValue(null),
    resolveOrderIdByNumber: vi.fn().mockResolvedValue(null),
    resolveCatalogPage: vi.fn().mockResolvedValue(null),
    catalog: {
      mainMenu: vi.fn(async () => presentMainMenu()),
      categoryList: vi.fn(async () => ({ text: "cats", buttons: [] })),
      categoryView: vi.fn(async () => ({ text: "cat", buttons: [] })),
      variantDetail: vi.fn(),
      search: vi.fn(),
      storefront: vi.fn(async () => ({ text: "🛒 TIER20 SHOP", buttons: [] })),
    },
    checkout: {
      buyNowFromCallback: vi.fn(),
      refresh: vi.fn(),
      reopen: vi.fn(),
      cancel: vi.fn(),
    },
    history: { list: vi.fn(), detail: vi.fn() },
    support: {
      reasonMenu: vi.fn(() => presentSupportReasonMenu()),
      open: vi.fn(),
      list: vi.fn(),
    },
    responder: { ack, send },
    ...(uiSurface ? { uiSurface } : {}),
  });
  return { dispatcher, ack, send };
}

function surfaceToken(): string {
  return codec.issue({ action: "SHOP_HOME", telegramUserId: "123456789" });
}

function envelope(receivedAt?: string) {
  return {
    actorUserId: "123456789",
    chatId: "123456789",
    chatType: "private" as const,
    messageId: "42",
    action: "CATALOG" as const,
    callbackData: surfaceToken(),
    callbackQueryId: "cq-1",
    ...(receivedAt ? { receivedAt } : {}),
  };
}

describe("dispatcher drops a superseded render", () => {
  it("acknowledges but does not edit when a newer event owns the surface", async () => {
    const claim = vi.fn().mockResolvedValue(false);
    const { dispatcher, ack, send } = dispatcherFor({ claim });

    await dispatcher.handle(envelope("2026-09-10T09:00:00.000Z"));

    expect(ack).toHaveBeenCalledWith("cq-1");
    expect(send).not.toHaveBeenCalled();
    expect(claim).toHaveBeenCalledTimes(1);
  });

  it("edits when this event is still the newest for the surface", async () => {
    const claim = vi.fn().mockResolvedValue(true);
    const { dispatcher, send } = dispatcherFor({ claim });

    await dispatcher.handle(envelope("2026-09-10T09:05:00.000Z"));

    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]?.[0]).toMatchObject({ chatId: "123456789", messageId: "42" });
  });

  it("renders normally when the surface is unknown or the timestamp is missing", async () => {
    const claim = vi.fn().mockResolvedValue(false);
    const withGuard = dispatcherFor({ claim });
    await withGuard.dispatcher.handle(envelope());
    expect(withGuard.send).toHaveBeenCalledTimes(1);
    expect(claim).not.toHaveBeenCalled();

    const withoutGuard = dispatcherFor();
    await withoutGuard.dispatcher.handle(envelope("2026-09-10T09:00:00.000Z"));
    expect(withoutGuard.send).toHaveBeenCalledTimes(1);
  });
});

describe("UI surface registry ordering", () => {
  it("lets a newer event claim the surface and rejects an older retry", async () => {
    await sql`truncate table telegram_ui_surface`.execute(ctx.db);
    const registry = createPostgresUiSurfaceRegistry(ctx.db);
    const newer = new Date("2026-09-10T09:05:00.000Z");
    const older = new Date("2026-09-10T08:58:00.000Z");

    expect(await registry.claim({ chatId: "1", messageId: "42", eventReceivedAt: newer })).toBe(
      true,
    );
    expect(await registry.claim({ chatId: "1", messageId: "42", eventReceivedAt: older })).toBe(
      false,
    );

    const row = await sql<{ event_received_at: Date; render_count: number }>`
      select event_received_at, render_count from telegram_ui_surface
      where chat_id = '1' and message_id = '42'
    `.execute(ctx.db);
    expect(new Date(row.rows[0]!.event_received_at).toISOString()).toBe(newer.toISOString());
    expect(row.rows[0]!.render_count).toBe(1);
  });

  it("is idempotent for repeats of the current owner and scoped per message", async () => {
    await sql`truncate table telegram_ui_surface`.execute(ctx.db);
    const registry = createPostgresUiSurfaceRegistry(ctx.db);
    const at = new Date("2026-09-10T09:05:00.000Z");

    expect(await registry.claim({ chatId: "1", messageId: "42", eventReceivedAt: at })).toBe(true);
    expect(await registry.claim({ chatId: "1", messageId: "42", eventReceivedAt: at })).toBe(true);
    expect(await registry.claim({ chatId: "1", messageId: "43", eventReceivedAt: at })).toBe(true);

    const rows = await sql<{ n: string }>`
      select count(*)::text as n from telegram_ui_surface where chat_id = '1'
    `.execute(ctx.db);
    expect(rows.rows[0]?.n).toBe("2");
  });

  it("rejects an unusable surface identity", async () => {
    const registry = createPostgresUiSurfaceRegistry(ctx.db);
    await expect(
      registry.claim({ chatId: "", messageId: "42", eventReceivedAt: new Date() }),
    ).rejects.toThrow(/Invalid Telegram UI surface identity/);
    await expect(
      registry.claim({ chatId: "1", messageId: "42", eventReceivedAt: new Date("nope") }),
    ).rejects.toThrow(/Invalid Telegram UI surface timestamp/);
  });
});
