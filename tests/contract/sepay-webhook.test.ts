import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import {
  verifySePaySignature,
  parseSePayPayload,
  isTimestampFresh,
  SEPAY_SIGNATURE_HEADER,
  SEPAY_TIMESTAMP_HEADER,
  type SePayPayload,
} from "../../src/modules/payments/sepay-webhook.js";

/**
 * T041 — SePay raw-body HMAC, timestamp, schema, account/direction/amount/content
 * (FR-009, SR-002, SR-004, contracts/payment-sepay.md).
 *
 * Processing order is mandatory:
 *  1. preserve exact raw bytes;
 *  2. reject timestamps outside the replay window;
 *  3. HMAC over `{timestamp}.{raw_body}` compared constant-time;
 *  4. only then parse the allowlisted schema.
 *
 * A valid signature with mismatched business fields is still NOT settlement —
 * that is the matcher (T052). Here we only prove the ingress integrity gates.
 */

const SECRET = "sepay-hmac-secret-abcdefgh";

function sign(timestamp: string, rawBody: string, secret: string = SECRET): string {
  return `sha256=${createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex")}`;
}

const VALID_BODY: SePayPayload = {
  id: 123456,
  gateway: "MBBank",
  transactionDate: "2026-07-16 12:00:00",
  accountNumber: "0123456789",
  code: null,
  content: "ORD20260716A1B2C3D4",
  transferType: "in",
  transferAmount: 150000,
  accumulated: 150000,
  subAccount: null,
  referenceCode: "FT123456",
  description: "ORD20260716A1B2C3D4",
};

function rawOf(payload: SePayPayload = VALID_BODY): string {
  return JSON.stringify(payload);
}

describe("SePay signature verification (SR-002)", () => {
  it("accepts a valid HMAC over {timestamp}.{raw_body}", () => {
    const ts = "1721131200";
    const raw = rawOf();
    const sig = sign(ts, raw);
    expect(
      verifySePaySignature({ timestamp: ts, rawBody: raw, signature: sig, secret: SECRET }),
    ).toBe(true);
  });

  it("rejects a tampered body", () => {
    const ts = "1721131200";
    const raw = rawOf();
    const sig = sign(ts, raw);
    const tampered = rawOf({ ...VALID_BODY, transferAmount: 1 });
    expect(
      verifySePaySignature({ timestamp: ts, rawBody: tampered, signature: sig, secret: SECRET }),
    ).toBe(false);
  });

  it("rejects a wrong secret", () => {
    const ts = "1721131200";
    const raw = rawOf();
    const sig = sign(ts, raw, "wrong-secret-value-xxxx");
    expect(
      verifySePaySignature({ timestamp: ts, rawBody: raw, signature: sig, secret: SECRET }),
    ).toBe(false);
  });

  it("rejects missing/empty signature or timestamp", () => {
    const raw = rawOf();
    expect(
      verifySePaySignature({ timestamp: "", rawBody: raw, signature: "abc", secret: SECRET }),
    ).toBe(false);
    expect(
      verifySePaySignature({ timestamp: "1", rawBody: raw, signature: "", secret: SECRET }),
    ).toBe(false);
  });
});

describe("SePay timestamp freshness (SR-002 / SR-004)", () => {
  it("accepts a timestamp inside the replay window", () => {
    const nowSec = Math.floor(Date.now() / 1000);
    expect(isTimestampFresh(String(nowSec), 300, nowSec)).toBe(true);
    expect(isTimestampFresh(String(nowSec - 100), 300, nowSec)).toBe(true);
  });

  it("rejects a timestamp outside the replay window", () => {
    const nowSec = Math.floor(Date.now() / 1000);
    expect(isTimestampFresh(String(nowSec - 600), 300, nowSec)).toBe(false);
    expect(isTimestampFresh(String(nowSec + 600), 300, nowSec)).toBe(false);
  });

  it("rejects a non-numeric timestamp", () => {
    expect(isTimestampFresh("not-a-number", 300, 1_000_000)).toBe(false);
  });
});

describe("SePay payload schema (allowlisted)", () => {
  it("parses a valid payload", () => {
    const parsed = parseSePayPayload(rawOf());
    expect(parsed.id).toBe(123456);
    expect(parsed.transferType).toBe("in");
    expect(parsed.transferAmount).toBe(150000);
    expect(parsed.content).toBe("ORD20260716A1B2C3D4");
    expect(parsed.accountNumber).toBe("0123456789");
  });

  it("rejects a payload missing required fields", () => {
    expect(() => parseSePayPayload(JSON.stringify({ id: 1 }))).toThrow();
  });

  it("rejects a non-integer amount", () => {
    expect(() =>
      parseSePayPayload(rawOf({ ...VALID_BODY, transferAmount: 1.5 as unknown as number })),
    ).toThrow();
  });

  it("rejects an unknown transferType", () => {
    expect(() =>
      parseSePayPayload(rawOf({ ...VALID_BODY, transferType: "sideways" as "in" })),
    ).toThrow();
  });
});

describe("header constants", () => {
  it("exposes the documented signature and timestamp header names", () => {
    expect(SEPAY_SIGNATURE_HEADER.toLowerCase()).toContain("sepay");
    expect(SEPAY_TIMESTAMP_HEADER.toLowerCase()).toContain("time");
  });
});
