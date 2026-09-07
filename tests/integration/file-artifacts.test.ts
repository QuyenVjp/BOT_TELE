import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "kysely";
import {
  activateFileArtifact,
  cacheTelegramFileId,
  getActiveFileArtifactForDelivery,
  registerFileArtifact,
} from "../../src/modules/digital-goods/file-artifacts.js";
import { newId } from "../../src/shared/ids/index.js";
import { startPostgresContainer, type PgTestContext } from "../helpers/pg-container.js";

let ctx: PgTestContext;

const ROOT_ID = 123456789;
const rootConfig = { adminTelegramUserId: ROOT_ID, expectedUsername: "Quyenvjp" };
const rootActor = {
  numericUserId: ROOT_ID,
  chatType: "private" as const,
  observedUsername: "Quyenvjp",
};
const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);

beforeAll(async () => {
  ctx = await startPostgresContainer();
}, 180_000);

afterAll(async () => {
  await ctx?.teardown();
});

beforeEach(async () => {
  await sql`
    truncate table variant_file_artifact, audit_event, product_variant, product, category cascade
  `.execute(ctx.db);
});

async function seedDigitalVariant() {
  const categoryId = newId();
  const productId = newId();
  const variantId = newId();
  await sql`insert into category (id, name_vi, slug, is_active, sort_order) values (${categoryId}, 'Digital', ${categoryId.slice(-8)}, true, 1)`.execute(
    ctx.db,
  );
  await sql`insert into product (id, category_id, name_vi, slug, is_active, sort_order) values (${productId}, ${categoryId}, 'File product', ${productId.slice(-8)}, true, 1)`.execute(
    ctx.db,
  );
  await sql`
    insert into product_variant
      (id, product_id, sku, name_vi, price_vnd, duration_code, delivery_type, stock_policy, fulfillment_type)
    values
      (${variantId}, ${productId}, ${`SKU-${variantId}`}, 'Download', 100000, 'P1M', 'MANUAL_REVIEW', 'LOCAL_ONLY', 'DIGITAL_FILE')
  `.execute(ctx.db);
  return { variantId };
}

function registerInput(
  variantId: string,
  overrides: Partial<Parameters<typeof registerFileArtifact>[0]> = {},
) {
  return {
    actor: rootActor,
    config: rootConfig,
    db: ctx.db,
    variantId,
    version: 1,
    filename: "guide.pdf",
    mimeType: "application/pdf",
    sizeBytes: 12345n,
    sha256: SHA_A,
    storageReference: "vault://private/guide-v1",
    reason: "register file artifact",
    correlationId: "file-artifact-register",
    ...overrides,
  };
}

describe("digital file artifacts", () => {
  it("registers metadata idempotently without exposing the private storage reference", async () => {
    const { variantId } = await seedDigitalVariant();
    const first = await registerFileArtifact(registerInput(variantId));
    expect(first).toMatchObject({
      ok: true,
      artifact: { variantId, version: 1, isActive: false, telegramFileId: null },
    });
    if (!first.ok) return;
    expect(first.artifact).not.toHaveProperty("storageReference");

    const replay = await registerFileArtifact(
      registerInput(variantId, { correlationId: "file-artifact-register-replay" }),
    );
    expect(replay).toMatchObject({ ok: true, artifact: { id: first.artifact.id } });

    const conflict = await registerFileArtifact(
      registerInput(variantId, {
        filename: "other.pdf",
        correlationId: "file-artifact-register-conflict",
      }),
    );
    expect(conflict).toEqual({ ok: false, code: "VERSION_CONFLICT" });

    const audit = await sql<{
      action: string;
      metadata_redacted: { storageReference?: string; sha256?: string };
    }>`
      select action, metadata_redacted from audit_event where target_id = ${first.artifact.id}
    `.execute(ctx.db);
    expect(audit.rows.map((row) => row.action)).toEqual(["file_artifact.registered"]);
    expect(audit.rows[0]?.metadata_redacted.storageReference).toBeUndefined();
    expect(audit.rows[0]?.metadata_redacted.sha256).toBe(SHA_A);
  });

  it("activates exactly one selected version and returns delivery metadata only", async () => {
    const { variantId } = await seedDigitalVariant();
    const v1 = await registerFileArtifact(
      registerInput(variantId, {
        version: 1,
        sha256: SHA_A,
        storageReference: "vault://private/v1",
      }),
    );
    const v2 = await registerFileArtifact(
      registerInput(variantId, {
        version: 2,
        sha256: SHA_B,
        storageReference: "vault://private/v2",
        correlationId: "file-artifact-register-v2",
      }),
    );
    expect(v1.ok && v2.ok).toBe(true);
    if (!v1.ok || !v2.ok) return;

    await expect(
      activateFileArtifact({
        actor: rootActor,
        config: rootConfig,
        db: ctx.db,
        variantId,
        artifactId: v1.artifact.id,
        reason: "activate v1",
        correlationId: "activate-v1",
      }),
    ).resolves.toMatchObject({ ok: true, artifact: { id: v1.artifact.id, isActive: true } });
    await expect(
      activateFileArtifact({
        actor: rootActor,
        config: rootConfig,
        db: ctx.db,
        variantId,
        artifactId: v2.artifact.id,
        reason: "activate v2",
        correlationId: "activate-v2",
      }),
    ).resolves.toMatchObject({ ok: true, artifact: { id: v2.artifact.id, isActive: true } });

    const activeRows = await sql<{
      id: string;
    }>`select id from variant_file_artifact where variant_id = ${variantId} and is_active`.execute(
      ctx.db,
    );
    expect(activeRows.rows).toEqual([{ id: v2.artifact.id }]);

    const selected = await getActiveFileArtifactForDelivery(ctx.db, variantId);
    expect(selected).toMatchObject({
      id: v2.artifact.id,
      variantId,
      version: 2,
      sha256: SHA_B,
      telegramFileId: null,
    });
    expect(selected).not.toHaveProperty("storageReference");
  });

  it("caches Telegram file_id only when id, version, and hash all match", async () => {
    const { variantId } = await seedDigitalVariant();
    const registered = await registerFileArtifact(registerInput(variantId));
    expect(registered.ok).toBe(true);
    if (!registered.ok) return;

    const wrongHash = await cacheTelegramFileId({
      actor: rootActor,
      config: rootConfig,
      db: ctx.db,
      variantId,
      artifactId: registered.artifact.id,
      version: 1,
      sha256: SHA_B,
      telegramFileId: "AgACAgUAAxkBAAIB-file-id",
      reason: "cache telegram",
      correlationId: "cache-wrong",
    });
    expect(wrongHash).toEqual({ ok: false, code: "ARTIFACT_NOT_FOUND" });

    const cached = await cacheTelegramFileId({
      actor: rootActor,
      config: rootConfig,
      db: ctx.db,
      variantId,
      artifactId: registered.artifact.id,
      version: 1,
      sha256: SHA_A,
      telegramFileId: "AgACAgUAAxkBAAIB-file-id",
      telegramFileUniqueId: "unique_file_id",
      reason: "cache telegram",
      correlationId: "cache-ok",
    });
    expect(cached).toMatchObject({
      ok: true,
      artifact: {
        telegramFileId: "AgACAgUAAxkBAAIB-file-id",
        telegramFileUniqueId: "unique_file_id",
      },
    });
  });

  it("requires root private admin and bounded valid metadata", async () => {
    const { variantId } = await seedDigitalVariant();
    await expect(
      registerFileArtifact(
        registerInput(variantId, { actor: { numericUserId: ROOT_ID, chatType: "group" } }),
      ),
    ).resolves.toEqual({ ok: false, code: "WRONG_CONTEXT" });
    await expect(
      registerFileArtifact(
        registerInput(variantId, { actor: { numericUserId: ROOT_ID + 1, chatType: "private" } }),
      ),
    ).resolves.toEqual({ ok: false, code: "NOT_ROOT_ADMIN" });
    await expect(
      registerFileArtifact(
        registerInput(variantId, { filename: "", correlationId: "invalid-filename" }),
      ),
    ).resolves.toEqual({ ok: false, code: "INVALID_INPUT" });
    await expect(
      registerFileArtifact(
        registerInput(variantId, { sha256: "not-a-hash", correlationId: "invalid-hash" }),
      ),
    ).resolves.toEqual({ ok: false, code: "INVALID_INPUT" });
  });
});
