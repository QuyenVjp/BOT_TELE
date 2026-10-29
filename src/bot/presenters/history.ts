import { PAYMENT_COPY } from "./payment.js";
import { toHoChiMinh } from "../../shared/time/index.js";
import { formatVnd, makeVnd } from "../../shared/money/index.js";
import { compactInlineRows, type InlineButton, type PresentedMessage } from "./catalog.js";
import { CUSTOMER_BUTTONS } from "./customer-buttons.js";
import type {
  CustomerOrderDetail,
  CustomerPaymentEvidence,
  OrderHistoryItem,
  OrderHistoryPage,
} from "../../modules/commerce/history.js";
import type { OrderStatus } from "../../modules/commerce/order.js";

/**
 * Vietnamese Order history + detail presenters (T087, FR-018, goal §50-§52).
 *
 * History shows only the customer's own orders as paginated summaries with a
 * stable friendly status and the exact amount. Detail surfaces the authoritative
 * snapshot (payment state, created time, delivery/warranty policy) and offers
 * ownership-checked context actions. No internal enum, id, secret or payment-control
 * is ever rendered here.
 */

export const HISTORY_COPY = {
  title: "🧾 Đơn hàng của tôi",
  empty: "Bạn chưa có đơn hàng nào.",
  more: "Xem thêm",
  back: CUSTOMER_BUTTONS.back,
  mainMenu: CUSTOMER_BUTTONS.home,
  support: CUSTOMER_BUTTONS.support,
  buyAgain: "🔁 Mua lại",
  viewAlternatives: "🔎 Xem sản phẩm khác",
  detailTitle: "🧾 Chi tiết đơn hàng",
  priceLabel: "Giá",
  paymentLabel: "Thanh toán",
  statusLabel: "Trạng thái",
  createdLabel: "Ngày tạo",
  deliveryLabel: "Giao hàng / Bảo hành",
} as const;

export function presentBuyAgainUnavailable(): PresentedMessage {
  return {
    text: [
      "⚠️ Không thể mua lại sản phẩm này lúc này.",
      "",
      "Sản phẩm có thể đã ngừng bán, đổi giá hoặc hết hàng.",
    ].join("\n"),
    buttons: [
      [{ text: HISTORY_COPY.viewAlternatives, callbackData: "shop:home" }],
      [{ text: HISTORY_COPY.support, callbackData: "supp:open" }],
      [{ text: HISTORY_COPY.mainMenu, callbackData: "menu:main" }],
    ],
  };
}

/**
 * Owner-facing status wording (goal §52). A status outside this map — a review or
 * refund state today, any future enum tomorrow — renders the support wording, so a
 * raw internal value can never reach a customer.
 */
export const ORDER_STATUS_LABEL: Readonly<Partial<Record<OrderStatus, string>>> = {
  PENDING_PAYMENT: "⏳ Chờ thanh toán",
  PAID: "✅ Đã thanh toán",
  PROCESSING: "📦 Đang giao",
  COMPLETED: "🎉 Hoàn tất",
  EXPIRED: "⌛ Hết hạn",
  CANCELLED: "❌ Đã huỷ",
};

export const ORDER_STATUS_FALLBACK = "⚠️ Cần hỗ trợ";

function hasSettledPurchaseEvidence(evidence: CustomerPaymentEvidence): boolean {
  return evidence === "SEPAY_SETTLED" || evidence === "WALLET_PURCHASED";
}

function statusLabel(status: OrderStatus, paymentEvidence: CustomerPaymentEvidence): string {
  if (status === "REFUND_PENDING") {
    return hasSettledPurchaseEvidence(paymentEvidence)
      ? "⏳ Đang xử lý yêu cầu hoàn tiền"
      : ORDER_STATUS_FALLBACK;
  }
  if (status === "REFUNDED") {
    return paymentEvidence === "WALLET_REFUNDED" ? "✅ Đã hoàn vào ví" : ORDER_STATUS_FALLBACK;
  }
  if (
    (status === "PAID" || status === "PROCESSING" || status === "COMPLETED") &&
    !hasSettledPurchaseEvidence(paymentEvidence)
  ) {
    return ORDER_STATUS_FALLBACK;
  }
  return ORDER_STATUS_LABEL[status] ?? ORDER_STATUS_FALLBACK;
}

/** Payment state from settlement evidence, never from a raw internal status. */
function paymentLabel(order: CustomerOrderDetail): string {
  if (order.status === "PAYMENT_NEEDS_REVIEW") return ORDER_STATUS_FALLBACK;
  if (order.status === "REFUND_PENDING") {
    return hasSettledPurchaseEvidence(order.paymentEvidence)
      ? "⏳ Đang chờ hoàn tiền"
      : ORDER_STATUS_FALLBACK;
  }
  if (order.status === "REFUNDED") {
    return order.paymentEvidence === "WALLET_REFUNDED" ? "💸 Đã hoàn tiền" : ORDER_STATUS_FALLBACK;
  }
  if (order.status === "PAID" || order.status === "PROCESSING" || order.status === "COMPLETED") {
    return hasSettledPurchaseEvidence(order.paymentEvidence)
      ? "✅ Đã thanh toán"
      : ORDER_STATUS_FALLBACK;
  }
  if (order.status === "CANCELLED" || order.status === "EXPIRED" || order.status === "REJECTED")
    return "❌ Chưa thanh toán";
  return "⏳ Chờ thanh toán";
}

/** Delivery + warranty policy line: what the customer gets next, in human words. */
function deliveryWarrantyLine(order: CustomerOrderDetail): string {
  const warranty =
    order.warrantyDays > 0 ? `Bảo hành ${order.warrantyDays} ngày` : "Không kèm bảo hành";
  if (
    (order.status === "PAID" ||
      order.status === "PROCESSING" ||
      order.status === "COMPLETED" ||
      order.status === "REFUND_PENDING") &&
    !hasSettledPurchaseEvidence(order.paymentEvidence)
  ) {
    return `Liên hệ hỗ trợ để kiểm tra · ${warranty}`;
  }
  if (order.status === "REFUNDED" && order.paymentEvidence !== "WALLET_REFUNDED") {
    return `Liên hệ hỗ trợ để kiểm tra · ${warranty}`;
  }
  switch (order.status) {
    case "COMPLETED":
      return `✅ Đã giao · ${warranty}`;
    case "PROCESSING":
    case "PAID":
      return `📦 Đang chuẩn bị giao · ${warranty}`;
    case "DRAFT":
    case "PENDING_PAYMENT":
      return `Giao tự động ngay sau khi thanh toán · ${warranty}`;
    case "EXPIRED":
    case "CANCELLED":
    case "REJECTED":
      return `Đơn không còn hiệu lực · ${warranty}`;
    default:
      return `Liên hệ hỗ trợ để kiểm tra · ${warranty}`;
  }
}

function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const { year, month, day } = toHoChiMinh(date);
  return `${String(day).padStart(2, "0")}/${String(month).padStart(2, "0")}/${year}`;
}

/** Paginated history list. Each row shows order number, product and amount. */
export function presentOrderHistory(page: OrderHistoryPage): PresentedMessage {
  if (page.items.length === 0) {
    return {
      text: [HISTORY_COPY.title, "", HISTORY_COPY.empty].join("\n"),
      buttons: [[{ text: HISTORY_COPY.mainMenu, callbackData: "menu:main" }]],
    };
  }

  const lines = [HISTORY_COPY.title, ""];
  const buttons: InlineButton[][] = [];
  for (const item of page.items) {
    const amount = formatVnd(makeVnd(BigInt(item.priceVnd)));
    lines.push(
      `• ${item.orderNumber} — ${item.productNameVi} · ${amount} · ${statusLabel(item.status, item.paymentEvidence)}`,
    );
  }
  buttons.push(
    ...compactInlineRows(
      page.items.map((item) => ({
        text: item.orderNumber,
        callbackData: `ord:view:${item.orderNumber}`,
      })),
    ),
  );

  if (page.nextCursor) {
    buttons.push([
      { text: HISTORY_COPY.more, callbackData: `ord:list:${page.nextCursor}` },
      { text: HISTORY_COPY.mainMenu, callbackData: "menu:main" },
    ]);
  } else {
    buttons.push([{ text: HISTORY_COPY.mainMenu, callbackData: "menu:main" }]);
  }

  return { text: lines.join("\n"), buttons };
}

/** Detail view for one owned order: snapshot, payment state, status, policy. */
/** Goal §7: the warranty state of a fulfilled order, as the customer should read it. */
export interface OrderWarrantyState {
  warrantyDays: number;
  endsAt: string;
  usedDays: number;
  remainingDays: number;
  expired: boolean;
  orderId: string;
}

function warrantyLines(warranty: OrderWarrantyState | undefined): string[] {
  if (!warranty || warranty.warrantyDays <= 0) return [];
  if (warranty.expired) return ["", "🛡 Bảo hành: đã hết hạn"];
  return [
    "",
    "🛡 Bảo hành đến: " +
      new Date(warranty.endsAt).toLocaleDateString("vi-VN", {
        timeZone: "Asia/Ho_Chi_Minh",
      }),
    `Đã sử dụng: ${warranty.usedDays} ngày`,
    `Còn bảo hành: ${warranty.remainingDays} ngày`,
  ];
}

export function presentOrderDetail(
  order: CustomerOrderDetail,
  warranty?: OrderWarrantyState | undefined,
): PresentedMessage {
  const price = formatVnd(makeVnd(BigInt(order.priceVnd)));
  const text = [
    HISTORY_COPY.detailTitle,
    "",
    `Đơn: ${order.orderNumber}`,
    `${order.productNameVi} — ${order.variantNameVi}`,
    `${HISTORY_COPY.priceLabel}: ${price}`,
    `${HISTORY_COPY.paymentLabel}: ${paymentLabel(order)}`,
    `${HISTORY_COPY.statusLabel}: ${statusLabel(order.status, order.paymentEvidence)}`,
    `${HISTORY_COPY.createdLabel}: ${formatDate(order.createdAt)}`,
    `${HISTORY_COPY.deliveryLabel}: ${deliveryWarrantyLine(order)}`,
    ...warrantyLines(warranty),
  ].join("\n");

  const buttons: PresentedMessage["buttons"] = [
    ...(order.status === "EXPIRED"
      ? [
          [
            {
              text: PAYMENT_COPY.reopen,
              callbackData: `pay:reopen:${order.orderNumber}`,
            },
          ],
        ]
      : []),
    ...(order.status === "COMPLETED"
      ? [
          [
            {
              text: HISTORY_COPY.buyAgain,
              callbackData: `buyagain:${order.orderNumber}`,
            },
          ],
        ]
      : []),
    ...(warranty && !warranty.expired && warranty.warrantyDays > 0
      ? [
          [
            {
              text: CUSTOMER_BUTTONS.reportIssue,
              callbackData: `warranty:report:${warranty.orderId}`,
            },
          ],
        ]
      : []),
    [
      { text: CUSTOMER_BUTTONS.support, callbackData: `sup:open:${order.orderNumber}` },
      { text: CUSTOMER_BUTTONS.back, callbackData: "ord:list" },
    ],
  ];

  return { text, buttons };
}

/** Convenience: the summary row shape used in tests. */
export function summarizeHistoryItem(item: OrderHistoryItem): string {
  return `${item.orderNumber} · ${statusLabel(item.status, item.paymentEvidence)}`;
}
