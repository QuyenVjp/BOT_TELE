import type { CategoryId, ProductId, ProductVariantId } from "../../shared/ids/index.js";

/**
 * Catalog domain types + sellability rules (data-model.md Catalog).
 *
 * The sellability invariant is the single authority for whether a variant may
 * be shown or bought: product + category + variant active, price positive,
 * resale evidence present (SR-007), and a Feature 001 allowlisted stock policy. Repository
 * queries and Buy Now both defer to `isVariantSellable` so there is one rule,
 * not two drifting copies.
 */

export type DeliveryType = "INVITE" | "LICENSE" | "ACTIVATION_KEY" | "CREDENTIAL" | "MANUAL_REVIEW";

export type StockPolicy = "LOCAL_ONLY" | "SUPPLIER_ONLY" | "LOCAL_THEN_SUPPLIER" | "PAUSED";

export const FEATURE_001_SELLABLE_STOCK_POLICIES = [
  "LOCAL_ONLY",
  "LOCAL_THEN_SUPPLIER",
] as const satisfies readonly StockPolicy[];

const FEATURE_001_SELLABLE_STOCK_POLICY_SET: ReadonlySet<unknown> = new Set(
  FEATURE_001_SELLABLE_STOCK_POLICIES,
);

export type Feature001SellableStockPolicy = (typeof FEATURE_001_SELLABLE_STOCK_POLICIES)[number];

/** Feature 001 fails closed until a policy has a safe pre-payment capacity hold. */
export function isFeature001SellablePolicy(
  policy: unknown,
): policy is Feature001SellableStockPolicy {
  return FEATURE_001_SELLABLE_STOCK_POLICY_SET.has(policy);
}

/**
 * Reservation semantics stay a named decision boundary even though every
 * Feature 001 sellable policy currently draws on finite local stock.
 */
export function requiresLocalReservation(policy: unknown): policy is Feature001SellableStockPolicy {
  return isFeature001SellablePolicy(policy);
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
}

/**
 * The single sellability rule. A variant is sellable only when every gate holds.
 * Unknown, PAUSED, and SUPPLIER_ONLY policies fail closed; an absent resale
 * evidence id blocks selling (SR-007 — no unauthorized resale).
 */
export function isVariantSellable(ctx: SellabilityContext): boolean {
  return (
    ctx.categoryActive &&
    ctx.productActive &&
    ctx.variantActive &&
    ctx.priceVnd > 0n &&
    ctx.resaleEvidenceId !== null &&
    ctx.resaleEvidenceId.length > 0 &&
    isFeature001SellablePolicy(ctx.stockPolicy)
  );
}
