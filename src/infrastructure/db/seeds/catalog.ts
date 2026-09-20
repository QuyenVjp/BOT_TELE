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
  const aiCategory = newId();
  const hidden = newId();

  await sql`
    insert into category (id, name_vi, slug, is_active, sort_order) values
      (${aiCategory}, 'AI', 'ai', true, 1),
      (${hidden}, 'Danh mục ẩn', 'an', false, 2)
  `.execute(exec);

  const chatgpt = newId();
  const claude = newId();

  await sql`
    insert into product (id, category_id, name_vi, slug, short_description_vi, is_active, sort_order) values
      (${chatgpt}, ${aiCategory}, 'ChatGPT', 'chatgpt', 'Trợ lý AI hội thoại', true, 1),
      (${claude}, ${aiCategory}, 'Claude', 'claude', 'Trợ lý AI viết và phân tích', true, 2)
  `.execute(exec);

  await sql`
    insert into product_alias (id, product_id, normalized_alias, locale, priority) values
      (${newId()}, ${chatgpt}, 'chatgpt', 'vi', 1),
      (${newId()}, ${claude}, 'claude', 'vi', 1)
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
    chatgpt,
    "CG-1M",
    "Gói 1 tháng",
    120000,
    "CREDENTIAL",
    "LOCAL_ONLY",
    "RES-CG1",
    true,
    1,
  ).execute(exec);
  await mkVariant(
    chatgpt,
    "CG-3M",
    "Gói 3 tháng",
    320000,
    "CREDENTIAL",
    "LOCAL_THEN_SUPPLIER",
    "RES-CG3",
    true,
    2,
  ).execute(exec);
  await mkVariant(
    claude,
    "CL-1M",
    "Gói 1 tháng",
    59000,
    "INVITE",
    "LOCAL_ONLY",
    "RES-CL1",
    true,
    3,
  ).execute(exec);

  // Hidden: PAUSED variant (valid otherwise).
  await mkVariant(
    claude,
    "CL-PAUSED",
    "Gói tạm dừng",
    59000,
    "INVITE",
    "PAUSED",
    "RES-CLP",
    true,
    4,
  ).execute(exec);

  // UNAUTHORIZED SKU: no resale evidence — must never surface (SR-007).
  await mkVariant(
    chatgpt,
    "CG-NOAUTH",
    "Chưa được phép bán",
    99000,
    "LICENSE",
    "LOCAL_ONLY",
    null,
    true,
    5,
  ).execute(exec);
}
