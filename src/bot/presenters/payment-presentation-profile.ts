import { z } from "zod";
import type { FulfillmentType } from "../../modules/catalog/fulfillment-type.js";

/** Telegram Bot API photo caption limit after entities parsing. */
export const TELEGRAM_PHOTO_CAPTION_LIMIT = 1024;
/** Telegram Bot API `copy_text` payload limit. */
export const TELEGRAM_COPY_TEXT_LIMIT = 256;

/**
 * Presentation-only policy for the mobile bank-transfer card.
 * Never carries amount, account, transfer content, HTML, URLs, or callbacks.
 */
export interface PaymentPresentationProfile {
  readonly showProductDetails: boolean;
  readonly showQuantity: boolean;
  readonly showBankHolder: boolean;
  readonly showOrderCode: boolean;
  readonly showAmountCopyButton: boolean;
  readonly showAccountCopyButton: boolean;
  readonly showTransferContentCopyButton: boolean;
  readonly showOrderCodeCopyButton: boolean;
  readonly showPaymentCheckButton: boolean;
  readonly showCancelButton: boolean;
  readonly headline: string | null;
  readonly extraNotice: string | null;
  readonly fulfillmentNotice: string | null;
}

export const DEFAULT_MOBILE_BANK_TRANSFER: PaymentPresentationProfile = {
  showProductDetails: true,
  showQuantity: false,
  showBankHolder: true,
  showOrderCode: true,
  showAmountCopyButton: true,
  showAccountCopyButton: true,
  showTransferContentCopyButton: true,
  showOrderCodeCopyButton: true,
  showPaymentCheckButton: true,
  showCancelButton: true,
  headline: null,
  extraNotice: null,
  fulfillmentNotice: null,
};

const UNSAFE_COPY = /[<>]|https?:\/\/|tg:\/\/|callback|javascript:|data:/i;

function safeCopyString(max: number) {
  return z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((value) => !UNSAFE_COPY.test(value), "unsafe presentation copy");
}

/**
 * Product-level presentation override. Strict, presentation-only.
 * Cannot set amount, bank, account, HTML, URLs, callbacks, check, or cancel.
 */
export const PAYMENT_PRESENTATION_OVERRIDE_SCHEMA = z
  .object({
    headline: safeCopyString(80).optional(),
    extraNotice: safeCopyString(160).optional(),
    fulfillmentNotice: safeCopyString(160).optional(),
    showProductDetails: z.boolean().optional(),
    showQuantity: z.boolean().optional(),
    showBankHolder: z.boolean().optional(),
    showOrderCode: z.boolean().optional(),
    showAmountCopyButton: z.boolean().optional(),
    showAccountCopyButton: z.boolean().optional(),
    showTransferContentCopyButton: z.boolean().optional(),
    showOrderCodeCopyButton: z.boolean().optional(),
  })
  .strict();

export type PaymentPresentationOverride = z.infer<typeof PAYMENT_PRESENTATION_OVERRIDE_SCHEMA>;

const FULFILLMENT_OVERLAYS: Partial<Record<FulfillmentType, Partial<PaymentPresentationProfile>>> =
  {
    STOCK_CODE: {
      fulfillmentNotice: "Thanh toán thành công → mã hàng được giao tự động.",
    },
    STOCK_ACCOUNT: {
      fulfillmentNotice: "Thanh toán thành công → tài khoản được giao tự động.",
    },
    DIGITAL_FILE: {
      fulfillmentNotice: "Thanh toán thành công → tệp được gửi trong Telegram.",
    },
    SUPPLIER_API: {
      fulfillmentNotice: "Thanh toán thành công → hệ thống kích hoạt với nhà cung cấp.",
    },
    MANUAL_FULFILLMENT: {
      fulfillmentNotice: "Thanh toán thành công → đơn chuyển sang chờ xử lý.",
    },
    QUANTITY_STOCK: {
      showQuantity: true,
      fulfillmentNotice: "Thanh toán thành công → số lượng được trừ khỏi kho.",
    },
    UNLIMITED_SERVICE: {
      fulfillmentNotice: "Thanh toán thành công → dịch vụ được kích hoạt theo gói.",
    },
  };

export function parsePaymentPresentationOverride(
  input: unknown,
): PaymentPresentationOverride | undefined {
  if (input == null) return undefined;
  const parsed = PAYMENT_PRESENTATION_OVERRIDE_SCHEMA.safeParse(input);
  return parsed.success ? parsed.data : undefined;
}

function applyPartial(
  base: PaymentPresentationProfile,
  patch: Partial<PaymentPresentationProfile> | PaymentPresentationOverride | undefined,
): PaymentPresentationProfile {
  if (!patch) return base;
  const next: PaymentPresentationProfile = { ...base };
  for (const [key, value] of Object.entries(patch) as Array<
    [keyof PaymentPresentationProfile, PaymentPresentationProfile[keyof PaymentPresentationProfile]]
  >) {
    if (value !== undefined) {
      (next as unknown as Record<string, unknown>)[key] = value;
    }
  }
  return next;
}

/**
 * Precedence: global default → fulfillment overlay → sanitized product override → trusted patch.
 * Product override cannot hide check/cancel or inject payment truth.
 */
export function resolvePaymentPresentationProfile(input: {
  fulfillmentType?: FulfillmentType;
  override?: unknown;
  patch?: Partial<PaymentPresentationProfile>;
}): PaymentPresentationProfile {
  let profile = DEFAULT_MOBILE_BANK_TRANSFER;
  if (input.fulfillmentType) {
    profile = applyPartial(profile, FULFILLMENT_OVERLAYS[input.fulfillmentType]);
  }
  const override = parsePaymentPresentationOverride(input.override);
  profile = applyPartial(profile, override);
  // Product override cannot hide check/cancel or the one-phone copy trio.
  profile = {
    ...profile,
    showAccountCopyButton: true,
    showAmountCopyButton: true,
    showTransferContentCopyButton: true,
    showPaymentCheckButton: true,
    showCancelButton: true,
  };
  const resolved = applyPartial(profile, input.patch);
  return {
    ...resolved,
    showAccountCopyButton: true,
    showAmountCopyButton: true,
    showTransferContentCopyButton: true,
  };
}

/**
 * Telegram `copy_text` accepts 1–256 Unicode code points.
 * Authoritative payment values are never truncated, normalized, or trimmed.
 * Over-limit or empty values are omitted so a copy button cannot lie.
 */
export function exactCopyText(value: string): string | undefined {
  if (value.length === 0) return undefined;
  if ([...value].length > TELEGRAM_COPY_TEXT_LIMIT) return undefined;
  return value;
}
