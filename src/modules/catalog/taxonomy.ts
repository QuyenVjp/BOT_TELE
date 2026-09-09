import { sql } from "kysely";
import type { Executor } from "../../infrastructure/db/transaction.js";
import { newId } from "../../shared/ids/index.js";

function foldText(input: string): string {
  return input
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/đ/g, "d")
    .replace(/\s+/g, " ")
    .trim();
}

const ROOTS: ReadonlyArray<{
  slug: string;
  nameVi: string;
  icon: string;
  sortOrder: number;
}> = [
  { slug: "ai", nameVi: "🤖 AI", icon: "🤖", sortOrder: 1 },
  { slug: "coding", nameVi: "💻 Coding / IDE", icon: "💻", sortOrder: 2 },
  { slug: "vpn", nameVi: "🌐 VPN", icon: "🌐", sortOrder: 3 },
  { slug: "design", nameVi: "🎨 Thiết kế / Sáng tạo", icon: "🎨", sortOrder: 4 },
  { slug: "cloud", nameVi: "☁️ Cloud / VPS", icon: "☁️", sortOrder: 5 },
  { slug: "license", nameVi: "🔑 Key / License", icon: "🔑", sortOrder: 6 },
  { slug: "khac", nameVi: "📦 Khác", icon: "📦", sortOrder: 7 },
];

const BRANDS: ReadonlyArray<{
  slug: string;
  rootSlug: string;
  nameVi: string;
  sortOrder: number;
}> = [
  { slug: "chatgpt", rootSlug: "ai", nameVi: "ChatGPT", sortOrder: 1 },
  { slug: "claude", rootSlug: "ai", nameVi: "Claude", sortOrder: 2 },
  { slug: "gemini", rootSlug: "ai", nameVi: "Gemini", sortOrder: 3 },
  { slug: "cursor", rootSlug: "coding", nameVi: "Cursor", sortOrder: 1 },
  { slug: "kiro", rootSlug: "coding", nameVi: "Kiro", sortOrder: 2 },
  { slug: "codex", rootSlug: "coding", nameVi: "Codex", sortOrder: 3 },
  { slug: "expressvpn", rootSlug: "vpn", nameVi: "ExpressVPN", sortOrder: 1 },
  { slug: "hma", rootSlug: "vpn", nameVi: "HMA", sortOrder: 2 },
  { slug: "canva", rootSlug: "design", nameVi: "Canva", sortOrder: 1 },
];

const PRODUCT_BRAND_RULES: ReadonlyArray<{ pattern: RegExp; slug: string }> = [
  { pattern: /chatgpt|chat\s*gpt|\bgpt\b/, slug: "chatgpt" },
  { pattern: /claude|\bclau\b/, slug: "claude" },
  { pattern: /gemini/, slug: "gemini" },
  { pattern: /cursor/, slug: "cursor" },
  { pattern: /\bkiro\b/, slug: "kiro" },
  { pattern: /\bcodex\b/, slug: "codex" },
  { pattern: /express\s*vpn|expressvpn/, slug: "expressvpn" },
  { pattern: /\bhma\b|hidemyass|hide\s*my\s*ass/, slug: "hma" },
  { pattern: /canva/, slug: "canva" },
];

const ALIASES: ReadonlyArray<{ alias: string; brandSlug: string }> = [
  { alias: "chatgpt", brandSlug: "chatgpt" },
  { alias: "gpt", brandSlug: "chatgpt" },
  { alias: "chat gpt", brandSlug: "chatgpt" },
  { alias: "claude", brandSlug: "claude" },
  { alias: "clau", brandSlug: "claude" },
  { alias: "express vpn", brandSlug: "expressvpn" },
  { alias: "expressvpn", brandSlug: "expressvpn" },
  { alias: "hma", brandSlug: "hma" },
  { alias: "cursor", brandSlug: "cursor" },
  { alias: "canva", brandSlug: "canva" },
];

const FULFILLMENT_SLUGS = new Set([
  "tai-khoan",
  "tai-khoan-ai",
  "key",
  "key-code",
  "phan-mem",
  "phan-mem-dich-vu",
  "accounts",
  "codes",
]);

export function isFulfillmentTaxonomyNode(slug: string, nameVi: string): boolean {
  return looksLikeFulfillmentBucket(slug, nameVi);
}

function looksLikeFulfillmentBucket(slug: string, nameVi: string): boolean {
  if (FULFILLMENT_SLUGS.has(slug)) return true;
  const folded = foldText(nameVi);
  return (
    folded.includes("tai khoan") ||
    folded.includes("key / code") ||
    folded.includes("key code") ||
    folded.includes("phan mem / dich vu") ||
    folded.includes("phan mem dich vu")
  );
}

function matchBrandSlug(nameVi: string, slug: string): string | null {
  const haystack = foldText(`${nameVi} ${slug}`);
  for (const rule of PRODUCT_BRAND_RULES) {
    if (rule.pattern.test(haystack)) return rule.slug;
  }
  return null;
}

async function upsertCategory(
  exec: Executor,
  input: {
    slug: string;
    nameVi: string;
    icon: string | null;
    parentId: string | null;
    sortOrder: number;
  },
): Promise<string> {
  const found = await sql<{ id: string }>`
    select id from category where slug = ${input.slug}
    order by is_active desc, sort_order asc
    limit 1
  `.execute(exec);
  if (found.rows[0]) {
    await sql`
      update category
      set name_vi = ${input.nameVi},
          display_name_vi = ${input.nameVi},
          icon = ${input.icon},
          parent_id = ${input.parentId},
          is_active = true,
          sort_order = ${input.sortOrder},
          updated_at = now(),
          version = version + 1
      where id = ${found.rows[0].id}
    `.execute(exec);
    return found.rows[0].id;
  }
  const id = newId();
  await sql`
    insert into category (id, name_vi, slug, parent_id, is_active, sort_order, icon, display_name_vi)
    values (${id}, ${input.nameVi}, ${input.slug}, ${input.parentId}, true, ${input.sortOrder}, ${input.icon}, ${input.nameVi})
  `.execute(exec);
  return id;
}

export async function ensureTaxonomy(exec: Executor): Promise<void> {
  const ids = new Map<string, string>();
  for (const root of ROOTS) {
    const id = await upsertCategory(exec, {
      slug: root.slug,
      nameVi: root.nameVi,
      icon: root.icon,
      parentId: null,
      sortOrder: root.sortOrder,
    });
    ids.set(root.slug, id);
  }
  for (const brand of BRANDS) {
    const parentId = ids.get(brand.rootSlug);
    if (!parentId) continue;
    const id = await upsertCategory(exec, {
      slug: brand.slug,
      nameVi: brand.nameVi,
      icon: null,
      parentId,
      sortOrder: brand.sortOrder,
    });
    ids.set(brand.slug, id);
  }

  const products = await sql<{ id: string; name_vi: string; slug: string; category_id: string }>`
    select id, name_vi, slug, category_id from product where not is_archived
  `.execute(exec);
  for (const product of products.rows) {
    const brandSlug = matchBrandSlug(product.name_vi, product.slug);
    if (!brandSlug) continue;
    const brandId = ids.get(brandSlug);
    if (!brandId || product.category_id === brandId) continue;
    await sql`
      update product
      set category_id = ${brandId}, updated_at = now(), version = version + 1
      where id = ${product.id}
    `.execute(exec);
  }

  for (const { alias, brandSlug } of ALIASES) {
    const brandId = ids.get(brandSlug);
    if (!brandId) continue;
    await sql`
      insert into product_alias (id, product_id, normalized_alias, locale)
      select ${newId()}, p.id, ${alias}, 'vi'
      from product p
      where p.category_id = ${brandId}
        and not p.is_archived
        and not exists (
          select 1 from product_alias a
          where a.product_id = p.id and a.locale = 'vi' and a.normalized_alias = ${alias}
        )
    `.execute(exec);
  }

  const khacId = ids.get("khac");
  if (khacId) {
    const stranded = await sql<{
      id: string;
      name_vi: string;
      slug: string;
      cat_slug: string;
      cat_name: string;
    }>`
      select p.id, p.name_vi, p.slug, c.slug as cat_slug, c.name_vi as cat_name
      from product p
      join category c on c.id = p.category_id
      where not p.is_archived
    `.execute(exec);
    for (const product of stranded.rows) {
      if (!looksLikeFulfillmentBucket(product.cat_slug, product.cat_name)) continue;
      if (matchBrandSlug(product.name_vi, product.slug)) continue;
      await sql`
        update product
        set category_id = ${khacId}, updated_at = now(), version = version + 1
        where id = ${product.id}
      `.execute(exec);
    }
  }

  const leftover = await sql<{ id: string; slug: string; name_vi: string }>`
    select c.id, c.slug, c.name_vi
    from category c
    where c.is_active
      and not exists (select 1 from product p where p.category_id = c.id and not p.is_archived)
      and not exists (select 1 from category child where child.parent_id = c.id and child.is_active)
  `.execute(exec);
  for (const row of leftover.rows) {
    if (ids.has(row.slug)) continue;
    if (!looksLikeFulfillmentBucket(row.slug, row.name_vi)) continue;
    await sql`
      update category
      set is_active = false, updated_at = now(), version = version + 1
      where id = ${row.id}
    `.execute(exec);
  }
}
