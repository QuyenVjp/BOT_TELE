import { sql } from "kysely";
import type { Db } from "../../infrastructure/db/transaction.js";
import { withTransaction } from "../../infrastructure/db/transaction.js";
import { newId } from "../../shared/ids/index.js";
import { findOrderById, transitionOrder } from "../commerce/repository.js";
import { findDeliveredAssetHistoryForOrder } from "./repository.js";

/**
 * Replacement / refund-request workflow (T078, FR-020).
 *
 * Opens a recorded ReplacementCase that preserves the original asset and Order
 * history. The original asset is never rewritten or deleted: a replacement
 * (when fulfilled later) is a new asset linked via `replacement_asset_id`. A
 * refund request moves the Order to REFUND_PENDING without mutating delivery
 * history. Both paths are audit-friendly and fail-closed on ownership /
 * warranty / status checks.
 */

export type ReplacementReasonCode =
  | "INVALID_CREDENTIAL"
  | "EXPIRED_ON_DELIVERY"
  | "WRONG_REGION"
  | "WRONG_DURATION"
  | "CUSTOMER_REQUEST"
  | "COMPROMISED";

export type ReplacementCaseStatus =
  "OPEN" | "APPROVED" | "REPLACED" | "REFUND_REQUESTED" | "REJECTED" | "CLOSED";

export type OpenReplacementResult =
  | { ok: true; caseId: string; status: ReplacementCaseStatus }
  | {
      ok: false;
      code: "NOT_FOUND" | "ORDER_NOT_OWNED" | "NO_ASSET" | "NOT_ELIGIBLE" | "WARRANTY_EXPIRED";
      message: string;
    };

export interface OpenReplacementInput {
  orderId: string;
  customerId: string;
  reasonCode: ReplacementReasonCode;
  /** Request a refund review instead of a replacement asset. */
  requestRefund?: boolean;
  correlationId: string;
  /** Injectable clock for warranty-deadline tests. */
  now?: Date;
}

/**
 * Open a replacement/refund case for a delivered (or ready) asset. Ownership is
 * enforced against the Order's customer. The original asset row is left intact.
 */
export async function openReplacementCase(
  db: Db,
  input: OpenReplacementInput,
): Promise<OpenReplacementResult> {
  const order = await findOrderById(db, input.orderId);
  if (!order) {
    return { ok: false, code: "NOT_FOUND", message: "Không tìm thấy đơn hàng." };
  }
  if (order.customerId !== input.customerId) {
    return { ok: false, code: "ORDER_NOT_OWNED", message: "Bạn không sở hữu đơn hàng này." };
  }

  // Eligible once the order has been paid and fulfillment has started/finished.
  const eligible = ["PAID", "PROCESSING", "COMPLETED", "FULFILLMENT_NEEDS_REVIEW"].includes(
    order.status,
  );
  if (!eligible) {
    return {
      ok: false,
      code: "NOT_ELIGIBLE",
      message: "Đơn hàng chưa đủ điều kiện thay thế/hoàn tiền.",
    };
  }

  const asset = await findDeliveredAssetHistoryForOrder(db, order.id);
  if (!asset) {
    return { ok: false, code: "NO_ASSET", message: "Đơn hàng chưa có tài khoản để thay thế." };
  }

  // Warranty: order.warrantyDays from the immutable snapshot; 0 means no window
  // (still allow a case for COMPROMISED / INVALID_CREDENTIAL policy reasons, but
  // refuse pure CUSTOMER_REQUEST past the deadline).
  const now = input.now ?? new Date();
  if (order.warrantyDays > 0 && order.paidAt) {
    const paidAt = new Date(order.paidAt);
    const deadline = new Date(paidAt.getTime() + order.warrantyDays * 86_400_000);
    if (
      now.getTime() > deadline.getTime() &&
      (input.reasonCode === "CUSTOMER_REQUEST" || input.reasonCode === "EXPIRED_ON_DELIVERY")
    ) {
      return {
        ok: false,
        code: "WARRANTY_EXPIRED",
        message: "Đã quá thời hạn bảo hành cho yêu cầu này.",
      };
    }
  }

  const wantRefund = input.requestRefund === true;
  const status: ReplacementCaseStatus = wantRefund ? "REFUND_REQUESTED" : "OPEN";
  const caseId = newId();
  const warrantyDeadline =
    order.warrantyDays > 0 && order.paidAt
      ? new Date(new Date(order.paidAt).getTime() + order.warrantyDays * 86_400_000)
      : null;

  await withTransaction(db, async (trx) => {
    await sql`
      insert into replacement_case
        (id, order_id, original_asset_id, reason_code, status, warranty_deadline)
      values
        (${caseId}, ${order.id}, ${asset.id}, ${input.reasonCode}, ${status},
         ${warrantyDeadline ? warrantyDeadline.toISOString() : null})
    `.execute(trx);

    // A refund request moves the Order into REFUND_PENDING so finance can act;
    // a pure replacement stays on the current status (support fulfills later).
    if (wantRefund) {
      const live = await findOrderById(trx, order.id);
      if (
        live &&
        (live.status === "PAID" || live.status === "PROCESSING" || live.status === "COMPLETED")
      ) {
        await transitionOrder(
          trx,
          live,
          "REFUND_PENDING",
          "REFUND_REQUESTED",
          input.correlationId,
          {
            type: "customer",
            id: input.customerId,
          },
        );
      }
    }
  });

  return { ok: true, caseId, status };
}
