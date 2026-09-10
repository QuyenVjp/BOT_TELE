import { sql } from "kysely";
import type { Db } from "../../infrastructure/db/transaction.js";
import type { PresentedMessage } from "../../bot/presenters/catalog.js";
import type { SentTelegramMessage } from "../../bot/grammy-responder.js";
import {
  getGroupCommerceSettings,
  updateGroupCommerceSettings,
} from "../catalog/group-commerce.js";
import { presentGroupShopPanel } from "../../bot/presenters/group.js";

/**
 * Durable shop panel (F-012).
 *
 * The community panel is ONE logical message the bot owns and rewrites in place. Telegram only
 * tells us which message a send produced, so the identity has to be persisted from the API
 * response — never guessed by scraping history. Once persisted, every later refresh edits that
 * message; a send is only used to create the panel, or to replace it after Telegram confirms the
 * original is gone.
 *
 * Failure policy:
 *  - `non-editable-or-missing` (deleted / wrong chat) → the transport already falls through to
 *    exactly one new send, and the new identity is persisted here with a version bump.
 *  - transient (429 / 5xx) → thrown, nothing is persisted, so the caller retries the same panel
 *    instead of leaking a duplicate.
 */

export interface ShopPanelSender {
  send(input: {
    chatId: string;
    messageId: string | null;
    message: PresentedMessage;
  }): Promise<SentTelegramMessage | null>;
}

export interface ShopPanelResult {
  chatId: string;
  messageId: string;
  version: number;
  /** True when Telegram no longer held the previous panel and a replacement was posted. */
  replaced: boolean;
  created: boolean;
}

export async function publishShopPanel(
  db: Db,
  deps: { send: ShopPanelSender["send"]; botUsername: string; updatedBy?: string },
): Promise<ShopPanelResult> {
  const settings = await getGroupCommerceSettings(db);
  const previous = settings.shop_panel_message_id;
  const sent = await deps.send({
    chatId: settings.group_chat_id,
    messageId: previous,
    message: presentGroupShopPanel({ botUsername: deps.botUsername }),
  });
  if (!sent) throw new Error("SHOP_PANEL_SEND_NO_MESSAGE");

  const unchanged = sent.messageId === previous;
  if (unchanged) {
    return {
      chatId: sent.chatId,
      messageId: sent.messageId,
      version: settings.shop_panel_version,
      replaced: false,
      created: false,
    };
  }

  // First publish, or a replacement of a panel Telegram no longer holds. Persist the identity
  // only after Telegram has confirmed the message exists.
  const version = settings.shop_panel_version + 1;
  await updateGroupCommerceSettings(db, {
    shop_panel_chat_id: sent.chatId,
    shop_panel_message_id: sent.messageId,
    shop_panel_version: version,
    ...(deps.updatedBy === undefined ? {} : { updated_by: deps.updatedBy }),
  });
  return {
    chatId: sent.chatId,
    messageId: sent.messageId,
    version,
    replaced: previous !== null,
    created: previous === null,
  };
}

/** Read the persisted identity for reporting; never rescans chat history. */
export async function readShopPanelIdentity(
  db: Db,
): Promise<{ chatId: string | null; messageId: string | null; version: number }> {
  const row = (
    await sql<{
      shop_panel_chat_id: string | null;
      shop_panel_message_id: string | null;
      shop_panel_version: number;
    }>`
      select shop_panel_chat_id, shop_panel_message_id, shop_panel_version
      from group_commerce_settings where id = 'main' limit 1
    `.execute(db)
  ).rows[0];
  return {
    chatId: row?.shop_panel_chat_id ?? null,
    messageId: row?.shop_panel_message_id ?? null,
    version: row?.shop_panel_version ?? 0,
  };
}
