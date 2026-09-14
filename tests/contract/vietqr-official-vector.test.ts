import { describe, expect, it } from "vitest";
import { buildVietQrPayload, crc16Ccitt, parseEmvTlv } from "../../src/modules/payments/vietqr.js";

/**
 * T148 — Official VietQR / EMVCo correctness (no Docker).
 *
 * Findings from the independent review:
 *   - TLV length must be UTF-8 BYTE length, not JS char count. Vietnamese
 *     accented account names otherwise produce a wrong length → unscannable QR.
 *   - The NAPAS service code (sub-tag 02 of the merchant account info) is
 *     QRIBFTTA/QRIBFTTC and is the only service hint in the payload.
 *   - CRC-16/CCITT over the UTF-8 bytes including the "6304" tag+length.
 */

const BASE = {
  bankBin: "970422",
  accountNumber: "0123456789",
  accountName: "SHOP DIGITAL MVP",
  amountVnd: 150000,
  transferContent: "ORDABC123",
};

describe("EMVCo TLV byte-length correctness", () => {
  it("encodes multibyte (Vietnamese) values with UTF-8 BYTE length", () => {
    const payload = buildVietQrPayload({ ...BASE, accountName: "NGUYỄN VĂN Ê" });
    const fields = parseEmvTlv(payload);
    const name = fields.find((f) => f.id === "59");
    expect(name).toBeDefined();
    // The declared length must equal the UTF-8 byte length of the value.
    const byteLen = Buffer.from(name!.value, "utf8").length;
    expect(name!.declaredLength).toBe(byteLen);
    // And a naive char-count encoding would have been wrong here.
    expect(byteLen).toBeGreaterThan(name!.value.length);
  });

  it("round-trips every top-level field (parse re-reads what build wrote)", () => {
    const payload = buildVietQrPayload(BASE);
    const fields = parseEmvTlv(payload);
    // Required EMVCo tags present.
    for (const id of ["00", "01", "38", "53", "54", "58", "59", "62", "63"]) {
      expect(fields.map((f) => f.id)).toContain(id);
    }
    // Currency VND + exact amount.
    expect(fields.find((f) => f.id === "53")?.value).toBe("704");
    expect(fields.find((f) => f.id === "54")?.value).toBe("150000");
  });
});

describe("NAPAS service code", () => {
  it("uses a valid NAPAS service code (QRIBFTTA)", () => {
    const payload = buildVietQrPayload(BASE);
    const fields = parseEmvTlv(payload);
    const merchant = fields.find((f) => f.id === "38");
    expect(merchant).toBeDefined();
    const sub = parseEmvTlv(merchant!.value);
    const serviceCode = sub.find((f) => f.id === "02")?.value;
    expect(["QRIBFTTA", "QRIBFTTC"]).toContain(serviceCode);
  });
});

describe("CRC-16/CCITT trailer", () => {
  it("appends a valid CRC over the body including the 6304 tag", () => {
    const payload = buildVietQrPayload(BASE);
    // Strip the last 4 hex chars (the CRC value) and recompute over body+"6304".
    const body = payload.slice(0, -4);
    const expected = crc16Ccitt(body).toString(16).toUpperCase().padStart(4, "0");
    expect(payload.slice(-4)).toBe(expected);
    expect(body.endsWith("6304")).toBe(true);
  });
});
