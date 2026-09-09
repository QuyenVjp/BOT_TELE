import { sql } from "kysely";
import type { Executor } from "../../infrastructure/db/transaction.js";
import { newId } from "../../shared/ids/index.js";

export type StoreMode = "CLOSED" | "TEST" | "OPEN";

const MODES = new Set<StoreMode>(["CLOSED", "TEST", "OPEN"]);

export async function getStoreMode(db: Executor): Promise<StoreMode> {
  const result = await sql<{ status: string }>`
    select status from store_control where id = 'main' limit 1
  `.execute(db);
  const status = result.rows[0]?.status;
  return MODES.has(status as StoreMode) ? (status as StoreMode) : "CLOSED";
}

export async function setStoreMode(
  db: Executor,
  mode: StoreMode,
  updatedBy: string,
): Promise<void> {
  await sql`
    insert into store_control (id, status, updated_at, updated_by)
    values ('main', ${mode}, now(), ${updatedBy})
    on conflict (id) do update
      set status = excluded.status, updated_at = now(), updated_by = excluded.updated_by
  `.execute(db);
}

export async function isTestCustomer(db: Executor, telegramUserId: string): Promise<boolean> {
  const result = await sql`
    select 1 from test_customer_allowlist where telegram_user_id = ${telegramUserId} limit 1
  `.execute(db);
  return result.rows.length > 0;
}

export async function addTestCustomer(
  db: Executor,
  telegramUserId: string,
  addedBy: string,
  note?: string,
): Promise<void> {
  await sql`
    insert into test_customer_allowlist (id, telegram_user_id, note, added_by)
    values (${newId()}, ${telegramUserId}, ${note ?? null}, ${addedBy})
    on conflict (telegram_user_id) do update
      set note = excluded.note, added_by = excluded.added_by
  `.execute(db);
}

export async function removeTestCustomer(db: Executor, telegramUserId: string): Promise<void> {
  await sql`delete from test_customer_allowlist where telegram_user_id = ${telegramUserId}`.execute(
    db,
  );
}

export interface TestCustomer {
  id: string;
  telegramUserId: string;
  note: string | null;
  addedBy: string | null;
  createdAt: Date | string;
}

export async function listTestCustomers(db: Executor): Promise<TestCustomer[]> {
  const result = await sql<{
    id: string;
    telegram_user_id: string;
    note: string | null;
    added_by: string | null;
    created_at: Date | string;
  }>`
    select id, telegram_user_id, note, added_by, created_at
      from test_customer_allowlist order by created_at asc, telegram_user_id asc
  `.execute(db);
  return result.rows.map((row) => ({
    id: row.id,
    telegramUserId: row.telegram_user_id,
    note: row.note,
    addedBy: row.added_by,
    createdAt: row.created_at,
  }));
}

export async function canPurchase(
  db: Executor,
  input: { telegramUserId: string; isRootAdmin: boolean; variantIsTest: boolean },
): Promise<{ ok: boolean; code?: string }> {
  const mode = await getStoreMode(db);
  if (mode === "CLOSED") return { ok: false, code: "STORE_CLOSED" };
  if (mode === "OPEN")
    return input.variantIsTest ? { ok: false, code: "STORE_TEST_ONLY" } : { ok: true };
  if (!input.variantIsTest) return { ok: false, code: "STORE_TEST_ONLY" };
  return input.isRootAdmin || (await isTestCustomer(db, input.telegramUserId))
    ? { ok: true }
    : { ok: false, code: "STORE_TEST_ONLY" };
}
