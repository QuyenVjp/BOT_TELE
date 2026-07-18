import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { newId } from "../../src/shared/ids/index.js";
import { createInMemoryVault } from "../../src/infrastructure/vault/testing-adapter.js";
import { openReplacementCase } from "../../src/modules/digital-goods/replacement.js";
import { fulfillPaidOrder } from "../../src/modules/digital-goods/fulfillment.js";
import { startPostgresContainer, type PgTestContext } from "../helpers/pg-container.js";

/**
 * T078 — Replacement / refund-request workflow (FR-020).
 *
 * Opening a case preserves the original asset and Order history. A refund
 * request moves the Order to REFUND_PENDING; a pure replacement stays on the
 * current status. Ownership and warranty are enforced.
 */

let ctx: PgTestContext;

beforeAll(async () => {
  ctx = await startPostgresContainer();
}, 180_000);

afterAll(async () => {
  await ctx?.teardown();
});

interface Fixture {
  orderId: string;
  customerId: string;
  assetId: string;
  variantId: string;
}

async function seedCompletedOrder(opts?: { warrantyDays?: number }): Promise<Fixture> {
  const categoryId = newId();
  const productId = newId();
  const variantId = newId();
  const customerId = newId();
  const orderId = newId();
  const assetId = newId();
  const vault = createInMemoryVault();
  const vaultRef = await vault.write("SECRET-" + newId().slice(-4));
  const slug = categoryId.slice(-8);
  const warrantyDays = opts?.warrantyDays ?? 7;

  await sql`insert into category (id, name_vi, slug, is_active, sort_order) values (${categoryId}, 'C', ${slug}, true, 1)`.execute(
    ctx.db,
  );
  await sql`insert into product (id, category_id, name_vi, slug, is_active, sort_order) values (${productId}, ${categoryId}, 'P', ${slug}, true, 1)`.execute(
    ctx.db,
  );
  await sql`
    insert into product_variant (id, product_id, sku, name_vi, price_vnd, duration_code, delivery_type, stock_policy, resale_evidence_id, warranty_days)
    values (${variantId}, ${productId}, ${"SKU-" + variantId}, 'V', 100000, 'P1M', 'CREDENTIAL', 'LOCAL_ONLY', 'RES-1', ${warrantyDays})
  `.execute(ctx.db);
  await sql`insert into customer (id, status, locale) values (${customerId}, 'ACTIVE', 'vi')`.execute(
    ctx.db,
  );
  await sql`
    insert into "order" (id, order_number, customer_id, variant_id, product_name_vi, variant_name_vi,
      price_vnd, duration_code, delivery_type, warranty_days, status, paid_at)
    values (${orderId}, ${"ORD-" + orderId}, ${customerId}, ${variantId}, 'P', 'V',
      100000, 'P1M', 'CREDENTIAL', ${warrantyDays}, 'COMPLETED', now())
  `.execute(ctx.db);
  await sql`
    insert into digital_asset
      (id, variant_id, source_type, vault_ref, fingerprint_hash, status, reserved_order_id, delivered_order_id)
    values
      (${assetId}, ${variantId}, 'LOCAL', ${vaultRef}, ${"fp-" + newId()}, 'DELIVERED', ${orderId}, ${orderId})
  `.execute(ctx.db);

  return { orderId, customerId, assetId, variantId };
}

beforeEach(async () => {
  await sql`
    truncate table replacement_case, delivery_bundle, digital_asset, order_transition, "order",
      product_variant, product, category, customer, outbox_event cascade
  `.execute(ctx.db);
});

describe("replacement / refund-request (T078 / FR-020)", () => {
  it("opens a replacement case without rewriting the original asset", async () => {
    const f = await seedCompletedOrder();
    const res = await openReplacementCase(ctx.db, {
      orderId: f.orderId,
      customerId: f.customerId,
      reasonCode: "INVALID_CREDENTIAL",
      correlationId: "rep-1",
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.status).toBe("OPEN");

    const row = await sql<{
      original_asset_id: string;
      replacement_asset_id: string | null;
      status: string;
    }>`
      select original_asset_id, replacement_asset_id, status from replacement_case where id = ${res.caseId}
    `.execute(ctx.db);
    expect(row.rows[0]?.original_asset_id).toBe(f.assetId);
    expect(row.rows[0]?.replacement_asset_id).toBeNull();
    expect(row.rows[0]?.status).toBe("OPEN");

    // Original asset is untouched.
    const asset = await sql<{
      status: string;
    }>`select status from digital_asset where id = ${f.assetId}`.execute(ctx.db);
    expect(asset.rows[0]?.status).toBe("DELIVERED");
  });

  it("fulfillment re-entry selects a newer active hold, never the old delivered credential", async () => {
    const f = await seedCompletedOrder();
    const replacementAssetId = newId();
    await sql`
      insert into digital_asset
        (id, variant_id, source_type, vault_ref, fingerprint_hash, status, reserved_order_id,
         reserved_until)
      values
        (${replacementAssetId}, ${f.variantId}, 'LOCAL', ${"vault:" + replacementAssetId},
         ${"fp-" + replacementAssetId}, 'RESERVED', ${f.orderId}, now() + interval '15 minutes')
    `.execute(ctx.db);

    const fulfilled = await fulfillPaidOrder(ctx.db, {
      orderId: f.orderId,
      correlationId: "replacement-reentry",
      deps: {
        vault: createInMemoryVault(),
        supplier: null,
        deliveryBaseUrl: "https://delivery.example.test",
        bundleTtlSeconds: 900,
      },
    });
    expect(fulfilled.ok).toBe(true);
    if (!fulfilled.ok) return;
    expect(fulfilled.assetId).toBe(replacementAssetId);

    const bundle = await sql<{ asset_id: string }>`
      select asset_id from delivery_bundle where id = ${fulfilled.bundleId}
    `.execute(ctx.db);
    expect(bundle.rows[0]?.asset_id).toBe(replacementAssetId);
    const original = await sql<{ status: string }>`
      select status from digital_asset where id = ${f.assetId}
    `.execute(ctx.db);
    expect(original.rows[0]?.status).toBe("DELIVERED");
  });

  it("replacement links the deterministic original DELIVERED asset regardless of row order", async () => {
    const f = await seedCompletedOrder();
    const activeReplacementId = newId();

    // Reinsert active first and delivered history second so an unordered
    // RESERVED|READY|DELIVERED query chooses the wrong row on PostgreSQL.
    await sql`delete from digital_asset where id = ${f.assetId}`.execute(ctx.db);
    await sql`
      insert into digital_asset
        (id, variant_id, source_type, vault_ref, fingerprint_hash, status, reserved_order_id,
         reserved_until, created_at, updated_at)
      values
        (${activeReplacementId}, ${f.variantId}, 'LOCAL', ${"vault:" + activeReplacementId},
         ${"fp-" + activeReplacementId}, 'RESERVED', ${f.orderId}, now() + interval '15 minutes',
         '2026-02-01T00:00:00Z', '2026-02-01T00:00:00Z')
    `.execute(ctx.db);
    await sql`
      insert into digital_asset
        (id, variant_id, source_type, vault_ref, fingerprint_hash, status, reserved_order_id,
         delivered_order_id, created_at, updated_at)
      values
        (${f.assetId}, ${f.variantId}, 'LOCAL', ${"vault:" + f.assetId}, ${"fp-" + f.assetId},
         'DELIVERED', ${f.orderId}, ${f.orderId}, '2026-01-01T00:00:00Z',
         '2026-01-01T00:00:00Z')
    `.execute(ctx.db);

    const result = await openReplacementCase(ctx.db, {
      orderId: f.orderId,
      customerId: f.customerId,
      reasonCode: "INVALID_CREDENTIAL",
      correlationId: "replacement-original-history",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const replacementCase = await sql<{ original_asset_id: string }>`
      select original_asset_id from replacement_case where id = ${result.caseId}
    `.execute(ctx.db);
    expect(replacementCase.rows[0]?.original_asset_id).toBe(f.assetId);
    expect(replacementCase.rows[0]?.original_asset_id).not.toBe(activeReplacementId);
  });

  it.each(["COMPROMISED", "REVOKED"] as const)(
    "keeps a %s delivered credential in replacement history while fulfillment uses the active hold",
    async (historicalStatus) => {
      const f = await seedCompletedOrder();
      const activeReplacementId = newId();
      await sql`
        update digital_asset
        set status = ${historicalStatus}, updated_at = '2026-01-01T00:00:00Z'
        where id = ${f.assetId}
      `.execute(ctx.db);
      await sql`
        insert into digital_asset
          (id, variant_id, source_type, vault_ref, fingerprint_hash, status, reserved_order_id,
           reserved_until, created_at, updated_at)
        values
          (${activeReplacementId}, ${f.variantId}, 'LOCAL', ${"vault:" + activeReplacementId},
           ${"fp-" + activeReplacementId}, 'RESERVED', ${f.orderId}, now() + interval '15 minutes',
           '2026-02-01T00:00:00Z', '2026-02-01T00:00:00Z')
      `.execute(ctx.db);

      const replacement = await openReplacementCase(ctx.db, {
        orderId: f.orderId,
        customerId: f.customerId,
        reasonCode: "COMPROMISED",
        correlationId: `replacement-${historicalStatus.toLowerCase()}`,
      });
      expect(replacement.ok).toBe(true);
      if (!replacement.ok) return;

      const replacementCase = await sql<{ original_asset_id: string }>`
        select original_asset_id from replacement_case where id = ${replacement.caseId}
      `.execute(ctx.db);
      expect(replacementCase.rows[0]?.original_asset_id).toBe(f.assetId);

      const fulfilled = await fulfillPaidOrder(ctx.db, {
        orderId: f.orderId,
        correlationId: `fulfillment-${historicalStatus.toLowerCase()}`,
        deps: {
          vault: createInMemoryVault(),
          supplier: null,
          deliveryBaseUrl: "https://delivery.example.test",
          bundleTtlSeconds: 900,
        },
      });
      expect(fulfilled.ok).toBe(true);
      if (fulfilled.ok) expect(fulfilled.assetId).toBe(activeReplacementId);
    },
  );

  it("a refund request moves the order to REFUND_PENDING and preserves history", async () => {
    const f = await seedCompletedOrder();
    const res = await openReplacementCase(ctx.db, {
      orderId: f.orderId,
      customerId: f.customerId,
      reasonCode: "CUSTOMER_REQUEST",
      requestRefund: true,
      correlationId: "rep-refund",
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.status).toBe("REFUND_REQUESTED");

    const order = await sql<{
      status: string;
    }>`select status from "order" where id = ${f.orderId}`.execute(ctx.db);
    expect(order.rows[0]?.status).toBe("REFUND_PENDING");

    // Transition audit recorded.
    const transitions = await sql<{ count: string }>`
      select count(*)::text as count from order_transition
      where order_id = ${f.orderId} and to_status = 'REFUND_PENDING'
    `.execute(ctx.db);
    expect(Number(transitions.rows[0]?.count)).toBe(1);
  });

  it("refuses a non-owner and a past-warranty customer request", async () => {
    const f = await seedCompletedOrder({ warrantyDays: 1 });
    const other = await openReplacementCase(ctx.db, {
      orderId: f.orderId,
      customerId: newId(),
      reasonCode: "CUSTOMER_REQUEST",
      correlationId: "rep-x",
    });
    expect(other.ok).toBe(false);
    if (!other.ok) expect(other.code).toBe("ORDER_NOT_OWNED");

    // Force paid_at far in the past.
    await sql`update "order" set paid_at = now() - interval '30 days' where id = ${f.orderId}`.execute(
      ctx.db,
    );
    const late = await openReplacementCase(ctx.db, {
      orderId: f.orderId,
      customerId: f.customerId,
      reasonCode: "CUSTOMER_REQUEST",
      correlationId: "rep-late",
      now: new Date(),
    });
    expect(late.ok).toBe(false);
    if (!late.ok) expect(late.code).toBe("WARRANTY_EXPIRED");
  });
});
