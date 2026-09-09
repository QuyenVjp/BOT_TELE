import type { InlineButton, PresentedMessage } from "./catalog.js";
import {
  FULFILLMENT_TYPE_LABELS,
  type FulfillmentType,
  type InventoryField,
} from "../../modules/catalog/fulfillment-type.js";
import type { StoreMode } from "../../modules/commerce/store-mode.js";
import type { AuditEvent } from "../../modules/identity/audit.js";
import type {
  AdminOrderDetail,
  AdminOrderListPage,
  AdminOrderStatusFilter,
} from "../../modules/admin/order-operations.js";

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
  customers: "👥 Khách hàng",
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
  { id: "customers", label: ADMIN_COPY.customers, callbackData: "admin:customers", enabled: true },
  { id: "orders", label: ADMIN_COPY.orders, callbackData: "admin:orders", enabled: true },
  { id: "payments", label: ADMIN_COPY.payments, callbackData: "admin:payments", enabled: true },
  { id: "suppliers", label: ADMIN_COPY.suppliers, callbackData: "admin:suppliers", enabled: true },
  { id: "support", label: ADMIN_COPY.support, callbackData: "admin:support", enabled: true },
  { id: "dashboard", label: ADMIN_COPY.overview, callbackData: "admin:dashboard", enabled: false },
  { id: "marketing", label: ADMIN_COPY.marketing, callbackData: "admin:marketing", enabled: true },
  {
    id: "operations",
    label: ADMIN_COPY.operations,
    callbackData: "admin:operations",
    enabled: false,
  },
  { id: "testing", label: ADMIN_COPY.testing, callbackData: "admin:testing", enabled: false },
  { id: "audit", label: ADMIN_COPY.audit, callbackData: "admin:audit", enabled: false },
] as const;

export const ADMIN_VISIBLE_ROUTE_KEYS = ADMIN_NAV_ITEMS.filter((item) => item.enabled).map(
  (item) => item.id,
) as Array<
  | "products"
  | "inventory"
  | "orders"
  | "payments"
  | "suppliers"
  | "support"
  | "marketing"
  | "customers"
>;

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
export function presentAdminMenu(storeMode: StoreMode = "CLOSED"): PresentedMessage {
  const storeBanner =
    storeMode === "OPEN"
      ? "🟢 ĐANG MỞ BÁN"
      : storeMode === "TEST"
        ? "🟡 CHẾ ĐỘ TEST"
        : "🔴 CỬA HÀNG ĐANG ĐÓNG";
  const storeButton: InlineButton[] =
    storeMode === "CLOSED"
      ? [{ text: "🏪 Trạng thái cửa hàng", callbackData: "admin:store:mode" }]
      : [{ text: "🏪 Trạng thái cửa hàng", callbackData: "admin:store:mode" }];
  return {
    text: `${ADMIN_COPY.adminMenu}\n\n${storeBanner}`,
    buttons: [storeButton, ...visibleAdminButtons()],
  };
}

export function presentAdminStoreMode(mode: StoreMode): PresentedMessage {
  const buttons: InlineButton[][] = [];
  if (mode === "CLOSED")
    buttons.push([{ text: "🧪 Chế độ TEST", callbackData: "admin:store:test" }]);
  if (mode !== "OPEN") buttons.push([{ text: "🟢 Mở bán", callbackData: "admin:store:open" }]);
  if (mode !== "CLOSED")
    buttons.push([{ text: "🔴 Đóng cửa hàng", callbackData: "admin:store:close" }]);
  buttons.push([{ text: "⬅️ Quay lại", callbackData: "admin:menu" }]);
  return {
    text: `🏪 Trạng thái cửa hàng\n\n${mode === "OPEN" ? "🟢 ĐANG MỞ BÁN" : mode === "TEST" ? "🟡 CHẾ ĐỘ TEST" : "🔴 CỬA HÀNG ĐANG ĐÓNG"}`,
    buttons,
  };
}
export function presentAdminStoreOpenConfirmation(input: {
  activeProducts: number;
  inStockVariants: number;
}): PresentedMessage {
  return {
    text: `⚠️ XÁC NHẬN MỞ BÁN\n\nSản phẩm public đang hoạt động: ${input.activeProducts}\nBiến thể đang còn hàng: ${input.inStockVariants}`,
    buttons: [
      [{ text: "✅ MỞ BÁN", callbackData: "admin:store:open:confirm" }],
      [{ text: "❌ Huỷ", callbackData: "admin:store:mode" }],
    ],
  };
}
export function presentAdminTestCustomers(input: {
  customers: Array<{ id: string; telegramUserId: string }>;
}): PresentedMessage {
  return {
    text: `👥 KHÁCH TEST\n\n${input.customers.length ? input.customers.map((c) => `• ${c.telegramUserId.replace(/^(\d{2})\d+(\d{2})$/u, "$1••••$2")}`).join("\n") : "Chưa có khách test."}`,
    buttons: [
      [{ text: "➕ Thêm", callbackData: "admin:testlab:testers:add" }],
      ...input.customers.map((c) => [
        { text: "➖ Xoá", callbackData: `admin:testlab:testers:del:${c.id}` },
      ]),
      [{ text: "⬅️ Quay lại", callbackData: "admin:testlab" }],
    ],
  };
}
export function presentAdminTestCustomerPrompt(): PresentedMessage {
  return {
    text: "Nhập Telegram ID khách test (chỉ chữ số).",
    buttons: [[{ text: "⬅️ Quay lại", callbackData: "admin:testlab:testers" }]],
  };
}
export function presentAdminCategories(input: {
  categories: Array<{ id: string; nameVi: string; active: boolean; productCount: number }>;
}): PresentedMessage {
  return {
    text: `🏷 DANH MỤC\n\n${input.categories.length ? input.categories.map((c) => `• ${c.nameVi} · ${c.productCount} sản phẩm · ${c.active ? "đang bật" : "đang tắt"}`).join("\n") : "Chưa có danh mục."}`,
    buttons: [
      ...input.categories.flatMap((c) => [
        [
          { text: `✏️ ${c.nameVi}`, callbackData: `admin:categories:rename:${c.id}` },
          { text: "🔁 Bật/Tắt", callbackData: `admin:categories:toggle:${c.id}` },
        ],
        [
          { text: "⬆️", callbackData: `admin:categories:up:${c.id}` },
          { text: "⬇️", callbackData: `admin:categories:down:${c.id}` },
        ],
      ]),
      [{ text: "➕ Tạo danh mục", callbackData: "admin:categories:create" }],
      [{ text: "⬅️ Quay lại", callbackData: "admin:products" }],
    ],
  };
}
export function presentAdminCategoryPrompt(): PresentedMessage {
  return {
    text: "Nhập tên danh mục mới.",
    buttons: [[{ text: "⬅️ Quay lại", callbackData: "admin:categories" }]],
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
  return presentAdminSection(ADMIN_COPY.products, "Quản lý sản phẩm và danh mục.", [
    [{ text: "➕ Tạo sản phẩm", callbackData: "admin:products:create" }],
  ]);
}
export function presentAdminInventoryMenu(): PresentedMessage {
  return presentAdminSection(ADMIN_COPY.inventory, "Theo dõi và nhập dữ liệu tồn kho.");
}
export function presentAdminOrdersMenu(): PresentedMessage {
  return presentAdminSection(ADMIN_COPY.orders, "Theo dõi đơn hàng và giao hàng.", [
    [{ text: "Tất cả đơn", callbackData: "admin:orders:filter:all" }],
    [
      { text: "Chờ thanh toán", callbackData: "admin:orders:filter:pending_payment" },
      { text: "Cần soát tiền", callbackData: "admin:orders:filter:payment_review" },
    ],
    [
      { text: "Đang xử lý", callbackData: "admin:orders:filter:processing" },
      { text: "Cần giao hàng", callbackData: "admin:orders:filter:fulfillment_review" },
    ],
    [{ text: "🔎 Tìm đơn/khách", callbackData: "admin:orders:search" }],
    [{ text: "🛠 Xử lý thủ công", callbackData: "admin:manual" }],
  ]);
}
const ADMIN_ORDER_STATUS_LABELS: Record<AdminOrderStatusFilter, string> = {
  all: "Tất cả",
  pending_payment: "Chờ thanh toán",
  paid: "Đã thanh toán",
  processing: "Đang xử lý",
  completed: "Hoàn tất",
  payment_review: "Cần soát tiền",
  fulfillment_review: "Cần giao hàng",
  refunds: "Hoàn tiền",
};

export function presentAdminOrders(page: AdminOrderListPage): PresentedMessage {
  const lines = [
    ADMIN_COPY.orders,
    page.query ? `Tìm: ${page.query}` : `Lọc: ${ADMIN_ORDER_STATUS_LABELS[page.filter]}`,
    "",
    ...(page.items.length === 0
      ? ["Không có đơn phù hợp."]
      : page.items.map(
          (order) =>
            `• ${order.orderNumber} · ${order.status} · ${order.priceVnd.toLocaleString("vi-VN")} ₫ · ${order.displayName ?? order.telegramUserId ?? order.customerId}`,
        )),
  ];
  return {
    text: lines.join("\n"),
    buttons: [
      ...page.items.map((order) => [
        {
          text: `${order.orderNumber} · ${order.status}`,
          callbackData: `admin:orders:view:${order.stateId}`,
        },
      ]),
      [{ text: "🔎 Tìm đơn/khách", callbackData: "admin:orders:search" }],
      [
        { text: "Tất cả", callbackData: "admin:orders:filter:all" },
        { text: "Chờ tiền", callbackData: "admin:orders:filter:pending_payment" },
      ],
      [
        { text: "Cần soát tiền", callbackData: "admin:orders:filter:payment_review" },
        { text: "Cần giao", callbackData: "admin:orders:filter:fulfillment_review" },
      ],
      ...(page.nextStateId
        ? [[{ text: "Trang sau", callbackData: `admin:orders:page:${page.nextStateId}` }]]
        : []),
      [{ text: ADMIN_COPY.mainMenu, callbackData: "admin:menu" }],
    ],
  };
}

export function presentAdminOrderSearchPrompt(): PresentedMessage {
  return {
    text: "Nhập mã đơn ORD-... hoặc Telegram ID/chat ID số để tìm đơn.",
    buttons: [[{ text: "Huỷ", callbackData: "admin:orders" }]],
  };
}

export function presentAdminOrderDetail(order: AdminOrderDetail): PresentedMessage {
  return {
    text: [
      "Chi tiết đơn hàng",
      "",
      `Mã: ${order.orderNumber}`,
      `Trạng thái đơn: ${order.orderStatus}`,
      `Khách: ${order.displayName ?? "chưa có"} · Telegram ${order.telegramUserId ?? "chưa có"}${order.username ? ` (@${order.username})` : ""}`,
      `Có thể nhắn: ${order.reachable ? "có" : "không"}`,
      `SĐT: ${order.phoneNumber ?? "chưa chia sẻ"}`,
      `Sản phẩm: ${order.productName} · ${order.variantName}`,
      `Giá: ${order.priceVnd.toLocaleString("vi-VN")} ₫`,
      `Giao hàng: ${order.fulfillmentType} · ${order.deliveryType} · ${order.supplierPolicySnapshot ?? "không có"}`,
      `Thanh toán: ${order.paymentStatus ?? "chưa có"}${order.paymentAmountVnd === null ? "" : ` · ${order.paymentAmountVnd.toLocaleString("vi-VN")} ₫`}`,
      `Paid at: ${order.paidAt ?? "chưa có"}`,
      `Settled at: ${order.paymentSettledAt ?? "chưa có"}`,
      `Fulfillment: ${order.fulfillmentStatus ?? order.manualTaskStatus ?? "chưa có"}`,
      `Completed at: ${order.completedAt ?? "chưa có"}`,
      `Created at: ${order.createdAt}`,
    ].join("\n"),
    buttons: [
      [{ text: "✉️ Nhắn khách", callbackData: `admin:orders:message:${order.messageStateId}` }],
      [{ text: ADMIN_COPY.orders, callbackData: "admin:orders" }],
      [{ text: ADMIN_COPY.mainMenu, callbackData: "admin:menu" }],
    ],
  };
}
export function presentAdminPaymentsMenu(statusText?: string | undefined): PresentedMessage {
  const body = statusText
    ? `${statusText}\nTheo dõi thanh toán và đối soát.`
    : "Theo dõi thanh toán và đối soát.";
  return presentAdminSection(ADMIN_COPY.payments, body);
}
export interface AdminSupplierOverview {
  id: string;
  name: string;
  adapterType: string;
  status: string;
  activeMappings: number;
  variantId?: string;
  variantName?: string;
}

export interface AdminSupplierVariantMapping {
  supplierSkuId: string;
  supplierName: string;
  externalSku: string;
  costVnd: bigint;
  region: string | null;
  active: boolean;
  selected: boolean;
  lastVerifiedAt: string | null;
}

export function presentAdminSuppliersMenu(
  suppliers: AdminSupplierOverview[] = [],
): PresentedMessage {
  if (suppliers.length === 0) {
    return presentAdminSection(ADMIN_COPY.suppliers, "Chưa có nhà cung cấp đang hoạt động.");
  }
  const visible = suppliers.slice(0, 20);
  return presentAdminSection(
    ADMIN_COPY.suppliers,
    [
      "Nhà cung cấp đang cấu hình:",
      ...visible.map(
        (supplier) =>
          `• ${supplier.name} — ${supplier.status} — ${supplier.activeMappings} mapping${supplier.variantName ? ` — ${supplier.variantName}` : ""}`,
      ),
    ].join("\n"),
    visible.flatMap((supplier) =>
      supplier.variantId
        ? [
            [
              {
                text: supplier.variantName ?? supplier.name,
                callbackData: `admin:supv:${supplier.variantId}`,
              },
            ],
          ]
        : [],
    ),
  );
}

export function presentAdminSupplierVariant(input: {
  variantId: string;
  variantName: string;
  sku: string;
  mappings: AdminSupplierVariantMapping[];
}): PresentedMessage {
  const lines = [
    ADMIN_COPY.suppliers,
    `Biến thể: ${input.variantName}`,
    `SKU: ${input.sku}`,
    "",
    ...(input.mappings.length
      ? input.mappings.map(
          (mapping) =>
            `${mapping.selected ? "✓" : "•"} ${mapping.supplierName} / ${mapping.externalSku} — ${mapping.costVnd.toLocaleString("vi-VN")} ₫ — ${mapping.region ?? "mọi vùng"} — ${mapping.lastVerifiedAt ? `đã xác nhận ${mapping.lastVerifiedAt}` : "chưa xác nhận thủ công"}`,
        )
      : ["Chưa có mapping nhà cung cấp cho biến thể này."]),
  ];
  const buttons = input.mappings.flatMap((mapping): InlineButton[][] => [
    [
      {
        text: `${mapping.selected ? "✓" : "Chọn"} ${mapping.externalSku}`,
        callbackData: `admin:sups:${mapping.supplierSkuId}`,
      },
    ],
    [
      {
        text: `Đánh dấu đã kiểm tra ${mapping.externalSku}`,
        callbackData: `admin:supm:${mapping.supplierSkuId}`,
      },
    ],
  ]);
  if (input.mappings.some((mapping) => mapping.selected))
    buttons.push([{ text: "Bỏ chọn mapping", callbackData: `admin:supc:${input.variantId}` }]);
  return { text: lines.join("\n"), buttons: [...buttons, adminNav("admin:suppliers")] };
}

export function presentAdminSupplierActionDone(input: {
  action: "select" | "clear" | "verify";
  variantId: string;
}): PresentedMessage {
  const label =
    input.action === "select"
      ? "Đã chọn mapping nhà cung cấp"
      : input.action === "clear"
        ? "Đã bỏ chọn mapping nhà cung cấp"
        : "Đã đánh dấu kiểm tra thủ công";
  return {
    text: ["✅ Nhà cung cấp", "", label, `Mã biến thể: ${input.variantId}`].join("\n"),
    buttons: [
      [{ text: ADMIN_COPY.suppliers, callbackData: `admin:supv:${input.variantId}` }],
      adminNav("admin:suppliers"),
    ],
  };
}

export function presentAdminSupportMenu(): PresentedMessage {
  return presentAdminSection(ADMIN_COPY.support, "Xử lý yêu cầu hỗ trợ và sự cố.");
}

export interface AdminSupportReplacementRow {
  caseId: string;
  orderId: string;
  orderNumber: string;
  customerId: string;
  reasonCode: string;
  safeSummary: string | null;
}

export function presentAdminSupportQueue(rows: AdminSupportReplacementRow[]): PresentedMessage {
  if (rows.length === 0) {
    return {
      text: [ADMIN_COPY.support, "", "Không có yêu cầu thay thế đang chờ duyệt."].join("\n"),
      buttons: [[{ text: ADMIN_COPY.mainMenu, callbackData: "admin:menu" }]],
    };
  }
  const lines = [ADMIN_COPY.support, "", "Yêu cầu thay thế chờ duyệt:"];
  const buttons: InlineButton[][] = [];
  for (const row of rows) {
    lines.push(`• ${row.orderNumber} · ${row.reasonCode} · ${row.caseId.slice(-8)}`);
    if (row.safeSummary) lines.push(`  ${row.safeSummary}`);
    buttons.push([
      { text: `Duyệt ${row.orderNumber}`, callbackData: `admin:support:approve:${row.caseId}` },
    ]);
  }
  buttons.push([{ text: ADMIN_COPY.mainMenu, callbackData: "admin:menu" }]);
  return { text: lines.join("\n"), buttons };
}

export type AdminBroadcastAudience = "all" | "shop" | "activity" | "root";

const audienceLabel = (audience: AdminBroadcastAudience): string =>
  audience === "all"
    ? "Tất cả khách nhận Telegram"
    : audience === "shop"
      ? "Khách bật cập nhật sản phẩm"
      : audience === "activity"
        ? "Khách bật hoạt động mua hàng"
        : "Chỉ chủ cửa hàng";

export function presentAdminMarketingMenu(): PresentedMessage {
  return presentAdminSection(
    ADMIN_COPY.marketing,
    "Gửi thông báo marketing cho nhóm khách đã chọn.",
    [[{ text: "📝 Soạn thông báo", callbackData: "admin:marketing:compose" }]],
  );
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
    text: [
      `Soạn nội dung thông báo.`,
      `Nhóm nhận: ${audienceLabel(audience)}`,
      "",
      "Gửi nội dung bằng tin nhắn tiếp theo.",
    ].join("\n"),
    buttons: [[{ text: "Huỷ", callbackData: "admin:marketing:cancel" }]],
  };
}
export function presentAdminBroadcastPreview(input: {
  campaignId: string;
  audience: AdminBroadcastAudience;
  count: number;
  content: string;
}): PresentedMessage {
  return {
    text: [
      "📣 Xem trước thông báo",
      `Nhóm nhận: ${audienceLabel(input.audience)}`,
      `Số khách sẽ nhận: ${input.count}`,
      "",
      input.content,
    ].join("\n"),
    buttons: [
      [{ text: "✅ Xác nhận gửi", callbackData: `admin:marketing:confirm:${input.campaignId}` }],
      [{ text: "Huỷ", callbackData: `admin:marketing:cancel:${input.campaignId}` }],
    ],
  };
}

export function presentAdminBroadcastStatus(input: {
  campaignId: string;
  status: string;
  audience: AdminBroadcastAudience;
  total: number;
  pending: number;
  retry: number;
  sent: number;
  suppressed: number;
  dead: number;
}): PresentedMessage {
  return {
    text: [
      "📣 Trạng thái thông báo",
      `ID: ${input.campaignId}`,
      `Trạng thái: ${input.status}`,
      `Nhóm nhận: ${audienceLabel(input.audience)}`,
      `Tổng: ${input.total}`,
      `Đang chờ: ${input.pending}`,
      `Gửi lại: ${input.retry}`,
      `Đã gửi: ${input.sent}`,
      `Đã dừng/huỷ: ${input.suppressed}`,
      `Lỗi chết: ${input.dead}`,
      "",
      "Dừng chỉ chặn phần chưa bắt đầu gửi. Tin đang gửi tới Telegram vẫn có thể đến người nhận.",
    ].join("\n"),
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
    text: "Bước 5/8 — Chọn danh mục.",
    buttons: categories
      .slice(0, 20)
      .map((category) => [
        { text: category.name, callbackData: `admin:products:category:${category.id}` },
      ]),
  };
}
export function presentProductFulfillmentTypeChoices(): PresentedMessage {
  return {
    text: "Bước 6/8 — Chọn loại giao hàng.",
    buttons: [
      [
        {
          text: "👤 Tài khoản",
          callbackData: "admin:products:type:STOCK_ACCOUNT",
        },
      ],
      [
        {
          text: "🔑 Key / Code",
          callbackData: "admin:products:type:STOCK_CODE",
        },
      ],
      [
        {
          text: "🧑‍💻 Giao thủ công",
          callbackData: "admin:products:type:MANUAL_FULFILLMENT",
        },
      ],
      [
        {
          text: "♾ Dịch vụ",
          callbackData: "admin:products:type:UNLIMITED_SERVICE",
        },
      ],
      [
        {
          text: "📦 Hàng số lượng",
          callbackData: "admin:products:type:QUANTITY_STOCK",
        },
      ],
      [
        {
          text: "📁 File số",
          callbackData: "admin:products:type:DIGITAL_FILE",
        },
      ],
      [
        {
          text: "🔌 API nhà cung cấp",
          callbackData: "admin:products:type:SUPPLIER_API",
        },
      ],
      [
        { text: "⬅️ Quay lại", callbackData: "admin:products:back" },
        { text: "❌ Huỷ", callbackData: "admin:products:cancel" },
      ],
    ],
  };
}

export function presentProductDraftPreview(draft: {
  name?: string | undefined;
  existingProductId?: string | undefined;
  sku: string;
  variantName: string;
  categoryId?: string | undefined;
  categoryName?: string | undefined;
  priceVnd: bigint;
  compareAtPriceVnd?: bigint | undefined;
  fulfillmentType: FulfillmentType;
  inventoryFields: InventoryField[];
  lowStockThreshold?: number | undefined;
  descriptionVi?: string | undefined;
  warrantyVi?: string | undefined;
  deliveryEtaVi?: string | undefined;
  serviceInstructions?: string | undefined;
  initialQuantity?: number | undefined;
  fileArtifact?: { filename: string } | undefined;
  supplierConfig?:
    | { supplierId: string; externalSku: string; costVnd: bigint; region?: string | undefined }
    | undefined;
}): PresentedMessage {
  const deliveryLine =
    draft.fulfillmentType === "UNLIMITED_SERVICE"
      ? "♾ Dịch vụ không giới hạn — không cần nhập kho"
      : draft.fulfillmentType === "MANUAL_FULFILLMENT"
        ? "🧑‍💻 Nhân viên xử lý thủ công"
        : draft.fulfillmentType === "SUPPLIER_API"
          ? "🔌 Giao qua nhà cung cấp/API"
          : draft.fulfillmentType === "QUANTITY_STOCK"
            ? "📦 Hàng số lượng — không có thông tin đăng nhập"
            : draft.fulfillmentType === "DIGITAL_FILE"
              ? "📁 Giao tệp số"
              : draft.inventoryFields.map((field) => field.label).join(", ") || "Chưa cấu hình";
  return {
    text: [
      "📋 XEM TRƯỚC SẢN PHẨM",
      "",
      ...(draft.name ? [`Tên: ${draft.name}`] : []),
      `Biến thể: ${draft.variantName}`,
      `SKU: ${draft.sku}`,
      draft.existingProductId
        ? `Sản phẩm cha: ${draft.existingProductId}`
        : `Danh mục: ${draft.categoryName ?? draft.categoryId ?? "Chưa chọn"}`,
      `Loại: ${FULFILLMENT_TYPE_LABELS[draft.fulfillmentType]}`,
      `Giá: ${draft.priceVnd.toLocaleString("vi-VN")} ₫${draft.compareAtPriceVnd ? ` (gốc ${draft.compareAtPriceVnd.toLocaleString("vi-VN")} ₫)` : ""}`,
      `Giao hàng: ${deliveryLine}`,
      ...(draft.descriptionVi ? [`Mô tả: ${draft.descriptionVi}`] : []),
      ...(draft.deliveryEtaVi ? [`Thời gian giao: ${draft.deliveryEtaVi}`] : []),
      `Bảo hành: ${draft.warrantyVi ?? "Theo chính sách cửa hàng"}`,
      "Hiển thị: Nháp — chỉ admin thấy cho tới khi kích hoạt",
      ...(draft.lowStockThreshold === undefined ? [] : [`Ngưỡng tồn: ${draft.lowStockThreshold}`]),
      ...(draft.serviceInstructions ? [`Hướng dẫn xử lý:\n${draft.serviceInstructions}`] : []),
      ...(draft.initialQuantity === undefined
        ? []
        : [`Số lượng ban đầu:\n${draft.initialQuantity}`]),
      ...(draft.fileArtifact
        ? [`Tệp đăng ký:\n${draft.fileArtifact.filename} (chưa kích hoạt/chưa bán)`]
        : []),
      ...(draft.supplierConfig
        ? [
            `Nhà cung cấp:\n${draft.supplierConfig.supplierId} · SKU ${draft.supplierConfig.externalSku} · Giá vốn ${draft.supplierConfig.costVnd.toLocaleString("vi-VN")} ₫${draft.supplierConfig.region ? ` · ${draft.supplierConfig.region}` : ""}`,
          ]
        : []),
    ].join("\n"),
    buttons: [
      [
        {
          text: draft.existingProductId ? "✅ Tạo biến thể" : "✅ Tạo sản phẩm",
          callbackData: "admin:products:confirm",
        },
      ],
      [{ text: "✏️ Chỉnh sửa", callbackData: "admin:products:back" }],
      ...(!draft.existingProductId
        ? [[{ text: "💾 Lưu nháp", callbackData: "admin:products:draft" }]]
        : []),
      [{ text: "❌ Huỷ", callbackData: "admin:products:cancel" }],
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
  const visibleRows = rows.slice(0, 20);
  return {
    text: [
      ADMIN_COPY.products,
      ...visibleRows.map((row) => `• ${row.name} (${row.active ? "đang bán" : "tạm dừng"})`),
    ].join("\n"),
    buttons: [
      [
        { text: ADMIN_COPY.overview, callbackData: "admin:dashboard" },
        { text: ADMIN_COPY.inventory, callbackData: "admin:inventory" },
      ],
      ...visibleRows.map((row) => [
        {
          text: `${row.name} (${row.active ? "đang bán" : "tạm dừng"})`,
          callbackData: `admin:products:detail:${row.id}`,
        },
      ]),
      [{ text: "📝 Xem lại nháp", callbackData: "admin:products:review" }],
      adminNav("admin:menu"),
    ],
  };
}

export interface AdminInventoryProductSummary {
  id: string;
  name: string;
  active?: boolean;
  variantCount: number;
  inStock: number;
  lowStock: number;
  outOfStock: number;
}

export interface AdminInventoryVariantSummary {
  id: string;
  name: string;
  sku: string;
  fulfillmentType: FulfillmentType;
  available: number;
  reserved: number;
  delivered: number;
  error: number;
  lowStockThreshold: number | null;
  importSupported: boolean;
  fileImportSupported?: boolean;
  quantityAdjustSupported?: boolean;
  supplierSupported?: boolean;
  active?: boolean;
}

function stockBadge(input: { available: number; lowStockThreshold: number | null }): string {
  if (input.available <= 0) return "hết hàng";
  return input.lowStockThreshold !== null &&
    input.lowStockThreshold > 0 &&
    input.available <= input.lowStockThreshold
    ? `sắp hết (${input.available})`
    : `còn ${input.available}`;
}

function importInstruction(input: {
  fulfillmentType: FulfillmentType;
  fields?: InventoryField[];
}): string {
  switch (input.fulfillmentType) {
    case "STOCK_ACCOUNT": {
      const fields = input.fields?.map((field) => field.name).join(", ") || "dữ liệu";
      return `Dán dạng pipe theo trường: ${fields}; hoặc tải CSV mẫu, điền đúng cột rồi dán/gửi tệp .csv/.txt.`;
    }
    case "STOCK_CODE":
      return "Dán mỗi mã một dòng hoặc gửi tệp .txt/.csv; bot chỉ xem trước số dòng, không ghi kho trước khi xác nhận.";
    case "DIGITAL_FILE":
      return "Gửi một tài liệu Telegram để đăng ký tệp bán, xem trước rồi xác nhận kích hoạt.";
    case "SUPPLIER_API":
      return "Đồng bộ/mapping qua màn hình nhà cung cấp; không nhập CSV cho loại này.";
    case "QUANTITY_STOCK":
      return "Điều chỉnh số lượng bằng nút +1/-1; không nhập dữ liệu đăng nhập.";
    case "MANUAL_FULFILLMENT":
    case "UNLIMITED_SERVICE":
      return "Xử lý theo quy trình dịch vụ, không có nhập kho vật lý.";
  }
}

export function presentAdminInventory(
  rows: AdminInventoryProductSummary[],
  totals?: {
    products: number;
    variants: number;
    inStock: number;
    lowStock: number;
    outOfStock: number;
    held?: number;
    waiting?: number;
  },
): PresentedMessage {
  const visibleRows = rows.slice(0, 20);
  return {
    text: [
      "📦 QUẢN LÝ KHO",
      "",
      totals
        ? [
            "Tổng:",
            `• Sản phẩm: ${totals.products}`,
            `• Biến thể: ${totals.variants}`,
            `• Còn hàng: ${totals.inStock}`,
            `• Sắp hết: ${totals.lowStock}`,
            `• Hết hàng: ${totals.outOfStock}`,
            `• Đang giữ: ${totals.held ?? 0}`,
            `• Chờ nhập: ${totals.waiting ?? 0}`,
          ].join("\n")
        : "Tổng quan tồn kho sản phẩm.",
      "",
      visibleRows.length === 0
        ? "Chưa có sản phẩm. Tạo sản phẩm mới để bắt đầu; không dùng CSV khi chưa có biến thể."
        : "Danh sách sản phẩm kho:",
      ...visibleRows.map((row) => {
        const status = row.active === false ? " · nháp/chưa mở bán" : "";
        return `• ${row.name}${status}: ${row.variantCount} biến thể · còn ${row.inStock} · sắp hết ${row.lowStock} · hết ${row.outOfStock}`;
      }),
    ].join("\n"),
    buttons: [
      ...(visibleRows.length === 0
        ? [[{ text: "➕ Tạo sản phẩm", callbackData: "admin:products:create" }]]
        : visibleRows.map((row) => [
            {
              text: `${row.name}${row.active === false ? " · nháp" : ""} · ${row.inStock}/${row.variantCount} còn`,
              callbackData: `admin:inventory:product:${row.id}`,
            },
          ])),
      [
        { text: "➕ Nhập kho", callbackData: "admin:inventory:add" },
        { text: "➕ Tạo sản phẩm", callbackData: "admin:products:create" },
      ],
      [
        { text: "📥 Tải mẫu CSV", callbackData: "admin:inventory:template_select" },
        { text: "📋 Dán nhanh", callbackData: "admin:inventory:paste_select" },
      ],
      [
        { text: "🔎 Tìm sản phẩm", callbackData: "admin:products" },
        { text: "⚠️ Sắp / hết hàng", callbackData: "admin:dashboard" },
      ],
      [
        { text: "🕘 Lịch sử kho", callbackData: "admin:audit" },
        { text: "🏠 Quản trị", callbackData: "admin:menu" },
      ],
    ],
  };
}

export function presentAdminInventoryProductPicker(
  products: Array<{ id: string; name: string }>,
  action: "import" | "template" | "paste",
): PresentedMessage {
  const title =
    action === "template"
      ? "📥 CHỌN SẢN PHẨM ĐỂ TẢI MẪU CSV"
      : action === "paste"
        ? "📋 CHỌN SẢN PHẨM ĐỂ DÁN DỮ LIỆU"
        : "➕ CHỌN SẢN PHẨM ĐỂ NHẬP KHO";
  return {
    text: [title, "", "Vui lòng chọn sản phẩm bên dưới:"].join("\n"),
    buttons: [
      ...products.map((p) => [
        { text: `📦 ${p.name}`, callbackData: `admin:inventory:pick_prod:${action}:${p.id}` },
      ]),
      [{ text: "↩️ Quay lại Kho", callbackData: "admin:inventory" }],
      [{ text: "🏠 Quản trị", callbackData: "admin:menu" }],
    ],
  };
}

export function presentAdminInventoryVariantPicker(
  product: { id: string; name: string },
  variants: Array<{
    id: string;
    name: string;
    sku: string;
    fulfillmentType: FulfillmentType;
    available: number;
  }>,
  action: "import" | "template" | "paste",
): PresentedMessage {
  const title =
    action === "template"
      ? "📥 CHỌN BIẾN THỂ ĐỂ TẢI MẪU CSV"
      : action === "paste"
        ? "📋 CHỌN BIẾN THỂ ĐỂ DÁN DỮ LIỆU"
        : "➕ CHỌN BIẾN THỂ ĐỂ NHẬP KHO";
  return {
    text: [title, "", `Sản phẩm: ${product.name}`, "Vui lòng chọn biến thể:"].join("\n"),
    buttons: [
      ...variants.map((v) => [
        {
          text: `🔹 ${v.name} (${v.sku}) — Còn: ${v.available}`,
          callbackData:
            action === "template"
              ? `admin:inventory:template:${v.id}`
              : `admin:inventory:import:${v.id}`,
        },
      ]),
      [
        {
          text: "↩️ Chọn sản phẩm khác",
          callbackData: `admin:inventory:${action === "template" ? "template_select" : action === "paste" ? "paste_select" : "add"}`,
        },
      ],
      [{ text: "🏠 Quản trị", callbackData: "admin:menu" }],
    ],
  };
}

export function presentAdminTestLab(input: {
  testProducts: Array<{ id: string; name: string; active: boolean }>;
  canaryOrders: Array<{ orderNumber: string; status: string; priceVnd: number }>;
}): PresentedMessage {
  return {
    text: [
      "🧪 TEST LAB (CANARY & KIỂM THỬ NỘI BỘ)",
      "",
      "Khu vực này tách biệt hoàn toàn khỏi khách hàng.",
      "Dùng để kiểm thử giao dịch, SePay replay và Canary automated codes.",
      "",
      "📦 Sản phẩm Canary / Test:",
      ...(input.testProducts.length === 0
        ? ["• (Chưa có sản phẩm test)"]
        : input.testProducts.map((p) => `• ${p.name} (ID: ${p.id.slice(0, 12)}...)`)),
      "",
      "🧾 Giao dịch Canary gần nhất:",
      ...(input.canaryOrders.length === 0
        ? ["• (Chưa có giao dịch)"]
        : input.canaryOrders.map(
            (o) => `• ${o.orderNumber} · ${o.status} · ${o.priceVnd.toLocaleString("vi-VN")} ₫`,
          )),
    ].join("\n"),
    buttons: [
      [{ text: "👥 Khách test", callbackData: "admin:testlab:testers" }],
      [
        { text: "📦 Quản lý kho", callbackData: "admin:inventory" },
        { text: "🏠 Quản trị", callbackData: "admin:menu" },
      ],
    ],
  };
}
export interface AdminPreorderSummaryItem {
  id: string;
  variantId: string;
  productName: string;
  variantName: string;
  status: string;
  depositVnd: number;
  balanceVnd: number;
  customerName: string;
  holdUntil?: Date | string | null;
}

export function presentAdminPreorders(input: {
  items: AdminPreorderSummaryItem[];
  filter: string;
}): PresentedMessage {
  const lines = [
    "💰 ĐẶT CỌC / GIỮ HÀNG",
    `Bộ lọc: ${input.filter}`,
    "",
    ...(input.items.length === 0
      ? ["Chưa có lượt đặt cọc nào phù hợp."]
      : input.items.map(
          (item) =>
            `• ${item.productName} · ${item.variantName} · ${item.status} · Cọc: ${item.depositVnd.toLocaleString("vi-VN")} ₫ · Khách: ${item.customerName}`,
        )),
  ];

  const cancelButtons = input.items
    .filter((item) =>
      [
        "CREATED",
        "WAITING_DEPOSIT",
        "DEPOSIT_PAID",
        "ALLOCATED",
        "BALANCE_DUE",
        "FULLY_PAID",
      ].includes(item.status),
    )
    .slice(0, 8)
    .map((item) => [
      {
        text: `Huỷ shop · ${item.variantName}`.slice(0, 64),
        callbackData: `admin:preorders:cancel:${item.id}`,
      },
    ]);

  return {
    text: lines.join("\n"),
    buttons: [
      ...cancelButtons,
      [
        { text: "Tất cả", callbackData: "admin:preorders:filter:all" },
        { text: "Chờ cọc", callbackData: "admin:preorders:filter:waiting_deposit" },
        { text: "Đã cọc", callbackData: "admin:preorders:filter:deposit_paid" },
      ],
      [
        { text: "Đã giữ hàng", callbackData: "admin:preorders:filter:allocated" },
        { text: "Chờ thanh toán", callbackData: "admin:preorders:filter:balance_due" },
        { text: "Hoàn tất", callbackData: "admin:preorders:filter:fulfilled" },
      ],
      [
        { text: "Bỏ cọc", callbackData: "admin:preorders:filter:forfeited" },
        { text: "Cần hoàn", callbackData: "admin:preorders:filter:refund_due" },
      ],
      [
        { text: "📦 Quản lý kho", callbackData: "admin:inventory" },
        { text: "🏠 Quản trị", callbackData: "admin:menu" },
      ],
    ],
  };
}

export function presentAdminInventoryProduct(input: {
  id: string;
  name: string;
  variants: AdminInventoryVariantSummary[];
}): PresentedMessage {
  const visibleVariants = input.variants.slice(0, 20);
  return {
    text: [
      ADMIN_COPY.inventory,
      `Sản phẩm: ${input.name}`,
      visibleVariants.length === 0
        ? "Chưa có biến thể. Tạo biến thể để bán hoặc nhập kho."
        : "Biến thể:",
      ...visibleVariants.map(
        (variant) =>
          `• ${variant.name}${variant.active === false ? " · nháp/chưa mở bán" : ""} — ${variant.sku} — ${FULFILLMENT_TYPE_LABELS[variant.fulfillmentType]} — khả dụng ${variant.available} · giữ ${variant.reserved} · giao ${variant.delivered} · lỗi ${variant.error}${variant.lowStockThreshold === null ? "" : ` — ngưỡng ${variant.lowStockThreshold}`}`,
      ),
    ].join("\n"),
    buttons: [
      ...visibleVariants.map((variant) => [
        {
          text: `${variant.name}${variant.active === false ? " · nháp" : ""} · ${stockBadge(variant)}`,
          callbackData: `admin:inventory:variant:${variant.id}`,
        },
      ]),
      [{ text: "➕ Thêm biến thể", callbackData: `admin:products:variant-add:${input.id}` }],
      [{ text: ADMIN_COPY.back, callbackData: "admin:inventory" }],
      adminNav("admin:menu"),
    ],
  };
}

export function presentAdminInventoryVariant(input: {
  productId: string;
  id: string;
  name: string;
  sku: string;
  fulfillmentType: FulfillmentType;
  available: number;
  reserved?: number;
  delivered?: number;
  error?: number;
  lowStockThreshold: number | null;
  importSupported: boolean;
  fileImportSupported?: boolean;
  announceSupported?: boolean;
  stockVersion?: number;
  inventoryFields?: InventoryField[];
  supplierSupported?: boolean;
  active?: boolean;
}): PresentedMessage {
  return {
    text: [
      ADMIN_COPY.inventory,
      `Biến thể: ${input.name}`,
      `SKU: ${input.sku}`,
      `Loại: ${FULFILLMENT_TYPE_LABELS[input.fulfillmentType]}`,
      `Trạng thái: ${input.active === false ? "nháp/chưa mở bán" : "đang quản lý"}`,
      `Khả dụng: ${input.available}`,
      `Đang giữ: ${input.reserved ?? 0}`,
      `Đã giao: ${input.delivered ?? 0}`,
      `Lỗi/khóa: ${input.error ?? 0}`,
      `Ngưỡng cảnh báo: ${input.lowStockThreshold ?? "—"}`,
      importInstruction({
        fulfillmentType: input.fulfillmentType,
        ...(input.inventoryFields ? { fields: input.inventoryFields } : {}),
      }),
    ].join("\n"),
    buttons: [
      ...(input.fileImportSupported
        ? [[{ text: "📎 Đăng ký tệp", callbackData: `admin:inventory:import:${input.id}` }]]
        : input.importSupported
          ? [
              [{ text: "📥 Nhập kho", callbackData: `admin:inventory:import:${input.id}` }],
              [{ text: "⬇️ Template", callbackData: `admin:inventory:template:${input.id}` }],
            ]
          : []),
      ...(input.fulfillmentType === "QUANTITY_STOCK" && input.stockVersion !== undefined
        ? [
            [
              {
                text: "+1",
                callbackData: `admin:inventory:qty:${input.id}:1:${input.stockVersion}`,
              },
              {
                text: "-1",
                callbackData: `admin:inventory:qty:${input.id}:-1:${input.stockVersion}`,
              },
            ],
          ]
        : []),
      ...(input.supplierSupported
        ? [[{ text: "🚚 Mapping/đồng bộ", callbackData: `admin:supv:${input.id}` }]]
        : []),
      ...(input.announceSupported
        ? [
            [
              {
                text: "📣 Thông báo còn hàng",
                callbackData: `admin:inventory:announce:${input.id}`,
              },
            ],
          ]
        : []),
      [{ text: "📋 Danh sách an toàn", callbackData: `admin:inventory:history:${input.id}` }],
      [{ text: ADMIN_COPY.back, callbackData: `admin:inventory:product:${input.productId}` }],
      adminNav("admin:menu"),
    ],
  };
}

export function presentAdminInventoryHistory(input: {
  productId: string;
  variantId: string;
  variantName: string;
  rows: Array<{ label: string; detail: string; occurredAt: string }>;
}): PresentedMessage {
  const lines = input.rows.length
    ? input.rows.map((row) => `• ${row.label} — ${row.detail} — ${row.occurredAt}`)
    : ["Chưa có lịch sử kho cho biến thể này."];
  return {
    text: [
      ADMIN_COPY.inventory,
      `Lịch sử kho: ${input.variantName}`,
      "Hiển thị tối đa 10 mục gần nhất. Không hiển thị lần nhập cũ hoặc nhập nhiều biến thể chưa có liên kết kiểm toán riêng.",
      ...lines,
    ].join("\n"),
    buttons: [
      [{ text: ADMIN_COPY.back, callbackData: `admin:inventory:variant:${input.variantId}` }],
      [{ text: "Sản phẩm", callbackData: `admin:inventory:product:${input.productId}` }],
      adminNav("admin:menu"),
    ],
  };
}

export function presentQuantityStockAdjustPreview(input: {
  stateId: string;
  variantName: string;
  sku: string;
  delta: number;
  available: number;
  nextAvailable: number;
  expectedStockVersion: number;
}): PresentedMessage {
  return {
    text: [
      "Xác nhận điều chỉnh tồn kho số lượng",
      `Biến thể: ${input.variantName}`,
      `SKU: ${input.sku}`,
      `Thay đổi: ${input.delta > 0 ? "+" : ""}${input.delta}`,
      `Tồn hiện tại: ${input.available}`,
      `Tồn sau điều chỉnh: ${input.nextAvailable}`,
      `Phiên bản tồn: ${input.expectedStockVersion}`,
    ].join("\n"),
    buttons: [
      [{ text: "✅ Xác nhận", callbackData: `admin:inventory:qty-confirm:${input.stateId}` }],
      [{ text: ADMIN_COPY.back, callbackData: "admin:inventory" }],
    ],
  };
}

export function presentQuantityStockAdjustReasonPrompt(input: {
  variantName: string;
  delta: number;
  nextAvailable: number;
}): PresentedMessage {
  return {
    text: [
      "Nhập lý do điều chỉnh tồn kho.",
      `Biến thể: ${input.variantName}`,
      `Thay đổi: ${input.delta > 0 ? "+" : ""}${input.delta}`,
      `Tồn sau điều chỉnh: ${input.nextAvailable}`,
      "Tối đa 200 ký tự.",
    ].join("\n"),
    buttons: [[{ text: ADMIN_COPY.back, callbackData: "admin:inventory" }]],
  };
}

export function presentQuantityStockAdjustDone(input: {
  availableQuantity: number;
  version: number;
  idempotent: boolean;
}): PresentedMessage {
  return {
    text: `✅ Đã cập nhật tồn kho: ${input.availableQuantity} (phiên bản ${input.version})${input.idempotent ? " — đã ghi nhận trước đó" : ""}.`,
    buttons: [[{ text: ADMIN_COPY.inventory, callbackData: "admin:inventory" }]],
  };
}

export function presentInventoryImportPrompt(input: {
  variantId: string;
  variantName: string;
  sku: string;
  kind?: "secret" | "file";
  fulfillmentType?: FulfillmentType;
  inventoryFields?: InventoryField[];
}): PresentedMessage {
  const file = input.kind === "file";
  return {
    text: [
      file ? "📎 Đăng ký tệp bán" : "📦 Nhập kho biến thể",
      `Biến thể: ${input.variantName}`,
      `SKU: ${input.sku}`,
      file
        ? "Gửi một tài liệu Telegram. Bot tải tối đa 20 MB vào kho riêng, tính hash, rồi chờ xác nhận kích hoạt."
        : importInstruction({
            fulfillmentType: input.fulfillmentType ?? "STOCK_ACCOUNT",
            ...(input.inventoryFields ? { fields: input.inventoryFields } : {}),
          }),
      file
        ? "Không gửi đường dẫn hay token. Bấm /cancel để huỷ."
        : "Có thể dán nội dung hoặc gửi tài liệu .csv/.txt tối đa 64 KB / 500 dòng. Preview không hiện dữ liệu bí mật.",
    ].join("\n"),
    buttons: [
      ...(file
        ? []
        : [
            [
              {
                text: "⬇️ Tải CSV mẫu",
                callbackData: `admin:inventory:template:${input.variantId}`,
              },
            ],
          ]),
      [{ text: "↩️ Huỷ nhập kho", callbackData: "admin:inventory:cancel" }],
      [{ text: ADMIN_COPY.adminMenu, callbackData: "admin:menu" }],
    ],
  };
}

export function presentInventoryImportTemplate(input: {
  variantName: string;
  sku: string;
  filename: string;
  csv: string;
  requiredFields: string[];
  optionalFields: string[];
}): PresentedMessage {
  return {
    text: [
      "CSV mẫu nhập kho",
      `Biến thể: ${input.variantName}`,
      `SKU: ${input.sku}`,
      `Bắt buộc: ${input.requiredFields.join(", ") || "—"}`,
      `Tuỳ chọn: ${input.optionalFields.join(", ") || "—"}`,
      "Sao chép nội dung hoặc tải tệp CSV, điền dòng mới rồi dán/gửi lại. Không đổi header.",
    ].join("\n"),
    document: { kind: "buffer", value: Buffer.from(input.csv, "utf8"), filename: input.filename },
    buttons: [
      [{ text: "↩️ Huỷ nhập kho", callbackData: "admin:inventory:cancel" }],
      [{ text: ADMIN_COPY.adminMenu, callbackData: "admin:menu" }],
    ],
  };
}

export interface InventoryImportPreview {
  ready: number;
  invalid: number;
  duplicates: number;
  variants: string[];
}

export function presentInventoryImportPreview(preview: InventoryImportPreview): PresentedMessage {
  return {
    text: [
      "📦 Xem trước nhập kho",
      `Dòng hợp lệ: ${preview.ready}`,
      `Dòng không hợp lệ: ${preview.invalid}`,
      `Dòng trùng: ${preview.duplicates}`,
      `Biến thể trong tệp: ${new Set(preview.variants).size || "—"}`,
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

export function presentFileArtifactImportPreview(input: {
  stateId: string;
  filename: string;
  sizeBytes: bigint;
  sha256: string;
}): PresentedMessage {
  return {
    text: [
      "📦 Xem trước tệp nhập kho",
      `Tệp: ${input.filename}`,
      `Dung lượng: ${input.sizeBytes.toString()} bytes`,
      `SHA-256: ${input.sha256}`,
      "Tệp đã được tải vào kho riêng và sẽ chỉ bán sau khi xác nhận kích hoạt.",
    ].join("\n"),
    buttons: [
      [{ text: "✅ Kích hoạt tệp", callbackData: `admin:inventory:file-confirm:${input.stateId}` }],
      [{ text: "↩️ Huỷ nhập kho", callbackData: "admin:inventory:cancel" }],
      [{ text: ADMIN_COPY.adminMenu, callbackData: "admin:menu" }],
    ],
  };
}

export function presentFileArtifactImportDone(input: { filename: string }): PresentedMessage {
  return {
    text: `✅ Đã kích hoạt tệp ${input.filename}.`,
    buttons: [
      [
        { text: "📦 Kho hàng", callbackData: "admin:inventory" },
        { text: "🛍 Sản phẩm", callbackData: "admin:products" },
      ],
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
  variants?: Array<{
    id: string;
    name: string;
    sku: string;
    priceVnd?: bigint;
    active?: boolean;
    fulfillmentType: string;
    expectedVersion?: number;
  }>;
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
      ...(input.variants?.length
        ? [
            "",
            ...input.variants.map(
              (variant) =>
                `• ${variant.name} — ${variant.sku}${variant.priceVnd === undefined ? "" : ` — ${variant.priceVnd.toLocaleString("vi-VN")} ₫`}${variant.expectedVersion === undefined ? "" : ` — v${variant.expectedVersion}`}`,
            ),
          ]
        : []),
      ...(input.description ? ["", input.description] : []),
    ].join("\n"),
    buttons: [
      [{ text: "➕ Thêm biến thể", callbackData: `admin:products:variant-add:${input.id}` }],
      ...(input.variants ?? []).flatMap((variant) => [
        [
          {
            text: `Sửa ${variant.name}`,
            callbackData: `admin:products:variant-edit:${variant.id}`,
          },
        ],
      ]),
      [{ text: ADMIN_COPY.back, callbackData: "admin:products" }],
      adminNav("admin:menu"),
    ],
  };
}

export function presentAdminVariantDraft(input: {
  stateId: string;
  productId: string;
  variantId: string;
  expectedVersion: number;
  sku: string;
  name: string;
  priceVnd: bigint;
  durationCode: string;
  warrantyDays: number;
  lowStockThreshold: number | null;
}): PresentedMessage {
  return {
    text: [
      "✏️ Sửa biến thể",
      `Sản phẩm: ${input.productId}`,
      `Biến thể: ${input.variantId}`,
      `Phiên bản: ${input.expectedVersion}`,
      "",
      `Gửi: ${input.stateId}|name|priceVnd|durationCode|warrantyDays|lowStockThreshold`,
      "Bỏ trống cột để giữ nguyên; dùng '-' để xoá ngưỡng tồn.",
    ].join("\n"),
    buttons: [[{ text: "❌ Huỷ", callbackData: "admin:products" }]],
  };
}

export function presentAdminVariantMutationDone(input: {
  productId: string;
  variantName: string;
  action: "created" | "updated";
}): PresentedMessage {
  return {
    text: `${input.action === "created" ? "✅ Đã thêm" : "✅ Đã cập nhật"} biến thể ${input.variantName}.`,
    buttons: [[{ text: "🛍 Sản phẩm", callbackData: `admin:products:detail:${input.productId}` }]],
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
