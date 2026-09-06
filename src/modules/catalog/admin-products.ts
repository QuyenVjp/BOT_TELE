import { sql } from "kysely";
import type { Db } from "../../infrastructure/db/transaction.js";
import { withTransaction } from "../../infrastructure/db/transaction.js";
import { appendAuditEvent } from "../identity/audit.js";
import type { RootActor, RootAdminConfig } from "../identity/root-admin.js";
import { guardRootAction } from "../../bot/middleware/root-admin.js";
import { newId } from "../../shared/ids/index.js";

export interface AdminProductInput {
  actor: RootActor;
  config: RootAdminConfig;
  db: Db;
  categoryId: string;
  name: string;
  slug: string;
  sku: string;
  description?: string;
  priceVnd: bigint;
  reason: string;
  correlationId: string;
}

export interface AdminProductSummary {
  id: string;
  variantId: string;
  name: string;
  sku: string;
  priceVnd: bigint;
  active: boolean;
}

export interface AdminProductDetail extends AdminProductSummary {
  categoryId: string;
  slug: string;
  description: string | null;
}

export interface AdminProductMutation {
  actor: RootActor;
  config: RootAdminConfig;
  db: Db;
  productId: string;
  name?: string;
  slug?: string;
  description?: string | null;
  priceVnd?: bigint;
  reason: string;
  correlationId: string;
}


function validate(input: AdminProductInput): void {
  if (!input.name.trim() || input.name.length > 200) throw new Error("INVALID_NAME");
  if (!/^[a-z0-9][a-z0-9-]{1,127}$/.test(input.slug)) throw new Error("INVALID_SLUG");
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(input.sku)) throw new Error("INVALID_SKU");
  if (input.priceVnd < 0n) throw new Error("INVALID_PRICE");
  if ((input.description ?? "").length > 2_000) throw new Error("INVALID_DESCRIPTION");
  if (!input.reason.trim() || input.reason.length > 500) throw new Error("INVALID_REASON");
}

async function authorize(input: AdminProductInput): Promise<void> {
  const gate = await guardRootAction(input.db, {
    actor: input.actor,
    config: input.config,
    correlationId: input.correlationId,
    action: "product.create",
    targetType: "Product",
    targetId: input.sku,
  });
  if (!gate.ok) throw new Error(gate.reason);
}

export async function createAdminProduct(input: AdminProductInput): Promise<AdminProductSummary> {
  validate(input);
  await authorize(input);
  return withTransaction(input.db, async (trx) => {
    const productId = newId();
    const variantId = newId();
    const product = await sql<{
      id: string;
    }>`insert into product (id, category_id, name_vi, slug, short_description_vi) values (${productId}, ${input.categoryId}, ${input.name.trim()}, ${input.slug}, ${input.description ?? null}) returning id`.execute(
      trx,
    );
    if (!product.rows[0]) throw new Error("CATEGORY_NOT_FOUND");
    await sql`insert into product_variant (id, product_id, sku, name_vi, price_vnd, duration_code, delivery_type, stock_policy) values (${variantId}, ${productId}, ${input.sku}, ${input.name.trim()}, ${input.priceVnd.toString()}, 'CUSTOM', 'CREDENTIAL', 'LOCAL_ONLY')`.execute(
      trx,
    );
    await appendAuditEvent(trx, {
      actorType: "ROOT_ADMIN",
      actorId: String(input.actor.numericUserId),
      action: "product.created",
      targetType: "Product",
      targetId: productId,
      reason: input.reason.trim(),
      correlationId: input.correlationId,
      metadataRedacted: { sku: input.sku, priceVnd: input.priceVnd.toString() },
    });
    return {
      id: productId,
      variantId,
      name: input.name.trim(),
      sku: input.sku,
      priceVnd: input.priceVnd,
      active: true,
    };
  });
}

export async function updateAdminVariantPrice(
  db: Db,
  actor: RootActor,
  config: RootAdminConfig,
  variantId: string,
  priceVnd: bigint,
  reason: string,
  correlationId: string,
): Promise<boolean> {
  if (priceVnd < 0n || !reason.trim() || reason.length > 500) throw new Error("INVALID_INPUT");
  const gate = await guardRootAction(db, {
    actor,
    config,
    correlationId,
    action: "product.price_changed",
    targetType: "ProductVariant",
    targetId: variantId,
  });
  if (!gate.ok) throw new Error(gate.reason);
  return withTransaction(db, async (trx) => {
    const result = await sql<{
      id: string;
    }>`update product_variant set price_vnd = ${priceVnd.toString()}, updated_at = now(), version = version + 1 where id = ${variantId} returning id`.execute(
      trx,
    );
    if (!result.rows[0]) return false;
    await appendAuditEvent(trx, {
      actorType: "ROOT_ADMIN",
      actorId: String(actor.numericUserId),
      action: "product.price_changed",
      targetType: "ProductVariant",
      targetId: variantId,
      reason: reason.trim(),
      correlationId,
      metadataRedacted: { priceVnd: priceVnd.toString() },
    });
    return true;
  });
}
