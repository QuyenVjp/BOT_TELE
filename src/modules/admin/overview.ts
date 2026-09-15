import { sql } from "kysely";
import type { Executor } from "../../infrastructure/db/transaction.js";

/**
 * Admin overview aggregate (goal §71 summary block, §136 business overview).
 *
 * Read-only. Every figure EXCLUDES test and canary inventory: an `is_test` product is not real
 * trade, and the goal requires that test fixtures never inflate the owner's dashboard.
 *
 * The Vietnam day boundary is computed in JS from an injected `now` so the window is
 * deterministic under test instead of depending on the database session timezone.
 */

export interface AdminOverview {
  /** Sum of real COMPLETED orders that completed today (VN). */
  revenueTodayVnd: bigint;
  /** Real orders created today (VN), any status. */
  ordersToday: number;
  /** Real orders still needing an operator: waiting payment, paid, processing, in review. */
  awaitingAction: number;
  /** Sellable variants at or below their configured low-stock threshold. */
  lowStockVariants: number;
  /** Orders whose payment could not be matched confidently. */
  paymentsNeedingReview: number;
  /** Support tickets an operator has not closed yet. */
  newTickets: number;
}

const VIETNAM_OFFSET_MS = 7 * 60 * 60 * 1000;

/** Start of the Vietnam calendar day containing `now`, as a UTC instant. */
export function vietnamDayStart(now: Date): Date {
  const shifted = now.getTime() + VIETNAM_OFFSET_MS;
  return new Date(Math.floor(shifted / 86_400_000) * 86_400_000 - VIETNAM_OFFSET_MS);
}

/** Real (non-test, non-archived) orders only. */
const REAL_ORDER_SQL = sql`
  join product_variant v on v.id = o.variant_id
  join product p on p.id = v.product_id
  where not p.is_test and not p.is_archived
`;

export async function getAdminOverview(
  exec: Executor,
  now: Date = new Date(),
): Promise<AdminOverview> {
  const dayStart = vietnamDayStart(now).toISOString();

  const result = await sql<{
    revenue_today_vnd: string | null;
    orders_today: number;
    awaiting_action: number;
    payments_needing_review: number;
  }>`
    select
      (select coalesce(sum(o.price_vnd), 0)::text from "order" o
         ${REAL_ORDER_SQL} and o.status = 'COMPLETED' and o.completed_at >= ${dayStart}) as revenue_today_vnd,
      (select count(*)::int from "order" o
         ${REAL_ORDER_SQL} and o.created_at >= ${dayStart}) as orders_today,
      (select count(*)::int from "order" o
         ${REAL_ORDER_SQL} and o.status in (
           'PENDING_PAYMENT', 'PAID', 'PROCESSING', 'PAYMENT_NEEDS_REVIEW', 'FULFILLMENT_NEEDS_REVIEW'
         )) as awaiting_action,
      (select count(*)::int from "order" o
         ${REAL_ORDER_SQL} and o.status = 'PAYMENT_NEEDS_REVIEW') as payments_needing_review
  `.execute(exec);

  const stock = await sql<{ low_stock_variants: number }>`
    with sellable as (
      select
        v.id,
        coalesce(v.low_stock_threshold, 0)::int as threshold,
        case
          when v.fulfillment_type in ('STOCK_ACCOUNT', 'STOCK_CODE') then (
            select count(*)::int from digital_asset a
            where a.variant_id = v.id and a.status = 'AVAILABLE'
          )
          when v.fulfillment_type = 'QUANTITY_STOCK' then coalesce((
            select q.available_quantity from variant_quantity_stock q where q.variant_id = v.id
          ), 0)::int
          when v.fulfillment_type in ('MANUAL_FULFILLMENT', 'UNLIMITED_SERVICE') then 1
          when v.fulfillment_type = 'DIGITAL_FILE' then (
            select count(*)::int from variant_file_artifact f
            where f.variant_id = v.id and f.is_active
          )
          else 0
        end as available
      from product_variant v
      join product p on p.id = v.product_id
      join category c on c.id = p.category_id
      where v.is_active and p.is_active and not p.is_test and not p.is_archived and c.is_active
        and v.price_vnd > 0
    )
    select count(*)::int as low_stock_variants
    from sellable
    where threshold > 0 and available <= threshold
  `.execute(exec);

  const tickets = await sql<{ new_tickets: number }>`
    select count(*)::int as new_tickets
    from support_ticket t
    where t.status in ('OPEN', 'MANUAL_REVIEW')
      and not exists (
        select 1
        from channel_identity ci
        join test_customer_allowlist a
          on a.telegram_user_id::text = ci.channel_user_id::text
        where ci.customer_id = t.customer_id
      )
  `.execute(exec);

  const head = result.rows[0];
  return {
    revenueTodayVnd: BigInt(head?.revenue_today_vnd ?? "0"),
    ordersToday: head?.orders_today ?? 0,
    awaitingAction: head?.awaiting_action ?? 0,
    lowStockVariants: stock.rows[0]?.low_stock_variants ?? 0,
    paymentsNeedingReview: head?.payments_needing_review ?? 0,
    newTickets: tickets.rows[0]?.new_tickets ?? 0,
  };
}
