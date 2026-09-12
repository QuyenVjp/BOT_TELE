import { createHash } from "node:crypto";
import { sql } from "kysely";
import type { Db } from "../../infrastructure/db/transaction.js";
import { hashAuthorizationPayload, type AuthorizationJsonValue } from "./authorization-payload.js";

export interface SensitiveBindingRequest {
  actionKey: string;
  resourceType: string;
  resourceId: string;
  requestedData?: AuthorizationJsonValue;
}

export interface SensitiveAuthorizationBinding {
  resourceVersion: string;
  payloadHash: string;
}

function requestedString(data: AuthorizationJsonValue | undefined, key: string): string | null {
  if (typeof data !== "object" || data === null || Array.isArray(data)) return null;
  const value = data[key];
  return typeof value === "string" ? value : null;
}

/** Re-read the authoritative state immediately before preview/consume. */
export async function loadSensitiveAuthorizationBinding(
  db: Db,
  input: SensitiveBindingRequest,
): Promise<SensitiveAuthorizationBinding> {
  let resourceVersion = "missing";
  let current: AuthorizationJsonValue = null;
  const requested = input.requestedData ?? null;

  if (
    input.actionKey === "catalog.variant.price.change" ||
    input.actionKey === "catalog.variant.deposit.change" ||
    input.actionKey === "catalog.variant.commercial.change" ||
    input.actionKey === "catalog.activate" ||
    input.actionKey === "catalog.deactivate"
  ) {
    const row = await sql<{
      version: string;
      price_vnd: string;
      compare_at_price_vnd: string | null;
      deposit_amount_vnd: string;
      preorder_enabled: boolean;
      is_active: boolean;
    }>`
      select version::text, price_vnd::text, compare_at_price_vnd::text,
             deposit_amount_vnd::text, preorder_enabled, is_active
      from product_variant where id = ${input.resourceId} limit 1
    `.execute(db);
    const value = row.rows[0];
    resourceVersion = value?.version ?? "missing";
    current = value
      ? {
          version: value.version,
          priceVnd: value.price_vnd,
          compareAtPriceVnd: value.compare_at_price_vnd,
          depositAmountVnd: value.deposit_amount_vnd,
          preorderEnabled: value.preorder_enabled,
          active: value.is_active,
        }
      : null;
  } else if (input.actionKey === "inventory.stock.adjust") {
    const row = await sql<{ version: string; available_quantity: number }>`
      select version::text, available_quantity::int
      from variant_quantity_stock where variant_id = ${input.resourceId} limit 1
    `.execute(db);
    const value = row.rows[0];
    resourceVersion = value?.version ?? "missing";
    current = value
      ? { version: value.version, availableQuantity: value.available_quantity }
      : null;
  } else if (input.actionKey.startsWith("supplier.mapping.")) {
    const variantId = requestedString(requested, "variantId");
    const candidateBinding =
      input.actionKey === "supplier.mapping.select" ||
      input.actionKey === "supplier.mapping.verify";
    const row = await sql<{
      variant_version: string;
      variant_supplier_sku_id: string | null;
      candidate_version: string | null;
      candidate_supplier_id: string | null;
      candidate_active: boolean | null;
      supplier_status: string | null;
    }>`
      select v.version::text as variant_version, v.supplier_sku_id as variant_supplier_sku_id,
             ss.version::text as candidate_version, ss.supplier_id as candidate_supplier_id,
             ss.is_active as candidate_active, s.status as supplier_status
      from product_variant v
      left join supplier_sku ss on ss.id = case when ${candidateBinding} then ${input.resourceId} else v.supplier_sku_id end
      left join supplier s on s.id = ss.supplier_id
      where v.id = ${variantId ?? input.resourceId}
      limit 1
    `.execute(db);
    const value = row.rows[0];
    resourceVersion = value?.variant_version ?? value?.candidate_version ?? "missing";
    current = value
      ? {
          variantVersion: value.variant_version,
          currentSupplierSkuId: value.variant_supplier_sku_id,
          candidateVersion: value.candidate_version,
          candidateSupplierId: value.candidate_supplier_id,
          candidateActive: value.candidate_active,
          supplierStatus: value.supplier_status,
        }
      : null;
  } else if (input.actionKey === "preorder.cancel") {
    const row = await sql<{
      version: string;
      status: string;
      deposit_amount_vnd: string;
      balance_amount_vnd: string;
      total_price_vnd: string;
      deposit_paid_at: string | null;
      allocated_asset_id: string | null;
      refund_amount_vnd: string | null;
      refund_status: string | null;
    }>`
      select p.version::text, p.status, p.deposit_amount_vnd::text,
             p.balance_amount_vnd::text, p.total_price_vnd::text,
             p.deposit_paid_at::text, p.allocated_asset_id,
             r.amount_vnd::text as refund_amount_vnd, r.status as refund_status
      from preorder_reservation p
      left join shop_refund_obligation r on r.preorder_id = p.id
      where p.id = ${input.resourceId}
      limit 1
    `.execute(db);
    const value = row.rows[0];
    resourceVersion = value?.version ?? "missing";
    current = value
      ? {
          version: value.version,
          status: value.status,
          depositAmountVnd: value.deposit_amount_vnd,
          balanceAmountVnd: value.balance_amount_vnd,
          totalPriceVnd: value.total_price_vnd,
          depositPaidAt: value.deposit_paid_at,
          allocatedAssetId: value.allocated_asset_id,
          refundAmountVnd: value.refund_amount_vnd,
          refundStatus: value.refund_status,
        }
      : null;
  } else if (input.actionKey === "wallet.refund") {
    const row = await sql<{
      version: string;
      status: string;
      customer_id: string;
      refund_amount_vnd: string | null;
    }>`
      select o.version::text, o.status, o.customer_id,
             (select amount_vnd::text from wallet_ledger
              where wallet_account_id = (select id from wallet_account where customer_id = o.customer_id)
                and entry_type = 'DEBIT' and idempotency_key like ${`purchase:${input.resourceId}:%`}
              order by created_at asc, id asc limit 1) as refund_amount_vnd
      from "order" o where o.id = ${input.resourceId} limit 1
    `.execute(db);
    const value = row.rows[0];
    resourceVersion = value?.version ?? "missing";
    current = value
      ? {
          version: value.version,
          status: value.status,
          customerId: value.customer_id,
          refundAmountVnd: value.refund_amount_vnd,
        }
      : null;
  } else if (input.actionKey === "broadcast.confirm") {
    const row = await sql<{
      revision: number;
      status: string;
      audience: string;
      class: string;
      created_by: string;
      content: string;
      previewed_content_hash: string | null;
      previewed_audience_hash: string | null;
    }>`
      select revision, status, audience, class, created_by, content,
             previewed_content_hash, previewed_audience_hash
      from notification_campaign where id = ${input.resourceId} limit 1
    `.execute(db);
    const value = row.rows[0];
    resourceVersion = value ? String(value.revision) : "missing";
    current = value
      ? {
          revision: value.revision,
          status: value.status,
          audience: value.audience,
          class: value.class,
          createdBy: value.created_by,
          contentHash: createHash("sha256").update(value.content, "utf8").digest("hex"),
          previewedContentHash: value.previewed_content_hash,
          previewedAudienceHash: value.previewed_audience_hash,
        }
      : null;
  } else if (
    input.actionKey === "warranty.refund.approve" ||
    input.actionKey === "warranty.refund.adjust" ||
    input.actionKey === "warranty.replacement.approve"
  ) {
    const row = await sql<{
      version: string;
      status: string;
      calculated_refund_vnd: string;
      approved_refund_vnd: string | null;
      policy_version: number | null;
    }>`
      select version::text, status, calculated_refund_vnd::text,
             approved_refund_vnd::text, policy_version
      from warranty_claim where id = ${input.resourceId} limit 1
    `.execute(db);
    const value = row.rows[0];
    resourceVersion = value?.version ?? "missing";
    current = value
      ? {
          version: value.version,
          status: value.status,
          calculatedRefundVnd: value.calculated_refund_vnd,
          approvedRefundVnd: value.approved_refund_vnd,
          policyVersion: value.policy_version,
        }
      : null;
  } else if (input.resourceType === "StoreControl") {
    const row = await sql<{ status: string; updated_at: string }>`
      select status, updated_at::text from store_control where id = ${input.resourceId} limit 1
    `.execute(db);
    const value = row.rows[0];
    resourceVersion = value?.updated_at ?? "missing";
    current = value ? { status: value.status, updatedAt: value.updated_at } : null;
  } else {
    current = { resourceType: input.resourceType, resourceId: input.resourceId };
  }

  const payloadHash = hashAuthorizationPayload({
    actionKey: input.actionKey,
    resourceType: input.resourceType,
    resourceId: input.resourceId,
    resourceVersion,
    data: { current, requested },
  });
  return { resourceVersion, payloadHash };
}
