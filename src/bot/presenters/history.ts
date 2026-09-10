import { formatVnd, makeVnd } from "../../shared/money/index.js";
import type { InlineButton, PresentedMessage } from "./catalog.js";
import type { OrderHistoryItem, OrderHistoryPage } from "../../modules/commerce/history.js";
import type { Order, OrderStatus } from "../../modules/commerce/order.js";

/**
 * Vietnamese Order history + detail presenters (T087, FR-018, goal §50-§52).
 *
 * History shows only the customer's own orders as paginated summaries with a
 * stable friendly status and the exact amount. Detail surfaces the authoritative
 * snapshot (payment state, created time, delivery/warranty policy) and offers the
 * two context actions: support and back to the list. No internal enum, id, secret
 * or payment-control is ever rendered here.
 */

export const HISTORY_COPY = {
  title: "🧾 ĐƠN HÀNG CỦA TÔI",
  empty: "Bạn chưa có đơn hàng nào.",
  more: "Xem thêm",
  back: "⬅️ Quay lại",
  mainMenu: "Menu chính",
  support: "💬 Hỗ trợ",
  detailTitle: "🧾 Chi tiết đơn hàng",
  priceLabel: "Giá",
  paymentLabel: "Thanh toán",
  statusLabel: "Trạng thái",
  createdLabel: "Ngày tạo",
  deliveryLabel: "Giao hàng / Bảo hành",
} as const;

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

function statusLabel(status: OrderStatus): string {
  return ORDER_STATUS_LABEL[status] ?? ORDER_STATUS_FALLBACK;
}

/** Payment state from settlement evidence, never from a raw internal status. */
function paymentLabel(order: Order): string {
  if (order.status === "PAYMENT_NEEDS_REVIEW") return ORDER_STATUS_FALLBACK;
  if (order.status === "REFUND_PENDING" || order.status === "REFUNDED") return "💸 Đã hoàn tiền";
  if (order.paidAt) return "✅ Đã thanh toán";
  if (order.status === "CANCELLED" || order.status === "EXPIRED" || order.status === "REJECTED")
    return "❌ Chưa thanh toán";
  return "⏳ Chờ thanh toán";
}

/** Delivery + warranty policy line: what the customer gets next, in human words. */
function deliveryWarrantyLine(order: Order): string {
  const warranty =
    order.warrantyDays > 0 ? `Bảo hành ${order.warrantyDays} ngày` : "Không kèm bảo hành";
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
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${day}/${m}/${y}`;
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
      `• ${item.orderNumber} — ${item.productNameVi} · ${amount} · ${statusLabel(item.status)}`,
    );
    buttons.push([{ text: `${item.orderNumber}`, callbackData: `ord:view:${item.orderNumber}` }]);
  }

  if (page.nextCursor) {
    buttons.push([{ text: HISTORY_COPY.more, callbackData: `ord:list:${page.nextCursor}` }]);
  }
  buttons.push([{ text: HISTORY_COPY.mainMenu, callbackData: "menu:main" }]);

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
  variantId: string;
}

export function presentOrderDetail(
  order: Order,
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
    `${HISTORY_COPY.statusLabel}: ${statusLabel(order.status)}`,
    `${HISTORY_COPY.createdLabel}: ${formatDate(order.createdAt)}`,
    `${HISTORY_COPY.deliveryLabel}: ${deliveryWarrantyLine(order)}`,
    // Goal §7: a live warranty states its end date and how much of it is left, so the customer can
    // see their own position without asking. An expired one says so instead of counting backwards.
    ...(warranty && warranty.warrantyDays > 0
      ? warranty.expired
        ? ["", "🛡 Bảo hành: đã hết hạn"]
        : [
            "",
            "🛡 Bảo hành đến: " +
              new Date(warranty.endsAt).toLocaleDateString("vi-VN", {
                timeZone: "Asia/Ho_Chi_Minh",
              }),
            `Đã sử dụng: ${warranty.usedDays} ngày`,
            `Còn bảo hành: ${warranty.remainingDays} ngày`,
          ]
      : []),
  ].join("\n");

  const buttons: PresentedMessage["buttons"] = [
    ...(warranty && !warranty.expired && warranty.warrantyDays > 0
      ? [
          [
            {
              text: "🛡 Báo lỗi / Bảo hành",
              callbackData: `warranty:report:${warranty.variantId}`,
            },
          ],
        ]
      : []),
    [{ text: HISTORY_COPY.support, callbackData: `sup:open:${order.orderNumber}` }],
    [{ text: HISTORY_COPY.back, callbackData: "ord:list" }],
  ];

  return { text, buttons };
}

/** Convenience: the summary row shape used in tests. */
export function summarizeHistoryItem(item: OrderHistoryItem): string {
  return `${item.orderNumber} · ${statusLabel(item.status)}`;
}
