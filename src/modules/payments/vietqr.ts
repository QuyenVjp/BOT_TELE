import { MoneyError } from "../../shared/money/index.js";

/**
 * VietQR generator (FR-008, contracts/payment-sepay.md, T148/T149).
 *
 * Produces an EMVCo-compliant QR payload for NAPAS VietQR with an EXACT integer
 * VND amount and a UNIQUE transfer content. The payload is payment *initiation*
 * only — it never asserts settlement. Settlement truth comes solely from verified
 * SePay evidence.
 *
 * Correctness rules (independent review findings):
 *  - TLV length is the UTF-8 BYTE length, not the JS character count. Vietnamese
 *    accented account names otherwise produce an unscannable QR.
 *  - The NAPAS service code (sub-tag 02 of merchant account info) is
 *    QRIBFTTA / QRIBFTTC, and is the only service hint in the payload.
 *  - CRC-16/CCITT (poly 0x1021, init 0xFFFF) over the UTF-8 bytes of the body
 *    including the CRC tag+length placeholder ("6304").
 *
 * The QR IMAGE is rendered locally by the presenter (`qrcode.toBuffer(payload)`
 * in bot/presenters/payment.ts) from the payload below; the copyable
 * account/amount/content come from {@link presentPayment}. No external image
 * endpoint is involved.
 */

export interface VietQrInput {
  /** 6-digit NAPAS bank BIN (e.g. 970422 for MB). */
  bankBin: string;
  accountNumber: string;
  accountName: string;
  amountVnd: number;
  transferContent: string;
  /**
   * NAPAS service code. Defaults to QRIBFTTA (account-number transfer).
   * Must be one of the NAPAS codes.
   */
  serviceCode?: "QRIBFTTA" | "QRIBFTTC";
  /** Public bank alias (e.g. MB) from config; not part of the payload or output. */
  bankAlias?: string;
}

/** CRC-16/CCITT (poly 0x1021, init 0xFFFF) over the UTF-8 bytes of `input`. */
export function crc16Ccitt(input: string): number {
  let crc = 0xffff;
  const bytes = Buffer.from(input, "utf8");
  for (const byte of bytes) {
    crc ^= byte << 8;
    for (let i = 0; i < 8; i++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc & 0xffff;
}

/**
 * EMVCo TLV field: 2-digit id + 2-digit zero-padded UTF-8 BYTE length + value.
 * Length is measured in UTF-8 bytes so multibyte Vietnamese characters count
 * correctly (T148 finding).
 */
function tlv(id: string, value: string): string {
  const byteLen = Buffer.byteLength(value, "utf8");
  if (byteLen > 99) {
    throw new MoneyError(`VietQR field ${id} exceeds EMVCo length limit`);
  }
  const len = byteLen.toString().padStart(2, "0");
  return `${id}${len}${value}`;
}

const GUID_NAPAS = "A000000727";
const DEFAULT_SERVICE_CODE = "QRIBFTTA" as const;
const ALLOWED_SERVICE_CODES = new Set(["QRIBFTTA", "QRIBFTTC"]);

/**
 * Build the EMVCo QR payload string. The consumer renders it to a QR image; the
 * copyable account/amount/content come from {@link presentPayment}.
 */
export function buildVietQrPayload(input: VietQrInput): string {
  if (!Number.isInteger(input.amountVnd) || input.amountVnd <= 0) {
    throw new MoneyError("VietQR amount must be a positive integer VND");
  }
  if (!input.transferContent || input.transferContent.trim().length === 0) {
    throw new MoneyError("VietQR requires a non-empty unique transfer content");
  }
  // Strict 6-digit BIN (NAPAS bank identification number).
  if (!/^\d{6}$/.test(input.bankBin)) {
    throw new MoneyError("VietQR requires a 6-digit numeric bank BIN");
  }
  if (!input.accountNumber || input.accountNumber.length < 4 || input.accountNumber.length > 19) {
    throw new MoneyError("VietQR account number must be 4–19 characters");
  }

  // Service code is a NAPAS code only; nothing else may influence it.
  const serviceCode = input.serviceCode ?? DEFAULT_SERVICE_CODE;
  if (!ALLOWED_SERVICE_CODES.has(serviceCode)) {
    throw new MoneyError(`VietQR service code must be QRIBFTTA or QRIBFTTC, got ${serviceCode}`);
  }

  // Merchant account information (tag 38): NAPAS GUID + acquirer/merchant info.
  const beneficiary = tlv("00", input.bankBin) + tlv("01", input.accountNumber);
  const merchantAccountInfo =
    tlv("00", GUID_NAPAS) + tlv("01", beneficiary) + tlv("02", serviceCode);

  // Additional data (tag 62): transfer content in sub-tag 08 (purpose of txn).
  // Bound the content so the EMVCo field stays within the 25-char purpose limit.
  const content = input.transferContent.slice(0, 25);
  const additionalData = tlv("08", content);

  // Account name is truncated to 25 UTF-8 BYTES (not chars) to stay under the
  // EMVCo merchant-name limit while still encoding Vietnamese correctly.
  const accountName = truncateUtf8(input.accountName, 25);

  const body =
    tlv("00", "01") + // payload format indicator
    tlv("01", "12") + // point of initiation: 12 = dynamic (one-time)
    tlv("38", merchantAccountInfo) +
    tlv("53", "704") + // currency: VND (ISO 4217 704)
    tlv("54", String(input.amountVnd)) +
    tlv("58", "VN") + // country
    tlv("59", accountName) +
    tlv("62", additionalData);

  // CRC is computed over the body PLUS the CRC tag+length ("6304").
  const toCrc = body + "6304";
  const crc = crc16Ccitt(toCrc).toString(16).toUpperCase().padStart(4, "0");
  return toCrc + crc;
}

/** Truncate a string so its UTF-8 byte length is ≤ maxBytes, never mid-codepoint. */
function truncateUtf8(value: string, maxBytes: number): string {
  const buf = Buffer.from(value, "utf8");
  if (buf.length <= maxBytes) return value;
  // Walk code points until the remaining bytes fit.
  let out = "";
  let used = 0;
  for (const ch of value) {
    const n = Buffer.byteLength(ch, "utf8");
    if (used + n > maxBytes) break;
    out += ch;
    used += n;
  }
  return out;
}

/**
 * Parse an EMVCo TLV string into its top-level fields. Length is interpreted as
 * UTF-8 BYTES so a payload built by {@link buildVietQrPayload} round-trips.
 * Used by golden-vector tests and any downstream parser.
 */
export interface EmvTlvField {
  id: string;
  declaredLength: number;
  value: string;
}

export function parseEmvTlv(payload: string): EmvTlvField[] {
  const bytes = Buffer.from(payload, "utf8");
  const fields: EmvTlvField[] = [];
  let offset = 0;
  while (offset + 4 <= bytes.length) {
    const id = bytes.subarray(offset, offset + 2).toString("utf8");
    const lenStr = bytes.subarray(offset + 2, offset + 4).toString("utf8");
    const len = Number(lenStr);
    if (!Number.isInteger(len) || len < 0) break;
    offset += 4;
    if (offset + len > bytes.length) break;
    const value = bytes.subarray(offset, offset + len).toString("utf8");
    offset += len;
    fields.push({ id, declaredLength: len, value });
  }
  return fields;
}

export interface PresentPaymentInput extends VietQrInput {
  orderNumber: string;
  expiresAt: Date;
  /** Optional bank display name for the payment card (e.g. "MB Bank"). */
  bankName?: string;
}

export interface PaymentPresentation {
  payload: string;
  bankBin: string;
  accountNumber: string;
  accountName: string;
  amountVnd: number;
  transferContent: string;
  orderNumber: string;
  /** ISO-8601 UTC. Presenters format this to Asia/Ho_Chi_Minh for display. */
  expiresAt: string;
  /** Optional bank display name (never affects the QR payload). */
  bankName?: string;
}

/**
 * Presentation view for the payment screen: QR payload + copyable fields + expiry.
 * Deliberately carries NO settlement flag — VietQR initiates, SePay settles.
 * The QR image is rendered locally by the presenter from `payload`; this function
 * returns no image URL.
 */
export function presentPayment(input: PresentPaymentInput): PaymentPresentation {
  const payload = buildVietQrPayload(input);
  const presentation: PaymentPresentation = {
    payload,
    bankBin: input.bankBin,
    accountNumber: input.accountNumber,
    accountName: input.accountName,
    amountVnd: input.amountVnd,
    transferContent: input.transferContent,
    orderNumber: input.orderNumber,
    expiresAt: input.expiresAt.toISOString(),
  };
  if (input.bankName !== undefined) presentation.bankName = input.bankName;
  return presentation;
}
