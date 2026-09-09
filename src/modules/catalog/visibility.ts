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

/**
 * Product+variant visibility predicate. Expects SQL aliases `p` (product) and
 * `v` (product_variant). Public listings never include `is_test`. Test audience
 * may include test SKUs; resale evidence is required only for non-test products.
 */
export function catalogVisibilitySql(audience: CatalogAudience) {
  if (audience === "test") {
    return sql`and not p.is_archived and (p.is_test or v.resale_evidence_id is not null)`;
  }
  return sql`and not p.is_archived and not p.is_test and v.resale_evidence_id is not null`;
}
