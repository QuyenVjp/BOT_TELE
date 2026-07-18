import { describe, expect, it } from "vitest";
import {
  FEATURE_001_SELLABLE_STOCK_POLICIES,
  isFeature001SellablePolicy,
  requiresLocalReservation,
  type StockPolicy,
} from "../../src/modules/catalog/domain.js";

describe("Feature 001 stock-policy contract", () => {
  const allPolicies: StockPolicy[] = [
    "LOCAL_ONLY",
    "SUPPLIER_ONLY",
    "LOCAL_THEN_SUPPLIER",
    "PAUSED",
  ];

  it("allowlists only policies supported by the Feature 001 checkout", () => {
    expect(FEATURE_001_SELLABLE_STOCK_POLICIES).toEqual(["LOCAL_ONLY", "LOCAL_THEN_SUPPLIER"]);
    for (const policy of allPolicies) {
      expect(isFeature001SellablePolicy(policy)).toBe(
        policy === "LOCAL_ONLY" || policy === "LOCAL_THEN_SUPPLIER",
      );
    }
  });

  it.each([null, undefined, "", "UNKNOWN", 0, {}, []])(
    "fails closed for unknown policy value %j",
    (policy) => {
      expect(isFeature001SellablePolicy(policy)).toBe(false);
      expect(requiresLocalReservation(policy)).toBe(false);
    },
  );

  it("keeps checkout sellability distinct from the local reservation decision", () => {
    for (const policy of allPolicies) {
      expect(requiresLocalReservation(policy)).toBe(
        policy === "LOCAL_ONLY" || policy === "LOCAL_THEN_SUPPLIER",
      );
    }
  });
});
