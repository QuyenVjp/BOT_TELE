import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { createDb, type DbHandle } from "../../src/infrastructure/db/client.js";
import {
  TELEGRAM_CHANNEL,
  bootstrapRootTelegramIdentity,
  ensureTelegramIdentity,
  resolveTelegramCustomerId,
} from "../../src/modules/identity/channel-identity.js";
import { newId } from "../../src/shared/ids/index.js";
import {
  dockerAvailable,
  startPostgresContainer,
  type PgTestContext,
} from "../helpers/pg-container.js";

const hasDocker = await dockerAvailable();

describe.skipIf(!hasDocker)("fresh Telegram identity onboarding (T177)", () => {
  let ctx: PgTestContext;

  beforeAll(async () => {
    ctx = await startPostgresContainer();
  }, 180_000);

  beforeEach(async () => {
    await sql`truncate table channel_identity, customer cascade`.execute(ctx.db);
  });

  afterAll(async () => {
    await ctx?.teardown();
  });

  it("creates one canonical identity and treats username changes as metadata", async () => {
    const first = await ensureTelegramIdentity(ctx.db, {
      telegramUserId: "123456789",
      observedUsername: "first_name",
    });
    const renamed = await ensureTelegramIdentity(ctx.db, {
      telegramUserId: "123456789",
      observedUsername: "renamed_user",
    });

    expect(renamed).toEqual(first);
    expect(await resolveTelegramCustomerId(ctx.db, "123456789")).toBe(first.customerId);

    const identities = await sql<{
      customer_id: string;
      channel: string;
      channel_user_id: string;
      observed_username: string | null;
    }>`
      select customer_id, channel, channel_user_id, observed_username
      from channel_identity
    `.execute(ctx.db);
    const customers = await sql<{
      count: string;
    }>`select count(*)::text as count from customer`.execute(ctx.db);

    expect(identities.rows).toEqual([
      {
        customer_id: first.customerId,
        channel: TELEGRAM_CHANNEL,
        channel_user_id: "123456789",
        observed_username: "renamed_user",
      },
    ]);
    expect(customers.rows[0]?.count).toBe("1");
  });

  it("converges concurrent starts from independent database handles", async () => {
    const secondHandle: DbHandle = createDb({ connectionString: ctx.connectionString });
    try {
      const results = await Promise.all(
        Array.from({ length: 20 }, (_, index) =>
          ensureTelegramIdentity(index % 2 === 0 ? ctx.db : secondHandle.db, {
            telegramUserId: "987654321",
            observedUsername: `metadata_${index}`,
          }),
        ),
      );

      expect(new Set(results.map((result) => result.customerId)).size).toBe(1);
      expect(new Set(results.map((result) => result.channelIdentityId)).size).toBe(1);

      const counts = await sql<{ customers: string; identities: string }>`
        select
          (select count(*)::text from customer) as customers,
          (select count(*)::text from channel_identity) as identities
      `.execute(ctx.db);
      expect(counts.rows[0]).toEqual({ customers: "1", identities: "1" });
    } finally {
      await secondHandle.close();
    }
  });

  it("bootstraps the numeric root on an empty database and rejects non-canonical channel writes", async () => {
    const root = await bootstrapRootTelegramIdentity(ctx.db, {
      telegramUserId: "1122334455",
    });

    expect(await resolveTelegramCustomerId(ctx.db, "1122334455")).toBe(root.customerId);

    const unrelatedCustomerId = newId();
    await sql`insert into customer (id) values (${unrelatedCustomerId})`.execute(ctx.db);
    await expect(
      sql`
        insert into channel_identity (id, customer_id, channel, channel_user_id)
        values (${newId()}, ${unrelatedCustomerId}, 'telegram', '55667788')
      `.execute(ctx.db),
    ).rejects.toThrow();
  });
});
