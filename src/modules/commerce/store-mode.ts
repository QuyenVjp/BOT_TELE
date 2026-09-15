import { sql } from "kysely";
import type { Db, Executor } from "../../infrastructure/db/transaction.js";
import { withTransaction } from "../../infrastructure/db/transaction.js";
import { appendAuditEvent } from "../identity/audit.js";
import { newId } from "../../shared/ids/index.js";

export type StoreMode = "CLOSED" | "TEST" | "OPEN";
export interface StoreControl {
  id: string;
  status: StoreMode;
  version: number;
  updatedAt: string;
  updatedBy: string | null;
  lastRequestId: string | null;
}

export interface StoreModeTransitionInput {
  targetMode: StoreMode;
  expectedVersion: number;
  requestId: string;
  actorId: string;
  reason: string;
  correlationId: string;
}

export type StoreModeTransitionResult =
  | { ok: true; kind: "CHANGED" | "REPLAYED"; control: StoreControl }
  | {
      ok: false;
      code: "INVALID_INPUT" | "NOT_FOUND" | "INVALID_TRANSITION" | "VERSION_CONFLICT" | "CONFLICT";
      message: string;
    };

const MODES: Record<StoreMode, true> = { CLOSED: true, TEST: true, OPEN: true };
const ALLOWED_TRANSITIONS: Record<StoreMode, readonly StoreMode[]> = {
  CLOSED: ["TEST", "OPEN"],
  TEST: ["CLOSED"],
  OPEN: ["CLOSED"],
};

function asMode(value: string): StoreMode {
  return Object.hasOwn(MODES, value) ? (value as StoreMode) : "CLOSED";
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export async function getStoreControl(exec: Executor, id = "main"): Promise<StoreControl> {
  const result = await sql<{
    id: string;
    status: string;
    version: number;
    updated_at: Date | string;
    updated_by: string | null;
    last_request_id: string | null;
  }>`
    select id, status, version, updated_at, updated_by, last_request_id
      from store_control where id = ${id} limit 1
  `.execute(exec);
  const row = result.rows[0];
  if (!row) {
    return {
      id,
      status: "CLOSED",
      version: 1,
      updatedAt: new Date(0).toISOString(),
      updatedBy: null,
      lastRequestId: null,
    };
  }
  return {
    id: row.id,
    status: asMode(row.status),
    version: row.version,
    updatedAt: toIso(row.updated_at),
    updatedBy: row.updated_by,
    lastRequestId: row.last_request_id,
  };
}

export async function getStoreMode(db: Executor): Promise<StoreMode> {
  return (await getStoreControl(db)).status;
}

/** Test fixture compatibility only. Production owner mutations use transitionStoreMode. */
export async function setStoreMode(
  db: Executor,
  mode: StoreMode,
  updatedBy: string,
): Promise<void> {
  await sql`
    insert into store_control (id, status, updated_at, updated_by, version)
    values ('main', ${mode}, now(), ${updatedBy}, 1)
    on conflict (id) do update
      set status = excluded.status,
          updated_at = now(),
          updated_by = excluded.updated_by,
          version = store_control.version + 1,
          last_request_id = null
  `.execute(db);
}

export async function transitionStoreModeInTransaction(
  exec: Executor,
  input: StoreModeTransitionInput,
): Promise<StoreModeTransitionResult> {
  if (!Object.hasOwn(MODES, input.targetMode) || !Number.isInteger(input.expectedVersion)) {
    return { ok: false, code: "INVALID_INPUT", message: "Trạng thái hoặc phiên bản không hợp lệ." };
  }
  const requestId = input.requestId.trim();
  const reason = input.reason.trim();
  if (
    requestId.length === 0 ||
    requestId.length > 128 ||
    reason.length === 0 ||
    reason.length > 500
  ) {
    return { ok: false, code: "INVALID_INPUT", message: "Thiếu mã yêu cầu hoặc lý do." };
  }
  const current = await sql<{
    id: string;
    status: string;
    version: number;
    updated_at: Date | string;
    updated_by: string | null;
    last_request_id: string | null;
  }>`
    select id, status, version, updated_at, updated_by, last_request_id
      from store_control where id = 'main' for update
  `.execute(exec);
  const row = current.rows[0];
  if (!row) return { ok: false, code: "NOT_FOUND", message: "Chưa có cấu hình store control." };
  const mode = asMode(row.status);
  const existing = await sql<{ from_status: string; to_status: string; resulting_version: number }>`
    select from_status, to_status, resulting_version
      from store_mode_transition where request_id = ${requestId} and store_id = 'main' limit 1
  `.execute(exec);
  if (existing.rows[0]) {
    if (existing.rows[0].to_status !== input.targetMode) {
      return {
        ok: false,
        code: "CONFLICT",
        message: "Mã yêu cầu đã dùng cho chuyển trạng thái khác.",
      };
    }
    return {
      ok: true,
      kind: "REPLAYED",
      control: {
        id: "main",
        status: asMode(existing.rows[0].to_status),
        version: existing.rows[0].resulting_version,
        updatedAt: toIso(row.updated_at),
        updatedBy: row.updated_by,
        lastRequestId: requestId,
      },
    };
  }
  if (!ALLOWED_TRANSITIONS[mode].includes(input.targetMode)) {
    return {
      ok: false,
      code: "INVALID_TRANSITION",
      message: "Chỉ cho phép CLOSED↔TEST hoặc CLOSED↔OPEN.",
    };
  }
  if (row.version !== input.expectedVersion) {
    return { ok: false, code: "VERSION_CONFLICT", message: "Store đã thay đổi. Vui lòng mở lại." };
  }
  const updated = await sql<{
    version: number;
    updated_at: Date | string;
    updated_by: string | null;
  }>`
    update store_control
       set status = ${input.targetMode}, version = version + 1,
           updated_at = now(), updated_by = ${input.actorId}, last_request_id = ${requestId}
     where id = 'main' and version = ${input.expectedVersion}
     returning version, updated_at, updated_by
  `.execute(exec);
  const next = updated.rows[0];
  if (!next)
    return { ok: false, code: "VERSION_CONFLICT", message: "Store đã thay đổi. Vui lòng mở lại." };
  await sql`
    insert into store_mode_transition
      (id, store_id, from_status, to_status, expected_version, resulting_version, request_id, actor_id, reason, correlation_id)
    values
      (${newId()}, 'main', ${mode}, ${input.targetMode}, ${input.expectedVersion}, ${next.version}, ${requestId}, ${input.actorId}, ${reason}, ${input.correlationId})
  `.execute(exec);
  await appendAuditEvent(exec, {
    actorType: "ROOT_ADMIN",
    actorId: input.actorId,
    action: `store.${input.targetMode.toLowerCase()}`,
    targetType: "StoreControl",
    targetId: "main",
    reason,
    correlationId: input.correlationId,
    metadataRedacted: {
      from: mode,
      to: input.targetMode,
      expectedVersion: input.expectedVersion,
      version: next.version,
      requestId,
    },
  });
  return {
    ok: true,
    kind: "CHANGED",
    control: {
      id: "main",
      status: input.targetMode,
      version: next.version,
      updatedAt: toIso(next.updated_at),
      updatedBy: next.updated_by,
      lastRequestId: requestId,
    },
  };
}

export async function transitionStoreMode(
  db: Db,
  input: StoreModeTransitionInput,
): Promise<StoreModeTransitionResult> {
  return withTransaction(db, (trx) => transitionStoreModeInTransaction(trx, input));
}

export async function isTestCustomer(db: Executor, telegramUserId: string): Promise<boolean> {
  const result =
    await sql`select 1 from test_customer_allowlist where telegram_user_id = ${telegramUserId} limit 1`.execute(
      db,
    );
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
    on conflict (telegram_user_id) do update set note = excluded.note, added_by = excluded.added_by
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
    select id, telegram_user_id, note, added_by, created_at from test_customer_allowlist
     order by created_at asc, telegram_user_id asc
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
