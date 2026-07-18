import { ulid } from "ulid";

/**
 * Opaque, brand-checked identifiers (data-model.md Conventions).
 *
 * - Primary identifiers are opaque ULID values (Crockford base32, 26 chars,
 *   lexicographically sortable, collision-resistant).
 * - Branded types prevent accidentally passing an OrderId where a ProductId is
 *   expected, without any runtime cost beyond validation at the boundary.
 * - `isId` / `brandId` guard external input so a malformed string can never be
 *   smuggled in as a trusted identifier (no path traversal, no empties).
 */

declare const brand: unique symbol;

/** Base branded id type. Each aggregate declares its own nominal alias. */
export type Id<TBrand extends string> = string & { readonly [brand]: TBrand };

export type OrderId = Id<"Order">;
export type ProductId = Id<"Product">;
export type ProductVariantId = Id<"ProductVariant">;
export type CategoryId = Id<"Category">;
export type CustomerId = Id<"Customer">;
export type PaymentIntentId = Id<"PaymentIntent">;
export type BankTransactionId = Id<"BankTransaction">;
export type DeliveryBundleId = Id<"DeliveryBundle">;
export type DigitalAssetId = Id<"DigitalAsset">;
export type SupplierId = Id<"Supplier">;
export type SupplierOrderId = Id<"SupplierOrder">;
export type SupportTicketId = Id<"SupportTicket">;
export type OutboxId = Id<"Outbox">;
export type InboxId = Id<"Inbox">;
export type AuditId = Id<"Audit">;

/** ULID: 26 chars from Crockford's base32 alphabet (excludes I, L, O, U). */
const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/** True when a value is a well-formed opaque identifier string. */
export function isId(value: unknown): value is string {
  return typeof value === "string" && ULID_RE.test(value);
}

/** Generate a fresh opaque identifier, branded to the caller's aggregate type. */
export function newId<T extends Id<string>>(): T {
  return ulid() as T;
}

/**
 * Validate and brand an externally-supplied identifier string.
 * Throws when the value is not a well-formed opaque id, so untrusted input
 * (query params, webhook payloads) can never masquerade as a trusted id.
 */
export function brandId<T extends Id<string>>(value: string): T {
  if (!isId(value)) {
    throw new Error("Invalid identifier");
  }
  return value as T;
}
