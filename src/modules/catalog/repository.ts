import { sql } from "kysely";
import type { Executor } from "../../infrastructure/db/transaction.js";
import type { DeliveryType, StockPolicy } from "./domain.js";
import type { FulfillmentType } from "./fulfillment-type.js";
import { newId } from "../../shared/ids/index.js";

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
}

export interface PageOptions {
  limit: number;
  cursor?: string | null;
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

/** List active categories in stable (sort_order, id) order. */
export async function listActiveCategories(exec: Executor): Promise<CatalogCategoryRow[]> {
  const result = await sql<CatalogCategoryRow>`
    select id, name_vi, slug, sort_order
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
}

export async function listCategoriesWithCounts(exec: Executor): Promise<CategoryWithCountsRow[]> {
  const result = await sql<CategoryWithCountsRow>`
    select c.id, c.name_vi, c.is_active, c.sort_order,
           count(p.id)::int as product_count
    from category c
    left join product p on p.category_id = c.id and p.is_archived = false
    group by c.id, c.name_vi, c.is_active, c.sort_order
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
  input: { nameVi: string },
): Promise<CategoryWithCountsRow> {
  const nameVi = input.nameVi.trim();
  if (!nameVi) throw new Error("CATEGORY_NAME_REQUIRED");
  const id = newId();
  const result = await sql<CategoryWithCountsRow>`
    insert into category (id, name_vi, slug, is_active, sort_order)
    values (${id}, ${nameVi}, ${categorySlug(nameVi)}, true,
      (select coalesce(max(sort_order), 0) + 1 from category))
    returning id, name_vi, is_active, sort_order, 0::int as product_count
  `.execute(exec);
  return result.rows[0]!;
}

export async function renameCategory(exec: Executor, id: string, nameVi: string): Promise<void> {
  const name = nameVi.trim();
  if (!name) throw new Error("CATEGORY_NAME_REQUIRED");
  await sql`update category set name_vi = ${name}, slug = ${categorySlug(name)}, updated_at = now(), version = version + 1 where id = ${id}`.execute(
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
    with current as (select sort_order from category where id = ${id}), adjacent as (
      select c.id, c.sort_order from category c, current
      where c.id <> ${id} and ((${delta} = -1 and c.sort_order < current.sort_order)
        or (${delta} = 1 and c.sort_order > current.sort_order))
      order by c.sort_order ${delta === -1 ? sql`desc` : sql`asc`}, c.id
      limit 1
    )
    update category c set sort_order = case when c.id = ${id} then (select sort_order from adjacent)
      else (select sort_order from current) end, updated_at = now(), version = version + 1
    where c.id = ${id} or c.id = (select id from adjacent)
  `.execute(exec);
}

const DEFAULT_CATEGORIES = [
  "🤖 AI / ChatGPT",
  "💻 Coding / IDE",
  "🔑 Key & License",
  "☁️ Cloud / VPS",
  "📦 Khác",
] as const;

export async function ensureDefaultCategories(exec: Executor): Promise<void> {
  const existing = await sql<{
    count: number;
  }>`select count(*)::int as count from category where is_active`.execute(exec);
  if ((existing.rows[0]?.count ?? 0) > 0) return;
  for (const [index, nameVi] of DEFAULT_CATEGORIES.entries()) {
    await sql`insert into category (id, name_vi, slug, is_active, sort_order)
      values (${newId()}, ${nameVi}, ${categorySlug(nameVi)}, true, ${index + 1})`.execute(exec);
  }
}

export async function getOrCreateUncategorizedCategory(
  exec: Executor,
): Promise<CategoryWithCountsRow> {
  const found = await sql<CategoryWithCountsRow>`
    select id, name_vi, is_active, sort_order,
      (select count(*)::int from product p where p.category_id = c.id and p.is_archived = false) as product_count
    from category c where c.slug = 'khac' order by c.is_active desc, c.sort_order asc limit 1
  `.execute(exec);
  if (found.rows[0]) {
    if (!found.rows[0].is_active) await setCategoryActive(exec, found.rows[0].id, true);
    return { ...found.rows[0], is_active: true };
  }
  return createCategory(exec, { nameVi: "📁 Khác" });
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
        where v.product_id = p.id
          and v.is_active
          and v.price_vnd > 0
          and v.resale_evidence_id is not null
          and (
            (v.stock_policy in ('LOCAL_ONLY','LOCAL_THEN_SUPPLIER') and v.fulfillment_type <> 'SUPPLIER_API')
            or (v.stock_policy = 'SUPPLIER_ONLY' and v.fulfillment_type = 'SUPPLIER_API' and exists (
              select 1 from supplier_sku ss join supplier s on s.id = ss.supplier_id
              where ss.variant_id = v.id and ss.is_active and s.status = 'ACTIVE'
            ))
          )
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
  options: PageOptions & { productId?: string; categoryId?: string },
): Promise<Page<CatalogVariantRow>> {
  const cursor = options.cursor ? decodeCursor(options.cursor) : null;
  // Fetch one extra row to determine whether a further page exists.
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
    left join variant_quantity_stock q on q.variant_id = v.id
    where c.is_active
      and p.is_active
      and not p.is_test
      and not p.is_archived
      and v.is_active
      and v.price_vnd > 0
      and v.resale_evidence_id is not null
      and (
        (v.stock_policy in ('LOCAL_ONLY','LOCAL_THEN_SUPPLIER') and v.fulfillment_type <> 'SUPPLIER_API')
        or (v.stock_policy = 'SUPPLIER_ONLY' and v.fulfillment_type = 'SUPPLIER_API' and exists (
          select 1 from supplier_sku ss join supplier s on s.id = ss.supplier_id
          where ss.variant_id = v.id and ss.is_active and s.status = 'ACTIVE'
        ))
      )
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
): Promise<CatalogVariantRow | null> {
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
    left join variant_quantity_stock q on q.variant_id = v.id
    where v.id = ${variantId}
      and c.is_active
      and p.is_active
      and not p.is_archived
      and v.is_active
      and v.price_vnd > 0
      and (
        (v.stock_policy in ('LOCAL_ONLY','LOCAL_THEN_SUPPLIER') and v.fulfillment_type <> 'SUPPLIER_API')
        or (v.stock_policy = 'SUPPLIER_ONLY' and v.fulfillment_type = 'SUPPLIER_API' and exists (
          select 1 from supplier_sku ss join supplier s on s.id = ss.supplier_id
          where ss.variant_id = v.id and ss.is_active and s.status = 'ACTIVE'
        ))
      )
  `.execute(exec);
  return result.rows[0] ?? null;
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
      where v.is_active
        and v.price_vnd > 0
        and v.resale_evidence_id is not null
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
