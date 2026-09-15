import { sql } from "kysely";
import type { Executor } from "../../infrastructure/db/transaction.js";
import { getStoreMode, isTestCustomer } from "../commerce/store-mode.js";

/**
 * Catalog listing audience. Purchase remains gated by frozen `canPurchase`.
 * CLOSED/OPEN public browse is allowed; test SKUs are TEST-mode allowlist/root only.
 */
export type CatalogAudience = "public" | "test";

export interface CatalogIdentity {
  telegramUserId?: string | undefined;
  isRootAdmin?: boolean | undefined;
}

export async function resolveCatalogAudience(
  db: Executor,
  identity?: CatalogIdentity | undefined,
): Promise<CatalogAudience> {
  const telegramUserId = identity?.telegramUserId;
  const isRootAdmin = identity?.isRootAdmin === true;
  if (!telegramUserId && !isRootAdmin) return "public";
  const mode = await getStoreMode(db);
  if (mode !== "TEST") return "public";
  if (isRootAdmin) return "test";
  if (telegramUserId && (await isTestCustomer(db, telegramUserId))) return "test";
  return "public";
}

/** Current publication binding. Expects SQL aliases `p` and `v`. */
export function currentPublicationSql() {
  return sql`(
    v.resale_evidence_id is not null
    and v.publication_evidence_id = v.resale_evidence_id
    and v.publication_product_version = p.version
    and v.publication_variant_version = v.version
    and v.published_at is not null
    and exists (
      select 1 from resale_evidence re
      where re.id = v.publication_evidence_id
        and re.variant_id = v.id
        and re.status = 'ACTIVE'
    )
  )`;
}

/**
 * Product+variant visibility predicate. Expects SQL aliases `p` (product) and
 * `v` (product_variant). Public listings never include test or unpublished rows.
 * Test audience may include test SKUs without a publication binding.
 */
export function catalogVisibilitySql(audience: CatalogAudience) {
  const published = currentPublicationSql();
  if (audience === "test") {
    return sql`and not p.is_archived and (p.is_test or ${published})`;
  }
  return sql`and not p.is_archived and not p.is_test and ${published}`;
}
