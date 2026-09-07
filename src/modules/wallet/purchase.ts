import { sql } from "kysely";
import type { Db } from "../../infrastructure/db/transaction.js";
import { withTransaction } from "../../infrastructure/db/transaction.js";
import { enqueueOutboxEvent } from "../../infrastructure/outbox/repository.js";
import { findOrderByIdForUpdate, transitionOrder } from "../commerce/repository.js";
import { isFeature001SellablePolicy } from "../catalog/domain.js";
import { orderHasActiveReservation } from "../digital-goods/repository.js";
import { voidLiveIntentsForOrder } from "../payments/repository.js";
import { debitWalletLedgerEntry, type WalletLedgerErrorCode } from "./ledger.js";
import { newId } from "../../shared/ids/index.js";

export type WalletPurchaseResult =
  | { ok: true; kind: "PAID"; orderId: string; ledgerEntryId: string }
  | { ok: true; kind: "ALREADY_PAID"; orderId: string }
  | {
      ok: false;
      code: "NOT_FOUND" | "NOT_OWNED" | "ALREADY_PAID" | "INSUFFICIENT_FUNDS" | "ORDER_NOT_PAYABLE";
      message: string;
    };

export interface WalletPurchaseInput {
  customerId: string;
  orderId: string;
  idempotencyKey: string;
  correlationId: string;
}

export function createWalletPurchaseService(db: Db) {
  return {
    async purchase(input: WalletPurchaseInput): Promise<WalletPurchaseResult> {
      return withTransaction(db, async (trx) => {
        const order = await findOrderByIdForUpdate(trx, input.orderId);
        if (!order) return { ok: false, code: "NOT_FOUND", message: "Không tìm thấy đơn hàng." };
        if (order.customerId !== input.customerId)
          return { ok: false, code: "NOT_OWNED", message: "Bạn không sở hữu đơn hàng này." };
        if (
          order.status === "PAID" ||
          order.status === "PROCESSING" ||
          order.status === "COMPLETED"
        ) {
          return { ok: true, kind: "ALREADY_PAID", orderId: order.id };
        }
        if (order.status !== "PENDING_PAYMENT") {
          return {
            ok: false,
            code: "ORDER_NOT_PAYABLE",
            message: "Đơn hàng không thể thanh toán bằng ví.",
          };
        }
        if (order.expiresAt !== null && new Date(order.expiresAt).getTime() <= Date.now()) {
          return {
            ok: false,
            code: "ORDER_NOT_PAYABLE",
            message: "Đơn hàng đã hết hạn thanh toán.",
          };
        }
        const variant = await sql<{
          variant_active: boolean;
          product_active: boolean;
          category_active: boolean;
          stock_policy: string;
        }>`
          select v.is_active as variant_active, p.is_active as product_active,
                 c.is_active as category_active, v.stock_policy
          from product_variant v
          join product p on p.id = v.product_id
          join category c on c.id = p.category_id
          where v.id = ${order.variantId}
          for share of v, p, c
        `.execute(trx);
        const live = variant.rows[0];
        if (
          !live ||
          !live.variant_active ||
          !live.product_active ||
          !live.category_active ||
          !isFeature001SellablePolicy(live.stock_policy)
        ) {
          return { ok: false, code: "ORDER_NOT_PAYABLE", message: "Sản phẩm không còn bán." };
        }
        const hasReservation = await orderHasActiveReservation(
          trx,
          order.id,
          order.variantId,
          new Date(),
        );
        if (!hasReservation)
          return { ok: false, code: "ORDER_NOT_PAYABLE", message: "Sản phẩm không còn tồn kho." };
        const debit = await debitWalletLedgerEntry(trx, {
          customerId: input.customerId,
          amountVnd: BigInt(order.priceVnd),
          idempotencyKey: `purchase:${order.id}:${input.idempotencyKey}`,
          correlationId: input.correlationId,
          reason: `wallet purchase ${order.orderNumber}`,
        });
        if (!debit.ok)
          return { ok: false, code: mapLedgerError(debit.code), message: debit.message };

        await voidLiveIntentsForOrder(trx, order.id);
        const paid = await transitionOrder(
          trx,
          order,
          "PAID",
          "WALLET_PURCHASE",
          input.correlationId,
          {
            type: "SYSTEM",
            id: "wallet",
          },
        );
        await enqueueOutboxEvent(trx, {
          id: newId(),
          aggregateType: "Order",
          aggregateId: order.id,
          aggregateVersion: paid.version,
          eventType: "OrderPaid",
          payloadRedacted: {
            orderId: order.id,
            customerId: input.customerId,
            correlationId: input.correlationId,
          },
        });
        return { ok: true, kind: "PAID", orderId: order.id, ledgerEntryId: debit.entryId };
      });
    },
  };
}

function mapLedgerError(
  code: WalletLedgerErrorCode,
): "NOT_FOUND" | "INSUFFICIENT_FUNDS" | "ORDER_NOT_PAYABLE" {
  if (code === "INSUFFICIENT_FUNDS") return "INSUFFICIENT_FUNDS";
  if (code === "IDEMPOTENCY_CONFLICT") return "ORDER_NOT_PAYABLE";
  return "NOT_FOUND";
}
