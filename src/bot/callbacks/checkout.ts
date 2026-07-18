import type { Db } from "../../infrastructure/db/transaction.js";
import { buyNow, cancelUnpaidOrder, isStockOutcomeCode } from "../../modules/commerce/buy-now.js";
import { findOrderByNumber } from "../../modules/commerce/repository.js";
import { presentPaymentForOrder } from "../../modules/payments/service.js";
import { findLiveIntentByOrder } from "../../modules/payments/repository.js";
import { normalizeTelegramUserId, type BuyNowCallbackCodec } from "../callback-codec.js";
import {
  presentPaymentScreen,
  presentPaymentSettled,
  presentPaymentExpired,
  presentPaymentNeedsReview,
  PAYMENT_COPY,
} from "../presenters/payment.js";
import { presentStockOutcome, type PresentedMessage } from "../presenters/catalog.js";

/**
 * Checkout callbacks (T056) — Buy Now, payment status refresh, reopen, unpaid-cancel.
 *
 * Thin orchestration over commerce + payments. Status refresh reads the internal
 * order/intent projection only: it NEVER polls SePay and NEVER marks paid. The
 * only path that settles is `applyPaymentEvidence` (webhook/reconciliation).
 */

export interface MerchantConfig {
  merchantAccountId: string;
  beneficiaryAccountNumber: string;
  bankBin: string;
  accountName: string;
  bankName: string;
  bankAlias?: string;
  template?: string;
}

export interface CheckoutCallbackDeps {
  db: Db;
  merchant: MerchantConfig;
  callbackCodec?: BuyNowCallbackCodec;
  /** Authoritative channel-identity lookup; callers never supply customerId. */
  resolveCustomerId?: (telegramUserId: string) => Promise<string | null>;
}

interface BuyNowCallbackInput {
  customerId: string;
  variantId: string;
  expectedPriceVnd: number;
  correlationId: string;
  idempotencyKey: string;
}

export interface SignedBuyNowCallbackInput {
  callbackData: string;
  telegramUserId: string | bigint | number;
  correlationId: string;
}

export interface CheckoutCallbacks {
  buyNowFromCallback(input: SignedBuyNowCallbackInput): Promise<PresentedMessage>;
  refresh(orderNumber: string, customerId: string): Promise<PresentedMessage>;
  reopen(orderNumber: string, customerId: string): Promise<PresentedMessage>;
  cancel(orderNumber: string, customerId: string, correlationId: string): Promise<PresentedMessage>;
  /** Last presented order number (test/probe helper). */
  lastOrderNumber(): string | null;
  /** Last presented transfer content (test/probe helper). */
  lastTransferContent(): string | null;
}

function errorMessage(text: string): PresentedMessage {
  return {
    text,
    buttons: [[{ text: PAYMENT_COPY.mainMenu, callbackData: "menu:main" }]],
  };
}

export function createCheckoutCallbacks(deps: CheckoutCallbackDeps): CheckoutCallbacks {
  let lastOrderNumber: string | null = null;
  let lastTransferContent: string | null = null;

  const merchantInput = () => ({
    merchantAccountId: deps.merchant.merchantAccountId,
    beneficiaryAccountNumber: deps.merchant.beneficiaryAccountNumber,
    bankBin: deps.merchant.bankBin,
    accountName: deps.merchant.accountName,
    bankName: deps.merchant.bankName,
    ...(deps.merchant.bankAlias !== undefined ? { bankAlias: deps.merchant.bankAlias } : {}),
    ...(deps.merchant.template !== undefined ? { template: deps.merchant.template } : {}),
  });

  const handleBuyNow = async (input: BuyNowCallbackInput): Promise<PresentedMessage> => {
    const result = await buyNow(deps.db, {
      customerId: input.customerId,
      variantId: input.variantId,
      expectedPriceVnd: input.expectedPriceVnd,
      idempotencyKey: input.idempotencyKey,
      correlationId: input.correlationId,
    });
    if (!result.ok) {
      if (isStockOutcomeCode(result.code)) return presentStockOutcome(result.code);
      return errorMessage(result.message);
    }

    const presented = await presentPaymentForOrder(deps.db, {
      orderId: result.order.id,
      correlationId: input.correlationId,
      ...merchantInput(),
    });
    if (!presented.ok) return errorMessage("Không tạo được mã thanh toán. Vui lòng thử lại.");
    lastOrderNumber = presented.presentation.orderNumber;
    lastTransferContent = presented.presentation.transferContent;
    return presentPaymentScreen(presented.presentation);
  };

  return {
    lastOrderNumber: () => lastOrderNumber,
    lastTransferContent: () => lastTransferContent,

    async buyNowFromCallback(input) {
      if (!deps.callbackCodec || !deps.resolveCustomerId) {
        return errorMessage("Yêu cầu mua hàng không hợp lệ. Vui lòng mở lại sản phẩm.");
      }
      const telegramUserId = normalizeTelegramUserId(input.telegramUserId);
      if (!telegramUserId) {
        return errorMessage("Yêu cầu mua hàng không hợp lệ. Vui lòng mở lại sản phẩm.");
      }
      const verified = deps.callbackCodec.verify(input.callbackData, {
        telegramUserId,
      });
      if (!verified.ok) {
        return errorMessage(
          verified.code === "EXPIRED"
            ? "Nút mua này đã hết hạn. Vui lòng mở lại sản phẩm và thử lại."
            : "Yêu cầu mua hàng không hợp lệ. Vui lòng mở lại sản phẩm.",
        );
      }
      const customerId = await deps.resolveCustomerId(telegramUserId);
      if (!customerId) {
        return errorMessage("Không tìm thấy tài khoản khách hàng. Vui lòng mở lại cửa hàng.");
      }
      return handleBuyNow({
        customerId,
        variantId: verified.value.variantId,
        expectedPriceVnd: verified.value.expectedPriceVnd,
        idempotencyKey: verified.value.idempotencyKey,
        correlationId: input.correlationId,
      });
    },

    async refresh(orderNumber, customerId) {
      const order = await findOrderByNumber(deps.db, orderNumber);
      if (!order) return errorMessage("Không tìm thấy đơn hàng.");
      if (order.customerId !== customerId) {
        return errorMessage("Bạn không sở hữu đơn hàng này.");
      }

      // Pure internal projection — no SePay call, no mark-paid.
      if (
        order.status === "PAID" ||
        order.status === "PROCESSING" ||
        order.status === "COMPLETED"
      ) {
        return presentPaymentSettled(order.orderNumber);
      }
      if (order.status === "EXPIRED") {
        return presentPaymentExpired(order.orderNumber);
      }
      if (order.status === "PAYMENT_NEEDS_REVIEW") {
        return presentPaymentNeedsReview(order.orderNumber, order.id);
      }
      if (order.status === "CANCELLED" || order.status === "REJECTED") {
        return errorMessage(`Đơn ${order.orderNumber} đã huỷ.`);
      }

      // Still unpaid: re-present the live intent (or mint one if missing).
      const presented = await presentPaymentForOrder(deps.db, {
        orderId: order.id,
        correlationId: `refresh-${order.id}`,
        ...merchantInput(),
      });
      if (!presented.ok) {
        // Intent may already be non-live (e.g. NEEDS_REVIEW on the intent).
        const live = await findLiveIntentByOrder(deps.db, order.id);
        if (!live) return presentPaymentNeedsReview(order.orderNumber, order.id);
        return errorMessage("Không tải được mã thanh toán. Vui lòng thử lại.");
      }
      lastOrderNumber = presented.presentation.orderNumber;
      lastTransferContent = presented.presentation.transferContent;
      return presentPaymentScreen(presented.presentation);
    },

    async reopen(orderNumber, customerId) {
      // Reopen reuses the same presentation path as refresh for a still-payable order.
      return this.refresh(orderNumber, customerId);
    },

    async cancel(orderNumber, customerId, correlationId) {
      const order = await findOrderByNumber(deps.db, orderNumber);
      if (!order) return errorMessage("Không tìm thấy đơn hàng.");
      const result = await cancelUnpaidOrder(deps.db, {
        orderId: order.id,
        customerId,
        correlationId,
      });
      if (!result.ok) return errorMessage(result.message);
      return {
        text: `Đơn ${order.orderNumber} đã huỷ.`,
        buttons: [[{ text: PAYMENT_COPY.mainMenu, callbackData: "menu:main" }]],
      };
    },
  };
}
