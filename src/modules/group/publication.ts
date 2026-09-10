import { sql } from "kysely";
import type { Db, Executor } from "../../infrastructure/db/transaction.js";
import { newId } from "../../shared/ids/index.js";
import { enqueueOutboxEvent, type OutboxEvent } from "../../infrastructure/outbox/repository.js";
import type { DispatchDecision } from "../../infrastructure/outbox/dispatch-policy.js";
import type { DistributedRateLimiter } from "../risk/service.js";
import type { PresentedMessage } from "../../bot/presenters/catalog.js";
import { getGroupCommerceSettings } from "../catalog/group-commerce.js";
import { evaluateAndPublishSocialProof } from "../marketing/social-proof.js";

/**
 * Group publication (F-009).
 *
 * Restock and social proof are the two things the shop says in the community. Both are
 * opt-in per `group_commerce_settings`, both are rate limited per chat, and both are
 * deduplicated so a restart or a double scan cannot repeat a post:
 *
 *  - Restock is generation-based. A variant posts "back in stock" once per 0 -> >0 sellable
 *    transition; 5 -> 8 is not a restock, and 5 -> 0 -> 3 is a new generation. The generation
 *    number is the outbox dedupe key, so exactly-once falls out of the existing unique index.
 *  - Social proof is once per order, decided by `evaluateAndPublishSocialProof`, which refuses
 *    test/archived products and honouring customers who opted out.
 *
 * Neither path sends from a domain transaction: detection and enqueue run in their own job,
 * and the outbox handler performs the send under the limiter.
 */

export const GROUP_RESTOCK_EVENT = "GroupRestockPublished";
/** Emitted by `evaluateAndPublishSocialProof`; this module owns its delivery. */
export const GROUP_SOCIAL_PROOF_EVENT = "SocialProofEventCreated";

export interface RestockGenerationTick {
  variantId: string;
  generation: number;
}

/** True for outbox events this module delivers. */
export function isGroupPublicationEvent(eventType: string): boolean {
  return eventType === GROUP_RESTOCK_EVENT || eventType === GROUP_SOCIAL_PROOF_EVENT;
}

/**
 * Advance every variant's observed sellable stock and return the ones that just crossed
 * 0 -> >0. Sellable counts only unclaimed inventory, so preorder/reservation holds are
 * already excluded by the time a restock is announced.
 */
export async function advanceRestockGenerations(
  db: Db,
  options: { batchSize: number },
): Promise<RestockGenerationTick[]> {
  if (!Number.isInteger(options.batchSize) || options.batchSize < 1 || options.batchSize > 1000) {
    throw new Error("Invalid restock detection batch size");
  }
  const result = await sql<{ variant_id: string; generation: number }>`
    with sellable as (
      select v.id as variant_id,
             (coalesce(qs.available_quantity, 0) + coalesce(a.available, 0))::int as sellable
      from product_variant v
      left join variant_quantity_stock qs on qs.variant_id = v.id
      left join (
        select variant_id, count(*)::int as available
        from digital_asset
        where status = 'AVAILABLE'
        group by variant_id
      ) a on a.variant_id = v.id
      where v.is_active
    ), merged as (
      select s.variant_id,
             s.sellable,
             g.last_seen_sellable,
             coalesce(g.generation, 0) as generation
      from sellable s
      left join group_restock_generation g on g.variant_id = s.variant_id
      order by s.variant_id
      limit ${options.batchSize}
    ), crossed as (
      select variant_id from merged where last_seen_sellable = 0 and sellable > 0
    ), applied as (
      insert into group_restock_generation (variant_id, last_seen_sellable, generation, updated_at)
      select variant_id,
             sellable,
             case when last_seen_sellable = 0 and sellable > 0 then generation + 1 else generation end,
             now()
      from merged
      on conflict (variant_id) do update
        set last_seen_sellable = excluded.last_seen_sellable,
            generation = excluded.generation,
            updated_at = now()
      returning variant_id, generation
    )
    select variant_id, generation from applied
    where variant_id in (select variant_id from crossed)
  `.execute(db);
  return result.rows.map((row) => ({ variantId: row.variant_id, generation: row.generation }));
}

export async function enqueueRestockPublication(
  exec: Executor,
  tick: RestockGenerationTick,
): Promise<void> {
  await enqueueOutboxEvent(exec, {
    id: newId(),
    aggregateType: "ProductVariant",
    aggregateId: tick.variantId,
    aggregateVersion: tick.generation,
    eventType: GROUP_RESTOCK_EVENT,
    payloadRedacted: { variantId: tick.variantId, generation: tick.generation },
  });
}

/** Completed, non-test orders that have not been evaluated for social proof yet. */
export async function listSocialProofCandidates(
  db: Db,
  options: { batchSize: number },
): Promise<string[]> {
  if (!Number.isInteger(options.batchSize) || options.batchSize < 1 || options.batchSize > 1000) {
    throw new Error("Invalid social proof detection batch size");
  }
  const result = await sql<{ id: string }>`
    select o.id
    from "order" o
    where o.status = 'COMPLETED'
      and not exists (
        select 1 from group_social_proof_publication p where p.order_id = o.id
      )
      and exists (
        select 1
        from digital_asset a
        join product_variant v on v.id = a.variant_id
        join product p on p.id = v.product_id
        where a.delivered_order_id = o.id
          and p.is_test = false
          and p.is_archived = false
          and p.name_vi not ilike '%canary%'
      )
    order by o.completed_at asc nulls last, o.id
    limit ${options.batchSize}
  `.execute(db);
  return result.rows.map((row) => row.id);
}

/**
 * Evaluate one candidate and remember the decision. The ledger keeps an ineligible order
 * from being rescanned forever while still guaranteeing at most one publication per order.
 */
export async function evaluateSocialProofCandidate(
  db: Db,
  input: { orderId: string; aliasSalt?: string },
): Promise<{ queued: boolean; reason: string | null }> {
  const outcome = await evaluateAndPublishSocialProof(db, {
    orderId: input.orderId,
    ...(input.aliasSalt === undefined ? {} : { aliasSalt: input.aliasSalt }),
  });
  const queued = outcome.ok;
  const reason = outcome.ok ? null : outcome.code;
  await sql`
    insert into group_social_proof_publication (order_id, outcome, reason, evaluated_at)
    values (${input.orderId}, ${queued ? "QUEUED" : "SKIPPED"}, ${reason}, now())
    on conflict (order_id) do nothing
  `.execute(db);
  return { queued, reason };
}

export interface GroupPublicationDeps {
  /** Sends the message into the group chat. Never called from a domain transaction. */
  send(input: { chatId: string; message: PresentedMessage }): Promise<void>;
  /** `getChatMember` status of the bot in the group, or null when it is not a member. */
  botMembership(): Promise<"member" | "administrator" | "creator" | null>;
  limiter: DistributedRateLimiter;
  aliasSalt?: string;
}

export async function handleGroupPublicationOutboxEvent(
  db: Db,
  event: OutboxEvent,
  deps: GroupPublicationDeps,
): Promise<DispatchDecision> {
  const settings = await getGroupCommerceSettings(db);
  const chatId = settings.group_chat_id;

  if (event.eventType === GROUP_RESTOCK_EVENT) {
    if (!settings.restock_publishing_enabled) return { kind: "PUBLISHED" };
  }
  if (event.eventType === GROUP_SOCIAL_PROOF_EVENT) {
    if (settings.social_proof_mode === "OFF") return { kind: "PUBLISHED" };
    const since = settings.last_social_proof_at
      ? Date.now() - new Date(settings.last_social_proof_at).getTime()
      : Number.POSITIVE_INFINITY;
    if (since < settings.social_proof_min_interval_seconds * 1000) {
      return { kind: "RETRY", errorCode: "SOCIAL_PROOF_PACED" };
    }
  }

  const membership = await deps.botMembership();
  if (!membership) return { kind: "RETRY", errorCode: "GROUP_NOT_MEMBER" };

  const budget = await deps.limiter.tryConsume({
    principal: `group:${chatId}`,
    action: "GROUP_PUBLICATION",
  });
  if (!budget.allowed) return { kind: "RETRY", errorCode: "RATE_LIMITED" };

  const message =
    event.eventType === GROUP_RESTOCK_EVENT
      ? await buildRestockMessage(db, event)
      : await buildSocialProofMessage(db, event);
  if (!message) return { kind: "PUBLISHED" };

  await deps.send({ chatId, message });
  if (event.eventType === GROUP_RESTOCK_EVENT) {
    await sql`
      update group_commerce_settings set last_restock_published_at = now() where id = 'main'
    `.execute(db);
  } else {
    await sql`
      update group_commerce_settings set last_social_proof_at = now() where id = 'main'
    `.execute(db);
  }
  return { kind: "PUBLISHED" };
}

async function buildRestockMessage(db: Db, event: OutboxEvent): Promise<PresentedMessage | null> {
  const variantId =
    typeof event.payloadRedacted.variantId === "string" ? event.payloadRedacted.variantId : null;
  if (!variantId) return null;
  const row = (
    await sql<{
      product_id: string;
      product_name: string;
      variant_name: string;
      price_vnd: string;
      available: number;
    }>`
      select p.id as product_id, p.name_vi as product_name, v.name_vi as variant_name,
             v.price_vnd::text as price_vnd,
             (select count(*)::int from digital_asset a
               where a.variant_id = v.id and a.status = 'AVAILABLE') as available
      from product_variant v
      join product p on p.id = v.product_id
      where v.id = ${variantId}
      limit 1
    `.execute(db)
  ).rows[0];
  if (!row || row.available <= 0) return null;
  return {
    text: [
      "🔥 HÀNG ĐÃ VỀ!",
      "",
      `📦 ${row.product_name} — ${row.variant_name}`,
      `💰 ${Number(row.price_vnd).toLocaleString("vi-VN")} ₫`,
      "🟢 Còn hàng",
    ].join("\n"),
    buttons: [[{ text: "🛒 Xem sản phẩm", callbackData: `shop:product:${row.product_id}` }]],
  };
}

async function buildSocialProofMessage(
  db: Db,
  event: OutboxEvent,
): Promise<PresentedMessage | null> {
  const text =
    typeof event.payloadRedacted.message === "string" ? event.payloadRedacted.message : null;
  const orderId =
    typeof event.payloadRedacted.orderId === "string" ? event.payloadRedacted.orderId : null;
  if (!text || !orderId) return null;
  const row = (
    await sql<{ product_id: string }>`
      select p.id as product_id
      from digital_asset a
      join product_variant v on v.id = a.variant_id
      join product p on p.id = v.product_id
      where a.delivered_order_id = ${orderId}
      limit 1
    `.execute(db)
  ).rows[0];
  return {
    text,
    buttons: row?.product_id
      ? [[{ text: "🛒 Xem sản phẩm", callbackData: `shop:product:${row.product_id}` }]]
      : [],
  };
}
