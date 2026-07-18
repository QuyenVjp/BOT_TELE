import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "kysely";
import {
  consumeTelegramUsernameObservation,
  createPostgresTelegramInbox,
  pruneTelegramUsernameData,
  type TelegramCommandEnvelope,
} from "../../src/infrastructure/inbox/telegram.js";
import {
  bootstrapRootTelegramIdentity,
  ensureTelegramIdentity,
} from "../../src/modules/identity/channel-identity.js";
import { startPostgresContainer, type PgTestContext } from "../helpers/pg-container.js";

let ctx: PgTestContext;
beforeAll(async () => {
  ctx = await startPostgresContainer();
}, 180_000);
afterAll(async () => ctx?.teardown());
beforeEach(async () => {
  await sql`
    truncate table telegram_username_observation, webhook_inbox, channel_identity, customer cascade
  `.execute(ctx.db);
});

function envelope(username: string): TelegramCommandEnvelope {
  return {
    actorUserId: "7788990011",
    actorUsername: username,
    chatId: "7788990011",
    chatType: "private",
    messageId: "1",
    action: "CATALOG",
    command: "/start",
  };
}

describe("Telegram username privacy lifecycle (T185 RED)", () => {
  it("bootstraps root by numeric ID without converting expected config into observed metadata", async () => {
    const root = await bootstrapRootTelegramIdentity(ctx.db, { telegramUserId: "1122334455" });
    const row = await sql<{ observed_username: string | null }>`
      select observed_username from channel_identity where id = ${root.channelIdentityId}
    `.execute(ctx.db);
    expect(row.rows).toEqual([{ observed_username: null }]);
  });

  it("keeps username out of inbox, applies only the verified observation, then prunes stale metadata", async () => {
    const inbox = createPostgresTelegramInbox(ctx.db);
    await inbox.accept({
      sourceEventId: "991",
      rawHash: "a".repeat(64),
      envelope: envelope("verified_customer"),
    });
    const durable = await sql<{ envelope: Record<string, unknown> }>`
      select envelope from webhook_inbox where source_event_id = '991'
    `.execute(ctx.db);
    expect(durable.rows[0]?.envelope).not.toHaveProperty("actorUsername");
    const observed = await consumeTelegramUsernameObservation(ctx.db, "7788990011");
    expect(observed).toBe("verified_customer");
    const identity = await ensureTelegramIdentity(ctx.db, {
      telegramUserId: "7788990011",
      ...(observed ? { observedUsername: observed } : {}),
    });
    await sql`
      update channel_identity set username_observed_at = now() - interval '31 days'
      where id = ${identity.channelIdentityId}
    `.execute(ctx.db);
    await sql`
      insert into telegram_username_observation
        (telegram_user_id, observed_username, observed_at, expires_at)
      values ('99887766', 'expired_observation', now() - interval '31 days', now() - interval '1 day')
    `.execute(ctx.db);
    const result = await pruneTelegramUsernameData(ctx.db, {
      batchSize: 1,
      retentionDays: 30,
    });
    expect(result).toEqual({ observationsDeleted: 1, identitiesCleared: 1 });
    const cleared = await sql<{
      observed_username: string | null;
      username_observed_at: Date | null;
    }>`
      select observed_username, username_observed_at
      from channel_identity where id = ${identity.channelIdentityId}
    `.execute(ctx.db);
    expect(cleared.rows).toEqual([{ observed_username: null, username_observed_at: null }]);
  });
});
