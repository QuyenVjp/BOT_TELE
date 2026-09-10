import { sql } from "kysely";
import type { Executor } from "../../infrastructure/db/transaction.js";

export interface TelegramCustomerProfileSnapshotInput {
  customerId: string;
  telegramUserId: string;
  chatId: string;
  username?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  languageCode?: string | null;
  phoneNumber?: string | null;
  reachable?: boolean;
  seenAt?: Date;
}

/**
 * The snapshot describes the customer's PRIVATE chat with the bot: `chat_id` is constrained
 * to a private chat id and the row is keyed by customer. A group or channel id is a
 * programming error, not data — rejecting it here keeps a group envelope from taking down
 * the whole inbox handler before dispatch (which a raw constraint violation would do).
 */
const PRIVATE_CHAT_ID = /^[1-9][0-9]{0,19}$/;

export async function upsertTelegramCustomerProfileSnapshot(
  db: Executor,
  input: TelegramCustomerProfileSnapshotInput,
): Promise<void> {
  if (!PRIVATE_CHAT_ID.test(input.chatId)) throw new Error("INVALID_PRIVATE_CHAT_ID");
  const seenAt = input.seenAt ?? new Date();
  const displayName = deriveDisplayName(input.firstName, input.lastName);
  await sql`
    insert into customer_profile_snapshot (
      customer_id, telegram_user_id, chat_id, username, first_name, last_name, display_name,
      language_code, reachable, phone_number, phone_shared_at, created_at, last_seen_at
    )
    values (
      ${input.customerId}, ${input.telegramUserId}, ${input.chatId}, ${input.username ?? null},
      ${input.firstName ?? null}, ${input.lastName ?? null}, ${displayName},
      ${input.languageCode ?? null}, ${input.reachable ?? true}, ${input.phoneNumber ?? null},
      ${input.phoneNumber ? seenAt.toISOString() : null}, now(), ${seenAt.toISOString()}
    )
    on conflict (customer_id) do update set
      telegram_user_id = excluded.telegram_user_id,
      chat_id = excluded.chat_id,
      username = coalesce(excluded.username, customer_profile_snapshot.username),
      first_name = coalesce(excluded.first_name, customer_profile_snapshot.first_name),
      last_name = coalesce(excluded.last_name, customer_profile_snapshot.last_name),
      display_name = coalesce(excluded.display_name, customer_profile_snapshot.display_name),
      language_code = coalesce(excluded.language_code, customer_profile_snapshot.language_code),
      reachable = excluded.reachable,
      phone_number = coalesce(excluded.phone_number, customer_profile_snapshot.phone_number),
      phone_shared_at = coalesce(excluded.phone_shared_at, customer_profile_snapshot.phone_shared_at),
      last_seen_at = excluded.last_seen_at
  `.execute(db);
}

function deriveDisplayName(firstName?: string | null, lastName?: string | null): string | null {
  const parts = [firstName?.trim(), lastName?.trim()].filter((part): part is string =>
    Boolean(part),
  );
  return parts.length > 0 ? parts.join(" ") : null;
}
