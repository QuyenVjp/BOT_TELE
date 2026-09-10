import { sql } from "kysely";
import type { Executor } from "../infrastructure/db/transaction.js";

/**
 * Telegram UI supersession (T186).
 *
 * Every editable Telegram surface is one message that the bot rewrites in place. When an
 * inbox event fails it is retried with backoff, and a retry that lands minutes later would
 * otherwise repaint the message the operator has since navigated away from — the exact
 * failure that replaced a create-success screen with a stale "session moved on" error.
 *
 * The registry stores the newest inbox `received_at` that rendered each (chat, message)
 * surface. A render is allowed only when the incoming event is at least as new as the one
 * that last painted the surface, so a retry of an older event is dropped while its
 * callback query is still acknowledged.
 */

export interface UiSurfaceClaim {
  chatId: string;
  messageId: string;
  eventReceivedAt: Date;
}

export interface UiSurfaceRegistry {
  /**
   * Reserve the surface for this event. Resolves `true` when the caller may render,
   * `false` when a newer event already owns the surface.
   */
  claim(input: UiSurfaceClaim): Promise<boolean>;
}

export function createPostgresUiSurfaceRegistry(db: Executor): UiSurfaceRegistry {
  return {
    async claim(input) {
      if (!input.chatId || !input.messageId) {
        throw new Error("Invalid Telegram UI surface identity");
      }
      if (
        !(input.eventReceivedAt instanceof Date) ||
        Number.isNaN(input.eventReceivedAt.getTime())
      ) {
        throw new Error("Invalid Telegram UI surface timestamp");
      }
      const claimed = await sql<{ chat_id: string }>`
        insert into telegram_ui_surface (chat_id, message_id, event_received_at, rendered_at, render_count)
        values (${input.chatId}, ${input.messageId}, ${input.eventReceivedAt.toISOString()}, now(), 1)
        on conflict (chat_id, message_id) do update
          set event_received_at = excluded.event_received_at,
              rendered_at = now(),
              render_count = telegram_ui_surface.render_count + 1
          where telegram_ui_surface.event_received_at <= excluded.event_received_at
        returning chat_id
      `.execute(db);
      return claimed.rows.length === 1;
    },
  };
}
