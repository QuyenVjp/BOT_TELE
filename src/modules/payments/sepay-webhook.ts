import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

/**
 * SePay webhook ingress verifier (FR-009, SR-002, SR-004, contracts/payment-sepay.md).
 *
 * Processing order is mandatory and fail-closed:
 *  1. preserve the exact raw body bytes (caller responsibility before this module);
 *  2. reject timestamps outside the configured replay window;
 *  3. HMAC-SHA256 over `{timestamp}.{raw_body}` compared in constant time;
 *  4. only then parse the allowlisted schema.
 *
 * A valid signature alone is NOT settlement. Business match (account, direction,
 * amount, content → Payment Intent) is the matcher (T052).
 */

/** Header carrying the `sha256=`-prefixed HMAC hex digest. */
export const SEPAY_SIGNATURE_HEADER = "x-sepay-signature";
/** Header carrying the Unix-seconds timestamp used in the signed string. */
export const SEPAY_TIMESTAMP_HEADER = "x-sepay-timestamp";

export interface VerifyInput {
  timestamp: string;
  rawBody: string;
  signature: string;
  secret: string;
}

/**
 * Constant-time HMAC verification of `{timestamp}.{rawBody}` against the
 * presented signature (hex). Returns false for any length/encoding mismatch —
 * never throws on a bad signature.
 */
export function verifySePaySignature(input: VerifyInput): boolean {
  const { timestamp, rawBody, signature, secret } = input;
  if (!timestamp || !signature || !secret) return false;
  if (!/^sha256=[a-f0-9]{64}$/.test(signature)) return false;
  const expected =
    "sha256=" + createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
  // timingSafeEqual requires equal-length buffers; unequal lengths are a miss.
  if (expected.length !== signature.length) return false;
  try {
    return timingSafeEqual(Buffer.from(expected, "utf8"), Buffer.from(signature, "utf8"));
  } catch {
    return false;
  }
}

/**
 * Accept a timestamp only when it is within `windowSeconds` of `nowSec`
 * (default: current wall clock). Rejects non-numeric and out-of-window values.
 */
export function isTimestampFresh(
  timestamp: string,
  windowSeconds: number,
  nowSec: number = Math.floor(Date.now() / 1000),
): boolean {
  if (!/^\d+$/.test(timestamp)) return false;
  const ts = Number(timestamp);
  if (!Number.isSafeInteger(ts) || ts < 0) return false;
  return Math.abs(nowSec - ts) <= windowSeconds;
}

/**
 * Allowlisted SePay webhook payload. Unknown extra fields are stripped by Zod
 * so a chatty provider cannot smuggle control data into the domain.
 */
export const SePayPayloadSchema = z
  .object({
    id: z.number().int().positive(),
    gateway: z.string().min(1),
    transactionDate: z.string().min(1),
    accountNumber: z.string().min(1),
    code: z.string().nullable().optional(),
    content: z.string().nullable().optional(),
    transferType: z.enum(["in", "out"]),
    transferAmount: z.number().int().positive(),
    accumulated: z.number().int().optional(),
    subAccount: z.string().nullable().optional(),
    referenceCode: z.string().nullable().optional(),
    description: z.string().nullable().optional(),
  })
  .strip();

export type SePayPayload = z.infer<typeof SePayPayloadSchema>;

/** Parse + validate the allowlisted schema; throws ZodError on invalid shape. */
export function parseSePayPayload(rawBody: string): SePayPayload {
  let json: unknown;
  try {
    json = JSON.parse(rawBody);
  } catch {
    throw new Error("SePay payload is not valid JSON");
  }
  return SePayPayloadSchema.parse(json);
}
