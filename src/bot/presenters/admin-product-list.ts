import type { InlineButton, PresentedMessage } from "./catalog.js";

export type AdminProductView = "all" | "featured" | "inactive" | "archived" | "test";

const PRODUCT_VIEW_LABELS: Record<AdminProductView, string> = {
  all: "📦 Tất cả",
  featured: "⭐ Đã ghim",
  inactive: "🚫 Đang tắt",
  archived: "🗄 Lưu trữ",
  test: "🧪 Test",
};

export interface AdminProductListChrome {
  title: string;
  overview: string;
  inventory: string;
  navigation: InlineButton[];
}

export function renderAdminProductList(
  rows: Array<{ id: string; name: string; active: boolean; featured?: boolean; test?: boolean }>,
  options: { view?: AdminProductView; page?: number; hasMore?: boolean; total?: number },
  chrome: AdminProductListChrome,
): PresentedMessage {
  const view = options.view ?? "all";
  const page = options.page ?? 1;
  const views = Object.keys(PRODUCT_VIEW_LABELS) as AdminProductView[];
  return {
    text: [
      chrome.title,
      `Đang xem: ${PRODUCT_VIEW_LABELS[view]}${page > 1 ? ` · trang ${page}` : ""}`,
      ...(rows.length === 0
        ? ["Không có sản phẩm nào trong mục này."]
        : rows.map(
            (row) =>
              `• ${row.name} (${row.active ? "đang bán" : "tạm dừng"})${row.featured ? " ⭐" : ""}${row.test ? " 🧪" : ""}`,
          )),
      ...(options.hasMore ? ["", "Còn nữa — bấm Xem thêm."] : []),
    ].join("\n"),
    buttons: [
      [
        { text: chrome.overview, callbackData: "admin:dashboard" },
        { text: chrome.inventory, callbackData: "admin:inventory" },
      ],
      [{ text: "➕ Tạo sản phẩm", callbackData: "admin:products:create" }],
      ...views
        .filter((candidate) => candidate !== view)
        .map((candidate) => [
          {
            text: PRODUCT_VIEW_LABELS[candidate],
            callbackData: `admin:products:view:${candidate}`,
          },
        ]),
      ...rows.map((row) => [
        {
          text: `${row.featured ? "⭐ " : ""}${row.name} (${row.active ? "đang bán" : "tạm dừng"})`,
          callbackData: `admin:products:detail:${row.id}`,
        },
      ]),
      ...(options.hasMore
        ? [
            [
              {
                text: "➡️ Xem thêm",
                callbackData: `admin:products:view:${view}:${page + 1}`,
              },
            ],
          ]
        : []),
      [{ text: "📝 Xem lại nháp", callbackData: "admin:products:review" }],
      chrome.navigation,
    ],
  };
}
