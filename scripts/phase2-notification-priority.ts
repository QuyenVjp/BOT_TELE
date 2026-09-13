import { spawnSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { sql } from "kysely";
import { runNotificationDeliveryLane } from "../src/worker.js";
import { newId } from "../src/shared/ids/index.js";
import {
  createBroadcast,
  enqueueBroadcastRecipients,
  markBroadcastPreviewed,
} from "../src/modules/notification/service.js";
import { startPostgresContainer } from "../tests/helpers/pg-container.js";

const broadcastCount = Number(process.argv[2] ?? 1_000);
if (!Number.isInteger(broadcastCount) || broadcastCount < 100) {
  throw new RangeError("broadcast count must be an integer >= 100");
}

function percentile(values: number[], p: number): number {
  const ordered = [...values].sort((a, b) => a - b);
  return ordered[Math.min(ordered.length - 1, Math.floor(ordered.length * p))] ?? 0;
}

const ctx = await startPostgresContainer();
try {
  const migrated = spawnSync("npm", ["run", "migrate"], {
    env: { ...process.env, DATABASE_URL: ctx.connectionString },
    encoding: "utf8",
  });
  if (migrated.status !== 0)
    throw new Error(`QA migration failed: ${migrated.stderr || migrated.stdout}`);

  await sql`
    truncate table notification_delivery, notification_campaign, notification_campaign_audience,
      notification_preference, notification_rate_slot, channel_identity, customer cascade
  `.execute(ctx.db);

  await sql`
    insert into customer (id,status,locale)
    select md5('phase2-broadcast-' || gs::text), 'ACTIVE', 'vi'
    from generate_series(1, ${broadcastCount}) gs
  `.execute(ctx.db);
  await sql`
    insert into channel_identity(id,customer_id,channel,channel_user_id)
    select md5('phase2-channel-' || gs::text), md5('phase2-broadcast-' || gs::text), 'TELEGRAM',
      'priority-broadcast-' || gs::text
    from generate_series(1, ${broadcastCount}) gs
  `.execute(ctx.db);
  await sql`
    insert into notification_preference(customer_id,shop_updates,purchase_activity)
    select md5('phase2-broadcast-' || gs::text), true, true
    from generate_series(1, ${broadcastCount}) gs
  `.execute(ctx.db);

  const broadcastId = await createBroadcast(ctx.db, {
    class: "SHOP_UPDATE",
    content: "phase2-broadcast",
    createdBy: "qa",
    idempotencyKey: `phase2-priority-broadcast-${newId()}`,
    audience: "shop",
  });
  if (
    !(await markBroadcastPreviewed(ctx.db, {
      campaignId: broadcastId,
      createdBy: "qa",
      content: "phase2-broadcast",
    }))
  )
    throw new Error("broadcast preview failed");
  const enqueuedBroadcast = await enqueueBroadcastRecipients(ctx.db, broadcastId);
  if (enqueuedBroadcast !== broadcastCount)
    throw new Error(`broadcast enqueued ${enqueuedBroadcast}, expected ${broadcastCount}`);

  const criticalCustomerId = "phase2-critical-customer";
  await sql`
    insert into customer (id,status,locale) values (${criticalCustomerId}, 'ACTIVE', 'vi')
  `.execute(ctx.db);
  await sql`
    insert into channel_identity(id,customer_id,channel,channel_user_id)
    values (${newId()}, ${criticalCustomerId}, 'TELEGRAM', 'priority-critical')
  `.execute(ctx.db);
  await sql`
    insert into notification_preference(customer_id,shop_updates,purchase_activity)
    values (${criticalCustomerId}, true, true)
  `.execute(ctx.db);

  const criticalId = await createBroadcast(ctx.db, {
    class: "CRITICAL_SERVICE",
    content: "phase2-critical",
    createdBy: "qa",
    idempotencyKey: `phase2-priority-critical-${newId()}`,
    audience: "root",
  });
  if (
    !(await markBroadcastPreviewed(ctx.db, {
      campaignId: criticalId,
      createdBy: "qa",
      content: "phase2-critical",
      rootTelegramUserId: "priority-critical",
    }))
  )
    throw new Error("critical preview failed");

  const startedAt = performance.now();
  const sentAt: Array<{ className: "broadcast" | "critical"; elapsedMs: number; chatId: string }> =
    [];
  const sendCounts = new Map<string, number>();
  const lane = {
    db: ctx.db,
    responder: {
      send: async ({ chatId, message }: { chatId: string; message: { text: string } }) => {
        const className = message.text === "phase2-critical" ? "critical" : "broadcast";
        sentAt.push({ className, elapsedMs: performance.now() - startedAt, chatId });
        sendCounts.set(chatId, (sendCounts.get(chatId) ?? 0) + 1);
      },
    },
    ratePerSecond: 20,
    maxAttempts: 5,
    workers: 4,
    batchSize: 100,
  };

  const firstBatch = runNotificationDeliveryLane(lane);
  await sleep(100);
  const criticalEnqueuedAt = performance.now();
  const enqueuedCritical = await enqueueBroadcastRecipients(
    ctx.db,
    criticalId,
    "priority-critical",
  );
  if (enqueuedCritical !== 1) throw new Error(`critical enqueued ${enqueuedCritical}, expected 1`);
  await firstBatch;

  while (true) {
    const remaining = Number(
      (
        await sql<{ remaining: string }>`
          select count(*)::text as remaining
          from notification_delivery
          where status in ('PENDING','RETRY')
        `.execute(ctx.db)
      ).rows[0]?.remaining ?? 0,
    );
    if (remaining === 0) break;
    await runNotificationDeliveryLane(lane);
  }

  const criticalSend = sentAt.find((event) => event.className === "critical");
  const broadcastWaits = sentAt
    .filter((event) => event.className === "broadcast")
    .map((event) => event.elapsedMs);
  const duplicateSends = [...sendCounts.values()].reduce(
    (sum, count) => sum + Math.max(0, count - 1),
    0,
  );
  const sentRows = Number(
    (
      await sql<{ sent: string }>`
        select count(*)::text as sent from notification_delivery where status='SENT'
      `.execute(ctx.db)
    ).rows[0]?.sent ?? 0,
  );
  const criticalLatencyMs = criticalSend
    ? criticalSend.elapsedMs - (criticalEnqueuedAt - startedAt)
    : null;
  const result = {
    result:
      sentRows === broadcastCount + 1 &&
      sentAt.length === broadcastCount + 1 &&
      duplicateSends === 0 &&
      criticalLatencyMs !== null
        ? "PASS"
        : "FAIL",
    mode: "real-queue-real-claim-real-worker-mocked-transport",
    broadcastCount,
    criticalCount: 1,
    ratePerSecond: 20,
    workers: 4,
    sentRows,
    duplicateSends,
    criticalLatencyMs: criticalLatencyMs === null ? null : Number(criticalLatencyMs.toFixed(3)),
    criticalElapsedMs: criticalSend ? Number(criticalSend.elapsedMs.toFixed(3)) : null,
    broadcastQueueWaitMs: {
      p50: Number(percentile(broadcastWaits, 0.5).toFixed(3)),
      p95: Number(percentile(broadcastWaits, 0.95).toFixed(3)),
      max: Number(Math.max(...broadcastWaits).toFixed(3)),
    },
    durationMs: Number((performance.now() - startedAt).toFixed(3)),
  };
  console.log(JSON.stringify(result));
  if (result.result !== "PASS") throw new Error(JSON.stringify(result));
} finally {
  await ctx.teardown();
}
