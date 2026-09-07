import { describe, expect, it } from "vitest";
import {
  FEATURE_001_SELLABLE_STOCK_POLICIES,
  isFeature001SellablePolicy,
  isSupportedCatalogRoute,
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

  it("allowlists policies supported by checkout while keeping supplier-only typed-route gated", () => {
    expect(FEATURE_001_SELLABLE_STOCK_POLICIES).toEqual([
      "LOCAL_ONLY",
      "SUPPLIER_ONLY",
      "LOCAL_THEN_SUPPLIER",
    ]);
    for (const policy of allPolicies) {
      expect(isFeature001SellablePolicy(policy)).toBe(policy !== "PAUSED");
    }
    expect(
      isSupportedCatalogRoute({ stockPolicy: "SUPPLIER_ONLY", fulfillmentType: "SUPPLIER_API" }),
    ).toBe(true);
    expect(
      isSupportedCatalogRoute({ stockPolicy: "SUPPLIER_ONLY", fulfillmentType: "STOCK_ACCOUNT" }),
    ).toBe(false);
  });

  it.each([null, undefined, "", "UNKNOWN", 0, {}, []])(
    "fails closed for unknown policy value %j",
    (policy) => {
      expect(isFeature001SellablePolicy(policy)).toBe(false);
      expect(requiresLocalReservation(policy)).toBe(false);
    },
  );

  it("fails closed for unsupported fulfillment routes", () => {
    for (const fulfillmentType of [null, undefined, "", "UNKNOWN", 0, {}, []]) {
      expect(isSupportedCatalogRoute({ stockPolicy: "LOCAL_ONLY", fulfillmentType })).toBe(false);
      expect(isSupportedCatalogRoute({ stockPolicy: "LOCAL_THEN_SUPPLIER", fulfillmentType })).toBe(
        false,
      );
      expect(isSupportedCatalogRoute({ stockPolicy: "SUPPLIER_ONLY", fulfillmentType })).toBe(
        false,
      );
    }
  });

  it("keeps checkout sellability distinct from the local reservation decision", () => {
    for (const policy of allPolicies) {
      expect(requiresLocalReservation(policy)).toBe(
        policy === "LOCAL_ONLY" || policy === "LOCAL_THEN_SUPPLIER",
      );
    }
  });
});
