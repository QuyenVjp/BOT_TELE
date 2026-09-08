import { describe, expect, it } from "vitest";
import {
  classifyPaymentCode,
  generateOrderPaymentCode,
  isOrderPaymentCode,
} from "../../src/modules/payments/payment-code.js";

describe("payment code families", () => {
  it("generates and validates explicit order payment codes", () => {
    const code = generateOrderPaymentCode("ORD-20260908-ABCD12345678");
    expect(code).toMatch(/^ORD[A-Z0-9]{12}$/);
    expect(isOrderPaymentCode(code)).toBe(true);
  });

  it("routes wallet, order, and unknown families explicitly", () => {
    expect(classifyPaymentCode("napviABC123")).toBe("WALLET_TOPUP");
    expect(classifyPaymentCode("ORDABC123456789")).toBe("ORDER");
    expect(classifyPaymentCode("PAYMENT123")).toBe("UNKNOWN");
  });
});
