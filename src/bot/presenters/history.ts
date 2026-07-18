import { formatVnd, makeVnd } from "../../shared/money/index.js";
import type { InlineButton, PresentedMessage } from "./catalog.js";
import type { OrderHistoryItem, OrderHistoryPage } from "../../modules/commerce/history.js";
import type { Order, OrderStatus } from "../../modules/commerce/order.js";

/**
 * Vietnamese Order history + detail presenters (T087, FR-018).
 *
 * History shows only the customer's own orders as paginated summaries with a
 * stable status label. Detail surfaces the authoritative snapshot and offers a
 * reopen affordance for unpaid orders and a support affordance always. No
 * secret or payment-control is ever rendered here.
 */

export const HISTORY_COPY = {
  title: "📦 Đơn hàng của bạn",
  empty: "Bạn chưa có đơn hàng nào.",
  more: "Xem thêm",
  back: "Quay lại",
  mainMenu: "Menu chính",
  support: "💬 Hỗ trợ",
  reopen: "Tiếp tục thanh toán",
  detailTitle: "🧾 Chi tiết đơn hàng",
  priceLabel: "Giá",
  statusLabel: "Trạng thái",
  createdLabel: "Ngày tạo",
} as const;

/** Stable Vietnamese status labels for the customer view. */
export const ORDER_STATUS_LABEL: Record<OrderStatus, string> = {
  DRAFT: "Nháp",
  PENDING_PAYMENT: "Chờ thanh toán",
  PAID: "Đã thanh toán",
  PROCESSING: "Đang xử lý",
  COMPLETED: "Hoàn tất",
  REJECTED: "Bị từ chối",
  CANCELLED: "Đã huỷ",
  EXPIRED: "Hết hạn",
  PAYMENT_NEEDS_REVIEW: "Đang kiểm tra thanh toán",
  FULFILLMENT_NEEDS_REVIEW: "Đang kiểm tra giao hàng",
  REFUND_PENDING: "Chờ hoàn tiền",
  REFUNDED: "Đã hoàn tiền",
};

function statusLabel(status: OrderStatus): string {
  return ORDER_STATUS_LABEL[status] ?? status;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${day}/${m}/${y}`;
}

/** Paginated history list. Each row links to its detail view. */
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
    lines.push(`• ${item.orderNumber} — ${item.productNameVi} · ${statusLabel(item.status)}`);
    buttons.push([{ text: `${item.orderNumber}`, callbackData: `ord:view:${item.orderNumber}` }]);
  }

  if (page.nextCursor) {
    buttons.push([{ text: HISTORY_COPY.more, callbackData: `ord:list:${page.nextCursor}` }]);
  }
  buttons.push([{ text: HISTORY_COPY.mainMenu, callbackData: "menu:main" }]);

  return { text: lines.join("\n"), buttons };
}

/** Detail view for one owned order. */
export function presentOrderDetail(order: Order): PresentedMessage {
  const price = formatVnd(makeVnd(Number(order.priceVnd)));
  const text = [
    HISTORY_COPY.detailTitle,
    "",
    `Đơn: ${order.orderNumber}`,
    `${order.productNameVi} — ${order.variantNameVi}`,
    `${HISTORY_COPY.priceLabel}: ${price}`,
    `${HISTORY_COPY.statusLabel}: ${statusLabel(order.status)}`,
    `${HISTORY_COPY.createdLabel}: ${formatDate(order.createdAt)}`,
  ].join("\n");

  const buttons: InlineButton[][] = [];
  // Reopen affordance only for a still-payable unpaid order.
  if (order.status === "PENDING_PAYMENT") {
    buttons.push([{ text: HISTORY_COPY.reopen, callbackData: `pay:reopen:${order.orderNumber}` }]);
  }
  buttons.push([{ text: HISTORY_COPY.support, callbackData: `sup:open:${order.orderNumber}` }]);
  buttons.push([
    { text: HISTORY_COPY.back, callbackData: "ord:list" },
    { text: HISTORY_COPY.mainMenu, callbackData: "menu:main" },
  ]);

  return { text, buttons };
}

/** Convenience: the summary row shape used in tests. */
export function summarizeHistoryItem(item: OrderHistoryItem): string {
  return `${item.orderNumber} · ${statusLabel(item.status)}`;
}
