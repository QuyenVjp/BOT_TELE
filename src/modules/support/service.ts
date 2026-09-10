import { sql } from "kysely";
import type { Db, Executor } from "../../infrastructure/db/transaction.js";
import { withTransaction } from "../../infrastructure/db/transaction.js";
import { enqueueOutboxEvent } from "../../infrastructure/outbox/repository.js";
import { newId } from "../../shared/ids/index.js";
import { appendAuditEvent } from "../identity/audit.js";
import { findOrderById } from "../commerce/repository.js";
import { openReplacementCase } from "../digital-goods/replacement.js";
import {
  canTicketTransition,
  isSupportReasonCode,
  slaDueAt,
  toSafeSummary,
  type SupportReasonCode,
  type SupportTicketStatus,
} from "./domain.js";

/**
 * Customer-scoped support commands (T086, FR-019, SR-003).
 *
 * The customer verbs are ONLY ticket verbs: open / list / get / close. They
 * import nothing from payments, delivery, vault, or supplier — so they cannot
 * mark paid, mutate evidence, refund, or reveal a credential. Ownership is
 * enforced on every linked-Order path. The admin views at the bottom of this
 * file are authorized by the caller (the worker) before they run and still
 * touch ticket columns only.
 */

export interface SupportTicket {
  id: string;
  customerId: string;
  orderId: string | null;
  reasonCode: SupportReasonCode;
  status: SupportTicketStatus;
  safeSummary: string;
  dueAt: string | null;
  createdAt: string;
}

export type OpenTicketResult =
  | { ok: true; ticketId: string; status: SupportTicketStatus; replacementCaseId?: string }
  | {
      ok: false;
      code: "INVALID_REASON" | "ORDER_NOT_FOUND" | "ORDER_NOT_OWNED" | "EMPTY_SUMMARY";
      message: string;
    };

export interface OpenTicketInput {
  customerId: string;
  orderId?: string;
  reasonCode: string;
  description: string;
  correlationId: string;
}

export interface ListTicketsInput {
  customerId: string;
  limit?: number;
}

export interface SupportService {
  openTicket(input: OpenTicketInput): Promise<OpenTicketResult>;
  listTickets(input: ListTicketsInput): Promise<SupportTicket[]>;
  getTicket(input: { ticketId: string; customerId: string }): Promise<SupportTicket | null>;
  closeTicket(input: {
    ticketId: string;
    customerId: string;
    correlationId: string;
  }): Promise<{ ok: true } | { ok: false; code: "NOT_FOUND" | "NOT_OWNED"; message: string }>;
}

interface TicketRow {
  id: string;
  customer_id: string;
  order_id: string | null;
  reason_code: SupportReasonCode;
  status: SupportTicketStatus;
  safe_summary: string;
  due_at: Date | string | null;
  created_at: Date | string;
}

function toIso(v: Date | string | null): string | null {
  if (v === null) return null;
  return v instanceof Date ? v.toISOString() : new Date(v).toISOString();
}

function mapTicket(row: TicketRow): SupportTicket {
  return {
    id: row.id,
    customerId: row.customer_id,
    orderId: row.order_id,
    reasonCode: row.reason_code,
    status: row.status,
    safeSummary: row.safe_summary,
    dueAt: toIso(row.due_at),
    createdAt: toIso(row.created_at) ?? new Date().toISOString(),
  };
}

export function createSupportService(db: Db): SupportService {
  return {
    async openTicket(input) {
      if (!isSupportReasonCode(input.reasonCode)) {
        return {
          ok: false,
          code: "INVALID_REASON",
          message: "Lý do hỗ trợ không hợp lệ.",
        };
      }
      const summary = toSafeSummary(input.description);
      if (summary.length === 0) {
        return {
          ok: false,
          code: "EMPTY_SUMMARY",
          message: "Vui lòng mô tả vấn đề ngắn gọn.",
        };
      }

      // Ownership: a linked Order must belong to the customer.
      if (input.orderId) {
        const order = await findOrderById(db, input.orderId);
        if (!order) {
          return { ok: false, code: "ORDER_NOT_FOUND", message: "Không tìm thấy đơn hàng." };
        }
        if (order.customerId !== input.customerId) {
          return {
            ok: false,
            code: "ORDER_NOT_OWNED",
            message: "Bạn không sở hữu đơn hàng này.",
          };
        }
      }

      const now = new Date();
      const due = slaDueAt(input.reasonCode, now);

      const ticketId = await withTransaction(db, async (trx) => {
        // Replayed Telegram callbacks carry the same stable correlation id.
        // Serialize that key across workers, then reuse the already committed
        // TicketOpened effect instead of creating duplicate support tickets.
        await sql`select pg_advisory_xact_lock(hashtextextended(${input.correlationId}, 0))`.execute(
          trx,
        );
        const existing = await sql<{ aggregate_id: string }>`
          select aggregate_id
          from outbox_event
          where event_type = 'TicketOpened'
            and payload_redacted ->> 'correlationId' = ${input.correlationId}
            and payload_redacted ->> 'customerId' = ${input.customerId}
          limit 1
        `.execute(trx);
        if (existing.rows[0]) return existing.rows[0].aggregate_id;

        const createdTicketId = newId();
        await sql`
          insert into support_ticket
            (id, customer_id, order_id, reason_code, status, safe_summary, due_at)
          values
            (${createdTicketId}, ${input.customerId}, ${input.orderId ?? null},
             ${input.reasonCode}, 'OPEN', ${summary}, ${due.toISOString()})
        `.execute(trx);

        await enqueueOutboxEvent(trx, {
          id: newId(),
          aggregateType: "SupportTicket",
          aggregateId: createdTicketId,
          aggregateVersion: 1,
          eventType: "TicketOpened",
          payloadRedacted: {
            ticketId: createdTicketId,
            customerId: input.customerId,
            orderId: input.orderId ?? null,
            reasonCode: input.reasonCode,
            correlationId: input.correlationId,
          },
        });
        return createdTicketId;
      });

      if (input.orderId && input.reasonCode === "ASSET_NOT_WORKING") {
        const replacement = await openReplacementCase(db, {
          orderId: input.orderId,
          customerId: input.customerId,
          reasonCode: "INVALID_CREDENTIAL",
          requestRefund: false,
          correlationId: input.correlationId,
        });
        if (replacement.ok)
          return { ok: true, ticketId, status: "OPEN", replacementCaseId: replacement.caseId };
      }

      return { ok: true, ticketId, status: "OPEN" };
    },

    async listTickets(input) {
      const limit = Math.max(1, Math.min(input.limit ?? 20, 50));
      const result = await sql<TicketRow>`
        select id, customer_id, order_id, reason_code, status, safe_summary, due_at, created_at
        from support_ticket
        where customer_id = ${input.customerId}
        order by created_at desc
        limit ${limit}
      `.execute(db);
      return result.rows.map(mapTicket);
    },

    async getTicket(input) {
      const result = await sql<TicketRow>`
        select id, customer_id, order_id, reason_code, status, safe_summary, due_at, created_at
        from support_ticket
        where id = ${input.ticketId} and customer_id = ${input.customerId}
        limit 1
      `.execute(db);
      const row = result.rows[0];
      return row ? mapTicket(row) : null;
    },

    async closeTicket(input) {
      const existing = await findTicket(db, input.ticketId);
      if (!existing) {
        return { ok: false, code: "NOT_FOUND", message: "Không tìm thấy ticket." };
      }
      if (existing.customer_id !== input.customerId) {
        return { ok: false, code: "NOT_OWNED", message: "Bạn không sở hữu ticket này." };
      }
      await sql`
        update support_ticket
        set status = 'CLOSED', updated_at = now(), version = version + 1
        where id = ${input.ticketId} and customer_id = ${input.customerId}
      `.execute(db);
      return { ok: true };
    },
  };
}

async function findTicket(exec: Executor, ticketId: string): Promise<TicketRow | null> {
  const result = await sql<TicketRow>`
    select id, customer_id, order_id, reason_code, status, safe_summary, due_at, created_at
    from support_ticket where id = ${ticketId} limit 1
  `.execute(exec);
  return result.rows[0] ?? null;
}

/** Owner-facing ticket row. A short customer label, never a raw telegram identity. */
export interface AdminSupportTicketRow {
  id: string;
  customerLabel: string;
  reasonCode: SupportReasonCode;
  status: SupportTicketStatus;
  safeSummary: string;
  orderNumber: string | null;
  dueAt: string | null;
}

interface AdminTicketRow {
  id: string;
  customer_id: string;
  reason_code: SupportReasonCode;
  status: SupportTicketStatus;
  safe_summary: string;
  due_at: Date | string | null;
  order_number: string | null;
}

function mapAdminTicket(row: AdminTicketRow): AdminSupportTicketRow {
  return {
    id: row.id,
    // Same short label the warranty queue uses; the owner reads a ticket, not an id.
    customerLabel: `Khách ${row.customer_id.slice(-4).toUpperCase()}`,
    reasonCode: row.reason_code,
    status: row.status,
    safeSummary: row.safe_summary,
    orderNumber: row.order_number,
    dueAt: toIso(row.due_at),
  };
}

/** Tickets still needing an answer, most urgent SLA first. */
export async function listOpenTickets(db: Db, limit = 20): Promise<AdminSupportTicketRow[]> {
  const result = await sql<AdminTicketRow>`
    select t.id, t.customer_id, t.reason_code, t.status, t.safe_summary, t.due_at,
           o.order_number
    from support_ticket t
    left join "order" o on o.id = t.order_id
    where t.status not in ('RESOLVED', 'CLOSED')
    order by t.due_at asc nulls last, t.id asc
    limit ${Math.max(1, Math.min(limit, 50))}
  `.execute(db);
  return result.rows.map(mapAdminTicket);
}

export async function getAdminTicket(
  db: Db,
  ticketId: string,
): Promise<AdminSupportTicketRow | null> {
  const result = await sql<AdminTicketRow>`
    select t.id, t.customer_id, t.reason_code, t.status, t.safe_summary, t.due_at,
           o.order_number
    from support_ticket t
    left join "order" o on o.id = t.order_id
    where t.id = ${ticketId}
    limit 1
  `.execute(db);
  const row = result.rows[0];
  return row ? mapAdminTicket(row) : null;
}

export type SetTicketStatusResult =
  | { ok: true; from: SupportTicketStatus; to: SupportTicketStatus; customerId: string }
  | { ok: false; code: "NOT_FOUND" | "ILLEGAL_STATE" };

/**
 * Move a ticket to `toStatus`, refusing any transition the customer-facing state
 * machine forbids. `toStatus` arrives from callback data, so it is validated
 * before the row is read.
 */
export async function setTicketStatus(input: {
  db: Db;
  ticketId: string;
  toStatus: string;
  actorId: string;
  correlationId: string;
}): Promise<SetTicketStatusResult> {
  if (!isTicketStatus(input.toStatus)) return { ok: false, code: "ILLEGAL_STATE" };
  const to = input.toStatus;
  return withTransaction(input.db, async (trx) => {
    // Lock the row: two taps must not both read the same `from` status and apply twice.
    const found = await sql<{ status: SupportTicketStatus; customer_id: string }>`
      select status, customer_id from support_ticket where id = ${input.ticketId} for update
    `.execute(trx);
    const row = found.rows[0];
    if (!row) return { ok: false, code: "NOT_FOUND" };
    if (!canTicketTransition(row.status, to)) return { ok: false, code: "ILLEGAL_STATE" };
    await sql`
      update support_ticket
      set status = ${to}, updated_at = now(), version = version + 1
      where id = ${input.ticketId}
    `.execute(trx);
    await appendAuditEvent(trx, {
      actorType: "ROOT_ADMIN",
      actorId: input.actorId,
      action: "support.ticket.status",
      targetType: "SupportTicket",
      targetId: input.ticketId,
      reason: "Root admin moved a support ticket",
      correlationId: input.correlationId,
      metadataRedacted: { from: row.status, to },
    });
    return { ok: true, from: row.status, to, customerId: row.customer_id };
  });
}

const TICKET_STATUSES: readonly SupportTicketStatus[] = [
  "OPEN",
  "WAITING_SHOP",
  "WAITING_CUSTOMER",
  "RESOLVED",
  "CLOSED",
  "MANUAL_REVIEW",
];

function isTicketStatus(value: string): value is SupportTicketStatus {
  return (TICKET_STATUSES as readonly string[]).includes(value);
}
