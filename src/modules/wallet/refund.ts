import { sql } from "kysely";
import type { Db, Trx } from "../../infrastructure/db/transaction.js";
import { withTransaction } from "../../infrastructure/db/transaction.js";
import { enqueueOutboxEvent } from "../../infrastructure/outbox/repository.js";
import { findOrderByIdForUpdate, transitionOrder } from "../commerce/repository.js";
import { creditWalletLedgerEntry } from "./ledger.js";
import { newId } from "../../shared/ids/index.js";

export type WalletRefundResult =
  | { ok: true; kind: "REFUNDED" | "ALREADY_REFUNDED"; orderId: string; ledgerEntryId?: string }
  | { ok: false; code: "NOT_FOUND" | "NOT_ELIGIBLE" | "NOT_WALLET_PAID" | "IDEMPOTENCY_CONFLICT"; message: string };

export interface WalletRefundInput {
  orderId: string;
  correlationId: string;
  /** Set only after the existing root-admin approval authority has authorized this action. */
  approvedBy: string;
}

/**
 * Transaction-scoped refund primitive. The caller owns authorization; this
 * function only accepts an order already moved to REFUND_PENDING by the refund
 * workflow and credits the wallet debit's exact amount once.
 */
export async function refundWalletCredit(trx: Trx, input: WalletRefundInput): Promise<WalletRefundResult> {
  if (!input.approvedBy.trim()) return { ok: false, code: "NOT_ELIGIBLE", message: "Thiếu người duyệt hoàn tiền." };
  const order = await findOrderByIdForUpdate(trx, input.orderId);
  if (!order) return { ok: false, code: "NOT_FOUND", message: "Không tìm thấy đơn hàng." };
  if (order.status === "REFUNDED") return { ok: true, kind: "ALREADY_REFUNDED", orderId: order.id };
  if (order.status !== "REFUND_PENDING") return { ok: false, code: "NOT_ELIGIBLE", message: "Đơn hàng chưa được duyệt hoàn tiền." };

  const debit = await sql<{ amount_vnd: string }>`
    select amount_vnd from wallet_ledger
    where wallet_account_id = (select id from wallet_account where customer_id = ${order.customerId})
      and entry_type = 'DEBIT'
      and idempotency_key like ${`purchase:${order.id}:%`}
    order by created_at asc, id asc limit 1
  `.execute(trx);
  const amount = debit.rows[0]?.amount_vnd;
  if (!amount) return { ok: false, code: "NOT_WALLET_PAID", message: "Đơn hàng không được thanh toán bằng ví." };

  const credit = await creditWalletLedgerEntry(trx, {
    customerId: order.customerId,
    amountVnd: BigInt(amount),
    idempotencyKey: `refund:${order.id}`,
    correlationId: input.correlationId,
    reason: `wallet refund ${order.orderNumber}`,
  });
  if (!credit.ok) {
    if (credit.code === "IDEMPOTENCY_CONFLICT") return { ok: false, code: "IDEMPOTENCY_CONFLICT", message: credit.message };
    return { ok: false, code: "NOT_ELIGIBLE", message: credit.message };
  }

  const refunded = await transitionOrder(trx, order, "REFUNDED", "WALLET_REFUND", input.correlationId, {
    type: "root-admin",
    id: input.approvedBy,
  });
  await enqueueOutboxEvent(trx, {
    id: newId(), aggregateType: "Order", aggregateId: order.id,
    aggregateVersion: refunded.version, eventType: "WalletRefunded",
    payloadRedacted: { orderId: order.id, customerId: order.customerId, amountVnd: amount, correlationId: input.correlationId },
  });
  return { ok: true, kind: credit.inserted ? "REFUNDED" : "ALREADY_REFUNDED", orderId: order.id, ...(credit.inserted ? { ledgerEntryId: credit.entryId } : {}) };
}

export function createWalletRefundService(db: Db) {
  return { refund(input: WalletRefundInput) { return withTransaction(db, (trx) => refundWalletCredit(trx, input)); } };
}
