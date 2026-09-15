import { sql } from "kysely";
import type { Executor } from "../../infrastructure/db/transaction.js";
import type { DeliveryType, StockPolicy } from "./domain.js";
import type { FulfillmentType } from "./fulfillment-type.js";
import { newId } from "../../shared/ids/index.js";
import { catalogVisibilitySql, currentPublicationSql, type CatalogAudience } from "./visibility.js";
import { ensureTaxonomy, isFulfillmentTaxonomyNode } from "./taxonomy.js";

/**
 * Catalog persistence + cursor queries (FR-002).
 *
 * The sellability invariant lives in SQL here for set-based efficiency, but it
 * mirrors `isVariantSellable` exactly: category + product + variant active,
 * price > 0, resale evidence present (SR-007), and a Feature 001 allowlisted policy.
 *
 * Pagination is keyset on `(sort_order, id)` — a stable, gap-free cursor that is
 * robust to inserts between page reads (unlike OFFSET). The cursor is an opaque
 * base64 of the last row's sort key.
 */

export interface CatalogCategoryRow {
  id: string;
  name_vi: string;
  slug: string;
  sort_order: number;
  parent_id?: string | null;
  icon?: string | null;
}

export interface CatalogVariantRow {
  id: string;
  product_id: string;
  product_name_vi: string;
  sku: string;
  name_vi: string;
  price_vnd: string; // bigint as string (exact); wrapped to Vnd at the domain edge
  duration_code: string | null;
  delivery_type: DeliveryType;
  warranty_days: number;
  stock_policy: StockPolicy;
  sort_order: number;
  fulfillment_type: FulfillmentType;
  available_quantity: number | null;
  is_ready: boolean;
  description_vi?: string | null;
  what_customer_receives_vi?: string | null;
  usage_instructions_vi?: string | null;
  delivery_eta_vi?: string | null;
  warranty_vi?: string | null;
  support_vi?: string | null;
  compare_at_price_vnd?: string | null;
  stock_display_mode?: "BAND" | "EXACT" | null;
  category_id?: string;
  preorder_enabled?: boolean;
  warranty_enabled?: boolean;
  /** Raw presentation-only override; validated by the zod schema at the app edge. */
  presentation_profile?: unknown;
}

export interface PageOptions {
  limit: number;
  cursor?: string | null;
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export const VARIANT_READY_SQL = sql`
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
  end
`;

export const SELLABLE_ROUTE_SQL = sql`
  (
    (v.stock_policy in ('LOCAL_ONLY','LOCAL_THEN_SUPPLIER') and v.fulfillment_type <> 'SUPPLIER_API')
    or (v.stock_policy = 'SUPPLIER_ONLY' and v.fulfillment_type = 'SUPPLIER_API' and exists (
      select 1 from supplier_sku ss join supplier s on s.id = ss.supplier_id
      where ss.variant_id = v.id and ss.is_active and s.status = 'ACTIVE'
    ))
  )
`;

/** List active categories in stable (sort_order, id) order. */
export async function listActiveCategories(exec: Executor): Promise<CatalogCategoryRow[]> {
  const result = await sql<CatalogCategoryRow>`
    select id, name_vi, slug, sort_order, parent_id, icon
    from category
    where is_active
    order by sort_order asc, id asc
  `.execute(exec);
  return result.rows;
}

/** Admin picker: every active category, including those without products. */
export const listAdminCategories = listActiveCategories;

export interface CategoryWithCountsRow {
  id: string;
  name_vi: string;
  is_active: boolean;
  sort_order: number;
  product_count: number;
  parent_id?: string | null;
}

export async function listCategoriesWithCounts(exec: Executor): Promise<CategoryWithCountsRow[]> {
  const result = await sql<CategoryWithCountsRow>`
    select c.id, c.name_vi, c.is_active, c.sort_order, c.parent_id,
           (
             select count(distinct p.id)::int
             from product p
             join category leaf on leaf.id = p.category_id
             where (leaf.id = c.id or leaf.parent_id = c.id)
               and p.is_archived = false
           ) as product_count
    from category c
    order by c.sort_order asc, c.id asc
  `.execute(exec);
  return result.rows;
}

function categorySlug(nameVi: string): string {
  const slug = nameVi
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/đ/g, "d")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "khac";
}

export async function createCategory(
  exec: Executor,
  input: { nameVi: string; parentId?: string | null; icon?: string | null },
): Promise<CategoryWithCountsRow> {
  const nameVi = input.nameVi.trim();
  if (!nameVi) throw new Error("CATEGORY_NAME_REQUIRED");
  if (input.parentId) await assertValidParent(exec, null, input.parentId);
  const id = newId();
  const result = await sql<CategoryWithCountsRow>`
    insert into category (id, name_vi, slug, is_active, sort_order, parent_id, icon, display_name_vi)
    values (${id}, ${nameVi}, ${categorySlug(nameVi)}, true,
      (select coalesce(max(sort_order), 0) + 1 from category
       where parent_id is not distinct from ${input.parentId ?? null}),
      ${input.parentId ?? null}, ${input.icon ?? null}, ${nameVi})
    returning id, name_vi, is_active, sort_order, parent_id, 0::int as product_count
  `.execute(exec);
  return result.rows[0]!;
}

export async function renameCategory(exec: Executor, id: string, nameVi: string): Promise<void> {
  const name = nameVi.trim();
  if (!name) throw new Error("CATEGORY_NAME_REQUIRED");
  await sql`update category set name_vi = ${name}, display_name_vi = ${name}, slug = ${categorySlug(name)}, updated_at = now(), version = version + 1 where id = ${id}`.execute(
    exec,
  );
}

export async function setCategoryActive(
  exec: Executor,
  id: string,
  active: boolean,
): Promise<void> {
  await sql`update category set is_active = ${active}, updated_at = now(), version = version + 1 where id = ${id}`.execute(
    exec,
  );
}

export async function reorderCategory(
  exec: Executor,
  id: string,
  direction: "up" | "down",
): Promise<void> {
  const delta = direction === "up" ? -1 : 1;
  await sql`
    with current as (select sort_order, parent_id from category where id = ${id}), adjacent as (
      select c.id, c.sort_order from category c, current
      where c.id <> ${id}
        and c.parent_id is not distinct from current.parent_id
        and ((${delta} = -1 and c.sort_order < current.sort_order)
        or (${delta} = 1 and c.sort_order > current.sort_order))
      order by c.sort_order ${delta === -1 ? sql`desc` : sql`asc`}, c.id
      limit 1
    )
    update category c set sort_order = case when c.id = ${id} then (select sort_order from adjacent)
      else (select sort_order from current) end, updated_at = now(), version = version + 1
    where c.id = ${id} or c.id = (select id from adjacent)
  `.execute(exec);
}

export async function ensureDefaultCategories(exec: Executor): Promise<void> {
  await ensureTaxonomy(exec);
}

export async function getOrCreateUncategorizedCategory(
  exec: Executor,
): Promise<CategoryWithCountsRow> {
  const found = await sql<CategoryWithCountsRow>`
    select id, name_vi, is_active, sort_order, parent_id,
      (select count(*)::int from product p where p.category_id = c.id and p.is_archived = false) as product_count
    from category c where c.slug = 'khac' order by c.is_active desc, c.sort_order asc limit 1
  `.execute(exec);
  if (found.rows[0]) {
    if (!found.rows[0].is_active) await setCategoryActive(exec, found.rows[0].id, true);
    return { ...found.rows[0], is_active: true };
  }
  return createCategory(exec, { nameVi: "📦 Khác" });
}

export interface CatalogProductRow {
  id: string;
  category_id: string;
  name_vi: string;
  slug: string;
  short_description_vi: string | null;
  sort_order: number;
}

/**
 * List active products under an active category that have at least one sellable
 * variant. A product with only hidden/unauthorized variants does not appear.
 */
export async function listActiveProductsByCategory(
  exec: Executor,
  categoryId: string,
): Promise<CatalogProductRow[]> {
  const result = await sql<CatalogProductRow>`
    select p.id, p.category_id, p.name_vi, p.slug, p.short_description_vi, p.sort_order
    from product p
    join category c on c.id = p.category_id
    where c.is_active
      and p.is_active
      and not p.is_test
      and not p.is_archived
      and c.id = ${categoryId}
      and exists (
        select 1 from product_variant v
        left join variant_quantity_stock q on q.variant_id = v.id
        where v.product_id = p.id
          and v.is_active
          and v.price_vnd > 0
          and ${currentPublicationSql()}
          and ${SELLABLE_ROUTE_SQL}
      )
    order by p.sort_order asc, p.id asc
  `.execute(exec);
  return result.rows;
}

/** Alias kept for call sites that prefer the shorter name. */
export const listActiveProducts = listActiveProductsByCategory;

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
 * List sellable variants, keyset-paginated. Optionally scoped to one product.
 * Returns up to `limit` rows plus an opaque `nextCursor` (null when exhausted).
 */
export async function listSellableVariants(
  exec: Executor,
  options: PageOptions & {
    productId?: string;
    categoryId?: string;
    audience?: CatalogAudience | undefined;
  },
): Promise<Page<CatalogVariantRow>> {
  const cursor = options.cursor ? decodeCursor(options.cursor) : null;
  const fetchLimit = options.limit + 1;

  const productFilter = options.productId ? sql`and v.product_id = ${options.productId}` : sql``;
  const categoryFilter = options.categoryId ? sql`and c.id = ${options.categoryId}` : sql``;
  const cursorFilter = cursor
    ? sql`and (v.sort_order, v.id) > (${cursor.sortOrder}, ${cursor.id})`
    : sql``;

  const result = await sql<CatalogVariantRow>`
    select
      v.id, v.product_id, p.name_vi as product_name_vi, v.sku, v.name_vi,
      v.price_vnd, v.duration_code, v.delivery_type, v.warranty_days,
      v.stock_policy, v.sort_order, v.fulfillment_type, v.warranty_enabled,
      q.available_quantity::int as available_quantity,
      ${VARIANT_READY_SQL} as is_ready,
      coalesce(v.preorder_enabled, false) as preorder_enabled,
      p.category_id
    from product_variant v
    join product p on p.id = v.product_id
    join category c on c.id = p.category_id
    left join variant_quantity_stock q on q.variant_id = v.id
    where c.is_active
      and p.is_active
      and v.is_active
      and v.price_vnd > 0
      ${catalogVisibilitySql(options.audience ?? "public")}
      and ${SELLABLE_ROUTE_SQL}
      ${productFilter}
      ${categoryFilter}
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

/**
 * Fetch a single sellable variant by id. Returns null (never throws) when the
 * variant does not exist or is not currently sellable — callers get no
 * distinction, so an unauthorized/hidden SKU cannot be probed by id.
 */
export async function getVariantById(
  exec: Executor,
  variantId: string,
  audience: CatalogAudience = "public",
): Promise<CatalogVariantRow | null> {
  const result = await sql<CatalogVariantRow>`
    select
      v.id, v.product_id, p.name_vi as product_name_vi, v.sku, v.name_vi,
      v.price_vnd, v.duration_code, v.delivery_type, v.warranty_days,
      v.stock_policy, v.sort_order, v.fulfillment_type, v.warranty_enabled,
      q.available_quantity::int as available_quantity,
      ${VARIANT_READY_SQL} as is_ready,
      p.description_vi, p.what_customer_receives_vi, p.usage_instructions_vi,
      p.delivery_eta_vi, p.warranty_vi, p.support_vi,
      v.compare_at_price_vnd::text as compare_at_price_vnd,
      p.stock_display_mode, p.category_id,
      v.presentation_profile
    from product_variant v
    join product p on p.id = v.product_id
    join category c on c.id = p.category_id
    left join variant_quantity_stock q on q.variant_id = v.id
    where v.id = ${variantId}
      and c.is_active
      and p.is_active
      and v.is_active
      and v.price_vnd > 0
      ${catalogVisibilitySql(audience)}
      and ${SELLABLE_ROUTE_SQL}
  `.execute(exec);
  return result.rows[0] ?? null;
}

/**
 * The variant's stored, presentation-only customization blob.
 *
 * Read WITHOUT audience gating and without the sellability filters on purpose: the
 * only caller decorates the payment screen for an order the customer already owns,
 * so this exposes no catalog data that order did not already reveal. Returns
 * `undefined` when unset; the value is untrusted product metadata and must be
 * validated (the payment presenter parses it with a strict schema and falls back
 * to the safe default profile when it does not fit).
 */
export async function loadVariantPresentationOverride(
  exec: Executor,
  variantId: string,
): Promise<unknown> {
  const result = await sql<{ presentation_profile: unknown }>`
    select v.presentation_profile
    from product_variant v
    where v.id = ${variantId}
    limit 1
  `.execute(exec);
  return result.rows[0]?.presentation_profile ?? undefined;
}

export interface StorefrontProductSummary {
  id: string;
  name_vi: string;
  slug: string;
  short_description_vi: string | null;
  min_price_vnd: string;
  total_available: number;
  preorder_enabled: boolean;
  primary_variant_id: string;
  primary_variant_sku: string;
  primary_variant_name: string;
}

/**
 * List customer-facing storefront products with stock and preorder status.
 */
export async function listStorefrontProducts(
  exec: Executor,
  limit: number = 6,
  offset: number = 0,
): Promise<{ items: StorefrontProductSummary[]; total: number }> {
  const result = await sql<StorefrontProductSummary & { total_count: number }>`
    with variant_data as (
      select
        v.id as variant_id,
        v.product_id,
        v.sku,
        v.name_vi as variant_name,
        v.price_vnd,
        v.sort_order,
        v.preorder_enabled,
        case
          when v.fulfillment_type in ('STOCK_ACCOUNT','STOCK_CODE') then (
            select count(*)::int from digital_asset a where a.variant_id = v.id and a.status = 'AVAILABLE'
          )
          when v.fulfillment_type = 'QUANTITY_STOCK' then coalesce(
            (select q.available_quantity from variant_quantity_stock q where q.variant_id = v.id), 0
          )::int
          when v.fulfillment_type = 'DIGITAL_FILE' then (
            select count(*)::int from variant_file_artifact f where f.variant_id = v.id and f.is_active
          )
          when v.fulfillment_type = 'SUPPLIER_API' then (
            select count(*)::int from supplier_sku ss join supplier s on s.id = ss.supplier_id
            where ss.variant_id = v.id and ss.is_active and s.status = 'ACTIVE'
          )
          when v.fulfillment_type in ('MANUAL_FULFILLMENT','UNLIMITED_SERVICE') then (
            select count(*)::int from variant_service_fulfillment sf
            where sf.variant_id = v.id and sf.fulfillment_type = v.fulfillment_type and sf.is_active
          )
          else 0
        end as available_count
      from product_variant v
      join product p on p.id = v.product_id
      where v.is_active
        and v.price_vnd > 0
        and v.publication_evidence_id = v.resale_evidence_id
        and v.publication_product_version = p.version
        and v.publication_variant_version = v.version
        and v.published_at is not null
        and ${SELLABLE_ROUTE_SQL}
        and exists (select 1 from resale_evidence re where re.id = v.publication_evidence_id and re.variant_id = v.id and re.status = 'ACTIVE')
    ),
    product_summary as (
      select
        p.id,
        p.name_vi,
        p.slug,
        p.short_description_vi,
        p.sort_order,
        min(vd.price_vnd)::text as min_price_vnd,
        coalesce(sum(vd.available_count), 0)::int as total_available,
        coalesce(bool_or(vd.preorder_enabled), false) as preorder_enabled,
        (array_agg(vd.variant_id order by vd.sort_order asc, vd.variant_id asc))[1] as primary_variant_id,
        (array_agg(vd.sku order by vd.sort_order asc, vd.variant_id asc))[1] as primary_variant_sku,
        (array_agg(vd.variant_name order by vd.sort_order asc, vd.variant_id asc))[1] as primary_variant_name
      from product p
      join category c on c.id = p.category_id
      join variant_data vd on vd.product_id = p.id
      where c.is_active
        and p.is_active
        and not p.is_test
        and not p.is_archived
      group by p.id, p.name_vi, p.slug, p.short_description_vi, p.sort_order
    )
    select
      id, name_vi, slug, short_description_vi,
      min_price_vnd, total_available, preorder_enabled,
      primary_variant_id, primary_variant_sku, primary_variant_name,
      count(*) over()::int as total_count
    from product_summary
    order by sort_order asc, id asc
    limit ${limit} offset ${offset}
  `.execute(exec);

  return {
    items: result.rows,
    total: result.rows[0]?.total_count ?? 0,
  };
}

/** List active test products for allowlisted/root-admin storefronts. */
export async function listTestCatalogProducts(
  exec: Executor,
  limit: number = 6,
  offset: number = 0,
): Promise<{ items: StorefrontProductSummary[]; total: number }> {
  const result = await sql<StorefrontProductSummary & { total_count: number }>`
    with variant_data as (
      select v.id as variant_id, v.product_id, v.sku,
        v.name_vi as variant_name, v.price_vnd, v.sort_order, v.preorder_enabled,
        case
          when v.fulfillment_type in ('STOCK_ACCOUNT','STOCK_CODE') then
            (select count(*)::int from digital_asset a where a.variant_id = v.id and a.status = 'AVAILABLE')
          when v.fulfillment_type = 'QUANTITY_STOCK' then coalesce(
            (select q.available_quantity from variant_quantity_stock q where q.variant_id = v.id), 0)::int
          when v.fulfillment_type = 'DIGITAL_FILE' then
            (select count(*)::int from variant_file_artifact f where f.variant_id = v.id and f.is_active)
          when v.fulfillment_type = 'SUPPLIER_API' then
            (select count(*)::int from supplier_sku ss join supplier s on s.id = ss.supplier_id
             where ss.variant_id = v.id and ss.is_active and s.status = 'ACTIVE')
          when v.fulfillment_type in ('MANUAL_FULFILLMENT','UNLIMITED_SERVICE') then
            (select count(*)::int from variant_service_fulfillment sf
             where sf.variant_id = v.id and sf.fulfillment_type = v.fulfillment_type and sf.is_active)
          else 0
        end as available_count
      from product_variant v
      where v.is_active and v.price_vnd > 0
    ), product_summary as (
      select p.id, p.name_vi, p.slug, p.short_description_vi, p.sort_order,
        min(vd.price_vnd)::text as min_price_vnd,
        coalesce(sum(vd.available_count), 0)::int as total_available,
        coalesce(bool_or(vd.preorder_enabled), false) as preorder_enabled,
        (array_agg(vd.variant_id order by vd.sort_order asc, vd.variant_id asc))[1] as primary_variant_id,
        (array_agg(vd.sku order by vd.sort_order asc, vd.variant_id asc))[1] as primary_variant_sku,
        (array_agg(vd.variant_name order by vd.sort_order asc, vd.variant_id asc))[1] as primary_variant_name
      from product p join category c on c.id = p.category_id join variant_data vd on vd.product_id = p.id
      where c.is_active and p.is_active and p.is_test and not p.is_archived
      group by p.id, p.name_vi, p.slug, p.short_description_vi, p.sort_order
    )
    select id, name_vi, slug, short_description_vi, min_price_vnd, total_available,
      preorder_enabled, primary_variant_id, primary_variant_sku, primary_variant_name,
      count(*) over()::int as total_count
    from product_summary order by sort_order asc, id asc limit ${limit} offset ${offset}
  `.execute(exec);
  return { items: result.rows, total: result.rows[0]?.total_count ?? 0 };
}

export interface CatalogCategoryNode extends CatalogCategoryRow {
  icon: string | null;
  display_name_vi: string | null;
  parent_id: string | null;
  is_active: boolean;
  is_featured: boolean;
  featured_rank: number | null;
  child_count: number;
  public_product_count: number;
}

function subtreeProductCountSql(audience: CatalogAudience) {
  return sql`(
    select count(distinct p.id)::int
    from product p
    join product_variant v on v.product_id = p.id
    left join variant_quantity_stock q on q.variant_id = v.id
    join category leaf on leaf.id = p.category_id
    where (leaf.id = c.id or leaf.parent_id = c.id)
      and leaf.is_active
      and p.is_active
      and v.is_active
      and v.price_vnd > 0
      ${catalogVisibilitySql(audience)}
      and ${SELLABLE_ROUTE_SQL}
  )`;
}

const CATEGORY_NODE_COLUMNS = sql`
  c.id, c.name_vi, c.slug, c.sort_order, c.parent_id, c.icon, c.display_name_vi,
  c.is_active, c.is_featured, c.featured_rank
`;

export async function listPublicRootCategories(
  exec: Executor,
  audience: CatalogAudience = "public",
): Promise<CatalogCategoryNode[]> {
  const result = await sql<CatalogCategoryNode>`
    select ${CATEGORY_NODE_COLUMNS},
      (select count(*)::int from category x where x.parent_id = c.id and x.is_active) as child_count,
      ${subtreeProductCountSql(audience)} as public_product_count
    from category c
    where c.parent_id is null and c.is_active
    order by c.sort_order asc, c.id asc
  `.execute(exec);
  return result.rows.filter(
    (row) => row.public_product_count > 0 && !isFulfillmentTaxonomyNode(row.slug, row.name_vi),
  );
}

export async function listFeaturedProducts(
  exec: Executor,
  audience: CatalogAudience = "public",
  limit = 3,
): Promise<StorefrontProductSummary[]> {
  return listScopedProducts(exec, audience, {
    featuredOnly: true,
    limit,
    offset: 0,
  });
}

async function listScopedProducts(
  exec: Executor,
  audience: CatalogAudience,
  options: {
    categoryId?: string;
    includeChildren?: boolean;
    featuredOnly?: boolean;
    categoryFeaturedFirst?: boolean;
    limit: number;
    offset: number;
  },
): Promise<StorefrontProductSummary[]> {
  const categoryFilter = options.categoryId
    ? options.includeChildren
      ? sql`and (p.category_id = ${options.categoryId} or c.parent_id = ${options.categoryId})`
      : sql`and p.category_id = ${options.categoryId}`
    : sql``;
  const featuredFilter = options.featuredOnly ? sql`and p.is_featured` : sql``;
  const orderBy = options.categoryFeaturedFirst
    ? sql`p.is_category_featured desc, p.category_featured_rank nulls last, p.sort_order asc, p.id asc`
    : options.featuredOnly
      ? sql`p.featured_rank nulls last, p.sort_order asc, p.id asc`
      : sql`p.sort_order asc, p.id asc`;
  const result = await sql<StorefrontProductSummary>`
    select
      p.id, p.name_vi, p.slug, p.short_description_vi,
      min(v.price_vnd)::text as min_price_vnd,
      0::int as total_available,
      coalesce(bool_or(v.preorder_enabled), false) as preorder_enabled,
      (array_agg(v.id order by v.sort_order, v.id))[1] as primary_variant_id,
      (array_agg(v.sku order by v.sort_order, v.id))[1] as primary_variant_sku,
      (array_agg(v.name_vi order by v.sort_order, v.id))[1] as primary_variant_name
    from product p
    join category c on c.id = p.category_id
    join product_variant v on v.product_id = p.id
    left join variant_quantity_stock q on q.variant_id = v.id
    where c.is_active
      and p.is_active
      and v.is_active
      and v.price_vnd > 0
      ${catalogVisibilitySql(audience)}
      and ${SELLABLE_ROUTE_SQL}
      ${categoryFilter}
      ${featuredFilter}
    group by p.id, p.name_vi, p.slug, p.short_description_vi, p.sort_order,
      p.is_featured, p.featured_rank, p.is_category_featured, p.category_featured_rank
    order by ${orderBy}
    limit ${options.limit} offset ${options.offset}
  `.execute(exec);
  return result.rows;
}

export interface PublicCategoryPage {
  category: CatalogCategoryNode;
  parent: CatalogCategoryNode | null;
  children: CatalogCategoryNode[];
  products: StorefrontProductSummary[];
  featured: StorefrontProductSummary[];
  page: number;
  totalPages: number;
  pageSize: number;
}

async function loadCategoryNode(
  exec: Executor,
  categoryId: string,
  audience: CatalogAudience,
): Promise<CatalogCategoryNode | null> {
  const result = await sql<CatalogCategoryNode>`
    select ${CATEGORY_NODE_COLUMNS},
      (select count(*)::int from category x where x.parent_id = c.id and x.is_active) as child_count,
      ${subtreeProductCountSql(audience)} as public_product_count
    from category c
    where c.id = ${categoryId} and c.is_active
    limit 1
  `.execute(exec);
  return result.rows[0] ?? null;
}

export async function listPublicCategoryPage(
  exec: Executor,
  categoryId: string,
  audience: CatalogAudience = "public",
  page = 0,
  pageSize = 8,
): Promise<PublicCategoryPage | null> {
  const category = await loadCategoryNode(exec, categoryId, audience);
  if (!category) return null;
  if (isFulfillmentTaxonomyNode(category.slug, category.name_vi)) return null;
  if (category.public_product_count <= 0) return null;
  const parent = category.parent_id
    ? await loadCategoryNode(exec, category.parent_id, audience)
    : null;
  const childResult = await sql<CatalogCategoryNode>`
    select ${CATEGORY_NODE_COLUMNS},
      (select count(*)::int from category x where x.parent_id = c.id and x.is_active) as child_count,
      ${subtreeProductCountSql(audience)} as public_product_count
    from category c
    where c.parent_id = ${categoryId} and c.is_active
    order by c.sort_order asc, c.id asc
  `.execute(exec);
  const visibleChildren = childResult.rows.filter(
    (row) => row.public_product_count > 0 && !isFulfillmentTaxonomyNode(row.slug, row.name_vi),
  );
  const safePage = Math.max(0, page);
  const featured = await listScopedProducts(exec, audience, {
    categoryId,
    includeChildren: true,
    featuredOnly: true,
    limit: 3,
    offset: 0,
  });
  if (visibleChildren.length > 0) {
    const totalPages = Math.max(1, Math.ceil(visibleChildren.length / pageSize));
    const start = safePage * pageSize;
    return {
      category,
      parent,
      children: visibleChildren.slice(start, start + pageSize),
      products: [],
      featured,
      page: safePage,
      totalPages,
      pageSize,
    };
  }
  const products = await listScopedProducts(exec, audience, {
    categoryId,
    includeChildren: false,
    categoryFeaturedFirst: true,
    limit: pageSize,
    offset: safePage * pageSize,
  });
  const countResult = await sql<{ n: number }>`
    select count(distinct p.id)::int as n
    from product p
    join category c on c.id = p.category_id
    join product_variant v on v.product_id = p.id
    left join variant_quantity_stock q on q.variant_id = v.id
    where p.category_id = ${categoryId}
      and c.is_active and p.is_active and v.is_active and v.price_vnd > 0
      ${catalogVisibilitySql(audience)}
      and ${SELLABLE_ROUTE_SQL}
  `.execute(exec);
  const total = countResult.rows[0]?.n ?? 0;
  return {
    category,
    parent,
    children: [],
    products,
    featured,
    page: safePage,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
    pageSize,
  };
}

export interface ProductDetailView {
  id: string;
  name_vi: string;
  slug: string;
  short_description_vi: string | null;
  description_vi: string | null;
  what_customer_receives_vi: string | null;
  usage_instructions_vi: string | null;
  delivery_eta_vi: string | null;
  warranty_vi: string | null;
  support_vi: string | null;
  category_id: string;
  category_name: string;
  parent_category_id: string | null;
  parent_category_name: string | null;
  stock_display_mode: "BAND" | "EXACT" | null;
  variants: CatalogVariantRow[];
}

export async function getProductDetail(
  exec: Executor,
  productId: string,
  audience: CatalogAudience = "public",
): Promise<ProductDetailView | null> {
  const result = await sql<{
    id: string;
    name_vi: string;
    slug: string;
    short_description_vi: string | null;
    description_vi: string | null;
    what_customer_receives_vi: string | null;
    usage_instructions_vi: string | null;
    delivery_eta_vi: string | null;
    warranty_vi: string | null;
    support_vi: string | null;
    category_id: string;
    category_name: string;
    parent_category_id: string | null;
    parent_category_name: string | null;
    stock_display_mode: "BAND" | "EXACT" | null;
  }>`
    select p.id, p.name_vi, p.slug, p.short_description_vi, p.description_vi,
      p.what_customer_receives_vi, p.usage_instructions_vi, p.delivery_eta_vi,
      p.warranty_vi, p.support_vi, p.category_id, c.name_vi as category_name,
      c.parent_id as parent_category_id, parent.name_vi as parent_category_name,
      p.stock_display_mode
    from product p
    join category c on c.id = p.category_id
    left join category parent on parent.id = c.parent_id
    join product_variant v on v.product_id = p.id
    where p.id = ${productId}
      and c.is_active and p.is_active
      ${catalogVisibilitySql(audience)}
    limit 1
  `.execute(exec);
  const product = result.rows[0];
  if (!product) return null;
  const variants = await listSellableVariants(exec, { limit: 24, productId, audience });
  if (variants.items.length === 0) return null;
  return { ...product, variants: variants.items };
}

async function assertValidParent(
  exec: Executor,
  id: string | null,
  newParentId: string,
): Promise<void> {
  if (id && id === newParentId) throw new Error("SELF");
  const parent = await sql<{ id: string; parent_id: string | null }>`
    select id, parent_id from category where id = ${newParentId} limit 1
  `.execute(exec);
  if (!parent.rows[0]) throw new Error("INVALID_PARENT");
  if (parent.rows[0].parent_id) throw new Error("DEPTH");
  if (id) {
    const children = await sql<{ id: string }>`
      select id from category where parent_id = ${id} limit 1
    `.execute(exec);
    if (children.rows[0]) throw new Error("DEPTH");
    let cursor: string | null = newParentId;
    for (let hop = 0; hop < 8 && cursor; hop++) {
      if (cursor === id) throw new Error("CYCLE");
      const row = await sql<{ parent_id: string | null }>`
        select parent_id from category where id = ${cursor} limit 1
      `.execute(exec);
      cursor = row.rows[0]?.parent_id ?? null;
    }
  }
}

export async function moveCategory(
  exec: Executor,
  id: string,
  newParentId: string | null,
): Promise<void> {
  if (newParentId) await assertValidParent(exec, id, newParentId);
  await sql`update category set parent_id = ${newParentId}, updated_at = now(), version = version + 1 where id = ${id}`.execute(
    exec,
  );
}

export async function setProductFeatured(
  exec: Executor,
  productId: string,
  featured: boolean,
  rank?: number | null,
): Promise<void> {
  await sql`
    update product
    set is_featured = ${featured},
        featured_rank = ${featured ? (rank ?? 0) : null},
        updated_at = now(),
        version = version + 1
    where id = ${productId}
  `.execute(exec);
}
