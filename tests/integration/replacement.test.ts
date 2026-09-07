import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { newId } from "../../src/shared/ids/index.js";
import { createInMemoryVault } from "../../src/infrastructure/vault/testing-adapter.js";
import {
  approveReplacementCase,
  openReplacementCase,
} from "../../src/modules/digital-goods/replacement.js";
import { revealDeliveryBundle } from "../../src/modules/digital-goods/delivery.js";
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

  it("reuses one nonterminal case for concurrent duplicate opens on the same original asset", async () => {
    const f = await seedCompletedOrder();

    const opened = await Promise.all(
      Array.from({ length: 8 }, (_, n) =>
        openReplacementCase(ctx.db, {
          orderId: f.orderId,
          customerId: f.customerId,
          reasonCode: "INVALID_CREDENTIAL",
          correlationId: `rep-race-${n}`,
        }),
      ),
    );

    expect(opened.every((result) => result.ok)).toBe(true);
    const caseIds = new Set(opened.map((result) => (result.ok ? result.caseId : "")));
    expect(caseIds.size).toBe(1);

    const rows = await sql<{ count: string }>`
      select count(*)::text as count
      from replacement_case
      where order_id = ${f.orderId} and original_asset_id = ${f.assetId}
    `.execute(ctx.db);
    expect(rows.rows[0]?.count).toBe("1");
  });

  it("escalates a duplicate open on the same case to refund review", async () => {
    const f = await seedCompletedOrder();
    const replacement = await openReplacementCase(ctx.db, {
      orderId: f.orderId,
      customerId: f.customerId,
      reasonCode: "INVALID_CREDENTIAL",
      correlationId: "rep-before-refund",
    });
    expect(replacement.ok).toBe(true);
    if (!replacement.ok) return;

    const refund = await openReplacementCase(ctx.db, {
      orderId: f.orderId,
      customerId: f.customerId,
      reasonCode: "CUSTOMER_REQUEST",
      requestRefund: true,
      correlationId: "rep-duplicate-refund",
    });
    expect(refund).toMatchObject({
      ok: true,
      caseId: replacement.caseId,
      status: "REFUND_REQUESTED",
    });

    const proof = await sql<{ case_count: string; order_status: string; transitions: string }>`
      select
        (select count(*)::text from replacement_case where order_id = ${f.orderId}) as case_count,
        (select status from "order" where id = ${f.orderId}) as order_status,
        (select count(*)::text from order_transition where order_id = ${f.orderId} and to_status = 'REFUND_PENDING') as transitions
    `.execute(ctx.db);
    expect(proof.rows[0]).toMatchObject({
      case_count: "1",
      order_status: "REFUND_PENDING",
      transitions: "1",
    });
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
    expect(fulfilled.kind).toBe("DELIVERY_BUNDLE");
    if (fulfilled.kind !== "DELIVERY_BUNDLE")
      throw new Error(`expected delivery bundle, got ${fulfilled.kind}`);
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
      if (!fulfilled.ok) return;
      expect(fulfilled.kind).toBe("DELIVERY_BUNDLE");
      if (fulfilled.kind !== "DELIVERY_BUNDLE")
        throw new Error(`expected delivery bundle, got ${fulfilled.kind}`);
      expect(fulfilled.assetId).toBe(activeReplacementId);
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

  it("approves a replacement by reserving new stock and issuing a delivery bundle idempotently", async () => {
    const f = await seedCompletedOrder();
    const vault = createInMemoryVault();
    const replacementAssetId = newId();
    const replacementSecret = "REPLACEMENT-" + newId().slice(-6);
    const replacementVaultRef = await vault.write(replacementSecret);
    const oldBundleId = newId();
    await sql`
      insert into delivery_bundle (id, order_id, customer_id, asset_id, token_hash, status, expires_at)
      values (${oldBundleId}, ${f.orderId}, ${f.customerId}, ${f.assetId}, ${"old-token-" + oldBundleId}, 'AVAILABLE', now() + interval '15 minutes')
    `.execute(ctx.db);
    await sql`
      insert into digital_asset
        (id, variant_id, source_type, vault_ref, fingerprint_hash, status)
      values
        (${replacementAssetId}, ${f.variantId}, 'LOCAL', ${replacementVaultRef},
         ${"fp-" + replacementAssetId}, 'AVAILABLE')
    `.execute(ctx.db);
    const opened = await openReplacementCase(ctx.db, {
      orderId: f.orderId,
      customerId: f.customerId,
      reasonCode: "INVALID_CREDENTIAL",
      correlationId: "approve-open",
    });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;

    const approved = await approveReplacementCase(ctx.db, {
      caseId: opened.caseId,
      approvedBy: "root-admin",
      correlationId: "approve-replacement",
      deliveryBaseUrl: "https://delivery.example.test",
      bundleTtlSeconds: 900,
    });
    expect(approved).toMatchObject({ ok: true, replacementAssetId, reused: false });
    if (!approved.ok) return;

    const rows = await sql<{
      case_status: string;
      replacement_asset_id: string | null;
      original_status: string;
      replacement_status: string;
      bundle_asset_id: string;
      old_bundle_status: string;
    }>`
      select rc.status as case_status, rc.replacement_asset_id,
             old_asset.status as original_status,
             new_asset.status as replacement_status,
             db.asset_id as bundle_asset_id,
             old_bundle.status as old_bundle_status
      from replacement_case rc
      join digital_asset old_asset on old_asset.id = rc.original_asset_id
      join digital_asset new_asset on new_asset.id = rc.replacement_asset_id
      join delivery_bundle db on db.id = ${approved.bundleId}
      join delivery_bundle old_bundle on old_bundle.id = ${oldBundleId}
      where rc.id = ${opened.caseId}
    `.execute(ctx.db);
    expect(rows.rows[0]).toMatchObject({
      case_status: "REPLACED",
      replacement_asset_id: replacementAssetId,
      original_status: "DELIVERED",
      replacement_status: "RESERVED",
      bundle_asset_id: replacementAssetId,
      old_bundle_status: "REVOKED",
    });

    const replay = await approveReplacementCase(ctx.db, {
      caseId: opened.caseId,
      approvedBy: "root-admin",
      correlationId: "approve-replacement-replay",
      deliveryBaseUrl: "https://delivery.example.test",
      bundleTtlSeconds: 900,
    });
    expect(replay).toMatchObject({
      ok: true,
      replacementAssetId,
      bundleId: approved.bundleId,
      reused: true,
    });

    const revealed = await revealDeliveryBundle(ctx.db, {
      token: approved.token,
      customerId: f.customerId,
      correlationId: "approve-replacement-reveal",
      vault,
    });
    expect(revealed).toMatchObject({ ok: true, secret: replacementSecret });
    await expect(
      revealDeliveryBundle(ctx.db, {
        token: approved.token,
        customerId: f.customerId,
        correlationId: "approve-replacement-reveal-replay",
        vault,
      }),
    ).resolves.toMatchObject({ ok: false, code: "UNAVAILABLE" });
  });

  it("does not allocate a second asset when approving legacy duplicate cases for one original asset", async () => {
    const f = await seedCompletedOrder();
    const vault = createInMemoryVault();
    const firstCaseId = newId();
    const secondCaseId = newId();
    const firstReplacementAssetId = newId();
    const secondReplacementAssetId = newId();
    const firstVaultRef = await vault.write("FIRST-REPLACEMENT-" + newId().slice(-6));
    const secondVaultRef = await vault.write("SECOND-REPLACEMENT-" + newId().slice(-6));
    await sql`
      insert into replacement_case (id, order_id, original_asset_id, reason_code, status)
      values
        (${firstCaseId}, ${f.orderId}, ${f.assetId}, 'INVALID_CREDENTIAL', 'OPEN'),
        (${secondCaseId}, ${f.orderId}, ${f.assetId}, 'INVALID_CREDENTIAL', 'OPEN')
    `.execute(ctx.db);
    await sql`
      insert into digital_asset
        (id, variant_id, source_type, vault_ref, fingerprint_hash, status, created_at)
      values
        (${firstReplacementAssetId}, ${f.variantId}, 'LOCAL', ${firstVaultRef}, ${"fp-" + firstReplacementAssetId}, 'AVAILABLE', '2026-01-01T00:00:00Z'),
        (${secondReplacementAssetId}, ${f.variantId}, 'LOCAL', ${secondVaultRef}, ${"fp-" + secondReplacementAssetId}, 'AVAILABLE', '2026-01-02T00:00:00Z')
    `.execute(ctx.db);

    const [first, second] = await Promise.all([
      approveReplacementCase(ctx.db, {
        caseId: firstCaseId,
        approvedBy: "root-admin",
        correlationId: "approve-legacy-duplicate-first",
        deliveryBaseUrl: "https://delivery.example.test",
        bundleTtlSeconds: 900,
      }),
      approveReplacementCase(ctx.db, {
        caseId: secondCaseId,
        approvedBy: "root-admin",
        correlationId: "approve-legacy-duplicate-second",
        deliveryBaseUrl: "https://delivery.example.test",
        bundleTtlSeconds: 900,
      }),
    ]);
    expect(first).toMatchObject({ ok: true, replacementAssetId: firstReplacementAssetId });
    expect(second).toMatchObject({ ok: true, replacementAssetId: firstReplacementAssetId });
    if (!first.ok || !second.ok) return;
    expect(new Set([first.bundleId, second.bundleId]).size).toBe(1);
    expect([first.reused, second.reused].filter(Boolean)).toHaveLength(1);

    const proof = await sql<{
      distinct_replacements: string;
      reserved_replacements: string;
      untouched_second: string;
    }>`
      select
        count(distinct replacement_asset_id)::text as distinct_replacements,
        (select count(*)::text from digital_asset where id in (${firstReplacementAssetId}, ${secondReplacementAssetId}) and status = 'RESERVED') as reserved_replacements,
        (select status from digital_asset where id = ${secondReplacementAssetId}) as untouched_second
      from replacement_case
      where id in (${firstCaseId}, ${secondCaseId})
    `.execute(ctx.db);
    expect(proof.rows[0]).toMatchObject({
      distinct_replacements: "1",
      reserved_replacements: "1",
      untouched_second: "AVAILABLE",
    });
  });
  it("does not fake approval when replacement stock is unavailable", async () => {
    const f = await seedCompletedOrder();
    const opened = await openReplacementCase(ctx.db, {
      orderId: f.orderId,
      customerId: f.customerId,
      reasonCode: "INVALID_CREDENTIAL",
      correlationId: "approve-open-no-stock",
    });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;

    const approved = await approveReplacementCase(ctx.db, {
      caseId: opened.caseId,
      approvedBy: "root-admin",
      correlationId: "approve-no-stock",
      deliveryBaseUrl: "https://delivery.example.test",
      bundleTtlSeconds: 900,
    });
    expect(approved).toMatchObject({ ok: false, code: "OUT_OF_STOCK" });
    const row = await sql<{ status: string; replacement_asset_id: string | null }>`
      select status, replacement_asset_id from replacement_case where id = ${opened.caseId}
    `.execute(ctx.db);
    expect(row.rows[0]).toMatchObject({ status: "OPEN", replacement_asset_id: null });
  });
});
