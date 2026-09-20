import type { InlineButton, PresentedMessage } from "./catalog.js";
import type { FulfillmentType } from "../../modules/catalog/fulfillment-type.js";
import { FULFILLMENT_TYPE_LABELS } from "../../modules/catalog/fulfillment-type.js";
import type { ProductDraft } from "../../modules/catalog/product-draft.js";

const BACK_CANCEL: InlineButton[][] = [
  [{ text: "⬅️ Quay lại", callbackData: "admin:products:back" }],
  [{ text: "❌ Huỷ", callbackData: "admin:products:cancel" }],
];

/** Bước 1/8 — Tên sản phẩm. */
export function presentWizardNameStep(draft?: ProductDraft): PresentedMessage {
  return {
    text: `Bước 1/8 — 📝 Tên sản phẩm\n\nNhập tên hiển thị cho khách.\nVí dụ: GPT PLUS BHF 1 tháng, Netflix Premium 4K.${draft?.name ? `\n\n(Hiện tại: ${draft.name})` : ""}`,
    buttons: BACK_CANCEL,
  };
}

/** Bước 2/8 — SKU. */
export function presentWizardSkuStep(draft: ProductDraft, proposal: string): PresentedMessage {
  return {
    text: `Bước 2/8 — 🏷 SKU\n\nSKU dùng để quản lý nội bộ (chữ, số, dấu - hoặc _).${draft.sku ? `\n(Hiện tại: ${draft.sku})` : ""}\n\nĐề xuất: ${proposal}`,
    buttons: [
      [
        {
          text: `✨ Dùng SKU đề xuất: ${proposal}`,
          callbackData: `admin:products:apply-sku:${proposal}`,
        },
      ],
      ...BACK_CANCEL,
    ],
  };
}

/** Bước 3/8 — Danh mục. Never a dead screen: create-new + uncategorized fallback. */
export function presentWizardCategoryStep(
  categories: Array<{ id: string; name: string }>,
): PresentedMessage {
  return {
    text: "Bước 3/8 — 📂 Chọn danh mục",
    buttons: [
      ...categories.map((c) => [{ text: c.name, callbackData: `admin:products:category:${c.id}` }]),
      [{ text: "➕ Tạo danh mục mới", callbackData: "admin:products:category:new" }],
      [{ text: "📁 Khác / Chưa phân loại", callbackData: "admin:products:category:none" }],
      ...BACK_CANCEL,
    ],
  };
}

/** Bước 4/8 — Loại sản phẩm (Vietnamese labels, no enum names). */
export function presentFulfillmentTypeChoices(): PresentedMessage {
  const choices: Array<[string, FulfillmentType]> = [
    ["👤 Tài khoản (giao tự động)", "STOCK_ACCOUNT"],
    ["🔑 Mã / Key (giao tự động)", "STOCK_CODE"],
    ["📁 Tệp số", "DIGITAL_FILE"],
    ["📦 Hàng theo số lượng", "QUANTITY_STOCK"],
    ["♾ Dịch vụ không giới hạn", "UNLIMITED_SERVICE"],
    ["🧑‍💻 Xử lý thủ công", "MANUAL_FULFILLMENT"],
    ["🔌 Nhà cung cấp / API", "SUPPLIER_API"],
  ];
  const buttons: InlineButton[][] = choices.map(([text, type]) => [
    { text, callbackData: `admin:products:type:${type}` },
  ]);
  buttons.push(...BACK_CANCEL);
  return { text: "Bước 4/8 — 🧩 Loại sản phẩm\n\nChọn cách cửa hàng giao sản phẩm này.", buttons };
}

/** Bước 5/8 — Mô tả & hướng dẫn. */
export function presentWizardDescriptionStep(type: FulfillmentType | undefined): PresentedMessage {
  const typeLabel = type ? FULFILLMENT_TYPE_LABELS[type] : "sản phẩm";
  return {
    text: `Bước 5/8 — 📝 Mô tả & hướng dẫn\n\nChọn "Dùng mẫu mô tả" để điền sẵn nội dung chuẩn cho loại ${typeLabel} (có thể chỉnh sau), hoặc "Tự nhập" để viết mô tả riêng.`,
    buttons: [
      [{ text: "✨ Dùng mẫu mô tả", callbackData: "admin:products:desc:template" }],
      [
        { text: "✏️ Tự nhập", callbackData: "admin:products:desc:custom" },
        { text: "🧩 Nhập từng mục", callbackData: "admin:products:desc:fields" },
      ],
      ...BACK_CANCEL,
    ],
  };
}

/** Bước 5/8 (tự nhập) — hướng dẫn nhập mô tả. */
export function presentWizardDescriptionCustomPrompt(): PresentedMessage {
  return {
    text: "Bước 5/8 — ✏️ Tự nhập mô tả\n\nGửi mô tả sản phẩm của bạn (một tin nhắn). Bạn có thể chỉnh sửa ở bước xem trước.",
    buttons: BACK_CANCEL,
  };
}

/** Bước 6/8 — Giá / biến thể. */
export function presentWizardVariantStep(draft?: ProductDraft): PresentedMessage {
  return {
    text: `Bước 6/8 — 💰 Giá / biến thể\n\nNhập tên biến thể và giá theo định dạng:\nTên biến thể | Giá\n\nVí dụ: 1 tháng | 250000${draft?.variantName && draft.priceVnd ? `\n\n(Hiện tại: ${draft.variantName} | ${draft.priceVnd.toLocaleString("vi-VN")} ₫)` : ""}`,
    buttons: BACK_CANCEL,
  };
}

/** Optional toggle presets per type for Bước 7/8. */
const OPTIONAL_TOGGLES: Partial<Record<FulfillmentType, Array<{ name: string; label: string }>>> = {
  STOCK_ACCOUNT: [
    { name: "recovery_email", label: "Recovery Email" },
    { name: "two_factor_secret", label: "2FA / Secret" },
    { name: "custom_instructions", label: "Hướng dẫn riêng" },
  ],
  STOCK_CODE: [
    { name: "note", label: "Ghi chú" },
    { name: "expires_at", label: "Hạn sử dụng" },
  ],
  DIGITAL_FILE: [
    { name: "file_password", label: "Mật khẩu file" },
    { name: "instructions", label: "Hướng dẫn" },
  ],
};

const DELIVERY_INTRO: Record<FulfillmentType, string> = {
  STOCK_ACCOUNT: "👤 Tài khoản cần giao gồm những thông tin nào?",
  STOCK_CODE: "🔑 Nội dung giao:",
  DIGITAL_FILE: "📁 File giao cho khách:",
  QUANTITY_STOCK: "📦 Hàng số lượng — không có thông tin đăng nhập.",
  UNLIMITED_SERVICE: "♾ Dịch vụ không cần nhập kho.",
  MANUAL_FULFILLMENT: "🧑‍💻 Nhân viên xử lý thủ công.",
  SUPPLIER_API: "🔌 Nhà cung cấp / API.",
};

/** Bước 7/8 — Cách giao hàng / cấu trúc kho (button-driven, no raw schema input). */
export function presentWizardDeliveryStep(draft: ProductDraft): PresentedMessage {
  const type = draft.fulfillmentType;
  if (!type) return { text: "Bước 7/8 — Chọn loại sản phẩm trước.", buttons: BACK_CANCEL };
  const intro = `Bước 7/8 — 📦 Cách giao hàng / cấu trúc kho\n\n${DELIVERY_INTRO[type]}`;

  if (type === "QUANTITY_STOCK")
    return {
      text: `${intro}\n\nNhập số lượng ban đầu (số nguyên dương). Có thể nhập thêm sau tại Kho hàng.`,
      buttons: BACK_CANCEL,
    };
  if (type === "UNLIMITED_SERVICE" || type === "MANUAL_FULFILLMENT")
    return {
      text: `${intro}\n\nNhập hướng dẫn xử lý cho đơn hàng (nhân viên sẽ thấy khi có đơn).`,
      buttons: BACK_CANCEL,
    };
  if (type === "SUPPLIER_API")
    return {
      text: `${intro}\n\n🔌 Cấu hình nhà cung cấp / đối tác\nNhập thông tin kết nối API theo định dạng:\nTên đối tác | Mã gói đối tác | Giá vốn | Khu vực\nVí dụ: NCC_A | PRO_1M | 50000 | VN\n\n(Lưu ý: Chỉ áp dụng với nhà cung cấp đã được kích hoạt trong hệ thống)`,
      buttons: BACK_CANCEL,
    };

  // Schema types: STOCK_ACCOUNT / STOCK_CODE / DIGITAL_FILE — button-driven field config.
  const fields = draft.inventoryFields ?? [];
  const toggles = OPTIONAL_TOGGLES[type] ?? [];
  const toggleButtons: InlineButton[][] = toggles.map((t) => {
    const on = fields.some((f) => f.name === t.name);
    return [
      {
        text: `${on ? "✅" : "⬜"} ${t.label}`,
        callbackData: `admin:products:dc:toggle:${t.name}`,
      },
    ];
  });
  const customFields = (draft.deliveryConfig?.customFields ?? []).map((f) => [
    {
      text: `🧩 ${f.label}${f.required ? " ·bắt buộc" : ""}${f.secret ? " ·ẩn" : ""}`,
      callbackData: `admin:products:dc:flags:${f.name}`,
    },
  ]);
  const currentLines = fields.map(
    (f) => `• ${f.label}${f.required ? " (bắt buộc)" : ""}${f.secret ? " (ẩn)" : ""}`,
  );
  return {
    text: `${intro}\n\nTrường hiện tại:\n${currentLines.join("\n") || "• (chưa có)"}`,
    buttons: [
      ...toggleButtons,
      ...customFields,
      [
        { text: "➕ Trường tùy chỉnh", callbackData: "admin:products:dc:custom" },
        { text: "⚙️ Trường nâng cao", callbackData: "admin:products:dc:advanced" },
      ],
      [{ text: "✅ Tiếp tục", callbackData: "admin:products:dc:done" }],
      ...BACK_CANCEL,
    ],
  };
}

/** Bước 8/8 — cài đặt hiển thị và bán hàng. */
export function presentWizardVisibilityStep(draft: ProductDraft): PresentedMessage {
  const visibility =
    draft.visibility === "TEST_ONLY"
      ? "Chỉ test"
      : draft.visibility === "DRAFT"
        ? "Bản nháp"
        : "Công khai";
  return {
    text: `Bước 8/8 — ⚙️ Cài đặt hiển thị & bán hàng\n\nHiển thị: ${visibility}\nGhim nổi bật: ${draft.isFeatured ? "Có" : "Không"}\nBảo hành: ${draft.warrantyEnabled ? `${draft.warrantyDays ?? 0} ngày${draft.warrantyProrationEnabled === false ? " · không chia theo thời gian" : " · hoàn theo thời gian còn lại"}` : "Không"}\nĐặt cọc khi hết hàng: ${draft.preorderEnabled ? "Bật" : "Tắt"}\nCảnh báo sắp hết: ${draft.lowStockThreshold ?? 3}`,
    buttons: [
      [
        {
          text: draft.visibility === "TEST_ONLY" ? "🧪 Chỉ test (Đang chọn)" : "🧪 Đặt Chỉ test",
          callbackData: "admin:products:vis:test",
        },
        {
          text: draft.visibility === "DRAFT" ? "📝 Bản nháp (Đang chọn)" : "📝 Đặt Bản nháp",
          callbackData: "admin:products:vis:draft",
        },
      ],
      [
        {
          text:
            draft.visibility === "PUBLIC" || !draft.visibility
              ? "🟢 Công khai (Đang chọn)"
              : "🟢 Đặt Công khai",
          callbackData: "admin:products:vis:public",
        },
      ],
      [
        {
          text: `${draft.isFeatured ? "⭐" : "☆"} Ghim nổi bật: ${draft.isFeatured ? "Bật" : "Tắt"}`,
          callbackData: "admin:products:vis:toggle_featured",
        },
      ],
      // Warranty policy (goal §60/§61). Choices, not prose: a toggle, a duration, the refund rule and
      // the two resolution permissions. Coverage/exclusions prose is entered in the content editor.
      [
        {
          text: `${draft.warrantyEnabled ? "✅" : "❌"} Bảo hành: ${draft.warrantyEnabled ? "Bật" : "Tắt"}`,
          callbackData: "admin:products:warranty:toggle",
        },
      ],
      ...(draft.warrantyEnabled
        ? [
            [7, 15, 30, 90].map((days) => ({
              text: `${draft.warrantyDays === days ? "✅" : ""}${days} ngày`,
              callbackData: `admin:products:warranty:days:${days}`,
            })),
            [
              {
                text: `${draft.warrantyProrationEnabled === false ? "◻️" : "✅"} Hoàn theo thời gian còn lại`,
                callbackData: "admin:products:warranty:proration",
              },
            ],
            [
              {
                text: `${draft.warrantyReplacementAllowed === false ? "◻️" : "✅"} Cho phép đổi hàng`,
                callbackData: "admin:products:warranty:replacement",
              },
              {
                text: `${draft.warrantyRefundAllowed === false ? "◻️" : "✅"} Cho phép hoàn tiền`,
                callbackData: "admin:products:warranty:refund",
              },
            ],
            [
              {
                text:
                  draft.warrantyReplacementBehavior === "RESET_FROM_REPLACEMENT"
                    ? "♻️ Bảo hành đổi hàng: tính lại từ lần đổi"
                    : "♻️ Bảo hành đổi hàng: giữ hạn cũ",
                callbackData: "admin:products:warranty:behavior",
              },
            ],
            [
              {
                text: `${draft.warrantyCoverageVi ? "✅" : "◻️"} Phạm vi bảo hành`,
                callbackData: "admin:products:warranty:text:coverage",
              },
              {
                text: `${draft.warrantyExclusionsVi ? "✅" : "◻️"} Không thuộc bảo hành`,
                callbackData: "admin:products:warranty:text:exclusions",
              },
            ],
          ]
        : []),
      [
        {
          text: `💰 Đặt cọc khi hết hàng: ${draft.preorderEnabled ? "Bật" : "Tắt"}`,
          callbackData: "admin:products:vis:toggle_preorder",
        },
      ],
      [{ text: "✅ Tiếp tục xem trước", callbackData: "admin:products:vis:done" }],
      ...BACK_CANCEL,
    ],
  };
}

/** Custom-field flags editor. */
export function presentWizardCustomFieldFlags(
  fieldName: string,
  fieldLabel: string,
  flags: { required: boolean; secret: boolean; customerVisible: boolean },
): PresentedMessage {
  const flag = (key: string, label: string, on: boolean) => ({
    text: `${on ? "✅" : "⬜"} ${label}`,
    callbackData: `admin:products:dc:flag:${fieldName}:${key}`,
  });
  return {
    text: `🧩 Trường tùy chỉnh\n\nTên: ${fieldLabel}\nKhoá nội bộ: ${fieldName}`,
    buttons: [
      [flag("required", "Bắt buộc", flags.required)],
      [flag("secret", "Ẩn giá trị (bí mật)", flags.secret)],
      [flag("customerVisible", "Khách được thấy", flags.customerVisible)],
      [{ text: "🗑 Xoá trường này", callbackData: `admin:products:dc:del:${fieldName}` }],
      [{ text: "✅ Xong", callbackData: "admin:products:dc:back" }],
    ],
  };
}

/** Prompts for sub-flows (state carried via admin_callback_state). */
export function presentWizardCategoryCreatePrompt(): PresentedMessage {
  return {
    text: "➕ Tạo danh mục mới\n\nNhập tên danh mục (ví dụ: 🤖 AI / ChatGPT).",
    buttons: BACK_CANCEL,
  };
}
export function presentWizardCustomFieldPrompt(): PresentedMessage {
  return {
    text: '➕ Trường tùy chỉnh\n\nTên trường (khách hoặc bạn sẽ thấy):\nVí dụ: "Ngày hết hạn"',
    buttons: BACK_CANCEL,
  };
}
export function presentWizardAdvancedPrompt(): PresentedMessage {
  return {
    text: "⚙️ Trường nâng cao\n\nNhập danh sách tên trường, phân tách bởi dấu phẩy.\nVí dụ: Email, Mật khẩu, Ngày hết hạn\n\n(Khuyến nghị dùng nút bấm ở màn hình trước.)",
    buttons: BACK_CANCEL,
  };
}

/**
 * Goal §76 — the per-field content editor.
 *
 * The wizard's description step offers a preset template or one free-text message; neither can
 * enter the individual fields the customer contract calls for, and the database stores them
 * separately. This sub-flow fills each one on its own without adding a wizard step: the draft
 * stays on `description` and the pending field rides the existing sub-flow state's payload.
 */
export const WIZARD_DESCRIPTION_FIELDS = [
  { key: "shortDescriptionVi", label: "📝 Mô tả ngắn", prompt: "Nhập mô tả ngắn (một dòng)." },
  { key: "descriptionVi", label: "📝 Mô tả đầy đủ", prompt: "Nhập mô tả đầy đủ." },
  { key: "whatCustomerReceivesVi", label: "📦 Bạn nhận được", prompt: "Khách sẽ nhận được gì?" },
  { key: "usageInstructionsVi", label: "📘 Hướng dẫn", prompt: "Hướng dẫn sử dụng." },
  { key: "warrantyVi", label: "🛡 Bảo hành", prompt: "Chính sách bảo hành." },
  { key: "deliveryEtaVi", label: "⏱ Thời gian giao", prompt: "Dự kiến giao hàng." },
  { key: "termsVi", label: "📄 Điều khoản", prompt: "Điều khoản / lưu ý." },
] as const;

export type WizardDescriptionFieldKey = (typeof WIZARD_DESCRIPTION_FIELDS)[number]["key"];

/**
 * Warranty prose (goal §60). Kept out of the step-5 content menu: it belongs to the warranty
 * settings, and the prompt mechanism is shared so there is still one way to enter a field.
 */
export const WIZARD_WARRANTY_TEXT_FIELDS = [
  {
    key: "warrantyCoverageVi",
    label: "🛡 Phạm vi bảo hành",
    prompt: "Mô tả phạm vi bảo hành (lỗi nào thuộc trách nhiệm shop).",
  },
  {
    key: "warrantyExclusionsVi",
    label: "🚫 Không thuộc bảo hành",
    prompt: "Mô tả các trường hợp không thuộc bảo hành.",
  },
] as const;

export function wizardDescriptionField(
  key: string,
): { key: string; label: string; prompt: string } | undefined {
  const content = WIZARD_DESCRIPTION_FIELDS.find((field) => field.key === key);
  if (content) return content;
  return WIZARD_WARRANTY_TEXT_FIELDS.find((field) => field.key === key);
}

/** The field menu: one row per field, marked filled, with a way forward and back. */
export function presentWizardDescriptionFields(draft?: ProductDraft): PresentedMessage {
  const filled = (key: WizardDescriptionFieldKey): boolean => {
    const value = draft?.[key];
    return typeof value === "string" && value.trim().length > 0;
  };
  const remaining = WIZARD_DESCRIPTION_FIELDS.filter((field) => !filled(field.key)).length;
  return {
    text: [
      "Bước 5/8 — 🧩 Nội dung sản phẩm",
      "",
      "Chọn từng mục để nhập riêng. Mục đã có nội dung được đánh dấu ✅.",
      remaining === 0 ? "Đã đủ nội dung." : `Còn ${remaining} mục chưa nhập (không bắt buộc).`,
    ].join("\n"),
    buttons: [
      ...WIZARD_DESCRIPTION_FIELDS.map((field) => [
        {
          text: `${filled(field.key) ? "✅" : "⬜"} ${field.label}`,
          callbackData: `admin:products:df:edit:${field.key}`,
        },
      ]),
      [{ text: "✅ Tiếp tục", callbackData: "admin:products:df:done" }],
      ...BACK_CANCEL,
    ],
  };
}

/** Prompt for exactly one field. The label is echoed so the owner knows what is being asked. */
export function presentWizardDescriptionFieldPrompt(
  key: string,
  current?: string | undefined,
): PresentedMessage {
  const field = wizardDescriptionField(key);
  return {
    text: [
      `Bước 5/8 — ${field ? field.label : "Nội dung"}`,
      "",
      field ? field.prompt : "Nhập nội dung.",
      current && current.trim() ? `\n(Hiện tại: ${current.trim().slice(0, 200)})` : "",
      "",
      "Gửi một tin nhắn. Gõ - để xoá nội dung của mục này.",
    ]
      .filter((line) => line !== "")
      .join("\n"),
    buttons: [
      [{ text: "⬅️ Danh sách mục", callbackData: "admin:products:desc:fields" }],
      ...BACK_CANCEL,
    ],
  };
}

/**
 * Goal §131 — a wizard validation error must say WHICH field is wrong, never a bare
 * "Dữ liệu không hợp lệ". The step is the field being edited, so the hint is derived from it, and
 * every error code the draft machine can return gets its own sentence.
 */
const WIZARD_STEP_HINTS: Record<string, string> = {
  name: "Nhập tên sản phẩm (tối đa 200 ký tự).",
  sku: "SKU chỉ gồm chữ, số, dấu - hoặc _ (không dấu cách).",
  category: "Chọn danh mục bằng nút bên dưới.",
  productType: "Chọn loại sản phẩm bằng nút bên dưới.",
  description: "Nhập nội dung mô tả.",
  variant: "Nhập: Tên biến thể | Giá (ví dụ: 1 tháng | 250000).",
  deliveryConfig: "Chọn cấu trúc kho bằng nút bên dưới.",
  visibilityFlags: "Chọn hiển thị bằng nút bên dưới.",
  confirm: "Xác nhận bằng nút bên dưới.",
  inventoryFields: "Chọn cấu trúc kho bằng nút bên dưới.",
  variantName: "Nhập tên biến thể (tối đa 200 ký tự).",
  price: "Nhập giá là một số nguyên dương (VND).",
  threshold: "Nhập ngưỡng cảnh báo là một số nguyên không âm.",
  initialQuantity: "Nhập số lượng ban đầu là một số nguyên không âm.",
  serviceInstructions: "Nhập hướng dẫn xử lý cho đơn hàng.",
  supplierConfig: "Nhập: supplierId | externalSku | costVnd | region.",
};

const WIZARD_STEP_LABELS: Record<string, string> = {
  name: "📝 Tên sản phẩm",
  sku: "🏷 SKU",
  description: "📝 Mô tả & hướng dẫn",
  variant: "💰 Giá / biến thể",
  deliveryConfig: "📦 Cách giao hàng",
  visibilityFlags: "⚙️ Hiển thị & bán hàng",
  inventoryFields: "📦 Cấu trúc kho",
  variantName: "🏷 Tên biến thể",
  price: "💰 Giá",
  threshold: "📦 Ngưỡng cảnh báo",
  initialQuantity: "📦 Số lượng ban đầu",
  serviceInstructions: "🧑‍💻 Hướng dẫn xử lý",
  supplierConfig: "🔌 Nhà cung cấp",
};

const WIZARD_ERROR_SENTENCES: Record<string, string> = {
  DRAFT_EXPIRED: "Phiên tạo sản phẩm đã hết hạn.",
  DRAFT_READY: "Sản phẩm đã sẵn sàng để tạo — hãy bấm nút xác nhận.",
  INVALID_STEP: "Bước này không nhận nội dung gõ tay.",
  UNSUPPORTED_FULFILLMENT_TYPE: "Loại sản phẩm chưa được hỗ trợ cho trường này.",
  NO_DRAFT: "Chưa có sản phẩm đang tạo.",
  INVALID_QUANTITY: "Số lượng không hợp lệ.",
  INVALID_VARIANT: "Định dạng biến thể chưa đúng.",
  INVALID_SKU: "SKU không hợp lệ.",
  INVALID_SUPPLIER_CONFIG: "Cấu hình nhà cung cấp chưa đúng.",
  INVALID_INVENTORY_FIELDS: "Cấu trúc kho chưa hợp lệ.",
  INVALID_VALUE: "Nội dung không được để trống hoặc quá dài.",
};

export function wizardValidationMessage(errorCode: string, step: string): string {
  const label = WIZARD_STEP_LABELS[step];
  const sentence = WIZARD_ERROR_SENTENCES[errorCode] ?? "Nội dung chưa hợp lệ cho bước này.";
  const hint = WIZARD_STEP_HINTS[step];
  return [label ? `Ở bước ${label}: ${sentence}` : sentence, hint ? `👉 ${hint}` : null]
    .filter((line): line is string => line !== null)
    .join("\n");
}
