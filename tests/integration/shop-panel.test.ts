import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { sql } from "kysely";
import { startPostgresContainer, type PgTestContext } from "../helpers/pg-container.js";
import { publishShopPanel, readShopPanelIdentity } from "../../src/modules/group/shop-panel.js";
import { TelegramRetryableError } from "../../src/bot/grammy-responder.js";

/**
 * Durable shop panel (F-012).
 *
 * The panel is one logical group message. Telegram is the only authority on which message a
 * send produced, so the identity must be persisted from the API response: create once, edit
 * forever, and only repost when Telegram confirms the original is gone.
 */

let ctx: PgTestContext;
beforeAll(async () => {
  ctx = await startPostgresContainer();
}, 180_000);
afterAll(async () => ctx?.teardown());
beforeEach(async () => {
  await sql`truncate table group_commerce_settings cascade`.execute(ctx.db);
  await sql`insert into group_commerce_settings (id, group_chat_id) values ('main', '-1003906082671')`.execute(
    ctx.db,
  );
});

const CHAT = "-1003906082671";

describe("shop panel identity", () => {
  it("persists the message Telegram returned on first publish", async () => {
    const send = vi.fn().mockResolvedValue({ chatId: CHAT, messageId: "501" });

    const result = await publishShopPanel(ctx.db, { send, botUsername: "tier20ai_bot" });

    expect(result).toMatchObject({ messageId: "501", version: 1, created: true, replaced: false });
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ chatId: CHAT, messageId: null }));
    expect(await readShopPanelIdentity(ctx.db)).toEqual({
      chatId: CHAT,
      messageId: "501",
      version: 1,
    });
  });

  it("edits the persisted panel instead of posting a second one", async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({ chatId: CHAT, messageId: "501" })
      .mockImplementation(async (input: { messageId: string | null }) => ({
        chatId: CHAT,
        messageId: input.messageId ?? "unexpected",
      }));

    await publishShopPanel(ctx.db, { send, botUsername: "tier20ai_bot" });
    const second = await publishShopPanel(ctx.db, { send, botUsername: "tier20ai_bot" });

    expect(second).toMatchObject({ messageId: "501", version: 1, created: false, replaced: false });
    expect(send).toHaveBeenLastCalledWith(expect.objectContaining({ messageId: "501" }));
    expect(await readShopPanelIdentity(ctx.db)).toMatchObject({ messageId: "501", version: 1 });
  });

  it("records a replacement once when Telegram no longer holds the panel", async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({ chatId: CHAT, messageId: "501" })
      // The transport falls through to a fresh send when the edit target is gone.
      .mockResolvedValueOnce({ chatId: CHAT, messageId: "777" });

    await publishShopPanel(ctx.db, { send, botUsername: "tier20ai_bot" });
    const recovered = await publishShopPanel(ctx.db, { send, botUsername: "tier20ai_bot" });

    expect(recovered).toMatchObject({
      messageId: "777",
      version: 2,
      created: false,
      replaced: true,
    });
    expect(await readShopPanelIdentity(ctx.db)).toEqual({
      chatId: CHAT,
      messageId: "777",
      version: 2,
    });
  });

  it("persists nothing when Telegram fails transiently", async () => {
    const send = vi.fn().mockRejectedValue(new TelegramRetryableError("flood", 30));

    await expect(publishShopPanel(ctx.db, { send, botUsername: "tier20ai_bot" })).rejects.toThrow(
      /flood/,
    );
    expect(await readShopPanelIdentity(ctx.db)).toEqual({
      chatId: null,
      messageId: null,
      version: 0,
    });
  });

  it("does not persist an identity it could not read back", async () => {
    const send = vi.fn().mockResolvedValue(null);

    await expect(publishShopPanel(ctx.db, { send, botUsername: "tier20ai_bot" })).rejects.toThrow(
      /SHOP_PANEL_SEND_NO_MESSAGE/,
    );
    expect(await readShopPanelIdentity(ctx.db)).toMatchObject({ messageId: null, version: 0 });
  });
});
