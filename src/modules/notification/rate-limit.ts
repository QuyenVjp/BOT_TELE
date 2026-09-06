import { sql } from "kysely";
import { withTransaction, type Db } from "../../infrastructure/db/transaction.js";

/** Reserve one global and per-chat slot atomically across worker restarts. */
export async function reserveNotificationSlot(db: Db, chatId: string, rate: number): Promise<number> {
  if (!Number.isInteger(rate) || rate < 1 || rate > 25) throw new RangeError("notification rate must be 1..25");
  return withTransaction(db, async trx => {
    const chat = `chat:${chatId}`;
    await sql`insert into notification_rate_slot(scope,next_at) values ('global',now()),(${chat},now()) on conflict do nothing`.execute(trx);
    const slots = await sql<{ scope: string; next_at: Date }>`select scope,next_at from notification_rate_slot where scope in ('global',${chat}) order by scope for update`.execute(trx);
    const clock = await sql<{ now: Date }>`select clock_timestamp() as now`.execute(trx);
    const now = clock.rows[0]!.now.getTime();
    const at = Math.max(now, ...slots.rows.map(row => row.next_at.getTime()));
    await sql`update notification_rate_slot set next_at=case when scope='global' then ${new Date(at + 1000 / rate)}::timestamptz else ${new Date(at + (chatId.startsWith('-') ? 3000 : 1000))}::timestamptz end where scope in ('global',${chat})`.execute(trx);
    return at - now;
  });
}

export async function pauseNotificationRate(db: Db, seconds: number): Promise<void> {
  if (!Number.isFinite(seconds) || seconds <= 0) return;
  await sql`insert into notification_rate_slot(scope,next_at) values ('global',clock_timestamp()+${seconds}*interval '1 second') on conflict(scope) do update set next_at=greatest(notification_rate_slot.next_at,excluded.next_at)`.execute(db);
  await sql`insert into notification_rate_slot(scope,next_at) values ('pause',clock_timestamp()+${seconds}*interval '1 second') on conflict(scope) do update set next_at=greatest(notification_rate_slot.next_at,excluded.next_at)`.execute(db);
}

export async function notificationPauseRemaining(db: Db): Promise<number> {
  const r = await sql<{ delay: number }>`select greatest(0,extract(epoch from (next_at-clock_timestamp()))*1000)::float8 as delay from notification_rate_slot where scope='pause'`.execute(db);
  return r.rows[0]?.delay ?? 0;
}
