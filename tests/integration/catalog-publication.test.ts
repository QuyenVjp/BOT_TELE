import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { newId } from "../../src/shared/ids/index.js";
import { getVariantById } from "../../src/modules/catalog/repository.js";
import {
  getProductPublicationReadiness,
  publishProduct,
  registerResaleEvidence,
  revokeResaleEvidence,
} from "../../src/modules/catalog/publication.js";
import { getStoreOpenReadiness } from "../../src/modules/commerce/store-mode.js";
import { startPostgresContainer, type PgTestContext } from "../helpers/pg-container.js";

let ctx: PgTestContext;

/** This suite seeds no discrepancies, parked outbox rows or tickets: only stock gates the store. */
const NO_BLOCKING_QUEUES = {
  openDiscrepancies: 0,
  terminalOutboxOrphans: 0,
  criticalSupportTickets: 0,
} as const;

beforeAll(async () => {
  ctx = await startPostgresContainer();
}, 180_000);

afterAll(async () => {
  await ctx?.teardown();
});

beforeEach(async () => {
  await sql`truncate table product_variant, product, category cascade`.execute(ctx.db);
  await sql`
    update store_control
       set status = 'CLOSED', version = 1, last_request_id = null
     where id = 'main'
  `.execute(ctx.db);
});

async function seedProduct(options: { isTest?: boolean } = {}): Promise<{
  productId: string;
  variantId: string;
}> {
  const categoryId = newId();
  const productId = newId();
  const variantId = newId();
  await sql`
    insert into category (id, name_vi, slug, is_active, sort_order)
    values (${categoryId}, 'AI', ${`ai-${categoryId}`}, true, 1)
  `.execute(ctx.db);
  await sql`
    insert into product (id, category_id, name_vi, slug, is_active, sort_order, is_test, is_archived)
    values (${productId}, ${categoryId}, 'GPT Plus', ${`gpt-${productId}`}, true, 1, ${options.isTest ?? false}, false)
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

type EvidenceRow = {
  variant_id: string;
  source: string;
  reference: string;
  summary: string;
  metadata_redacted: string;
  created_by: string;
  registration_request_id: string | null;
  created_at: Date;
  status: string;
  revoked_at: Date | null;
  revoked_by: string | null;
  revocation_request_id: string | null;
};

async function readEvidence(id: string): Promise<EvidenceRow> {
  const result = await sql<EvidenceRow>`
    select variant_id, source, reference, summary, metadata_redacted::text as metadata_redacted,
           created_by, registration_request_id, created_at, status, revoked_at, revoked_by,
           revocation_request_id
      from resale_evidence
     where id = ${id}
  `.execute(ctx.db);
  const row = result.rows[0];
  if (!row) throw new Error(`missing resale_evidence row ${id}`);
  return row;
}

async function readVariant(variantId: string) {
  const result = await sql<{
    version: number;
    resale_evidence_id: string | null;
    publication_evidence_id: string | null;
    publication_product_version: number | null;
    publication_variant_version: number | null;
    published_at: Date | null;
  }>`
    select version, resale_evidence_id, publication_evidence_id,
           publication_product_version, publication_variant_version, published_at
      from product_variant
     where id = ${variantId}
  `.execute(ctx.db);
  const row = result.rows[0];
  if (!row) throw new Error(`missing product_variant row ${variantId}`);
  return row;
}

async function registerEvidence(variantId: string, requestId: string) {
  const result = await registerResaleEvidence(ctx.db, {
    variantId,
    source: "OWNER_ATTESTATION",
    reference: `owner-ticket-${requestId}`,
    summary: "Owner verified supplier resale authorization.",
    requestId,
    actorId: "admin",
    reason: "Record resale evidence",
    correlationId: requestId,
  });
  if (!result.ok) throw new Error(result.message);
  return result;
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
    // The wire version is a bounded fingerprint (`productVersion:sha256`), never the evidence id:
    // the snapshot is what the confirmation replays, and it must stay inside callback limits.
    expect(ready?.publicationVersion).toMatch(/^\d+:[0-9a-f]{64}$/u);
    expect(ready?.publicationVersion).not.toContain(registration.evidenceId);

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
      ...NO_BLOCKING_QUEUES,
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
      ...NO_BLOCKING_QUEUES,
    });
  });

  it("does not promote a TEST_ONLY product while the store is in TEST mode", async () => {
    const { productId, variantId } = await seedProduct({ isTest: true });
    await registerEvidence(variantId, "test-mode-register-1");
    await sql`update store_control set status = 'TEST', version = 2 where id = 'main'`.execute(
      ctx.db,
    );

    try {
      const readiness = await getProductPublicationReadiness(ctx.db, productId);
      expect(readiness).toMatchObject({
        testOnly: true,
        visibilityBlockers: ["PRODUCT_TEST_ONLY"],
        blockers: ["STORE_TEST_MODE"],
        canPublish: false,
      });
      await expect(
        publishProduct(ctx.db, {
          productId,
          expectedPublicationVersion: readiness!.publicationVersion,
          actorId: "admin",
          reason: "Refuse public promotion in TEST mode",
          correlationId: "test-mode-publish-1",
        }),
      ).resolves.toMatchObject({ ok: false, code: "NOT_READY" });
      expect(await getVariantById(ctx.db, variantId, "public")).toBeNull();
      await expect(
        sql<{ is_test: boolean }>`select is_test from product where id = ${productId}`.execute(
          ctx.db,
        ),
      ).resolves.toMatchObject({ rows: [{ is_test: true }] });
    } finally {
      await sql`update store_control set status = 'CLOSED', version = 3 where id = 'main'`.execute(
        ctx.db,
      );
    }
  });

  it("promotes a TEST_ONLY product to public and replays the old confirmation", async () => {
    const { productId, variantId } = await seedProduct({ isTest: true });
    const registration = await registerEvidence(variantId, "promote-register-1");

    const before = await getProductPublicationReadiness(ctx.db, productId);
    // TEST_ONLY is a visibility state, not a technical blocker: the product is publishable, and
    // publishing is the verb that clears it.
    expect(before).toMatchObject({
      testOnly: true,
      visibilityBlockers: ["PRODUCT_TEST_ONLY"],
      blockers: [],
      canPublish: true,
    });
    expect(before?.variants[0]).toMatchObject({
      evidenceId: registration.evidenceId,
      evidenceActive: true,
      published: false,
    });
    expect(await getVariantById(ctx.db, variantId, "public")).toBeNull();

    const published = await publishProduct(ctx.db, {
      productId,
      expectedPublicationVersion: before!.publicationVersion,
      actorId: "admin",
      reason: "Promote verified test product",
      correlationId: "promote-publish-1",
    });
    expect(published).toMatchObject({ ok: true, kind: "PUBLISHED", productId });

    const productAfter = (
      await sql<{ is_test: boolean; version: number }>`
        select is_test, version from product where id = ${productId}
      `.execute(ctx.db)
    ).rows[0]!;
    expect(productAfter.is_test).toBe(false);
    const after = await getProductPublicationReadiness(ctx.db, productId);
    expect(after).toMatchObject({
      testOnly: false,
      visibilityBlockers: [],
      canPublish: true,
      productVersion: productAfter.version,
      blockers: [],
    });
    expect(await getVariantById(ctx.db, variantId, "public")).not.toBeNull();
    await expect(getStoreOpenReadiness(ctx.db)).resolves.toEqual({
      activeProducts: 1,
      inStockVariants: 1,
      ...NO_BLOCKING_QUEUES,
    });

    // The confirmation the owner is still holding carries the pre-promotion snapshot, whose
    // product version the promotion itself bumped. Replaying it must succeed as a no-op.
    await expect(
      publishProduct(ctx.db, {
        productId,
        expectedPublicationVersion: before!.publicationVersion,
        actorId: "admin",
        reason: "Replay the old confirmation",
        correlationId: "promote-publish-1-replay",
      }),
    ).resolves.toMatchObject({ ok: true, kind: "REPLAYED" });
    expect(await getVariantById(ctx.db, variantId, "public")).not.toBeNull();
    await expect(
      sql`select is_test, version from product where id = ${productId}`.execute(ctx.db),
    ).resolves.toMatchObject({ rows: [{ is_test: false, version: productAfter.version }] });
    const audits = await sql<{ count: number }>`
      select count(*)::int as count from audit_event
       where action = 'catalog.publish' and target_id = ${productId}
    `.execute(ctx.db);
    expect(audits.rows[0]?.count).toBe(1);
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
      ...NO_BLOCKING_QUEUES,
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

  it("revokes an active record, preserves its facts, and invalidates public readiness", async () => {
    const { productId, variantId } = await seedProduct();
    const registration = await registerEvidence(variantId, "revoke-register-1");
    const ready = await getProductPublicationReadiness(ctx.db, productId);
    await expect(
      publishProduct(ctx.db, {
        productId,
        expectedPublicationVersion: ready!.publicationVersion,
        actorId: "admin",
        reason: "Publish before revocation",
        correlationId: "revoke-publish-1",
      }),
    ).resolves.toMatchObject({ ok: true, kind: "PUBLISHED" });
    expect(await getVariantById(ctx.db, variantId, "public")).not.toBeNull();

    const factsBefore = await readEvidence(registration.evidenceId);
    const before = await readVariant(variantId);

    const revoked = await revokeResaleEvidence(ctx.db, {
      variantId,
      evidenceId: registration.evidenceId,
      expectedVariantVersion: before.version,
      requestId: "revoke-request-1",
      actorId: "admin",
      reason: "Owner withdrew the resale authorization",
      correlationId: "revoke-request-1",
    });
    expect(revoked).toEqual({
      ok: true,
      kind: "REVOKED",
      evidenceId: registration.evidenceId,
      variantId,
      variantVersion: before.version + 1,
    });

    // Lifecycle/provenance moved; every fact column is byte-identical.
    const factsAfter = await readEvidence(registration.evidenceId);
    expect({
      status: factsAfter.status,
      revoked: factsAfter.revoked_at !== null,
      revoked_by: factsAfter.revoked_by,
      revocation_request_id: factsAfter.revocation_request_id,
    }).toEqual({
      status: "REVOKED",
      revoked: true,
      revoked_by: "admin",
      revocation_request_id: "revoke-request-1",
    });
    const {
      status: _s,
      revoked_at: _ra,
      revoked_by: _rb,
      revocation_request_id: _rr,
      ...after
    } = factsAfter;
    const {
      status: _bs,
      revoked_at: _bra,
      revoked_by: _brb,
      revocation_request_id: _brr,
      ...facts
    } = factsBefore;
    expect(after).toEqual(facts);

    // The variant still points at the revoked record: the snapshot goes stale, it is
    // never rewritten to look current and the evidence is never silently replaced.
    await expect(readVariant(variantId)).resolves.toMatchObject({
      version: before.version + 1,
      resale_evidence_id: registration.evidenceId,
      publication_evidence_id: registration.evidenceId,
      publication_variant_version: before.version,
    });

    const afterReadiness = await getProductPublicationReadiness(ctx.db, productId);
    expect(afterReadiness?.blockers).toContain("RESALE_EVIDENCE_MISSING");
    expect(afterReadiness?.canPublish).toBe(false);
    expect(afterReadiness?.variants[0]).toMatchObject({
      version: before.version + 1,
      evidenceId: registration.evidenceId,
      evidenceActive: false,
      published: false,
    });
    expect(await getVariantById(ctx.db, variantId, "public")).toBeNull();
    await expect(getStoreOpenReadiness(ctx.db)).resolves.toEqual({
      activeProducts: 0,
      inStockVariants: 0,
      ...NO_BLOCKING_QUEUES,
    });

    const audit = await sql<{
      target_id: string;
      reason: string;
      metadata_redacted: Record<string, unknown>;
    }>`
      select target_id, reason, metadata_redacted
        from audit_event
       where action = 'catalog.evidence.revoke' and target_id = ${variantId}
    `.execute(ctx.db);
    expect(audit.rows).toEqual([
      {
        target_id: variantId,
        reason: "Owner withdrew the resale authorization",
        metadata_redacted: { evidenceId: registration.evidenceId, requestId: "revoke-request-1" },
      },
    ]);
  });

  it("replays a revocation request and refuses reuse on another record", async () => {
    const first = await seedProduct();
    const second = await seedProduct();
    const firstRegistration = await registerEvidence(first.variantId, "revoke-register-a");
    const secondRegistration = await registerEvidence(second.variantId, "revoke-register-b");
    const firstVersion = (await readVariant(first.variantId)).version;
    const secondVersionBefore = (await readVariant(second.variantId)).version;
    await expect(
      revokeResaleEvidence(ctx.db, {
        variantId: first.variantId,
        evidenceId: secondRegistration.evidenceId,
        expectedVariantVersion: firstVersion,
        requestId: "revoke-pair-mismatch",
        actorId: "admin",
        reason: "Reject mismatched evidence and variant",
        correlationId: "revoke-pair-mismatch",
      }),
    ).resolves.toMatchObject({ ok: false, code: "NOT_FOUND" });
    await expect(readEvidence(secondRegistration.evidenceId)).resolves.toMatchObject({
      status: "ACTIVE",
    });
    await expect(readVariant(second.variantId)).resolves.toMatchObject({
      version: secondVersionBefore,
    });

    await expect(
      revokeResaleEvidence(ctx.db, {
        variantId: first.variantId,
        evidenceId: firstRegistration.evidenceId,
        expectedVariantVersion: firstVersion,
        requestId: "revoke-shared",
        actorId: "admin",
        reason: "Owner withdrew the resale authorization",
        correlationId: "revoke-shared",
      }),
    ).resolves.toMatchObject({ ok: true, kind: "REVOKED", variantVersion: firstVersion + 1 });

    // Same request, same record, and the pre-revocation version the retry still carries.
    await expect(
      revokeResaleEvidence(ctx.db, {
        variantId: first.variantId,
        evidenceId: firstRegistration.evidenceId,
        expectedVariantVersion: firstVersion,
        requestId: "revoke-shared",
        actorId: "admin",
        reason: "Owner withdrew the resale authorization",
        correlationId: "revoke-shared-retry",
      }),
    ).resolves.toEqual({
      ok: true,
      kind: "REPLAYED",
      evidenceId: firstRegistration.evidenceId,
      variantId: first.variantId,
      variantVersion: firstVersion + 1,
    });
    await expect(readVariant(first.variantId)).resolves.toMatchObject({
      version: firstVersion + 1,
    });

    const secondVersion = (await readVariant(second.variantId)).version;
    await expect(
      revokeResaleEvidence(ctx.db, {
        variantId: second.variantId,
        evidenceId: secondRegistration.evidenceId,
        expectedVariantVersion: secondVersion,
        requestId: "revoke-shared",
        actorId: "admin",
        reason: "Reuse of a spent request id",
        correlationId: "revoke-shared-reuse",
      }),
    ).resolves.toMatchObject({ ok: false, code: "CONFLICT" });
    await expect(readEvidence(secondRegistration.evidenceId)).resolves.toMatchObject({
      status: "ACTIVE",
    });
    await expect(readVariant(second.variantId)).resolves.toMatchObject({ version: secondVersion });

    const audits = await sql<{ count: number }>`
      select count(*)::int as count from audit_event
       where action = 'catalog.evidence.revoke' and target_id = ${first.variantId}
    `.execute(ctx.db);
    expect(audits.rows[0]?.count).toBe(1);
  });

  it("refuses a stale variant version, a second request, and malformed input", async () => {
    const { variantId } = await seedProduct();
    const registration = await registerEvidence(variantId, "revoke-guard-register");
    const version = (await readVariant(variantId)).version;

    await expect(
      revokeResaleEvidence(ctx.db, {
        variantId,
        evidenceId: registration.evidenceId,
        expectedVariantVersion: version + 5,
        requestId: "revoke-guard-stale",
        actorId: "admin",
        reason: "Stale version must not revoke",
        correlationId: "revoke-guard-stale",
      }),
    ).resolves.toMatchObject({ ok: false, code: "VERSION_CONFLICT" });
    await expect(readEvidence(registration.evidenceId)).resolves.toMatchObject({
      status: "ACTIVE",
      revoked_at: null,
    });
    await expect(readVariant(variantId)).resolves.toMatchObject({ version });

    await expect(
      revokeResaleEvidence(ctx.db, {
        variantId,
        evidenceId: registration.evidenceId,
        expectedVariantVersion: version,
        requestId: "revoke-guard-1",
        actorId: "admin",
        reason: "Owner withdrew the resale authorization",
        correlationId: "revoke-guard-1",
      }),
    ).resolves.toMatchObject({ ok: true, kind: "REVOKED" });

    await expect(
      revokeResaleEvidence(ctx.db, {
        variantId,
        evidenceId: registration.evidenceId,
        expectedVariantVersion: version + 1,
        requestId: "revoke-guard-2",
        actorId: "admin",
        reason: "Second request on a revoked record",
        correlationId: "revoke-guard-2",
      }),
    ).resolves.toMatchObject({ ok: false, code: "NOT_ACTIVE" });

    const invalid = [
      {
        evidenceId: "not-an-id",
        variantId,
        expectedVariantVersion: version,
        requestId: "revoke-bad-id",
      },
      {
        evidenceId: newId(),
        variantId,
        expectedVariantVersion: version,
        requestId: "revoke-unknown-id",
      },
      {
        evidenceId: registration.evidenceId,
        variantId,
        expectedVariantVersion: version,
        requestId: "  ",
      },
      {
        evidenceId: registration.evidenceId,
        variantId,
        expectedVariantVersion: version,
        requestId: "x".repeat(129),
      },
      {
        evidenceId: registration.evidenceId,
        variantId,
        expectedVariantVersion: 0,
        requestId: "revoke-zero-v",
      },
      {
        evidenceId: registration.evidenceId,
        variantId,
        expectedVariantVersion: version,
        requestId: "revoke-long-reason",
        reason: "y".repeat(501),
      },
    ];
    const codes = await Promise.all(
      invalid.map(async (input) =>
        revokeResaleEvidence(ctx.db, {
          actorId: "admin",
          reason: "Record resale evidence",
          correlationId: "revoke-invalid",
          ...input,
        }),
      ),
    );
    expect(codes.map((result) => (result.ok ? "OK" : result.code))).toEqual([
      "NOT_FOUND",
      "NOT_FOUND",
      "INVALID_INPUT",
      "INVALID_INPUT",
      "INVALID_INPUT",
      "INVALID_INPUT",
    ]);
    await expect(readEvidence(registration.evidenceId)).resolves.toMatchObject({
      status: "REVOKED",
      revocation_request_id: "revoke-guard-1",
    });
  });

  it("leaves direct deletion and fact rewrites impossible after revocation", async () => {
    const { variantId } = await seedProduct();
    const registration = await registerEvidence(variantId, "revoke-immutable-register");
    const version = (await readVariant(variantId)).version;

    // Revocation provenance cannot be forged onto an ACTIVE record by direct SQL.
    await expect(
      sql`update resale_evidence set revocation_request_id = 'forged-request'
           where id = ${registration.evidenceId}`.execute(ctx.db),
    ).rejects.toThrow(/resale_evidence_revocation_state_ck/u);

    await expect(
      revokeResaleEvidence(ctx.db, {
        variantId,
        evidenceId: registration.evidenceId,
        expectedVariantVersion: version,
        requestId: "revoke-immutable",
        actorId: "admin",
        reason: "Owner withdrew the resale authorization",
        correlationId: "revoke-immutable",
      }),
    ).resolves.toMatchObject({ ok: true, kind: "REVOKED" });

    await expect(
      sql`delete from resale_evidence where id = ${registration.evidenceId}`.execute(ctx.db),
    ).rejects.toThrow(/immutable/iu);
    await expect(
      sql`update resale_evidence set summary = 'rewritten'
           where id = ${registration.evidenceId}`.execute(ctx.db),
    ).rejects.toThrow(/immutable/iu);
    await expect(readEvidence(registration.evidenceId)).resolves.toMatchObject({
      status: "REVOKED",
      summary: "Owner verified supplier resale authorization.",
      revocation_request_id: "revoke-immutable",
    });
  });
});
