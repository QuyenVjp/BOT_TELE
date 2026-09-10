import { sql } from "kysely";
import type { Executor } from "../../infrastructure/db/transaction.js";

/**
 * Admin system health (goal §135) and the operator queue counts behind it.
 *
 * Read-only, secret-free: every field is a count, a liveness verdict or a configured mode.
 * No token, key, endpoint credential or customer identity passes through here, so the screen
 * built on it can be shown without redaction.
 *
 * Every queue excludes test/canary trade (goal §114, §136): a TEST-mode purchase produces a real
 * `payment_intent` row, and an operator chasing an abandoned test payment is exactly the noise the
 * exclusion rule exists to prevent. Payment intents are filtered through the order's product
 * (`is_test`), and support tickets through the test-customer allowlist.
 *
 * `outbox_event` and `discrepancy` have no product link, so they are counted as-is; an outbox row
 * that belongs to a test order is operationally real (it is a delivery the system attempted) and a
 * discrepancy is a money-matching problem the operator must still resolve.
 */

export interface AdminHealthQueues {
  outboxBacklog: number;
  outboxDeadLettered: number;
  openDiscrepancies: number;
  intentsAwaitingSettlement: number;
  paymentsNeedingReview: number;
  openSupportTickets: number;
}

export interface AdminHealthFacts {
  /** Result of a `select 1` round trip. */
  database: "ok" | "down";
  queues: AdminHealthQueues;
}

const EMPTY_QUEUES: AdminHealthQueues = {
  outboxBacklog: 0,
  outboxDeadLettered: 0,
  openDiscrepancies: 0,
  intentsAwaitingSettlement: 0,
  paymentsNeedingReview: 0,
  openSupportTickets: 0,
};

/**
 * Probe the database and read the operator queues in one shot.
 *
 * A database that cannot be reached reports `down` with zeroed queues instead of throwing: the
 * health screen must still render (and say so) when the thing it reports on is unavailable.
 */
export async function getAdminHealthFacts(exec: Executor): Promise<AdminHealthFacts> {
  try {
    await sql`select 1`.execute(exec);
  } catch {
    return { database: "down", queues: { ...EMPTY_QUEUES } };
  }

  const result = await sql<{
    outbox_backlog: number;
    outbox_dead_lettered: number;
    open_discrepancies: number;
    intents_awaiting_settlement: number;
    payments_needing_review: number;
    open_support_tickets: number;
  }>`
    select
      (select count(*)::int from outbox_event
         where published_at is null and dead_lettered_at is null) as outbox_backlog,
      (select count(*)::int from outbox_event
         where dead_lettered_at is not null) as outbox_dead_lettered,
      (select count(*)::int from discrepancy where resolved_at is null) as open_discrepancies,
      (select count(*)::int from payment_intent i
         join "order" o on o.id = i.order_id
         join product_variant v on v.id = o.variant_id
         join product p on p.id = v.product_id
         where i.status in ('CREATED', 'PRESENTED') and not p.is_test and not p.is_archived
      ) as intents_awaiting_settlement,
      (select count(*)::int from payment_intent i
         join "order" o on o.id = i.order_id
         join product_variant v on v.id = o.variant_id
         join product p on p.id = v.product_id
         where i.status = 'NEEDS_REVIEW' and not p.is_test and not p.is_archived
      ) as payments_needing_review,
      (select count(*)::int from support_ticket t
         where t.status in ('OPEN', 'MANUAL_REVIEW')
           and not exists (
             select 1
             from channel_identity ci
             join test_customer_allowlist a
               on a.telegram_user_id::text = ci.channel_user_id::text
             where ci.customer_id = t.customer_id
           )
      ) as open_support_tickets
  `.execute(exec);

  const row = result.rows[0];
  return {
    database: "ok",
    queues: {
      outboxBacklog: row?.outbox_backlog ?? 0,
      outboxDeadLettered: row?.outbox_dead_lettered ?? 0,
      openDiscrepancies: row?.open_discrepancies ?? 0,
      intentsAwaitingSettlement: row?.intents_awaiting_settlement ?? 0,
      paymentsNeedingReview: row?.payments_needing_review ?? 0,
      openSupportTickets: row?.open_support_tickets ?? 0,
    },
  };
}
