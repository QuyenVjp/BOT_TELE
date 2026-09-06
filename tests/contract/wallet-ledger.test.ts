import { describe, expect, it } from "vitest";
import { planWalletMutation } from "../../src/modules/wallet/ledger.js";

describe("planWalletMutation", () => {
  it("adds credit amounts and rejects invalid inputs", () => {
    expect(planWalletMutation(10n, 5n, "CREDIT")).toEqual({ ok: true, nextBalanceVnd: 15n });
    expect(planWalletMutation(10n, 0n, "CREDIT")).toEqual({
      ok: false,
      code: "INVALID_AMOUNT",
      message: "Số tiền ví phải là số nguyên dương.",
    });
  });

  it("rejects debits that would go negative", () => {
    expect(planWalletMutation(10n, 11n, "DEBIT")).toEqual({
      ok: false,
      code: "INSUFFICIENT_FUNDS",
      message: "Không đủ số dư ví để thực hiện giao dịch.",
    });
  });
});
