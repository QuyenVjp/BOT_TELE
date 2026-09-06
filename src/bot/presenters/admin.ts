import type { InlineButton, PresentedMessage } from "./catalog.js";
import type { AuditEvent } from "../../modules/identity/audit.js";

/**
 * Owner-safe Vietnamese admin presenters (T098, FR-021–FR-023).
 *
 * Surfaces for the sole owner: authorization denials, kill-switch confirmation,
 * high-risk confirmation challenge, and a redacted audit list. No presenter ever
 * invites an add-admin action or exposes a raw secret.
 */

export const ADMIN_COPY = {
  deniedTitle: "⛔ Không được phép",
  deniedBody: "Hành động quản trị chỉ dành cho chủ sở hữu trong chat riêng.",
  killSwitchDone: "✅ Đã cập nhật trạng thái bán hàng",
  confirmTitle: "⚠️ Xác nhận hành động rủi ro cao",
  confirmBody:
    "Hành động này cần xác nhận. Nhập (hoặc dán) mã xác nhận trong thời hạn, kèm lý do đã nêu.",
  confirmOk: "✅ Đã thực hiện hành động",
  confirmFail: "❌ Xác nhận thất bại hoặc đã hết hạn",
  auditTitle: "📜 Nhật ký kiểm toán",
  auditEmpty: "Chưa có sự kiện kiểm toán cho mục này.",
  unknownCommand: "Lệnh không được hỗ trợ.",
  mainMenu: "Menu chính",
  adminMenu: "⚙️ BẢNG ĐIỀU HÀNH QUẢN TRỊ",
  back: "↩️ Quay lại",
  home: "⌂ Trang quản trị",
  overview: "📊 Tổng quan",
  products: "🛍 Sản phẩm",
  inventory: "📦 Kho hàng",
  orders: "🧾 Đơn hàng",
  payments: "💳 Thanh toán",
  suppliers: "🚚 Nhà cung cấp",
  marketing: "📣 Tiếp thị",
  support: "💬 Hỗ trợ",
  operations: "🛠 Vận hành",
  testing: "🧪 Kiểm thử",
  audit: "📜 Nhật ký",
} as const;

export interface AdminNavItem {
  id: string;
  label: string;
  callbackData: string;
  enabled: boolean;
}

export const ADMIN_NAV_ITEMS: AdminNavItem[] = [
  { id: "products", label: ADMIN_COPY.products, callbackData: "admin:products", enabled: true },
  { id: "inventory", label: ADMIN_COPY.inventory, callbackData: "admin:inventory", enabled: true },
  { id: "orders", label: ADMIN_COPY.orders, callbackData: "admin:orders", enabled: true },
  { id: "payments", label: ADMIN_COPY.payments, callbackData: "admin:payments", enabled: true },
  { id: "suppliers", label: ADMIN_COPY.suppliers, callbackData: "admin:suppliers", enabled: true },
  { id: "support", label: ADMIN_COPY.support, callbackData: "admin:support", enabled: true },
  { id: "dashboard", label: ADMIN_COPY.overview, callbackData: "admin:dashboard", enabled: false },
  { id: "marketing", label: ADMIN_COPY.marketing, callbackData: "admin:marketing", enabled: true },
  { id: "operations", label: ADMIN_COPY.operations, callbackData: "admin:operations", enabled: false },
  { id: "testing", label: ADMIN_COPY.testing, callbackData: "admin:testing", enabled: false },
  { id: "audit", label: ADMIN_COPY.audit, callbackData: "admin:audit", enabled: false },
] as const;

export const ADMIN_VISIBLE_ROUTE_KEYS = ADMIN_NAV_ITEMS.filter((item) => item.enabled).map((item) => item.id) as Array<"products" | "inventory" | "orders" | "payments" | "suppliers" | "support" | "marketing">;

const adminNav = (back: string): InlineButton[] => [
  { text: ADMIN_COPY.back, callbackData: back },
  { text: ADMIN_COPY.home, callbackData: "admin:menu" },
];

const visibleAdminButtons = (): InlineButton[][] =>
  ADMIN_NAV_ITEMS.filter((item) => item.enabled).reduce<InlineButton[][]>((rows, item, index) => {
    const current = rows.at(-1);
    if (!current || current.length === 2 || (index === 0 && current.length === 0)) {
      rows.push([{ text: item.label, callbackData: item.callbackData }]);
      return rows;
    }
    current.push({ text: item.label, callbackData: item.callbackData });
    return rows;
  }, []);

/** Compact root: only live operational areas are shown. */
export function presentAdminMenu(): PresentedMessage {
  return {
    text: ADMIN_COPY.adminMenu,
    buttons: visibleAdminButtons(),
  };
}

function presentAdminSection(
  title: string,
  body: string,
  buttons: InlineButton[][] = [],
): PresentedMessage {
  return { text: `${title}\n${body}`, buttons: [...buttons, adminNav("admin:menu")] };
}

export function presentAdminProductsMenu(): PresentedMessage {
  return presentAdminSection(ADMIN_COPY.products, "Quản lý sản phẩm và danh mục.");
}
export function presentAdminInventoryMenu(): PresentedMessage {
  return presentAdminSection(ADMIN_COPY.inventory, "Theo dõi và nhập dữ liệu tồn kho.");
}
export function presentAdminOrdersMenu(): PresentedMessage {
  return presentAdminSection(ADMIN_COPY.orders, "Theo dõi đơn hàng và giao hàng.");
}
export function presentAdminPaymentsMenu(): PresentedMessage {
  return presentAdminSection(ADMIN_COPY.payments, "Theo dõi thanh toán và đối soát.");
}
export function presentAdminSuppliersMenu(): PresentedMessage {
  return presentAdminSection(ADMIN_COPY.suppliers, "Quản lý nhà cung cấp và nhập hàng.");
}
export function presentAdminSupportMenu(): PresentedMessage {
  return presentAdminSection(ADMIN_COPY.support, "Xử lý yêu cầu hỗ trợ và sự cố.");
}

export type AdminBroadcastAudience = "all" | "shop" | "activity" | "root";

const audienceLabel = (audience: AdminBroadcastAudience): string =>
  audience === "all" ? "Tất cả khách nhận Telegram" : audience === "shop" ? "Khách bật cập nhật sản phẩm" : audience === "activity" ? "Khách bật hoạt động mua hàng" : "Chỉ chủ cửa hàng";

export function presentAdminMarketingMenu(): PresentedMessage {
  return presentAdminSection(ADMIN_COPY.marketing, "Gửi thông báo marketing cho nhóm khách đã chọn.", [
    [{ text: "📝 Soạn thông báo", callbackData: "admin:marketing:compose" }],
  ]);
}

export function presentAdminBroadcastAudience(): PresentedMessage {
  return {
    text: "Chọn nhóm nhận thông báo.",
    buttons: [
      [{ text: "Tất cả", callbackData: "admin:marketing:audience:all" }],
      [{ text: "🛍 Cập nhật sản phẩm", callbackData: "admin:marketing:audience:shop" }],
      [{ text: "📣 Hoạt động mua hàng", callbackData: "admin:marketing:audience:activity" }],
      [{ text: "🔒 Gửi thử cho chủ", callbackData: "admin:marketing:audience:root" }],
      adminNav("admin:marketing"),
    ],
  };
}

export function presentAdminBroadcastPrompt(audience: AdminBroadcastAudience): PresentedMessage {
  return {
    text: [`Soạn nội dung thông báo.`, `Nhóm nhận: ${audienceLabel(audience)}`, "", "Gửi nội dung bằng tin nhắn tiếp theo."].join("\n"),
    buttons: [[{ text: "Huỷ", callbackData: "admin:marketing:cancel" }]],
  };
}

export function presentAdminBroadcastPreview(input: { campaignId: string; audience: AdminBroadcastAudience; count: number; content: string }): PresentedMessage {
  return {
    text: ["📣 Xem trước thông báo", `Nhóm nhận: ${audienceLabel(input.audience)}`, `Số khách sẽ nhận: ${input.count}`, "", input.content].join("\n"),
    buttons: [
      [{ text: "✅ Xác nhận gửi", callbackData: `admin:marketing:confirm:${input.campaignId}` }],
      [{ text: "Huỷ", callbackData: `admin:marketing:cancel:${input.campaignId}` }],
    ],
  };
}

export function presentAdminBroadcastStatus(input: { campaignId: string; status: string; audience: AdminBroadcastAudience; total: number; pending: number; retry: number; sent: number; suppressed: number; dead: number }): PresentedMessage {
  return {
    text: ["📣 Trạng thái thông báo", `ID: ${input.campaignId}`, `Trạng thái: ${input.status}`, `Nhóm nhận: ${audienceLabel(input.audience)}`, `Tổng: ${input.total}`, `Đang chờ: ${input.pending}`, `Gửi lại: ${input.retry}`, `Đã gửi: ${input.sent}`, `Đã dừng/huỷ: ${input.suppressed}`, `Lỗi chết: ${input.dead}`, "", "Dừng chỉ chặn phần chưa bắt đầu gửi. Tin đang gửi tới Telegram vẫn có thể đến người nhận."].join("\n"),
    buttons: [
      [{ text: "Làm mới", callbackData: `admin:marketing:status:${input.campaignId}` }],
      [{ text: "Dừng phần chưa gửi", callbackData: `admin:marketing:cancel:${input.campaignId}` }],
      adminNav("admin:marketing"),
    ],
  };
}

export function presentProductCategoryChoices(
  categories: Array<{ id: string; name: string }>,
): PresentedMessage {
  return {
    text: "Bước 3/6 — Chọn danh mục.",
    buttons: categories
      .slice(0, 20)
      .map((category) => [
        { text: category.name, callbackData: `admin:products:category:${category.id}` },
      ]),
  };
}

export function presentProductDraftPreview(draft: {
  name: string;
  sku: string;
  categoryId: string;
  priceVnd: bigint;
  description: string;
  lowStockThreshold: number;
}): PresentedMessage {
  return {
    text: [
      "Xem trước sản phẩm",
      `Tên: ${draft.name}`,
      `SKU: ${draft.sku}`,
      `Danh mục: ${draft.categoryId}`,
      `Giá: ${draft.priceVnd.toLocaleString("vi-VN")} ₫`,
      `Mô tả: ${draft.description}`,
      `Ngưỡng tồn: ${draft.lowStockThreshold}`,
    ].join("\n"),
    buttons: [
      [{ text: "✅ Tạo sản phẩm", callbackData: "admin:products:confirm" }],
      [{ text: "❌ Huỷ", callbackData: "admin:products" }],
    ],
  };
}

export interface AdminDashboardSummary {
  activeProducts: number;
  outOfStock: number;
  lowStock: number;
  availableInventory: number;
  ordersToday: number;
  paidToday: number;
  revenueTodayVnd: bigint;
  pendingPayment: number;
  paymentReview: number;
  fulfillmentFailures: number;
}

export function presentAdminDashboard(data: AdminDashboardSummary): PresentedMessage {
  return {
    text: [
      ADMIN_COPY.overview,
      `📦 Sản phẩm đang bán: ${data.activeProducts}`,
      `❌ Hết hàng: ${data.outOfStock}`,
      `⚠️ Sắp hết: ${data.lowStock}`,
      `📚 Kho khả dụng: ${data.availableInventory}`,
      `🧾 Đơn hôm nay: ${data.ordersToday}`,
      `✅ Đã thanh toán hôm nay: ${data.paidToday}`,
      `💰 Doanh thu hôm nay: ${data.revenueTodayVnd.toLocaleString("vi-VN")} ₫`,
      `⏳ Chờ thanh toán: ${data.pendingPayment}`,
      `⚠️ Cần xem thanh toán: ${data.paymentReview}`,
      `🚨 Lỗi giao hàng: ${data.fulfillmentFailures}`,
    ].join("\n"),
    buttons: [
      [
        { text: ADMIN_COPY.products, callbackData: "admin:products" },
        { text: ADMIN_COPY.inventory, callbackData: "admin:inventory" },
      ],
      [{ text: ADMIN_COPY.home, callbackData: "admin:menu" }],
    ],
  };
}

export function presentAdminProducts(
  rows: Array<{ id: string; name: string; active: boolean }>,
): PresentedMessage {
  const lines = [
    ADMIN_COPY.products,
    ...rows.slice(0, 20).map((row) => `• ${row.name} (${row.active ? "đang bán" : "tạm dừng"})`),
  ];
  const rowButtons = rows.slice(0, 20).map((row) => [
    {
      text: `${row.name} (${row.active ? "đang bán" : "tạm dừng"})`,
      callbackData: `admin:products:detail:${row.id}`,
    },
  ]);
  return {
    text: lines.join("\n"),
    buttons: [
      [
        { text: ADMIN_COPY.overview, callbackData: "admin:dashboard" },
        { text: ADMIN_COPY.inventory, callbackData: "admin:inventory" },
      ],
      ...rowButtons,
      adminNav("admin:menu"),
    ],
  };
}

export function presentAdminProductDetail(input: {
  id: string;
  name: string;
  slug: string;
  categoryName: string;
  description: string | null;
  active: boolean;
  variantCount: number;
  minPriceVnd: bigint;
}): PresentedMessage {
  return {
    text: [
      ADMIN_COPY.products,
      `Mã: ${input.id}`,
      `Tên: ${input.name}`,
      `Slug: ${input.slug}`,
      `Danh mục: ${input.categoryName}`,
      `Trạng thái: ${input.active ? "đang bán" : "tạm dừng"}`,
      `Biến thể: ${input.variantCount}`,
      `Giá thấp nhất: ${input.minPriceVnd.toLocaleString("vi-VN")} ₫`,
      ...(input.description ? ["", input.description] : []),
    ].join("\n"),
    buttons: [[{ text: ADMIN_COPY.back, callbackData: "admin:products" }], adminNav("admin:menu")],
  };
}

export function presentAdminInventory(count: number): PresentedMessage {
  return {
    text: [
      ADMIN_COPY.inventory,
      `Tồn kho: ${count}`,
      "Nhập kho bằng dữ liệu CSV ở bước riêng; thông tin đăng nhập không hiển thị.",
    ].join("\n"),
    buttons: [
      [{ text: "Xem trước nhập kho", callbackData: "admin:inventory:import" }],
      [
        { text: ADMIN_COPY.overview, callbackData: "admin:dashboard" },
        { text: ADMIN_COPY.home, callbackData: "admin:menu" },
      ],
    ],
  };
}

export interface InventoryImportPreview {
  ready: number;
  invalid: number;
  duplicates: number;
  variants: string[];
}

export function presentInventoryImportPrompt(): PresentedMessage {
  return {
    text: [
      "📦 Nhập kho từ CSV",
      "Dán nội dung `variantId,credential` vào chat.",
      "Mỗi dòng một tài khoản; bấm /cancel để huỷ.",
    ].join("\n"),
    buttons: [[{ text: "↩️ Huỷ nhập kho", callbackData: "admin:inventory:cancel" }], [{ text: ADMIN_COPY.adminMenu, callbackData: "admin:menu" }]],
  };
}

/** Parse metadata for confirmation; credentials never enter the returned value. */
export function previewInventoryImport(input: string): InventoryImportPreview {
  const variants: string[] = [];
  let invalid = 0;
  for (const line of input.split(/\r?\n/).filter((line) => line.trim())) {
    const comma = line.indexOf(",");
    const variant = comma < 0 ? "" : line.slice(0, comma).trim();
    const credential = comma < 0 ? "" : line.slice(comma + 1).trim();
    if (
      !/^[A-Za-z0-9_-]{1,128}$/.test(variant) ||
      credential.length === 0 ||
      credential.length > 4096
    ) {
      invalid += 1;
    } else {
      variants.push(variant);
    }
  }
  const uniqueVariants = [...new Set(variants)];
  return { ready: uniqueVariants.length, invalid, duplicates: variants.length - uniqueVariants.length, variants: uniqueVariants };
}

export function presentInventoryImportPreview(preview: InventoryImportPreview): PresentedMessage {
  return {
    text: [
      "📦 Xem trước nhập kho",
      `Dòng hợp lệ: ${preview.ready}`,
      `Dòng không hợp lệ: ${preview.invalid}`,
      `Dòng trùng: ${preview.duplicates}`,
      `Biến thể: ${preview.variants.join(", ") || "—"}`,
      "",
      "Thông tin đăng nhập không được hiển thị.",
    ].join("\n"),
    buttons: [
      [{ text: "✅ Xác nhận nhập", callbackData: "admin:inventory:confirm" }],
      [{ text: "↩️ Huỷ nhập kho", callbackData: "admin:inventory:cancel" }],
      [{ text: ADMIN_COPY.adminMenu, callbackData: "admin:menu" }],
    ],
  };
}

export function presentAdminDenied(reason: "NOT_ROOT_ADMIN" | "WRONG_CONTEXT"): PresentedMessage {
  const hint =
    reason === "WRONG_CONTEXT"
      ? "Chỉ dùng trong chat riêng với bot."
      : "Tài khoản này không phải chủ sở hữu.";
  return {
    text: [ADMIN_COPY.deniedTitle, "", ADMIN_COPY.deniedBody, hint].join("\n"),
    buttons: [[{ text: ADMIN_COPY.mainMenu, callbackData: "menu:main" }]],
  };
}

export function presentKillSwitchDone(input: {
  command: "catalog.activate" | "catalog.deactivate";
  targetId: string;
}): PresentedMessage {
  const verb = input.command === "catalog.activate" ? "bật bán" : "tạm dừng bán";
  return {
    text: [
      ADMIN_COPY.killSwitchDone,
      "",
      `Hành động: ${verb}`,
      `Mã biến thể: ${input.targetId}`,
    ].join("\n"),
    buttons: [[{ text: ADMIN_COPY.mainMenu, callbackData: "menu:main" }]],
  };
}

export function presentHighRiskChallenge(input: {
  confirmationId: string;
  challenge: string;
  expiresAt: string;
  action: string;
}): PresentedMessage {
  return {
    text: [
      ADMIN_COPY.confirmTitle,
      "",
      ADMIN_COPY.confirmBody,
      `Hành động: ${input.action}`,
      `Mã xác nhận: ${input.challenge}`,
      `Hết hạn: ${input.expiresAt}`,
      `ID: ${input.confirmationId}`,
    ].join("\n"),
    buttons: [[{ text: ADMIN_COPY.mainMenu, callbackData: "menu:main" }]],
  };
}

export function presentHighRiskDone(action: string): PresentedMessage {
  return {
    text: [ADMIN_COPY.confirmOk, "", `Hành động: ${action}`].join("\n"),
    buttons: [[{ text: ADMIN_COPY.mainMenu, callbackData: "menu:main" }]],
  };
}

export function presentAuditList(events: AuditEvent[]): PresentedMessage {
  if (events.length === 0) {
    return {
      text: [ADMIN_COPY.auditTitle, "", ADMIN_COPY.auditEmpty].join("\n"),
      buttons: [[{ text: ADMIN_COPY.mainMenu, callbackData: "menu:main" }]],
    };
  }
  const lines: string[] = [ADMIN_COPY.auditTitle, ""];
  for (const e of events.slice(0, 10)) {
    lines.push(`• ${e.occurredAt} — ${e.action}`);
    lines.push(`  lý do: ${e.reason}`);
  }
  const buttons: InlineButton[][] = [[{ text: ADMIN_COPY.mainMenu, callbackData: "menu:main" }]];
  return { text: lines.join("\n"), buttons };
}
