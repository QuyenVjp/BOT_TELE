import { sql } from "kysely";
import type { Executor } from "../transaction.js";
import { newId } from "../../../shared/ids/index.js";

/**
 * Safe development catalog seed (T037).
 *
 * Deliberately mixes:
 *  - active categories/products with sellable variants (browsable);
 *  - one INACTIVE category (must stay hidden);
 *  - one PAUSED variant (must stay hidden);
 *  - ONE UNAUTHORIZED SKU with no resale evidence (SR-007 — must NEVER surface).
 *
 * Contains no secrets and no real supplier data — safe to run in any dev/test DB.
 */

export async function seedCatalog(exec: Executor): Promise<void> {
  const entertainment = newId();
  const hidden = newId();

  await sql`
    insert into category (id, name_vi, slug, is_active, sort_order) values
      (${entertainment}, 'Giải trí', 'giai-tri', true, 1),
      (${hidden}, 'Danh mục ẩn', 'an', false, 2)
  `.execute(exec);

  const netflix = newId();
  const spotify = newId();

  await sql`
    insert into product (id, category_id, name_vi, slug, short_description_vi, is_active, sort_order) values
      (${netflix}, ${entertainment}, 'Netflix', 'netflix', 'Xem phim bản quyền', true, 1),
      (${spotify}, ${entertainment}, 'Spotify', 'spotify', 'Nghe nhạc không quảng cáo', true, 2)
  `.execute(exec);

  await sql`
    insert into product_alias (id, product_id, normalized_alias, locale, priority) values
      (${newId()}, ${netflix}, 'phim', 'vi', 1),
      (${newId()}, ${spotify}, 'nhac', 'vi', 1)
  `.execute(exec);

  const mkVariant = (
    productId: string,
    sku: string,
    nameVi: string,
    priceVnd: number,
    delivery: string,
    stockPolicy: string,
    resaleEvidenceId: string | null,
    isActive: boolean,
    sortOrder: number,
  ) =>
    sql`
      insert into product_variant
        (id, product_id, sku, name_vi, price_vnd, duration_code, delivery_type, warranty_days,
         stock_policy, resale_evidence_id, is_active, sort_order)
      values
        (${newId()}, ${productId}, ${sku}, ${nameVi}, ${priceVnd}, 'P1M', ${delivery}, 30,
         ${stockPolicy}, ${resaleEvidenceId}, ${isActive}, ${sortOrder})
    `;

  // Sellable variants.
  await mkVariant(
    netflix,
    "NF-1M",
    "Gói 1 tháng",
    120000,
    "CREDENTIAL",
    "LOCAL_ONLY",
    "RES-NF1",
    true,
    1,
  ).execute(exec);
  await mkVariant(
    netflix,
    "NF-3M",
    "Gói 3 tháng",
    320000,
    "CREDENTIAL",
    "LOCAL_THEN_SUPPLIER",
    "RES-NF3",
    true,
    2,
  ).execute(exec);
  await mkVariant(
    spotify,
    "SP-1M",
    "Gói 1 tháng",
    59000,
    "INVITE",
    "LOCAL_ONLY",
    "RES-SP1",
    true,
    3,
  ).execute(exec);

  // Hidden: PAUSED variant (valid otherwise).
  await mkVariant(
    spotify,
    "SP-PAUSED",
    "Gói tạm dừng",
    59000,
    "INVITE",
    "PAUSED",
    "RES-SPP",
    true,
    4,
  ).execute(exec);

  // UNAUTHORIZED SKU: no resale evidence — must never surface (SR-007).
  await mkVariant(
    netflix,
    "NF-NOAUTH",
    "Chưa được phép bán",
    99000,
    "LICENSE",
    "LOCAL_ONLY",
    null,
    true,
    5,
  ).execute(exec);
}
