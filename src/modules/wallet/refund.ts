import { sql } from "kysely";
import type { Db, Trx } from "../../infrastructure/db/transaction.js";
import { withTransaction } from "../../infrastructure/db/transaction.js";
import { enqueueOutboxEvent } from "../../infrastructure/outbox/repository.js";
import { findOrderByIdForUpdate, transitionOrder } from "../commerce/repository.js";
import { releaseTypedStockForOrder } from "../digital-goods/repository.js";
import { creditWalletLedgerEntry } from "./ledger.js";
import { newId } from "../../shared/ids/index.js";

export type WalletRefundResult =
  | { ok: true; kind: "REFUNDED" | "ALREADY_REFUNDED"; orderId: string; ledgerEntryId?: string }
  | {
      ok: false;
      code:
        | "NOT_FOUND"
        | "NOT_ELIGIBLE"
        | "NOT_WALLET_PAID"
        | "IDEMPOTENCY_CONFLICT"
        | "ALREADY_FULFILLED";
      message: string;
    };

export interface WalletRefundInput {
  orderId: string;
  correlationId: string;
  /** Set only after the existing root-admin approval authority has authorized this action. */
  approvedBy: string;
}

/**
 * Transaction-scoped refund primitive. The caller owns authorization. The
 * Order lock is the cross-lane serialization boundary: fulfillment must win
 * with PROCESSING before this function can credit the wallet.
 */
export async function refundWalletCredit(
  trx: Trx,
  input: WalletRefundInput,
): Promise<WalletRefundResult> {
  if (!input.approvedBy.trim())
    return { ok: false, code: "NOT_ELIGIBLE", message: "Thiếu người duyệt hoàn tiền." };
  const order = await findOrderByIdForUpdate(trx, input.orderId);
  if (!order) return { ok: false, code: "NOT_FOUND", message: "Không tìm thấy đơn hàng." };
  if (order.status === "REFUNDED") return { ok: true, kind: "ALREADY_REFUNDED", orderId: order.id };
  if (order.status === "PROCESSING" || order.status === "COMPLETED") {
    return {
      ok: false,
      code: "ALREADY_FULFILLED",
      message: "Đơn hàng đã bắt đầu giao, không thể hoàn tiền từ ví.",
    };
  }
  if (order.status !== "PAID" && order.status !== "REFUND_PENDING")
    return { ok: false, code: "NOT_ELIGIBLE", message: "Đơn hàng chưa được duyệt hoàn tiền." };

  // A legacy PAID/REFUND_PENDING row can predate the PROCESSING fence. Never
  // turn durable fulfillment evidence into a wallet refund or release a
  // claimed asset.
  const evidence = await sql<{ one: number }>`
    select 1 as one
    where exists (
      select 1
      from digital_asset
      where (
        (reserved_order_id = ${order.id} and status in ('READY', 'DELIVERED'))
        or (delivered_order_id = ${order.id} and status = 'DELIVERED')
      )
    )
    or exists (
      select 1
      from outbox_event
      where event_type = 'DigitalAssetClaimed'
        and payload_redacted ->> 'orderId' = ${order.id}
    )
    or exists (
      select 1
      from manual_fulfillment_task
      where order_id = ${order.id} and status = 'OPEN'
    )
    or exists (
      select 1
      from supplier_order
      where order_id = ${order.id}
        and status not in ('REJECTED', 'CANCELLED')
    )
    or exists (
      select 1
      from quantity_stock_ledger
      where order_id = ${order.id} and entry_type = 'DELIVER'
    )
    or exists (
      select 1
      from delivery_bundle
      where order_id = ${order.id}
        and status in ('CREATED', 'AVAILABLE', 'VIEWED', 'CONSUMED')
    )
    or exists (
      select 1
      from file_delivery_job
      where order_id = ${order.id}
        and (
          status in ('PROCESSING', 'SENT')
          or (
            status = 'FAILED'
            and coalesce(last_error, '') not in (
              'INVALID_STORAGE_REFERENCE',
              'FILE_HASH_MISMATCH',
              'FILE_SIZE_MISMATCH'
            )
          )
        )
    )
    or exists (
      select 1
      from delivery_notification_handoff h
      join delivery_bundle b on b.id = h.bundle_id
      where b.order_id = ${order.id}
    )
  `.execute(trx);
  if (evidence.rows[0]) {
    return {
      ok: false,
      code: "ALREADY_FULFILLED",
      message: "Đơn hàng đã có bằng chứng xử lý, không thể hoàn tiền từ ví.",
    };
  }

  const debit = await sql<{ amount_vnd: string }>`
    select amount_vnd from wallet_ledger
    where wallet_account_id = (select id from wallet_account where customer_id = ${order.customerId})
      and entry_type = 'DEBIT'
      and idempotency_key like ${`purchase:${order.id}:%`}
    order by created_at asc, id asc limit 1
  `.execute(trx);
  const amount = debit.rows[0]?.amount_vnd;
  if (!amount)
    return {
      ok: false,
      code: "NOT_WALLET_PAID",
      message: "Đơn hàng không được thanh toán bằng ví.",
    };

  let refundPending = order;
  if (order.status === "PAID") {
    refundPending = await transitionOrder(
      trx,
      order,
      "REFUND_PENDING",
      "REFUND_REQUESTED",
      input.correlationId,
      {
        type: "root-admin",
        id: input.approvedBy,
      },
    );
  }

  // This path only releases checkout-time RESERVED local/quantity stock.
  // READY, delivered, and fulfillment-started evidence was rejected above.
  await releaseTypedStockForOrder(trx, order.id);

  const credit = await creditWalletLedgerEntry(trx, {
    customerId: order.customerId,
    amountVnd: BigInt(amount),
    idempotencyKey: `refund:${order.id}`,
    correlationId: input.correlationId,
    reason: `wallet refund ${order.orderNumber}`,
  });
  if (!credit.ok) {
    if (credit.code === "IDEMPOTENCY_CONFLICT")
      return { ok: false, code: "IDEMPOTENCY_CONFLICT", message: credit.message };
    return { ok: false, code: "NOT_ELIGIBLE", message: credit.message };
  }

  const refunded = await transitionOrder(
    trx,
    refundPending,
    "REFUNDED",
    "WALLET_REFUND",
    input.correlationId,
    {
      type: "root-admin",
      id: input.approvedBy,
    },
  );
  await enqueueOutboxEvent(trx, {
    id: newId(),
    aggregateType: "Order",
    aggregateId: order.id,
    aggregateVersion: refunded.version,
    eventType: "WalletRefunded",
    payloadRedacted: {
      orderId: order.id,
      customerId: order.customerId,
      amountVnd: amount,
      correlationId: input.correlationId,
    },
  });
  return {
    ok: true,
    kind: credit.inserted ? "REFUNDED" : "ALREADY_REFUNDED",
    orderId: order.id,
    ...(credit.inserted ? { ledgerEntryId: credit.entryId } : {}),
  };
}

export function createWalletRefundService(db: Db) {
  return {
    refund(input: WalletRefundInput) {
      return withTransaction(db, (trx) => refundWalletCredit(trx, input));
    },
  };
}
