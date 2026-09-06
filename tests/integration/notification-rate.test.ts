import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { sql } from "kysely";
import { runNotificationDeliveryLane } from "../../src/worker.js";
import { claimNotificationDeliveries } from "../../src/modules/notification/service.js";
import { newId } from "../../src/shared/ids/index.js";
import { reserveNotificationSlot, pauseNotificationRate } from "../../src/modules/notification/rate-limit.js";
import { startPostgresContainer, type PgTestContext } from "../helpers/pg-container.js";
let ctx: PgTestContext;
beforeAll(async () => { ctx = await startPostgresContainer(); }, 180000);
afterAll(async () => { await ctx?.teardown(); });

async function seedDelivery(chatId: string, suffix = chatId): Promise<string> {
  const customerId = newId();
  const campaignId = newId();
  const deliveryId = newId();
  await sql`insert into customer (id, status, locale) values (${customerId}, 'ACTIVE', 'vi')`.execute(ctx.db);
  await sql`insert into notification_campaign(id,class,content,status,created_by,idempotency_key) values (${campaignId},'CRITICAL_SERVICE','hello','QUEUED','test',${`idem-${suffix}-${campaignId}`})`.execute(ctx.db);
  await sql`insert into notification_delivery(id,campaign_id,customer_id,chat_id) values (${deliveryId},${campaignId},${customerId},${chatId})`.execute(ctx.db);
  return deliveryId;
}

async function resetNotifications(): Promise<void> {
  await sql`truncate table notification_delivery, notification_campaign, notification_rate_slot, customer cascade`.execute(ctx.db);
}

describe("persistent notification rate", () => {
  it("shares global and individual-chat reservations across callers", async () => {
    await sql`truncate notification_rate_slot`.execute(ctx.db);
    await reserveNotificationSlot(ctx.db, "one", 20);
    const same = await reserveNotificationSlot(ctx.db, "one", 20);
    expect(same).toBeGreaterThan(800);
    const other = await reserveNotificationSlot(ctx.db, "two", 20);
    expect(other).toBeGreaterThan(same - 100);
  });
  it("preserves global 429 backoff across caller restart", async () => {
    await pauseNotificationRate(ctx.db, 5);
    const wait = await reserveNotificationSlot(ctx.db, "restart", 20);
    expect(wait).toBeGreaterThan(4500);
    expect(wait).toBeLessThanOrEqual(5100);
  });
  it("waits on a global pause after slots were already reserved", async () => {
    await resetNotifications();
    await seedDelivery("1001");
    await seedDelivery("1002");
    let paused = false;
    const sleeps: number[] = [];
    const sender = { send: vi.fn(async () => undefined) };
    await runNotificationDeliveryLane({ db: ctx.db, responder: sender, ratePerSecond: 20, maxAttempts: 5, workers: 2, sleep: async ms => {
      sleeps.push(ms);
      if (!paused) { paused = true; await pauseNotificationRate(ctx.db, 3); }
      else if (ms >= 2500) await sql`update notification_rate_slot set next_at=now()-interval '1 second' where scope='pause'`.execute(ctx.db);
    } });

    expect(sender.send).toHaveBeenCalledTimes(2);
    expect(sleeps.some(ms => ms >= 2500)).toBe(true);
    expect((await sql<{ sent: string }>`select count(*) filter (where status='SENT')::text as sent from notification_delivery`.execute(ctx.db)).rows[0]).toEqual({ sent: "2" });
  });

  it("does not send stale leases and restart excludes already-sent deliveries", async () => {
    await resetNotifications();
    const sentBeforeRestart = await seedDelivery("2001", "sent");
    const stale = await seedDelivery("2002", "stale");
    const stillDue = await seedDelivery("2003", "due");
    const [sentClaim, staleClaim, dueClaim] = await claimNotificationDeliveries(ctx.db, 3);
    await sql`update notification_delivery set status='SENT', sent_at=now(), claim_expires_at=null where id=${sentBeforeRestart}`.execute(ctx.db);
    await sql`update notification_delivery set claim_expires_at=now()-interval '1 second' where id=${stale}`.execute(ctx.db);
    await sql`update notification_delivery set status='PENDING', claim_expires_at=null, next_attempt_at=now() where id=${stillDue}`.execute(ctx.db);
    expect([sentClaim?.id, staleClaim?.id, dueClaim?.id].sort()).toEqual([sentBeforeRestart, stale, stillDue].sort());
    const sender = { send: vi.fn(async () => undefined) };

    await runNotificationDeliveryLane({ db: ctx.db, responder: sender, ratePerSecond: 20, maxAttempts: 5, workers: 4, sleep: async () => undefined });

    expect(sender.send).toHaveBeenCalledTimes(1);
    expect(sender.send).toHaveBeenCalledWith({ chatId: "2003", messageId: null, message: { text: "hello", buttons: [] } });
    const rows = await sql<{ id: string; status: string }>`select id,status from notification_delivery where id in (${sentBeforeRestart},${stale},${stillDue}) order by id`.execute(ctx.db);
    expect(rows.rows).toEqual([{ id: sentBeforeRestart, status: "SENT" }, { id: stale, status: "RETRY" }, { id: stillDue, status: "SENT" }].sort((a, b) => a.id.localeCompare(b.id)));
  });
});
