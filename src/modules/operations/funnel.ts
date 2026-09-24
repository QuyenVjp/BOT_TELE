import { sql } from "kysely";
import type { Executor } from "../../infrastructure/db/transaction.js";

export type FunnelEventName =
  "PRODUCT_VIEW" | "CHECKOUT_STARTED" | "PAYMENT_PRESENTED" | "PAYMENT_SUCCEEDED" | "DELIVERED";

export interface FunnelCounts {
  eventName: FunnelEventName;
  count: number;
}

export const FUNNEL_EVENT_KEY_MAX_BYTES = 200;

export async function recordFunnelEvent(
  exec: Executor,
  input: {
    eventKey: string;
    eventName: FunnelEventName;
    variantId?: string;
    eventDate?: Date;
  },
): Promise<void> {
  if (
    input.eventKey.length === 0 ||
    Buffer.byteLength(input.eventKey, "utf8") > FUNNEL_EVENT_KEY_MAX_BYTES
  ) {
    throw new Error("funnel event key is empty or too long");
  }
  const variantKey = input.variantId ?? "";
  await sql`
    with accepted as (
      insert into funnel_event_receipt
        (event_key, event_date, event_name, variant_key, variant_id)
      values (
        ${input.eventKey},
        coalesce(${input.eventDate ?? null}::date, current_date),
        ${input.eventName},
        ${variantKey},
        ${input.variantId ?? null}
      )
      on conflict (event_key) do nothing
      returning event_date, event_name, variant_key, variant_id
    )
    insert into funnel_event_daily (event_date, event_name, variant_key, variant_id, event_count)
    select event_date, event_name, variant_key, variant_id, 1
    from accepted
    on conflict (event_date, event_name, variant_key)
    do update set event_count = funnel_event_daily.event_count + 1
  `.execute(exec);
}

export async function getFunnelCounts(
  exec: Executor,
  input: { from: Date; to: Date },
): Promise<FunnelCounts[]> {
  const result = await sql<{ event_name: FunnelEventName; count: number }>`
    select event_name, sum(event_count)::int as count
    from funnel_event_daily
    where event_date >= ${input.from}::date and event_date < ${input.to}::date
    group by event_name
    order by event_name
  `.execute(exec);
  return result.rows.map((row) => ({ eventName: row.event_name, count: row.count }));
}
