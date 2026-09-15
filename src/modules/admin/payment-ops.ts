import { sql } from "kysely";
import type { Db, Executor } from "../../infrastructure/db/transaction.js";
import { withTransaction } from "../../infrastructure/db/transaction.js";
import { isId } from "../../shared/ids/index.js";
import { appendAuditEvent } from "../identity/audit.js";

/**
 * Goal §95: the operator's payment queues. The admin payment screen used to show the SePay
 * reconciliation status and nothing else, so "unmatched money is never discarded" (§96) had nowhere
 * to be seen. Each view is a plain read of the same tables the domain settles from.
 */
export type AdminPaymentOpsView =
  "pending" | "late" | "paid" | "unmatched" | "discrepancy" | "refund";

export interface AdminPaymentOpsRow {
  id: string;
  label: string;
  detail: string;
}

export interface AdminPaymentOpsPage {
  view: AdminPaymentOpsView;
  title: string;
  rows: AdminPaymentOpsRow[];
  emptyHint: string;
}

export const ADMIN_PAYMENT_OPS_VIEWS: ReadonlyArray<{
  view: AdminPaymentOpsView;
  label: string;
}> = [
  { view: "pending", label: "⏳ Chờ thanh toán" },
  { view: "late", label: "⌛ Quá hạn" },
  { view: "paid", label: "✅ Đã thanh toán" },
  { view: "unmatched", label: "❓ Tiền chưa khớp" },
  { view: "discrepancy", label: "⚠️ Sai lệch" },
  { view: "refund", label: "↩️ Cần hoàn tiền" },
];

const TITLES: Record<AdminPaymentOpsView, string> = {
  pending: "⏳ CHỜ THANH TOÁN",
  late: "⌛ QUÁ HẠN",
  paid: "✅ ĐÃ THANH TOÁN",
  unmatched: "❓ TIỀN CHƯA KHỚP",
  discrepancy: "⚠️ SAI LỆCH",
  refund: "↩️ CẦN HOÀN TIỀN",
};

const EMPTY_HINTS: Record<AdminPaymentOpsView, string> = {
  pending: "Không có yêu cầu thanh toán nào đang chờ.",
  late: "Không có yêu cầu nào quá hạn.",
  paid: "Chưa có thanh toán nào thành công.",
  unmatched: "Không có khoản tiền nào chưa khớp.",
  discrepancy: "Không có sai lệch nào đang mở.",
  refund: "Không có nghĩa vụ hoàn tiền nào đang mở.",
};

const vnd = (value: bigint | number | string): string =>
  `${BigInt(value).toLocaleString("vi-VN")} ₫`;

const shortTime = (value: string | Date | null): string => {
  if (!value) return "—";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString("vi-VN", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
};

/**
 * Read one payment queue. Test and archived products are excluded the same way the health screen
 * excludes them (§136): a canary payment is not something an operator should be reconciling.
 */
export async function listAdminPaymentOps(
  exec: Executor,
  view: AdminPaymentOpsView,
  limit = 8,
): Promise<AdminPaymentOpsPage> {
  const base = { view, title: TITLES[view], emptyHint: EMPTY_HINTS[view] };

  if (view === "pending" || view === "late") {
    const late = view === "late";
    const result = await sql<{
      id: string;
      amount_vnd: string;
      expires_at: Date | null;
      order_number: string | null;
      transfer_content: string | null;
    }>`
      select i.id, i.amount_vnd::text as amount_vnd, i.expires_at, o.order_number, i.transfer_content
        from payment_intent i
        left join "order" o on o.id = i.order_id
        left join product_variant v on v.id = o.variant_id
        left join product p on p.id = v.product_id
       where i.status in ('CREATED', 'PRESENTED')
         and (${late} is false and i.expires_at > now() or ${late} is true and i.expires_at <= now())
         and (p.id is null or (not p.is_test and not p.is_archived))
       order by i.created_at desc
       limit ${limit}
    `.execute(exec);
    return {
      ...base,
      rows: result.rows.map((row) => ({
        id: row.id,
        label: `${row.order_number ?? "Đơn khác"} · ${vnd(row.amount_vnd)}`,
        detail: `${row.transfer_content ?? "—"} · hết hạn ${shortTime(row.expires_at)}`,
      })),
    };
  }

  if (view === "paid") {
    const result = await sql<{
      id: string;
      amount_vnd: string;
      settled_at: Date | null;
      order_number: string | null;
    }>`
      select i.id, i.amount_vnd::text as amount_vnd, i.settled_at, o.order_number
        from payment_intent i
        left join "order" o on o.id = i.order_id
        left join product_variant v on v.id = o.variant_id
        left join product p on p.id = v.product_id
       where i.status in ('SUCCEEDED', 'PARTIALLY_REFUNDED', 'REFUNDED')
         and (p.id is null or (not p.is_test and not p.is_archived))
       order by i.settled_at desc nulls last
       limit ${limit}
    `.execute(exec);
    return {
      ...base,
      rows: result.rows.map((row) => ({
        id: row.id,
        label: `${row.order_number ?? "Đơn khác"} · ${vnd(row.amount_vnd)}`,
        detail: `đã nhận ${shortTime(row.settled_at)}`,
      })),
    };
  }

  if (view === "unmatched" || view === "discrepancy") {
    const unmatched = view === "unmatched";
    const result = await sql<{
      id: string;
      type: string;
      reason: string | null;
      due_at: Date | null;
      bank_transaction_id: string | null;
      order_number: string | null;
    }>`
      select d.id, d.type, d.reason, d.due_at, d.bank_transaction_id, o.order_number
        from discrepancy d
        left join "order" o on o.id = d.order_id
       where d.resolved_at is null
         and (${unmatched} is true and d.type = 'UNMATCHED' or ${unmatched} is false and d.type <> 'UNMATCHED')
       order by d.due_at asc nulls last, d.id
       limit ${limit}
    `.execute(exec);
    return {
      ...base,
      rows: result.rows.map((row) => ({
        id: row.id,
        label: `${row.order_number ?? "Không gắn đơn"} · ${row.type}`,
        // Same safe projection as the detail view: the evidence id is masked to
        // its suffix and the reason is bounded, so a queue row can never render
        // a full provider reference or an unbounded customer string.
        detail: `${summarizeText(row.reason) ?? "—"}${
          row.bank_transaction_id ? ` · GD ${maskIdentifier(row.bank_transaction_id)}` : ""
        } · hạn ${shortTime(row.due_at)}`,
      })),
    };
  }

  const result = await sql<{
    id: string;
    amount_vnd: string;
    status: string;
    created_at: Date;
    order_number: string | null;
    claim_id: string | null;
  }>`
    select r.id, r.amount_vnd::text as amount_vnd, r.status, r.created_at, o.order_number, r.claim_id
      from shop_refund_obligation r
      left join "order" o on o.id = r.order_id
     where r.status = 'OPEN'
     order by r.created_at asc
     limit ${limit}
  `.execute(exec);
  return {
    ...base,
    rows: result.rows.map((row) => ({
      id: row.id,
      label: `${row.order_number ?? (row.claim_id ? "Bảo hành" : "Đặt cọc")} · ${vnd(row.amount_vnd)}`,
      detail: `phát sinh ${shortTime(row.created_at)}`,
    })),
  };
}

/* -------------------------------------------------------------------------- *
 * Discrepancy classification + disposition (production-remediation slice B).
 *
 * The operator queue above only *shows* open discrepancies. Closing one used to
 * be a hand-written `update … set status='RESOLVED'` in the Telegram callback
 * adapter, which meant: no version guard (two admins could both "resolve" one
 * row), no idempotency (a replayed confirmation resolved a second row), no
 * bounded resolution vocabulary, and no guaranteed audit. This is the typed
 * domain API the adapter calls instead — see `dispositionDiscrepancy`.
 *
 * Evidence is append-only: a disposition transitions the discrepancy row and
 * nothing else. `bank_transaction` and its aliases are never rewritten, and the
 * detail projection masks identifiers so an operator screen cannot leak a bank
 * account or an unbounded customer string.
 * -------------------------------------------------------------------------- */

/** Classifications the discrepancy table may carry (mirrors the SQL check). */
export const DISCREPANCY_CLASSIFICATIONS = [
  "UNDERPAYMENT",
  "OVERPAYMENT",
  "LATE_PAYMENT",
  "WRONG_CONTENT",
  "WRONG_ACCOUNT",
  "UNMATCHED",
  "REFERENCE_COLLISION",
  "REFUND_MISMATCH",
  "AMBIGUOUS_CORRELATION",
] as const;

export type DiscrepancyClassification = (typeof DISCREPANCY_CLASSIFICATIONS)[number];

/**
 * Bounded resolution vocabulary. A free-text resolution code is unqueryable, so
 * ops reports cannot be built on it; the operator's explanation lives in the
 * (bounded) note instead. `MANUAL_RESOLVE` is retained because it is the code
 * the pre-remediation callback path already wrote.
 */
export const DISCREPANCY_RESOLUTION_CODES = [
  "MANUAL_RESOLVE",
  "MANUAL_SETTLE",
  "MANUAL_REFUND",
  "DUPLICATE_EVIDENCE",
  "INVALID_EVIDENCE",
  "NO_ACTION_REQUIRED",
  "ESCALATED",
] as const;

export type DiscrepancyResolutionCode = (typeof DISCREPANCY_RESOLUTION_CODES)[number];

/** Audit action recorded for every accepted disposition (step-up allowlisted). */
export const DISCREPANCY_DISPOSITION_AUDIT_ACTION = "discrepancy.resolve";

export function isDiscrepancyClassification(value: string): value is DiscrepancyClassification {
  return (DISCREPANCY_CLASSIFICATIONS as readonly string[]).includes(value);
}

export function isDiscrepancyResolutionCode(value: string): value is DiscrepancyResolutionCode {
  return (DISCREPANCY_RESOLUTION_CODES as readonly string[]).includes(value);
}

const MAX_NOTE_LENGTH = 200;
const MAX_TEXT_SUMMARY_LENGTH = 40;
const MAX_REQUEST_ID_LENGTH = 128;

/** Collapse to one line and bound the length; never return unbounded text. */
function summarizeText(value: string | null): string | null {
  if (!value) return null;
  const flat = value.replace(/\s+/g, " ").trim();
  if (flat.length === 0) return null;
  return flat.length <= MAX_TEXT_SUMMARY_LENGTH
    ? flat
    : `${flat.slice(0, MAX_TEXT_SUMMARY_LENGTH)}…`;
}

/** Keep only the tail of an opaque identifier — enough to eyeball, not to reuse. */
function maskIdentifier(value: string | null): string | null {
  if (!value) return null;
  const flat = value.trim();
  if (flat.length === 0) return null;
  if (flat.length <= 4) return "•".repeat(flat.length);
  return `${"•".repeat(Math.min(flat.length - 4, 12))}${flat.slice(-4)}`;
}

/** Normalize an operator note, or null when it is blank / over the bound. */
function normalizeNote(note: string | null | undefined): string | null {
  if (typeof note !== "string") return null;
  const flat = note.replace(/\s+/g, " ").trim();
  if (flat.length === 0 || flat.length > MAX_NOTE_LENGTH) return null;
  return flat;
}

export interface SafeBankTransactionEvidence {
  bankTransactionId: string;
  provider: string;
  providerTransactionIdMasked: string;
  merchantAccountMasked: string;
  direction: string;
  amountVnd: bigint;
  referenceMasked: string | null;
  /** Bounded, single-line. The raw bank content is never rendered in full. */
  transferContentSummary: string | null;
  transactedAt: string;
  signatureStatus: string;
  /** The canonical row is append-only; a disposition never rewrites it. */
  immutable: true;
}

export interface AdminDiscrepancyDetail {
  id: string;
  classification: string;
  classificationKnown: boolean;
  status: string;
  /** Bounded domain reason (never the raw bank payload). */
  reason: string;
  owner: string;
  dueAt: string | null;
  version: number;
  resolutionCode: string | null;
  resolutionNote: string | null;
  resolvedAt: string | null;
  resolvedBy: string | null;
  orderId: string | null;
  orderNumber: string | null;
  paymentIntentId: string | null;
  evidence: SafeBankTransactionEvidence | null;
}

interface DiscrepancyDetailRow {
  id: string;
  type: string;
  status: string;
  reason: string;
  owner: string;
  due_at: Date | string | null;
  version: number;
  resolution_code: string | null;
  resolution_note: string | null;
  resolved_at: Date | string | null;
  resolved_by: string | null;
  order_id: string | null;
  order_number: string | null;
  payment_intent_id: string | null;
  bank_transaction_id: string | null;
  bt_provider: string | null;
  bt_provider_transaction_id: string | null;
  bt_merchant_account_id: string | null;
  bt_direction: string | null;
  bt_amount_vnd: string | number | null;
  bt_reference: string | null;
  bt_content: string | null;
  bt_transacted_at: Date | string | null;
  bt_signature_status: string | null;
}

function isoOrNull(value: Date | string | null): string | null {
  if (value === null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function mapDetail(row: DiscrepancyDetailRow): AdminDiscrepancyDetail {
  const evidence: SafeBankTransactionEvidence | null =
    row.bank_transaction_id === null
      ? null
      : {
          bankTransactionId: row.bank_transaction_id,
          provider: row.bt_provider ?? "unknown",
          providerTransactionIdMasked: maskIdentifier(row.bt_provider_transaction_id) ?? "—",
          merchantAccountMasked: maskIdentifier(row.bt_merchant_account_id) ?? "—",
          direction: row.bt_direction ?? "—",
          amountVnd: BigInt(row.bt_amount_vnd ?? 0),
          referenceMasked: maskIdentifier(row.bt_reference),
          transferContentSummary: summarizeText(row.bt_content),
          transactedAt: isoOrNull(row.bt_transacted_at) ?? "—",
          signatureStatus: row.bt_signature_status ?? "—",
          immutable: true,
        };

  return {
    id: row.id,
    classification: row.type,
    classificationKnown: isDiscrepancyClassification(row.type),
    status: row.status,
    reason: summarizeText(row.reason) ?? "—",
    owner: row.owner,
    dueAt: isoOrNull(row.due_at),
    version: row.version,
    resolutionCode: row.resolution_code,
    resolutionNote: row.resolution_note,
    resolvedAt: isoOrNull(row.resolved_at),
    resolvedBy: row.resolved_by,
    orderId: row.order_id,
    orderNumber: row.order_number,
    paymentIntentId: row.payment_intent_id,
    evidence,
  };
}

const DISCREPANCY_DETAIL_SELECT = sql`
  select d.id, d.type, d.status, d.reason, d.owner, d.due_at, d.version,
         d.resolution_code, d.resolution_note, d.resolved_at, d.resolved_by,
         d.order_id, d.payment_intent_id, d.bank_transaction_id,
         o.order_number,
         bt.provider as bt_provider,
         bt.provider_transaction_id as bt_provider_transaction_id,
         bt.merchant_account_id as bt_merchant_account_id,
         bt.direction as bt_direction,
         bt.amount_vnd as bt_amount_vnd,
         bt.reference as bt_reference,
         bt.content as bt_content,
         bt.transacted_at as bt_transacted_at,
         bt.signature_status as bt_signature_status
    from discrepancy d
    left join "order" o on o.id = d.order_id
    left join bank_transaction bt on bt.id = d.bank_transaction_id
`;

/** Safe-by-default detail for the operator screen. Null when the id is unknown. */
export async function getAdminDiscrepancyDetail(
  exec: Executor,
  discrepancyId: string,
): Promise<AdminDiscrepancyDetail | null> {
  if (!isId(discrepancyId)) return null;
  const result = await sql<DiscrepancyDetailRow>`
    ${DISCREPANCY_DETAIL_SELECT}
    where d.id = ${discrepancyId}
  `.execute(exec);
  const row = result.rows[0];
  return row ? mapDetail(row) : null;
}

export type DiscrepancyDispositionFailure =
  /** No discrepancy with that id. */
  | "NOT_FOUND"
  /** The caller's snapshot is stale; re-read and retry. */
  | "VERSION_CONFLICT"
  /** Another confirmation already closed this discrepancy. */
  | "ALREADY_RESOLVED"
  /** Same request id, different decision (or reused on another discrepancy). */
  | "CONFLICTING_REPEAT"
  | "INVALID_RESOLUTION_CODE"
  | "INVALID_NOTE";

export type DiscrepancyDispositionResult =
  | {
      ok: true;
      /** `RESOLVED` = this call made the change; `REPLAYED` = it already happened. */
      kind: "RESOLVED" | "REPLAYED";
      discrepancyId: string;
      version: number;
      /** Null on a replay: a repeated confirmation appends nothing. */
      auditEventId: string | null;
    }
  | { ok: false; code: DiscrepancyDispositionFailure; message: string };

export interface DispositionDiscrepancyInput {
  discrepancyId: string;
  /** Version the operator saw, from {@link getAdminDiscrepancyDetail}. */
  expectedVersion: number;
  resolutionCode: DiscrepancyResolutionCode;
  /** Operator explanation. Required, single-line, at most 200 characters. */
  note: string;
  /**
   * Idempotency key of one operator confirmation. Replaying the same request id
   * against the same row is a no-op success; reusing it elsewhere is rejected.
   */
  requestId: string;
  actorId: string;
  correlationId: string;
}

interface DiscrepancyRow {
  id: string;
  status: string;
  version: number;
  resolution_code: string | null;
  resolved_at: Date | string | null;
  disposition_request_id: string | null;
}

/**
 * Close an OPEN discrepancy under an optimistic version guard, idempotent on
 * the request id. Runs in the caller's transaction so the disposition and its
 * audit event commit together (and so a confirming step-up flow can wrap both).
 */
export async function dispositionDiscrepancyInTransaction(
  exec: Executor,
  input: DispositionDiscrepancyInput,
): Promise<DiscrepancyDispositionResult> {
  if (!isDiscrepancyResolutionCode(input.resolutionCode)) {
    return {
      ok: false,
      code: "INVALID_RESOLUTION_CODE",
      message: "Mã xử lý không nằm trong danh sách cho phép.",
    };
  }
  const note = normalizeNote(input.note);
  if (note === null) {
    return {
      ok: false,
      code: "INVALID_NOTE",
      message: `Ghi chú xử lý bắt buộc, tối đa ${MAX_NOTE_LENGTH} ký tự.`,
    };
  }
  const requestId = input.requestId?.trim() ?? "";
  if (requestId.length === 0 || requestId.length > MAX_REQUEST_ID_LENGTH) {
    return { ok: false, code: "CONFLICTING_REPEAT", message: "Mã yêu cầu không hợp lệ." };
  }
  if (!isId(input.discrepancyId)) {
    return { ok: false, code: "NOT_FOUND", message: "Không tìm thấy sai lệch." };
  }

  const current = await sql<DiscrepancyRow>`
    select id, status, version, resolution_code, resolved_at, disposition_request_id
    from discrepancy
    where id = ${input.discrepancyId}
    for update
  `.execute(exec);
  const row = current.rows[0];
  if (!row) return { ok: false, code: "NOT_FOUND", message: "Không tìm thấy sai lệch." };

  // A replay of the SAME confirmation is checked before the version guard: the
  // first attempt advanced the version, so the retrying caller necessarily
  // holds the stale one.
  if (row.disposition_request_id === requestId) {
    return row.resolution_code === input.resolutionCode
      ? {
          ok: true,
          kind: "REPLAYED",
          discrepancyId: row.id,
          version: row.version,
          auditEventId: null,
        }
      : {
          ok: false,
          code: "CONFLICTING_REPEAT",
          message: "Mã yêu cầu này đã được dùng cho một kết luận khác.",
        };
  }

  // A closed discrepancy is answered as such regardless of the version the
  // caller holds: "re-read and retry" would only loop, because the row is done.
  // This also precedes the version guard so a second, different confirmation
  // reports the real situation rather than a misleading conflict.
  if (row.status !== "OPEN" || row.resolved_at !== null) {
    return {
      ok: false,
      code: "ALREADY_RESOLVED",
      message: "Sai lệch này đã được xử lý.",
    };
  }

  if (!Number.isInteger(input.expectedVersion) || row.version !== input.expectedVersion) {
    return {
      ok: false,
      code: "VERSION_CONFLICT",
      message: "Sai lệch đã được thay đổi bởi thao tác khác. Vui lòng mở lại.",
    };
  }

  // The request id is unique across discrepancies: a collision means the same
  // confirmation was replayed against a different row (the unique index is the
  // backstop for the concurrent case).
  const reused = await sql<{ id: string }>`
    select id from discrepancy
    where disposition_request_id = ${requestId} and id <> ${row.id}
    limit 1
  `.execute(exec);
  if (reused.rows[0]) {
    return {
      ok: false,
      code: "CONFLICTING_REPEAT",
      message: "Mã yêu cầu này đã xử lý một sai lệch khác.",
    };
  }

  const updated = await sql<{ version: number }>`
    update discrepancy
    set status = 'RESOLVED',
        resolution_code = ${input.resolutionCode},
        resolution_note = ${note},
        resolved_at = now(),
        resolved_by = ${input.actorId},
        disposition_request_id = ${requestId},
        version = version + 1
    where id = ${row.id} and status = 'OPEN' and version = ${input.expectedVersion}
    returning version
  `.execute(exec);
  const version = updated.rows[0]?.version;
  if (version === undefined) {
    return {
      ok: false,
      code: "VERSION_CONFLICT",
      message: "Sai lệch đã được thay đổi bởi thao tác khác. Vui lòng mở lại.",
    };
  }

  const auditEventId = await appendAuditEvent(exec, {
    actorType: "ROOT_ADMIN",
    actorId: input.actorId,
    action: DISCREPANCY_DISPOSITION_AUDIT_ACTION,
    targetType: "Discrepancy",
    targetId: row.id,
    reason: note,
    correlationId: input.correlationId,
    metadataRedacted: {
      resolutionCode: input.resolutionCode,
      version,
      requestId,
    },
  });

  return { ok: true, kind: "RESOLVED", discrepancyId: row.id, version, auditEventId };
}

/** Transactional entry point for callers that are not already in a unit of work. */
export async function dispositionDiscrepancy(
  db: Db,
  input: DispositionDiscrepancyInput,
): Promise<DiscrepancyDispositionResult> {
  return withTransaction(db, (trx) => dispositionDiscrepancyInTransaction(trx, input));
}
