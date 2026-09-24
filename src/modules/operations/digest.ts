import { sql } from "kysely";
import type { Executor } from "../../infrastructure/db/transaction.js";

export interface DailyGrowthDigest {
  dayStart: string;
  completedOrders: number;
  revenueVnd: bigint;
  newCustomers: number;
  repeatCustomers: number;
  couponRedemptions: number;
  qualifiedReferrals: number;
}

export async function getDailyGrowthDigest(
  exec: Executor,
  input: { dayStart: Date; dayEnd: Date },
): Promise<DailyGrowthDigest> {
  const [orders, customers, repeats, coupons, referrals] = await Promise.all([
    sql<{ completed_orders: number; revenue_vnd: string }>`
      select count(*)::int as completed_orders, coalesce(sum(o.price_vnd), 0)::text as revenue_vnd
      from "order" o
      join product_variant v on v.id = o.variant_id
      join product p on p.id = v.product_id
      where o.status = 'COMPLETED' and p.is_test = false
        and o.completed_at >= ${input.dayStart} and o.completed_at < ${input.dayEnd}
    `.execute(exec),
    sql<{ new_customers: number }>`
      select count(*)::int as new_customers from customer
      where created_at >= ${input.dayStart} and created_at < ${input.dayEnd}
    `.execute(exec),
    sql<{ repeat_customers: number }>`
      select count(*)::int as repeat_customers
      from (
        select o.customer_id
        from "order" o
        join product_variant v on v.id = o.variant_id
        join product p on p.id = v.product_id
        where o.status = 'COMPLETED' and p.is_test = false
          and o.completed_at >= ${input.dayStart} and o.completed_at < ${input.dayEnd}
        group by o.customer_id
        having count(*) > 1
      ) repeated
    `.execute(exec),
    sql<{ coupon_redemptions: number }>`
      select count(*)::int as coupon_redemptions
      from promotion_redemption
      where status = 'CONSUMED' and consumed_at >= ${input.dayStart} and consumed_at < ${input.dayEnd}
    `.execute(exec),
    sql<{ qualified_referrals: number }>`
      select count(*)::int as qualified_referrals
      from referral_attribution
      where status = 'QUALIFIED' and created_at >= ${input.dayStart} and created_at < ${input.dayEnd}
    `.execute(exec),
  ]);
  const orderRow = orders.rows[0];
  return {
    dayStart: input.dayStart.toISOString(),
    completedOrders: orderRow?.completed_orders ?? 0,
    revenueVnd: BigInt(orderRow?.revenue_vnd ?? "0"),
    newCustomers: customers.rows[0]?.new_customers ?? 0,
    repeatCustomers: repeats.rows[0]?.repeat_customers ?? 0,
    couponRedemptions: coupons.rows[0]?.coupon_redemptions ?? 0,
    qualifiedReferrals: referrals.rows[0]?.qualified_referrals ?? 0,
  };
}
