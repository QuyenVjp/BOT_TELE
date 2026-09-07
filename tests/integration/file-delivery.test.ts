import { mkdtemp, rm, writeFile, symlink, truncate } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "kysely";
import {
  queueFileDelivery,
  processFileDelivery,
  type TelegramDocumentSender,
} from "../../src/modules/digital-goods/file-delivery.js";
import { newId } from "../../src/shared/ids/index.js";
import { startPostgresContainer, type PgTestContext } from "../helpers/pg-container.js";

let ctx: PgTestContext;
let storageRoot: string;

beforeAll(async () => {
  ctx = await startPostgresContainer();
  storageRoot = await mkdtemp(join(tmpdir(), "bot-tele-file-delivery-"));
}, 180_000);

afterAll(async () => {
  await ctx?.teardown();
  if (storageRoot) await rm(storageRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  await sql`
    truncate table file_delivery_job, variant_file_artifact, order_transition, "order",
      customer_profile_snapshot, channel_identity, customer, product_variant, product, category cascade
  `.execute(ctx.db);
});

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function seedPaidDigitalOrder(
  input: { bytes?: Uint8Array; artifactVersion?: number; artifactActive?: boolean } = {},
) {
  const bytes = input.bytes ?? new TextEncoder().encode("paid digital file");
  const categoryId = newId();
  const productId = newId();
  const variantId = newId();
  const customerId = newId();
  const orderId = newId();
  const artifactId = newId();
  const filePath = join(storageRoot, `${artifactId}.bin`);
  await writeFile(filePath, bytes);
  await sql`insert into category (id, name_vi, slug, is_active, sort_order) values (${categoryId}, 'Digital', ${categoryId.slice(-8)}, true, 1)`.execute(
    ctx.db,
  );
  await sql`insert into product (id, category_id, name_vi, slug, is_active, sort_order) values (${productId}, ${categoryId}, 'P', ${productId.slice(-8)}, true, 1)`.execute(
    ctx.db,
  );
  await sql`
    insert into product_variant (id, product_id, sku, name_vi, price_vnd, duration_code, delivery_type, stock_policy, fulfillment_type)
    values (${variantId}, ${productId}, ${`SKU-${variantId}`}, 'V', 100000, 'P1M', 'MANUAL_REVIEW', 'LOCAL_ONLY', 'DIGITAL_FILE')
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
    values (${orderId}, ${`ORD-${orderId}`}, ${customerId}, ${variantId}, 'P', 'V', 100000, 'P1M', 'MANUAL_REVIEW', 'DIGITAL_FILE', 'PAID', now())
  `.execute(ctx.db);
  await sql`
    insert into variant_file_artifact
      (id, variant_id, version, filename, mime_type, size_bytes, sha256, storage_reference, is_active)
    values
      (${artifactId}, ${variantId}, ${input.artifactVersion ?? 1}, 'file.bin', 'application/octet-stream', ${String(bytes.byteLength)}, ${sha256(bytes)}, ${filePath}, ${input.artifactActive ?? true})
  `.execute(ctx.db);
  return { orderId, variantId, customerId, artifactId, filePath, bytes, hash: sha256(bytes) };
}

function recordingSender(ids: {
  fileId: string;
  uniqueId?: string | null;
}): TelegramDocumentSender & {
  calls: Array<Parameters<TelegramDocumentSender["sendDocument"]>[0]>;
} {
  const calls: Array<Parameters<TelegramDocumentSender["sendDocument"]>[0]> = [];
  return {
    calls,
    async sendDocument(input) {
      calls.push(input);
      return { fileId: ids.fileId, fileUniqueId: ids.uniqueId ?? null };
    },
  };
}

describe("file delivery jobs", () => {
  it("queues against the order fulfillment snapshot and keeps the chosen artifact version", async () => {
    const seeded = await seedPaidDigitalOrder();
    const queued = await queueFileDelivery({ db: ctx.db, orderId: seeded.orderId });
    expect(queued).toMatchObject({
      ok: true,
      inserted: true,
      job: { artifactId: seeded.artifactId, artifactVersion: 1, artifactSha256: seeded.hash },
    });
    if (!queued.ok) return;

    await sql`update product_variant set fulfillment_type = 'MANUAL_FULFILLMENT' where id = ${seeded.variantId}`.execute(
      ctx.db,
    );
    await sql`update variant_file_artifact set is_active = false where id = ${seeded.artifactId}`.execute(
      ctx.db,
    );
    const replay = await queueFileDelivery({ db: ctx.db, orderId: seeded.orderId });
    expect(replay).toMatchObject({
      ok: true,
      inserted: false,
      job: { artifactId: seeded.artifactId, artifactVersion: 1, artifactSha256: seeded.hash },
    });
  });

  it("uploads verified bytes once, caches Telegram file_id, and completes the order after send", async () => {
    const seeded = await seedPaidDigitalOrder();
    const queued = await queueFileDelivery({ db: ctx.db, orderId: seeded.orderId });
    expect(queued.ok).toBe(true);
    if (!queued.ok) return;
    const sender = recordingSender({
      fileId: "telegram_file_id_1234567890",
      uniqueId: "unique123",
    });

    const sent = await processFileDelivery({
      db: ctx.db,
      job: queued.job,
      storageRoots: [storageRoot],
      sender,
    });
    expect(sent).toMatchObject({
      ok: true,
      reusedTelegramFileId: false,
      job: { status: "SENT", telegramFileId: "telegram_file_id_1234567890" },
    });
    expect(sender.calls).toHaveLength(1);
    expect(sender.calls[0]?.source.kind).toBe("bytes");
    if (sender.calls[0]?.source.kind !== "bytes") return;
    expect(Array.from(sender.calls[0].source.bytes)).toEqual(Array.from(seeded.bytes));

    const state = await sql<{ order_status: string; cached: string | null }>`
      select o.status as order_status, a.telegram_file_id as cached
      from "order" o join variant_file_artifact a on a.id = ${seeded.artifactId}
      where o.id = ${seeded.orderId}
    `.execute(ctx.db);
    expect(state.rows[0]).toEqual({
      order_status: "COMPLETED",
      cached: "telegram_file_id_1234567890",
    });
  });

  it("reuses a cached Telegram file_id without reading private storage", async () => {
    const seeded = await seedPaidDigitalOrder();
    await sql`update variant_file_artifact set telegram_file_id = 'cached_file_id_1234567890', telegram_file_unique_id = 'cached_unique' where id = ${seeded.artifactId}`.execute(
      ctx.db,
    );
    await rm(seeded.filePath);
    const queued = await queueFileDelivery({ db: ctx.db, orderId: seeded.orderId });
    expect(queued.ok).toBe(true);
    if (!queued.ok) return;
    const sender = recordingSender({
      fileId: "cached_file_id_1234567890",
      uniqueId: "cached_unique",
    });

    const sent = await processFileDelivery({
      db: ctx.db,
      job: queued.job,
      storageRoots: [storageRoot],
      sender,
    });
    expect(sent).toMatchObject({ ok: true, reusedTelegramFileId: true });
    expect(sender.calls[0]?.source).toEqual({
      kind: "telegram_file_id",
      fileId: "cached_file_id_1234567890",
    });
  });

  it("rejects symlink escapes and hash mismatches before sending", async () => {
    const seeded = await seedPaidDigitalOrder();
    const outside = join(tmpdir(), `${newId()}.bin`);
    const link = join(storageRoot, `${newId()}.bin`);
    await writeFile(outside, seeded.bytes);
    await symlink(outside, link);
    await sql`update variant_file_artifact set storage_reference = ${link} where id = ${seeded.artifactId}`.execute(
      ctx.db,
    );
    const queued = await queueFileDelivery({ db: ctx.db, orderId: seeded.orderId });
    expect(queued.ok).toBe(true);
    if (!queued.ok) return;
    const sender = recordingSender({ fileId: "unused_file_id_1234567890" });
    await expect(
      processFileDelivery({ db: ctx.db, job: queued.job, storageRoots: [storageRoot], sender }),
    ).resolves.toEqual({ ok: false, code: "INVALID_STORAGE_REFERENCE" });
    expect(sender.calls).toHaveLength(0);
    await rm(outside, { force: true });

    await sql`update variant_file_artifact set storage_reference = ${seeded.filePath}, sha256 = ${"b".repeat(64)} where id = ${seeded.artifactId}`.execute(
      ctx.db,
    );
    await sql`update file_delivery_job set status = 'QUEUED', claim_generation = 0 where order_id = ${seeded.orderId}`.execute(
      ctx.db,
    );
    await expect(
      processFileDelivery({ db: ctx.db, job: queued.job, storageRoots: [storageRoot], sender }),
    ).resolves.toEqual({ ok: false, code: "FILE_HASH_MISMATCH" });
    expect(sender.calls).toHaveLength(0);
  });

  it("rejects oversized replaced files before sending", async () => {
    const seeded = await seedPaidDigitalOrder();
    const queued = await queueFileDelivery({ db: ctx.db, orderId: seeded.orderId });
    expect(queued.ok).toBe(true);
    if (!queued.ok) return;
    await truncate(seeded.filePath, 51 * 1024 * 1024);
    const sender = recordingSender({ fileId: "oversize_unused_file_id_1234567890" });
    await expect(
      processFileDelivery({ db: ctx.db, job: queued.job, storageRoots: [storageRoot], sender }),
    ).resolves.toEqual({ ok: false, code: "FILE_SIZE_MISMATCH" });
    expect(sender.calls).toHaveLength(0);
  });

  it("fences concurrent processors so only one sender call can complete the job", async () => {
    const seeded = await seedPaidDigitalOrder();
    const queued = await queueFileDelivery({ db: ctx.db, orderId: seeded.orderId });
    expect(queued.ok).toBe(true);
    if (!queued.ok) return;
    const enteredSend = Promise.withResolvers<void>();
    const releaseSend = Promise.withResolvers<void>();
    const sender: TelegramDocumentSender & {
      calls: Array<Parameters<TelegramDocumentSender["sendDocument"]>[0]>;
    } = {
      calls: [],
      async sendDocument(input) {
        sender.calls.push(input);
        enteredSend.resolve();
        await releaseSend.promise;
        return { fileId: "race_file_id_1234567890", fileUniqueId: null };
      },
    };

    const firstPromise = processFileDelivery({
      db: ctx.db,
      job: queued.job,
      storageRoots: [storageRoot],
      sender,
    });
    await enteredSend.promise;
    const refreshed = await queueFileDelivery({ db: ctx.db, orderId: seeded.orderId });
    expect(refreshed).toMatchObject({ ok: true, job: { status: "PROCESSING" } });
    if (!refreshed.ok) return;
    await expect(
      processFileDelivery({ db: ctx.db, job: refreshed.job, storageRoots: [storageRoot], sender }),
    ).resolves.toEqual({ ok: false, code: "STALE_JOB" });
    releaseSend.resolve();
    await expect(firstPromise).resolves.toMatchObject({ ok: true, job: { status: "SENT" } });
    const replay = await processFileDelivery({
      db: ctx.db,
      job: queued.job,
      storageRoots: [storageRoot],
      sender,
    });
    expect(replay).toMatchObject({ ok: true, job: { status: "SENT" } });
    expect(sender.calls).toHaveLength(1);
  });

  it("rejects an active processing lease even when caller has the current generation", async () => {
    const seeded = await seedPaidDigitalOrder();
    const queued = await queueFileDelivery({ db: ctx.db, orderId: seeded.orderId });
    expect(queued.ok).toBe(true);
    if (!queued.ok) return;
    await sql`
      update file_delivery_job
      set status = 'PROCESSING', claim_generation = 1, processing_expires_at = now() + interval '5 minutes'
      where order_id = ${seeded.orderId}
    `.execute(ctx.db);
    const refreshed = await queueFileDelivery({ db: ctx.db, orderId: seeded.orderId });
    expect(refreshed).toMatchObject({
      ok: true,
      job: { status: "PROCESSING", claimGeneration: 1 },
    });
    if (!refreshed.ok) return;
    const sender = recordingSender({ fileId: "active_lease_file_id_1234567890" });

    await expect(
      processFileDelivery({ db: ctx.db, job: refreshed.job, storageRoots: [storageRoot], sender }),
    ).resolves.toEqual({ ok: false, code: "STALE_JOB" });
    expect(sender.calls).toHaveLength(0);
  });

  it("recovers an expired processing lease and advances the claim generation", async () => {
    const seeded = await seedPaidDigitalOrder();
    const queued = await queueFileDelivery({ db: ctx.db, orderId: seeded.orderId });
    expect(queued.ok).toBe(true);
    if (!queued.ok) return;
    await sql`
      update file_delivery_job
      set status = 'PROCESSING', claim_generation = 1, processing_expires_at = now() - interval '1 second'
      where order_id = ${seeded.orderId}
    `.execute(ctx.db);
    const refreshed = await queueFileDelivery({ db: ctx.db, orderId: seeded.orderId });
    expect(refreshed).toMatchObject({
      ok: true,
      job: { status: "PROCESSING", claimGeneration: 1 },
    });
    if (!refreshed.ok) return;
    const sender = recordingSender({ fileId: "expired_lease_file_id_1234567890" });

    const sent = await processFileDelivery({
      db: ctx.db,
      job: refreshed.job,
      storageRoots: [storageRoot],
      sender,
    });
    expect(sent).toMatchObject({ ok: true, job: { status: "SENT", claimGeneration: 2 } });
    expect(sender.calls).toHaveLength(1);
  });
});
