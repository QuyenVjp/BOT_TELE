import { sql } from "kysely";
import type { Db, Executor } from "../../infrastructure/db/transaction.js";
import { withTransaction } from "../../infrastructure/db/transaction.js";
import { newId } from "../../shared/ids/index.js";

export const TELEGRAM_CHANNEL = "TELEGRAM" as const;

export interface EnsureTelegramIdentityInput {
  telegramUserId: string;
  observedUsername?: string;
}

export interface TelegramIdentity {
  customerId: string;
  channelIdentityId: string;
}

interface IdentityRow {
  id: string;
  customer_id: string;
}

/**
 * Atomically binds a numeric Telegram user id to exactly one Customer.
 * Username is observation-only metadata and never participates in lookup or
 * authorization.
 */
export async function ensureTelegramIdentity(
  db: Db,
  input: EnsureTelegramIdentityInput,
): Promise<TelegramIdentity> {
  const telegramUserId = normalizeTelegramUserId(input.telegramUserId);
  const observedUsername = normalizeObservedUsername(input.observedUsername);

  return withTransaction(db, async (trx) => {
    const existing = await findIdentity(trx, telegramUserId);
    if (existing) {
      await touchIdentity(trx, existing, observedUsername);
      return mapIdentity(existing);
    }

    const candidateCustomerId = newId();
    const candidateIdentityId = newId();
    await sql`insert into customer (id) values (${candidateCustomerId})`.execute(trx);

    const inserted = await sql<IdentityRow>`
      insert into channel_identity
        (id, customer_id, channel, channel_user_id, observed_username, username_observed_at)
      values
        (${candidateIdentityId}, ${candidateCustomerId}, ${TELEGRAM_CHANNEL},
         ${telegramUserId}, ${observedUsername ?? null},
         ${observedUsername ? sql`now()` : null})
      on conflict (channel, channel_user_id) do nothing
      returning id, customer_id
    `.execute(trx);
    const created = inserted.rows[0];
    if (created) return mapIdentity(created);

    // ON CONFLICT can observe a concurrent winner that was not visible to the
    // insert statement's snapshot. Remove our unreferenced candidate, then use
    // a new READ COMMITTED statement snapshot to read that committed winner.
    await sql`delete from customer where id = ${candidateCustomerId}`.execute(trx);
    const winner = await findIdentity(trx, telegramUserId);
    if (!winner) throw new Error("Telegram identity conflict winner was not found");
    await touchIdentity(trx, winner, observedUsername);
    return mapIdentity(winner);
  });
}

export async function resolveTelegramCustomerId(
  db: Db,
  telegramUserId: string,
): Promise<string | null> {
  const normalized = normalizeTelegramUserId(telegramUserId);
  const identity = await findIdentity(db, normalized);
  return identity?.customer_id ?? null;
}

export function bootstrapRootTelegramIdentity(
  db: Db,
  input: { telegramUserId: string },
): Promise<TelegramIdentity> {
  return ensureTelegramIdentity(db, input);
}

function normalizeTelegramUserId(value: string): string {
  if (!/^[1-9][0-9]{0,19}$/.test(value)) throw new Error("Invalid Telegram user id");
  const parsed = BigInt(value);
  if (parsed > 0xffff_ffff_ffff_ffffn) throw new Error("Invalid Telegram user id");
  return parsed.toString(10);
}

function normalizeObservedUsername(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value.normalize("NFC").trim();
  if (!/^[A-Za-z0-9_]{1,64}$/.test(normalized)) return undefined;
  return normalized;
}

async function findIdentity(db: Executor, telegramUserId: string): Promise<IdentityRow | null> {
  const result = await sql<IdentityRow>`
    select id, customer_id
    from channel_identity
    where channel = ${TELEGRAM_CHANNEL} and channel_user_id = ${telegramUserId}
    limit 1
  `.execute(db);
  return result.rows[0] ?? null;
}

async function touchIdentity(
  db: Executor,
  identity: IdentityRow,
  observedUsername: string | undefined,
): Promise<void> {
  const observed = observedUsername ?? null;
  await sql`
    update channel_identity
    set last_seen_at = now(),
        observed_username = coalesce(${observed}::text, observed_username),
        username_observed_at = case when ${observed}::text is not null
          then now() else username_observed_at end
    where id = ${identity.id}
  `.execute(db);
  await sql`update customer set last_seen_at = now() where id = ${identity.customer_id}`.execute(
    db,
  );
}

function mapIdentity(row: IdentityRow): TelegramIdentity {
  return { customerId: row.customer_id, channelIdentityId: row.id };
}
