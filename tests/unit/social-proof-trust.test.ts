import { describe, expect, it } from "vitest";
import { presentCustomerTrustScreen } from "../../src/bot/presenters/customer.js";
import {
  generateCustomerAlias,
  TRUST_PAGE_SIZE,
  type TrustScreenData,
} from "../../src/modules/marketing/social-proof.js";

const screen: TrustScreenData = {
  page: 0,
  pageSize: TRUST_PAGE_SIZE,
  rows: [
    {
      customerAlias: generateCustomerAlias("customer-internal-id", "a".repeat(32)),
      productName: "ChatGPT Plus",
      variantName: "1 tháng",
      amountVnd: 250_000,
      completedAt: "2026-09-24T03:00:00.000Z",
    },
  ],
  completed24h: 1,
  completed7d: 1,
  completedAll: 1,
  hasPrevious: false,
  hasNext: false,
};

describe("customer trust screen", () => {
  it("renders only pseudonymous sale facts and no customer identity", () => {
    const message = presentCustomerTrustScreen(screen);
    const text = message.text.replaceAll("\u00a0", " ");
    expect(text).toContain("Khách #");
    expect(text).toContain("ChatGPT Plus");
    expect(text).toContain("250.000 ₫");
    expect(text).not.toContain("customer-internal-id");
    expect(text).not.toMatch(/telegram|username|phone|email|bank|token|vault|password/i);
  });

  it("uses bounded page navigation and one-message callback targets", () => {
    const next = presentCustomerTrustScreen({ ...screen, hasNext: true });
    const callbacks = next.buttons.flat().map((button) => button.callbackData);
    expect(callbacks).toContain("trust:page:0");
    expect(callbacks).toContain("trust:page:1");
    expect(callbacks).not.toContain("trust:broadcast");
  });

  it("requires a configured HMAC key for public aliases", () => {
    expect(() => generateCustomerAlias("customer", "short")).toThrow(
      "SOCIAL_PROOF_HMAC_KEY_REQUIRED",
    );
  });
});
