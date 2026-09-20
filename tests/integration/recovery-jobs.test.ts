import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { newId } from "../../src/shared/ids/index.js";
import { recoverExpiredOrdersBatch } from "../../src/modules/commerce/recovery.js";
import { recoverSePayBatch } from "../../src/modules/payments/recovery.js";
import { recoverSupplierOrdersBatch } from "../../src/modules/supplier/recovery.js";
import {
  recoverExpiredDeliveryBundlesBatch,
  recoverStaleReservationsBatch,
  releaseReadyAssetInTransaction,
} from "../../src/modules/digital-goods/recovery.js";
import type { PaymentEvidence } from "../../src/modules/payments/domain.js";
import type { SePayReconciliationPort } from "../../src/modules/payments/reconciliation.js";
import { SePayApiError } from "../../src/modules/payments/sepay-api.js";
import { createInMemoryRateLimiter } from "../../src/modules/risk/service.js";
import type { SupplierPort } from "../../src/modules/supplier/port.js";
import { createInMemoryVault } from "../../src/infrastructure/vault/testing-adapter.js";
import { verifiedSePayEvidence } from "../helpers/verified-sepay.js";
import { startPostgresContainer, type PgTestContext } from "../helpers/pg-container.js";
/**
 * T167 — bounded crash-recovery jobs.
 *
 * Public seams under test are the five exported batch commands. Assertions cover
 * observable database state plus their common backlog/oldest-age telemetry; no
 * private selector/helper is imported.
 */

let ctx: PgTestContext;
async function sePayCursorRow(): Promise<{
  window_from_sec: number;
  window_to_sec: number;
  page: number;
  per_page: number;
  generation: number;
} | null> {
  const row = await sql<{
    window_from_sec: number;
    window_to_sec: number;
    page: number;
    per_page: number;
    generation: number;
  }>`
    select window_from_sec, window_to_sec, page, per_page, generation
    from sepay_reconciliation_cursor
    where provider = 'sepay'
  `.execute(ctx.db);
  return row.rows[0] ?? null;
}

beforeAll(async () => {
  ctx = await startPostgresContainer();
}, 180_000);

afterAll(async () => {
  await ctx?.teardown();
});

beforeEach(async () => {
  await sql`
    truncate table sepay_reconciliation_cursor, delivery_bundle, digital_asset, supplier_order, supplier_sku, supplier,
      outbox_event, payment_allocation, discrepancy, bank_transaction, payment_intent,
      order_transition, "order", product_variant, product, category, customer cascade
  `.execute(ctx.db);
  await sql`drop trigger if exists recovery_poison_reservation on digital_asset`.execute(ctx.db);
  await sql`drop function if exists recovery_fail_poison_reservation()`.execute(ctx.db);
});

interface CommerceSeed {
  customerId: string;
  variantId: string;
}

async function seedCommerce(): Promise<CommerceSeed> {
  const customerId = newId();
  const categoryId = newId();
  const productId = newId();
  const variantId = newId();
  const slug = categoryId.slice(-8);
  await sql`insert into customer (id, status, locale) values (${customerId}, 'ACTIVE', 'vi')`.execute(
    ctx.db,
  );
  await sql`insert into category (id, name_vi, slug, is_active, sort_order) values (${categoryId}, 'C', ${slug}, true, 1)`.execute(
    ctx.db,
  );
  await sql`insert into product (id, category_id, name_vi, slug, is_active, sort_order) values (${productId}, ${categoryId}, 'P', ${slug}, true, 1)`.execute(
    ctx.db,
  );
  await sql`
    insert into product_variant
      (id, product_id, sku, name_vi, price_vnd, duration_code, delivery_type,
       stock_policy, resale_evidence_id, is_active, sort_order)
    values
      (${variantId}, ${productId}, ${"SKU-" + variantId}, 'V', 150000, 'P1M', 'CREDENTIAL',
       'LOCAL_ONLY', 'RES-1', true, 1)
  `.execute(ctx.db);
  return { customerId, variantId };
}

async function seedOrder(
  seed: CommerceSeed,
  input: { status?: string; expiresAt?: Date; createdAt?: Date } = {},
): Promise<{ orderId: string; intentId: string; content: string; account: string }> {
  const orderId = newId();
  const intentId = newId();
  const content = "ORD" + newId().slice(-12);
  const account = "0123456789";
  const status = input.status ?? "PENDING_PAYMENT";
  const expiresAt = input.expiresAt ?? new Date(Date.now() + 15 * 60_000);
  const createdAt = input.createdAt ?? new Date();
  await sql`
    insert into "order"
      (id, order_number, customer_id, variant_id, product_name_vi, variant_name_vi,
       price_vnd, duration_code, delivery_type, status, expires_at, created_at, updated_at)
    values
      (${orderId}, ${"ORD-" + orderId}, ${seed.customerId}, ${seed.variantId}, 'P', 'V',
       150000, 'P1M', 'CREDENTIAL', ${status}, ${expiresAt.toISOString()},
       ${createdAt.toISOString()}, ${createdAt.toISOString()})
  `.execute(ctx.db);
  await sql`
    insert into payment_intent
      (id, order_id, status, amount_vnd, merchant_account_id, transfer_content,
       expires_at, presented_at, created_at)
    values
      (${intentId}, ${orderId}, 'PRESENTED', 150000, ${account}, ${content},
       ${expiresAt.toISOString()}, ${createdAt.toISOString()}, ${createdAt.toISOString()})
  `.execute(ctx.db);
  return { orderId, intentId, content, account };
}

async function seedReservedAsset(
  seed: CommerceSeed,
  orderId: string,
  reservedUntil: Date,
  fingerprint = "fp-" + newId(),
): Promise<string> {
  const assetId = newId();
  await sql`
    insert into digital_asset
      (id, variant_id, source_type, vault_ref, fingerprint_hash, status,
       reserved_order_id, reserved_until, created_at, updated_at)
    values
      (${assetId}, ${seed.variantId}, 'LOCAL', ${"vault:" + assetId}, ${fingerprint},
       'RESERVED', ${orderId}, ${reservedUntil.toISOString()}, now(), now())
  `.execute(ctx.db);
  return assetId;
}

describe("bounded recovery jobs (T167/T168)", () => {
  it("releases an unpaid READY asset only after the payment and delivery proofs are clear", async () => {
    const seed = await seedCommerce();
    const order = await seedOrder(seed, { status: "CANCELLED" });
    await sql`update payment_intent set status = 'EXPIRED' where id = ${order.intentId}`.execute(
      ctx.db,
    );
    const assetId = newId();
    await sql`
      insert into digital_asset
        (id, variant_id, source_type, vault_ref, fingerprint_hash, status,
         reserved_order_id, reserved_until, version)
      values
        (${assetId}, ${seed.variantId}, 'LOCAL', ${"vault:" + assetId}, ${"fp-" + assetId},
         'READY', ${order.orderId}, now() - interval '1 minute', 7)
    `.execute(ctx.db);

    const result = await releaseReadyAssetInTransaction(ctx.db, {
      assetId,
      expectedVersion: 7,
      actorId: "1",
      reason: "test stale unpaid delivery",
      correlationId: "recovery-test-unpaid",
      requestId: "request-unpaid-1",
    });

    expect(result).toMatchObject({ ok: true, newVersion: 8 });
    const row = await sql<{ status: string; version: number; reserved_order_id: string | null }>`
      select status, version, reserved_order_id from digital_asset where id = ${assetId}
    `.execute(ctx.db);
    expect(row.rows[0]).toEqual({ status: "AVAILABLE", version: 8, reserved_order_id: null });
  });
  it("releases a cancelled READY asset after the payment intent was fully refunded", async () => {
    const seed = await seedCommerce();
    const order = await seedOrder(seed, { status: "CANCELLED" });
    await sql`update payment_intent set status = 'REFUNDED' where id = ${order.intentId}`.execute(
      ctx.db,
    );
    const assetId = newId();
    await sql`
      insert into digital_asset
        (id, variant_id, source_type, vault_ref, fingerprint_hash, status,
         reserved_order_id, reserved_until, version)
      values
        (${assetId}, ${seed.variantId}, 'LOCAL', ${"vault:" + assetId}, ${"fp-" + assetId},
         'READY', ${order.orderId}, now() + interval '15 minutes', 3)
    `.execute(ctx.db);

    const result = await releaseReadyAssetInTransaction(ctx.db, {
      assetId,
      expectedVersion: 3,
      actorId: "1",
      reason: "test refunded unpaid delivery",
      correlationId: "recovery-test-refunded",
      requestId: "request-refunded-1",
    });

    expect(result).toMatchObject({ ok: true, newVersion: 4 });
  });
  it("refuses an open refund obligation even when payment and delivery proofs are clear", async () => {
    const seed = await seedCommerce();
    const order = await seedOrder(seed, { status: "CANCELLED" });
    await sql`update payment_intent set status = 'EXPIRED' where id = ${order.intentId}`.execute(
      ctx.db,
    );
    await sql`
      insert into shop_refund_obligation
        (id, customer_id, amount_vnd, status, reason, created_by, order_id)
      values
        (${newId()}, ${seed.customerId}, 150000, 'OPEN', 'recovery regression', 'ROOT_ADMIN', ${order.orderId})
    `.execute(ctx.db);
    const assetId = newId();
    await sql`
      insert into digital_asset
        (id, variant_id, source_type, vault_ref, fingerprint_hash, status,
         reserved_order_id, reserved_until, version)
      values
        (${assetId}, ${seed.variantId}, 'LOCAL', ${"vault:" + assetId}, ${"fp-" + assetId},
         'READY', ${order.orderId}, now() + interval '15 minutes', 3)
    `.execute(ctx.db);

    const result = await releaseReadyAssetInTransaction(ctx.db, {
      assetId,
      expectedVersion: 3,
      actorId: "1",
      reason: "test open refund obligation",
      correlationId: "recovery-test-refund",
      requestId: "request-refund-1",
    });

    expect(result).toEqual({ ok: false, code: "RECOVERY_NOT_SAFE" });
    const row = await sql<{ status: string; version: number }>`
      select status, version from digital_asset where id = ${assetId}
    `.execute(ctx.db);
    expect(row.rows[0]).toEqual({ status: "READY", version: 3 });
  });

  it("refuses the historical paid READY plus live bundle state without mutation", async () => {
    const seed = await seedCommerce();
    const order = await seedOrder(seed, { status: "PROCESSING" });
    await sql`
      update payment_intent
      set status = 'SUCCEEDED', settled_at = now()
      where id = ${order.intentId}
    `.execute(ctx.db);
    const bankTransactionId = newId();
    await sql`
      insert into bank_transaction
        (id, provider, provider_transaction_id, direction, merchant_account_id,
         amount_vnd, content, transacted_at, raw_hash, signature_status, schema_version)
      values
        (${bankTransactionId}, 'sepay', ${"test-" + bankTransactionId}, 'IN', ${order.account},
         150000, ${order.content}, now(), ${"hash-" + bankTransactionId}, 'VERIFIED', 'v2')
    `.execute(ctx.db);
    await sql`
      insert into payment_allocation
        (id, bank_transaction_id, payment_intent_id, allocated_amount_vnd,
         status, decision_code, correlation_id)
      values
        (${newId()}, ${bankTransactionId}, ${order.intentId}, 150000,
         'SETTLED', 'SETTLED', 'recovery-test-paid')
    `.execute(ctx.db);
    const assetId = newId();
    const bundleId = newId();
    await sql`
      insert into digital_asset
        (id, variant_id, source_type, vault_ref, fingerprint_hash, status,
         reserved_order_id, reserved_until, version)
      values
        (${assetId}, ${seed.variantId}, 'LOCAL', ${"vault:" + assetId}, ${"fp-" + assetId},
         'READY', ${order.orderId}, now() + interval '15 minutes', 3)
    `.execute(ctx.db);
    await sql`
      insert into delivery_bundle
        (id, order_id, customer_id, asset_id, token_hash, status, expires_at)
      values
        (${bundleId}, ${order.orderId}, ${seed.customerId}, ${assetId},
         ${"hash-" + bundleId}, 'AVAILABLE', now() + interval '1 day')
    `.execute(ctx.db);
    await sql`
      insert into delivery_notification_handoff
        (id, bundle_id, customer_id, telegram_chat_id, capability_key,
         capability_ref, status, sent_at)
      values
        (${newId()}, ${bundleId}, ${seed.customerId}, '123456789', ${bundleId + ":123456789"},
         ${"vault:capability-test"}, 'SENT', now())
    `.execute(ctx.db);

    const result = await releaseReadyAssetInTransaction(ctx.db, {
      assetId,
      expectedVersion: 3,
      actorId: "1",
      reason: "test must not release paid delivery",
      correlationId: "recovery-test-paid",
      requestId: "request-paid-1",
    });

    expect(result).toEqual({ ok: false, code: "RECOVERY_NOT_SAFE" });
    const row = await sql<{ status: string; version: number; reserved_order_id: string | null }>`
      select status, version, reserved_order_id from digital_asset where id = ${assetId}
    `.execute(ctx.db);
    expect(row.rows[0]).toEqual({
      status: "READY",
      version: 3,
      reserved_order_id: order.orderId,
    });
  });
  it("expires only the bounded oldest Order batch and atomically voids intents/releases holds", async () => {
    const seed = await seedCommerce();
    const now = new Date();
    const oldest = await seedOrder(seed, {
      expiresAt: new Date(now.getTime() - 180_000),
      createdAt: new Date(now.getTime() - 300_000),
    });
    const middle = await seedOrder(seed, {
      expiresAt: new Date(now.getTime() - 120_000),
      createdAt: new Date(now.getTime() - 240_000),
    });
    const newest = await seedOrder(seed, {
      expiresAt: new Date(now.getTime() - 60_000),
      createdAt: new Date(now.getTime() - 180_000),
    });
    await seedReservedAsset(seed, oldest.orderId, new Date(now.getTime() - 180_000));
    await seedReservedAsset(seed, middle.orderId, new Date(now.getTime() - 120_000));
    await seedReservedAsset(seed, newest.orderId, new Date(now.getTime() - 60_000));

    const result = await recoverExpiredOrdersBatch(ctx.db, { batchSize: 2, now });

    expect(result).toMatchObject({ claimed: 2, succeeded: 2, failed: 0, backlog: 1 });
    expect(result.oldestAgeSeconds).toBeGreaterThanOrEqual(59);
    const rows = await sql<{ id: string; status: string }>`
      select id, status from "order" where id in (${oldest.orderId}, ${middle.orderId}, ${newest.orderId})
    `.execute(ctx.db);
    expect(new Map(rows.rows.map((row) => [row.id, row.status]))).toEqual(
      new Map([
        [oldest.orderId, "EXPIRED"],
        [middle.orderId, "EXPIRED"],
        [newest.orderId, "PENDING_PAYMENT"],
      ]),
    );
    const liveIntents = await sql<{ n: number }>`
      select count(*)::int as n from payment_intent where status in ('CREATED','PRESENTED')
    `.execute(ctx.db);
    expect(liveIntents.rows[0]?.n).toBe(1);
    const reserved = await sql<{ n: number }>`
      select count(*)::int as n from digital_asset where status = 'RESERVED'
    `.execute(ctx.db);
    expect(reserved.rows[0]?.n).toBe(1);
  });

  it("isolates a poison reservation row and continues the deterministic bounded batch", async () => {
    const seed = await seedCommerce();
    const orderA = await seedOrder(seed);
    const orderB = await seedOrder(seed);
    const orderC = await seedOrder(seed);
    const stale = new Date(Date.now() - 60_000);
    const goodA = await seedReservedAsset(seed, orderA.orderId, stale, "good-a");
    const poison = await seedReservedAsset(seed, orderB.orderId, stale, "poison");
    const goodC = await seedReservedAsset(seed, orderC.orderId, stale, "good-c");
    await sql`
      create function recovery_fail_poison_reservation() returns trigger language plpgsql as $$
      begin
        if old.fingerprint_hash = 'poison' then raise exception 'poison reservation'; end if;
        return new;
      end $$
    `.execute(ctx.db);
    await sql`
      create trigger recovery_poison_reservation before update on digital_asset
      for each row execute function recovery_fail_poison_reservation()
    `.execute(ctx.db);

    const result = await recoverStaleReservationsBatch(ctx.db, {
      batchSize: 3,
      now: new Date(),
    });

    expect(result).toMatchObject({ claimed: 3, succeeded: 2, failed: 1, backlog: 1 });
    const rows = await sql<{ id: string; status: string }>`
      select id, status from digital_asset where id in (${goodA}, ${poison}, ${goodC})
    `.execute(ctx.db);
    const statuses = new Map(rows.rows.map((row) => [row.id, row.status]));
    expect(statuses.get(goodA)).toBe("AVAILABLE");
    expect(statuses.get(goodC)).toBe("AVAILABLE");
    expect(statuses.get(poison)).toBe("RESERVED");
  });

  it("runs a bounded verified SePay window and never bypasses the canonical matcher", async () => {
    const seed = await seedCommerce();
    const now = new Date();
    const first = await seedOrder(seed, { createdAt: new Date(now.getTime() - 120_000) });
    const second = await seedOrder(seed, { createdAt: new Date(now.getTime() - 60_000) });
    const evidence = verifiedSePayEvidence({
      provider: "sepay",
      providerTransactionId: "api:" + randomUUID(),
      direction: "IN",
      merchantAccountId: first.account,
      amountVnd: 149999,
      content: first.content,
      reference: "FT-" + newId().slice(-8),
      transactedAt: now,
      rawHash: "hash-" + newId(),
      correlationId: "recovery-sepay",
    } satisfies PaymentEvidence);
    let requestedLimit = 0;
    const port: SePayReconciliationPort = {
      listTransactions(_fromSec, _toSec, limit) {
        requestedLimit = limit ?? 0;
        return Promise.resolve([evidence]);
      },
    };

    const result = await recoverSePayBatch(ctx.db, { batchSize: 1, now, port });

    expect(requestedLimit).toBe(1);
    expect(result).toMatchObject({ claimed: 1, succeeded: 1, failed: 0, backlog: 1 });
    const statuses = await sql<{ id: string; status: string }>`
      select id, status from "order" where id in (${first.orderId}, ${second.orderId})
    `.execute(ctx.db);
    const byId = new Map(statuses.rows.map((row) => [row.id, row.status]));
    expect(byId.get(first.orderId)).toBe("PAYMENT_NEEDS_REVIEW");
    expect(byId.get(second.orderId)).toBe("PENDING_PAYMENT");
    const allocations = await sql<{ n: number }>`
      select count(*)::int as n from payment_allocation where status = 'SETTLED'
    `.execute(ctx.db);
    expect(allocations.rows[0]?.n).toBe(0);
  });

  it("keeps the fixed SePay window while the worker clock changes after a throttled page", async () => {
    const seed = await seedCommerce();
    await seedOrder(seed, { createdAt: new Date("2026-01-01T00:00:00.000Z") });
    const calls: Array<{
      from: number;
      to: number;
      limit: number | undefined;
      sinceId: string | undefined;
    }> = [];
    const port: SePayReconciliationPort = {
      listTransactions(from, to, limit, options) {
        calls.push({ from, to, limit, sinceId: options?.sinceId });
        return Promise.resolve([
          verifiedSePayEvidence({
            provider: "sepay",
            providerTransactionId: "api:" + randomUUID(),
            direction: "IN",
            merchantAccountId: "0123456789",
            amountVnd: 150000,
            content: "NO_MATCH",
            reference: "FT-window",
            transactedAt: new Date("2026-01-01T00:01:00.000Z"),
            rawHash: "hash-window",
            correlationId: "recovery-window",
          } satisfies PaymentEvidence),
        ]);
      },
    };
    const limiter = createInMemoryRateLimiter({ capacity: 0, refillPerSecond: 0 });

    await recoverSePayBatch(ctx.db, {
      batchSize: 2,
      now: new Date("2026-01-01T00:10:00.000Z"),
      port,
      rateLimiter: limiter,
    });
    const firstCursor = await sePayCursorRow();
    await recoverSePayBatch(ctx.db, {
      batchSize: 5,
      now: new Date("2026-01-01T00:20:00.000Z"),
      port,
      rateLimiter: limiter,
    });
    const secondCursor = await sePayCursorRow();

    expect(calls[1]).toMatchObject({
      from: calls[0]?.from,
      to: calls[0]?.to,
      limit: firstCursor?.per_page,
      sinceId: undefined,
    });
    expect(firstCursor).toMatchObject({ page: 1, generation: 1, per_page: 2 });
    expect(secondCursor).toMatchObject({ page: 1, generation: 1, per_page: 2 });
  });

  it("does not advance the SePay cursor on the first failed row and replays that row", async () => {
    const seed = await seedCommerce();
    const order = await seedOrder(seed);
    const badId = randomUUID();
    const goodId = randomUUID();
    const badEvidence = { providerTransactionId: "api:" + badId } as unknown as PaymentEvidence;
    const goodEvidence = verifiedSePayEvidence({
      provider: "sepay",
      providerTransactionId: "api:" + goodId,
      direction: "IN",
      merchantAccountId: order.account,
      amountVnd: 150000,
      content: order.content,
      reference: "FT-replay",
      transactedAt: new Date(),
      rawHash: "hash-replay",
      correlationId: "recovery-replay",
    } satisfies PaymentEvidence);
    const seenSince: Array<string | undefined> = [];
    let attempt = 0;
    const port: SePayReconciliationPort = {
      listTransactions(_from, _to, _limit, options) {
        seenSince.push(options?.sinceId);
        attempt += 1;
        return Promise.resolve([(attempt === 1 ? badEvidence : goodEvidence) as never]);
      },
    };

    const failed = await recoverSePayBatch(ctx.db, { batchSize: 1, now: new Date(), port });
    const afterFailure = await sePayCursorRow();
    const replayed = await recoverSePayBatch(ctx.db, { batchSize: 1, now: new Date(), port });
    const afterReplay = await sePayCursorRow();

    expect(failed).toMatchObject({ succeeded: 0, failed: 1 });
    expect(afterFailure).toMatchObject({ page: 1, generation: 1 });
    expect(seenSince).toEqual([undefined, undefined]);
    expect(replayed).toMatchObject({ succeeded: 1, failed: 0 });
    expect(afterReplay).toMatchObject({ page: 2, generation: 2 });
  });

  it("defers SePay polling until the provider Retry-After deadline", async () => {
    const seed = await seedCommerce();
    await seedOrder(seed, { createdAt: new Date("2026-01-01T00:00:00.000Z") });
    const firstNow = new Date("2026-01-01T00:10:00.000Z");
    let calls = 0;
    const port: SePayReconciliationPort = {
      listTransactions() {
        calls += 1;
        if (calls === 1) {
          throw new SePayApiError("RATE_LIMITED", "provider backoff", 120);
        }
        return Promise.resolve([]);
      },
    };

    const failed = await recoverSePayBatch(ctx.db, { batchSize: 1, now: firstNow, port });
    const gated = await recoverSePayBatch(ctx.db, {
      batchSize: 1,
      now: new Date(firstNow.getTime() + 60_000),
      port,
    });
    const released = await recoverSePayBatch(ctx.db, {
      batchSize: 1,
      now: new Date(firstNow.getTime() + 121_000),
      port,
    });

    expect(failed).toMatchObject({ claimed: 1, failed: 1 });
    expect(gated).toMatchObject({ claimed: 0, failed: 0 });
    expect(released).toMatchObject({ claimed: 1, failed: 0 });
    expect(calls).toBe(2);
  });

  it("advances the SePay cursor only after all rows in the page succeed", async () => {
    const seed = await seedCommerce();
    const first = await seedOrder(seed);
    const second = await seedOrder(seed);
    const firstId = randomUUID();
    const secondId = randomUUID();
    const port: SePayReconciliationPort = {
      listTransactions() {
        return Promise.resolve([
          verifiedSePayEvidence({
            provider: "sepay",
            providerTransactionId: "api:" + firstId,
            direction: "IN",
            merchantAccountId: first.account,
            amountVnd: 150000,
            content: first.content,
            reference: "FT-ok-1",
            transactedAt: new Date(),
            rawHash: "hash-ok-1",
            correlationId: "recovery-ok-1",
          } satisfies PaymentEvidence),
          verifiedSePayEvidence({
            provider: "sepay",
            providerTransactionId: "api:" + secondId,
            direction: "IN",
            merchantAccountId: second.account,
            amountVnd: 150000,
            content: second.content,
            reference: "FT-ok-2",
            transactedAt: new Date(),
            rawHash: "hash-ok-2",
            correlationId: "recovery-ok-2",
          } satisfies PaymentEvidence),
        ]);
      },
    };

    await recoverSePayBatch(ctx.db, { batchSize: 2, now: new Date(), port });
    expect(await sePayCursorRow()).toMatchObject({ page: 2, generation: 2, per_page: 2 });
  });

  it("completes an empty SePay window into the next overlap window", async () => {
    const seed = await seedCommerce();
    const oldestPending = new Date("2026-01-01T00:00:00.000Z");
    await seedOrder(seed, { createdAt: oldestPending });
    const calls: Array<{ from: number; to: number; limit: number | undefined }> = [];
    const port: SePayReconciliationPort = {
      listTransactions(from, to, limit) {
        calls.push({ from, to, limit });
        return Promise.resolve([]);
      },
    };

    await recoverSePayBatch(ctx.db, {
      batchSize: 3,
      now: new Date("2026-01-01T00:10:00.000Z"),
      port,
    });
    const cursor = await sePayCursorRow();

    expect(calls[0]).toMatchObject({ limit: 3 });
    expect(cursor).toMatchObject({
      window_from_sec: Math.min(Math.floor(oldestPending.getTime() / 1000), calls[0]!.to - 300),
      window_to_sec: calls[0]!.to,
      page: 1,
      per_page: 3,
      generation: 2,
    });
  });

  it("rescans page one after an empty page so late rows in the fixed window are not missed", async () => {
    const seed = await seedCommerce();
    const first = await seedOrder(seed, { createdAt: new Date("2026-01-01T00:00:00.000Z") });
    const late = await seedOrder(seed, { createdAt: new Date("2026-01-01T00:00:30.000Z") });
    const calls: Array<{ page: number | undefined; sinceId: string | undefined }> = [];
    const firstEvidence = verifiedSePayEvidence({
      provider: "sepay",
      providerTransactionId: "api:" + randomUUID(),
      direction: "IN",
      merchantAccountId: first.account,
      amountVnd: 150000,
      content: first.content,
      reference: "FT-rescan-1",
      transactedAt: new Date("2026-01-01T00:01:00.000Z"),
      rawHash: "hash-rescan-1",
      correlationId: "recovery-rescan-1",
    } satisfies PaymentEvidence);
    const lateEvidence = verifiedSePayEvidence({
      provider: "sepay",
      providerTransactionId: "api:" + randomUUID(),
      direction: "IN",
      merchantAccountId: late.account,
      amountVnd: 150000,
      content: late.content,
      reference: "FT-rescan-2",
      transactedAt: new Date("2026-01-01T00:01:30.000Z"),
      rawHash: "hash-rescan-2",
      correlationId: "recovery-rescan-2",
    } satisfies PaymentEvidence);
    const port: SePayReconciliationPort = {
      listTransactions(_from, _to, _limit, options) {
        calls.push({ page: options?.page, sinceId: options?.sinceId });
        if (calls.length === 1) return Promise.resolve([firstEvidence]);
        if (calls.length === 2) return Promise.resolve([]);
        return Promise.resolve([lateEvidence]);
      },
    };

    await recoverSePayBatch(ctx.db, {
      batchSize: 1,
      now: new Date("2026-01-01T00:10:00.000Z"),
      port,
    });
    await recoverSePayBatch(ctx.db, {
      batchSize: 1,
      now: new Date("2026-01-01T00:10:30.000Z"),
      port,
    });
    await recoverSePayBatch(ctx.db, {
      batchSize: 1,
      now: new Date("2026-01-01T00:11:00.000Z"),
      port,
    });

    expect(calls).toEqual([
      { page: 1, sinceId: undefined },
      { page: 2, sinceId: undefined },
      { page: 1, sinceId: undefined },
    ]);
    const lateOrder = await sql<{
      status: string;
    }>`select status from "order" where id = ${late.orderId}`.execute(ctx.db);
    expect(lateOrder.rows[0]?.status).toBe("PAID");
  });

  it("polls SePay when local unpaid backlog is empty", async () => {
    const calls: Array<{ from: number; to: number; limit: number | undefined }> = [];
    const port: SePayReconciliationPort = {
      listTransactions(from, to, limit) {
        calls.push({ from, to, limit });
        return Promise.resolve([]);
      },
    };
    const now = new Date("2026-01-01T00:10:00.000Z");
    await sql`
      insert into sepay_reconciliation_cursor
        (provider, window_from_sec, window_to_sec, page, per_page, generation, updated_at)
      values ('sepay', 0, 1, 1, 5, 1, '2025-12-31T23:00:00.000Z'::timestamptz)
    `.execute(ctx.db);
    const before = await sql<{ updated_at: Date | string }>`
      select updated_at from sepay_reconciliation_cursor where provider = 'sepay'
    `.execute(ctx.db);

    const result = await recoverSePayBatch(ctx.db, { batchSize: 5, now, port });
    const cursor = await sql<{
      last_success_at: Date | string | null;
      transactions_scanned: number;
      consecutive_failures: number;
      updated_at: Date | string;
    }>`
      select last_success_at, transactions_scanned, consecutive_failures, updated_at
      from sepay_reconciliation_cursor
      where provider = 'sepay'
    `.execute(ctx.db);

    expect(calls.length).toBeGreaterThanOrEqual(1);
    expect(result).toMatchObject({ claimed: 0, succeeded: 0, failed: 0, backlog: 0 });
    expect(cursor.rows[0]?.last_success_at).not.toBeNull();
    expect(cursor.rows[0]?.transactions_scanned).toBe(0);
    expect(cursor.rows[0]?.consecutive_failures).toBe(0);
    expect(new Date(cursor.rows[0]!.updated_at).getTime()).toBeGreaterThan(
      new Date(before.rows[0]!.updated_at).getTime(),
    );
  });

  it("claims supplier UNKNOWN rows once, queries only, and isolates provider failures", async () => {
    const seed = await seedCommerce();
    const orderA = await seedOrder(seed, { status: "PAID" });
    const orderB = await seedOrder(seed, { status: "PAID" });
    const supplierId = newId();
    const supplierSkuId = newId();
    await sql`
      insert into supplier (id, name, adapter_type, credential_vault_ref)
      values (${supplierId}, 'S', 'fixture', 'vault:supplier')
    `.execute(ctx.db);
    await sql`
      insert into supplier_sku
        (id, supplier_id, variant_id, external_sku, cost_vnd, region, delivery_type)
      values (${supplierSkuId}, ${supplierId}, ${seed.variantId}, 'EXT-SKU', 100000, 'VN', 'CREDENTIAL')
    `.execute(ctx.db);
    const poisonId = newId();
    const pendingId = newId();
    for (const [id, orderId, key] of [
      [poisonId, orderA.orderId, "poison-query"],
      [pendingId, orderB.orderId, "pending-query"],
    ] as const) {
      await sql`
        insert into supplier_order
          (id, supplier_id, supplier_sku_id, order_id, idempotency_key, request_fingerprint,
           status, cost_vnd_snapshot, sale_price_vnd_snapshot, margin_vnd_snapshot,
           submitted_at, last_queried_at, next_reconcile_at)
        values
          (${id}, ${supplierId}, ${supplierSkuId}, ${orderId}, ${key}, ${"fp-" + id},
           'UNKNOWN', 100000, 150000, 50000, now() - interval '10 minutes',
           now() - interval '5 minutes', now() - interval '1 minute')
      `.execute(ctx.db);
    }
    let createCalls = 0;
    let queryCalls = 0;
    const port: SupplierPort = {
      getAvailability: () =>
        Promise.resolve({ status: "AVAILABLE", observedAt: new Date().toISOString() }),
      createOrder() {
        createCalls += 1;
        return Promise.reject(new Error("create must not be called by recovery"));
      },
      queryOrder(input) {
        queryCalls += 1;
        if (input.queryKey === "poison-query") return Promise.reject(new Error("provider poison"));
        return Promise.resolve({ status: "PENDING", externalOrderId: "external-pending" });
      },
      cancelOrder: async () => ({ status: "ACCEPTED" }),
      requestRefund: async () => ({ status: "PENDING" }),
      reconcile: async () => ({ observations: [], nextCursor: null }),
    };

    const result = await recoverSupplierOrdersBatch(ctx.db, {
      batchSize: 2,
      now: new Date(),
      retryDelaySeconds: 60,
      resolvePort: () => port,
      vault: createInMemoryVault(),
    });

    expect(createCalls).toBe(0);
    expect(queryCalls).toBe(2);
    expect(result).toMatchObject({ claimed: 2, succeeded: 1, failed: 1, backlog: 2 });
  });

  it("claims stale SUBMITTED supplier rows only after the retry threshold", async () => {
    const seed = await seedCommerce();
    const order = await seedOrder(seed, { status: "PAID" });
    const supplierId = newId();
    const supplierSkuId = newId();
    await sql`
      insert into supplier (id, name, adapter_type, credential_vault_ref)
      values (${supplierId}, 'S', 'fixture', 'vault:supplier')
    `.execute(ctx.db);
    await sql`
      insert into supplier_sku
        (id, supplier_id, variant_id, external_sku, cost_vnd, region, delivery_type)
      values (${supplierSkuId}, ${supplierId}, ${seed.variantId}, 'EXT-SKU', 100000, 'VN', 'CREDENTIAL')
    `.execute(ctx.db);
    await sql`
      insert into supplier_order
        (id, supplier_id, supplier_sku_id, order_id, idempotency_key, request_fingerprint,
         status, cost_vnd_snapshot, sale_price_vnd_snapshot, margin_vnd_snapshot,
         submitted_at)
      values
        (${newId()}, ${supplierId}, ${supplierSkuId}, ${order.orderId}, 'fresh-submitted', 'fp-fresh',
         'SUBMITTED', 100000, 150000, 50000, now())
    `.execute(ctx.db);
    await sql`
      insert into supplier_order
        (id, supplier_id, supplier_sku_id, order_id, idempotency_key, request_fingerprint,
         status, cost_vnd_snapshot, sale_price_vnd_snapshot, margin_vnd_snapshot,
         submitted_at)
      values
        (${newId()}, ${supplierId}, ${supplierSkuId}, ${order.orderId}, 'stale-submitted', 'fp-stale',
         'SUBMITTED', 100000, 150000, 50000, now() - interval '10 minutes')
    `.execute(ctx.db);

    let queryCalls = 0;
    const port: SupplierPort = {
      getAvailability: () =>
        Promise.resolve({ status: "AVAILABLE", observedAt: new Date().toISOString() }),
      createOrder: () => Promise.reject(new Error("create must not be called by recovery")),
      queryOrder: () => {
        queryCalls += 1;
        return Promise.resolve({ status: "PENDING", externalOrderId: "external-submitted" });
      },
      cancelOrder: async () => ({ status: "ACCEPTED" }),
      requestRefund: async () => ({ status: "PENDING" }),
      reconcile: async () => ({ observations: [], nextCursor: null }),
    };

    const result = await recoverSupplierOrdersBatch(ctx.db, {
      batchSize: 2,
      now: new Date(),
      retryDelaySeconds: 60,
      resolvePort: () => port,
      vault: createInMemoryVault(),
    });

    expect(queryCalls).toBe(1);
    expect(result.claimed).toBe(1);
  });

  it("lets concurrent bundle workers split expired rows and never resets CONSUMED", async () => {
    const seed = await seedCommerce();
    const orders = await Promise.all([
      seedOrder(seed, { status: "PROCESSING" }),
      seedOrder(seed, { status: "PROCESSING" }),
      seedOrder(seed, { status: "COMPLETED" }),
    ]);
    const statuses = ["AVAILABLE", "VIEWED", "CONSUMED"] as const;
    const bundleIds: string[] = [];
    for (let i = 0; i < orders.length; i += 1) {
      const order = orders[i]!;
      const assetId = newId();
      const bundleId = newId();
      bundleIds.push(bundleId);
      await sql`
        insert into digital_asset
          (id, variant_id, source_type, vault_ref, fingerprint_hash, status,
           reserved_order_id, delivered_order_id)
        values
          (${assetId}, ${seed.variantId}, 'LOCAL', ${"vault:" + assetId}, ${"fp-" + assetId},
           ${i === 2 ? "DELIVERED" : "READY"}, ${i === 2 ? null : order.orderId},
           ${i === 2 ? order.orderId : null})
      `.execute(ctx.db);
      await sql`
        insert into delivery_bundle
          (id, order_id, customer_id, asset_id, token_hash, status, expires_at,
           viewed_at, consumed_at, created_at)
        values
          (${bundleId}, ${order.orderId}, ${seed.customerId}, ${assetId}, ${"token-" + bundleId},
           ${statuses[i]}, now() - interval '1 minute',
           ${i === 1 ? new Date().toISOString() : null},
           ${i === 2 ? new Date().toISOString() : null}, now() - interval '5 minutes')
      `.execute(ctx.db);
    }

    const [a, b] = await Promise.all([
      recoverExpiredDeliveryBundlesBatch(ctx.db, { batchSize: 1, now: new Date() }),
      recoverExpiredDeliveryBundlesBatch(ctx.db, { batchSize: 1, now: new Date() }),
    ]);

    expect(a.succeeded + b.succeeded).toBe(2);
    const rows = await sql<{ id: string; status: string }>`
      select id, status from delivery_bundle where id in (${bundleIds[0]}, ${bundleIds[1]}, ${bundleIds[2]})
    `.execute(ctx.db);
    const byId = new Map(rows.rows.map((row) => [row.id, row.status]));
    expect(byId.get(bundleIds[0]!)).toBe("EXPIRED");
    expect(byId.get(bundleIds[1]!)).toBe("EXPIRED");
    expect(byId.get(bundleIds[2]!)).toBe("CONSUMED");
  });
});
