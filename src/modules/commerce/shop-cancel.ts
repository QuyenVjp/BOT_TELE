import { sql } from "kysely";
import type { Db } from "../../infrastructure/db/transaction.js";
import { withTransaction } from "../../infrastructure/db/transaction.js";
import { newId } from "../../shared/ids/index.js";
import { appendAuditEvent } from "../identity/audit.js";
import { allocateRestockToPreorders } from "./preorder.js";

const CANCELLABLE = [
  "CREATED",
  "WAITING_DEPOSIT",
  "DEPOSIT_PAID",
  "ALLOCATED",
  "BALANCE_DUE",
  "FULLY_PAID",
] as const;

type CancellableStatus = (typeof CANCELLABLE)[number];

function isCancellable(status: string): status is CancellableStatus {
  return (CANCELLABLE as readonly string[]).includes(status);
}

export interface ShopCancelInput {
  preorderId: string;
  actorTelegramUserId: string;
  reason: string;
  correlationId: string;
}

export type ShopCancelResult =
  | {
      ok: true;
      preorderId: string;
      status: "SHOP_CANCELLED" | "REFUND_DUE";
      amountVnd: number;
      obligationId: string | null;
      idempotent: boolean;
    }
  | { ok: false; code: "NOT_FOUND" | "NOT_CANCELLABLE" | "EMPTY_REASON" };

interface ReservationRow {
  id: string;
  variant_id: string;
  customer_id: string;
  status: string;
  deposit_amount_vnd: string;
  balance_amount_vnd: string;
  allocated_asset_id: string | null;
  deposit_paid_at: Date | string | null;
  version: number;
}

function collectedAmountVnd(row: ReservationRow): number {
  const deposit = Number(row.deposit_amount_vnd);
  const balance = Number(row.balance_amount_vnd);
  if (!Number.isFinite(deposit) || !Number.isFinite(balance)) return 0;
  if (row.status === "FULLY_PAID") return Math.max(0, deposit + balance);
  if (row.deposit_paid_at) return Math.max(0, deposit);
  return 0;
}

export async function shopCancelPreorder(
  db: Db,
  input: ShopCancelInput,
): Promise<ShopCancelResult> {
  const reason = input.reason.trim();
  if (reason.length === 0) return { ok: false, code: "EMPTY_REASON" };

  return withTransaction(db, async (trx) => {
    const locked = await sql<ReservationRow>`
      select id, variant_id, customer_id, status, deposit_amount_vnd::text, balance_amount_vnd::text,
             allocated_asset_id, deposit_paid_at, version
      from preorder_reservation
      where id = ${input.preorderId}
      for update
    `.execute(trx);
    const row = locked.rows[0];
    if (!row) return { ok: false, code: "NOT_FOUND" };

    const existingObligation = await sql<{ id: string; amount_vnd: string }>`
      select id, amount_vnd::text from shop_refund_obligation
      where preorder_id = ${row.id}
      limit 1
    `.execute(trx);
    if (row.status === "SHOP_CANCELLED" || row.status === "REFUND_DUE") {
      const obligation = existingObligation.rows[0];
      return {
        ok: true,
        preorderId: row.id,
        status: row.status,
        amountVnd: obligation ? Number(obligation.amount_vnd) : 0,
        obligationId: obligation?.id ?? null,
        idempotent: true,
      };
    }
    if (!isCancellable(row.status)) return { ok: false, code: "NOT_CANCELLABLE" };

    const amountVnd = collectedAmountVnd(row);
    const nextStatus = amountVnd > 0 ? "REFUND_DUE" : "SHOP_CANCELLED";
    let obligationId: string | null = null;
    if (amountVnd > 0) {
      obligationId = existingObligation.rows[0]?.id ?? newId();
      await sql`
        insert into shop_refund_obligation
          (id, preorder_id, customer_id, amount_vnd, status, reason, created_by)
        values
          (${obligationId}, ${row.id}, ${row.customer_id}, ${amountVnd}::bigint, 'OPEN',
           ${reason}, ${input.actorTelegramUserId})
        on conflict (preorder_id) do nothing
      `.execute(trx);
      const persisted = await sql<{ id: string }>`
        select id from shop_refund_obligation where preorder_id = ${row.id} limit 1
      `.execute(trx);
      obligationId = persisted.rows[0]?.id ?? obligationId;
    }

    if (row.allocated_asset_id) {
      await sql`
        update digital_asset
        set status = 'AVAILABLE',
            reserved_until = null,
            updated_at = now(),
            version = version + 1
        where id = ${row.allocated_asset_id}
          and status = 'RESERVED'
      `.execute(trx);
    }

    await sql`
      update preorder_reservation
      set status = ${nextStatus}::text,
          allocated_asset_id = null,
          hold_until = null,
          updated_at = now(),
          version = version + 1
      where id = ${row.id}
        and status = ${row.status}
    `.execute(trx);

    const eventId = newId();
    await sql`
      insert into outbox_event (
        id, aggregate_type, aggregate_id, aggregate_version, event_type, payload_redacted
      ) values (
        ${eventId}, 'PreorderReservation', ${row.id}, ${row.version + 1}, 'PreorderShopCancelled',
        jsonb_build_object(
          'preorderId', ${row.id}::text,
          'customerId', ${row.customer_id}::text,
          'variantId', ${row.variant_id}::text,
          'amountDue', ${amountVnd}::bigint,
          'status', ${nextStatus}::text
        )
      )
    `.execute(trx);

    await appendAuditEvent(trx, {
      actorType: "ROOT_ADMIN",
      actorId: input.actorTelegramUserId,
      action: "preorder.shop_cancel",
      targetType: "PreorderReservation",
      targetId: row.id,
      reason,
      correlationId: input.correlationId,
      metadataRedacted: {
        status: nextStatus,
        amountVnd,
        obligationId,
      },
    });

    await allocateRestockToPreorders(trx, row.variant_id);

    return {
      ok: true,
      preorderId: row.id,
      status: nextStatus,
      amountVnd,
      obligationId,
      idempotent: false,
    };
  });
}
