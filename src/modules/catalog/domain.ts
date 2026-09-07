import type { CategoryId, ProductId, ProductVariantId } from "../../shared/ids/index.js";
import { FulfillmentTypeSchema, type FulfillmentType } from "./fulfillment-type.js";
/**
 * Catalog domain types + sellability rules (data-model.md Catalog).
 *
 * The visibility invariant is the single authority for whether a variant may
 * be shown or bought: product + category + variant active, price positive,
 * resale evidence present (SR-007), and a stock-policy/fulfillment-type route
 * the checkout can validate. Repository queries and Buy Now both defer here so
 * there is one rule, not two drifting copies.
 */

export type DeliveryType = "INVITE" | "LICENSE" | "ACTIVATION_KEY" | "CREDENTIAL" | "MANUAL_REVIEW";

export type StockPolicy = "LOCAL_ONLY" | "SUPPLIER_ONLY" | "LOCAL_THEN_SUPPLIER" | "PAUSED";

export type CatalogFulfillmentType = FulfillmentType;

export const FEATURE_001_SELLABLE_STOCK_POLICIES = [
  "LOCAL_ONLY",
  "SUPPLIER_ONLY",
  "LOCAL_THEN_SUPPLIER",
] as const satisfies readonly StockPolicy[];

const FEATURE_001_SELLABLE_STOCK_POLICY_SET: ReadonlySet<unknown> = new Set(
  FEATURE_001_SELLABLE_STOCK_POLICIES,
);

export type Feature001SellableStockPolicy = (typeof FEATURE_001_SELLABLE_STOCK_POLICIES)[number];

/** Feature 001 fails closed until a policy/fulfillment route is supported. */
export function isFeature001SellablePolicy(
  policy: unknown,
): policy is Feature001SellableStockPolicy {
  return FEATURE_001_SELLABLE_STOCK_POLICY_SET.has(policy);
}

export function isSupportedCatalogRoute(input: {
  stockPolicy: unknown;
  fulfillmentType: unknown;
}): input is {
  stockPolicy: Feature001SellableStockPolicy;
  fulfillmentType: CatalogFulfillmentType;
} {
  if (!isFeature001SellablePolicy(input.stockPolicy)) return false;
  if (!FulfillmentTypeSchema.safeParse(input.fulfillmentType).success) return false;
  if (input.stockPolicy === "SUPPLIER_ONLY") return input.fulfillmentType === "SUPPLIER_API";
  return input.fulfillmentType !== "SUPPLIER_API";
}

/** Local policies need a pre-payment readiness/reservation check. */
export function requiresLocalReservation(
  policy: unknown,
): policy is "LOCAL_ONLY" | "LOCAL_THEN_SUPPLIER" {
  return policy === "LOCAL_ONLY" || policy === "LOCAL_THEN_SUPPLIER";
}

export interface Category {
  id: CategoryId;
  nameVi: string;
  slug: string;
  isActive: boolean;
  sortOrder: number;
}

export interface Product {
  id: ProductId;
  categoryId: CategoryId;
  nameVi: string;
  slug: string;
  shortDescriptionVi: string | null;
  isActive: boolean;
  sortOrder: number;
}

export interface ProductVariant {
  id: ProductVariantId;
  productId: ProductId;
  sku: string;
  nameVi: string;
  priceVnd: bigint;
  durationCode: string | null;
  deliveryType: DeliveryType;
  warrantyDays: number;
  stockPolicy: StockPolicy;
  resaleEvidenceId: string | null;
  isActive: boolean;
  sortOrder: number;
}

/** Inputs to the sellability decision, independent of persistence shape. */
export interface SellabilityContext {
  categoryActive: boolean;
  productActive: boolean;
  variantActive: boolean;
  priceVnd: bigint;
  resaleEvidenceId: string | null;
  stockPolicy: StockPolicy;
  fulfillmentType: CatalogFulfillmentType;
}

/**
 * A variant is visible/payable only when every catalog gate holds. PAUSED,
 * unsupported supplier legacy combinations, and absent resale evidence fail
 * closed (SR-007 — no unauthorized resale).
 */
export function isVariantSellable(ctx: SellabilityContext): boolean {
  return (
    ctx.categoryActive &&
    ctx.productActive &&
    ctx.variantActive &&
    ctx.priceVnd > 0n &&
    ctx.resaleEvidenceId !== null &&
    ctx.resaleEvidenceId.length > 0 &&
    isSupportedCatalogRoute({ stockPolicy: ctx.stockPolicy, fulfillmentType: ctx.fulfillmentType })
  );
}
