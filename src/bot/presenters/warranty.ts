/**
 * Warranty screens (goal: warranty / defect report / prorated refund).
 *
 * Copy rules that the tests and the live E2E hold us to:
 *  * a refund is only ever an ESTIMATE until an admin verifies the defect — the wording says
 *    "hoàn dự kiến nếu lỗi được xác nhận thuộc phạm vi bảo hành";
 *  * the customer never learns an internal state, an asset id or a credential here;
 *  * money that has not moved is never described as moved.
 */
import type { PresentedMessage } from "./catalog.js";
import { ISSUE_TYPE_LABELS, type WarrantyIssueType } from "../../modules/warranty/claims.js";

/** Canonical warranty block for a product screen (goal §5/§62). */
export const WARRANTY_BLOCK_LINES = [
  "🛡 Bảo hành",
  "Bảo hành theo thời gian sử dụng.",
  "Nếu tài khoản bị khóa hoặc mất gói do lỗi thuộc phạm vi bảo hành, shop hoàn phần tiền tương ứng với số ngày chưa sử dụng.",
];

const vnd = (value: bigint) => `${value.toLocaleString("vi-VN")} ₫`;

function day(value: string | number): string {
  const date = typeof value === "string" ? new Date(value) : new Date(value);
  return date.toLocaleDateString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" });
}

/** Goal §6: the policy screen behind "Xem chính sách bảo hành". */
export function presentWarrantyPolicy(input: {
  productName: string;
  warrantyDays: number;
  coverageVi: string | null;
  exclusionsVi: string | null;
  examplePriceVnd: bigint | null;
  variantId: string;
  /** Where "Quay lại" goes: the product screen the customer came from. */
  productId: string;
}): PresentedMessage {
  const lines = [
    "🛡 Chính sách bảo hành",
    "",
    `Sản phẩm: ${input.productName}`,
    `Thời gian: ${input.warrantyDays} ngày kể từ khi giao hàng thành công`,
    "",
    "Phạm vi:",
    input.coverageVi ?? "Lỗi thuộc trách nhiệm của shop trong thời gian bảo hành.",
    "",
    "Cách tính hoàn tiền:",
    "Tiền đã thanh toán × số ngày còn lại / tổng số ngày bảo hành",
  ];
  if (input.examplePriceVnd && input.examplePriceVnd > 0n) {
    lines.push(
      "",
      "Ví dụ:",
      `${vnd(input.examplePriceVnd)} / ${input.warrantyDays} ngày`,
      "→ hoàn dự kiến theo số ngày còn lại khi bạn báo lỗi.",
    );
  }
  if (input.exclusionsVi) {
    lines.push("", "Không thuộc bảo hành:", input.exclusionsVi);
  }
  lines.push("", "Hoàn dự kiến nếu lỗi được xác nhận thuộc phạm vi bảo hành.");
  return {
    text: lines.join("\n"),
    buttons: [
      [{ text: "🛡 Báo lỗi / Bảo hành", callbackData: `warranty:report:${input.variantId}` }],
      [
        { text: "⬅️ Quay lại", callbackData: `shop:product:${input.productId}` },
        { text: "🏠 Trang chủ", callbackData: "shop:home" },
      ],
    ],
  };
}

/** Goal §7: the warranty state of a fulfilled order. */
export function presentWarrantyOrderBlock(input: {
  orderNumber: string;
  variantId: string;
  warrantyEnd: string;
  usedDays: number;
  remainingDays: number;
  expired: boolean;
}): PresentedMessage {
  if (input.expired) {
    return {
      text: [
        "⌛ Sản phẩm đã hết thời hạn bảo hành",
        "",
        `Đơn: ${input.orderNumber}`,
        `Bảo hành đến: ${day(input.warrantyEnd)}`,
        "",
        "Yêu cầu bảo hành sau thời hạn này không thuộc phạm vi bảo hành.",
      ].join("\n"),
      buttons: [
        [
          { text: "💬 Liên hệ hỗ trợ", callbackData: "sup:open" },
          { text: "🏠 Trang chủ", callbackData: "shop:home" },
        ],
      ],
    };
  }
  return {
    text: [
      "🛡 Bảo hành",
      "",
      `Đơn: ${input.orderNumber}`,
      `Bảo hành đến: ${day(input.warrantyEnd)}`,
      `Đã sử dụng: ${input.usedDays} ngày`,
      `Còn bảo hành: ${input.remainingDays} ngày`,
      "",
      "Nếu tài khoản bị khóa hoặc mất gói do lỗi thuộc phạm vi bảo hành, shop hoàn phần tiền tương ứng với số ngày chưa sử dụng.",
    ].join("\n"),
    buttons: [
      [{ text: "🛡 Báo lỗi / Bảo hành", callbackData: `warranty:report:${input.variantId}` }],
      [
        { text: "💬 Hỗ trợ", callbackData: "sup:open" },
        { text: "🏠 Trang chủ", callbackData: "shop:home" },
      ],
    ],
  };
}

/** Goal §8: human issue types — the customer never sees or needs an asset id. */
export function presentWarrantyIssueTypes(input: {
  orderNumber: string;
  /** Carried into every choice: the preview resolves the order through it. */
  variantId: string;
}): PresentedMessage {
  const types = Object.keys(ISSUE_TYPE_LABELS) as WarrantyIssueType[];
  return {
    text: [
      "🛡 Báo lỗi / bảo hành",
      "",
      `Đơn: ${input.orderNumber}`,
      "Chọn tình trạng bạn gặp phải:",
      "",
      "Không gửi mật khẩu của bạn cho shop.",
    ].join("\n"),
    buttons: [
      ...types.map((type) => [
        {
          text: ISSUE_TYPE_LABELS[type],
          callbackData: `warranty:type:${type}:${input.variantId}`,
        },
      ]),
      [{ text: "❌ Huỷ", callbackData: "ord:list" }],
    ],
  };
}

/** Goal §41: confirm before submitting, with the estimate clearly conditional. */
export function presentWarrantyReportPreview(input: {
  productName: string;
  orderNumber: string;
  issueType: WarrantyIssueType;
  note: string | null;
  warrantyEnd: string;
  remainingDays: number;
  estimatedRefundVnd: bigint;
  /** Carried into the submit callback, so the claim is opened for the order the preview showed. */
  variantId: string;
}): PresentedMessage {
  return {
    text: [
      "🛡 Xác nhận yêu cầu bảo hành",
      "",
      `Sản phẩm: ${input.productName}`,
      `Đơn: ${input.orderNumber}`,
      `Lỗi: ${ISSUE_TYPE_LABELS[input.issueType]}`,
      ...(input.note ? [`Mô tả: ${input.note}`] : []),
      "",
      `Bảo hành đến: ${day(input.warrantyEnd)}`,
      `Còn: ${input.remainingDays} ngày`,
      "",
      "Nếu lỗi được xác nhận thuộc phạm vi bảo hành,",
      `số tiền hoàn dự kiến: ${vnd(input.estimatedRefundVnd)}`,
      "",
      "Shop sẽ kiểm tra tài khoản đã giao trước khi quyết định.",
    ].join("\n"),
    buttons: [
      [
        {
          text: "✅ Gửi yêu cầu",
          callbackData: `warranty:submit:${input.variantId}:${input.issueType}`,
        },
      ],
      [{ text: "✏️ Sửa nội dung", callbackData: `warranty:report:${input.variantId}` }],
      [{ text: "❌ Huỷ", callbackData: "shop:home" }],
    ],
  };
}

export function presentWarrantyClaimSubmitted(input: {
  claimNumber: string;
  estimatedRefundVnd: bigint;
  remainingDays: number;
}): PresentedMessage {
  return {
    text: [
      "✅ Đã gửi yêu cầu bảo hành",
      "",
      `Mã: ${input.claimNumber}`,
      `Còn bảo hành: ${input.remainingDays} ngày`,
      `Hoàn dự kiến: ${vnd(input.estimatedRefundVnd)}`,
      "",
      "Shop đang kiểm tra. Bạn sẽ nhận thông báo khi có kết quả.",
    ].join("\n"),
    buttons: [
      [{ text: "🧾 Xem yêu cầu", callbackData: `warranty:claim:${input.claimNumber}` }],
      [
        { text: "💬 Hỗ trợ", callbackData: "sup:open" },
        { text: "🏠 Trang chủ", callbackData: "shop:home" },
      ],
    ],
  };
}

/** Goal §43: a customer-safe timeline — no internal state names, no ids. */
const TIMELINE_COPY: Record<string, string> = {
  SUBMITTED: "Đã gửi yêu cầu",
  WAITING_CUSTOMER: "Shop đang chờ bạn bổ sung thông tin",
  VERIFIED_DEFECT: "Đã xác nhận thuộc bảo hành",
  REPLACEMENT_APPROVED: "Đã duyệt đổi tài khoản",
  REFUND_DUE: "Hoàn tiền đang chờ shop chuyển khoản",
  REFUND_PAID: "Shop xác nhận đã chuyển tiền",
  REJECTED: "Yêu cầu chưa đủ điều kiện bảo hành",
};

export function presentWarrantyClaim(input: {
  claimNumber: string;
  productName: string;
  status: string;
  estimatedRefundVnd: bigint;
  approvedRefundVnd: bigint | null;
  remainingDays: number;
  timeline: Array<{ kind: string; safeNote: string | null; createdAt: string }>;
}): PresentedMessage {
  const when = (iso: string) =>
    new Date(iso).toLocaleString("vi-VN", {
      timeZone: "Asia/Ho_Chi_Minh",
      day: "2-digit",
      month: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  const amount = input.approvedRefundVnd ?? input.estimatedRefundVnd;
  return {
    text: [
      `🛡 Yêu cầu ${input.claimNumber}`,
      "",
      `Sản phẩm: ${input.productName}`,
      `Còn bảo hành: ${input.remainingDays} ngày`,
      `Số tiền: ${vnd(amount)}${input.approvedRefundVnd === null ? " (dự kiến)" : ""}`,
      "",
      "Diễn biến:",
      ...input.timeline.map(
        (event) =>
          `• ${when(event.createdAt)} — ${TIMELINE_COPY[event.kind] ?? "Cập nhật"}${event.safeNote ? `: ${event.safeNote}` : ""}`,
      ),
    ].join("\n"),
    buttons: [
      [
        {
          text: "💳 Cập nhật thông tin nhận tiền",
          callbackData: `warranty:payout:${input.claimNumber}`,
        },
      ],
      [
        { text: "💬 Hỗ trợ", callbackData: "sup:open" },
        { text: "🏠 Trang chủ", callbackData: "shop:home" },
      ],
    ],
  };
}

export function presentWarrantyExpired(input: { warrantyEnd: string }): PresentedMessage {
  return {
    text: [
      "⌛ Sản phẩm đã hết thời hạn bảo hành",
      "",
      `Bảo hành đến: ${day(input.warrantyEnd)}`,
      "",
      "Yêu cầu gửi sau thời hạn này không thuộc phạm vi bảo hành.",
      "Bạn vẫn có thể liên hệ hỗ trợ để được xem xét riêng.",
    ].join("\n"),
    buttons: [
      [
        { text: "💬 Liên hệ hỗ trợ", callbackData: "sup:open" },
        { text: "🏠 Trang chủ", callbackData: "shop:home" },
      ],
    ],
  };
}

export function presentWarrantyNotCovered(): PresentedMessage {
  return {
    text: [
      "ℹ️ Sản phẩm này không thuộc phạm vi bảo hành theo thời gian.",
      "",
      "Bạn vẫn có thể liên hệ hỗ trợ nếu cần giúp đỡ.",
    ].join("\n"),
    buttons: [
      [
        { text: "💬 Hỗ trợ", callbackData: "sup:open" },
        { text: "🏠 Trang chủ", callbackData: "shop:home" },
      ],
    ],
  };
}
