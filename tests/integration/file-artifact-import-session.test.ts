import { createHash } from "node:crypto";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { sql } from "kysely";
import { queueFileDelivery } from "../../src/modules/digital-goods/file-delivery.js";
import {
  createTelegramFileDownloader,
  startFileArtifactImportSession,
  stageFileArtifactDocument,
  confirmFileArtifactImportSession,
  cancelFileArtifactImportSession,
  TELEGRAM_FILE_IMPORT_MAX_BYTES,
  type TelegramDocumentImport,
  type TelegramFileDownloader,
} from "../../src/modules/digital-goods/file-artifact-import-session.js";
import { newId } from "../../src/shared/ids/index.js";
import { startPostgresContainer, type PgTestContext } from "../helpers/pg-container.js";

let ctx: PgTestContext;
let storageRoot: string;

const ROOT_ID = 123456789;
const OTHER_ROOT_ID = 999000111;
const ROOT_ACTOR = { numericUserId: ROOT_ID, chatType: "private" as const };
const ROOT_CONFIG = { adminTelegramUserId: ROOT_ID, expectedUsername: "Quyenvjp" };
const DOCUMENT: TelegramDocumentImport = {
  fileId: "telegram_file_id_1234567890",
  fileUniqueId: "unique_file_1234",
  filename: "asset.zip",
  mimeType: "application/zip",
  fileSize: 11,
};

beforeAll(async () => {
  ctx = await startPostgresContainer();
  storageRoot = await mkdtemp(join(tmpdir(), "bot-tele-file-import-"));
}, 180_000);

afterAll(async () => {
  await ctx?.teardown();
  if (storageRoot) await rm(storageRoot, { recursive: true, force: true });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

beforeEach(async () => {
  await rm(storageRoot, { recursive: true, force: true });
  storageRoot = await mkdtemp(join(tmpdir(), "bot-tele-file-import-"));
  await sql`
    truncate table file_delivery_job, admin_file_artifact_import, variant_file_artifact,
      order_transition, "order", customer_profile_snapshot, channel_identity, customer,
      product_variant, product, category, audit_event cascade
  `.execute(ctx.db);
});

function hash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function downloader(
  bytes: Uint8Array,
  options: { duringDownload?: () => Promise<void> } = {},
): TelegramFileDownloader & { calls: number } {
  return {
    calls: 0,
    async download(input) {
      this.calls += 1;
      await options.duringDownload?.();
      const path = join(input.root, `${newId()}.bin`);
      await writeFile(path, bytes);
      return { storageReference: path, sizeBytes: BigInt(bytes.byteLength), sha256: hash(bytes) };
    },
  };
}

async function seedDigitalVariant() {
  const categoryId = newId();
  const productId = newId();
  const variantId = newId();
  const customerId = newId();
  const orderId = newId();
  await sql`insert into category (id, name_vi, slug, is_active, sort_order) values (${categoryId}, 'Digital', ${categoryId.slice(-8)}, true, 1)`.execute(
    ctx.db,
  );
  await sql`insert into product (id, category_id, name_vi, slug, is_active, sort_order) values (${productId}, ${categoryId}, 'File Pack', ${productId.slice(-8)}, true, 1)`.execute(
    ctx.db,
  );
  await sql`
    insert into product_variant (id, product_id, sku, name_vi, price_vnd, duration_code, delivery_type, stock_policy, fulfillment_type, is_active)
    values (${variantId}, ${productId}, ${`SKU-${variantId}`}, 'ZIP', 100000, 'P1M', 'MANUAL_REVIEW', 'LOCAL_ONLY', 'DIGITAL_FILE', true)
  `.execute(ctx.db);
  await sql`insert into customer (id, status, locale) values (${customerId}, 'ACTIVE', 'vi')`.execute(
    ctx.db,
  );
  await sql`insert into customer_profile_snapshot (customer_id, telegram_user_id, chat_id, display_name, reachable) values (${customerId}, '123456', '123456', 'Buyer', true)`.execute(
    ctx.db,
  );
  await sql`
    insert into "order" (id, order_number, customer_id, variant_id, product_name_vi, variant_name_vi,
      price_vnd, duration_code, delivery_type, fulfillment_type, status, paid_at)
    values (${orderId}, ${`ORD-${orderId}`}, ${customerId}, ${variantId}, 'File Pack', 'ZIP', 100000, 'P1M', 'MANUAL_REVIEW', 'DIGITAL_FILE', 'PAID', now())
  `.execute(ctx.db);
  return { variantId, orderId };
}

async function startReadySession(input: { bytes?: Uint8Array } = {}) {
  const seeded = await seedDigitalVariant();
  const started = await startFileArtifactImportSession(ctx.db, {
    actor: ROOT_ACTOR,
    config: ROOT_CONFIG,
    variantId: seeded.variantId,
    correlationId: "file-import-start",
  });
  expect(started.ok).toBe(true);
  if (!started.ok) throw new Error("start failed");
  const dl = downloader(input.bytes ?? new TextEncoder().encode("file bytes"));
  const staged = await stageFileArtifactDocument(ctx.db, {
    actor: ROOT_ACTOR,
    config: ROOT_CONFIG,
    sessionId: started.session.sessionId,
    generation: started.session.generation,
    document: DOCUMENT,
    downloader: dl,
    privateArtifactRoot: storageRoot,
    correlationId: "file-import-stage",
  });
  expect(staged.ok).toBe(true);
  if (!staged.ok) throw new Error("stage failed");
  return { ...seeded, started, staged };
}

describe("file artifact import session", () => {
  it("stages inactive file artifact, confirms active, then queues paid order delivery", async () => {
    const { orderId, started, staged } = await startReadySession();

    const inactive = await sql<{
      is_active: boolean;
      telegram_file_id: string | null;
    }>`select is_active, telegram_file_id from variant_file_artifact where id = ${staged.artifact.id}`.execute(
      ctx.db,
    );
    expect(inactive.rows[0]).toEqual({ is_active: false, telegram_file_id: DOCUMENT.fileId });

    const confirmed = await confirmFileArtifactImportSession(ctx.db, {
      actor: ROOT_ACTOR,
      config: ROOT_CONFIG,
      sessionId: started.session.sessionId,
      generation: staged.session.generation,
      artifactId: staged.artifact.id,
      privateArtifactRoot: storageRoot,
      correlationId: "file-import-confirm",
    });
    expect(confirmed.ok).toBe(true);
    if (!confirmed.ok) return;
    expect(confirmed.artifact.isActive).toBe(true);

    const queued = await queueFileDelivery({ db: ctx.db, orderId });
    expect(queued).toMatchObject({
      ok: true,
      job: { artifactId: confirmed.artifact.id, artifactSha256: confirmed.artifact.sha256 },
    });
  });

  it("denies group context before invoking the downloader", async () => {
    const seeded = await seedDigitalVariant();
    const started = await startFileArtifactImportSession(ctx.db, {
      actor: ROOT_ACTOR,
      config: ROOT_CONFIG,
      variantId: seeded.variantId,
      correlationId: "file-import-start",
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const dl = downloader(new TextEncoder().encode("file bytes"));

    const staged = await stageFileArtifactDocument(ctx.db, {
      actor: { numericUserId: ROOT_ID, chatType: "group" },
      config: ROOT_CONFIG,
      sessionId: started.session.sessionId,
      generation: started.session.generation,
      document: DOCUMENT,
      downloader: dl,
      privateArtifactRoot: storageRoot,
      correlationId: "file-import-denied",
    });

    expect(staged).toMatchObject({ ok: false, code: "WRONG_CONTEXT" });
    expect(dl.calls).toBe(0);
  });

  it("does not attach a stale session when a restart happens during download", async () => {
    const seeded = await seedDigitalVariant();
    const first = await startFileArtifactImportSession(ctx.db, {
      actor: ROOT_ACTOR,
      config: ROOT_CONFIG,
      variantId: seeded.variantId,
      correlationId: "file-import-first",
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const dl = downloader(new TextEncoder().encode("file bytes"), {
      duringDownload: async () => {
        await startFileArtifactImportSession(ctx.db, {
          actor: ROOT_ACTOR,
          config: ROOT_CONFIG,
          variantId: seeded.variantId,
          correlationId: "file-import-restart",
        });
      },
    });

    const staged = await stageFileArtifactDocument(ctx.db, {
      actor: ROOT_ACTOR,
      config: ROOT_CONFIG,
      sessionId: first.session.sessionId,
      generation: first.session.generation,
      document: DOCUMENT,
      downloader: dl,
      privateArtifactRoot: storageRoot,
      correlationId: "file-import-stale",
    });

    expect(staged).toMatchObject({ ok: false, code: "NOT_FOUND" });
    const rows = await sql<{
      status: string;
      generation: number;
      artifact_id: string | null;
    }>`select status, generation, artifact_id from admin_file_artifact_import where admin_telegram_user_id = ${String(ROOT_ID)}`.execute(
      ctx.db,
    );
    expect(rows.rows[0]).toMatchObject({
      status: "WAITING_DOCUMENT",
      generation: first.session.generation + 1,
      artifact_id: null,
    });
    const artifacts = await sql<{
      count: string;
    }>`select count(*)::text as count from variant_file_artifact where variant_id = ${seeded.variantId}`.execute(
      ctx.db,
    );
    expect(Number(artifacts.rows[0]?.count)).toBe(0);
    expect(await readdir(storageRoot)).toEqual([]);
  });

  it("replaying the same stage request does not duplicate artifacts", async () => {
    const seeded = await seedDigitalVariant();
    const started = await startFileArtifactImportSession(ctx.db, {
      actor: ROOT_ACTOR,
      config: ROOT_CONFIG,
      variantId: seeded.variantId,
      correlationId: "file-import-start",
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const bytes = new TextEncoder().encode("file bytes");

    const input = {
      actor: ROOT_ACTOR,
      config: ROOT_CONFIG,
      sessionId: started.session.sessionId,
      generation: started.session.generation,
      document: DOCUMENT,
      privateArtifactRoot: storageRoot,
      correlationId: "file-import-replay",
    };
    const first = await stageFileArtifactDocument(ctx.db, {
      ...input,
      downloader: downloader(bytes),
    });
    const replay = await stageFileArtifactDocument(ctx.db, {
      ...input,
      downloader: downloader(bytes),
    });

    expect(first.ok).toBe(true);
    expect(replay).toMatchObject({ ok: false, code: "NOT_FOUND" });
    const artifacts = await sql<{
      count: string;
    }>`select count(*)::text as count from variant_file_artifact where variant_id = ${seeded.variantId}`.execute(
      ctx.db,
    );
    expect(Number(artifacts.rows[0]?.count)).toBe(1);
  });

  it("cancelling a READY session prevents activation", async () => {
    const { started, staged } = await startReadySession();
    const cancelled = await cancelFileArtifactImportSession(ctx.db, {
      actor: ROOT_ACTOR,
      config: ROOT_CONFIG,
      correlationId: "file-import-cancel",
    });
    expect(cancelled).toEqual({ ok: true });

    const confirmed = await confirmFileArtifactImportSession(ctx.db, {
      actor: ROOT_ACTOR,
      config: ROOT_CONFIG,
      sessionId: started.session.sessionId,
      generation: staged.session.generation,
      artifactId: staged.artifact.id,
      privateArtifactRoot: storageRoot,
      correlationId: "file-import-confirm-after-cancel",
    });
    expect(confirmed).toMatchObject({ ok: false, code: "NOT_READY" });
    const artifact = await sql<{
      is_active: boolean;
    }>`select is_active from variant_file_artifact where id = ${staged.artifact.id}`.execute(
      ctx.db,
    );
    expect(artifact.rows[0]?.is_active).toBe(false);
  });

  it("rejects activation when the private file hash no longer matches", async () => {
    const { started, staged } = await startReadySession();
    const stored = await sql<{
      storage_reference: string;
    }>`select storage_reference from variant_file_artifact where id = ${staged.artifact.id}`.execute(
      ctx.db,
    );
    await writeFile(stored.rows[0]!.storage_reference, "replacement bytes");

    const confirmed = await confirmFileArtifactImportSession(ctx.db, {
      actor: ROOT_ACTOR,
      config: ROOT_CONFIG,
      sessionId: started.session.sessionId,
      generation: staged.session.generation,
      artifactId: staged.artifact.id,
      privateArtifactRoot: storageRoot,
      correlationId: "file-import-hash-fail",
    });

    expect(confirmed).toMatchObject({ ok: false, code: "FILE_NOT_VERIFIED" });
    const artifact = await sql<{
      is_active: boolean;
    }>`select is_active from variant_file_artifact where id = ${staged.artifact.id}`.execute(
      ctx.db,
    );
    expect(artifact.rows[0]?.is_active).toBe(false);
  });

  it("rejects oversized real Telegram downloads, cleans its file, and hides the bot token in errors", async () => {
    const token = newId();
    const root = await mkdtemp(join(storageRoot, "real-downloader-"));
    const maxBytes = TELEGRAM_FILE_IMPORT_MAX_BYTES;
    const filePath = "documents/oversized.zip";
    const fetchImpl: typeof fetch = async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("/getFile")) {
        return new Response(
          JSON.stringify({
            ok: true,
            result: { file_path: filePath, file_size: Number(maxBytes) },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(Number(maxBytes) + 1));
            controller.close();
          },
        }),
        { status: 200 },
      );
    };
    const downloader = createTelegramFileDownloader(token, {
      fetchImpl,
      resolve: async () => ["93.184.216.34"],
    });

    await expect(downloader.download({ fileId: DOCUMENT.fileId, root, maxBytes })).rejects.toThrow(
      "TELEGRAM_FILE_UNAVAILABLE",
    );
    await expect(
      downloader.download({ fileId: DOCUMENT.fileId, root, maxBytes }),
    ).rejects.not.toThrow(token);
    expect(await readdir(root)).toEqual([]);
  });

  it("rejects a document declared above the 20 MB session cap before download", async () => {
    const seeded = await seedDigitalVariant();
    const started = await startFileArtifactImportSession(ctx.db, {
      actor: ROOT_ACTOR,
      config: ROOT_CONFIG,
      variantId: seeded.variantId,
      correlationId: "file-import-start",
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const dl = downloader(new TextEncoder().encode("file bytes"));

    const staged = await stageFileArtifactDocument(ctx.db, {
      actor: ROOT_ACTOR,
      config: ROOT_CONFIG,
      sessionId: started.session.sessionId,
      generation: started.session.generation,
      document: { ...DOCUMENT, fileSize: Number(TELEGRAM_FILE_IMPORT_MAX_BYTES + 1n) },
      downloader: dl,
      privateArtifactRoot: storageRoot,
      correlationId: "file-import-too-large",
    });

    expect(staged).toMatchObject({ ok: false, code: "FILE_TOO_LARGE" });
    expect(dl.calls).toBe(0);
  });

  it("does not let another root-configured actor confirm someone else's ready session", async () => {
    const { started, staged } = await startReadySession();
    const confirmed = await confirmFileArtifactImportSession(ctx.db, {
      actor: { numericUserId: OTHER_ROOT_ID, chatType: "private" },
      config: { ...ROOT_CONFIG, adminTelegramUserId: OTHER_ROOT_ID },
      sessionId: started.session.sessionId,
      generation: staged.session.generation,
      artifactId: staged.artifact.id,
      privateArtifactRoot: storageRoot,
      correlationId: "file-import-other-root",
    });

    expect(confirmed).toMatchObject({ ok: false, code: "NOT_READY" });
    const artifact = await sql<{
      is_active: boolean;
    }>`select is_active from variant_file_artifact where id = ${staged.artifact.id}`.execute(
      ctx.db,
    );
    expect(artifact.rows[0]?.is_active).toBe(false);
  });
});
