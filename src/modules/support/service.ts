import { sql } from "kysely";
import type { Db } from "../../infrastructure/db/transaction.js";
import { withTransaction } from "../../infrastructure/db/transaction.js";
import { enqueueOutboxEvent } from "../../infrastructure/outbox/repository.js";
import { newId } from "../../shared/ids/index.js";
import { appendAuditEvent } from "../identity/audit.js";
import { findOrderByIdForOwner } from "../commerce/repository.js";
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
 * Customer verbs are ticket-only: begin/submit/cancel description, open/list/get/close.
 * The durable description draft is a WAITING_CUSTOMER ticket owned by its customer.
 * This module imports nothing from payments, delivery, vault, or supplier, so it cannot
 * mark paid, mutate evidence, refund, or reveal a credential. Ownership is enforced
 * on every linked-Order and ticket path.
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
  /** Optimistic-concurrency version, exposed to owner/admin state handlers. */
  version?: number;
}

export type OpenTicketResult =
  | { ok: true; ticketId: string; status: SupportTicketStatus; replacementCaseId?: string }
  | {
      ok: false;
      code: "INVALID_REASON" | "ORDER_NOT_FOUND" | "EMPTY_SUMMARY";
      message: string;
    };

export interface OpenTicketInput {
  customerId: string;
  orderId?: string;
  reasonCode: string;
  description: string;
  correlationId: string;
}

export interface BeginDescriptionInput {
  customerId: string;
  orderId?: string;
  reasonCode: string;
  correlationId: string;
}

export type BeginDescriptionResult =
  | {
      ok: true;
      ticketId: string;
      status: "WAITING_CUSTOMER";
      reasonCode: SupportReasonCode;
      orderId: string | null;
    }
  | {
      ok: false;
      code: "INVALID_REASON" | "ORDER_NOT_FOUND" | "ALREADY_SUBMITTED";
      message: string;
    };
export interface SubmitDescriptionInput {
  customerId: string;
  /** Optional durable draft id from a sealed callback; ordinary text may omit it. */
  ticketId?: string;
  description: string;
  correlationId: string;
}

export type SubmitDescriptionResult =
  | {
      ok: true;
      ticketId: string;
      status: "WAITING_SHOP";
      reasonCode: SupportReasonCode;
      orderId: string | null;
    }
  | {
      ok: false;
      code: "NOT_FOUND" | "EMPTY_SUMMARY" | "ALREADY_SUBMITTED" | "AMBIGUOUS_STATE";
      message: string;
    };

export interface CancelDescriptionInput {
  customerId: string;
  ticketId: string;
  correlationId: string;
}

export type CancelDescriptionResult =
  | { ok: true; ticketId: string; status: "RESOLVED" }
  | { ok: false; code: "NOT_FOUND" | "ALREADY_SUBMITTED"; message: string };

export interface ListTicketsInput {
  customerId: string;
  limit?: number;
}

export interface SupportService {
  openTicket(input: OpenTicketInput): Promise<OpenTicketResult>;
  beginDescription(input: BeginDescriptionInput): Promise<BeginDescriptionResult>;
  submitDescription(input: SubmitDescriptionInput): Promise<SubmitDescriptionResult>;
  listTickets(input: ListTicketsInput): Promise<SupportTicket[]>;
  cancelDescription(input: CancelDescriptionInput): Promise<CancelDescriptionResult>;
  getTicket(input: { ticketId: string; customerId: string }): Promise<SupportTicket | null>;
  closeTicket(input: {
    ticketId: string;
    customerId: string;
    correlationId: string;
  }): Promise<{ ok: true } | { ok: false; code: "NOT_FOUND"; message: string }>;
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
  version: number;
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
    version: row.version,
  };
}

export function createSupportService(db: Db): SupportService {
  return {
    async openTicket(input) {
      const summary = toSafeSummary(input.description);
      const opened = await withTransaction(db, async (trx) => {
        // Replayed Telegram callbacks carry the same stable correlation id.
        // Serialize that key across workers, then reuse the already committed
        // TicketOpened effect instead of creating duplicate support tickets.
        await sql`select pg_advisory_xact_lock(hashtextextended(${input.correlationId}, 0))`.execute(
          trx,
        );
        const existing = await sql<{
          aggregate_id: string;
          order_id: string | null;
          reason_code: SupportReasonCode;
          customer_id: string;
        }>`
          select e.aggregate_id, t.order_id, t.reason_code, t.customer_id
          from outbox_event e
          join support_ticket t on t.id = e.aggregate_id
          where e.event_type = 'TicketOpened'
            and e.payload_redacted ->> 'correlationId' = ${input.correlationId}
            and e.payload_redacted ->> 'customerId' = ${input.customerId}
          limit 1
        `.execute(trx);
        if (existing.rows[0]) {
          return { ok: true as const, ticketId: existing.rows[0].aggregate_id };
        }

        if (!isSupportReasonCode(input.reasonCode)) {
          return {
            ok: false as const,
            code: "INVALID_REASON" as const,
            message: "Lý do hỗ trợ không hợp lệ.",
          };
        }
        if (summary.length === 0) {
          return {
            ok: false as const,
            code: "EMPTY_SUMMARY" as const,
            message: "Vui lòng mô tả vấn đề ngắn gọn.",
          };
        }

        // Ownership is in the query, so a linked Order that belongs to somebody else is
        // indistinguishable from one that does not exist. This runs only for a new intent;
        // a replay uses the persisted TicketOpened fields below.
        if (input.orderId) {
          const order = await findOrderByIdForOwner(trx, input.orderId, input.customerId);
          if (!order) {
            return {
              ok: false as const,
              code: "ORDER_NOT_FOUND" as const,
              message: "Không tìm thấy đơn hàng.",
            };
          }
        }

        const due = slaDueAt(input.reasonCode, new Date());
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
        return { ok: true as const, ticketId: createdTicketId };
      });
      if (!opened.ok) return opened;
      const openedTicketId = opened.ticketId;

      const ticketState = await sql<{
        status: SupportTicketStatus;
        order_id: string | null;
        reason_code: SupportReasonCode;
        customer_id: string;
      }>`
        select status, order_id, reason_code, customer_id
        from support_ticket
        where id = ${openedTicketId} and customer_id = ${input.customerId}
        limit 1
      `.execute(db);
      const state = ticketState.rows[0];
      const ticketStatus = state?.status ?? "OPEN";

      // The committed TicketOpened row is the durable replacement intent. A replay retries
      // a prior post-commit failure, and persisted order/reason fields win over callback data.
      if (state?.order_id && state.reason_code === "ASSET_NOT_WORKING") {
        const replacement = await openReplacementCase(db, {
          orderId: state.order_id,
          customerId: state.customer_id,
          reasonCode: "INVALID_CREDENTIAL",
          requestRefund: false,
          correlationId: input.correlationId,
          supportTicketId: openedTicketId,
        });
        if (replacement.ok) {
          return {
            ok: true,
            ticketId: openedTicketId,
            status: ticketStatus,
            replacementCaseId: replacement.caseId,
          };
        }
      }

      return { ok: true, ticketId: openedTicketId, status: ticketStatus };
    },

    async beginDescription(input) {
      if (!isSupportReasonCode(input.reasonCode)) {
        return {
          ok: false,
          code: "INVALID_REASON",
          message: "Lý do hỗ trợ không hợp lệ.",
        };
      }
      if (input.orderId) {
        const order = await findOrderByIdForOwner(db, input.orderId, input.customerId);
        if (!order) {
          return { ok: false, code: "ORDER_NOT_FOUND", message: "Không tìm thấy đơn hàng." };
        }
      }

      const due = slaDueAt(input.reasonCode, new Date());
      return withTransaction(db, async (trx) => {
        const lockKey = input.customerId;
        await sql`select pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`.execute(trx);

        const pendingCandidate = await sql<{ id: string }>`
          select id
          from support_ticket
          where customer_id = ${input.customerId}
            and status = 'WAITING_CUSTOMER'
          order by created_at desc, id desc
          limit 1
        `.execute(trx);
        const candidateId = pendingCandidate.rows[0]?.id;
        if (candidateId) {
          const pending = await sql<{
            id: string;
            order_id: string | null;
            reason_code: SupportReasonCode;
            status: SupportTicketStatus;
          }>`
            select id, order_id, reason_code, status
            from support_ticket
            where id = ${candidateId} and customer_id = ${input.customerId}
            for update
          `.execute(trx);
          const draft = pending.rows[0];
          if (!draft || draft.status !== "WAITING_CUSTOMER") {
            return {
              ok: false,
              code: "ALREADY_SUBMITTED",
              message: "Yêu cầu hỗ trợ này đã được gửi.",
            };
          }
          return {
            ok: true,
            ticketId: draft.id,
            status: "WAITING_CUSTOMER" as const,
            reasonCode: draft.reason_code,
            orderId: draft.order_id,
          };
        }

        const replay = await sql<{ aggregate_id: string; status: SupportTicketStatus }>`
          select e.aggregate_id, t.status
          from outbox_event e
          join support_ticket t on t.id = e.aggregate_id
          where e.event_type = 'TicketOpened'
            and e.payload_redacted ->> 'descriptionState' = 'WAITING_CUSTOMER'
            and e.payload_redacted ->> 'correlationId' = ${input.correlationId}
            and e.payload_redacted ->> 'customerId' = ${input.customerId}
          limit 1
        `.execute(trx);
        if (replay.rows[0]) {
          if (replay.rows[0].status !== "WAITING_CUSTOMER") {
            return {
              ok: false,
              code: "ALREADY_SUBMITTED",
              message: "Yêu cầu hỗ trợ này đã được gửi.",
            };
          }
          return {
            ok: true,
            ticketId: replay.rows[0].aggregate_id,
            status: "WAITING_CUSTOMER" as const,
            reasonCode: input.reasonCode as SupportReasonCode,
            orderId: input.orderId ?? null,
          };
        }

        const ticketId = newId();
        await sql`
          insert into support_ticket
            (id, customer_id, order_id, reason_code, status, safe_summary, due_at)
          values
            (${ticketId}, ${input.customerId}, ${input.orderId ?? null},
             ${input.reasonCode}, 'WAITING_CUSTOMER',
             'Đang chờ bạn bổ sung mô tả.', ${due.toISOString()})
        `.execute(trx);
        await enqueueOutboxEvent(trx, {
          id: newId(),
          aggregateType: "SupportTicket",
          aggregateId: ticketId,
          aggregateVersion: 1,
          eventType: "TicketOpened",
          payloadRedacted: {
            ticketId,
            customerId: input.customerId,
            orderId: input.orderId ?? null,
            reasonCode: input.reasonCode,
            descriptionState: "WAITING_CUSTOMER",
            correlationId: input.correlationId,
          },
        });
        return {
          ok: true,
          ticketId,
          status: "WAITING_CUSTOMER" as const,
          reasonCode: input.reasonCode as SupportReasonCode,
          orderId: input.orderId ?? null,
        };
      });
    },

    async submitDescription(input) {
      const summary = toSafeSummary(input.description);
      if (summary.length === 0) {
        return {
          ok: false,
          code: "EMPTY_SUMMARY",
          message: "Vui lòng mô tả vấn đề ngắn gọn.",
        };
      }

      return withTransaction(db, async (trx) => {
        const found = await sql<TicketRow>`
          select id, customer_id, order_id, reason_code, status, safe_summary, due_at, created_at, version
          from support_ticket
          where customer_id = ${input.customerId}
            and (${input.ticketId ?? null}::text is null or id = ${input.ticketId ?? null})
            and (${input.ticketId ?? null}::text is not null or status = 'WAITING_CUSTOMER')
          order by created_at desc, id desc
          limit 2
          for update
        `.execute(trx);
        if (!input.ticketId && found.rows.length > 1) {
          return {
            ok: false,
            code: "AMBIGUOUS_STATE",
            message: "Có nhiều yêu cầu đang chờ. Vui lòng bấm lại nút hỗ trợ.",
          };
        }
        const ticket = found.rows[0];
        if (!ticket) return { ok: false, code: "NOT_FOUND", message: "Không tìm thấy ticket." };
        if (ticket.status !== "WAITING_CUSTOMER") {
          return {
            ok: false,
            code: "ALREADY_SUBMITTED",
            message: "Ticket này đã được gửi hoặc đã đóng.",
          };
        }
        if (!canTicketTransition(ticket.status, "WAITING_SHOP")) {
          return {
            ok: false,
            code: "ALREADY_SUBMITTED",
            message: "Ticket này không còn chờ bổ sung mô tả.",
          };
        }
        await sql`
          update support_ticket
          set status = 'WAITING_SHOP',
              safe_summary = ${summary},
              updated_at = now(),
              version = version + 1
          where id = ${ticket.id}
            and customer_id = ${input.customerId}
            and status = 'WAITING_CUSTOMER'
            and version = ${ticket.version}
        `.execute(trx);
        await appendAuditEvent(trx, {
          actorType: "CUSTOMER",
          actorId: input.customerId,
          action: "support.ticket.description",
          targetType: "SupportTicket",
          targetId: ticket.id,
          reason: "Customer submitted support description",
          correlationId: input.correlationId,
          metadataRedacted: { from: ticket.status, to: "WAITING_SHOP" },
        });
        await enqueueOutboxEvent(trx, {
          id: newId(),
          aggregateType: "SupportTicket",
          aggregateId: ticket.id,
          aggregateVersion: ticket.version + 1,
          eventType: "TicketStatusChanged",
          payloadRedacted: {
            ticketId: ticket.id,
            customerId: input.customerId,
            from: ticket.status,
            to: "WAITING_SHOP",
            version: ticket.version + 1,
            actorId: input.customerId,
          },
        });

        return {
          ok: true,
          ticketId: ticket.id,
          status: "WAITING_SHOP" as const,
          reasonCode: ticket.reason_code,
          orderId: ticket.order_id,
        };
      });
    },

    async cancelDescription(input) {
      return withTransaction(db, async (trx) => {
        const found = await sql<{ id: string; status: SupportTicketStatus; version: number }>`
          select id, status, version
          from support_ticket
          where id = ${input.ticketId} and customer_id = ${input.customerId}
          for update
        `.execute(trx);
        const ticket = found.rows[0];
        if (!ticket) return { ok: false, code: "NOT_FOUND", message: "Không tìm thấy ticket." };
        if (
          ticket.status !== "WAITING_CUSTOMER" ||
          !canTicketTransition(ticket.status, "RESOLVED")
        ) {
          return {
            ok: false,
            code: "ALREADY_SUBMITTED",
            message: "Ticket này đã được gửi hoặc đã đóng.",
          };
        }
        await sql`
          update support_ticket
          set status = 'RESOLVED', updated_at = now(), version = version + 1
          where id = ${ticket.id}
            and customer_id = ${input.customerId}
            and status = 'WAITING_CUSTOMER'
            and version = ${ticket.version}
        `.execute(trx);
        await appendAuditEvent(trx, {
          actorType: "CUSTOMER",
          actorId: input.customerId,
          action: "support.ticket.description.cancel",
          targetType: "SupportTicket",
          targetId: ticket.id,
          reason: "Customer cancelled support description",
          correlationId: input.correlationId,
          metadataRedacted: { from: ticket.status, to: "RESOLVED" },
        });
        await enqueueOutboxEvent(trx, {
          id: newId(),
          aggregateType: "SupportTicket",
          aggregateId: ticket.id,
          aggregateVersion: ticket.version + 1,
          eventType: "TicketStatusChanged",
          payloadRedacted: {
            ticketId: ticket.id,
            customerId: input.customerId,
            from: ticket.status,
            to: "RESOLVED",
            version: ticket.version + 1,
            actorId: input.customerId,
          },
        });
        return { ok: true, ticketId: ticket.id, status: "RESOLVED" as const };
      });
    },

    async listTickets(input) {
      const limit = Math.max(1, Math.min(input.limit ?? 20, 50));
      const result = await sql<TicketRow>`
        select id, customer_id, order_id, reason_code, status, safe_summary,
               due_at, created_at, version
        from support_ticket
        where customer_id = ${input.customerId}
        order by created_at desc, id desc
        limit ${limit}
      `.execute(db);
      return result.rows.map(mapTicket);
    },

    async getTicket(input) {
      const result = await sql<TicketRow>`
        select id, customer_id, order_id, reason_code, status, safe_summary,
               due_at, created_at, version
        from support_ticket
        where id = ${input.ticketId} and customer_id = ${input.customerId}
        limit 1
      `.execute(db);
      const row = result.rows[0];
      return row ? mapTicket(row) : null;
    },

    async closeTicket(input) {
      return withTransaction(db, async (trx) => {
        const found = await sql<{
          customer_id: string;
          status: SupportTicketStatus;
          version: number;
        }>`
          select customer_id, status, version
          from support_ticket
          where id = ${input.ticketId}
          for update
        `.execute(trx);
        const ticket = found.rows[0];
        if (!ticket || ticket.customer_id !== input.customerId || ticket.status !== "RESOLVED") {
          return { ok: false, code: "NOT_FOUND", message: "Không tìm thấy ticket." };
        }

        const nextVersion = ticket.version + 1;
        await sql`
          update support_ticket
          set status = 'CLOSED', updated_at = now(), version = ${nextVersion}
          where id = ${input.ticketId}
            and customer_id = ${input.customerId}
            and status = 'RESOLVED'
            and version = ${ticket.version}
        `.execute(trx);
        await appendAuditEvent(trx, {
          actorType: "CUSTOMER",
          actorId: input.customerId,
          action: "support.ticket.close",
          targetType: "SupportTicket",
          targetId: input.ticketId,
          reason: "Customer closed support ticket",
          correlationId: input.correlationId,
          metadataRedacted: { from: ticket.status, to: "CLOSED" },
        });
        await enqueueOutboxEvent(trx, {
          id: newId(),
          aggregateType: "SupportTicket",
          aggregateId: input.ticketId,
          aggregateVersion: nextVersion,
          eventType: "TicketStatusChanged",
          payloadRedacted: {
            ticketId: input.ticketId,
            customerId: input.customerId,
            from: ticket.status,
            to: "CLOSED",
            version: nextVersion,
            actorId: input.customerId,
          },
        });
        return { ok: true };
      });
    },
  };
}

/** Owner-facing ticket row. A short customer label, never a raw telegram identity. */
export interface AdminSupportTicketRow {
  id: string;
  version: number;
  customerLabel: string;
  reasonCode: SupportReasonCode;
  status: SupportTicketStatus;
  safeSummary: string;
  orderNumber: string | null;
  dueAt: string | null;
}

interface AdminTicketRow {
  id: string;
  version: number;
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
    version: row.version,
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
    select t.id, t.version, t.customer_id, t.reason_code, t.status, t.safe_summary, t.due_at,
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
    select t.id, t.version, t.customer_id, t.reason_code, t.status, t.safe_summary, t.due_at,
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
  | { ok: false; code: "NOT_FOUND" | "STALE_VERSION" | "ILLEGAL_STATE" | "INVALID_VERSION" };

/**
 * Move a ticket to `toStatus`, refusing any transition the customer-facing state
 * machine forbids. `toStatus` arrives from callback data, so it is validated
 * before the row is read.
 */
export async function setTicketStatus(input: {
  db: Db;
  ticketId: string;
  toStatus: string;
  expectedVersion: number;
  actorId: string;
  correlationId: string;
}): Promise<SetTicketStatusResult> {
  if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1) {
    return { ok: false, code: "INVALID_VERSION" };
  }
  if (!isTicketStatus(input.toStatus)) return { ok: false, code: "ILLEGAL_STATE" };
  const to = input.toStatus;
  return withTransaction(input.db, async (trx) => {
    // Lock the row: two taps must not both read the same `from` status and apply twice.
    const found = await sql<{
      status: SupportTicketStatus;
      customer_id: string;
      version: number;
    }>`
      select status, customer_id, version from support_ticket where id = ${input.ticketId} for update
    `.execute(trx);
    const row = found.rows[0];
    if (!row) return { ok: false, code: "NOT_FOUND" };
    if (row.version !== input.expectedVersion) return { ok: false, code: "STALE_VERSION" };
    if (!canTicketTransition(row.status, to)) return { ok: false, code: "ILLEGAL_STATE" };
    const nextVersion = row.version + 1;
    await sql`
      update support_ticket
      set status = ${to}, updated_at = now(), version = ${nextVersion}
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
    await enqueueOutboxEvent(trx, {
      id: newId(),
      aggregateType: "SupportTicket",
      aggregateId: input.ticketId,
      aggregateVersion: nextVersion,
      eventType: "TicketStatusChanged",
      payloadRedacted: {
        ticketId: input.ticketId,
        customerId: row.customer_id,
        from: row.status,
        to,
        version: nextVersion,
        actorId: input.actorId,
      },
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
