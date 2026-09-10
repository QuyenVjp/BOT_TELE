/**
 * Admin warranty screens (goal: warranty / defect report / prorated refund).
 *
 * Two rules shape this surface:
 *
 *  * The system recommends, the owner decides. Every screen shows what the system calculated and
 *    labels it as a recommendation; nothing here resolves a claim by itself.
 *  * The system never moves money. The payout screen exists to tell the owner WHERE to send money
 *    and to record that they did — it can only mark an obligation paid, never pay one.
 *
 * Bank details are shown masked everywhere except the payout screen for the claim being paid, and
 * a credential is never rendered here at all.
 */
import type { InlineButton, PresentedMessage } from "./catalog.js";
import { ISSUE_TYPE_LABELS, type WarrantyIssueType } from "../../modules/warranty/claims.js";

const vnd = (value: bigint) => `${value.toLocaleString("vi-VN")} ₫`;
const day = (iso: string) =>
  new Date(iso).toLocaleDateString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" });

/** Mask a bank account for every screen except the payout itself. */
export function maskAccountNumber(value: string | null): string {
  if (!value) return "—";
  const tail = value.slice(-4);
  return `${"*".repeat(Math.max(0, value.length - 4))}${tail}`;
}

export function maskAccountHolder(value: string | null): string {
  if (!value) return "—";
  const parts = value.trim().split(/\s+/u);
  return parts
    .map((part, index) =>
      index === parts.length - 1
        ? part
        : part.length <= 1
          ? part
          : `${part[0]}${"*".repeat(Math.max(0, part.length - 2))}${part.slice(-1)}`,
    )
    .join(" ");
}

export type WarrantyQueueView =
  | "new"
  | "verifying"
  | "waiting_customer"
  | "refund_due"
  | "replacement"
  | "done"
  | "rejected"
  | "overdue";

/** The owner reads the timeline as an operator log, not as the second-person customer copy. */
const OWNER_TIMELINE_LABELS: Record<string, string> = {
  SUBMITTED: "Khách gửi yêu cầu",
  WAITING_CUSTOMER: "Chờ khách bổ sung thông tin",
  VERIFIED_DEFECT: "Đã xác nhận lỗi",
  REPLACEMENT_APPROVED: "Đã duyệt đổi hàng",
  REFUND_APPROVED: "Đã duyệt hoàn tiền",
  REFUND_DUE: "Chờ chuyển tiền",
  REFUND_PAID: "Đã xác nhận chuyển tiền",
  REJECTED: "Đã từ chối",
  RESOLVED: "Đã xử lý xong",
  CANCELLED: "Đã huỷ",
};

const VIEW_LABELS: Record<WarrantyQueueView, string> = {
  new: "🆕 Mới",
  verifying: "🔍 Chờ xác minh",
  waiting_customer: "👤 Chờ khách",
  refund_due: "💸 Chờ hoàn tiền",
  replacement: "🔄 Chờ đổi hàng",
  done: "✅ Đã xử lý",
  rejected: "❌ Từ chối",
  overdue: "⚠️ Quá hạn",
};

export interface WarrantyQueueRow {
  claimNumber: string;
  claimId: string;
  customerLabel: string;
  productName: string;
  amountVnd: bigint | null;
  statusLabel: string;
}

/** Goal §17: the queue, with counters, and the SLA breach called out. */
export function presentAdminWarrantyQueue(input: {
  view: WarrantyQueueView;
  counts: Record<WarrantyQueueView, number>;
  rows: WarrantyQueueRow[];
}): PresentedMessage {
  const views = Object.keys(VIEW_LABELS) as WarrantyQueueView[];
  return {
    text: [
      "🛡 BẢO HÀNH / HỖ TRỢ",
      "",
      views
        .filter((view) => view !== input.view)
        .map((view) => `${VIEW_LABELS[view]}: ${input.counts[view] ?? 0}`)
        .join(" · "),
      "",
      `${VIEW_LABELS[input.view]} — ${input.rows.length} yêu cầu`,
      ...(input.rows.length === 0
        ? ["Không có yêu cầu nào trong mục này."]
        : input.rows.map(
            (row) =>
              `• ${row.claimNumber} · ${row.productName} · ${row.customerLabel}${
                row.amountVnd === null ? "" : ` · ${vnd(row.amountVnd)}`
              } · ${row.statusLabel}`,
          )),
    ].join("\n"),
    buttons: [
      // One row per claim: the list above names them, and this is how the owner opens one.
      ...input.rows.map((row) => [
        {
          text: `🧾 ${row.claimNumber}`,
          callbackData: `admin:warranty:claim:${row.claimId}`,
        },
      ]),
      ...views.map((view) => [
        {
          text: `${VIEW_LABELS[view]} (${input.counts[view] ?? 0})`,
          callbackData: `admin:warranty:view:${view}`,
        },
      ]),
      [
        { text: "💰 Hàng chờ chi", callbackData: "admin:warranty:refunds" },
        { text: "🏠 Quản trị", callbackData: "admin:menu" },
      ],
    ],
  };
}

export interface AdminClaimView {
  id: string;
  claimNumber: string;
  status: string;
  statusLabel: string;
  customerLabel: string;
  orderNumber: string;
  productName: string;
  issueType: WarrantyIssueType;
  reportedAt: string;
  warrantyStart: string;
  warrantyEnd: string;
  usedDays: number;
  remainingDays: number;
  paidAmountVnd: bigint;
  calculatedRefundVnd: bigint;
  approvedRefundVnd: bigint | null;
  assetRef: string | null;
  coverageSnapshot: string | null;
  exclusionsSnapshot: string | null;
  bankName: string | null;
  accountNumber: string | null;
  accountHolder: string | null;
  rejectionReason: string | null;
  timeline: Array<{ kind: string; safeNote: string | null; createdAt: string }>;
  canVerify: boolean;
  canReplace: boolean;
  canRefund: boolean;
}

/** Goal §18: everything the owner needs to decide, and nothing they must not see. */
export function presentAdminWarrantyClaim(claim: AdminClaimView): PresentedMessage {
  const when = (iso: string) =>
    new Date(iso).toLocaleString("vi-VN", {
      timeZone: "Asia/Ho_Chi_Minh",
      day: "2-digit",
      month: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  const actions: InlineButton[][] = [];
  if (claim.canVerify) {
    actions.push([
      { text: "✅ Xác nhận lỗi", callbackData: `admin:warranty:verify:${claim.id}` },
      { text: "❓ Yêu cầu thêm thông tin", callbackData: `admin:warranty:info:${claim.id}` },
    ]);
    actions.push([
      { text: "❌ Từ chối bảo hành", callbackData: `admin:warranty:reject:${claim.id}` },
    ]);
  }
  if (claim.canReplace) {
    actions.push([
      { text: "🔄 Duyệt đổi tài khoản", callbackData: `admin:warranty:replace:${claim.id}` },
    ]);
  }
  if (claim.canRefund) {
    actions.push([
      { text: "💸 Duyệt hoàn tiền", callbackData: `admin:warranty:refund:${claim.id}` },
    ]);
  }
  if (claim.status === "REFUND_DUE") {
    actions.push([
      { text: "💸 Xử lý hoàn tiền", callbackData: `admin:warranty:payout:${claim.id}` },
    ]);
  }
  return {
    text: [
      `🛡 YÊU CẦU ${claim.claimNumber}`,
      `Trạng thái: ${claim.statusLabel}`,
      "",
      `Khách: ${claim.customerLabel}`,
      `Đơn: ${claim.orderNumber}`,
      `Sản phẩm: ${claim.productName}`,
      claim.assetRef ? `Tài khoản đã giao: ${claim.assetRef}` : "Giao hàng thủ công",
      `Lỗi: ${ISSUE_TYPE_LABELS[claim.issueType]}`,
      `Báo lúc: ${when(claim.reportedAt)}`,
      "",
      `Bảo hành: ${day(claim.warrantyStart)} → ${day(claim.warrantyEnd)}`,
      `Đã dùng: ${claim.usedDays} ngày · Còn: ${claim.remainingDays} ngày`,
      `Khách đã trả: ${vnd(claim.paidAmountVnd)}`,
      `Hệ thống tính: ${vnd(claim.calculatedRefundVnd)} (đề xuất)`,
      ...(claim.approvedRefundVnd === null
        ? []
        : [`Đã duyệt hoàn: ${vnd(claim.approvedRefundVnd)}`]),
      ...(claim.rejectionReason ? ["", `Đã từ chối: ${claim.rejectionReason}`] : []),
      ...(claim.coverageSnapshot ? ["", `Phạm vi: ${claim.coverageSnapshot}`] : []),
      ...(claim.exclusionsSnapshot ? [`Không thuộc bảo hành: ${claim.exclusionsSnapshot}`] : []),
      ...(claim.accountNumber
        ? [
            "",
            `Nhận tiền: ${claim.bankName ?? ""} ${maskAccountNumber(claim.accountNumber)} ${maskAccountHolder(claim.accountHolder)}`,
          ]
        : []),
      "",
      "Diễn biến:",
      ...claim.timeline.map(
        (event) =>
          `• ${when(event.createdAt)} — ${OWNER_TIMELINE_LABELS[event.kind] ?? "Cập nhật"}${
            event.safeNote ? `: ${event.safeNote}` : ""
          }`,
      ),
      "",
      "Bạn kiểm tra tài khoản đã giao trước khi quyết định.",
    ].join("\n"),
    buttons: [
      ...actions,
      [{ text: "🛡 Danh sách bảo hành", callbackData: "admin:warranty" }],
      [{ text: "🏠 Quản trị", callbackData: "admin:menu" }],
    ],
  };
}

/** Goal §25: the refund confirmation, with the calculation spelled out. */
export function presentAdminRefundConfirm(input: {
  claimId: string;
  claimNumber: string;
  paidAmountVnd: bigint;
  warrantyDays: number;
  usedDays: number;
  remainingDays: number;
  recommendedVnd: bigint;
  accountNumber: string | null;
}): PresentedMessage {
  return {
    text: [
      "💸 XÁC NHẬN HOÀN TIỀN",
      "",
      `Mã: ${input.claimNumber}`,
      `Giá trị đơn: ${vnd(input.paidAmountVnd)}`,
      `Bảo hành: ${input.warrantyDays} ngày`,
      `Ngày đã dùng: ${input.usedDays}`,
      `Ngày còn lại: ${input.remainingDays}`,
      `Hệ thống tính: ${vnd(input.recommendedVnd)}`,
      "",
      input.accountNumber
        ? "Shop chuyển khoản thủ công sau khi duyệt."
        : "Khách chưa cung cấp thông tin nhận tiền — hãy yêu cầu trước khi chuyển.",
    ].join("\n"),
    buttons: [
      [
        {
          text: `✅ Duyệt ${vnd(input.recommendedVnd)}`,
          callbackData: `admin:warranty:refund-confirm:${input.claimId}`,
        },
      ],
      [{ text: "✏️ Điều chỉnh", callbackData: `admin:warranty:refund-adjust:${input.claimId}` }],
      [{ text: "⬅️ Quay lại", callbackData: `admin:warranty:claim:${input.claimId}` }],
    ],
  };
}

export function presentAdminRefundAdjustPrompt(input: {
  claimId: string;
  recommendedVnd: bigint;
}): PresentedMessage {
  return {
    text: [
      "✏️ ĐIỀU CHỈNH SỐ TIỀN HOÀN",
      "",
      `Hệ thống đề xuất: ${vnd(input.recommendedVnd)}`,
      "",
      "Gửi số tiền bạn duyệt (VND) kèm lý do, cách nhau bởi dấu |",
      "Ví dụ: 40000 | Khách đã dùng thêm 2 ngày",
      "",
      "Số tiền đề xuất và số tiền bạn duyệt đều được ghi nhật ký.",
    ].join("\n"),
    buttons: [[{ text: "⬅️ Quay lại", callbackData: `admin:warranty:refund:${input.claimId}` }]],
  };
}

/** Goal §32: the manual payout screen. The system never transfers. */
export function presentAdminRefundPayout(input: {
  claimId: string;
  claimNumber: string;
  customerLabel: string;
  productName: string;
  amountVnd: bigint;
  reason: string;
  bankName: string | null;
  accountNumber: string | null;
  accountHolder: string | null;
}): PresentedMessage {
  return {
    text: [
      `💸 HOÀN TIỀN ${input.claimNumber}`,
      "",
      `Khách: ${input.customerLabel}`,
      `Sản phẩm: ${input.productName}`,
      `Số tiền: ${vnd(input.amountVnd)}`,
      `Lý do: ${input.reason}`,
      "",
      "Thông tin nhận tiền:",
      `Ngân hàng: ${input.bankName ?? "—"}`,
      `Số tài khoản: ${input.accountNumber ?? "—"}`,
      `Chủ tài khoản: ${input.accountHolder ?? "—"}`,
      "",
      "Shop tự thực hiện chuyển khoản, sau đó xác nhận tại đây.",
    ].join("\n"),
    buttons: [
      ...(input.accountNumber
        ? [
            [
              {
                text: "📋 Copy số tài khoản",
                callbackData: `admin:warranty:copy:acct:${input.claimId}`,
              },
            ],
          ]
        : []),
      [{ text: "📋 Copy số tiền", callbackData: `admin:warranty:copy:amount:${input.claimId}` }],
      [{ text: "✅ Tôi đã chuyển tiền", callbackData: `admin:warranty:paid:${input.claimId}` }],
      [{ text: "⬅️ Quay lại", callbackData: `admin:warranty:claim:${input.claimId}` }],
    ],
  };
}

/** Goal §33: confirm only after the transfer really happened. */
export function presentAdminRefundPaidConfirm(input: {
  claimId: string;
  claimNumber: string;
  amountVnd: bigint;
}): PresentedMessage {
  return {
    text: [
      "⚠️ XÁC NHẬN ĐÃ CHUYỂN TIỀN",
      "",
      `${input.claimNumber} · ${vnd(input.amountVnd)}`,
      "",
      "Chỉ xác nhận sau khi bạn thực sự đã chuyển khoản.",
      "Hệ thống không tự chuyển tiền và không kiểm tra được giao dịch ngân hàng.",
    ].join("\n"),
    buttons: [
      [
        {
          text: "✅ XÁC NHẬN ĐÃ HOÀN",
          callbackData: `admin:warranty:paid-confirm:${input.claimId}`,
        },
      ],
      [{ text: "❌ Chưa", callbackData: `admin:warranty:payout:${input.claimId}` }],
    ],
  };
}

/** Goal §31: the refund queue, oldest first. */
export function presentAdminRefundQueue(rows: WarrantyQueueRow[]): PresentedMessage {
  return {
    text: [
      "💸 CHỜ HOÀN TIỀN",
      "",
      `Cần chuyển: ${rows.length} yêu cầu`,
      ...(rows.length === 0
        ? ["Hiện không có yêu cầu nào chờ hoàn tiền."]
        : rows.map(
            (row) =>
              `• ${row.claimNumber} · ${row.customerLabel} · ${row.productName}${
                row.amountVnd === null ? "" : ` · ${vnd(row.amountVnd)}`
              }`,
          )),
      "",
      "Shop chuyển khoản thủ công cho từng yêu cầu; không có lệnh chi tự động.",
    ].join("\n"),
    buttons: [
      ...rows.map((row) => [
        {
          text: `💸 Xử lý ${row.claimNumber}`,
          callbackData: `admin:warranty:payout:${row.claimId}`,
        },
      ]),
      [
        { text: "🛡 Bảo hành", callbackData: "admin:warranty" },
        { text: "🏠 Quản trị", callbackData: "admin:menu" },
      ],
    ],
  };
}

/** Goal §19: dangerous answers get their own confirmation, and a reason the customer can read. */
export const WARRANTY_REJECT_REASONS = [
  "Ngoài phạm vi bảo hành",
  "Khách tự thay đổi thông tin đăng nhập",
  "Không tái hiện được lỗi",
  "Đã quá thời hạn bảo hành",
] as const;

export function presentAdminWarrantyRejectReason(input: {
  claimId: string;
  claimNumber: string;
}): PresentedMessage {
  return {
    text: [
      "❌ TỪ CHỐI BẢO HÀNH",
      "",
      `Mã: ${input.claimNumber}`,
      "Chọn lý do — khách sẽ đọc đúng câu này.",
    ].join("\n"),
    buttons: [
      ...WARRANTY_REJECT_REASONS.map((reason) => [
        {
          text: reason,
          callbackData: `admin:warranty:reject-confirm:${input.claimId}:${encodeURIComponent(reason)}`,
        },
      ]),
      [{ text: "⬅️ Quay lại", callbackData: `admin:warranty:claim:${input.claimId}` }],
    ],
  };
}

export function presentAdminWarrantyActionDone(input: {
  claimNumber: string;
  claimId: string;
  message: string;
}): PresentedMessage {
  return {
    text: [`✅ ${input.message}`, "", `Mã: ${input.claimNumber}`].join("\n"),
    buttons: [
      [{ text: "🛡 Xem yêu cầu", callbackData: `admin:warranty:claim:${input.claimId}` }],
      [{ text: "🛡 Danh sách bảo hành", callbackData: "admin:warranty" }],
      [{ text: "🏠 Quản trị", callbackData: "admin:menu" }],
    ],
  };
}
