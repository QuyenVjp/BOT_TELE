import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { sql } from "kysely";
import type { Db, Executor } from "../../infrastructure/db/transaction.js";
import { withTransaction } from "../../infrastructure/db/transaction.js";
import { newId } from "../../shared/ids/index.js";
import { creditWalletLedgerEntry } from "../wallet/ledger.js";

const PREFIX = "ref_";
export const REFERRAL_START_PARAM_MAX_BYTES = 64;
const PURPOSE = "tier20:referral:v1";

export function isReferralTokenSafeForTelegram(token: string): boolean {
  if (Buffer.byteLength(token, "utf8") > REFERRAL_START_PARAM_MAX_BYTES) return false;
  const value = token.startsWith(PREFIX) ? token.slice(PREFIX.length) : "";
  return /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value);
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function signature(secret: string, payload: string): string {
  return createHmac("sha256", secret)
    .update(PURPOSE)
    .update(payload)
    .digest("base64url")
    .slice(0, 16);
}

function validToken(token: string, secret: string): boolean {
  if (!isReferralTokenSafeForTelegram(token)) return false;
  const value = token.slice(PREFIX.length);
  const separator = value.lastIndexOf(".");
  if (separator <= 0) return false;
  const payload = value.slice(0, separator);
  const given = value.slice(separator + 1);
  const expected = signature(secret, payload);
  return (
    given.length === expected.length && timingSafeEqual(Buffer.from(given), Buffer.from(expected))
  );
}

export type ReferralResult =
  | {
      ok: true;
      referralCode?: string;
      attributionId?: string;
      rewardId?: string;
      already?: boolean;
    }
  | {
      ok: false;
      code:
        | "INVALID_TOKEN"
        | "SELF_REFERRAL"
        | "ALREADY_ATTRIBUTED"
        | "NOT_QUALIFIED"
        | "REWARD_FAILED"
        | "REWARDS_DISABLED";
    };

export async function getOrCreateReferralToken(
  db: Db,
  input: { customerId: string; secret: string },
): Promise<string> {
  if (!input.secret) throw new Error("REFERRAL_SECRET_NOT_CONFIGURED");
  const existing = await sql<{ token: string }>`
    select token from referral_code
    where referrer_customer_id = ${input.customerId} and active = true
    order by created_at desc
    limit 1
  `.execute(db);
  if (existing.rows[0]) return existing.rows[0].token;
  const payload = randomBytes(18).toString("base64url");
  const token = `${PREFIX}${payload}.${signature(input.secret, payload)}`;
  const inserted = await sql<{ token: string }>`
    insert into referral_code (id, referrer_customer_id, token, token_hash)
    values (${newId()}, ${input.customerId}, ${token}, ${digest(token)})
    on conflict (referrer_customer_id) do nothing
    returning token
  `.execute(db);
  return (
    inserted.rows[0]?.token ??
    (
      await sql<{ token: string }>`
      select token from referral_code
      where referrer_customer_id = ${input.customerId} and active = true
      limit 1
    `.execute(db)
    ).rows[0]?.token ??
    token
  );
}

export async function attributeReferral(
  db: Db,
  input: { token: string; refereeCustomerId: string; secret: string },
): Promise<ReferralResult> {
  if (!validToken(input.token, input.secret)) return { ok: false, code: "INVALID_TOKEN" };
  return withTransaction(db, async (trx) => {
    const code = await sql<{ id: string; referrer_customer_id: string }>`
      select id, referrer_customer_id
      from referral_code
      where token_hash = ${digest(input.token)} and active = true
      for update
    `.execute(trx);
    const row = code.rows[0];
    if (!row) return { ok: false, code: "INVALID_TOKEN" } as const;
    if (row.referrer_customer_id === input.refereeCustomerId)
      return { ok: false, code: "SELF_REFERRAL" } as const;
    const inserted = await sql<{ id: string }>`
      insert into referral_attribution
        (id, referral_code_id, referrer_customer_id, referee_customer_id)
      values
        (${newId()}, ${row.id}, ${row.referrer_customer_id}, ${input.refereeCustomerId})
      on conflict (referee_customer_id) do nothing
      returning id
    `.execute(trx);
    if (!inserted.rows[0]) return { ok: false, code: "ALREADY_ATTRIBUTED" } as const;
    return { ok: true, attributionId: inserted.rows[0].id } as const;
  });
}

export async function issueReferralReward(
  db: Db,
  input: {
    orderId: string;
    amountVnd: bigint;
    correlationId: string;
    enabled: boolean;
  },
): Promise<ReferralResult> {
  if (!input.enabled) return { ok: false, code: "REWARDS_DISABLED" };
  if (input.amountVnd <= 0n) return { ok: false, code: "REWARD_FAILED" };
  return withTransaction(db, async (trx) => {
    const qualifying = await sql<{
      customer_id: string;
      attribution_id: string;
      referrer_customer_id: string;
    }>`
      select o.customer_id, ra.id as attribution_id, ra.referrer_customer_id
      from "order" o
      join product_variant v on v.id = o.variant_id
      join product p on p.id = v.product_id
      join referral_attribution ra on ra.referee_customer_id = o.customer_id
      where o.id = ${input.orderId}
        and o.status = 'COMPLETED'
        and p.is_test = false
        and exists (select 1 from payment_intent pi where pi.order_id = o.id and pi.status = 'SUCCEEDED')
        and exists (
          select 1
          from payment_allocation pa
          join payment_intent pi on pi.id = pa.payment_intent_id
          where pi.order_id = o.id and pa.status = 'SETTLED'
        )
        and (
          exists (
            select 1 from digital_asset a
            where a.delivered_order_id = o.id and a.status = 'DELIVERED'
          )
          or exists (
            select 1 from manual_fulfillment_task mft
            where mft.order_id = o.id and mft.status = 'COMPLETED'
          )
        )
      limit 1
      for update of o, ra
    `.execute(trx);
    const row = qualifying.rows[0];
    if (!row) return { ok: false, code: "NOT_QUALIFIED" } as const;
    const existing = await sql<{ id: string }>`
      select id from referral_reward where attribution_id = ${row.attribution_id} for update
    `.execute(trx);
    if (existing.rows[0])
      return { ok: true, already: true, rewardId: existing.rows[0].id } as const;
    const rewardId = newId();
    const reward = await sql<{ id: string }>`
      insert into referral_reward
        (id, attribution_id, referrer_customer_id, referee_customer_id, qualifying_order_id, amount_vnd)
      values
        (${rewardId}, ${row.attribution_id}, ${row.referrer_customer_id}, ${row.customer_id}, ${input.orderId}, ${input.amountVnd})
      returning id
    `.execute(trx);
    if (!reward.rows[0]) return { ok: false, code: "REWARD_FAILED" } as const;
    const credit = await creditWalletLedgerEntry(trx, {
      customerId: row.referrer_customer_id,
      amountVnd: input.amountVnd,
      idempotencyKey: `referral:${row.attribution_id}:${input.orderId}`,
      correlationId: input.correlationId,
      reason: "REFERRAL_REWARD",
    });
    if (!credit.ok) return { ok: false, code: "REWARD_FAILED" } as const;
    await sql`
      update referral_attribution
      set status = 'QUALIFIED', qualifying_order_id = ${input.orderId}
      where id = ${row.attribution_id}
    `.execute(trx);
    return { ok: true, rewardId: reward.rows[0].id } as const;
  });
}

export async function getReferralStats(
  exec: Executor,
  customerId: string,
): Promise<{ attributed: number; qualified: number; earnedVnd: bigint }> {
  const result = await sql<{ attributed: number; qualified: number; earned_vnd: string }>`
    select
      count(*)::int as attributed,
      count(*) filter (where status = 'QUALIFIED')::int as qualified,
      coalesce((select sum(amount_vnd) from referral_reward where referrer_customer_id = ${customerId} and status = 'ISSUED'), 0)::text as earned_vnd
    from referral_attribution
    where referrer_customer_id = ${customerId}
  `.execute(exec);
  const row = result.rows[0];
  return {
    attributed: row?.attributed ?? 0,
    qualified: row?.qualified ?? 0,
    earnedVnd: BigInt(row?.earned_vnd ?? "0"),
  };
}
