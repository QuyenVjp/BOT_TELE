import { Api, InlineKeyboard } from "grammy";
import type { PresentedMessage } from "./presenters/catalog.js";

export interface TelegramResponder {
  send(input: {
    chatId: string;
    messageId: string | null;
    callbackQueryId?: string;
    message: PresentedMessage;
  }): Promise<void>;
}

/** Real grammY API adapter for durable webhook-worker dispatch. */
export function createGrammyResponder(botToken: string): TelegramResponder {
  if (!/^\d+:[A-Za-z0-9_-]{20,}$/.test(botToken)) {
    throw new Error("Invalid Telegram bot token");
  }
  const api = new Api(botToken);
  return {
    async send(input) {
      if (input.callbackQueryId) {
        await api.answerCallbackQuery(input.callbackQueryId).catch(() => undefined);
      }
      const keyboard = new InlineKeyboard();
      for (const row of input.message.buttons) {
        for (const button of row) keyboard.text(button.text, button.callbackData);
        keyboard.row();
      }
      await api.sendMessage(input.chatId, input.message.text, {
        reply_markup: keyboard,
      });
    },
  };
}
