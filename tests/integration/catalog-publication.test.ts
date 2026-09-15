import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { newId } from "../../src/shared/ids/index.js";
import { getVariantById } from "../../src/modules/catalog/repository.js";
import {
  getProductPublicationReadiness,
  publishProduct,
  registerResaleEvidence,
} from "../../src/modules/catalog/publication.js";
import { getStoreOpenReadiness } from "../../src/modules/commerce/store-mode.js";
import { startPostgresContainer, type PgTestContext } from "../helpers/pg-container.js";

let ctx: PgTestContext;

beforeAll(async () => {
  ctx = await startPostgresContainer();
}, 180_000);

afterAll(async () => {
  await ctx?.teardown();
});

beforeEach(async () => {
  await sql`truncate table product_variant, product, category cascade`.execute(ctx.db);
});

async function seedProduct(): Promise<{ productId: string; variantId: string }> {
  const categoryId = newId();
  const productId = newId();
  const variantId = newId();
  await sql`
    insert into category (id, name_vi, slug, is_active, sort_order)
    values (${categoryId}, 'AI', ${`ai-${categoryId}`}, true, 1)
  `.execute(ctx.db);
  await sql`
    insert into product (id, category_id, name_vi, slug, is_active, sort_order, is_test, is_archived)
    values (${productId}, ${categoryId}, 'GPT Plus', ${`gpt-${productId}`}, true, 1, false, false)
  `.execute(ctx.db);
  await sql`
    insert into product_variant
      (id, product_id, sku, name_vi, price_vnd, duration_code, delivery_type,
       fulfillment_type, warranty_days, stock_policy, is_active, sort_order)
    values
      (${variantId}, ${productId}, ${`GPT-${variantId}`}, '1 tháng', 250000, 'P1M', 'CREDENTIAL',
       'STOCK_ACCOUNT', 30, 'LOCAL_ONLY', true, 1)
  `.execute(ctx.db);
  await sql`
    insert into digital_asset (id, variant_id, source_type, vault_ref, fingerprint_hash, status)
    values (${newId()}, ${variantId}, 'TEST_FIXTURE', 'test-vault-ref', ${newId()}, 'AVAILABLE')
  `.execute(ctx.db);
  return { productId, variantId };
}

describe("protected catalog publication", () => {
  it("requires explicit evidence, preserves it, and publishes a current snapshot", async () => {
    const { productId, variantId } = await seedProduct();
    const before = await getProductPublicationReadiness(ctx.db, productId);
    expect(before?.canPublish).toBe(false);
    expect(before?.blockers).toContain("RESALE_EVIDENCE_MISSING");

    const registration = await registerResaleEvidence(ctx.db, {
      variantId,
      source: "OWNER_ATTESTATION",
      reference: "owner-ticket-123",
      summary: "Owner verified supplier resale authorization.",
      requestId: "evidence-request-1",
      actorId: "admin",
      reason: "Pre-production publication evidence",
      correlationId: "evidence-request-1",
    });
    expect(registration).toMatchObject({ ok: true, replayed: false });
    if (!registration.ok) throw new Error(registration.message);

    const replay = await registerResaleEvidence(ctx.db, {
      variantId,
      source: "OWNER_ATTESTATION",
      reference: "owner-ticket-123",
      summary: "Owner verified supplier resale authorization.",
      requestId: "evidence-request-1",
      actorId: "admin",
      reason: "Replay",
      correlationId: "evidence-request-1-replay",
    });
    expect(replay).toMatchObject({ ok: true, replayed: true, evidenceId: registration.evidenceId });

    const ready = await getProductPublicationReadiness(ctx.db, productId);
    expect(ready?.canPublish).toBe(true);
    expect(ready?.variants[0]?.evidenceId).toBe(registration.evidenceId);
    expect(ready?.publicationVersion).toContain(registration.evidenceId);

    const stale = await publishProduct(ctx.db, {
      productId,
      expectedPublicationVersion: "stale",
      actorId: "admin",
      reason: "stale snapshot must not publish",
      correlationId: "publish-stale",
    });
    expect(stale).toMatchObject({ ok: false, code: "VERSION_CONFLICT" });

    const published = await publishProduct(ctx.db, {
      productId,
      expectedPublicationVersion: ready!.publicationVersion,
      actorId: "admin",
      reason: "Publish verified product",
      correlationId: "publish-1",
    });
    expect(published).toMatchObject({ ok: true, kind: "PUBLISHED", productId });
    expect(await getVariantById(ctx.db, variantId, "public")).not.toBeNull();
    await expect(getStoreOpenReadiness(ctx.db)).resolves.toEqual({
      activeProducts: 1,
      inStockVariants: 1,
    });

    const replayedPublish = await publishProduct(ctx.db, {
      productId,
      expectedPublicationVersion: ready!.publicationVersion,
      actorId: "admin",
      reason: "Replay publish",
      correlationId: "publish-1-replay",
    });
    expect(replayedPublish).toMatchObject({ ok: true, kind: "REPLAYED" });
    await sql`update digital_asset set status = 'REVOKED' where variant_id = ${variantId}`.execute(
      ctx.db,
    );
    await expect(getStoreOpenReadiness(ctx.db)).resolves.toEqual({
      activeProducts: 1,
      inStockVariants: 0,
    });
  });

  it("requires an active category for publication and store opening", async () => {
    const { productId } = await seedProduct();
    await sql`
      update category set is_active = false
      where id = (select category_id from product where id = ${productId})
    `.execute(ctx.db);

    const readiness = await getProductPublicationReadiness(ctx.db, productId);
    expect(readiness?.blockers).toContain("CATEGORY_INACTIVE");
    expect(readiness?.canPublish).toBe(false);
    await expect(getStoreOpenReadiness(ctx.db)).resolves.toEqual({
      activeProducts: 0,
      inStockVariants: 0,
    });
  });

  it("rejects credential-like evidence text", async () => {
    const { variantId } = await seedProduct();
    const result = await registerResaleEvidence(ctx.db, {
      variantId,
      source: "OWNER_ATTESTATION",
      reference: "owner-ticket-safe",
      summary: "password=must-not-be-recorded",
      requestId: "evidence-request-secret",
      actorId: "admin",
      reason: "Reject secret-bearing evidence",
      correlationId: "evidence-request-secret",
    });
    expect(result).toMatchObject({ ok: false, code: "INVALID_INPUT" });
    const rows = await sql<{ count: number }>`
      select count(*)::int as count from resale_evidence where variant_id = ${variantId}
    `.execute(ctx.db);
    expect(rows.rows[0]?.count).toBe(0);
  });

  it("rejects mutation of evidence facts after registration", async () => {
    const { variantId } = await seedProduct();
    const registration = await registerResaleEvidence(ctx.db, {
      variantId,
      source: "CONTRACT_REFERENCE",
      reference: "contract-123",
      summary: "Contract evidence",
      requestId: "evidence-request-immutable",
      actorId: "admin",
      reason: "Record evidence",
      correlationId: "evidence-request-immutable",
    });
    if (!registration.ok) throw new Error(registration.message);
    await expect(
      sql`update resale_evidence set summary = 'rewritten' where id = ${registration.evidenceId}`.execute(
        ctx.db,
      ),
    ).rejects.toThrow(/immutable/iu);
  });
});
