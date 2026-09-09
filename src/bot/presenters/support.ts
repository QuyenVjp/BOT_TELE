import type { InlineButton, PresentedMessage } from "./catalog.js";
import type { SupportReasonCode, SupportTicketStatus } from "../../modules/support/domain.js";
import type { SupportTicket } from "../../modules/support/service.js";
import {
  ADMIN_CONTACT_URL,
  COMMUNITY_URL,
  SHOP_NAME,
} from "../../modules/catalog/shop-profile.js";

/**
 * Vietnamese support presenters (T087, FR-019).
 *
 * The ticket-open flow offers a structured reason menu and never asks for a
 * password/credential. Confirmation screens surface only a safe reference and
 * a ticket id — never a mark-paid or a credential paste prompt.
 */

export const SUPPORT_COPY = {
  title: `💬 HỖ TRỢ ${SHOP_NAME}`,
  reasonPrompt: "Chọn lý do bạn cần hỗ trợ:",
  descriptionPrompt: "Mô tả ngắn gọn vấn đề (không gửi mật khẩu hay ảnh chứa thông tin đăng nhập).",
  openedTitle: "✅ Đã tạo ticket hỗ trợ",
  openedBody:
    "Chúng tôi sẽ phản hồi trong thời gian sớm nhất. Vui lòng giữ mã tham chiếu bên dưới.",
  replacementPending: "Yêu cầu thay thế đã được ghi nhận và đang chờ chủ shop duyệt.",
  listTitle: "📋 Ticket của bạn",
  empty: "Bạn chưa có ticket hỗ trợ nào.",
  mainMenu: "Menu chính",
  back: "Quay lại",
  close: "Đóng ticket",
} as const;

export const REASON_LABEL: Record<SupportReasonCode, string> = {
  ASSET_NOT_WORKING: "Tài khoản không dùng được",
  PAYMENT_QUESTION: "Câu hỏi về thanh toán",
  DELIVERY_NOT_RECEIVED: "Chưa nhận được tài khoản",
  REFUND_REQUEST: "Yêu cầu hoàn tiền",
  GENERAL_QUESTION: "Câu hỏi chung",
  OTHER: "Khác",
};

const STATUS_LABEL: Record<SupportTicketStatus, string> = {
  OPEN: "Mở",
  WAITING_SHOP: "Chờ shop",
  WAITING_CUSTOMER: "Chờ bạn",
  RESOLVED: "Đã xử lý",
  CLOSED: "Đã đóng",
  MANUAL_REVIEW: "Đang kiểm tra",
};

/** Reason picker — structured only, no free-form secret invitation. */
export function presentSupportReasonMenu(orderNumber?: string): PresentedMessage {
  const suffix = orderNumber ? `:${orderNumber}` : "";
  const buttons: InlineButton[][] = [
    [{ text: "👨‍💻 Nhắn Admin", url: ADMIN_CONTACT_URL, callbackData: "" }],
    [{ text: "📢 Cộng đồng", url: COMMUNITY_URL, callbackData: "" }],
    ...(Object.keys(REASON_LABEL) as SupportReasonCode[]).map((code) => [
      { text: REASON_LABEL[code], callbackData: `sup:reason:${code}${suffix}` },
    ]),
    [{ text: SUPPORT_COPY.mainMenu, callbackData: "menu:main" }],
    [{ text: "🧾 Đơn hàng", callbackData: "ord:list" }],
  ];
  return {
    text: [
      SUPPORT_COPY.title,
      "",
      "Need help with:",
      "- order",
      "- payment",
      "- warranty",
      "- product usage",
      "",
      SUPPORT_COPY.reasonPrompt,
    ].join("\n"),
    buttons,
  };
}

/** Confirmation after a ticket is opened. */
export function presentTicketOpened(input: {
  ticketId: string;
  orderNumber?: string | null;
  reasonCode: SupportReasonCode;
  replacementCaseId?: string;
}): PresentedMessage {
  const lines = [
    SUPPORT_COPY.openedTitle,
    "",
    SUPPORT_COPY.openedBody,
    `Lý do: ${REASON_LABEL[input.reasonCode]}`,
  ];
  if (input.orderNumber) lines.push(`Đơn: ${input.orderNumber}`);
  lines.push(`Mã ticket: ${input.ticketId}`);
  if (input.replacementCaseId)
    lines.push(SUPPORT_COPY.replacementPending, `Mã yêu cầu: ${input.replacementCaseId}`);
  return {
    text: lines.join("\n"),
    buttons: [[{ text: SUPPORT_COPY.mainMenu, callbackData: "menu:main" }]],
  };
}

/** Customer's own ticket list. */
export function presentTicketList(tickets: SupportTicket[]): PresentedMessage {
  if (tickets.length === 0) {
    return {
      text: [SUPPORT_COPY.listTitle, "", SUPPORT_COPY.empty].join("\n"),
      buttons: [[{ text: SUPPORT_COPY.mainMenu, callbackData: "menu:main" }]],
    };
  }
  const lines = [SUPPORT_COPY.listTitle, ""];
  const buttons: InlineButton[][] = [];
  for (const t of tickets) {
    lines.push(`• ${t.id.slice(-8)} — ${REASON_LABEL[t.reasonCode]} · ${STATUS_LABEL[t.status]}`);
    buttons.push([{ text: t.id.slice(-8), callbackData: `sup:view:${t.id}` }]);
  }
  buttons.push([{ text: SUPPORT_COPY.mainMenu, callbackData: "menu:main" }]);
  return { text: lines.join("\n"), buttons };
}
