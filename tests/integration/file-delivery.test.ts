import { mkdtemp, rm, writeFile, symlink, truncate } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { sql } from "kysely";
import {
  queueFileDelivery,
  processFileDelivery,
  resolveUncertainFileDelivery,
  type TelegramDocumentSender,
} from "../../src/modules/digital-goods/file-delivery.js";
import { setStoreModeForTest } from "../../src/modules/commerce/store-mode.js";
import {
  getAdminOrderDetail,
  resolveAdminOrderState,
} from "../../src/modules/admin/order-operations.js";
import { createWalletLedgerService } from "../../src/modules/wallet/ledger.js";
import { createWalletRefundService } from "../../src/modules/wallet/refund.js";
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
  await sql`delete from test_customer_allowlist`.execute(ctx.db);
  await setStoreModeForTest(ctx.db, "OPEN", "file-delivery-test");
});

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function seedPaidDigitalOrder(
  input: {
    bytes?: Uint8Array;
    artifactVersion?: number;
    artifactActive?: boolean;
    isTest?: boolean;
    telegramUserId?: string;
  } = {},
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
  await sql`insert into product (id, category_id, name_vi, slug, is_active, is_test, sort_order) values (${productId}, ${categoryId}, 'P', ${productId.slice(-8)}, true, ${input.isTest ?? false}, 1)`.execute(
    ctx.db,
  );
  await sql`
    insert into product_variant (id, product_id, sku, name_vi, price_vnd, duration_code, delivery_type, stock_policy, fulfillment_type)
    values (${variantId}, ${productId}, ${`SKU-${variantId}`}, 'V', 100000, 'P1M', 'MANUAL_REVIEW', 'LOCAL_ONLY', 'DIGITAL_FILE')
  `.execute(ctx.db);
  await sql`insert into customer (id, status, locale) values (${customerId}, 'ACTIVE', 'vi')`.execute(
    ctx.db,
  );
  const telegramUserId = input.telegramUserId ?? "123456";
  await sql`insert into customer_profile_snapshot (customer_id, telegram_user_id, chat_id, display_name, reachable) values (${customerId}, ${telegramUserId}, ${telegramUserId}, 'Buyer', true)`.execute(
    ctx.db,
  );
  await sql`
    insert into channel_identity (id, customer_id, channel, channel_user_id)
    values (${newId()}, ${customerId}, 'TELEGRAM', ${telegramUserId})
  `.execute(ctx.db);
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
  messageId?: string | null;
}): TelegramDocumentSender & {
  calls: Array<Parameters<TelegramDocumentSender["sendDocument"]>[0]>;
} {
  const calls: Array<Parameters<TelegramDocumentSender["sendDocument"]>[0]> = [];
  return {
    calls,
    async sendDocument(input) {
      calls.push(input);
      return {
        fileId: ids.fileId,
        fileUniqueId: ids.uniqueId ?? null,
        messageId: ids.messageId ?? null,
      };
    },
  };
}

async function seedUncertainDelivery(input: Parameters<typeof seedPaidDigitalOrder>[0] = {}) {
  const seeded = await seedPaidDigitalOrder(input);
  const queued = await queueFileDelivery({ db: ctx.db, orderId: seeded.orderId });
  if (!queued.ok) throw new Error(`queue fixture failed: ${queued.code}`);
  await expect(
    processFileDelivery({
      db: ctx.db,
      job: queued.job,
      storageRoots: [storageRoot],
      sender: {
        async sendDocument() {
          throw new Error("simulated uncertain send");
        },
      },
    }),
  ).resolves.toEqual({ ok: false, code: "SEND_UNCERTAIN" });
  const current = await queueFileDelivery({ db: ctx.db, orderId: seeded.orderId });
  if (!current.ok) throw new Error(`uncertain fixture refresh failed: ${current.code}`);
  const version = (
    await sql<{
      version: number;
    }>`select version from "order" where id = ${seeded.orderId}`.execute(ctx.db)
  ).rows[0]!.version;
  return { seeded, job: current.job, version };
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
      messageId: "telegram_message_id_123",
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

    const state = await sql<{
      order_status: string;
      cached: string | null;
      receipt_message_id: string | null;
      receipt_status: string | null;
    }>`
      select
        o.status as order_status,
        a.telegram_file_id as cached,
        e.metadata_redacted->>'telegramMessageId' as receipt_message_id,
        e.metadata_redacted->>'status' as receipt_status
      from "order" o
      join variant_file_artifact a on a.id = ${seeded.artifactId}
      left join lateral (
        select metadata_redacted
        from audit_event
        where action = 'file_delivery.sent'
          and target_type = 'FileDeliveryJob'
          and target_id = ${seeded.orderId}
        order by occurred_at desc, id desc
        limit 1
      ) e on true
      where o.id = ${seeded.orderId}
    `.execute(ctx.db);
    expect(state.rows[0]).toEqual({
      order_status: "COMPLETED",
      cached: "telegram_file_id_1234567890",
      receipt_message_id: "telegram_message_id_123",
      receipt_status: "SENT",
    });
  });
  it("persists a late Telegram success receipt after the order moves to review", async () => {
    const seeded = await seedPaidDigitalOrder();
    const queued = await queueFileDelivery({ db: ctx.db, orderId: seeded.orderId });
    expect(queued.ok).toBe(true);
    if (!queued.ok) return;
    const enteredSend = Promise.withResolvers<void>();
    const releaseSend = Promise.withResolvers<void>();
    const sender: TelegramDocumentSender = {
      async sendDocument() {
        enteredSend.resolve();
        await releaseSend.promise;
        return {
          fileId: "late_file_id_1234567890",
          fileUniqueId: "late_unique_id",
          messageId: "late_message_id",
        };
      },
    };
    const processing = processFileDelivery({
      db: ctx.db,
      job: queued.job,
      storageRoots: [storageRoot],
      sender,
    });
    await enteredSend.promise;
    await sql`
      update "order"
      set status = 'FULFILLMENT_NEEDS_REVIEW'
      where id = ${seeded.orderId}
    `.execute(ctx.db);
    releaseSend.resolve();

    await expect(processing).resolves.toMatchObject({
      ok: true,
      job: { status: "SENT", telegramFileId: "late_file_id_1234567890" },
    });
    const state = await sql<{
      order_status: string;
      job_status: string;
      telegram_file_id: string | null;
      receipt_message_id: string | null;
    }>`
      select
        o.status as order_status,
        j.status as job_status,
        j.telegram_file_id,
        (
          select e.metadata_redacted->>'telegramMessageId'
          from audit_event e
          where e.action = 'file_delivery.sent'
            and e.target_id = j.order_id
          order by e.occurred_at desc, e.id desc
          limit 1
        ) as receipt_message_id
      from "order" o
      join file_delivery_job j on j.order_id = o.id
      where o.id = ${seeded.orderId}
    `.execute(ctx.db);
    expect(state.rows[0]).toEqual({
      order_status: "FULFILLMENT_NEEDS_REVIEW",
      job_status: "SENT",
      telegram_file_id: "late_file_id_1234567890",
      receipt_message_id: "late_message_id",
    });
  });

  it("treats a sender throw as uncertain and never retries the same job", async () => {
    const seeded = await seedPaidDigitalOrder();
    const queued = await queueFileDelivery({ db: ctx.db, orderId: seeded.orderId });
    expect(queued.ok).toBe(true);
    if (!queued.ok) return;
    const calls: Array<Parameters<TelegramDocumentSender["sendDocument"]>[0]> = [];
    const sender: TelegramDocumentSender = {
      async sendDocument(input) {
        calls.push(input);
        throw new Error("simulated remote acceptance");
      },
    };

    await expect(
      processFileDelivery({ db: ctx.db, job: queued.job, storageRoots: [storageRoot], sender }),
    ).resolves.toEqual({ ok: false, code: "SEND_UNCERTAIN" });

    const state = await sql<{ status: string; last_error: string | null }>`
      select status, last_error
      from file_delivery_job
      where order_id = ${seeded.orderId}
    `.execute(ctx.db);
    expect(state.rows[0]).toEqual({ status: "FAILED", last_error: "SEND_UNCERTAIN" });

    await expect(
      processFileDelivery({ db: ctx.db, job: queued.job, storageRoots: [storageRoot], sender }),
    ).resolves.toEqual({ ok: false, code: "SEND_UNCERTAIN" });
    expect(calls).toHaveLength(1);
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
      storageRoots: [],
      sender,
    });
    expect(sent).toMatchObject({ ok: true, reusedTelegramFileId: true });
    expect(sender.calls[0]?.source).toEqual({
      kind: "telegram_file_id",
      fileId: "cached_file_id_1234567890",
    });
  });
  it("rejects an uncached artifact when no private storage root is configured", async () => {
    const seeded = await seedPaidDigitalOrder();
    const queued = await queueFileDelivery({ db: ctx.db, orderId: seeded.orderId });
    expect(queued.ok).toBe(true);
    if (!queued.ok) return;
    const sender = recordingSender({ fileId: "must_not_send_without_storage_root" });

    await expect(
      processFileDelivery({
        db: ctx.db,
        job: queued.job,
        storageRoots: [],
        sender,
      }),
    ).resolves.toEqual({ ok: false, code: "INVALID_STORAGE_REFERENCE" });
    expect(sender.calls).toHaveLength(0);
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

  it("keeps an invalid symlink delivery refundable without sending", async () => {
    const seeded = await seedPaidDigitalOrder();
    const wallet = createWalletLedgerService(ctx.db);
    await wallet.credit({
      customerId: seeded.customerId,
      amountVnd: 100000n,
      idempotencyKey: "topup:file-refund",
      correlationId: "file-refund-seed",
      reason: "seed wallet credit",
    });
    await wallet.debit({
      customerId: seeded.customerId,
      amountVnd: 100000n,
      idempotencyKey: `purchase:${seeded.orderId}:wallet`,
      correlationId: "file-refund-purchase",
      reason: "seed wallet purchase",
    });

    const outside = join(tmpdir(), `${newId()}.bin`);
    const link = join(storageRoot, `${newId()}.bin`);
    try {
      const queued = await queueFileDelivery({ db: ctx.db, orderId: seeded.orderId });
      expect(queued.ok).toBe(true);
      if (!queued.ok) return;
      await writeFile(outside, seeded.bytes);
      await symlink(outside, link);
      await sql`update variant_file_artifact set storage_reference = ${link} where id = ${seeded.artifactId}`.execute(
        ctx.db,
      );
      const sender = recordingSender({ fileId: "symlink_escape_unused_file_id" });

      await expect(
        processFileDelivery({ db: ctx.db, job: queued.job, storageRoots: [storageRoot], sender }),
      ).resolves.toEqual({ ok: false, code: "INVALID_STORAGE_REFERENCE" });
      expect(sender.calls).toHaveLength(0);

      const beforeRefund = await sql<{
        order_status: string;
        job_status: string;
        last_error: string | null;
      }>`
        select o.status as order_status, j.status as job_status, j.last_error
        from "order" o join file_delivery_job j on j.order_id = o.id
        where o.id = ${seeded.orderId}
      `.execute(ctx.db);
      expect(beforeRefund.rows[0]).toEqual({
        order_status: "PAID",
        job_status: "FAILED",
        last_error: "INVALID_STORAGE_REFERENCE",
      });

      await expect(
        createWalletRefundService(ctx.db).refund({
          orderId: seeded.orderId,
          correlationId: "file-symlink-refund",
          approvedBy: "12345",
        }),
      ).resolves.toMatchObject({ ok: true, kind: "REFUNDED", orderId: seeded.orderId });

      const afterRefund = await sql<{ order_status: string; balance_vnd: string }>`
        select
          (select status from "order" where id = ${seeded.orderId}) as order_status,
          (select balance_vnd from wallet_account where customer_id = ${seeded.customerId}) as balance_vnd
      `.execute(ctx.db);
      expect(afterRefund.rows[0]).toEqual({ order_status: "REFUNDED", balance_vnd: "100000" });
    } finally {
      await rm(outside, { force: true });
      await rm(link, { force: true });
    }
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

  it("reconciles a late success after an expired lease parks the same generation", async () => {
    const seeded = await seedPaidDigitalOrder();
    const queued = await queueFileDelivery({ db: ctx.db, orderId: seeded.orderId });
    expect(queued.ok).toBe(true);
    if (!queued.ok) return;
    const enteredSend = Promise.withResolvers<void>();
    const releaseSend = Promise.withResolvers<void>();
    const firstSender: TelegramDocumentSender & {
      calls: Array<Parameters<TelegramDocumentSender["sendDocument"]>[0]>;
    } = {
      calls: [],
      async sendDocument(input) {
        firstSender.calls.push(input);
        enteredSend.resolve();
        await releaseSend.promise;
        return {
          fileId: "late_success_file_id_1234567890",
          fileUniqueId: "late_success_unique",
          messageId: "late_success_message",
        };
      },
    };
    const firstPromise = processFileDelivery({
      db: ctx.db,
      job: queued.job,
      storageRoots: [storageRoot],
      sender: firstSender,
    });
    await enteredSend.promise;
    await sql`
      update file_delivery_job
      set processing_expires_at = now() - interval '1 second'
      where order_id = ${seeded.orderId}
        and status = 'PROCESSING'
        and claim_generation = ${queued.job.claimGeneration + 1}
    `.execute(ctx.db);
    const current = await queueFileDelivery({ db: ctx.db, orderId: seeded.orderId });
    expect(current).toMatchObject({
      ok: true,
      job: { status: "PROCESSING", claimGeneration: queued.job.claimGeneration + 1 },
    });
    if (!current.ok) return;
    const secondSender = recordingSender({ fileId: "must_not_send_after_expiry" });
    await expect(
      processFileDelivery({
        db: ctx.db,
        job: current.job,
        storageRoots: [storageRoot],
        sender: secondSender,
      }),
    ).resolves.toEqual({ ok: false, code: "SEND_UNCERTAIN" });
    expect(secondSender.calls).toHaveLength(0);

    releaseSend.resolve();
    await expect(firstPromise).resolves.toMatchObject({
      ok: true,
      job: {
        status: "SENT",
        claimGeneration: queued.job.claimGeneration + 1,
        telegramFileId: "late_success_file_id_1234567890",
      },
    });
    expect(firstSender.calls).toHaveLength(1);

    const state = await sql<{
      order_status: string;
      job_status: string;
      claim_generation: number;
      attempt_count: number;
      job_file_id: string | null;
      job_unique_id: string | null;
      artifact_file_id: string | null;
      artifact_unique_id: string | null;
      receipt_message_id: string | null;
      sent_count: string;
      uncertain_count: string;
      completed_count: string;
    }>`
      select
        o.status as order_status,
        j.status as job_status,
        j.claim_generation,
        j.attempt_count,
        j.telegram_file_id as job_file_id,
        j.telegram_file_unique_id as job_unique_id,
        a.telegram_file_id as artifact_file_id,
        a.telegram_file_unique_id as artifact_unique_id,
        sent_audit.metadata_redacted->>'telegramMessageId' as receipt_message_id,
        (
          select count(*)::text
          from audit_event
          where action = 'file_delivery.sent'
            and target_type = 'FileDeliveryJob'
            and target_id = ${seeded.orderId}
        ) as sent_count,
        (
          select count(*)::text
          from audit_event
          where action = 'file_delivery.uncertain'
            and target_type = 'FileDeliveryJob'
            and target_id = ${seeded.orderId}
        ) as uncertain_count,
        (
          select count(*)::text
          from order_transition
          where order_id = ${seeded.orderId}
            and reason_code = 'FILE_DELIVERY_SENT'
        ) as completed_count
      from "order" o
      join file_delivery_job j on j.order_id = o.id
      join variant_file_artifact a on a.id = ${seeded.artifactId}
      left join lateral (
        select metadata_redacted
        from audit_event
        where action = 'file_delivery.sent'
          and target_type = 'FileDeliveryJob'
          and target_id = ${seeded.orderId}
        order by occurred_at desc, id desc
        limit 1
      ) sent_audit on true
      where o.id = ${seeded.orderId}
    `.execute(ctx.db);
    expect(state.rows[0]).toEqual({
      order_status: "COMPLETED",
      job_status: "SENT",
      claim_generation: queued.job.claimGeneration + 1,
      attempt_count: 1,
      job_file_id: "late_success_file_id_1234567890",
      job_unique_id: "late_success_unique",
      artifact_file_id: "late_success_file_id_1234567890",
      artifact_unique_id: "late_success_unique",
      receipt_message_id: "late_success_message",
      sent_count: "1",
      uncertain_count: "1",
      completed_count: "1",
    });
  });

  it("keeps a late receipt out of a newer explicitly requeued claim", async () => {
    const seeded = await seedPaidDigitalOrder();
    const queued = await queueFileDelivery({ db: ctx.db, orderId: seeded.orderId });
    expect(queued.ok).toBe(true);
    if (!queued.ok) return;
    const originalEntered = Promise.withResolvers<void>();
    const releaseOriginal = Promise.withResolvers<void>();
    const originalSender: TelegramDocumentSender = {
      async sendDocument() {
        originalEntered.resolve();
        await releaseOriginal.promise;
        return {
          fileId: "old_generation_file_id",
          fileUniqueId: "old_generation_unique_id",
          messageId: "old_generation_message_id",
        };
      },
    };
    const originalSend = processFileDelivery({
      db: ctx.db,
      job: queued.job,
      storageRoots: [storageRoot],
      sender: originalSender,
    });
    await originalEntered.promise;
    await sql`
      update file_delivery_job
      set processing_expires_at = now() - interval '1 second'
      where order_id = ${seeded.orderId}
        and status = 'PROCESSING'
        and claim_generation = ${queued.job.claimGeneration + 1}
    `.execute(ctx.db);
    const expired = await queueFileDelivery({ db: ctx.db, orderId: seeded.orderId });
    expect(expired.ok).toBe(true);
    if (!expired.ok) return;
    const noResend = recordingSender({ fileId: "must_not_send_while_parking" });
    await expect(
      processFileDelivery({
        db: ctx.db,
        job: expired.job,
        storageRoots: [storageRoot],
        sender: noResend,
      }),
    ).resolves.toEqual({ ok: false, code: "SEND_UNCERTAIN" });
    expect(noResend.calls).toHaveLength(0);

    const orderVersion = (
      await sql<{
        version: number;
      }>`select version from "order" where id = ${seeded.orderId}`.execute(ctx.db)
    ).rows[0]!.version;
    const requeued = await resolveUncertainFileDelivery({
      db: ctx.db,
      orderId: seeded.orderId,
      expectedOrderVersion: orderVersion,
      expectedClaimGeneration: expired.job.claimGeneration,
      artifactId: seeded.artifactId,
      artifactVersion: 1,
      artifactSha256: seeded.hash,
      telegramChatId: expired.job.telegramChatId,
      operatorId: "9001",
      reason: "Owner explicitly chose a controlled retry",
      decision: "REQUEUE",
      correlationId: "file-recovery-newer-generation",
    });
    expect(requeued).toMatchObject({ ok: true, requeued: true, job: { status: "QUEUED" } });
    if (!requeued.ok) return;

    const retryEntered = Promise.withResolvers<void>();
    const releaseRetry = Promise.withResolvers<void>();
    const retrySender: TelegramDocumentSender = {
      async sendDocument() {
        retryEntered.resolve();
        await releaseRetry.promise;
        return {
          fileId: "new_generation_file_id",
          fileUniqueId: "new_generation_unique_id",
          messageId: "new_generation_message_id",
        };
      },
    };
    const retrySend = processFileDelivery({
      db: ctx.db,
      job: requeued.job,
      storageRoots: [storageRoot],
      sender: retrySender,
    });
    await retryEntered.promise;

    releaseOriginal.resolve();
    await expect(originalSend).resolves.toEqual({ ok: false, code: "STALE_JOB" });
    releaseRetry.resolve();
    await expect(retrySend).resolves.toMatchObject({
      ok: true,
      job: {
        status: "SENT",
        claimGeneration: queued.job.claimGeneration + 2,
        telegramFileId: "new_generation_file_id",
      },
    });

    const state = await sql<{
      order_status: string;
      job_file_id: string | null;
      artifact_file_id: string | null;
      sent_count: string;
      uncertain_count: string;
      receipt_message_id: string | null;
    }>`
      select o.status as order_status,
        j.telegram_file_id as job_file_id,
        a.telegram_file_id as artifact_file_id,
        (
          select count(*)::text from audit_event
          where action = 'file_delivery.sent' and target_id = ${seeded.orderId}
        ) as sent_count,
        (
          select count(*)::text from audit_event
          where action = 'file_delivery.uncertain' and target_id = ${seeded.orderId}
        ) as uncertain_count,
        (
          select metadata_redacted->>'telegramMessageId'
          from audit_event
          where action = 'file_delivery.sent' and target_id = ${seeded.orderId}
          limit 1
        ) as receipt_message_id
      from "order" o
      join file_delivery_job j on j.order_id = o.id
      join variant_file_artifact a on a.id = ${seeded.artifactId}
      where o.id = ${seeded.orderId}
    `.execute(ctx.db);
    expect(state.rows[0]).toEqual({
      order_status: "COMPLETED",
      job_file_id: "new_generation_file_id",
      artifact_file_id: "new_generation_file_id",
      sent_count: "1",
      uncertain_count: "1",
      receipt_message_id: "new_generation_message_id",
    });
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

  it("parks an expired processing lease as uncertain without sending", async () => {
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
    const sender = recordingSender({ fileId: "expired_lease_unused_file_id_1234567890" });

    await expect(
      processFileDelivery({ db: ctx.db, job: refreshed.job, storageRoots: [storageRoot], sender }),
    ).resolves.toEqual({ ok: false, code: "SEND_UNCERTAIN" });
    expect(sender.calls).toHaveLength(0);

    const state = await sql<{
      status: string;
      last_error: string | null;
      processing_expires_at: Date | null;
    }>`
      select status, last_error, processing_expires_at
      from file_delivery_job
      where order_id = ${seeded.orderId}
    `.execute(ctx.db);
    expect(state.rows[0]).toMatchObject({
      status: "FAILED",
      last_error: "SEND_UNCERTAIN",
      processing_expires_at: null,
    });
  });

  it("parks a lease that expires after artifact retrieval before sending", async () => {
    const seeded = await seedPaidDigitalOrder();
    const queued = await queueFileDelivery({ db: ctx.db, orderId: seeded.orderId });
    expect(queued.ok).toBe(true);
    if (!queued.ok) return;
    const sender = recordingSender({ fileId: "post-retrieval-expiry_unused_file_id" });
    const realNow = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(realNow + 301_000);

    try {
      await expect(
        processFileDelivery({ db: ctx.db, job: queued.job, storageRoots: [storageRoot], sender }),
      ).resolves.toEqual({ ok: false, code: "SEND_UNCERTAIN" });
    } finally {
      clock.mockRestore();
    }

    expect(sender.calls).toHaveLength(0);
    const state = await sql<{ status: string; last_error: string | null }>`
      select status, last_error
      from file_delivery_job
      where order_id = ${seeded.orderId}
    `.execute(ctx.db);
    expect(state.rows).toEqual([{ status: "FAILED", last_error: "SEND_UNCERTAIN" }]);

    const audit = await sql<{
      target_id: string;
      order_id: string;
      artifact_id: string;
      claim_generation: string;
      outcome: string;
    }>`
      select
        target_id,
        metadata_redacted->>'orderId' as order_id,
        metadata_redacted->>'artifactId' as artifact_id,
        metadata_redacted->>'claimGeneration' as claim_generation,
        metadata_redacted->>'outcome' as outcome
      from audit_event
      where action = 'file_delivery.uncertain'
        and target_type = 'FileDeliveryJob'
        and target_id = ${seeded.orderId}
    `.execute(ctx.db);
    expect(audit.rows).toEqual([
      {
        target_id: seeded.orderId,
        order_id: seeded.orderId,
        artifact_id: seeded.artifactId,
        claim_generation: "1",
        outcome: "UNKNOWN",
      },
    ]);
  });

  it("audits exactly one uncertain event when an expired lease is parked", async () => {
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
    expect(refreshed.ok).toBe(true);
    if (!refreshed.ok) return;

    await expect(
      processFileDelivery({
        db: ctx.db,
        job: refreshed.job,
        storageRoots: [storageRoot],
        sender: recordingSender({ fileId: "expired_lease_audit_unused_file_id" }),
      }),
    ).resolves.toEqual({ ok: false, code: "SEND_UNCERTAIN" });

    const audit = await sql<{
      action: string;
      target_type: string;
      target_id: string;
      actor_type: string;
      actor_id: string;
      correlation_id: string;
      order_id: string;
      job_id: string;
      artifact_id: string;
      artifact_version: string;
      artifact_sha256: string;
      claim_generation: string;
      attempt_count: string;
      outcome: string;
    }>`
      select
        action,
        target_type,
        target_id,
        actor_type,
        actor_id,
        correlation_id,
        metadata_redacted->>'orderId' as order_id,
        metadata_redacted->>'jobId' as job_id,
        metadata_redacted->>'artifactId' as artifact_id,
        metadata_redacted->>'artifactVersion' as artifact_version,
        metadata_redacted->>'artifactSha256' as artifact_sha256,
        metadata_redacted->>'claimGeneration' as claim_generation,
        metadata_redacted->>'attemptCount' as attempt_count,
        metadata_redacted->>'outcome' as outcome
      from audit_event
      where action = 'file_delivery.uncertain'
        and target_type = 'FileDeliveryJob'
        and target_id = ${seeded.orderId}
    `.execute(ctx.db);
    expect(audit.rows).toEqual([
      {
        action: "file_delivery.uncertain",
        target_type: "FileDeliveryJob",
        target_id: seeded.orderId,
        actor_type: "SYSTEM",
        actor_id: "file-delivery",
        correlation_id: `file-delivery:${seeded.orderId}:1:uncertain`,
        order_id: seeded.orderId,
        job_id: seeded.orderId,
        artifact_id: seeded.artifactId,
        artifact_version: "1",
        artifact_sha256: seeded.hash,
        claim_generation: "1",
        attempt_count: "0",
        outcome: "UNKNOWN",
      },
    ]);
  });
  it("requires recovery authority to match the job's persisted Telegram chat", async () => {
    const { seeded, job, version } = await seedUncertainDelivery();

    const result = await resolveUncertainFileDelivery({
      db: ctx.db,
      orderId: seeded.orderId,
      expectedOrderVersion: version,
      expectedClaimGeneration: job.claimGeneration,
      artifactId: seeded.artifactId,
      artifactVersion: job.artifactVersion,
      artifactSha256: job.artifactSha256,
      telegramChatId: "777777",
      operatorId: "9001",
      reason: "sibling Telegram identity must not authorize recovery",
      decision: "REQUEUE",
      correlationId: "file-recovery-wrong-chat",
    });
    expect(result).toEqual({ ok: false, code: "STALE_JOB" });

    const current = await sql<{
      status: string;
      last_error: string | null;
      claim_generation: number;
    }>`
      select status, last_error, claim_generation
      from file_delivery_job
      where order_id = ${seeded.orderId}
    `.execute(ctx.db);
    expect(current.rows[0]).toEqual({
      status: "FAILED",
      last_error: "SEND_UNCERTAIN",
      claim_generation: job.claimGeneration,
    });
  });

  it("binds a recovery callback to its original file-delivery generation and chat", async () => {
    const { seeded, job } = await seedUncertainDelivery();
    const detail = await getAdminOrderDetail(ctx.db, {
      adminTelegramUserId: "9001",
      orderId: seeded.orderId,
    });
    expect(detail?.fileDelivery).toMatchObject({
      jobId: seeded.orderId,
      status: "FAILED",
      lastError: "SEND_UNCERTAIN",
      artifactId: seeded.artifactId,
      artifactVersion: job.artifactVersion,
      artifactSha256: job.artifactSha256,
      claimGeneration: job.claimGeneration,
    });
    if (!detail) return;

    const original = await resolveAdminOrderState(ctx.db, {
      adminTelegramUserId: "9001",
      stateId: detail.messageStateId,
    });
    expect(original).toMatchObject({
      kind: "ORDER_MESSAGE_PROMPT",
      orderId: seeded.orderId,
      fileDelivery: {
        jobId: seeded.orderId,
        status: "FAILED",
        lastError: "SEND_UNCERTAIN",
        artifactId: seeded.artifactId,
        artifactVersion: job.artifactVersion,
        artifactSha256: job.artifactSha256,
        claimGeneration: job.claimGeneration,
        telegramChatId: job.telegramChatId,
      },
    });

    await sql`
      update file_delivery_job
      set claim_generation = claim_generation + 1
      where order_id = ${seeded.orderId}
    `.execute(ctx.db);
    const replayed = await resolveAdminOrderState(ctx.db, {
      adminTelegramUserId: "9001",
      stateId: detail.messageStateId,
    });
    expect(replayed?.fileDelivery).toMatchObject({
      claimGeneration: job.claimGeneration,
      telegramChatId: job.telegramChatId,
    });
  });

  it.each(["CLOSED", "TEST"] as const)(
    "rejects a public non-allowlisted requeue while store is %s without mutation",
    async (mode) => {
      const { seeded, job, version } = await seedUncertainDelivery();
      await setStoreModeForTest(ctx.db, mode, "file-delivery-policy-test");

      const result = await resolveUncertainFileDelivery({
        db: ctx.db,
        orderId: seeded.orderId,
        expectedOrderVersion: version,
        expectedClaimGeneration: job.claimGeneration,
        artifactId: seeded.artifactId,
        artifactVersion: job.artifactVersion,
        artifactSha256: job.artifactSha256,
        telegramChatId: job.telegramChatId,
        operatorId: "9001",
        reason: "closed-mode recovery policy regression",
        decision: "REQUEUE",
        correlationId: `file-recovery-policy-refused-${mode}`,
      });
      expect(result).toEqual({ ok: false, code: "STORE_MODE_POLICY" });

      const state = await sql<{
        status: string;
        last_error: string | null;
        claim_generation: number;
        outbox_count: string;
        recovery_audit_count: string;
      }>`
        select
          j.status,
          j.last_error,
          j.claim_generation,
          (select count(*)::text from outbox_event
             where aggregate_type = 'FileDeliveryJob' and aggregate_id = ${seeded.orderId}) as outbox_count,
          (select count(*)::text from audit_event
             where action = 'file_delivery.recovery'
               and target_type = 'FileDeliveryJob'
               and target_id = ${seeded.orderId}) as recovery_audit_count
        from file_delivery_job j
        where j.order_id = ${seeded.orderId}
      `.execute(ctx.db);
      expect(state.rows[0]).toEqual({
        status: "FAILED",
        last_error: "SEND_UNCERTAIN",
        claim_generation: job.claimGeneration,
        outbox_count: "0",
        recovery_audit_count: "0",
      });
    },
  );
  it.each(["CLOSED", "TEST"] as const)(
    "rejects recovery when an allowlisted sibling identity is not the job recipient while store is %s",
    async (mode) => {
      const { seeded, job, version } = await seedUncertainDelivery({ isTest: true });
      expect(job.telegramChatId).toBe("123456");
      await sql`
        insert into channel_identity (id, customer_id, channel, channel_user_id)
        values (${newId()}, ${seeded.customerId}, 'TELEGRAM', '777777')
      `.execute(ctx.db);
      await sql`
        insert into test_customer_allowlist (id, telegram_user_id, note, added_by)
        values (${newId()}, '777777', 'file delivery sibling identity', '9001')
      `.execute(ctx.db);
      await setStoreModeForTest(ctx.db, mode, "file-delivery-policy-test");

      const result = await resolveUncertainFileDelivery({
        db: ctx.db,
        orderId: seeded.orderId,
        expectedOrderVersion: version,
        expectedClaimGeneration: job.claimGeneration,
        artifactId: seeded.artifactId,
        artifactVersion: job.artifactVersion,
        artifactSha256: job.artifactSha256,
        telegramChatId: job.telegramChatId,
        operatorId: "9001",
        reason: "sibling identity authorization regression",
        decision: "REQUEUE",
        correlationId: `file-recovery-policy-sibling-refused-${mode}`,
      });
      expect(result).toEqual({ ok: false, code: "STORE_MODE_POLICY" });

      const state = await sql<{
        status: string;
        last_error: string | null;
        claim_generation: number;
        outbox_count: string;
        recovery_audit_count: string;
      }>`
        select
          j.status,
          j.last_error,
          j.claim_generation,
          (select count(*)::text from outbox_event
             where aggregate_type = 'FileDeliveryJob' and aggregate_id = ${seeded.orderId}) as outbox_count,
          (select count(*)::text from audit_event
             where action = 'file_delivery.recovery'
               and target_type = 'FileDeliveryJob'
               and target_id = ${seeded.orderId}) as recovery_audit_count
        from file_delivery_job j
        where j.order_id = ${seeded.orderId}
      `.execute(ctx.db);
      expect(state.rows[0]).toEqual({
        status: "FAILED",
        last_error: "SEND_UNCERTAIN",
        claim_generation: job.claimGeneration,
        outbox_count: "0",
        recovery_audit_count: "0",
      });
    },
  );

  it.each(["CLOSED", "TEST"] as const)(
    "accepts a test product for an allowlisted customer while store is %s",
    async (mode) => {
      const { seeded, job, version } = await seedUncertainDelivery({ isTest: true });
      await sql`
        insert into test_customer_allowlist (id, telegram_user_id, note, added_by)
        values (${newId()}, '123456', 'file delivery test', '9001')
      `.execute(ctx.db);
      await setStoreModeForTest(ctx.db, mode, "file-delivery-policy-test");

      const result = await resolveUncertainFileDelivery({
        db: ctx.db,
        orderId: seeded.orderId,
        expectedOrderVersion: version,
        expectedClaimGeneration: job.claimGeneration,
        artifactId: seeded.artifactId,
        artifactVersion: job.artifactVersion,
        artifactSha256: job.artifactSha256,
        telegramChatId: job.telegramChatId,
        operatorId: "9001",
        reason: "allowlisted test recovery",
        decision: "REQUEUE",
        correlationId: `file-recovery-policy-allowlisted-${mode}`,
      });
      expect(result).toMatchObject({ ok: true, decision: "REQUEUE", requeued: true });
    },
  );

  it("accepts a root-admin customer's test order while store is CLOSED", async () => {
    const { seeded, job, version } = await seedUncertainDelivery({
      isTest: true,
      telegramUserId: "9001",
    });
    await setStoreModeForTest(ctx.db, "CLOSED", "file-delivery-policy-test");

    const result = await resolveUncertainFileDelivery({
      db: ctx.db,
      orderId: seeded.orderId,
      expectedOrderVersion: version,
      expectedClaimGeneration: job.claimGeneration,
      artifactId: seeded.artifactId,
      artifactVersion: job.artifactVersion,
      artifactSha256: job.artifactSha256,
      telegramChatId: job.telegramChatId,
      operatorId: "9001",
      reason: "root-admin test recovery",
      decision: "REQUEUE",
      correlationId: "file-recovery-policy-root",
    });
    expect(result).toMatchObject({ ok: true, decision: "REQUEUE", requeued: true });
  });

  it("accepts a normal order requeue while store is OPEN", async () => {
    const { seeded, job, version } = await seedUncertainDelivery();
    await setStoreModeForTest(ctx.db, "OPEN", "file-delivery-policy-test");

    const result = await resolveUncertainFileDelivery({
      db: ctx.db,
      orderId: seeded.orderId,
      expectedOrderVersion: version,
      expectedClaimGeneration: job.claimGeneration,
      artifactId: seeded.artifactId,
      artifactVersion: job.artifactVersion,
      artifactSha256: job.artifactSha256,
      telegramChatId: job.telegramChatId,
      operatorId: "9001",
      reason: "open-mode recovery",
      decision: "REQUEUE",
      correlationId: "file-recovery-policy-open",
    });
    expect(result).toMatchObject({ ok: true, decision: "REQUEUE", requeued: true });
  });

  it("records an audited default resolution without requeueing uncertain delivery", async () => {
    const seeded = await seedPaidDigitalOrder();
    const queued = await queueFileDelivery({ db: ctx.db, orderId: seeded.orderId });
    expect(queued.ok).toBe(true);
    if (!queued.ok) return;
    const sender: TelegramDocumentSender = {
      async sendDocument() {
        throw new Error("timeout after remote acceptance");
      },
    };
    await expect(
      processFileDelivery({ db: ctx.db, job: queued.job, storageRoots: [storageRoot], sender }),
    ).resolves.toEqual({ ok: false, code: "SEND_UNCERTAIN" });

    const version = (
      await sql<{
        version: number;
      }>`select version from "order" where id = ${seeded.orderId}`.execute(ctx.db)
    ).rows[0]!.version;
    const resolved = await resolveUncertainFileDelivery({
      db: ctx.db,
      orderId: seeded.orderId,
      expectedOrderVersion: version,
      artifactId: seeded.artifactId,
      artifactVersion: 1,
      artifactSha256: seeded.hash,
      telegramChatId: queued.job.telegramChatId,
      operatorId: "9001",
      reason: "Telegram send outcome requires review",
      correlationId: "file-recovery-default-1",
    });
    expect(resolved).toMatchObject({
      ok: true,
      decision: "KEEP_UNCERTAIN",
      requeued: false,
      job: { orderId: seeded.orderId, artifactId: seeded.artifactId, status: "FAILED" },
    });

    const audit = await sql<{
      actor_id: string;
      reason: string;
      target_id: string;
      decision: string;
      artifact_id: string;
      order_id: string;
    }>`
      select
        actor_id,
        reason,
        target_id,
        metadata_redacted->>'decision' as decision,
        metadata_redacted->>'artifactId' as artifact_id,
        metadata_redacted->>'orderId' as order_id
      from audit_event
      where action = 'file_delivery.recovery'
        and target_type = 'FileDeliveryJob'
        and target_id = ${seeded.orderId}
      order by occurred_at desc, id desc
      limit 1
    `.execute(ctx.db);
    expect(audit.rows[0]).toEqual({
      actor_id: "9001",
      reason: "Telegram send outcome requires review",
      target_id: seeded.orderId,
      decision: "KEEP_UNCERTAIN",
      artifact_id: seeded.artifactId,
      order_id: seeded.orderId,
    });
    const detail = await getAdminOrderDetail(ctx.db, {
      adminTelegramUserId: "9001",
      orderId: seeded.orderId,
    });
    expect(detail?.fileDelivery).toMatchObject({
      jobId: seeded.orderId,
      status: "FAILED",
      outcome: "UNKNOWN",
      lastError: "SEND_UNCERTAIN",
      artifactId: seeded.artifactId,
      artifactVersion: 1,
      artifactSha256: seeded.hash,
    });

    const replay = recordingSender({ fileId: "must_not_resend" });
    await expect(
      processFileDelivery({
        db: ctx.db,
        job: queued.job,
        storageRoots: [storageRoot],
        sender: replay,
      }),
    ).resolves.toEqual({ ok: false, code: "SEND_UNCERTAIN" });
    expect(replay.calls).toHaveLength(0);
  });

  it("rejects stale operator resolution and only explicitly requeues the existing job", async () => {
    const seeded = await seedPaidDigitalOrder();
    const queued = await queueFileDelivery({ db: ctx.db, orderId: seeded.orderId });
    expect(queued.ok).toBe(true);
    if (!queued.ok) return;
    const sender: TelegramDocumentSender = {
      async sendDocument() {
        throw new Error("ambiguous remote outcome");
      },
    };
    await processFileDelivery({ db: ctx.db, job: queued.job, storageRoots: [storageRoot], sender });
    const current = await queueFileDelivery({ db: ctx.db, orderId: seeded.orderId });
    expect(current.ok).toBe(true);
    if (!current.ok) return;
    const version = (
      await sql<{
        version: number;
      }>`select version from "order" where id = ${seeded.orderId}`.execute(ctx.db)
    ).rows[0]!.version;

    await expect(
      resolveUncertainFileDelivery({
        db: ctx.db,
        orderId: seeded.orderId,
        expectedOrderVersion: version - 1,
        artifactId: seeded.artifactId,
        artifactVersion: 1,
        artifactSha256: seeded.hash,
        telegramChatId: current.job.telegramChatId,
        operatorId: "9001",
        reason: "stale operator view",
        correlationId: "file-recovery-stale-1",
      }),
    ).resolves.toEqual({ ok: false, code: "STALE_ORDER" });
    await expect(
      resolveUncertainFileDelivery({
        db: ctx.db,
        orderId: seeded.orderId,
        expectedOrderVersion: version,
        expectedClaimGeneration: current.job.claimGeneration,
        artifactId: seeded.artifactId,
        artifactVersion: 1,
        artifactSha256: "f".repeat(64),
        telegramChatId: current.job.telegramChatId,
        operatorId: "9001",
        reason: "stale artifact view",
        correlationId: "file-recovery-stale-artifact-1",
      }),
    ).resolves.toEqual({ ok: false, code: "STALE_JOB" });

    await expect(
      resolveUncertainFileDelivery({
        db: ctx.db,
        orderId: seeded.orderId,
        expectedOrderVersion: version,
        expectedClaimGeneration: current.job.claimGeneration + 1,
        artifactId: seeded.artifactId,
        artifactVersion: 1,
        artifactSha256: seeded.hash,
        telegramChatId: current.job.telegramChatId,
        operatorId: "9001",
        reason: "stale generation view",
        correlationId: "file-recovery-stale-generation-1",
      }),
    ).resolves.toEqual({ ok: false, code: "STALE_JOB" });

    const requeued = await resolveUncertainFileDelivery({
      db: ctx.db,
      orderId: seeded.orderId,
      expectedOrderVersion: version,
      expectedClaimGeneration: current.job.claimGeneration,
      artifactId: seeded.artifactId,
      artifactVersion: 1,
      artifactSha256: seeded.hash,
      telegramChatId: current.job.telegramChatId,
      operatorId: "9001",
      reason: "Owner explicitly chose one controlled retry",
      decision: "REQUEUE",
      correlationId: "file-recovery-requeue-1",
    });
    expect(requeued).toMatchObject({
      ok: true,
      decision: "REQUEUE",
      requeued: true,
      job: { orderId: seeded.orderId, status: "QUEUED", artifactId: seeded.artifactId },
    });
    const count = await sql<{ jobs: string; artifacts: string }>`
      select
        count(*)::text as jobs,
        (select count(*)::text from variant_file_artifact where id = ${seeded.artifactId}) as artifacts
      from file_delivery_job
      where order_id = ${seeded.orderId}
    `.execute(ctx.db);
    expect(count.rows[0]).toEqual({ jobs: "1", artifacts: "1" });
    if (!requeued.ok) return;
    const retrySender = recordingSender({
      fileId: "controlled_retry_file_id",
      messageId: "controlled_retry_message_id",
    });
    await expect(
      processFileDelivery({
        db: ctx.db,
        job: requeued.job,
        storageRoots: [storageRoot],
        sender: retrySender,
      }),
    ).resolves.toMatchObject({ ok: true, job: { status: "SENT", artifactId: seeded.artifactId } });
    expect(retrySender.calls).toHaveLength(1);
  });
});
