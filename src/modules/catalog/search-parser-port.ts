import { z } from "zod";
import { foldText } from "./search.js";

/**
 * Search-parser port + allowlisted filter schema (FR-004 / FR-005, telegram-ux.md).
 *
 * Allowed output fields only:
 *   query, categoryId, duration, minPriceVnd, maxPriceVnd,
 *   stockStatus=AVAILABLE, deliveryType, sort.
 *
 * Unknown fields, invalid enums, negative/out-of-range prices, and oversized
 * strings are rejected. The free-text `query` is fold-normalized and hard-capped
 * so it can never be rendered as a product fact.
 */

const MAX_QUERY_LENGTH = 256;
const MAX_PRICE_VND = 100_000_000; // 100 triệu — hard ceiling for the MVP catalog.

const DeliveryTypeEnum = z.enum([
  "INVITE",
  "LICENSE",
  "ACTIVATION_KEY",
  "CREDENTIAL",
  "MANUAL_REVIEW",
]);

const SortEnum = z.enum(["price_asc", "price_desc", "name_asc", "relevance"]);

export const SearchFilterSchema = z
  .object({
    query: z
      .string()
      .max(MAX_QUERY_LENGTH)
      .transform((v) => foldText(v))
      .optional(),
    categoryId: z.string().min(1).max(40).optional(),
    duration: z.string().min(1).max(16).optional(),
    minPriceVnd: z.number().int().nonnegative().max(MAX_PRICE_VND).optional(),
    maxPriceVnd: z.number().int().nonnegative().max(MAX_PRICE_VND).optional(),
    // Only AVAILABLE is legal — the parser cannot invent other stock states.
    stockStatus: z.literal("AVAILABLE").optional(),
    deliveryType: DeliveryTypeEnum.optional(),
    sort: SortEnum.optional(),
  })
  .strict();

export type SearchFilter = z.infer<typeof SearchFilterSchema>;

/**
 * Validate + strip a raw model payload into the allowlisted filter set.
 * Unknown keys are stripped (not fatal) so a chatty model still produces a
 * usable filter; invalid *known* keys throw.
 */
export function parseModelFilterOutput(raw: unknown): SearchFilter {
  if (raw === null || typeof raw !== "object") {
    return {};
  }
  // Strip unknown keys first so `.strict()` only rejects bad values on known keys.
  const allowlisted: Record<string, unknown> = {};
  const source = raw as Record<string, unknown>;
  for (const key of [
    "query",
    "categoryId",
    "duration",
    "minPriceVnd",
    "maxPriceVnd",
    "stockStatus",
    "deliveryType",
    "sort",
  ] as const) {
    if (key in source) allowlisted[key] = source[key];
  }
  // Cap an oversized query before schema validation so the bound is enforced
  // even if the model returns a multi-kilobyte dump.
  if (typeof allowlisted.query === "string" && allowlisted.query.length > MAX_QUERY_LENGTH) {
    allowlisted.query = allowlisted.query.slice(0, MAX_QUERY_LENGTH);
  }
  return SearchFilterSchema.parse(allowlisted);
}

/** Port the bot/search layer talks to — deterministic or model-backed. */
export interface SearchParser {
  parse(rawUserText: string): Promise<SearchFilter>;
}
