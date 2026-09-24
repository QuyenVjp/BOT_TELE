import { sql } from "kysely";
import type { Db } from "../../infrastructure/db/transaction.js";

const DEFAULT_COOLDOWN_SECONDS = 3_600;
export const DEFAULT_MAX_PAYMENT_REMINDERS = 3;

export async function claimPaymentReminder(
  db: Db,
  input: {
    orderId: string;
    customerId: string;
    cooldownSeconds?: number;
    maxReminders?: number;
  },
): Promise<boolean> {
  const cooldownSeconds = Math.min(
    86_400,
    Math.max(60, Math.trunc(input.cooldownSeconds ?? DEFAULT_COOLDOWN_SECONDS)),
  );
  const maxReminders = Math.min(
    10,
    Math.max(1, Math.trunc(input.maxReminders ?? DEFAULT_MAX_PAYMENT_REMINDERS)),
  );
  const result = await sql<{ order_id: string }>`
    insert into payment_reminder (order_id, customer_id, last_sent_at, send_count)
    select o.id, o.customer_id, now(), 1
    from "order" o
    where o.id = ${input.orderId}
      and o.customer_id = ${input.customerId}
      and o.status = 'PENDING_PAYMENT'
      and (o.expires_at is null or o.expires_at > now())
    on conflict (order_id) do update
      set customer_id = excluded.customer_id,
          last_sent_at = now(),
          send_count = payment_reminder.send_count + 1
      where payment_reminder.customer_id = excluded.customer_id
        and payment_reminder.send_count < ${maxReminders}
        and payment_reminder.last_sent_at <= now() - (${cooldownSeconds} || ' seconds')::interval
    returning order_id
  `.execute(db);
  return Boolean(result.rows[0]);
}
