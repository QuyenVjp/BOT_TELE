import { describe, expect, it } from "vitest";
import { decideTopupMatch, type WalletTopupIntent } from "../../src/modules/wallet/topup.js";

const intent = (over: Partial<WalletTopupIntent> = {}): WalletTopupIntent => ({
  id: "topup-1",
  customerId: "customer-1",
  walletAccountId: "wallet-1",
  amountVnd: 100_000n,
  merchantAccountId: "merchant-1",
  transferContent: "NAPVI123",
  status: "PRESENTED",
  expiresAt: new Date("2026-09-06T10:00:00Z"),
  version: 1,
  ...over,
});

const evidence = (over = {}) => ({
  direction: "IN" as const,
  merchantAccountId: "merchant-1",
  amountVnd: 100_000,
  transactedAt: new Date("2026-09-06T09:59:00Z"),
  ...over,
});

describe("decideTopupMatch", () => {
  it("settles exact inbound SePay evidence for a live topup intent", () => {
    expect(decideTopupMatch(evidence(), intent())).toEqual({ kind: "SETTLE" });
  });

  it("fails closed on account, amount, expired, and non-live mismatches", () => {
    expect(decideTopupMatch(evidence({ merchantAccountId: "other" }), intent())).toEqual({ kind: "DISCREPANCY", reason: "WRONG_ACCOUNT" });
    expect(decideTopupMatch(evidence({ amountVnd: 99_999 }), intent())).toEqual({ kind: "DISCREPANCY", reason: "UNDERPAYMENT" });
    expect(decideTopupMatch(evidence({ transactedAt: new Date("2026-09-06T10:02:00Z") }), intent())).toEqual({ kind: "DISCREPANCY", reason: "LATE_PAYMENT" });
    expect(decideTopupMatch(evidence(), intent({ status: "SUCCEEDED" }))).toEqual({ kind: "DISCREPANCY", reason: "NOT_LIVE" });
  });
});
