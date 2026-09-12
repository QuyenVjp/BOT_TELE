import { describe, expect, it } from "vitest";
import {
  buildReconciliationPlan,
  summarizeWallets,
  type ReconcileInput,
  type WalletSnapshot,
} from "../../scripts/wallet-reconciliation.js";

function makeSnapshot(overrides: Partial<WalletSnapshot> = {}): WalletSnapshot {
  return {
    id: "wallet-fixture",
    balanceVnd: 82_000n,
    ledgerVnd: 32_000n,
    version: 13,
    entries: 12,
    chainBreaks: 1,
    migrationHead: "062_inbox_last_error_detail.sql",
    doubleEntryReady: false,
    ...overrides,
  };
}

function makeApplyInput(overrides: Partial<ReconcileInput> = {}): ReconcileInput {
  return {
    mode: "APPLY",
    walletId: "wallet-fixture",
    strategy: "CACHE_REPAIR",
    amountVnd: 50_000n,
    expectedCacheVnd: 82_000n,
    expectedLedgerVnd: 32_000n,
    expectedVersion: 13,
    expectedChainBreaks: 1,
    actorId: "root-fixture",
    reason: "reconcile cache against reviewed accounting evidence",
    correlationId: "wallet-reconciliation-fixture",
    idempotencyKey: "reconciliation:fixture",
    confirmation: "APPLY ACCOUNTING RECONCILIATION",
    json: false,
    ...overrides,
  };
}

describe("wallet reconciliation plan", () => {
  it("repairs only the cache and preserves the historical ledger total", () => {
    expect(buildReconciliationPlan(makeSnapshot(), makeApplyInput())).toMatchObject({
      action: "CACHE_REPAIR",
      amountVnd: 50_000n,
      beforeCacheVnd: 82_000n,
      beforeLedgerVnd: 32_000n,
      afterCacheVnd: 32_000n,
      afterLedgerVnd: 32_000n,
    });
  });

  it("reports a balanced wallet as clean", () => {
    expect(
      summarizeWallets([makeSnapshot({ balanceVnd: 32_000n, ledgerVnd: 32_000n, chainBreaks: 0 })]),
    ).toEqual({
      walletCount: 1,
      mismatchWalletCount: 0,
      mismatchLedgerEntryCount: 0,
      chainBreakWalletCount: 0,
      chainBreakCount: 0,
    });
  });

  it("reports an overstated cache without inventing a ledger credit", () => {
    const result = summarizeWallets([makeSnapshot()]);
    expect(result.mismatchWalletCount).toBe(1);
    expect(result.mismatchLedgerEntryCount).toBe(12);
  });

  it("flags a ledger missing a credit", () => {
    const result = summarizeWallets([
      makeSnapshot({ balanceVnd: 0n, ledgerVnd: -50_000n, entries: 1, chainBreaks: 1 }),
    ]);
    expect(result).toMatchObject({
      mismatchWalletCount: 1,
      mismatchLedgerEntryCount: 1,
      chainBreakWalletCount: 1,
    });
    expect(() =>
      buildReconciliationPlan(
        makeSnapshot({ balanceVnd: 0n, ledgerVnd: -50_000n, entries: 1, chainBreaks: 1 }),
        makeApplyInput({ amountVnd: 50_000n, expectedCacheVnd: 0n, expectedLedgerVnd: -50_000n }),
      ),
    ).toThrow("historical wallet ledger is negative");
  });

  it("flags chain breaks and duplicate-credit-shaped histories", () => {
    const result = summarizeWallets([
      makeSnapshot({ balanceVnd: 100_000n, ledgerVnd: 100_000n, entries: 2, chainBreaks: 1 }),
    ]);
    expect(result).toMatchObject({
      mismatchWalletCount: 0,
      chainBreakWalletCount: 1,
      chainBreakCount: 1,
    });
  });

  it("rejects stale expected state and wrong correction amount", () => {
    expect(() =>
      buildReconciliationPlan(makeSnapshot(), makeApplyInput({ expectedVersion: 12 })),
    ).toThrow("wallet version changed");
    expect(() =>
      buildReconciliationPlan(makeSnapshot(), makeApplyInput({ amountVnd: 49_000n })),
    ).toThrow("cache-minus-ledger difference");
  });

  it("rejects an already reconciled wallet instead of applying zero", () => {
    const clean = makeSnapshot({ balanceVnd: 32_000n, ledgerVnd: 32_000n, chainBreaks: 0 });
    expect(summarizeWallets([clean]).mismatchWalletCount).toBe(0);
    expect(() =>
      buildReconciliationPlan(
        clean,
        makeApplyInput({
          amountVnd: 0n,
          expectedCacheVnd: 32_000n,
          expectedLedgerVnd: 32_000n,
          expectedChainBreaks: 0,
        }),
      ),
    ).toThrow("amount must be positive");
  });

  it("counts one mismatched wallet separately from its twelve legacy rows", () => {
    const result = summarizeWallets([
      makeSnapshot({ entries: 12 }),
      makeSnapshot({
        id: "wallet-clean",
        balanceVnd: 0n,
        ledgerVnd: 0n,
        entries: 0,
        chainBreaks: 0,
      }),
    ]);
    expect(result).toEqual({
      walletCount: 2,
      mismatchWalletCount: 1,
      mismatchLedgerEntryCount: 12,
      chainBreakWalletCount: 1,
      chainBreakCount: 1,
    });
  });

  it("requires an explicit strategy and typed confirmation", () => {
    expect(() =>
      buildReconciliationPlan(makeSnapshot(), makeApplyInput({ strategy: null })),
    ).toThrow("no correction is chosen automatically");
    expect(() =>
      buildReconciliationPlan(makeSnapshot(), makeApplyInput({ confirmation: "yes" })),
    ).toThrow("APPLY ACCOUNTING RECONCILIATION");
  });
});
