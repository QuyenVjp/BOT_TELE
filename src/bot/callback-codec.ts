import { Buffer } from "node:buffer";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { isId } from "../shared/ids/index.js";

const CALLBACK_PREFIX = "buy:";
const FORMAT_VERSION = 1;
const BUY_NOW_ACTION = 1;
const PAYLOAD_BYTES = 35;
const SIGNATURE_BYTES = 10;
const TOKEN_BYTES = PAYLOAD_BYTES + SIGNATURE_BYTES;
const ENCODED_BYTES = 60;
/** Telegram's hard cap on `callback_data`; every codec in this module must respect it. */
const MAX_CALLBACK_DATA_BYTES = 64;
const NONCE_BYTES = 8;
const ULID_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const MAX_UINT32 = 0xffff_ffff;

export const MAX_CALLBACK_PRICE_VND = 0xffff_ffff_ffff;

declare const verifiedCallbackBrand: unique symbol;

export interface VerifiedBuyNowCallback {
  readonly action: "BUY_NOW";
  readonly variantId: string;
  readonly expectedPriceVnd: number;
  readonly expiresAt: Date;
  readonly idempotencyKey: string;
  readonly [verifiedCallbackBrand]: true;
}

export type CallbackVerificationError =
  | "MALFORMED"
  | "UNSUPPORTED_VERSION"
  | "WRONG_ACTION"
  | "UNKNOWN_KEY_VERSION"
  | "INVALID_SIGNATURE"
  | "EXPIRED"
  | "NOT_YET_VALID";

export type VerifyBuyNowCallbackResult =
  { ok: true; value: VerifiedBuyNowCallback } | { ok: false; code: CallbackVerificationError };

export interface BuyNowCallbackCodecConfig {
  key: string;
  keyVersion: number;
  ttlSeconds: number;
  clockSkewSeconds: number;
}

export interface IssueBuyNowCallbackInput {
  telegramUserId: string | bigint | number;
  variantId: string;
  expectedPriceVnd: number;
  now?: Date;
  /** Injectable only for deterministic contract/property tests. */
  nonce?: Uint8Array;
}

export interface BuyNowCallbackCodec {
  issue(input: IssueBuyNowCallbackInput): string;
  verify(
    callbackData: string,
    input: { telegramUserId: string | bigint | number; now?: Date },
  ): VerifyBuyNowCallbackResult;
}

export function createBuyNowCallbackCodec(config: BuyNowCallbackCodecConfig): BuyNowCallbackCodec {
  const key = Buffer.from(config.key, "utf8");
  if (key.byteLength < 32) throw new Error("Buy Now callback HMAC key must be at least 32 bytes");
  if (!Number.isInteger(config.keyVersion) || config.keyVersion < 0 || config.keyVersion > 15) {
    throw new Error("Buy Now callback key version must be an integer from 0 to 15");
  }
  if (!Number.isInteger(config.ttlSeconds) || config.ttlSeconds <= 0) {
    throw new Error("Buy Now callback TTL must be a positive integer");
  }
  if (!Number.isInteger(config.clockSkewSeconds) || config.clockSkewSeconds < 0) {
    throw new Error("Buy Now callback clock skew must be a non-negative integer");
  }

  return {
    issue(input) {
      const telegramUserId = normalizeTelegramUserId(input.telegramUserId);
      if (!telegramUserId) throw new Error("Invalid Telegram user id");
      if (!isId(input.variantId)) throw new Error("Invalid product variant id");
      if (
        !Number.isSafeInteger(input.expectedPriceVnd) ||
        input.expectedPriceVnd <= 0 ||
        input.expectedPriceVnd > MAX_CALLBACK_PRICE_VND
      ) {
        throw new Error("Invalid callback price");
      }
      const nonce = Buffer.from(input.nonce ?? randomBytes(NONCE_BYTES));
      if (nonce.byteLength !== NONCE_BYTES) throw new Error("Invalid callback nonce length");
      const nowSeconds = toUnixSeconds(input.now ?? new Date());
      const expiresAtSeconds = nowSeconds + config.ttlSeconds;
      if (nowSeconds < 0 || expiresAtSeconds > MAX_UINT32) {
        throw new Error("Callback timestamp is outside the supported range");
      }

      const payload = Buffer.alloc(PAYLOAD_BYTES);
      payload[0] = (FORMAT_VERSION << 6) | (BUY_NOW_ACTION << 4) | config.keyVersion;
      encodeUlid(input.variantId).copy(payload, 1);
      payload.writeUIntBE(input.expectedPriceVnd, 17, 6);
      payload.writeUInt32BE(expiresAtSeconds, 23);
      nonce.copy(payload, 27);
      const signature = sign(key, telegramUserId, payload);
      const callbackData =
        CALLBACK_PREFIX + Buffer.concat([payload, signature]).toString("base64url");
      if (Buffer.byteLength(callbackData, "utf8") > MAX_CALLBACK_DATA_BYTES) {
        throw new Error("Encoded callback exceeds Telegram's 64-byte limit");
      }
      return callbackData;
    },

    verify(callbackData, input) {
      const telegramUserId = normalizeTelegramUserId(input.telegramUserId);
      if (!telegramUserId) return { ok: false, code: "MALFORMED" };
      if (
        typeof callbackData !== "string" ||
        !callbackData.startsWith(CALLBACK_PREFIX) ||
        Buffer.byteLength(callbackData, "utf8") !== CALLBACK_PREFIX.length + ENCODED_BYTES
      ) {
        return { ok: false, code: "MALFORMED" };
      }
      const encoded = callbackData.slice(CALLBACK_PREFIX.length);
      if (!/^[A-Za-z0-9_-]{60}$/.test(encoded)) return { ok: false, code: "MALFORMED" };

      const raw = Buffer.from(encoded, "base64url");
      if (raw.byteLength !== TOKEN_BYTES) return { ok: false, code: "MALFORMED" };
      const payload = raw.subarray(0, PAYLOAD_BYTES);
      const signature = raw.subarray(PAYLOAD_BYTES);
      const version = payload[0]! >> 6;
      const action = (payload[0]! >> 4) & 0x03;
      const keyVersion = payload[0]! & 0x0f;
      if (version !== FORMAT_VERSION) return { ok: false, code: "UNSUPPORTED_VERSION" };
      if (action !== BUY_NOW_ACTION) return { ok: false, code: "WRONG_ACTION" };
      if (keyVersion !== config.keyVersion) return { ok: false, code: "UNKNOWN_KEY_VERSION" };

      const expectedSignature = sign(key, telegramUserId, payload);
      if (
        signature.byteLength !== expectedSignature.byteLength ||
        !timingSafeEqual(signature, expectedSignature)
      ) {
        return { ok: false, code: "INVALID_SIGNATURE" };
      }

      const expectedPriceVnd = payload.readUIntBE(17, 6);
      const expiresAtSeconds = payload.readUInt32BE(23);
      const nowSeconds = toUnixSeconds(input.now ?? new Date());
      if (nowSeconds > expiresAtSeconds + config.clockSkewSeconds) {
        return { ok: false, code: "EXPIRED" };
      }
      if (expiresAtSeconds > nowSeconds + config.ttlSeconds + config.clockSkewSeconds) {
        return { ok: false, code: "NOT_YET_VALID" };
      }

      const variantId = decodeUlid(payload.subarray(1, 17));
      const nonce = payload.subarray(27, 35);
      const idempotencyDigest = createHash("sha256")
        .update("telegram-shop:buy-now:idempotency:v1\0", "utf8")
        .update(telegramUserId, "utf8")
        .update("\0", "utf8")
        .update(nonce)
        .digest()
        .subarray(0, 18)
        .toString("base64url");
      return {
        ok: true,
        value: {
          action: "BUY_NOW",
          variantId,
          expectedPriceVnd,
          expiresAt: new Date(expiresAtSeconds * 1000),
          idempotencyKey: `buy:v1:${idempotencyDigest}`,
        } as VerifiedBuyNowCallback,
      };
    },
  };
}

function sign(key: Buffer, telegramUserId: string, payload: Buffer): Buffer {
  return createHmac("sha256", key)
    .update("telegram-shop:buy-now:callback:v1\0", "utf8")
    .update(telegramUserId, "utf8")
    .update("\0", "utf8")
    .update(payload)
    .digest()
    .subarray(0, SIGNATURE_BYTES);
}

export function normalizeTelegramUserId(value: string | bigint | number): string | null {
  try {
    if (typeof value === "number" && (!Number.isSafeInteger(value) || value <= 0)) return null;
    const text = typeof value === "string" ? value : String(value);
    if (!/^[1-9][0-9]{0,19}$/.test(text)) return null;
    const parsed = BigInt(text);
    if (parsed <= 0n || parsed > 0xffff_ffff_ffff_ffffn) return null;
    return parsed.toString(10);
  } catch {
    return null;
  }
}

function toUnixSeconds(value: Date): number {
  const seconds = Math.floor(value.getTime() / 1000);
  if (!Number.isSafeInteger(seconds)) throw new Error("Invalid callback time");
  return seconds;
}

function encodeUlid(value: string): Buffer {
  let numeric = 0n;
  for (const character of value) {
    const digit = ULID_ALPHABET.indexOf(character);
    if (digit < 0) throw new Error("Invalid product variant id");
    numeric = numeric * 32n + BigInt(digit);
  }
  if (numeric > 0xffff_ffff_ffff_ffff_ffff_ffff_ffff_ffffn) {
    throw new Error("Invalid product variant id");
  }
  const bytes = Buffer.alloc(16);
  for (let index = 15; index >= 0; index--) {
    bytes[index] = Number(numeric & 0xffn);
    numeric >>= 8n;
  }
  return bytes;
}

function decodeUlid(bytes: Buffer): string {
  let numeric = 0n;
  for (const byte of bytes) numeric = (numeric << 8n) | BigInt(byte);
  let value = "";
  for (let index = 0; index < 26; index++) {
    value = ULID_ALPHABET[Number(numeric & 31n)]! + value;
    numeric >>= 5n;
  }
  return value;
}

const UNIFIED_PREFIX = "cb:";
const UNIFIED_SIGNATURE_BYTES = 8;

export const CALLBACK_ACTION_CODES = {
  SEARCH_PROMPT: 0,
  MAIN_MENU: 1,
  CATEGORY_LIST: 2,
  CATEGORY_VIEW: 3,
  VARIANT_VIEW: 4,
  CATALOG_PAGE: 5,
  ORDER_LIST: 6,
  ORDER_LIST_PAGE: 7,
  ORDER_VIEW: 8,
  PAYMENT_REFRESH: 9,
  PAYMENT_REMINDER: 34,
  PAYMENT_CANCEL: 10,
  PAYMENT_REOPEN: 11,
  SUPPORT_MENU: 12,
  SUPPORT_REASON: 13,
  ADMIN_COMMAND: 14,
  SUPPORT_TICKET_VIEW: 15,
  RESTOCK_SUBSCRIBE: 16,
  RESTOCK_UNSUBSCRIBE: 17,
  RESTOCK_LIST: 18,
  SHOP_HOME: 19,
  SHOP_OPEN: 20,
  SHOP_PRODUCT: 21,
  SHOP_PAGE: 22,
  CUSTOMER_NOTIFICATIONS: 23,
  CUSTOMER_NOTIFICATION_TOGGLE: 24,
  CUSTOMER_WARRANTY: 25,
  PREORDER_CONSENT: 26,
  PREORDER_CREATE: 27,
  CHECKOUT_PREVIEW: 28,
  CHECKOUT_WALLET: 29,
  PREORDER_LIST: 30,
  PREORDER_PAY: 31,
  CUSTOMER_TRUST: 32,
  CUSTOMER_TRUST_PAGE: 33,
} as const;
export type CallbackAction = keyof typeof CALLBACK_ACTION_CODES;

export interface IssueCallbackTokenInput {
  action: CallbackAction;
  telegramUserId: string | bigint | number;
  resourceId?: string;
  secondaryResourceId?: string;
  option?: number;
  /** VND amount bound into the token (uint48), e.g. the confirmed checkout price. */
  amountVnd?: number;
  now?: Date;
}

export interface VerifiedCallbackToken {
  action: CallbackAction;
  resourceId?: string;
  secondaryResourceId?: string;
  option?: number;
  /** Price the customer was shown, for actions that must charge exactly that price. */
  amountVnd?: number;
  expiresAt: Date;
}

export type VerifyCallbackTokenResult =
  { ok: true; value: VerifiedCallbackToken } | { ok: false; code: CallbackVerificationError };

export interface CallbackTokenCodec {
  issue(input: IssueCallbackTokenInput): string;
  verify(
    callbackData: string,
    input: { telegramUserId: string | bigint | number; now?: Date },
  ): VerifyCallbackTokenResult;
}

const ACTION_BY_CODE = new Map<number, CallbackAction>(
  Object.entries(CALLBACK_ACTION_CODES).map(([action, code]) => [code, action as CallbackAction]),
);

/**
 * Unified customer-scoped callback codec for every non-Buy-Now action.
 *
 * Action schemas determine payload length, avoiding self-describing JSON and
 * keeping even the two-ULID catalog-page token below Telegram's 64-byte cap.
 * Buy Now retains its specialized price+nonce payload but shares the same key.
 */
export function createCallbackTokenCodec(config: BuyNowCallbackCodecConfig): CallbackTokenCodec {
  const key = Buffer.from(config.key, "utf8");
  validateUnifiedConfig(config, key);

  return {
    issue(input) {
      const telegramUserId = normalizeTelegramUserId(input.telegramUserId);
      if (!telegramUserId) throw new Error("Invalid Telegram user id");
      const actionCode = CALLBACK_ACTION_CODES[input.action];
      const encodedAction = encodeActionPayload(input);
      const actionPayload =
        actionCode >= 16
          ? Buffer.concat([Buffer.from([actionCode]), encodedAction])
          : encodedAction;
      const nowSeconds = toUnixSeconds(input.now ?? new Date());
      const expiresAtSeconds = nowSeconds + config.ttlSeconds;
      if (nowSeconds < 0 || expiresAtSeconds > MAX_UINT32) {
        throw new Error("Callback timestamp is outside the supported range");
      }
      const payload = Buffer.alloc(5 + actionPayload.byteLength);
      payload[0] = (Math.min(actionCode, 15) << 4) | config.keyVersion;
      payload.writeUInt32BE(expiresAtSeconds, 1);
      actionPayload.copy(payload, 5);
      const signature = signUnified(key, telegramUserId, payload);
      const token = UNIFIED_PREFIX + Buffer.concat([payload, signature]).toString("base64url");
      if (Buffer.byteLength(token, "utf8") > MAX_CALLBACK_DATA_BYTES) {
        throw new Error("Encoded callback exceeds Telegram's 64-byte limit");
      }
      return token;
    },

    verify(callbackData, input) {
      const telegramUserId = normalizeTelegramUserId(input.telegramUserId);
      if (!telegramUserId) return { ok: false, code: "MALFORMED" };
      if (
        typeof callbackData !== "string" ||
        !callbackData.startsWith(UNIFIED_PREFIX) ||
        Buffer.byteLength(callbackData, "utf8") > MAX_CALLBACK_DATA_BYTES
      ) {
        return { ok: false, code: "MALFORMED" };
      }
      const encoded = callbackData.slice(UNIFIED_PREFIX.length);
      if (!/^[A-Za-z0-9_-]+$/.test(encoded)) return { ok: false, code: "MALFORMED" };
      const raw = Buffer.from(encoded, "base64url");
      if (raw.byteLength < 5 + UNIFIED_SIGNATURE_BYTES || raw.toString("base64url") !== encoded) {
        return { ok: false, code: "MALFORMED" };
      }
      const payload = raw.subarray(0, raw.byteLength - UNIFIED_SIGNATURE_BYTES);
      const signature = raw.subarray(raw.byteLength - UNIFIED_SIGNATURE_BYTES);
      const expected = signUnified(key, telegramUserId, payload);
      if (!timingSafeEqual(signature, expected)) {
        return { ok: false, code: "INVALID_SIGNATURE" };
      }
      const keyVersion = payload[0]! & 0x0f;
      if (keyVersion !== config.keyVersion) return { ok: false, code: "UNKNOWN_KEY_VERSION" };
      const extended = payload[0]! >> 4 === 15 && payload.byteLength !== 21;
      const action = ACTION_BY_CODE.get(extended ? payload[5]! : payload[0]! >> 4);
      if (extended && payload[5]! < 16) return { ok: false, code: "WRONG_ACTION" };
      if (!action) return { ok: false, code: "WRONG_ACTION" };
      const expiresAtSeconds = payload.readUInt32BE(1);
      const nowSeconds = toUnixSeconds(input.now ?? new Date());
      if (nowSeconds > expiresAtSeconds + config.clockSkewSeconds) {
        return { ok: false, code: "EXPIRED" };
      }
      if (expiresAtSeconds > nowSeconds + config.ttlSeconds + config.clockSkewSeconds) {
        return { ok: false, code: "NOT_YET_VALID" };
      }
      const decoded = decodeActionPayload(action, payload.subarray(extended ? 6 : 5));
      if (!decoded) return { ok: false, code: "MALFORMED" };
      return {
        ok: true,
        value: {
          action,
          ...decoded,
          expiresAt: new Date(expiresAtSeconds * 1000),
        },
      };
    },
  };
}

function validateUnifiedConfig(config: BuyNowCallbackCodecConfig, key: Buffer): void {
  if (key.byteLength < 32) throw new Error("Callback HMAC key must be at least 32 bytes");
  if (!Number.isInteger(config.keyVersion) || config.keyVersion < 0 || config.keyVersion > 15) {
    throw new Error("Callback key version must be an integer from 0 to 15");
  }
  if (!Number.isInteger(config.ttlSeconds) || config.ttlSeconds < 1 || config.ttlSeconds > 86400) {
    throw new Error("Callback TTL must be between 1 and 86400 seconds");
  }
  if (
    !Number.isInteger(config.clockSkewSeconds) ||
    config.clockSkewSeconds < 0 ||
    config.clockSkewSeconds > 60
  ) {
    throw new Error("Callback clock skew must be between 0 and 60 seconds");
  }
}

function encodeActionPayload(input: IssueCallbackTokenInput): Buffer {
  switch (input.action) {
    case "SEARCH_PROMPT":
    case "MAIN_MENU":
    case "CATEGORY_LIST":
    case "ORDER_LIST":
    case "RESTOCK_LIST":
    case "SHOP_HOME":
    case "SHOP_OPEN":
    case "CUSTOMER_NOTIFICATIONS":
    case "CUSTOMER_WARRANTY":
    case "PREORDER_LIST":
    case "CUSTOMER_TRUST":
      assertNoPayload(input);
      return Buffer.alloc(0);
    case "CATEGORY_VIEW": {
      // A category or brand page number rides in the token: the sealer maps
      // `cat:view:<id>:<page>` to this action, so refusing an option here made every listing with
      // more than one page throw at render time and never reach the customer.
      if (!input.resourceId || input.secondaryResourceId !== undefined)
        throw new Error("Invalid category view callback payload");
      const base = encodeResourceId(input.resourceId);
      return input.option === undefined ? base : Buffer.concat([base, Buffer.from([input.option])]);
    }
    case "VARIANT_VIEW":
    case "ORDER_LIST_PAGE":
    case "ORDER_VIEW":
    case "PAYMENT_REFRESH":
    case "PAYMENT_REMINDER":
    case "PAYMENT_CANCEL":
    case "PAYMENT_REOPEN":
    case "SUPPORT_TICKET_VIEW":
    case "RESTOCK_SUBSCRIBE":
    case "RESTOCK_UNSUBSCRIBE":
    case "SHOP_PRODUCT":
    case "SHOP_PAGE":
    case "PREORDER_CONSENT":
    case "PREORDER_CREATE":
    case "PREORDER_PAY":
    case "CHECKOUT_PREVIEW":
      assertOnlyResource(input);
      return encodeResourceId(input.resourceId!);
    case "CHECKOUT_WALLET": {
      // The confirmed price rides in the token. Without it the wallet path would re-read the
      // live price and hand THAT to buyNow as the expected price, making the stale-price guard
      // self-fulfilling and silently charging a price the customer never saw.
      if (!input.resourceId || input.option !== undefined) {
        throw new Error("Invalid checkout wallet callback payload");
      }
      const amountVnd = input.amountVnd;
      if (
        !Number.isSafeInteger(amountVnd) ||
        amountVnd! <= 0 ||
        amountVnd! > MAX_CALLBACK_PRICE_VND
      ) {
        throw new Error("Invalid checkout wallet amount");
      }
      const amount = Buffer.alloc(6);
      amount.writeUIntBE(amountVnd!, 0, 6);
      // The attempt id is what makes a SECOND purchase of the same variant possible: the order
      // idempotency key is derived from it, so tapping the same preview twice still collapses to
      // one order, while a freshly rendered preview is a new attempt. Without it the key had to be
      // derived from customer+variant, which permanently blocked repeat purchases of a variant.
      if (input.secondaryResourceId === undefined)
        return Buffer.concat([encodeResourceId(input.resourceId), amount]);
      const attempt = decodeAttemptId(input.secondaryResourceId);
      if (!attempt) throw new Error("Invalid checkout wallet attempt id");
      // The attempt id is 6 random bytes carried as 8 base64url characters. A full 16-byte ULID
      // would push the finished token to 67 bytes and the issue() guard would refuse it — Telegram
      // caps callback_data at 64 — so the attempt id is sized to fit: 51 bytes without it, 59 with.
      return Buffer.concat([encodeResourceId(input.resourceId), amount, attempt]);
    }
    case "CUSTOMER_TRUST_PAGE": {
      if (
        input.resourceId !== undefined ||
        input.secondaryResourceId !== undefined ||
        !Number.isInteger(input.option) ||
        input.option! < 0 ||
        input.option! > 255
      )
        throw new Error("Invalid trust page callback payload");
      return Buffer.from([input.option!]);
    }
    case "CUSTOMER_NOTIFICATION_TOGGLE":
      assertOnlyResource(input);
      return encodeResourceId(input.resourceId!);
    case "CATALOG_PAGE": {
      if (!input.resourceId || input.option !== undefined)
        throw new Error("Invalid catalog page callback payload");
      return input.secondaryResourceId
        ? Buffer.concat([
            encodeResourceId(input.resourceId),
            encodeResourceId(input.secondaryResourceId),
          ])
        : encodeResourceId(input.resourceId);
    }
    case "SUPPORT_MENU":
      if (input.secondaryResourceId !== undefined || input.option !== undefined)
        throw new Error("Invalid support menu callback payload");
      return input.resourceId ? encodeResourceId(input.resourceId) : Buffer.alloc(0);
    case "SUPPORT_REASON":
    case "ADMIN_COMMAND": {
      if (
        input.secondaryResourceId !== undefined ||
        !Number.isInteger(input.option) ||
        input.option! < 0 ||
        input.option! > 255 ||
        (input.action === "ADMIN_COMMAND" && !input.resourceId)
      )
        throw new Error("Invalid callback option payload");
      const option = Buffer.from([input.option!]);
      return input.resourceId
        ? Buffer.concat([encodeResourceId(input.resourceId), option])
        : option;
    }
  }
  throw new Error("Unsupported callback action");
}

function decodeActionPayload(
  action: CallbackAction,
  payload: Buffer,
): Omit<VerifiedCallbackToken, "action" | "expiresAt"> | null {
  if (
    [
      "SEARCH_PROMPT",
      "MAIN_MENU",
      "CATEGORY_LIST",
      "ORDER_LIST",
      "RESTOCK_LIST",
      "SHOP_HOME",
      "SHOP_OPEN",
      "CUSTOMER_NOTIFICATIONS",
      "CUSTOMER_WARRANTY",
      "PREORDER_LIST",
      "CUSTOMER_TRUST",
    ].includes(action)
  ) {
    return payload.byteLength === 0 ? {} : null;
  }
  if (
    [
      "VARIANT_VIEW",
      "ORDER_LIST_PAGE",
      "ORDER_VIEW",
      "PAYMENT_REFRESH",
      "PAYMENT_REMINDER",
      "PAYMENT_CANCEL",
      "PAYMENT_REOPEN",
      "SUPPORT_TICKET_VIEW",
      "RESTOCK_SUBSCRIBE",
      "RESTOCK_UNSUBSCRIBE",
      "SHOP_PRODUCT",
      "SHOP_PAGE",
      "PREORDER_CONSENT",
      "PREORDER_CREATE",
      "PREORDER_PAY",
      "CUSTOMER_NOTIFICATION_TOGGLE",
      "CHECKOUT_PREVIEW",
    ].includes(action)
  ) {
    if (payload.byteLength === 16) return { resourceId: decodeUlid(payload) };
    return payload.byteLength === 26 ? { resourceId: payload.toString("utf8") } : null;
  }
  if (action === "CUSTOMER_TRUST_PAGE") {
    return payload.byteLength === 1 ? { option: payload[0]! } : null;
  }
  if (action === "CHECKOUT_WALLET") {
    if (payload.byteLength === 22)
      return {
        resourceId: decodeUlid(payload.subarray(0, 16)),
        amountVnd: payload.readUIntBE(16, 6),
      };
    return payload.byteLength === 28
      ? {
          resourceId: decodeUlid(payload.subarray(0, 16)),
          amountVnd: payload.readUIntBE(16, 6),
          secondaryResourceId: payload.subarray(22, 28).toString("base64url"),
        }
      : null;
  }
  if (action === "CATALOG_PAGE") {
    if (payload.byteLength === 16) return { resourceId: decodeUlid(payload) };
    return payload.byteLength === 32
      ? {
          resourceId: decodeUlid(payload.subarray(0, 16)),
          secondaryResourceId: decodeUlid(payload.subarray(16)),
        }
      : null;
  }
  if (action === "SUPPORT_MENU") {
    if (payload.byteLength === 0) return {};
    return payload.byteLength === 16 ? { resourceId: decodeUlid(payload) } : null;
  }
  if (action === "CATEGORY_VIEW") {
    if (payload.byteLength === 16) return { resourceId: decodeUlid(payload) };
    return payload.byteLength === 17
      ? { resourceId: decodeUlid(payload.subarray(0, 16)), option: payload[16]! }
      : null;
  }
  if (action === "SUPPORT_REASON") {
    if (payload.byteLength === 1) return { option: payload[0]! };
    return payload.byteLength === 17
      ? { resourceId: decodeUlid(payload.subarray(0, 16)), option: payload[16]! }
      : null;
  }
  if (action === "ADMIN_COMMAND") {
    return payload.byteLength === 17
      ? { resourceId: decodeUlid(payload.subarray(0, 16)), option: payload[16]! }
      : null;
  }
  return null;
}

function assertNoPayload(input: IssueCallbackTokenInput): void {
  if (
    input.resourceId !== undefined ||
    input.secondaryResourceId !== undefined ||
    input.option !== undefined
  ) {
    throw new Error("Callback action does not accept a payload");
  }
}

function decodeAttemptId(value: string): Buffer | null {
  if (!/^[A-Za-z0-9_-]{8}$/.test(value)) return null;
  const bytes = Buffer.from(value, "base64url");
  return bytes.byteLength === 6 ? bytes : null;
}

function assertOnlyResource(input: IssueCallbackTokenInput): void {
  if (!input.resourceId || input.secondaryResourceId !== undefined || input.option !== undefined) {
    throw new Error("Callback action requires exactly one resource");
  }
}

function encodeResourceId(resourceId: string): Buffer {
  if (isId(resourceId)) return encodeUlid(resourceId);
  if (/^[0-9A-Z]{26}$/.test(resourceId)) return Buffer.from(resourceId, "ascii");
  throw new Error("Invalid callback resource id");
}

function signUnified(key: Buffer, telegramUserId: string, payload: Buffer): Buffer {
  return createHmac("sha256", key)
    .update("telegram-shop:callback:v1\0", "utf8")
    .update(telegramUserId, "utf8")
    .update("\0", "utf8")
    .update(payload)
    .digest()
    .subarray(0, UNIFIED_SIGNATURE_BYTES);
}

/**
 * Untrusted action hint used only to select a rate-limit bucket before verification.
 *
 * Scoped to the customer `cb:` prefix: admin tokens carry the distinct `adm:` prefix, so they
 * never decode here and can never be classified as a customer action.
 */
export function peekCallbackAction(callbackData: string): CallbackAction | null {
  if (
    !callbackData.startsWith(UNIFIED_PREFIX) ||
    Buffer.byteLength(callbackData, "utf8") > MAX_CALLBACK_DATA_BYTES
  )
    return null;
  const encoded = callbackData.slice(UNIFIED_PREFIX.length);
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) return null;
  const raw = Buffer.from(encoded, "base64url");
  if (raw.byteLength < 5 + UNIFIED_SIGNATURE_BYTES || raw.toString("base64url") !== encoded)
    return null;
  // Mirror `verify` exactly: actions >= 16 are packed in the EXTENDED form, where the high
  // nibble is a 15 sentinel and the real code sits at offset 5. Reading only the nibble made
  // every extended action (RESTOCK_*, SHOP_PRODUCT, PREORDER_*, CUSTOMER_WARRANTY and the
  // checkout pair) peek as SUPPORT_TICKET_VIEW, so the pre-verification rate-limit bucket
  // could not tell them apart. The 21-byte exception is SUPPORT_TICKET_VIEW itself, whose
  // non-extended payload (5 header + 16 resource) also starts with the 15 sentinel nibble.
  const payload = raw.subarray(0, raw.byteLength - UNIFIED_SIGNATURE_BYTES);
  const keyVersionMatches = (payload[0]! & 0x0f) >= 0;
  const extended = payload[0]! >> 4 === 15 && payload.byteLength !== 21;
  if (!keyVersionMatches) return null;
  const actionCode = extended ? payload[5]! : payload[0]! >> 4;
  if (extended && actionCode < 16) return null;
  return ACTION_BY_CODE.get(actionCode) ?? null;
}
// An admin-scoped signed callback codec (`adm:`) was prototyped here and then removed: it
// had no production caller, and every privileged callback it would have signed is already
// gated by stronger, live controls — the numeric-id root identity check plus the private-chat
// requirement (`guardRootAction`), the durable expiring confirmation challenge, and step-up
// for the actions that move money or reach every customer. A second, unproven signing scheme
// would have been a third mechanism to keep correct, and Telegram already guarantees
// `callback_query.from.id` is authentic, so the actor id is never read from the payload.
