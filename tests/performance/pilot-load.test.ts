import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { newId } from "../../src/shared/ids/index.js";
import { listSellableVariants, getVariantById } from "../../src/modules/catalog/repository.js";
import { buyNow } from "../../src/modules/commerce/buy-now.js";
import {
  applyPaymentEvidence,
  presentPaymentForOrder,
} from "../../src/modules/payments/service.js";
import { fulfillPaidOrder } from "../../src/modules/digital-goods/fulfillment.js";
import { createInMemoryVault } from "../../src/infrastructure/vault/testing-adapter.js";
import { startPostgresContainer, type PgTestContext } from "../helpers/pg-container.js";
import { verifiedSePayEvidence } from "../helpers/verified-sepay.js";

/**
 * T104 — Pilot-load performance (SC-003, SC-004).
 *
 * SC-003: ≥95% of catalog/menu interactions respond within 1s under pilot load.
 * SC-004: ≥95% of verified paid Orders reach a usable Delivery Bundle within 60s
 *         when dependencies are healthy.
 *
 * This is a smoke-scale load harness against a real PostgreSQL container: it
 * measures p95 latency of catalog reads over many iterations and the
 * paid-to-delivery latency across a batch of orders. It is not a full
 * production load test (that needs provisioned infra), but it proves the code
 * paths meet the percentile targets at the pilot's per-request budget.
 */

let ctx: PgTestContext;

const CATALOG_ITERATIONS = 200;
const FULFILL_BATCH = 20;
const MERCHANT_ACCOUNT = "0123456789";
const BENEFICIARY_ACCOUNT = "9876543210";
const BANK_BIN = "970422";
const ACCOUNT_NAME = "SHOP DIGITAL MVP";

beforeAll(async () => {
  ctx = await startPostgresContainer();
}, 180_000);

afterAll(async () => {
  await ctx?.teardown();
});

function percentile(sortedMs: number[], p: number): number {
  if (sortedMs.length === 0) return 0;
  const idx = Math.min(sortedMs.length - 1, Math.floor((p / 100) * sortedMs.length));
  return sortedMs[idx] ?? 0;
}

async function seedCatalog(
  variants: number,
): Promise<{ categoryId: string; variantIds: string[] }> {
  const categoryId = newId();
  const productId = newId();
  const slug = categoryId.slice(-8);
  await sql`insert into customer (id, status, locale) values (${newId()}, 'ACTIVE', 'vi')`.execute(
    ctx.db,
  );
  await sql`insert into category (id, name_vi, slug, is_active, sort_order) values (${categoryId}, 'Giải trí', ${slug}, true, 1)`.execute(
    ctx.db,
  );
  await sql`insert into product (id, category_id, name_vi, slug, is_active, sort_order) values (${productId}, ${categoryId}, 'Netflix', ${"nf-" + slug}, true, 1)`.execute(
    ctx.db,
  );
  const variantIds: string[] = [];
  for (let i = 0; i < variants; i++) {
    const variantId = newId();
    variantIds.push(variantId);
    const evidenceId = "RES-" + i;
    await sql`
      insert into product_variant (id, product_id, sku, name_vi, price_vnd, duration_code, delivery_type, stock_policy, resale_evidence_id, sort_order)
      values (${variantId}, ${productId}, ${"SKU-" + variantId}, ${"Gói " + i}, ${100000 + i * 1000}, 'P1M', 'CREDENTIAL', 'LOCAL_ONLY', ${evidenceId}, ${i})
    `.execute(ctx.db);
    // Test-only resale evidence + version-bound publication snapshot (fresh fixture versions).
    await sql`
      insert into resale_evidence (id, variant_id, source, reference, summary, created_by)
      values (${evidenceId}, ${variantId}, 'OWNER_ATTESTATION', ${"TEST-REF-" + evidenceId}, 'fixture publication evidence', 'test')
    `.execute(ctx.db);
    await sql`
      update product_variant
         set publication_evidence_id = ${evidenceId},
             publication_product_version = 1,
             publication_variant_version = 1,
             published_at = now(),
             published_by = 'test'
       where id = ${variantId}
    `.execute(ctx.db);
    // CREDENTIAL resolves to STOCK_ACCOUNT: one available asset keeps the route sellable.
    const assetId = newId();
    await sql`
      insert into digital_asset (id, variant_id, source_type, vault_ref, fingerprint_hash, status)
      values (${assetId}, ${variantId}, 'TEST_FIXTURE', ${"test-vault-ref-" + assetId}, ${"test-fp-" + assetId}, 'AVAILABLE')
    `.execute(ctx.db);
  }
  return { categoryId, variantIds };
}

beforeEach(async () => {
  await sql`
    truncate table delivery_bundle, digital_asset, payment_allocation, discrepancy,
      bank_transaction, payment_intent, order_transition, outbox_event, "order",
      product_variant, product, category, customer cascade
  `.execute(ctx.db);
});

describe("pilot-load performance (SC-003 / SC-004)", () => {
  it("catalog reads meet the SC-003 p95 < 1s budget under repeated load", async () => {
    const { categoryId, variantIds } = await seedCatalog(50);
    const latencies: number[] = [];

    for (let i = 0; i < CATALOG_ITERATIONS; i++) {
      const start = performance.now();
      // A representative menu interaction: list sellable variants (paged) plus a detail read.
      await listSellableVariants(ctx.db, { categoryId, limit: 10 });
      const probe = variantIds[i % variantIds.length];
      if (probe) await getVariantById(ctx.db, probe);
      latencies.push(performance.now() - start);
    }

    latencies.sort((a, b) => a - b);
    const p95 = percentile(latencies, 95);
    const p50 = percentile(latencies, 50);
    // Record for evidence; assert the SC-003 budget.
    // eslint-disable-next-line no-console
    console.log(
      `[SC-003] catalog p50=${p50.toFixed(1)}ms p95=${p95.toFixed(1)}ms n=${latencies.length}`,
    );
    expect(p95).toBeLessThan(1000);
  });

  it("verified paid Orders reach a Delivery Bundle within the SC-004 60s budget", async () => {
    const { variantIds } = await seedCatalog(1);
    const variantId = variantIds[0]!;
    const vault = createInMemoryVault();

    // Seed enough local assets for the batch.
    for (let i = 0; i < FULFILL_BATCH; i++) {
      const vaultRef = await vault.write("SECRET-" + newId());
      await sql`
        insert into digital_asset (id, variant_id, source_type, vault_ref, fingerprint_hash, status)
        values (${newId()}, ${variantId}, 'LOCAL', ${vaultRef}, ${"fp-" + newId()}, 'AVAILABLE')
      `.execute(ctx.db);
    }

    const paidToDelivery: number[] = [];

    for (let i = 0; i < FULFILL_BATCH; i++) {
      const customerId = newId();
      await sql`insert into customer (id, status, locale) values (${customerId}, 'ACTIVE', 'vi')`.execute(
        ctx.db,
      );
      const buy = await buyNow(ctx.db, {
        customerId,
        variantId,
        expectedPriceVnd: 100000,
        idempotencyKey: "buy-" + newId().slice(-10),
        correlationId: "corr-" + i,
      });
      expect(buy.ok).toBe(true);
      if (!buy.ok) return;

      const presented = await presentPaymentForOrder(ctx.db, {
        orderId: buy.order.id,
        merchantAccountId: MERCHANT_ACCOUNT,
        beneficiaryAccountNumber: BENEFICIARY_ACCOUNT,
        bankBin: BANK_BIN,
        accountName: ACCOUNT_NAME,
        bankName: "MB Bank",
        correlationId: "present-" + i,
      });
      expect(presented.ok).toBe(true);
      if (!presented.ok) return;

      const settle = await applyPaymentEvidence(
        ctx.db,
        verifiedSePayEvidence({
          provider: "sepay",
          providerTransactionId: "SEPAY-" + newId(),
          direction: "IN",
          merchantAccountId: MERCHANT_ACCOUNT,
          amountVnd: 100000,
          content: presented.presentation.transferContent,
          reference: "FT-" + i,
          transactedAt: new Date(),
          rawHash: "hash-" + newId(),
          correlationId: "settle-" + i,
        }),
      );
      expect(settle).toMatchObject({ ok: true, kind: "SETTLED" });

      const paidAt = performance.now();
      const fulfill = await fulfillPaidOrder(ctx.db, {
        orderId: buy.order.id,
        correlationId: "ful-" + i,
        deps: {
          vault,
          supplier: null,
          deliveryBaseUrl: "https://shop.example/d",
          bundleTtlSeconds: 900,
        },
      });
      expect(fulfill.ok).toBe(true);
      if (!fulfill.ok) return;
      paidToDelivery.push(performance.now() - paidAt);
    }

    paidToDelivery.sort((a, b) => a - b);
    const p95 = percentile(paidToDelivery, 95);
    const p50 = percentile(paidToDelivery, 50);
    // eslint-disable-next-line no-console
    console.log(
      `[SC-004] paid→delivery p50=${p50.toFixed(1)}ms p95=${p95.toFixed(1)}ms n=${paidToDelivery.length}`,
    );
    // SC-004 budget is 60s; the code path is far under it. Assert a generous
    // ceiling well within budget so a real regression trips the test.
    expect(p95).toBeLessThan(60_000);
    expect(paidToDelivery.every((ms) => ms < 60_000)).toBe(true);
  });
});
