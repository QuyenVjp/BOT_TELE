import type { Db } from "../../infrastructure/db/transaction.js";
import { buyNow, cancelUnpaidOrder, isStockOutcomeCode } from "../../modules/commerce/buy-now.js";
import { findOrderByNumberForOwner } from "../../modules/commerce/repository.js";
import { presentPaymentForOrder } from "../../modules/payments/service.js";
import { findLiveIntentByOrderForOwner } from "../../modules/payments/repository.js";
import {
  normalizeTelegramUserId,
  type BuyNowCallbackCodec,
  type CallbackTokenCodec,
} from "../callback-codec.js";
import {
  presentPaymentScreen,
  presentPaymentExpired,
  presentPaymentNeedsReview,
  presentPaymentCancelled,
  presentCheckoutPreview,
  presentInsufficientBalance,
  PAYMENT_COPY,
} from "../presenters/payment.js";
import { presentStockOutcome, type PresentedMessage } from "../presenters/catalog.js";
import {
  getVariantById,
  loadVariantPresentationOverride,
} from "../../modules/catalog/repository.js";
import { loadOrderReservedQuantity } from "../../modules/digital-goods/repository.js";
import type { PaymentCheckResult } from "../../modules/payments/check-now.js";
import type { FulfillmentType } from "../../modules/catalog/fulfillment-type.js";
import type { CatalogAudience } from "../../modules/catalog/visibility.js";

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
}

export interface CheckoutCallbackDeps {
  db: Db;
  merchant: MerchantConfig;
  callbackCodec?: BuyNowCallbackCodec;
  /** Authoritative channel-identity lookup; callers never supply customerId. */
  resolveCustomerId?: (telegramUserId: string) => Promise<string | null>;
  /** Configured root admin Telegram id; never taken from client input. */
  adminTelegramUserId?: number | string;
  /** Unified token codec: verifies the checkout-preview and wallet-choice tokens. */
  tokenCodec?: CallbackTokenCodec;
  /** Wallet balance reader, used for the preview and the insufficient-funds screen. */
  walletBalanceVnd?: (customerId: string) => Promise<bigint | null>;
  /** Catalog audience resolver, so a TEST-mode owner can preview a test product. */
  resolveAudience?: (input: {
    telegramUserId: string;
    isRootAdmin: boolean;
  }) => Promise<CatalogAudience>;
  /** Configured wallet top-up bounds; a shortfall outside them links the picker instead. */
  walletTopUpBounds?: { minVnd: bigint; maxVnd: bigint };
  /** Debits the wallet for an order that was just created; returns the domain outcome. */
  payOrderWithWallet?: (input: {
    customerId: string;
    orderId: string;
    idempotencyKey: string;
    correlationId: string;
  }) => Promise<{ ok: boolean; message: string }>;
  /**
   * On-demand, read-only payment check behind the "Kiểm tra thanh toán" button.
   * Bounded SePay reconciliation with its own cooldown/lock; absent means the
   * button falls back to the internal projection only (no provider call).
   */
  reconcileForCheck?: () => Promise<PaymentCheckResult>;
}

/**
 * Customer-facing delivery wording per fulfillment type. The raw enum never reaches a
 * customer (`ACCOUNT`/`UNLIMITED_SERVICE` are backend vocabulary).
 */
const DELIVERY_LABELS: Record<FulfillmentType, string> = {
  STOCK_ACCOUNT: "Tự động",
  STOCK_CODE: "Tự động",
  DIGITAL_FILE: "Tự động (tệp số)",
  QUANTITY_STOCK: "Tự động",
  UNLIMITED_SERVICE: "Kích hoạt sau khi thanh toán",
  MANUAL_FULFILLMENT: "Nhân viên xử lý",
  SUPPLIER_API: "Tự động (nhà cung cấp)",
};

interface BuyNowCallbackInput {
  customerId: string;
  variantId: string;
  expectedPriceVnd: number;
  correlationId: string;
  idempotencyKey: string;
  telegramUserId: string;
  isRootAdmin: boolean;
}

export interface SignedCheckoutChoiceInput {
  callbackData: string;
  telegramUserId: string | bigint | number;
  correlationId: string;
}

export interface SignedBuyNowCallbackInput {
  callbackData: string;
  telegramUserId: string | bigint | number;
  correlationId: string;
}

export interface CheckoutCallbacks {
  buyNowFromCallback(input: SignedBuyNowCallbackInput): Promise<PresentedMessage>;
  /** Goal §32: confirmation screen rendered BEFORE any order or payment intent exists. */
  previewFromCallback(input: SignedCheckoutChoiceInput): Promise<PresentedMessage>;
  /** Goal §32/§41: pay the confirmed order from the wallet, atomically and once. */
  payWithWalletFromCallback(input: SignedCheckoutChoiceInput): Promise<PresentedMessage>;
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
  });

  const handleBuyNow = async (input: BuyNowCallbackInput): Promise<PresentedMessage> => {
    const result = await buyNow(deps.db, {
      customerId: input.customerId,
      variantId: input.variantId,
      expectedPriceVnd: input.expectedPriceVnd,
      idempotencyKey: input.idempotencyKey,
      correlationId: input.correlationId,
      telegramUserId: input.telegramUserId,
      isRootAdmin: input.isRootAdmin,
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
    return await presentPaymentScreen(presented.presentation, {
      status: "PENDING",
      productName: result.order.productNameVi,
      variantName: result.order.variantNameVi,
      fulfillmentType: result.order.fulfillmentType,
      ...(await presentationContext(result.order.variantId, result.order.id)),
    });
  };

  const isAdmin = (telegramUserId: string): boolean =>
    deps.adminTelegramUserId !== undefined && String(deps.adminTelegramUserId) === telegramUserId;

  /**
   * Presentation extras for a payment screen: the product's stored presentation
   * override (untrusted — the presenter parses it strictly and falls back to the
   * safe default when it does not fit) and the quantity the order actually
   * reserved. Quantity comes from the RESERVE ledger row, never from the callback.
   */
  const presentationContext = async (
    variantId: string,
    orderId: string,
  ): Promise<{ profileOverride?: unknown; quantity: number }> => {
    const [override, quantity] = await Promise.all([
      loadVariantPresentationOverride(deps.db, variantId),
      loadOrderReservedQuantity(deps.db, orderId),
    ]);
    return { ...(override !== undefined ? { profileOverride: override } : {}), quantity };
  };

  const loadCheckoutVariant = async (telegramUserId: string, variantId: string) => {
    const audience = deps.resolveAudience
      ? await deps.resolveAudience({ telegramUserId, isRootAdmin: isAdmin(telegramUserId) })
      : ("public" as CatalogAudience);
    return getVariantById(deps.db, variantId, audience);
  };

  /** A fresh Buy Now token for a price the customer is looking at right now. */
  const issueQrToken = (
    telegramUserId: string,
    variantId: string,
    expectedPriceVnd: number,
  ): string | undefined => {
    if (!deps.callbackCodec) return undefined;
    try {
      return deps.callbackCodec.issue({ telegramUserId, variantId, expectedPriceVnd });
    } catch {
      return undefined;
    }
  };

  const choiceToken = (
    action: "CHECKOUT_WALLET" | "SHOP_PRODUCT",
    telegramUserId: string,
    resourceId: string,
    amountVnd?: number,
    attemptId?: string,
  ): string | null => {
    try {
      return (
        deps.tokenCodec?.issue({
          action,
          telegramUserId,
          resourceId,
          ...(amountVnd === undefined ? {} : { amountVnd }),
          ...(attemptId === undefined ? {} : { secondaryResourceId: attemptId }),
        }) ?? null
      );
    } catch {
      return null;
    }
  };

  /** Shown when the confirmed price no longer matches the live price. */
  const priceChangedMessage = (cancelCallbackData: string): PresentedMessage => ({
    text: [
      "⚠️ Giá sản phẩm vừa thay đổi.",
      "",
      "Vui lòng mở lại sản phẩm để xem giá mới trước khi thanh toán. Bạn chưa bị trừ tiền.",
    ].join("\n"),
    buttons: [
      [
        { text: "🔄 Mở lại sản phẩm", callbackData: cancelCallbackData },
        { text: "💬 Hỗ trợ", callbackData: "sup:open" },
      ],
    ],
  });

  /**
   * The payment/status screen for one owned order.
   *
   * `check` is the "Kiểm tra thanh toán" intent: before reading the projection it asks the
   * bounded, cooldown-guarded, read-only reconciliation to look at the provider once. That
   * path can only ever record evidence the normal rules accept (it runs the same
   * `applyPaymentEvidence` as the webhook), so this handler still never marks an order paid
   * itself — it merely re-reads the projection afterwards. Navigation actions (reopen) pass
   * `check: false` so they cannot spend a provider call.
   *
   * A reconciliation failure is deliberately NOT caught: it means the database itself is
   * unhealthy, and the surrounding dispatcher retry is the right response — silently
   * pretending the check happened would be the worse failure.
   */
  const presentOrderPayment = async (
    orderNumber: string,
    customerId: string,
    check: boolean,
  ): Promise<PresentedMessage> => {
    let order = await findOrderByNumberForOwner(deps.db, orderNumber, customerId);
    if (!order) return errorMessage("Không tìm thấy đơn hàng.");

    if (check && deps.reconcileForCheck && order.status === "PENDING_PAYMENT") {
      const outcome = await deps.reconcileForCheck();
      if (outcome.reason === "RAN") {
        // Evidence may have settled this order while the provider was being read.
        const reread = await findOrderByNumberForOwner(deps.db, orderNumber, customerId);
        if (reread) order = reread;
      }
    }

    if (order.status === "COMPLETED") {
      return {
        text: `✅ Đơn hàng đã hoàn tất.\n\nĐơn: ${order.orderNumber}`,
        buttons: [
          [
            { text: "📦 Xem đơn hàng", callbackData: `ord:view:${order.orderNumber}` },
            { text: PAYMENT_COPY.mainMenu, callbackData: "menu:main" },
          ],
        ],
      };
    }
    if (order.status === "PAID" || order.status === "PROCESSING") {
      const isManual =
        order.fulfillmentType === "MANUAL_FULFILLMENT" ||
        order.fulfillmentType === "UNLIMITED_SERVICE";
      return {
        text: isManual
          ? `✅ Đã thanh toán.\n\nĐơn: ${order.orderNumber}\nĐang chờ nhân viên xử lý thủ công. Shop sẽ thông báo qua tin nhắn khi hoàn tất.`
          : `✅ Đã thanh toán.\n\nĐơn: ${order.orderNumber}\nĐang giao sản phẩm...`,
        buttons: [
          [
            { text: "📦 Xem đơn hàng", callbackData: `ord:view:${order.orderNumber}` },
            { text: PAYMENT_COPY.mainMenu, callbackData: "menu:main" },
          ],
        ],
      };
    }
    if (order.status === "EXPIRED") {
      return presentPaymentExpired(order.orderNumber);
    }
    if (order.status === "PAYMENT_NEEDS_REVIEW") {
      return presentPaymentNeedsReview(order.orderNumber, order.orderNumber);
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
      const live = await findLiveIntentByOrderForOwner(deps.db, order.id, customerId);
      if (!live) return presentPaymentNeedsReview(order.orderNumber, order.orderNumber);
      return errorMessage("Không tải được mã thanh toán. Vui lòng thử lại.");
    }
    lastOrderNumber = presented.presentation.orderNumber;
    lastTransferContent = presented.presentation.transferContent;
    return await presentPaymentScreen(presented.presentation, {
      status: "CHECK_PENDING",
      productName: order.productNameVi,
      variantName: order.variantNameVi,
      fulfillmentType: order.fulfillmentType,
      ...(await presentationContext(order.variantId, order.id)),
    });
  };

  return {
    async previewFromCallback(input) {
      const telegramUserId = normalizeTelegramUserId(input.telegramUserId);
      if (!telegramUserId || !deps.tokenCodec)
        return errorMessage("Không mở được xác nhận đơn hàng. Vui lòng mở lại sản phẩm.");
      const verified = deps.tokenCodec.verify(input.callbackData, { telegramUserId });
      if (
        !verified.ok ||
        verified.value.action !== "CHECKOUT_PREVIEW" ||
        !verified.value.resourceId
      ) {
        return errorMessage("Phiên này đã cũ. Đã tải lại thông tin mới nhất.");
      }
      const variant = await loadCheckoutVariant(telegramUserId, verified.value.resourceId);
      if (!variant || !variant.is_ready) {
        return errorMessage("Sản phẩm tạm hết hàng. Vui lòng chọn sản phẩm khác.");
      }
      const qrCallbackData = issueQrToken(telegramUserId, variant.id, Number(variant.price_vnd));
      const cancelCallbackData = choiceToken("SHOP_PRODUCT", telegramUserId, variant.product_id);
      if (!qrCallbackData || !cancelCallbackData) {
        return errorMessage("Không mở được xác nhận đơn hàng. Vui lòng mở lại sản phẩm.");
      }
      return presentCheckoutPreview({
        productName: variant.product_name_vi,
        variantName: variant.name_vi,
        priceVnd: BigInt(variant.price_vnd),
        deliveryLabel: DELIVERY_LABELS[variant.fulfillment_type] ?? "Tự động",
        warrantyLabel: variant.warranty_vi?.trim() || variant.delivery_eta_vi?.trim() || null,
        qrCallbackData,
        cancelCallbackData,
      });
    },

    async payWithWalletFromCallback(input) {
      const telegramUserId = normalizeTelegramUserId(input.telegramUserId);
      if (!telegramUserId || !deps.tokenCodec || !deps.resolveCustomerId)
        return errorMessage("Ví TIER20 không khả dụng. Vui lòng chọn VietQR.");
      const verified = deps.tokenCodec.verify(input.callbackData, { telegramUserId });
      if (
        !verified.ok ||
        verified.value.action !== "CHECKOUT_WALLET" ||
        !verified.value.resourceId
      ) {
        return errorMessage("Phiên này đã cũ. Đã tải lại thông tin mới nhất.");
      }
      const customerId = await deps.resolveCustomerId(telegramUserId);
      if (!customerId)
        return errorMessage("Không tìm thấy tài khoản khách hàng. Vui lòng mở lại cửa hàng.");
      const variant = await loadCheckoutVariant(telegramUserId, verified.value.resourceId);
      if (!variant || !variant.is_ready) {
        return errorMessage("Sản phẩm tạm hết hàng. Vui lòng chọn sản phẩm khác.");
      }
      const priceVnd = BigInt(variant.price_vnd);
      const qrCallbackData = issueQrToken(telegramUserId, variant.id, Number(variant.price_vnd));
      const cancelCallbackData =
        choiceToken("SHOP_PRODUCT", telegramUserId, variant.product_id) ?? "shop:home";
      // Charge the price the customer confirmed, never a freshly-read one: buyNow compares it
      // with the live price and rejects a mismatch, so a price change cannot pass silently.
      const confirmedPriceVnd = verified.value.amountVnd;
      if (!confirmedPriceVnd) return priceChangedMessage(cancelCallbackData);
      const balanceVnd = deps.walletBalanceVnd ? await deps.walletBalanceVnd(customerId) : null;

      if (balanceVnd !== null && balanceVnd < priceVnd) {
        if (!qrCallbackData)
          return errorMessage("Ví không đủ số dư. Vui lòng chọn VietQR khi mở lại sản phẩm.");
        const shortfallVnd = priceVnd - balanceVnd;
        const bounds = deps.walletTopUpBounds;
        const withinBounds =
          !bounds || (shortfallVnd >= bounds.minVnd && shortfallVnd <= bounds.maxVnd);
        return presentInsufficientBalance({
          balanceVnd,
          priceVnd,
          shortfallVnd,
          topUpCallbackData: withinBounds
            ? `wallet:topup:amount:${shortfallVnd.toString()}`
            : "wallet:topup",
          qrCallbackData,
          cancelCallbackData,
        });
      }
      if (!deps.payOrderWithWallet)
        return errorMessage("Ví TIER20 không khả dụng. Vui lòng chọn VietQR.");

      // Keyed on the attempt the customer confirmed, not on customer+variant: a double tap sends
      // the same token and therefore the same key (one order), while a repeat purchase starts from
      // a newly rendered preview and gets its own order. Deriving it from customer+variant made a
      // second purchase of the same variant impossible — buyNow returned the old, completed order.
      const attemptId = verified.value.secondaryResourceId;
      const idempotencyKey = attemptId
        ? `wallet:${customerId}:${attemptId}`
        : `wallet:${customerId}:${variant.id}`;
      const result = await buyNow(deps.db, {
        customerId,
        variantId: variant.id,
        expectedPriceVnd: confirmedPriceVnd,
        idempotencyKey,
        correlationId: input.correlationId,
        telegramUserId,
        isRootAdmin: isAdmin(telegramUserId),
      });
      if (!result.ok) {
        if (result.code === "PRICE_CHANGED") return priceChangedMessage(cancelCallbackData);
        if (isStockOutcomeCode(result.code)) return presentStockOutcome(result.code);
        return errorMessage(result.message);
      }
      lastOrderNumber = result.order.orderNumber;
      const paid = await deps.payOrderWithWallet({
        customerId,
        orderId: result.order.id,
        idempotencyKey,
        correlationId: input.correlationId,
      });
      if (!paid.ok) {
        return {
          text: `${paid.message}\n\nĐơn: ${result.order.orderNumber}`,
          buttons: [
            [{ text: "⚡ Nạp ví", callbackData: "wallet:topup" }],
            ...(qrCallbackData
              ? [[{ text: "🏦 Thanh toán VietQR", callbackData: qrCallbackData }]]
              : []),
            [{ text: "💬 Hỗ trợ", callbackData: "sup:open" }],
          ],
        };
      }
      return {
        text: `Đã thanh toán bằng ví. Chúng tôi sẽ giao tài khoản ngay.\n\nĐơn: ${result.order.orderNumber}`,
        buttons: [[{ text: "🧾 Xem đơn", callbackData: `ord:view:${result.order.orderNumber}` }]],
      };
    },

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
      const isRootAdmin =
        deps.adminTelegramUserId !== undefined &&
        String(deps.adminTelegramUserId) === telegramUserId;
      return handleBuyNow({
        customerId,
        variantId: verified.value.variantId,
        expectedPriceVnd: verified.value.expectedPriceVnd,
        idempotencyKey: verified.value.idempotencyKey,
        correlationId: input.correlationId,
        telegramUserId,
        isRootAdmin,
      });
    },

    async refresh(orderNumber, customerId) {
      return presentOrderPayment(orderNumber, customerId, true);
    },

    async reopen(orderNumber, customerId) {
      // Same screen as refresh, but reopen is a navigation action: it must not spend a
      // provider call. The "Kiểm tra thanh toán" button owns that side effect.
      return presentOrderPayment(orderNumber, customerId, false);
    },

    async cancel(orderNumber, customerId, correlationId) {
      const order = await findOrderByNumberForOwner(deps.db, orderNumber, customerId);
      if (!order) return errorMessage("Không tìm thấy đơn hàng.");
      const result = await cancelUnpaidOrder(deps.db, {
        orderId: order.id,
        customerId,
        correlationId,
      });
      if (!result.ok) return errorMessage(result.message);
      return presentPaymentCancelled(order.orderNumber);
    },
  };
}
