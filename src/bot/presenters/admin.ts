import { compactInlineRows, type InlineButton, type PresentedMessage } from "./catalog.js";
import { formatVnd, makeVnd } from "../../shared/money/index.js";
import { ORDER_STATUS_FALLBACK, ORDER_STATUS_LABEL } from "./history.js";
import {
  FULFILLMENT_TYPE_LABELS,
  type FulfillmentType,
  type InventoryField,
} from "../../modules/catalog/fulfillment-type.js";
import type {
  StoreControl,
  StoreMode,
  StoreOpenReadiness,
} from "../../modules/commerce/store-mode.js";
import type { AuditEvent } from "../../modules/identity/audit.js";
import type { SensitiveAuthorizationRefusal } from "../../modules/identity/sensitive-action.js";
import type { BroadcastRefusal } from "../../modules/notification/service.js";
import type {
  AdminOrderDetail,
  AdminOrderListPage,
  AdminOrderStatusFilter,
} from "../../modules/admin/order-operations.js";
import { canTicketTransition, type SupportTicketStatus } from "../../modules/support/domain.js";
import type { DailyGrowthDigest } from "../../modules/operations/digest.js";
import type { AdminSupportTicketRow } from "../../modules/support/service.js";
import type {
  AdminDiscrepancyDetail,
  DiscrepancyResolutionCode,
} from "../../modules/admin/payment-ops.js";
import type {
  OutboxDispositionCode,
  TerminalOutboxOrphanDetail,
} from "../../infrastructure/outbox/disposition.js";
import type {
  PublicationBlocker,
  ProductPublicationReadiness,
  ResaleEvidenceSource,
} from "../../modules/catalog/publication.js";
import { isId } from "../../shared/ids/index.js";
import { REASON_LABEL } from "./support.js";
import { renderAdminProductList, type AdminProductView } from "./admin-product-list.js";
import type {
  SupplierCatalogRow,
  SupplierLocalVariantTarget,
} from "../../modules/supplier/catalog.js";
import type { SupplierCapability } from "../../modules/supplier/port.js";

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
  adminMenu: "⚙️ TIER20 SHOP — Quản trị",
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
  { id: "dashboard", label: ADMIN_COPY.overview, callbackData: "admin:dashboard", enabled: true },
  { id: "products", label: "📦 Sản phẩm", callbackData: "admin:products", enabled: true },
  { id: "categories", label: "🏷 Danh mục", callbackData: "admin:categories", enabled: true },
  { id: "inventory", label: "📥 Kho hàng", callbackData: "admin:inventory", enabled: true },
  { id: "orders", label: ADMIN_COPY.orders, callbackData: "admin:orders", enabled: true },
  { id: "payments", label: ADMIN_COPY.payments, callbackData: "admin:payments", enabled: true },
  { id: "customers", label: ADMIN_COPY.customers, callbackData: "admin:customers", enabled: true },
  { id: "preorders", label: "💰 Đặt cọc", callbackData: "admin:preorders", enabled: true },
  {
    id: "notifications",
    label: "🔔 Thông báo",
    callbackData: "admin:notifications",
    enabled: true,
  },
  { id: "marketing", label: "📢 Broadcast", callbackData: "admin:marketing", enabled: true },
  { id: "suppliers", label: ADMIN_COPY.suppliers, callbackData: "admin:suppliers", enabled: true },
  { id: "support", label: "🛡 Hỗ trợ/BH", callbackData: "admin:support", enabled: true },
  { id: "health", label: "🩺 Hệ thống", callbackData: "admin:health", enabled: true },
  { id: "warranty", label: "🛡 Hàng chờ BH", callbackData: "admin:warranty", enabled: true },
  { id: "testing", label: "🧪 Test Lab", callbackData: "admin:testlab", enabled: true },
  {
    id: "operations",
    label: ADMIN_COPY.operations,
    callbackData: "admin:operations",
    enabled: true,
  },
  { id: "audit", label: ADMIN_COPY.audit, callbackData: "admin:audit", enabled: false },
] as const;

export const ADMIN_VISIBLE_ROUTE_KEYS = ADMIN_NAV_ITEMS.filter((item) => item.enabled).map(
  (item) => item.id,
) as Array<
  | "dashboard"
  | "products"
  | "categories"
  | "inventory"
  | "orders"
  | "payments"
  | "customers"
  | "preorders"
  | "marketing"
  | "suppliers"
  | "support"
  | "testing"
  | "operations"
>;

/**
 * Home-only nav, for a screen that already carries its own contextual back row. Emitting a second
 * `↩️ Quay lại` there produced two buttons with the same label pointing at different destinations —
 * ambiguous for the owner and impossible to address unambiguously from a harness.
 */
const adminHomeOnly: InlineButton[] = [{ text: ADMIN_COPY.home, callbackData: "admin:menu" }];

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
/** Goal §71 summary block; every figure excludes test/canary trade. */
export interface AdminHomeSummary {
  revenueTodayVnd: bigint;
  ordersToday: number;
  awaitingAction: number;
  lowStockVariants: number;
  paymentsNeedingReview: number;
  newTickets: number;
}

export function presentAdminMenu(
  storeMode: StoreMode = "CLOSED",
  summary?: AdminHomeSummary,
): PresentedMessage {
  const storeBanner = STORE_MODE_BANNER[storeMode];
  const summaryLines = summary
    ? [
        "",
        `💰 Doanh thu hôm nay: ${summary.revenueTodayVnd.toLocaleString("vi-VN")} ₫`,
        `🧾 Đơn hôm nay: ${summary.ordersToday}`,
        `⏳ Chờ xử lý: ${summary.awaitingAction}`,
        `📦 Sắp hết: ${summary.lowStockVariants}`,
        `⚠️ Thanh toán cần kiểm tra: ${summary.paymentsNeedingReview}`,
        `🛡 Ticket mới: ${summary.newTickets}`,
      ]
    : [];
  return {
    text: [`${ADMIN_COPY.adminMenu}`, "", storeBanner, ...summaryLines].join("\n"),
    buttons: [
      ...visibleAdminButtons(),
      [
        { text: "⚙️ Cài đặt", callbackData: "admin:store:mode" },
        { text: "🛒 Về Shop", callbackData: "shop:home" },
      ],
    ],
  };
}

export const STORE_MODE_BANNER: Record<StoreMode, string> = {
  OPEN: "🟢 Đang mở bán",
  TEST: "🟡 Chế độ test",
  CLOSED: "🔴 Cửa hàng đang đóng",
};

/**
 * The guarded store control, as the owner must see it: the current status WITH the
 * version every transition is checked against, and only the buttons the store state
 * machine can actually accept. `TEST → OPEN` is not an allowed transition, so the
 * screen used to offer an "open" button whose confirmation could never succeed.
 */
export function presentAdminStoreMode(control: StoreControl): PresentedMessage {
  const mode = control.status;
  const buttons: InlineButton[][] = [];
  if (mode === "CLOSED") {
    buttons.push([{ text: "🧪 Chế độ test", callbackData: "admin:store:test" }]);
    buttons.push([{ text: "🟢 Mở bán", callbackData: "admin:store:open" }]);
  }
  if (mode !== "CLOSED")
    buttons.push([{ text: "🔴 Đóng cửa hàng", callbackData: "admin:store:close" }]);
  buttons.push([{ text: "⬅️ Quay lại", callbackData: "admin:menu" }]);
  return {
    text: [
      "🏪 Trạng thái cửa hàng",
      "",
      STORE_MODE_BANNER[mode],
      `Phiên bản điều khiển: ${control.version}`,
      `Cập nhật: ${control.updatedAt}${control.updatedBy ? ` · bởi ${control.updatedBy}` : ""}`,
      ...(mode === "TEST"
        ? ["", "Đang ở chế độ TEST. Muốn mở bán công khai, đóng cửa hàng trước rồi mở bán."]
        : []),
    ].join("\n"),
    buttons,
  };
}

/** The commissioning gate refused the open: show the counts, never a shortcut around them. */
export interface AdminOperationsSnapshot {
  control: StoreControl;
  database: "ok" | "down";
  publicationBlocked: number;
  /** Actionable: discrepancies with no resolution yet. */
  openDiscrepancies: number;
  /** Retained history: discrepancies already resolved. Evidence, not work. */
  resolvedDiscrepancies: number;
  /** Actionable: parked outbox rows with no disposition yet. */
  terminalOutboxOrphans: number;
  /** Retained history: parked outbox rows a disposition already closed. */
  terminalOutboxOrphansDisposed: number;
  /** Informational: ordinary tickets waiting on the shop or the customer. */
  openSupportTickets: number;
  /** Actionable: tickets parked for operator judgement (`MANUAL_REVIEW`). */
  criticalSupportTickets: number;
  /** All group posting/publication switches are disabled. */
  groupPublicationDisabled: boolean;
  stockAccountNotReady: number;
  growthDigest?: DailyGrowthDigest;
  inventoryForecast?: Array<{
    variantName: string;
    availableUnits: number;
    reorderUnits: number;
    averageDailyUnits: number;
  }>;
  funnelCounts?: Array<{ eventName: string; count: number }>;
}

export function presentAdminOperations(input: AdminOperationsSnapshot): PresentedMessage {
  const { control } = input;
  return {
    text: [
      "🛠 Vận hành / Readiness",
      "",
      `${STORE_MODE_BANNER[control.status]} · phiên bản ${control.version}`,
      ...(input.database === "down"
        ? ["⚠️ DATABASE DOWN — các bộ đếm queue không xác nhận trạng thái thực tế."]
        : []),
      `Publication còn blocker: ${input.publicationBlocked}`,
      `STOCK_ACCOUNT chưa sẵn sàng: ${input.stockAccountNotReady}`,
      ...(input.growthDigest
        ? [
            "",
            `📊 Hôm nay — hoàn tất: ${input.growthDigest.completedOrders} đơn · doanh thu: ${formatVnd(makeVnd(input.growthDigest.revenueVnd))}`,
            `Khách mới: ${input.growthDigest.newCustomers} · khách mua lại: ${input.growthDigest.repeatCustomers}`,
            `Coupon: ${input.growthDigest.couponRedemptions} · giới thiệu đủ điều kiện: ${input.growthDigest.qualifiedReferrals}`,
          ]
        : []),
      ...(input.inventoryForecast?.length
        ? [
            "",
            "📦 Dự báo nhập kho (lead 3 ngày + an toàn 2 ngày):",
            ...input.inventoryForecast.map(
              (row) =>
                `• ${row.variantName}: còn ${row.availableUnits}, cần nhập ${row.reorderUnits} (bán TB ${row.averageDailyUnits.toFixed(1)}/ngày)`,
            ),
          ]
        : []),
      ...(input.funnelCounts?.length
        ? [
            "",
            "📈 Phễu 14 ngày (aggregate):",
            ...input.funnelCounts.map((row) => `• ${row.eventName}: ${row.count}`),
          ]
        : []),
      "",
      // Actionable work and retained history are printed apart on purpose: one blended
      // figure makes a finished queue look like an incident and hides a real one behind it.
      `⚠️ Cần xử lý — sai lệch thanh toán: ${input.openDiscrepancies}`,
      `⚠️ Cần xử lý — outbox terminal chưa kết luận: ${input.terminalOutboxOrphans}`,
      `🚨 Cần xử lý — phiếu hỗ trợ chờ người xử lý: ${input.criticalSupportTickets}`,
      `👥 Publication group: ${input.groupPublicationDisabled ? "OFF" : "ON"}`,
      `✅ Đã xử lý (chỉ lưu vết) — sai lệch: ${input.resolvedDiscrepancies} · outbox: ${input.terminalOutboxOrphansDisposed}`,
      `ℹ️ Ticket thường đang mở (chờ shop/khách): ${input.openSupportTickets}`,
      "",
      "Không có thao tác tự động trên màn hình này; từng mutation vẫn đi qua owner confirmation.",
    ].join("\n"),
    buttons: [
      [
        { text: "💳 Thanh toán / sai lệch", callbackData: "admin:payments" },
        { text: "🛍 Readiness sản phẩm", callbackData: "admin:products" },
      ],
      [
        { text: "⭐ Kiểm duyệt đánh giá", callbackData: "admin:reviews" },
        { text: "🏪 Store control", callbackData: "admin:store:mode" },
      ],
      [{ text: "💬 Ticket hỗ trợ", callbackData: "admin:support" }],
      ...(input.groupPublicationDisabled
        ? []
        : [
            [
              {
                text: "🚫 Tắt publication group",
                callbackData: "admin:operations:group-publication-off",
              },
            ],
          ]),
      adminNav("admin:menu"),
    ],
  };
}

/**
 * The actionable half of the OPEN gate, as reasons. `isStoreOpenReady` decides with these same
 * five conditions, so the preview can never be more permissive than the durable transition.
 */
function storeOpenReasons(readiness: StoreOpenReadiness): string[] {
  return [
    ...(readiness.activeProducts === 0 ? ["Chưa có sản phẩm public đang hoạt động."] : []),
    ...(readiness.inStockVariants === 0 ? ["Chưa có biến thể nào còn hàng."] : []),
    ...(readiness.openDiscrepancies > 0
      ? [`Còn ${readiness.openDiscrepancies} sai lệch thanh toán chưa xử lý.`]
      : []),
    ...(readiness.terminalOutboxOrphans > 0
      ? [`Còn ${readiness.terminalOutboxOrphans} outbox terminal chưa có kết luận.`]
      : []),
    ...(readiness.criticalSupportTickets > 0
      ? [`Còn ${readiness.criticalSupportTickets} phiếu hỗ trợ chờ người xử lý.`]
      : []),
  ];
}

export function presentAdminStoreOpenBlocked(input: {
  readiness: StoreOpenReadiness;
  control: StoreControl;
}): PresentedMessage {
  const { readiness } = input;
  return {
    text: [
      "⚠️ Chưa thể mở bán",
      "",
      `Sản phẩm public đang hoạt động: ${readiness.activeProducts} (cần ≥ 1)`,
      `Biến thể đang còn hàng: ${readiness.inStockVariants} (cần ≥ 1)`,
      `Sai lệch thanh toán chưa xử lý: ${readiness.openDiscrepancies} (cần 0)`,
      `Outbox terminal chưa kết luận: ${readiness.terminalOutboxOrphans} (cần 0)`,
      `Phiếu hỗ trợ chờ người xử lý: ${readiness.criticalSupportTickets} (cần 0)`,
      "",
      ...storeOpenReasons(readiness).map((reason) => `⛔ ${reason}`),
      "Cửa hàng vẫn đang đóng cho tới khi các mục trên bằng 0.",
      `${STORE_MODE_BANNER[input.control.status]} · phiên bản ${input.control.version}`,
    ].join("\n"),
    buttons: [
      [{ text: "↩️ Trạng thái cửa hàng", callbackData: "admin:store:mode" }],
      adminNav("admin:menu"),
    ],
  };
}
export function presentAdminStoreOpenConfirmation(readiness: StoreOpenReadiness): PresentedMessage {
  return {
    text: [
      "⚠️ Xác nhận mở bán",
      "",
      `Sản phẩm public đang hoạt động: ${readiness.activeProducts}`,
      `Biến thể đang còn hàng: ${readiness.inStockVariants}`,
      `Sai lệch chưa xử lý: ${readiness.openDiscrepancies} · outbox terminal chưa kết luận: ${readiness.terminalOutboxOrphans} · phiếu hỗ trợ chờ người xử lý: ${readiness.criticalSupportTickets}`,
      "Cửa hàng chỉ mở nếu tất cả đều đạt; bấm Mở bán sẽ kiểm tra lại.",
    ].join("\n"),
    buttons: [
      [{ text: "✅ Mở bán", callbackData: "admin:store:open:confirm" }],
      [{ text: "❌ Huỷ", callbackData: "admin:store:mode" }],
    ],
  };
}
export function presentAdminTestCustomers(input: {
  customers: Array<{ id: string; telegramUserId: string }>;
}): PresentedMessage {
  return {
    text: `👥 Khách test\n\n${input.customers.length ? input.customers.map((c) => `• ${c.telegramUserId.replace(/^(\d{2})\d+(\d{2})$/u, "$1••••$2")}`).join("\n") : "Chưa có khách test."}`,
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
function orderCategoryTree<T extends { id: string; parentId?: string | null }>(rows: T[]): T[] {
  const children = new Map<string | null, T[]>();
  for (const row of rows) {
    const key = row.parentId ?? null;
    const list = children.get(key) ?? [];
    list.push(row);
    children.set(key, list);
  }
  const out: T[] = [];
  const walk = (parentId: string | null) => {
    for (const row of children.get(parentId) ?? []) {
      out.push(row);
      walk(row.id);
    }
  };
  walk(null);
  for (const row of rows) if (!out.includes(row)) out.push(row);
  return out;
}

export function presentAdminCategories(input: {
  categories: Array<{
    id: string;
    nameVi: string;
    active: boolean;
    productCount: number;
    parentId?: string | null;
  }>;
}): PresentedMessage {
  const categories = orderCategoryTree(input.categories);
  return {
    text: `🏷 Danh mục\n\n${categories.length ? categories.map((c) => `${c.parentId ? "  ↳ " : "• "}${c.nameVi} · ${c.productCount} sản phẩm · ${c.active ? "đang bật" : "đang tắt"}`).join("\n") : "Chưa có danh mục."}`,
    buttons: [
      ...categories.flatMap((c) => [
        [
          {
            text: `✏️ ${c.parentId ? "↳ " : ""}${c.nameVi}`,
            callbackData: `admin:categories:rename:${c.id}`,
          },
          {
            // The label names the node and the action. A bare "Bật/Tắt" is unreadable once the tree
            // has more than a couple of rows: the owner cannot tell which category a row toggles.
            text: `${c.active ? "⏸ Tắt" : "▶️ Bật"}: ${c.parentId ? "↳ " : ""}${c.nameVi}`,
            callbackData: `admin:categories:toggle:${c.id}`,
          },
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
    [
      { text: "🔎 Tìm đơn/khách", callbackData: "admin:orders:search" },
      { text: "🛠 Xử lý thủ công", callbackData: "admin:manual" },
    ],
  ]);
}
/**
 * The admin lists used to print `COMPLETED` / `PROCESSING` while the customer list said
 * "🎉 Hoàn tất" — the same internal code the owner-facing fix removed from the warranty surface.
 * One accessor over the customer map keeps the two from drifting again.
 */
function adminOrderStatusLabel(status: string): string {
  return (
    (ORDER_STATUS_LABEL as Record<string, string | undefined>)[status] ?? ORDER_STATUS_FALLBACK
  );
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
            `• ${order.orderNumber} · ${adminOrderStatusLabel(order.status)} · ${order.priceVnd.toLocaleString("vi-VN")} ₫ · ${order.displayName ?? order.telegramUserId ?? order.customerId}`,
        )),
  ];
  return {
    text: lines.join("\n"),
    buttons: [
      ...page.items.map((order) => [
        {
          text: `${order.orderNumber} · ${adminOrderStatusLabel(order.status)}`,
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
  const review = order.deliveryReview;
  const reviewLines = review
    ? [
        "",
        "Đối soát giao hàng",
        `Bằng chứng: ${review.evidenceComplete ? "đủ" : "chưa đủ"}`,
        `Tài sản: ${review.assetStatus ?? "chưa có"}${review.assetRef ? ` · ref …${review.assetRef.slice(-8)}` : ""}`,
        `Bundle: ${review.bundleStatus ?? "chưa có"}`,
        `Handoff: ${review.handoffStatus ?? "chưa có"}`,
        `message_id: ${review.providerMessageIdPresent ? "có" : "không"}`,
        `Telegram khớp: ${review.providerChatMatches ? "có" : "không"}`,
        `Provider success: ${review.providerSuccessAt ?? "không có"}`,
        `Send attempt: ${review.sendAttemptedAt ?? "không có"}`,
      ]
    : [];
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
      ...reviewLines,
    ].join("\n"),
    buttons: [
      [{ text: "✉️ Nhắn khách", callbackData: `admin:orders:message:${order.messageStateId}` }],
      ...(order.orderStatus === "PROCESSING" && order.fulfillmentStatus === "EXPIRED"
        ? [
            [
              {
                text: "🧭 Đưa vào rà soát giao hàng",
                callbackData: `admin:orders:reconcile:${order.messageStateId}`,
              },
            ],
          ]
        : []),
      ...(order.orderStatus === "FULFILLMENT_NEEDS_REVIEW"
        ? [
            ...(review?.evidenceComplete
              ? [
                  [
                    {
                      text: "✅ Xác nhận đã giao",
                      callbackData: `admin:orders:reconcile_delivered:${order.messageStateId}`,
                    },
                  ],
                ]
              : []),
            [
              {
                text: "🛑 Giữ chưa xác định",
                callbackData: `admin:orders:keep_uncertain:${order.messageStateId}`,
              },
            ],
          ]
        : []),
      [
        { text: ADMIN_COPY.orders, callbackData: "admin:orders" },
        { text: ADMIN_COPY.mainMenu, callbackData: "admin:menu" },
      ],
    ],
  };
}
export function presentAdminPaymentsMenu(statusText?: string | undefined): PresentedMessage {
  const body = statusText
    ? `${statusText}\nTheo dõi thanh toán và đối soát.`
    : "Theo dõi thanh toán và đối soát.";
  // Goal §95: the queues an operator actually reconciles from. They used to be invisible from here.
  return {
    text: `${ADMIN_COPY.payments}\n\n${body}`,
    buttons: [
      [
        { text: "⏳ Chờ thanh toán", callbackData: "admin:payments:pending" },
        { text: "⌛ Quá hạn", callbackData: "admin:payments:late" },
      ],
      [
        { text: "✅ Đã thanh toán", callbackData: "admin:payments:paid" },
        { text: "❓ Tiền chưa khớp", callbackData: "admin:payments:unmatched" },
      ],
      [
        { text: "⚠️ Sai lệch", callbackData: "admin:payments:discrepancy" },
        { text: "↩️ Cần hoàn tiền", callbackData: "admin:payments:refund" },
      ],
      [{ text: "🧯 Outbox treo", callbackData: "admin:payments:outbox" }],
      adminNav("admin:menu"),
    ],
  };
}

export function presentAdminPaymentOps(input: {
  title: string;
  rows: Array<{ id: string; label: string; detail: string }>;
  emptyHint: string;
  rowCallbackPrefix?: string;
}): PresentedMessage {
  const body = input.rows.length
    ? input.rows.map((row) => `• ${row.label}\n   ${row.detail}`).join("\n")
    : input.emptyHint;
  const rowButtons = input.rowCallbackPrefix
    ? input.rows.map((row) => [
        {
          text: `🔎 ${row.label.slice(0, 28)}`,
          callbackData: `${input.rowCallbackPrefix}${row.id}`,
        },
      ])
    : [];
  return {
    text: `${input.title}\n\n${body}`,
    buttons: [
      ...rowButtons,
      [{ text: "⬅️ Thanh toán", callbackData: "admin:payments" }],
      adminNav("admin:menu"),
    ],
  };
}

const DISCREPANCY_DISPOSITION_BUTTONS: ReadonlyArray<readonly [string, DiscrepancyResolutionCode]> =
  [
    ["✅ Đã đối soát", "MANUAL_SETTLE"],
    ["↩️ Hoàn tiền", "MANUAL_REFUND"],
    ["♻️ Trùng chứng từ", "DUPLICATE_EVIDENCE"],
    ["🚫 Chứng từ sai", "INVALID_EVIDENCE"],
    ["📌 Không cần xử lý", "NO_ACTION_REQUIRED"],
    ["🚨 Chuyển escalated", "ESCALATED"],
  ];

export function presentAdminDiscrepancyDetail(detail: AdminDiscrepancyDetail): PresentedMessage {
  const evidence = detail.evidence;
  const lines = [
    `⚠️ Sai lệch ${detail.id.slice(-6)}`,
    `Phân loại: ${detail.classification}${detail.classificationKnown ? "" : " (legacy)"}`,
    `Trạng thái: ${detail.status} · phiên bản ${detail.version}`,
    `Lý do: ${detail.reason}`,
    `Chủ xử lý: ${detail.owner} · hạn ${detail.dueAt ?? "—"}`,
    `Đơn: ${detail.orderNumber ?? "không gắn đơn"}`,
    `Payment intent: ${detail.paymentIntentId ? "có" : "không"}`,
  ];
  if (evidence) {
    lines.push(
      `Bằng chứng ${evidence.provider} · ${evidence.direction} · ${evidence.amountVnd.toLocaleString("vi-VN")} ₫`,
      `Provider GD: ${evidence.providerTransactionIdMasked} · tài khoản: ${evidence.merchantAccountMasked}`,
      `Reference: ${evidence.referenceMasked ?? "—"} · nội dung: ${evidence.transferContentSummary ?? "—"}`,
      `Ký: ${evidence.signatureStatus} · immutable: ${evidence.immutable ? "yes" : "no"}`,
    );
  }
  const buttons =
    detail.status === "OPEN"
      ? DISCREPANCY_DISPOSITION_BUTTONS.map(([text, code]) => [
          { text, callbackData: `admin:payments:r:${detail.id}:${code}` },
        ])
      : [];
  if (detail.resolutionCode)
    lines.push(`Kết luận: ${detail.resolutionCode} · ghi chú: ${detail.resolutionNote ?? "—"}`);
  return {
    text: lines.join("\n"),
    buttons: [
      ...buttons,
      [{ text: "⬅️ Sai lệch", callbackData: "admin:payments:discrepancy" }],
      adminNav("admin:menu"),
    ],
  };
}

const OUTBOX_DISPOSITION_BUTTONS: ReadonlyArray<readonly [string, OutboxDispositionCode]> = [
  ["✅ Đã xử lý thủ công", "HANDLED_MANUALLY"],
  ["🚫 Không còn áp dụng", "NO_LONGER_APPLICABLE"],
  ["♻️ Sự kiện trùng", "DUPLICATE_EVENT"],
  ["⛔ Event không hợp lệ", "INVALID_EVENT"],
  ["🚨 Escalate", "ESCALATED"],
];

export function presentAdminOutboxOrphans(input: {
  rows: Array<{
    id: string;
    eventType: string;
    lastErrorCode: string | null;
    attemptCount: number;
    dispositionStatus: string | null;
  }>;
}): PresentedMessage {
  const body = input.rows.length
    ? input.rows
        .map(
          (row) =>
            `• ${row.eventType} · ${row.lastErrorCode ?? "—"} · lần ${row.attemptCount}${row.dispositionStatus ? ` · ${row.dispositionStatus}` : ""}`,
        )
        .join("\n")
    : "Không có outbox treo cần xử lý.";
  const buttons = input.rows.map((row) => [
    { text: `🔎 ${row.eventType.slice(0, 28)}`, callbackData: `admin:payments:o:${row.id}` },
  ]);
  return {
    text: `🧯 Outbox treo\n\n${body}`,
    buttons: [
      ...buttons,
      [{ text: "⬅️ Thanh toán", callbackData: "admin:payments" }],
      adminNav("admin:menu"),
    ],
  };
}

export function presentAdminOutboxDetail(detail: TerminalOutboxOrphanDetail): PresentedMessage {
  const row = detail.orphan;
  const lines = [
    `🧯 Outbox ${row.id.slice(-6)}`,
    `Event: ${row.eventType} · aggregate ${row.aggregateType}`,
    `Lỗi cuối: ${row.lastErrorCode ?? "—"} · attempts ${row.attemptCount}`,
    `Parked: ${row.deadLetteredAt} · disposition version ${row.dispositionVersion}`,
    `Trạng thái: ${row.dispositionStatus ?? "OPEN"}`,
    "Payload gốc được giữ nguyên trong hệ thống; màn hình không render payload khách hàng.",
  ];
  const buttons =
    row.dispositionStatus === null
      ? OUTBOX_DISPOSITION_BUTTONS.map(([text, code]) => [
          { text, callbackData: `admin:payments:x:${row.id}:${code}` },
        ])
      : [];
  if (row.dispositionCode)
    lines.push(`Kết luận: ${row.dispositionCode} · ghi chú: ${row.dispositionNote ?? "—"}`);
  return {
    text: lines.join("\n"),
    buttons: [
      ...buttons,
      [{ text: "⬅️ Outbox treo", callbackData: "admin:payments:outbox" }],
      adminNav("admin:menu"),
    ],
  };
}
/* -------------------------------------------------------------------------- *
 * Product publication readiness + resale evidence (production remediation).
 *
 * The adapter may render a readiness snapshot, but it must never invent the
 * evidence a variant needs: the source/reference/summary triple is typed by the
 * operator, and publication replays the snapshot version the operator saw.
 * -------------------------------------------------------------------------- */

export const PUBLICATION_BLOCKER_LABEL: Record<PublicationBlocker, string> = {
  PRODUCT_NOT_FOUND: "Không tìm thấy sản phẩm",
  PRODUCT_INACTIVE: "Sản phẩm đang tạm dừng",
  PRODUCT_ARCHIVED: "Sản phẩm đã lưu trữ",
  PRODUCT_TEST_ONLY: "Sản phẩm chỉ dành cho TEST",
  STORE_TEST_MODE: "Đang ở chế độ TEST; đóng cửa hàng trước khi xuất bản công khai",
  CATEGORY_INACTIVE: "Danh mục sản phẩm đang tắt",
  NO_ACTIVE_VARIANTS: "Không có biến thể đang bán",
  VARIANT_INACTIVE: "Biến thể đang tạm dừng",
  VARIANT_PRICE_INVALID: "Giá biến thể không hợp lệ",
  FULFILLMENT_NOT_READY: "Chưa có hàng/kho cho biến thể",
  SELLABLE_ROUTE_MISSING: "Thiếu tuyến bán (kho hoặc nhà cung cấp)",
  RESALE_EVIDENCE_MISSING: "Thiếu bằng chứng nguồn nhập hàng",
};

export const RESALE_EVIDENCE_SOURCE_LABEL: Record<ResaleEvidenceSource, string> = {
  SUPPLIER_AUTHORIZATION: "Uỷ quyền nhà cung cấp",
  OWNER_ATTESTATION: "Chủ shop xác nhận sở hữu",
  CONTRACT_REFERENCE: "Tham chiếu hợp đồng",
};

export function presentAdminProductReadiness(input: {
  name: string;
  readiness: ProductPublicationReadiness;
  /** False when the snapshot version cannot travel in a Telegram callback at all. */
  canSubmit: boolean;
}): PresentedMessage {
  const readiness = input.readiness;
  const active = readiness.variants.filter((variant) => variant.active);
  const withEvidence = active.filter((variant) => variant.evidenceActive).length;
  const blockers = Array.from(new Set(readiness.blockers));
  // VISIBILITY-ONLY: the technical checklist below is what `canPublish` answers. TEST_ONLY does
  // not block publication (publishing is what promotes the product to public), so it is printed
  // on its own line and never mixed into the blocker list — the owner must be able to read what
  // still stops a publish separately from what publishing will change.
  const visibility = Array.from(new Set(readiness.visibilityBlockers));
  const lines = [
    "🚀 Xuất bản sản phẩm",
    "",
    `Tên: ${input.name}`,
    `Mã: ${readiness.productId}`,
    `Trạng thái: ${readiness.active ? "đang bán" : "tạm dừng"}${readiness.archived ? " · đã lưu trữ" : ""}${readiness.testOnly ? " · TEST" : ""}`,
    `Phiên bản sản phẩm: ${readiness.productVersion}`,
    `Biến thể đang bán: ${active.length} · đã có bằng chứng: ${withEvidence}`,
    "",
    readiness.canPublish
      ? "✅ Đủ điều kiện xuất bản."
      : ["⛔ Còn thiếu:", ...blockers.map((code) => `• ${PUBLICATION_BLOCKER_LABEL[code]}`)].join(
          "\n",
        ),
    ...(visibility.length
      ? [
          "",
          "🔎 Riêng hiển thị công khai:",
          ...visibility.map((code) => `• ${PUBLICATION_BLOCKER_LABEL[code]}`),
          ...(readiness.testOnly ? ["Xuất bản sẽ chuyển sản phẩm này sang bán công khai."] : []),
        ]
      : []),
  ];
  if (active.length) {
    lines.push(
      "",
      ...active.map(
        (variant) =>
          `• ${variant.id.slice(-6)} v${variant.version} — ${variant.evidenceActive ? "có bằng chứng" : "CHƯA có bằng chứng"}${variant.published ? " · đã xuất bản" : ""}`,
      ),
    );
  }
  const buttons: InlineButton[][] = active.map((variant) => {
    const revoke = variant.evidenceId
      ? `admin:products:evrevoke:${variant.evidenceId}:${variant.version}`
      : null;
    return [
      {
        text: `🧾 Bằng chứng ${variant.id.slice(-6)}`,
        callbackData: `admin:products:evidence:${variant.id}`,
      },
      // Telegram caps callback_data at 64 bytes and the ingress drops anything longer, so a
      // variant whose evidence id + version no longer fit is offered without the revoke
      // button rather than with one that would silently do nothing.
      ...(variant.evidenceActive &&
      variant.evidenceId !== null &&
      isId(variant.evidenceId) &&
      revoke !== null &&
      Buffer.byteLength(revoke, "utf8") <= 64
        ? [{ text: "🚫 Thu hồi", callbackData: revoke }]
        : []),
    ];
  });
  if (readiness.canPublish && input.canSubmit) {
    buttons.push([
      { text: "🚀 Xuất bản", callbackData: `admin:products:publish:${readiness.productId}` },
    ]);
  }
  if (readiness.canPublish && !input.canSubmit) {
    lines.push(
      "",
      "Snapshot quá dài để xác nhận qua Telegram (quá nhiều biến thể đang bán). Tạm dừng bớt biến thể rồi mở lại màn hình này.",
    );
  }
  buttons.push([
    { text: "↩️ Sản phẩm", callbackData: `admin:products:detail:${readiness.productId}` },
    ...adminHomeOnly,
  ]);
  return { text: lines.join("\n"), buttons };
}

/**
 * The evidence prompt. It states the exact wire format and refuses to prefill
 * anything: a fabricated source/reference pair would make publication a lie.
 */
export function presentAdminEvidencePrompt(input: {
  productId: string;
  variantId: string;
  variantName: string;
}): PresentedMessage {
  return {
    text: [
      "🧾 Đăng ký bằng chứng nhập hàng",
      "",
      `Biến thể: ${input.variantName}`,
      "Gửi một dòng theo dạng:",
      "NGUỒN|MÃ THAM CHIẾU|TÓM TẮT AN TOÀN",
      "",
      `NGUỒN hợp lệ: ${Object.keys(RESALE_EVIDENCE_SOURCE_LABEL).join(", ")}`,
      "OWNER_ATTESTATION: Chủ shop xác nhận sở hữu.",
      "OWNER_ATTESTATION chỉ ghi nhận hàng do chủ shop nắm giữ; không phải uỷ quyền resale/chuyển nhượng từ nhà cung cấp.",
      "Mã tham chiếu: chỉ chữ, số và . _ : / - (tối đa 200 ký tự).",
      "Tóm tắt: tối đa 500 ký tự, không dán mật khẩu hay khoá API.",
      "",
      "Bot không tự tạo bằng chứng: không gửi thì biến thể vẫn không thể xuất bản.",
    ].join("\n"),
    buttons: [
      [
        { text: "↩️ Quay lại", callbackData: `admin:products:ready:${input.productId}` },
        ...adminHomeOnly,
      ],
    ],
  };
}

/**
 * The revocation prompt. It names the evidence that will be withdrawn (masked id, source,
 * recorded time) and asks only for the reason: the evidence facts are immutable, so nothing
 * the owner types here can rewrite them — the reason is a new provenance fact of its own.
 */
export function presentAdminEvidenceRevokePrompt(input: {
  productId: string;
  variantName: string;
  evidenceId: string;
  source: ResaleEvidenceSource;
  recordedAt: string;
  variantVersion: number;
}): PresentedMessage {
  return {
    text: [
      "🚫 Thu hồi bằng chứng nhập hàng",
      "",
      `Biến thể: ${input.variantName}`,
      `Bằng chứng: …${input.evidenceId.slice(-6)} · ${RESALE_EVIDENCE_SOURCE_LABEL[input.source]}`,
      `Ghi nhận lúc: ${input.recordedAt}`,
      `Phiên bản biến thể: ${input.variantVersion}`,
      "",
      "Gửi lý do thu hồi (một dòng, tối đa 200 ký tự).",
      "Thu hồi không sửa dữ liệu bằng chứng: chỉ đổi trạng thái và làm bản xuất bản hiện tại cũ đi. Hãy đăng ký bằng chứng mới rồi xuất bản lại.",
      "Bot sẽ trả mã xác nhận; hoàn tất bằng /confirm <mã xác nhận>.",
    ].join("\n"),
    buttons: [
      [
        { text: "↩️ Readiness", callbackData: `admin:products:ready:${input.productId}` },
        ...adminHomeOnly,
      ],
    ],
  };
}

/** The note a protected disposition needs before a confirmation can be issued. */
export function presentAdminNotePrompt(input: {
  title: string;
  action: string;
  back: string;
}): PresentedMessage {
  return {
    text: [
      input.title,
      "",
      `Xử lý: ${input.action}`,
      "Gửi ghi chú xử lý (một dòng, tối đa 200 ký tự).",
      "Bot sẽ trả mã xác nhận; hoàn tất bằng /confirm <mã xác nhận>.",
    ].join("\n"),
    buttons: [adminNav(input.back)],
  };
}

export interface AdminSupplierOverview {
  id: string;
  providerKey?: string;
  name: string;
  adapterType: string;
  capabilities?: readonly SupplierCapability[];
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
  const providerButtons = suppliers.slice(0, 20).flatMap((supplier) => {
    const providerKey = supplier.providerKey ?? supplier.name;
    const base = `admin:supplier:${providerKey}`;
    const capabilities = new Set(supplier.capabilities ?? []);
    const buttons: InlineButton[][] = [];
    if (capabilities.has("CATALOG_LIST")) {
      buttons.push([{ text: `${supplier.name} · Catalog`, callbackData: `${base}:products` }]);
    }
    if (capabilities.has("BALANCE_READ")) {
      buttons.push([{ text: `${supplier.name} · Balance`, callbackData: `${base}:balance` }]);
    }
    if (capabilities.has("HEALTH_READ")) {
      buttons.push([{ text: `${supplier.name} · Health`, callbackData: `${base}:health` }]);
    }
    return buttons;
  });
  if (suppliers.length === 0) {
    return presentAdminSection(ADMIN_COPY.suppliers, "Chưa có nhà cung cấp đang hoạt động.", []);
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
    [
      ...visible.flatMap((supplier) =>
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
      ...providerButtons,
    ],
  );
}
export interface AdminSupplierCatalogPageInput {
  providerKey: string;
  providerName: string;
  capabilities: readonly SupplierCapability[];
  items: SupplierCatalogRow[];
  nextOffset: number | null;
  total: number;
  syncEnabled: boolean;
}

function supplierStateLabel(row: SupplierCatalogRow): string {
  if (row.is_missing) return "MISSING";
  if (row.selection_status === "DISCOVERED") return "DISCOVERED · tắt";
  return row.is_enabled ? "SELECTED · bật" : "SELECTED · tắt";
}

function supplierBase(providerKey: string): string {
  return `admin:supplier:${providerKey}`;
}

export function presentAdminSupplierCatalogPage(
  input: AdminSupplierCatalogPageInput,
): PresentedMessage {
  const base = supplierBase(input.providerKey);
  const lines = [
    `Nhà cung cấp: ${input.providerName}`,
    `Tổng upstream: ${input.total}`,
    `Capabilities: ${input.capabilities.join(", ") || "HEALTH_READ"}`,
    "",
    ...(input.items.length
      ? input.items.map(
          (row, index) =>
            `${index + 1}. ${row.upstream_name_vi} — ${row.availability} — ${supplierStateLabel(row)} — cost ${BigInt(row.supplier_cost_vnd).toLocaleString("vi-VN")} ₫`,
        )
      : ["Chưa có catalog upstream. Hãy đồng bộ read-only sau khi cấu hình Vault reference."]),
  ];
  const buttons: InlineButton[][] = input.items.map((row) => [
    { text: `⚙️ ${row.upstream_name_vi.slice(0, 42)}`, callbackData: `${base}:item:${row.id}` },
  ]);
  if (input.syncEnabled)
    buttons.push([{ text: "🔄 Đồng bộ upstream", callbackData: `${base}:sync` }]);
  if (input.nextOffset !== null) {
    buttons.push([{ text: "➡️ Trang tiếp", callbackData: `${base}:page:${input.nextOffset}` }]);
  }
  buttons.push(adminNav("admin:suppliers"));
  return { text: lines.join("\n"), buttons };
}

export function presentAdminSupplierCatalogDetail(input: {
  providerKey: string;
  providerName: string;
  row: SupplierCatalogRow;
  ownerSelectionEnabled: boolean;
}): PresentedMessage {
  const { row } = input;
  const base = supplierBase(input.providerKey);
  const lines = [
    `Nhà cung cấp: ${input.providerName}`,
    `Upstream ID: ${row.external_product_id}`,
    `Upstream variant ID: ${row.external_variant_id || "default"}`,
    `Tên upstream: ${row.upstream_name_vi}`,
    `Availability: ${row.is_missing ? "MISSING" : row.availability}`,
    `Cost tham chiếu: ${BigInt(row.supplier_cost_vnd).toLocaleString("vi-VN")} ₫`,
    `Trạng thái: ${supplierStateLabel(row)}`,
    "",
    row.local_name_vi ? `Tên local: ${row.local_name_vi}` : "Chưa cấu hình local product.",
    row.local_variant_name_vi ? `Gói local: ${row.local_variant_name_vi}` : "",
    "Giá bán local chỉ do owner đặt; cost upstream không tự đổi giá bán.",
  ].filter(Boolean);
  const buttons: InlineButton[][] = [];
  if (input.ownerSelectionEnabled) {
    buttons.push([
      {
        text: row.selection_status === "SELECTED" ? "✏️ Cấu hình lại" : "✅ Chọn & cấu hình",
        callbackData: `${base}:configure:${row.id}`,
      },
    ]);
    if (!row.local_variant_id) {
      buttons.push([
        {
          text: "🔗 Gắn vào SKU local",
          callbackData: `${base}:targets:${row.id}`,
        },
      ]);
    }
    if (row.selection_status === "SELECTED") {
      buttons.push([
        {
          text: row.is_enabled ? "⏸ Tắt bán" : "▶️ Bật bán",
          callbackData: `${base}:${row.is_enabled ? "disable" : "enable"}:${row.id}`,
        },
      ]);
    }
    if (row.supplier_sku_id && row.local_variant_id && !row.is_primary) {
      buttons.push([
        {
          text: "⭐ Chọn làm primary",
          callbackData: `${base}:primary:${row.id}`,
        },
      ]);
    }
  }
  buttons.push(
    [{ text: "↩️ Danh sách upstream", callbackData: `${base}:products` }],
    adminHomeOnly,
  );
  return { text: lines.join("\n"), buttons };
}

export function presentAdminSupplierVariantTargets(input: {
  providerKey: string;
  providerName: string;
  catalogId: string;
  items: SupplierLocalVariantTarget[];
  nextOffset: number | null;
}): PresentedMessage {
  const base = supplierBase(input.providerKey);
  const lines = [
    `Gắn ${input.providerName} vào SKU local`,
    "Chọn đúng một variant local. Giá bán và tồn local hiện tại không bị đổi.",
    "",
    ...(input.items.length
      ? input.items.map(
          (target, index) =>
            `${index + 1}. ${target.productNameVi} — ${target.variantNameVi} (${target.sku})${target.primarySupplierId ? ` — primary ${target.primarySupplierId}` : ""}`,
        )
      : ["Không có variant local khả dụng."]),
  ];
  const buttons: InlineButton[][] = input.items.map((target) => [
    {
      text: `🔗 ${target.productNameVi.slice(0, 24)} / ${target.variantNameVi.slice(0, 24)}`,
      callbackData: `${base}:attach-target:${input.catalogId}:${target.variantId}`,
    },
  ]);
  if (input.nextOffset !== null) {
    buttons.push([
      {
        text: "➡️ Trang tiếp",
        callbackData: `${base}:targets:${input.catalogId}:${input.nextOffset}`,
      },
    ]);
  }
  buttons.push(
    [{ text: "↩️ Chi tiết upstream", callbackData: `${base}:item:${input.catalogId}` }],
    adminHomeOnly,
  );
  return { text: lines.join("\n"), buttons };
}

export function presentAdminSupplierConfigPrompt(input: {
  providerKey: string;
  providerName: string;
  targetVariantId?: string;
}): PresentedMessage {
  const base = supplierBase(input.providerKey);
  return {
    text: [
      `Nhà cung cấp: ${input.providerName}`,
      input.targetVariantId ? `Variant local đích: ${input.targetVariantId}` : "",
      "",
      "Gửi đúng 4 phần, ngăn bằng dấu |:",
      "Tên local | Tên gói local | Giá bán VND | Mô tả ngắn",
      `Ví dụ: ${input.providerName} | Gói 1 tháng | 199000 | Kích hoạt tự động sau thanh toán.`,
      "Giá là số nguyên VND. Cost upstream không được dùng làm giá bán.",
    ]
      .filter(Boolean)
      .join("\n"),
    buttons: [[{ text: "↩️ Danh sách upstream", callbackData: `${base}:products` }], adminHomeOnly],
  };
}
export function presentAdminSupplierConfigPreview(input: {
  providerKey: string;
  providerName: string;
  stateId: string;
  localNameVi: string;
  localVariantNameVi: string;
  localPriceVnd: bigint;
  localDescriptionVi: string;
  attachOnly?: boolean;
}): PresentedMessage {
  const base = supplierBase(input.providerKey);
  return {
    text: [
      `Nhà cung cấp: ${input.providerName}`,
      "",
      input.attachOnly
        ? "Gắn mapping vào SKU local; các giá trị local dưới đây là chỉ đọc:"
        : "Xem trước cấu hình local:",
      `Tên: ${input.localNameVi}`,
      `Gói: ${input.localVariantNameVi}`,
      `Giá bán: ${input.localPriceVnd.toLocaleString("vi-VN")} ₫`,
      `Mô tả: ${input.localDescriptionVi}`,
      "",
      "Chọn lưu và bật bán chỉ khi upstream đang AVAILABLE/LOW. Lưu tắt vẫn giữ mapping và lịch sử.",
    ].join("\n"),
    buttons: [
      [
        { text: "✅ Lưu & bật bán", callbackData: `${base}:confirm:${input.stateId}:on` },
        { text: "💾 Lưu tắt", callbackData: `${base}:confirm:${input.stateId}:off` },
      ],
      [{ text: "❌ Huỷ", callbackData: `${base}:products` }],
    ],
  };
}

export function presentAdminSupplierCatalogActionDone(input: {
  providerKey: string;
  providerName: string;
  catalogId: string;
  enabled: boolean;
  productId?: string;
  variantId?: string;
}): PresentedMessage {
  const base = supplierBase(input.providerKey);
  return {
    text: [
      `✅ ${input.providerName} curation`,
      input.enabled
        ? "Đã lưu mapping và bật bán theo trạng thái upstream."
        : "Đã lưu mapping ở trạng thái tắt.",
      input.productId ? `Local product: ${input.productId}` : "",
      input.variantId ? `Local variant: ${input.variantId}` : "",
    ]
      .filter(Boolean)
      .join("\n"),
    buttons: [
      [
        {
          text: `Mở sản phẩm ${input.providerName}`,
          callbackData: `${base}:item:${input.catalogId}`,
        },
      ],
      [{ text: "Danh sách upstream", callbackData: `${base}:products` }, ...adminHomeOnly],
    ],
  };
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

/**
 * Owner-facing ticket status labels. Deliberately unlike the customer's copy in
 * presenters/support.ts: the shop reads what it must do, the customer reads what
 * it means for them. Keys double as the label set the transition buttons render.
 */
export const SUPPORT_STATUS_LABELS: Record<SupportTicketStatus, string> = {
  OPEN: "Mới tiếp nhận",
  WAITING_SHOP: "Shop đang xử lý",
  WAITING_CUSTOMER: "Chờ khách bổ sung",
  RESOLVED: "Đã xử lý",
  CLOSED: "Đã đóng",
  MANUAL_REVIEW: "Đang xem xét thêm",
};

export function presentAdminSupportQueue(rows: AdminSupportReplacementRow[]): PresentedMessage {
  // The replacement queue is where `admin:support` lands; the ticket queue hangs
  // off it, so that screen keeps its meaning.
  const entry: InlineButton = { text: "🧾 Yêu cầu hỗ trợ", callbackData: "admin:support:tickets" };
  if (rows.length === 0) {
    return {
      text: [ADMIN_COPY.support, "", "Không có yêu cầu thay thế đang chờ duyệt."].join("\n"),
      buttons: [[entry, { text: ADMIN_COPY.mainMenu, callbackData: "admin:menu" }]],
    };
  }
  const lines = [ADMIN_COPY.support, "", "Yêu cầu thay thế chờ duyệt:"];
  const buttons: InlineButton[][] = [[entry]];
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

/** Open tickets, most urgent SLA first; one button opens each ticket. */
export function presentAdminSupportTickets(rows: AdminSupportTicketRow[]): PresentedMessage {
  if (rows.length === 0) {
    return {
      text: [ADMIN_COPY.support, "", "Không có yêu cầu hỗ trợ nào đang mở."].join("\n"),
      buttons: [adminNav("admin:support")],
    };
  }
  const lines = [ADMIN_COPY.support, "", `Yêu cầu đang mở: ${rows.length}`];
  const buttons: InlineButton[][] = [];
  for (const row of rows) {
    lines.push(
      `• ${row.customerLabel} · ${REASON_LABEL[row.reasonCode]} · ${SUPPORT_STATUS_LABELS[row.status]}`,
    );
    if (row.orderNumber) lines.push(`  Đơn: ${row.orderNumber}`);
    lines.push(`  ${row.safeSummary}`);
    buttons.push([
      {
        text: `🧾 ${row.customerLabel} · ${SUPPORT_STATUS_LABELS[row.status]}`,
        callbackData: `admin:support:ticket:${row.id}`,
      },
    ]);
  }
  buttons.push(adminNav("admin:support"));
  return { text: lines.join("\n"), buttons };
}

/**
 * One ticket with only the transitions the state machine allows. A closed ticket
 * therefore renders no status button at all — the owner gets navigation, not a
 * dead action.
 */
export function presentAdminSupportTicket(ticket: AdminSupportTicketRow): PresentedMessage {
  const when = (iso: string) =>
    new Date(iso).toLocaleString("vi-VN", {
      timeZone: "Asia/Ho_Chi_Minh",
      day: "2-digit",
      month: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  const lines = [
    `🧾 Yêu cầu hỗ trợ · ${ticket.customerLabel}`,
    "",
    `Lý do: ${REASON_LABEL[ticket.reasonCode]}`,
    `Trạng thái: ${SUPPORT_STATUS_LABELS[ticket.status]}`,
  ];
  if (ticket.orderNumber) lines.push(`Đơn: ${ticket.orderNumber}`);
  if (ticket.dueAt) lines.push(`Hạn phản hồi: ${when(ticket.dueAt)}`);
  lines.push("", ticket.safeSummary);
  const buttons = (Object.keys(SUPPORT_STATUS_LABELS) as SupportTicketStatus[])
    .filter((to) => canTicketTransition(ticket.status, to))
    .map((to): InlineButton[] => [
      {
        text: SUPPORT_STATUS_LABELS[to],
        callbackData: `admin:support:status:${ticket.id}:${to}`,
      },
    ]);
  buttons.push(adminNav("admin:support:tickets"));
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
      [
        { text: "Tất cả", callbackData: "admin:marketing:audience:all" },
        { text: "🔒 Gửi thử cho chủ", callbackData: "admin:marketing:audience:root" },
      ],
      [
        { text: "🛍 Cập nhật sản phẩm", callbackData: "admin:marketing:audience:shop" },
        { text: "📣 Hoạt động mua hàng", callbackData: "admin:marketing:audience:activity" },
      ],
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
      [{ text: "⬅️ Quay lại", callbackData: "admin:products:back" }],
      [{ text: "❌ Huỷ", callbackData: "admin:products:cancel" }],
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
  visibility?: "PUBLIC" | "TEST_ONLY" | "DRAFT";
  isFeatured?: boolean;
  preorderEnabled?: boolean;
  lowStockThreshold?: number | undefined;
  descriptionVi?: string | undefined;
  warrantyVi?: string | undefined;
  /** Warranty policy (goal §79): the preview states the structured term. */
  warrantyEnabled?: boolean | undefined;
  warrantyDays?: number | undefined;
  warrantyProrationEnabled?: boolean | undefined;
  deliveryEtaVi?: string | undefined;
  serviceInstructions?: string | undefined;
  initialQuantity?: number | undefined;
  fileArtifact?: { filename: string } | undefined;
  supplierConfig?:
    { supplierId: string; externalSku: string; costVnd: bigint; region?: string } | undefined;
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
      "📋 Xem trước sản phẩm",
      "",
      ...(draft.name ? [`Tên: ${draft.name}`] : []),
      `Biến thể: ${draft.variantName}`,
      `SKU: ${draft.sku}`,
      `Danh mục: ${draft.categoryName ?? "Chưa phân loại"}`,
      `Loại: ${FULFILLMENT_TYPE_LABELS[draft.fulfillmentType]}`,
      `Giá: ${draft.priceVnd.toLocaleString("vi-VN")} ₫${draft.compareAtPriceVnd ? ` (gốc ${draft.compareAtPriceVnd.toLocaleString("vi-VN")} ₫)` : ""}`,
      `Giao hàng: ${deliveryLine}`,
      ...(draft.descriptionVi ? [`Mô tả: ${draft.descriptionVi}`] : []),
      ...(draft.deliveryEtaVi ? [`Thời gian giao: ${draft.deliveryEtaVi}`] : []),
      // Goal §79: the preview states the structured term, not just the marketing copy.
      `Bảo hành: ${
        draft.warrantyEnabled
          ? `${draft.warrantyDays ?? 0} ngày${
              draft.warrantyProrationEnabled === false
                ? " (không chia theo thời gian)"
                : " · hoàn theo thời gian còn lại"
            }`
          : (draft.warrantyVi ?? "Không")
      }`,
      `Hiển thị: ${draft.visibility === "TEST_ONLY" ? "🧪 Chỉ test" : draft.visibility === "DRAFT" ? "📝 Bản nháp" : "🟢 Công khai"}`,
      `Ghim trang chủ: ${draft.isFeatured ? "⭐ Có" : "Không"}`,
      `Đặt cọc khi hết hàng: ${draft.preorderEnabled ? "Bật" : "Tắt"}`,
      `Cảnh báo hết hàng: ${draft.lowStockThreshold ?? "Mặc định"}`,
    ].join("\n"),
    buttons: [
      [
        {
          text: draft.existingProductId ? "✅ Tạo biến thể" : "✅ Tạo sản phẩm",
          callbackData: "admin:products:confirm",
        },
      ],
      ...(!draft.existingProductId
        ? [
            [
              { text: "✏️ Chỉnh sửa", callbackData: "admin:products:back" },
              { text: "💾 Lưu nháp", callbackData: "admin:products:draft" },
            ],
          ]
        : [[{ text: "✏️ Chỉnh sửa", callbackData: "admin:products:back" }]]),
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

export type { AdminProductView } from "./admin-product-list.js";

export function presentAdminProducts(
  rows: Array<{ id: string; name: string; active: boolean; featured?: boolean; test?: boolean }>,
  options: { view?: AdminProductView; page?: number; hasMore?: boolean; total?: number } = {},
): PresentedMessage {
  return renderAdminProductList(rows, options, {
    title: ADMIN_COPY.products,
    overview: ADMIN_COPY.overview,
    inventory: ADMIN_COPY.inventory,
    navigation: adminNav("admin:menu"),
  });
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
      return `Dán theo các trường: ${fields} (hỗ trợ phân cách bằng |, khoảng trắng, tab, hoặc :); hoặc tải CSV mẫu, điền đúng cột rồi dán/gửi tệp .csv/.txt.`;
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
      "📦 Quản lý kho",
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
      ? "📥 Chọn sản phẩm để tải mẫu CSV"
      : action === "paste"
        ? "📋 Chọn sản phẩm để dán dữ liệu"
        : "➕ Chọn sản phẩm để nhập kho";
  return {
    text: [title, "", "Vui lòng chọn sản phẩm bên dưới:"].join("\n"),
    buttons: [
      ...products.map((p) => [
        { text: `📦 ${p.name}`, callbackData: `admin:inventory:pick_prod:${action}:${p.id}` },
      ]),
      [
        { text: "↩️ Quay lại kho", callbackData: "admin:inventory" },
        { text: "🏠 Quản trị", callbackData: "admin:menu" },
      ],
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
      ? "📥 Chọn biến thể để tải mẫu CSV"
      : action === "paste"
        ? "📋 Chọn biến thể để dán dữ liệu"
        : "➕ Chọn biến thể để nhập kho";
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
        { text: "🏠 Quản trị", callbackData: "admin:menu" },
      ],
    ],
  };
}

export function presentAdminTestLab(input: {
  testProducts: Array<{ id: string; name: string; active: boolean }>;
  canaryOrders: Array<{ orderNumber: string; status: string; priceVnd: number }>;
}): PresentedMessage {
  return {
    text: [
      "🧪 Test lab (canary & kiểm thử nội bộ)",
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
            (o) =>
              `• ${o.orderNumber} · ${adminOrderStatusLabel(o.status)} · ${o.priceVnd.toLocaleString("vi-VN")} ₫`,
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
    "💰 Đặt cọc / giữ hàng",
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

  const filterButtons: InlineButton[] = [
    { text: "Tất cả", callbackData: "admin:preorders:filter:all" },
    { text: "Chờ cọc", callbackData: "admin:preorders:filter:waiting_deposit" },
    { text: "Đã cọc", callbackData: "admin:preorders:filter:deposit_paid" },
    { text: "Đã giữ hàng", callbackData: "admin:preorders:filter:allocated" },
    { text: "Chờ thanh toán", callbackData: "admin:preorders:filter:balance_due" },
    { text: "Hoàn tất", callbackData: "admin:preorders:filter:fulfilled" },
    { text: "Bỏ cọc", callbackData: "admin:preorders:filter:forfeited" },
    { text: "Cần hoàn", callbackData: "admin:preorders:filter:refund_due" },
  ];
  return {
    text: lines.join("\n"),
    buttons: [
      ...cancelButtons,
      ...compactInlineRows(filterButtons),
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
      adminHomeOnly,
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
      [{ text: "🧰 Quản lý dữ liệu", callbackData: `admin:inventory:items:${input.id}` }],
      [{ text: ADMIN_COPY.back, callbackData: `admin:inventory:product:${input.productId}` }],
      adminHomeOnly,
    ],
  };
}

/** Goal §89 — items of one variant, addressed by a derived ref, never by key or secret. */
export function presentAdminInventoryItems(input: {
  variantId: string;
  variantName: string;
  items: Array<{ ref: string; statusLabel: string; actions: string[] }>;
}): PresentedMessage {
  if (input.items.length === 0) {
    return {
      text: [
        ADMIN_COPY.inventory,
        `Biến thể: ${input.variantName}`,
        "Chưa có dữ liệu kho. Nhập kho để bắt đầu bán.",
      ].join("\n"),
      buttons: [
        [{ text: "📥 Nhập kho", callbackData: `admin:inventory:import:${input.variantId}` }],
        [{ text: ADMIN_COPY.back, callbackData: `admin:inventory:variant:${input.variantId}` }],
        adminHomeOnly,
      ],
    };
  }
  const manageable = input.items.filter((item) => item.actions.length > 0).length;
  return {
    text: [
      ADMIN_COPY.inventory,
      `Biến thể: ${input.variantName}`,
      `Dữ liệu: ${input.items.length} mục — ${manageable} mục có thể xử lý.`,
      "Chọn một mục để cách ly, phục hồi hoặc thu hồi. Nội dung đăng nhập không hiển thị ở đây.",
    ].join("\n"),
    buttons: [
      ...input.items.map((item) => [
        {
          text: `${item.ref} · ${item.statusLabel}`,
          callbackData: `admin:inventory:item:${item.ref}`,
        },
      ]),
      [{ text: ADMIN_COPY.back, callbackData: `admin:inventory:variant:${input.variantId}` }],
      adminHomeOnly,
    ],
  };
}

/** Actions for one item. Only the transitions legal from its current status are offered. */
export function presentAdminInventoryItemActions(input: {
  variantId: string;
  variantName: string;
  ref: string;
  statusLabel: string;
  actions: Array<{ action: string; label: string }>;
  readyRecovery?: { version: number } | undefined;
}): PresentedMessage {
  return {
    text: [
      ADMIN_COPY.inventory,
      `Mục: ${input.ref}`,
      `Biến thể: ${input.variantName}`,
      `Trạng thái: ${input.statusLabel}`,
      ...(input.readyRecovery
        ? [
            `Phiên bản kiểm tra: ${input.readyRecovery.version}`,
            "READY chưa giao chỉ được khôi phục qua kiểm tra an toàn.",
          ]
        : []),
      input.actions.length === 0 && !input.readyRecovery
        ? "Mục này đã giao cho khách hoặc đang trong đơn — chỉ xử lý được từ luồng đơn hàng."
        : "Chọn thao tác. Mỗi thao tác đều hỏi xác nhận và được ghi nhật ký.",
    ].join("\n"),
    buttons: [
      ...input.actions.map((entry) => [
        {
          text: entry.label,
          callbackData: `admin:inventory:item-act:${input.ref}:${entry.action}`,
        },
      ]),
      ...(input.readyRecovery
        ? [
            [
              {
                text: "🧯 Khôi phục READY chưa giao",
                callbackData: `admin:inventory:item-act:${input.ref}:READY_RELEASE`,
              },
            ],
          ]
        : []),
      [{ text: ADMIN_COPY.back, callbackData: `admin:inventory:items:${input.variantId}` }],
      adminHomeOnly,
    ],
  };
}

const ITEM_ACTION_EFFECT: Record<string, string> = {
  QUARANTINE: "Mục sẽ không còn được bán cho khách cho tới khi phục hồi.",
  RESTORE: "Mục sẽ trở lại trạng thái bán được.",
  REVOKE: "Mục sẽ bị thu hồi vĩnh viễn và không thể phục hồi.",
};

export function presentAdminInventoryItemConfirm(input: {
  variantId: string;
  variantName: string;
  ref: string;
  statusLabel: string;
  action: string;
  actionLabel: string;
}): PresentedMessage {
  return {
    text: [
      "⚠️ Xác nhận thao tác kho",
      "",
      `Mục: ${input.ref} — ${input.statusLabel}`,
      `Biến thể: ${input.variantName}`,
      `Thao tác: ${input.actionLabel}`,
      ITEM_ACTION_EFFECT[input.action] ?? "",
    ]
      .filter((line) => line.length > 0)
      .join("\n"),
    buttons: [
      [
        {
          text: "✅ Thực hiện",
          callbackData: `admin:inventory:item-confirm:${input.ref}:${input.action}`,
        },
      ],
      [
        {
          text: ADMIN_COPY.back,
          callbackData: `admin:inventory:item:${input.ref}`,
        },
      ],
      adminNav("admin:menu"),
    ],
  };
}

export function presentAdminInventoryItemDone(input: {
  variantId: string;
  ref: string;
  actionLabel: string;
  statusLabel: string;
}): PresentedMessage {
  return {
    text: [
      "✅ Đã cập nhật kho",
      "",
      `Mục: ${input.ref}`,
      `Thao tác: ${input.actionLabel}`,
      `Trạng thái mới: ${input.statusLabel}`,
    ].join("\n"),
    buttons: [
      [{ text: "Dữ liệu kho", callbackData: `admin:inventory:items:${input.variantId}` }],
      adminNav(`admin:inventory:variant:${input.variantId}`),
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
  isFeatured?: boolean;
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
      `Ghim nổi bật: ${input.isFeatured ? "⭐ Có" : "Không"}`,
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
      [
        { text: "🚀 Readiness xuất bản", callbackData: `admin:products:ready:${input.id}` },
        { text: "✏️ Sửa nội dung", callbackData: `admin:products:content:${input.id}` },
      ],
      [
        {
          text: input.isFeatured ? "☆ Bỏ ghim nổi bật" : "⭐ Ghim nổi bật",
          callbackData: `admin:products:feature:${input.id}`,
        },
        { text: "➕ Thêm biến thể", callbackData: `admin:products:variant-add:${input.id}` },
      ],
      ...(input.variants ?? []).flatMap((variant) => {
        const stockBacked =
          variant.fulfillmentType === "STOCK_ACCOUNT" || variant.fulfillmentType === "STOCK_CODE";
        return [
          [
            {
              text: `Sửa ${variant.name}`,
              callbackData: `admin:products:variant-edit:${variant.id}`,
            },
          ],
          ...(stockBacked
            ? [
                [
                  {
                    text: `📦 Nhập kho ${variant.name}`,
                    callbackData: `admin:inventory:variant:${variant.id}`,
                  },
                ],
              ]
            : []),
        ];
      }),
      adminNav("admin:products"),
    ],
  };
}

/** Goal §78: the fields of a variant an owner may edit, with the label the menu shows. */
export const ADMIN_VARIANT_FIELDS = [
  { key: "name", label: "Tên", kind: "text" },
  { key: "priceVnd", label: "Giá", kind: "number" },
  { key: "compareAtPriceVnd", label: "Giá gạch ngang", kind: "number" },
  { key: "durationCode", label: "Thời hạn", kind: "text" },
  { key: "active", label: "Đang bán", kind: "toggle" },
  { key: "preorderEnabled", label: "Cho đặt cọc", kind: "toggle" },
  { key: "depositAmountVnd", label: "Tiền đặt cọc", kind: "number" },
  { key: "lowStockThreshold", label: "Ngưỡng sắp hết", kind: "number" },
  { key: "warrantyDays", label: "Bảo hành (ngày)", kind: "number" },
] as const;

/**
 * The variant editor. The owner picks a field here and is asked for that one value; nothing on this
 * screen is an identifier, so the flow never asks anyone to type a UUID or a pipe-delimited row
 * (goal §172). The state this menu writes carries no `field`, which is what keeps free text from
 * being vouched for until a field prompt is actually open.
 */
export function presentAdminVariantDraft(input: {
  productId: string;
  sku: string;
  current: Record<(typeof ADMIN_VARIANT_FIELDS)[number]["key"], string>;
}): PresentedMessage {
  const current = input.current;
  return {
    text: [
      "✏️ Sửa biến thể",
      "",
      `${input.current.name} · ${input.sku}`,
      "",
      "Chọn thông tin cần sửa:",
      ...ADMIN_VARIANT_FIELDS.map((field) => `• ${field.label}: ${current[field.key]}`),
    ].join("\n"),
    buttons: [
      ...ADMIN_VARIANT_FIELDS.map((field) => [
        {
          text: `✏️ ${field.label}`,
          callbackData: `admin:products:vf:${field.key}`,
        },
      ]),
      [{ text: "⬅️ Sản phẩm", callbackData: `admin:products:detail:${input.productId}` }],
    ],
  };
}

export function presentAdminVariantFieldPrompt(input: {
  productId: string;
  variantId: string;
  fieldKey: string;
  label: string;
  current: string;
  hint: string;
  /** Present for a boolean field: the answer is a button, never something typed. */
  toggleOn?: boolean | undefined;
}): PresentedMessage {
  return {
    text: [`✏️ ${input.label}`, "", `Hiện tại: ${input.current}`, "", input.hint].join("\n"),
    buttons: [
      ...(input.toggleOn === undefined
        ? []
        : [
            [
              {
                text: "✅ Bật",
                callbackData: `admin:products:vfset:${input.fieldKey}:on`,
              },
              {
                text: "⛔ Tắt",
                callbackData: `admin:products:vfset:${input.fieldKey}:off`,
              },
            ],
          ]),
      [
        {
          text: "⬅️ Danh sách mục",
          callbackData: `admin:products:variant-edit:${input.variantId}`,
        },
      ],
      [{ text: "🛍 Sản phẩm", callbackData: `admin:products:detail:${input.productId}` }],
    ],
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

/** Deterministic step-up challenge copy, shared with the callback refusal message. */
export const STEP_UP_CHALLENGE_TEXT = "🔐 Thao tác nhạy cảm cần xác minh bảo mật.";
export const STEP_UP_CHALLENGE_INSTRUCTION =
  "Gửi /verify <mã 6 số> <mã yêu cầu> rồi mở lại và xác nhận đúng hành động này.";

export const STEP_UP_ENROLL_INSTRUCTION =
  "Chạy npm run admin:step-up enroll trên operator host, sau đó thực hiện lại hành động.";
export const STEP_UP_LOCKED_OUT_TEXT =
  "Xác minh bảo mật đang tạm khoá sau nhiều lần nhập sai. Vui lòng thử lại sau.";

/** One owner-facing sentence per refusal. None of them contains a code, an OTP or a seed. */
export const SENSITIVE_REFUSAL_TEXT: Record<SensitiveAuthorizationRefusal, string> = {
  NOT_ROOT_ADMIN: "Không được phép.",
  STEP_UP_REQUIRED: `${STEP_UP_CHALLENGE_TEXT}\n${STEP_UP_CHALLENGE_INSTRUCTION}`,
  STEP_UP_GRANT_MISSING: `${STEP_UP_CHALLENGE_TEXT}\nXác minh trước đó đã hết hiệu lực. ${STEP_UP_CHALLENGE_INSTRUCTION}`,
  STEP_UP_NOT_ENROLLED: `Chưa thiết lập xác minh bảo mật. ${STEP_UP_ENROLL_INSTRUCTION}`,
  STEP_UP_LOCKED_OUT: STEP_UP_LOCKED_OUT_TEXT,
};

export const ADMIN_MENU_BUTTON: InlineButton = {
  text: ADMIN_COPY.adminMenu,
  callbackData: "admin:menu",
};

/**
 * What the owner reads when a sensitive action needs its second factor. It names
 * the action and the required category — both come from the fixed policy table —
 * and nothing else: never a seed, an OTP or any code.
 */
export function presentStepUpRequired(input: {
  action: string;
  category: string | null;
  challengeId?: string;
}): PresentedMessage {
  const action = input.category === null ? input.action : `${input.action} (${input.category})`;
  const challenge = input.challengeId ? `Mã yêu cầu: ${input.challengeId}` : null;
  return {
    text: [
      STEP_UP_CHALLENGE_TEXT,
      "",
      `Hành động: ${action}`,
      ...(challenge ? [challenge] : []),
      STEP_UP_CHALLENGE_INSTRUCTION,
    ].join("\n"),
    buttons: [[ADMIN_MENU_BUTTON]],
  };
}

/** Why a broadcast send was refused. One sentence per reason; none of them blames the operator. */
export const BROADCAST_REFUSAL_TEXT: Record<BroadcastRefusal, string> = {
  NOT_FOUND: "Không tìm thấy thông báo.",
  NOT_DRAFT: "Thông báo này đã được gửi hoặc đã huỷ.",
  NOT_PREVIEWED: "Cần xem trước nội dung và số người nhận trước khi gửi.",
  NOT_OWNED: "Thông báo này không thuộc về bạn.",
  STALE_PREVIEW:
    "Nội dung hoặc danh sách người nhận đã thay đổi sau khi xem trước. Hãy xem trước lại rồi gửi.",
  COOLDOWN_ACTIVE: "Vừa có một thông báo lớn được gửi. Vui lòng chờ trong ít phút.",
};

export function presentAdminBroadcastRefused(reason: BroadcastRefusal): PresentedMessage {
  return {
    text: `⛔ ${BROADCAST_REFUSAL_TEXT[reason]}`,
    buttons: [[{ text: "📣 Tiếp thị", callbackData: "admin:marketing" }]],
  };
}

/** The refusal screen for a sensitive action: challenge for step-up, otherwise the sentence. */
export function presentSensitiveRefusal(input: {
  code: SensitiveAuthorizationRefusal;
  action: string;
  category: string | null;
  challengeId?: string;
}): PresentedMessage {
  if (input.code === "STEP_UP_REQUIRED" || input.code === "STEP_UP_GRANT_MISSING") {
    return presentStepUpRequired({
      action: input.action,
      category: input.category,
      ...(input.challengeId ? { challengeId: input.challengeId } : {}),
    });
  }
  return {
    text: SENSITIVE_REFUSAL_TEXT[input.code],
    buttons: [[ADMIN_MENU_BUTTON]],
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

/** Goal §135: safe system posture. Counts and configured modes only — never a secret. */
export interface AdminSystemHealthFacts {
  /** Build identity of the process rendering this screen (the worker). */
  workerCommit: string;
  builtAt: string;
  /** Live API identity read from its /health, or why it could not be read. */
  apiCommit: string;
  storeMode: string;
  database: "ok" | "down";
  vaultDriver: string;
  telegramWebhook: "CONFIGURED" | "MISSING";
  sepayReconciliation: string;
  queues: {
    outboxBacklog: number;
    /** Actionable: dead-lettered rows with no disposition yet. */
    outboxDeadLettered: number;
    /** Retained history: dead-lettered rows a disposition already closed. */
    outboxDeadLetteredDisposed: number;
    inboxDeadLetteredTelegram: number;
    inboxDeadLetteredSePay: number;
    inboxPendingTelegram: number;
    inboxPendingSePay: number;
    /** Actionable: discrepancies with no resolution yet. */
    openDiscrepancies: number;
    /** Retained history: discrepancies already resolved. Evidence, not work. */
    resolvedDiscrepancies: number;
    intentsAwaitingSettlement: number;
    paymentsNeedingReview: number;
    /** Informational: ordinary tickets waiting on the shop or the customer. */
    openSupportTickets: number;
    /** Actionable: tickets parked for operator judgement (`MANUAL_REVIEW`). */
    criticalSupportTickets: number;
  };
}

export function presentAdminSystemHealth(input: AdminSystemHealthFacts): PresentedMessage {
  const flag = (ok: boolean) => (ok ? "🟢" : "🔴");
  return {
    text: [
      "🩺 Hệ thống",
      "",
      `${flag(input.database === "ok")} Cơ sở dữ liệu: ${input.database === "ok" ? "hoạt động" : "KHÔNG truy cập được"}`,
      `🔖 Bản dựng worker: ${input.workerCommit.slice(0, 12)}`,
      `🕒 Dựng lúc: ${input.builtAt}`,
      `🔖 Bản dựng API: ${input.apiCommit}`,
      `🏪 Chế độ cửa hàng: ${input.storeMode}`,
      `🔐 Kho bí mật: ${input.vaultDriver}`,
      `${flag(input.telegramWebhook === "CONFIGURED")} Webhook Telegram: ${input.telegramWebhook === "CONFIGURED" ? "đã cấu hình" : "THIẾU"}`,
      `🏦 Đối soát SePay: ${input.sepayReconciliation}`,
      "",
      `📤 Hàng đợi outbox: ${input.queues.outboxBacklog}`,
      `☠️ Outbox dead-letter cần xử lý: ${input.queues.outboxDeadLettered}`,
      `📥 Inbox Telegram: chờ ${input.queues.inboxPendingTelegram} · dead ${input.queues.inboxDeadLetteredTelegram}`,
      `📥 Inbox SePay: chờ ${input.queues.inboxPendingSePay} · dead ${input.queues.inboxDeadLetteredSePay}`,
      `⚠️ Sai lệch cần soát: ${input.queues.openDiscrepancies}`,
      `⏳ Intent chờ thanh toán: ${input.queues.intentsAwaitingSettlement}`,
      `🔎 Thanh toán cần kiểm tra: ${input.queues.paymentsNeedingReview}`,
      `🚨 Ticket cần người xử lý: ${input.queues.criticalSupportTickets}`,
      `🛡 Ticket thường đang mở (chờ shop/khách): ${input.queues.openSupportTickets}`,
      // Retained history, kept as evidence: a closed queue is not an incident, and hiding it
      // would hide how much the disposition APIs have actually cleared.
      `🗄 Đã xử lý (chỉ lưu vết): outbox ${input.queues.outboxDeadLetteredDisposed} · sai lệch ${input.queues.resolvedDiscrepancies}`,
    ].join("\n"),
    buttons: [
      [
        { text: ADMIN_COPY.overview, callbackData: "admin:dashboard" },
        { text: ADMIN_COPY.payments, callbackData: "admin:payments" },
      ],
      adminNav("admin:menu"),
    ],
  };
}

/** Goal §104-§107: what the shop may send, and to whom. Private chats only. */
export function presentAdminNotifications(input: {
  transactionalKinds: string[];
  marketingRecipients: number;
  marketingOptOuts: number;
  outboxBacklog: number;
}): PresentedMessage {
  return {
    text: [
      "🔔 Thông báo",
      "",
      "Kênh gửi: chỉ chat riêng của khách.",
      "Giao dịch bắt buộc (không thể tắt):",
      ...input.transactionalKinds.map((kind) => `• ${kind}`),
      "",
      `📣 Người nhận marketing: ${input.marketingRecipients}`,
      `🚫 Đã tắt nhận marketing: ${input.marketingOptOuts}`,
      `📤 Đang chờ gửi trong outbox: ${input.outboxBacklog}`,
    ].join("\n"),
    buttons: [[{ text: "📢 Broadcast", callbackData: "admin:marketing" }], adminNav("admin:menu")],
  };
}

/** Goal §81 — edit a product's commercial content in place, one field at a time. */
export const ADMIN_PRODUCT_CONTENT_FIELDS = [
  { key: "name", label: "📝 Tên" },
  { key: "shortDescription", label: "📝 Mô tả ngắn" },
  { key: "description", label: "📝 Mô tả đầy đủ" },
  { key: "whatCustomerReceives", label: "📦 Bạn nhận được" },
  { key: "usageInstructions", label: "📘 Hướng dẫn" },
  { key: "warranty", label: "🛡 Bảo hành" },
  { key: "deliveryEta", label: "⏱ Thời gian giao" },
  { key: "terms", label: "📄 Điều khoản" },
  { key: "support", label: "💬 Hỗ trợ riêng" },
  { key: "tags", label: "🏷 Thẻ tìm kiếm" },
] as const;

export function adminProductContentField(
  key: string,
): (typeof ADMIN_PRODUCT_CONTENT_FIELDS)[number] | undefined {
  return ADMIN_PRODUCT_CONTENT_FIELDS.find((field) => field.key === key);
}

export function presentAdminProductContentMenu(input: {
  productId: string;
  name: string;
  values: Partial<Record<(typeof ADMIN_PRODUCT_CONTENT_FIELDS)[number]["key"], string | null>>;
}): PresentedMessage {
  const line = (key: (typeof ADMIN_PRODUCT_CONTENT_FIELDS)[number]["key"]): string => {
    const value = input.values[key];
    return value && value.trim() ? `${value.trim().slice(0, 40)}` : "(trống)";
  };
  return {
    text: [
      "✏️ Sửa nội dung sản phẩm",
      "",
      input.name,
      "",
      "Chọn mục cần sửa. Sản phẩm được cập nhật tại chỗ, không tạo lại.",
      ...ADMIN_PRODUCT_CONTENT_FIELDS.map((field) => `• ${field.label}: ${line(field.key)}`),
    ].join("\n"),
    buttons: [
      ...ADMIN_PRODUCT_CONTENT_FIELDS.map((field) => [
        {
          // Prefixed so the row cannot be confused with the persistent keyboard's own
          // "🛡 Bảo hành" / "💬 Hỗ trợ" keys, which dispatch to customer screens.
          text: `✏️ ${field.label}`,
          callbackData: `admin:products:cf:edit:${field.key}`,
        },
      ]),
      [
        { text: "⬅️ Quay lại", callbackData: `admin:products:detail:${input.productId}` },
        ...adminHomeOnly,
      ],
    ],
  };
}

export function presentAdminProductContentPrompt(input: {
  productId: string;
  label: string;
  current?: string | null;
}): PresentedMessage {
  return {
    text: [
      `✏️ ${input.label}`,
      "",
      input.current && input.current.trim()
        ? `Hiện tại: ${input.current.trim().slice(0, 300)}`
        : "Hiện tại: (trống)",
      "",
      "Gửi nội dung mới trong một tin nhắn. Gõ - để xoá nội dung này.",
    ].join("\n"),
    buttons: [
      [{ text: "⬅️ Danh sách mục", callbackData: `admin:products:content:${input.productId}` }],
      adminNav("admin:menu"),
    ],
  };
}
