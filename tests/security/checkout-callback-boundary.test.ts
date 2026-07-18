import { describe, expect, it } from "vitest";
import { createCheckoutCallbacks } from "../../src/bot/callbacks/checkout.js";
import type { Db } from "../../src/infrastructure/db/transaction.js";

describe("checkout callback production boundary", () => {
  it("does not export an unsigned Buy Now entrypoint accepting caller-owned customer identity", () => {
    const callbacks = createCheckoutCallbacks({
      db: {} as Db,
      merchant: {
        merchantAccountId: "merchant-account",
        beneficiaryAccountNumber: "0123456789",
        bankBin: "970422",
        accountName: "SHOP DIGITAL",
        bankName: "MB Bank",
      },
    });

    expect(callbacks).not.toHaveProperty("buyNow");
    expect(callbacks).toHaveProperty("buyNowFromCallback");
  });
});
