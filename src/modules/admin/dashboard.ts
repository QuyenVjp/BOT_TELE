import { sql } from "kysely";
import type { Executor } from "../../infrastructure/db/transaction.js";
import { vietnamDayStart } from "./overview.js";

/**
 * Root-admin dashboard metrics. This is a read model only: PostgreSQL is the source of truth and
 * the query intentionally returns one bounded aggregate row.
 */
export interface AdminDashboardMetrics {
  activeProducts: number;
  outOfStock: number;
  lowStock: number;
  availableInventory: number;
  ordersToday: number;
  paidToday: number;
  revenueTodayVnd: bigint;
  pendingPayment: number;
  paymentReview: number;
  fulfillmentFailures: number;
  manualOpenTasks: number;
  notificationSendUncertain: number;
  warrantyNew: number;
  refundDue: number;
  supportOpenTickets: number;
}

interface DashboardRow {
  active_products: number;
  out_of_stock: number;
  low_stock: number;
  available_inventory: number;
  orders_today: number;
  paid_today: number;
  revenue_today_vnd: string | number | bigint;
  pending_payment: number;
  payment_review: number;
  fulfillment_failures: number;
  manual_open_tasks: number;
  notification_send_uncertain: number;
  warranty_new: number;
  refund_due: number;
  support_open_tickets: number;
}

const DAY_MS = 86_400_000;

export async function getAdminDashboardMetrics(
  exec: Executor,
  now: Date = new Date(),
): Promise<AdminDashboardMetrics> {
  const dayStart = vietnamDayStart(now);
  const dayEnd = new Date(dayStart.getTime() + DAY_MS);
  const dayStartIso = dayStart.toISOString();
  const dayEndIso = dayEnd.toISOString();

  const result = await sql<DashboardRow>`
    with real_orders as (
      select o.id, o.customer_id, o.status, o.price_vnd, o.created_at, o.paid_at
      from "order" o
      join product_variant v on v.id = o.variant_id
      join product p on p.id = v.product_id
      where not p.is_test
        and not p.is_archived
        and p.name_vi not ilike '%canary%'
    ),
    operational_orders as (
      select o.id, o.customer_id, o.status
      from "order" o
      join product_variant v on v.id = o.variant_id
      join product p on p.id = v.product_id
      where not p.is_test
        and p.name_vi not ilike '%canary%'
    ),
    real_preorders as (
      select pr.id
      from preorder_reservation pr
      join product_variant v on v.id = pr.variant_id
      join product p on p.id = v.product_id
      where not p.is_test
        and not p.is_archived
        and p.name_vi not ilike '%canary%'
    ),
    operational_preorders as (
      select pr.id
      from preorder_reservation pr
      join product_variant v on v.id = pr.variant_id
      join product p on p.id = v.product_id
      where not p.is_test
        and p.name_vi not ilike '%canary%'
    ),
    local_variant_stock as (
      select
        v.id as variant_id,
        v.low_stock_threshold,
        case
          when v.fulfillment_type in ('STOCK_ACCOUNT', 'STOCK_CODE') then (
            select count(*)::int
            from digital_asset da
            where da.variant_id = v.id and da.status = 'AVAILABLE'
          )
          when v.fulfillment_type = 'QUANTITY_STOCK' then coalesce((
            select q.available_quantity
            from variant_quantity_stock q
            where q.variant_id = v.id
          ), 0)::int
          when v.fulfillment_type = 'DIGITAL_FILE' then (
            select count(*)::int
            from variant_file_artifact f
            where f.variant_id = v.id and f.is_active
          )
          else 0
        end as available
      from product_variant v
      join product p on p.id = v.product_id
      join category c on c.id = p.category_id
      where v.is_active
        and p.is_active
        and c.is_active
        and not p.is_test
        and not p.is_archived
        and p.name_vi not ilike '%canary%'
        and v.fulfillment_type in (
          'STOCK_ACCOUNT', 'STOCK_CODE', 'QUANTITY_STOCK', 'DIGITAL_FILE'
        )
    ),
    metrics as (
      select
        (
          select count(*)::int
          from product p
          join category c on c.id = p.category_id
          where p.is_active
            and c.is_active
            and not p.is_test
            and not p.is_archived
            and p.name_vi not ilike '%canary%'
        ) as active_products,
        (
          select count(*)::int
          from local_variant_stock
          where available = 0
        ) as out_of_stock,
        (
          select count(*)::int
          from local_variant_stock
          where low_stock_threshold is not null
            and low_stock_threshold > 0
            and available > 0
            and available <= low_stock_threshold
        ) as low_stock,
        coalesce((select sum(available)::int from local_variant_stock), 0)::int as available_inventory,
        (
          select count(*)::int
          from real_orders
          where created_at >= ${dayStartIso} and created_at < ${dayEndIso}
        ) as orders_today,
        (
          select count(*)::int
          from real_orders
          where status in ('PAID', 'PROCESSING', 'COMPLETED')
            and paid_at >= ${dayStartIso} and paid_at < ${dayEndIso}
        ) as paid_today,
        coalesce((
          select sum(price_vnd)::bigint
          from real_orders
          where status in ('PAID', 'PROCESSING', 'COMPLETED')
            and paid_at >= ${dayStartIso} and paid_at < ${dayEndIso}
        ), 0)::bigint as revenue_today_vnd,
        (
          select count(*)::int
          from operational_orders
          where status = 'PENDING_PAYMENT'
        ) as pending_payment,
        (
          select count(*)::int
          from operational_orders
          where status = 'PAYMENT_NEEDS_REVIEW'
        ) as payment_review,
        (
          select count(*)::int
          from operational_orders
          where status = 'FULFILLMENT_NEEDS_REVIEW'
        ) as fulfillment_failures,
        (
          select count(*)::int
          from manual_fulfillment_task task
          join operational_orders o on o.id = task.order_id
          where task.status = 'OPEN'
            and o.status = 'PROCESSING'
        ) as manual_open_tasks,
        (
          select count(*)::int
          from (
            select h.id
            from delivery_notification_handoff h
            join delivery_bundle b on b.id = h.bundle_id
            join operational_orders o on o.id = b.order_id
            where h.status = 'DEAD'
              and h.last_error_code in ('DELIVERY_UNCERTAIN', 'SEND_UNCERTAIN')
              and not exists (
                select 1
                from channel_identity ci
                join test_customer_allowlist allowlist
                  on allowlist.telegram_user_id::text = ci.channel_user_id::text
                where ci.customer_id = o.customer_id
              )
            union all
            select fdj.order_id
            from file_delivery_job fdj
            join operational_orders o on o.id = fdj.order_id
            where fdj.status = 'FAILED'
              and fdj.last_error = 'SEND_UNCERTAIN'
              and not exists (
                select 1
                from test_customer_allowlist allowlist
                where allowlist.telegram_user_id::text = fdj.telegram_chat_id::text
              )
          ) uncertain
        ) as notification_send_uncertain,
        (
          select count(*)::int
          from warranty_claim claim
          join operational_orders o on o.id = claim.order_id
          where claim.status = 'SUBMITTED'
        ) as warranty_new,
        (
          select count(*)::int
          from shop_refund_obligation refund
          left join operational_orders order_subject on order_subject.id = refund.order_id
          left join operational_preorders preorder_subject on preorder_subject.id = refund.preorder_id
          left join warranty_claim claim_subject on claim_subject.id = refund.claim_id
          left join operational_orders claim_order_subject on claim_order_subject.id = claim_subject.order_id
          where refund.status = 'OPEN'
            and (
              order_subject.id is not null
              or preorder_subject.id is not null
              or claim_order_subject.id is not null
            )
        ) as refund_due,
        (
          select count(*)::int
          from support_ticket ticket
          left join operational_orders order_subject on order_subject.id = ticket.order_id
          where ticket.status in ('OPEN', 'WAITING_SHOP', 'WAITING_CUSTOMER', 'MANUAL_REVIEW')
            and not exists (
              select 1
              from channel_identity ci
              join test_customer_allowlist allowlist
                on allowlist.telegram_user_id::text = ci.channel_user_id::text
              where ci.customer_id = ticket.customer_id
            )
            and (order_subject.id is not null or ticket.order_id is null)
        ) as support_open_tickets
    )
    select * from metrics
  `.execute(exec);

  const row = result.rows[0];
  return {
    activeProducts: row?.active_products ?? 0,
    outOfStock: row?.out_of_stock ?? 0,
    lowStock: row?.low_stock ?? 0,
    availableInventory: row?.available_inventory ?? 0,
    ordersToday: row?.orders_today ?? 0,
    paidToday: row?.paid_today ?? 0,
    revenueTodayVnd: BigInt(row?.revenue_today_vnd ?? 0),
    pendingPayment: row?.pending_payment ?? 0,
    paymentReview: row?.payment_review ?? 0,
    fulfillmentFailures: row?.fulfillment_failures ?? 0,
    manualOpenTasks: row?.manual_open_tasks ?? 0,
    notificationSendUncertain: row?.notification_send_uncertain ?? 0,
    warrantyNew: row?.warranty_new ?? 0,
    refundDue: row?.refund_due ?? 0,
    supportOpenTickets: row?.support_open_tickets ?? 0,
  };
}
