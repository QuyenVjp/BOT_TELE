import { describe, expect, it } from "vitest";
import {
  buildVietQrPayload,
  crc16Ccitt,
  parseEmvTlv,
  presentPayment,
  type VietQrInput,
} from "../../src/modules/payments/vietqr.js";

/**
 * T040 — VietQR payload/CRC/presentation (FR-008, contracts/payment-sepay.md).
 *
 * VietQR is payment INITIATION only: exact integer VND amount + unique transfer
 * content + merchant bank identity. The rendered payload never asserts settlement.
 * CRC-16/CCITT (poly 0x1021, init 0xFFFF) is the NAPAS/EMVCo standard.
 *
 * The QR IMAGE is rendered locally by the presenter (`qrcode.toBuffer(payload)`);
 * this module emits the EMVCo payload, never an image URL.
 */

const BASE: VietQrInput = {
  bankBin: "970422", // MB Bank
  accountNumber: "0123456789",
  accountName: "SHOP DIGITAL",
  amountVnd: 150000,
  transferContent: "ORD20260716A1B2C3D4",
};

describe("CRC-16/CCITT (EMVCo)", () => {
  it("computes the known EMVCo sample CRC", () => {
    // EMVCo sample string used widely for CRC-16/CCITT validation.
    // "123456789" → 0x29B1 under poly 0x1021, init 0xFFFF.
    expect(crc16Ccitt("123456789")).toBe(0x29b1);
  });
});

describe("VietQR payload (FR-008)", () => {
  it("embeds exact amount, bank BIN, account number, and transfer content", () => {
    const payload = buildVietQrPayload(BASE);
    // Payload is EMVCo TLV; amount is tag 54, content is under additional data.
    expect(payload).toContain("54"); // amount tag
    expect(payload).toContain(String(BASE.amountVnd));
    expect(payload).toContain(BASE.bankBin);
    expect(payload).toContain(BASE.accountNumber);
    expect(payload).toContain(BASE.transferContent);
    // CRC is the last 4 hex chars after tag 63.
    expect(payload).toMatch(/6304[0-9A-F]{4}$/);
  });

  it("rejects a non-positive amount (exact integer VND only)", () => {
    expect(() => buildVietQrPayload({ ...BASE, amountVnd: 0 })).toThrow();
    expect(() => buildVietQrPayload({ ...BASE, amountVnd: -1 })).toThrow();
    expect(() => buildVietQrPayload({ ...BASE, amountVnd: 1.5 as unknown as number })).toThrow();
  });

  it("rejects empty transfer content (unique content is required)", () => {
    expect(() => buildVietQrPayload({ ...BASE, transferContent: "" })).toThrow();
  });

  it("CRC is consistent with the payload body", () => {
    const payload = buildVietQrPayload(BASE);
    // Strip the trailing CRC hex (4 chars after "6304") and recompute.
    const body = payload.slice(0, -4);
    const expected = crc16Ccitt(body).toString(16).toUpperCase().padStart(4, "0");
    expect(payload.slice(-4)).toBe(expected);
  });
});

describe("payment presentation (FR-008)", () => {
  it("returns copyable amount/content/account and an expiry, never a settlement claim", () => {
    const expiresAt = new Date("2026-07-16T12:15:00.000Z");
    const view = presentPayment({
      ...BASE,
      orderNumber: "ORD-20260716-A1B2C3D4",
      expiresAt,
    });
    expect(view.amountVnd).toBe(150000);
    expect(view.transferContent).toBe(BASE.transferContent);
    expect(view.accountNumber).toBe(BASE.accountNumber);
    expect(view.accountName).toBe(BASE.accountName);
    expect(view.bankBin).toBe(BASE.bankBin);
    expect(view.payload).toMatch(/6304[0-9A-F]{4}$/);
    // The presentation carries the EMVCo payload the renderer encodes; no image URL.
    expect(view).not.toHaveProperty("imageUrl");
    // Payload proves it encodes the exact amount, beneficiary account and content.
    const top = parseEmvTlv(view.payload);
    expect(top.find((f) => f.id === "54")?.value).toBe("150000");
    expect(top.find((f) => f.id === "53")?.value).toBe("704");
    expect(top.find((f) => f.id === "58")?.value).toBe("VN");
    const merchant = parseEmvTlv(top.find((f) => f.id === "38")!.value);
    const acquirer = parseEmvTlv(merchant.find((f) => f.id === "01")!.value);
    expect(acquirer.find((f) => f.id === "00")?.value).toBe(BASE.bankBin);
    expect(acquirer.find((f) => f.id === "01")?.value).toBe(BASE.accountNumber);
    const additional = parseEmvTlv(top.find((f) => f.id === "62")!.value);
    expect(additional.find((f) => f.id === "08")?.value).toBe(BASE.transferContent);
    expect(view.expiresAt).toBe(expiresAt.toISOString());
    // Presentation is initiation only — no settlement language.
    const joined = JSON.stringify(view).toLowerCase();
    expect(joined).not.toContain("settled");
    expect(joined).not.toContain("paid");
    expect(joined).not.toContain("đã thanh toán");
  });
});
