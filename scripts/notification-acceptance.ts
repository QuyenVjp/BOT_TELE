import { spawnSync } from "node:child_process";
import { sql } from "kysely";
import { runNotificationDeliveryLane } from "../src/worker.js";
import { newId } from "../src/shared/ids/index.js";
import {
  createBroadcast,
  enqueueBroadcastRecipients,
  markBroadcastPreviewed,
} from "../src/modules/notification/service.js";
import { startPostgresContainer } from "../tests/helpers/pg-container.js";

const counts = (process.argv.slice(2).length ? process.argv.slice(2) : ["1000", "10000"]).map(
  (value) => {
    const count = Number(value);
    if (!Number.isInteger(count) || count < 1) throw new RangeError(`invalid count: ${value}`);
    return count;
  },
);

function percentile(values: number[], p: number): number {
  return values[Math.min(values.length - 1, Math.floor(values.length * p))] ?? 0;
}

const ctx = await startPostgresContainer();
try {
  const migrated = spawnSync("npm", ["run", "migrate"], {
    env: { ...process.env, DATABASE_URL: ctx.connectionString },
    encoding: "utf8",
  });
  if (migrated.status !== 0)
    throw new Error(`QA migration failed: ${migrated.stderr || migrated.stdout}`);

  for (const count of counts) {
    await sql`truncate table notification_delivery, notification_campaign, notification_preference, notification_rate_slot, channel_identity, customer cascade`.execute(
      ctx.db,
    );

    const campaignId = await createBroadcast(ctx.db, {
      class: "CRITICAL_SERVICE",
      content: "acceptance",
      createdBy: "qa",
      idempotencyKey: `notification-acceptance-${count}-${newId()}`,
    });
    for (let i = 0; i < count; i++) {
      const customerId = newId();
      await sql`insert into customer (id,status,locale) values (${customerId},'ACTIVE','vi')`.execute(
        ctx.db,
      );
      await sql`insert into channel_identity(id,customer_id,channel,channel_user_id) values (${newId()},${customerId},'TELEGRAM',${`chat-${i}`})`.execute(
        ctx.db,
      );
    }
    const previewed = await markBroadcastPreviewed(ctx.db, {
      campaignId,
      createdBy: "qa",
      content: "acceptance",
    });
    if (!previewed) throw new Error("campaign preview failed");
    const enqueued = await enqueueBroadcastRecipients(ctx.db, campaignId);
    if (enqueued !== count) throw new Error(`enqueued ${enqueued}, expected ${count}`);

    const startedAt = performance.now();
    const sentAt = new Map<string, number[]>();
    const queueWaits: number[] = [];
    while (true) {
      await runNotificationDeliveryLane({
        db: ctx.db,
        responder: {
          send: async ({ chatId }) => {
            const elapsed = performance.now() - startedAt;
            sentAt.set(chatId, [...(sentAt.get(chatId) ?? []), elapsed]);
            queueWaits.push(elapsed);
          },
        },
        ratePerSecond: 20,
        maxAttempts: 5,
        workers: 4,
      });
      const status = (
        await sql<{
          remaining: string;
        }>`select count(*)::text as remaining from notification_delivery where status in ('PENDING','RETRY')`.execute(
          ctx.db,
        )
      ).rows[0];
      if (status?.remaining === "0") break;
    }

    queueWaits.sort((a, b) => a - b);
    const duplicateSends = [...sentAt.values()].reduce(
      (sum, sends) => sum + Math.max(0, sends.length - 1),
      0,
    );
    const sentRows = Number(
      (
        await sql<{
          sent: string;
        }>`select count(*)::text as sent from notification_delivery where status='SENT'`.execute(
          ctx.db,
        )
      ).rows[0]?.sent ?? 0,
    );
    if (sentRows !== count) throw new Error(`sent ${sentRows}, expected ${count}`);
    if (duplicateSends !== 0) throw new Error(`duplicate sends observed: ${duplicateSends}`);

    const durationMs = performance.now() - startedAt;
    console.log(
      JSON.stringify({
        mode: "real-clock-real-claim-process-mocked-transport",
        count,
        seconds: durationMs / 1000,
        messagesPerSecond: (count * 1000) / durationMs,
        p50QueueWaitMs: percentile(queueWaits, 0.5),
        p95QueueWaitMs: percentile(queueWaits, 0.95),
        duplicateSends,
      }),
    );
  }
} finally {
  await ctx.teardown();
}
