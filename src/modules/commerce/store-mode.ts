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
      code:
        | "INVALID_INPUT"
        | "NOT_FOUND"
        | "INVALID_TRANSITION"
        | "VERSION_CONFLICT"
        | "NOT_READY"
        | "CONFLICT";
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

export interface StoreOpenReadiness {
  activeProducts: number;
  inStockVariants: number;
}

/**
 * Final OPEN gate. Keep this in the mode domain so both the Telegram preview and the durable
 * confirmation check the same publication/stock invariant; a stale preview can never open an empty
 * or unpublished store.
 */
export async function getStoreOpenReadiness(exec: Executor): Promise<StoreOpenReadiness> {
  const result = await sql<{ active_products: number; in_stock_variants: number }>`
    with public_variants as (
      select v.id, v.fulfillment_type, v.stock_policy
        from product_variant v
        join product p on p.id = v.product_id
        join category c on c.id = p.category_id
       where v.is_active and p.is_active and c.is_active and not p.is_test and not p.is_archived
         and v.price_vnd > 0
         and v.resale_evidence_id is not null
         and v.publication_evidence_id = v.resale_evidence_id
         and v.publication_product_version = p.version
         and v.publication_variant_version = v.version
         and v.published_at is not null
         and ((v.stock_policy in ('LOCAL_ONLY','LOCAL_THEN_SUPPLIER') and v.fulfillment_type <> 'SUPPLIER_API')
           or (v.stock_policy = 'SUPPLIER_ONLY' and v.fulfillment_type = 'SUPPLIER_API' and exists (
             select 1 from supplier_sku ss join supplier s on s.id = ss.supplier_id
              where ss.variant_id = v.id and ss.is_active and s.status = 'ACTIVE')))
         and exists (
           select 1 from resale_evidence re
            where re.id = v.publication_evidence_id and re.variant_id = v.id and re.status = 'ACTIVE'
         )
    ),
    stock as (
      select pv.id,
        case
          when pv.fulfillment_type in ('STOCK_ACCOUNT','STOCK_CODE') then (
            select count(*)::int from digital_asset a where a.variant_id = pv.id and a.status = 'AVAILABLE'
          )
          when pv.fulfillment_type = 'QUANTITY_STOCK' then coalesce((
            select q.available_quantity from variant_quantity_stock q where q.variant_id = pv.id
          ), 0)::int
          when pv.fulfillment_type = 'DIGITAL_FILE' then (
            select count(*)::int from variant_file_artifact f where f.variant_id = pv.id and f.is_active
          )
          when pv.fulfillment_type = 'SUPPLIER_API' then (
            select count(*)::int from supplier_sku ss join supplier s on s.id = ss.supplier_id
             where ss.variant_id = pv.id and ss.is_active and s.status = 'ACTIVE'
          )
          when pv.fulfillment_type in ('MANUAL_FULFILLMENT','UNLIMITED_SERVICE') then (
            select count(*)::int from variant_service_fulfillment sf
             where sf.variant_id = pv.id and sf.fulfillment_type = pv.fulfillment_type and sf.is_active
          )
          else 0
        end as available
      from public_variants pv
    )
    select
      (select count(distinct p.id)::int
         from public_variants pv
         join product_variant v on v.id = pv.id
         join product p on p.id = v.product_id) as active_products,
      (select count(*)::int from stock where available > 0) as in_stock_variants
  `.execute(exec);
  const row = result.rows[0];
  return {
    activeProducts: row?.active_products ?? 0,
    inStockVariants: row?.in_stock_variants ?? 0,
  };
}

/** Test fixture compatibility only. Production owner mutations use transitionStoreMode. */
export async function setStoreModeForTest(
  db: Executor,
  mode: StoreMode,
  updatedBy: string,
): Promise<void> {
  if (process.env.NODE_ENV === "production")
    throw new Error("setStoreModeForTest is unavailable in production");
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
  if (input.targetMode === "OPEN") {
    const readiness = await getStoreOpenReadiness(exec);
    if (readiness.activeProducts === 0 || readiness.inStockVariants === 0) {
      return {
        ok: false,
        code: "NOT_READY",
        message: "Chưa có sản phẩm đã publish và còn hàng để mở store.",
      };
    }
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
