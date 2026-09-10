import { sql } from "kysely";
import type { Executor } from "../../infrastructure/db/transaction.js";
import type { CatalogVariantRow, Page } from "./repository.js";
import type { DeliveryType } from "./domain.js";
import { catalogVisibilitySql, type CatalogAudience } from "./visibility.js";

/**
 * Deterministic catalog search (FR-004).
 *
 * Matching is done on a fold-normalized form so accented/unaccented and
 * mixed-case queries collapse together. The fold is computed identically in JS
 * (for the query) and SQL (for stored names/aliases) via a shared translate
 * map, so "Giải trí" and "giai tri" match the same rows. Filters only ever
 * NARROW the authoritative sellable set — search never invents a product.
 */

export interface CatalogFilter {
  query?: string | undefined;
  categoryId?: string | undefined;
  minPriceVnd?: number | undefined;
  maxPriceVnd?: number | undefined;
  deliveryType?: DeliveryType | undefined;
}

export interface SearchOptions {
  limit: number;
  cursor?: string | null;
  audience?: CatalogAudience | undefined;
}

export const SEARCH_MAX_QUERY = 256;
const SEARCH_MAX_TOKENS = 8;

// Accented Vietnamese characters grouped by their folded (accent-stripped) base.
// FOLD_TO is derived from these groups so the two strings are guaranteed to stay
// index-aligned — SQL translate() and the JS fold map both consume the pair.
const FOLD_GROUPS: Array<[base: string, accented: string]> = [
  ["a", "àáảãạăằắẳẵặâầấẩẫậ"],
  ["d", "đ"],
  ["e", "èéẻẽẹêềếểễệ"],
  ["i", "ìíỉĩị"],
  ["o", "òóỏõọôồốổỗộơờớởỡợ"],
  ["u", "ùúủũụưừứửữự"],
  ["y", "ỳýỷỹỵ"],
];

const FOLD_FROM = FOLD_GROUPS.map(([, accented]) => accented).join("");
const FOLD_TO = FOLD_GROUPS.map(([base, accented]) => base.repeat([...accented].length)).join("");

function buildFoldMap(): Map<string, string> {
  const map = new Map<string, string>();
  for (const [base, accented] of FOLD_GROUPS) {
    for (const ch of accented) map.set(ch, base);
  }
  return map;
}

const FOLD_MAP = buildFoldMap();

/**
 * Fold a string to its accent-stripped lowercase form (JS side), collapsing
 * internal whitespace and trimming. Seed/stored names use single spaces, so the
 * SQL side (translate over single-spaced values) stays consistent with this.
 */
export function foldText(input: string): string {
  const lower = input.normalize("NFC").toLowerCase();
  let out = "";
  for (const ch of lower) {
    out += FOLD_MAP.get(ch) ?? ch;
  }
  return out.replace(/\s+/g, " ").trim();
}

function toPrefixTsQuery(input: string): string | null {
  const tokens = input.match(/[\p{L}\p{N}]+/gu)?.slice(0, SEARCH_MAX_TOKENS) ?? [];
  return tokens.length > 0 ? tokens.map((token) => `${token}:*`).join(" & ") : null;
}

interface Cursor {
  sortOrder: number;
  id: string;
}

function encodeCursor(c: Cursor): string {
  return Buffer.from(`${c.sortOrder}:${c.id}`, "utf8").toString("base64url");
}

function decodeCursor(raw: string): Cursor | null {
  try {
    const decoded = Buffer.from(raw, "base64url").toString("utf8");
    const idx = decoded.indexOf(":");
    if (idx < 0) return null;
    const sortOrder = Number(decoded.slice(0, idx));
    const id = decoded.slice(idx + 1);
    if (!Number.isFinite(sortOrder) || id.length === 0) return null;
    return { sortOrder, id };
  } catch {
    return null;
  }
}

/**
 * Search sellable variants with bounded, allowlisted filters. Text search folds
 * the query and matches (folded) product name, category name, parent (brand
 * family) name, tags, or any product alias. Every other filter only narrows the sellable set. Keyset-paginated on
 * (sort_order, id) for a stable, gap-free cursor.
 */
export async function searchCatalog(
  exec: Executor,
  filter: CatalogFilter,
  options: SearchOptions,
): Promise<Page<CatalogVariantRow>> {
  const cursor = options.cursor ? decodeCursor(options.cursor) : null;
  const fetchLimit = options.limit + 1;

  const foldedQuery = filter.query
    ? foldText(filter.query).slice(0, SEARCH_MAX_QUERY).trim()
    : null;
  const prefixTsQuery = foldedQuery ? toPrefixTsQuery(foldedQuery) : null;

  // Word-prefix text match avoids leading-wildcard scans while preserving
  // accent-folded discovery across product, category, and alias terms.
  const textFilter = prefixTsQuery
    ? sql`and (
          to_tsvector('simple', translate(lower(p.name_vi), ${FOLD_FROM}, ${FOLD_TO}))
            @@ to_tsquery('simple', ${prefixTsQuery})
          or to_tsvector('simple', translate(lower(c.name_vi), ${FOLD_FROM}, ${FOLD_TO}))
            @@ to_tsquery('simple', ${prefixTsQuery})
          or to_tsvector('simple', translate(lower(coalesce(parent.name_vi, '')), ${FOLD_FROM}, ${FOLD_TO}))
            @@ to_tsquery('simple', ${prefixTsQuery})
          or exists (
            select 1 from product_alias a
            where a.product_id = p.id
              and to_tsvector(
                    'simple',
                    translate(lower(a.normalized_alias), ${FOLD_FROM}, ${FOLD_TO})
                  ) @@ to_tsquery('simple', ${prefixTsQuery})
          )
          or exists (
            select 1 from unnest(coalesce(p.tags, '{}'::text[])) as tag
            where to_tsvector('simple', translate(lower(tag), ${FOLD_FROM}, ${FOLD_TO}))
              @@ to_tsquery('simple', ${prefixTsQuery})
          )
        )`
    : sql``;

  const categoryFilter = filter.categoryId ? sql`and c.id = ${filter.categoryId}` : sql``;
  const minPriceFilter =
    filter.minPriceVnd !== undefined ? sql`and v.price_vnd >= ${filter.minPriceVnd}` : sql``;
  const maxPriceFilter =
    filter.maxPriceVnd !== undefined ? sql`and v.price_vnd <= ${filter.maxPriceVnd}` : sql``;
  const deliveryFilter = filter.deliveryType
    ? sql`and v.delivery_type = ${filter.deliveryType}`
    : sql``;
  const cursorFilter = cursor
    ? sql`and (v.sort_order, v.id) > (${cursor.sortOrder}, ${cursor.id})`
    : sql``;

  const result = await sql<CatalogVariantRow>`
    select
      v.id, v.product_id, p.name_vi as product_name_vi, v.sku, v.name_vi,
      v.price_vnd, v.duration_code, v.delivery_type, v.warranty_days,
      v.stock_policy, v.sort_order, v.fulfillment_type,
      q.available_quantity::int as available_quantity,
      case
        when v.fulfillment_type in ('STOCK_ACCOUNT','STOCK_CODE') then exists (
          select 1 from digital_asset a where a.variant_id = v.id and a.status = 'AVAILABLE'
        )
        when v.fulfillment_type = 'QUANTITY_STOCK' then coalesce(q.available_quantity, 0) > 0
        when v.fulfillment_type = 'DIGITAL_FILE' then exists (
          select 1 from variant_file_artifact f where f.variant_id = v.id and f.is_active
        )
        when v.fulfillment_type = 'SUPPLIER_API' then exists (
          select 1 from supplier_sku ss join supplier s on s.id = ss.supplier_id
          where ss.variant_id = v.id and ss.is_active and s.status = 'ACTIVE'
        )
        when v.fulfillment_type in ('MANUAL_FULFILLMENT','UNLIMITED_SERVICE') then exists (
          select 1 from variant_service_fulfillment sf
          where sf.variant_id = v.id and sf.fulfillment_type = v.fulfillment_type and sf.is_active
        )
        else false
      end as is_ready
    from product_variant v
    join product p on p.id = v.product_id
    join category c on c.id = p.category_id
    left join category parent on parent.id = c.parent_id
    left join variant_quantity_stock q on q.variant_id = v.id
    where c.is_active
      and p.is_active
      and v.is_active
      and v.price_vnd > 0
      ${catalogVisibilitySql(options.audience ?? "public")}
      and (
        (v.stock_policy in ('LOCAL_ONLY','LOCAL_THEN_SUPPLIER') and v.fulfillment_type <> 'SUPPLIER_API')
        or (v.stock_policy = 'SUPPLIER_ONLY' and v.fulfillment_type = 'SUPPLIER_API' and exists (
          select 1 from supplier_sku ss join supplier s on s.id = ss.supplier_id
          where ss.variant_id = v.id and ss.is_active and s.status = 'ACTIVE'
        ))
      )
      ${textFilter}
      ${categoryFilter}
      ${minPriceFilter}
      ${maxPriceFilter}
      ${deliveryFilter}
      ${cursorFilter}
    order by v.sort_order asc, v.id asc
    limit ${fetchLimit}
  `.execute(exec);

  const rows = result.rows;
  const hasMore = rows.length > options.limit;
  const items = hasMore ? rows.slice(0, options.limit) : rows;
  const last = items[items.length - 1];
  const nextCursor =
    hasMore && last ? encodeCursor({ sortOrder: last.sort_order, id: last.id }) : null;

  return { items, nextCursor };
}
