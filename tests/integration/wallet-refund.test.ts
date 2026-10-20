import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { newId } from "../../src/shared/ids/index.js";
import { createWalletLedgerService } from "../../src/modules/wallet/ledger.js";
import { createWalletRefundService } from "../../src/modules/wallet/refund.js";
import {
  dockerAvailable,
  startPostgresContainer,
  type PgTestContext,
} from "../helpers/pg-container.js";

const hasDocker = await dockerAvailable();
let ctx: PgTestContext;

beforeAll(async () => {
  if (hasDocker) ctx = await startPostgresContainer();
}, 180_000);
afterAll(async () => {
  await ctx?.teardown();
});
beforeEach(async () => {
  await sql`truncate table outbox_event, wallet_ledger, wallet_account, "order", product_variant, product, category, customer cascade`.execute(
    ctx.db,
  );
});

async function seedRefundCandidate(
  status = "REFUND_PENDING",
  options: {
    reserveLocal?: boolean;
    fileDelivery?: {
      status: "QUEUED" | "PROCESSING" | "SENT" | "FAILED";
      lastError?: string | null;
    };
  } = {},
): Promise<{ customerId: string; orderId: string; assetId?: string }> {
  const customerId = newId();
  const categoryId = newId();
  const productId = newId();
  const variantId = newId();
  const orderId = newId();
  await sql`insert into customer (id, status, locale) values (${customerId}, 'ACTIVE', 'vi-VN')`.execute(
    ctx.db,
  );
  await sql`insert into category (id, name_vi, slug, is_active, sort_order) values (${categoryId}, 'C', ${categoryId.slice(-8)}, true, 1)`.execute(
    ctx.db,
  );
  await sql`insert into product (id, category_id, name_vi, slug, is_active, sort_order) values (${productId}, ${categoryId}, 'P', ${productId.slice(-8)}, true, 1)`.execute(
    ctx.db,
  );
  await sql`insert into product_variant (id, product_id, sku, name_vi, price_vnd, duration_code, delivery_type, warranty_days, stock_policy, resale_evidence_id, is_active)
    values (${variantId}, ${productId}, ${"SKU-" + variantId.slice(-8)}, 'V', 200000, 'P1M', 'CREDENTIAL', 0, 'LOCAL_ONLY', 'RES-1', true)`.execute(
    ctx.db,
  );
  await sql`insert into "order" (id, order_number, customer_id, variant_id, product_name_vi, variant_name_vi, price_vnd, duration_code, delivery_type, warranty_days, supplier_policy_snapshot, status)
    values (${orderId}, ${"ORD-" + orderId}, ${customerId}, ${variantId}, 'P', 'V', 200000, 'P1M', 'CREDENTIAL', 0, 'LOCAL_ONLY', ${status})`.execute(
    ctx.db,
  );
  const assetId = options.reserveLocal ? newId() : null;
  if (assetId) {
    await sql`
      insert into digital_asset
        (id, variant_id, source_type, vault_ref, fingerprint_hash, status,
         reserved_order_id, reserved_until)
      values
        (${assetId}, ${variantId}, 'LOCAL', ${`vault:${assetId}`}, ${`fp:${assetId}`},
         'RESERVED', ${orderId}, now() + interval '15 minutes')
    `.execute(ctx.db);
  }
  if (options.fileDelivery) {
    const artifactId = newId();
    const artifactSha256 = "a".repeat(64);
    await sql`
      insert into variant_file_artifact
        (id, variant_id, version, filename, mime_type, size_bytes, sha256, storage_reference)
      values
        (${artifactId}, ${variantId}, 1, 'refund.bin', 'application/octet-stream', 1,
         ${artifactSha256}, ${`vault:${artifactId}`})
    `.execute(ctx.db);
    await sql`
      insert into file_delivery_job
        (order_id, customer_id, variant_id, artifact_id, artifact_version, artifact_sha256,
         telegram_chat_id, status, last_error)
      values
        (${orderId}, ${customerId}, ${variantId}, ${artifactId}, 1, ${artifactSha256},
         'chat', ${options.fileDelivery.status}, ${options.fileDelivery.lastError ?? null})
    `.execute(ctx.db);
  }
  await createWalletLedgerService(ctx.db).credit({
    customerId,
    amountVnd: 100000n,
    idempotencyKey: "seed-credit",
    correlationId: "seed",
    reason: "seed",
  });
  await createWalletLedgerService(ctx.db).debit({
    customerId,
    amountVnd: 100000n,
    idempotencyKey: `purchase:${orderId}:seed`,
    correlationId: "seed-debit",
    reason: "seed purchase",
  });
  return assetId ? { customerId, orderId, assetId } : { customerId, orderId };
}

describe.skipIf(!hasDocker)("wallet refund service", () => {
  it("credits the exact wallet debit and is replay-safe", async () => {
    const { orderId, customerId } = await seedRefundCandidate();
    const service = createWalletRefundService(ctx.db);
    const input = { orderId, correlationId: "refund-corr", approvedBy: "12345" };
    expect(await service.refund(input)).toMatchObject({ ok: true, kind: "REFUNDED", orderId });
    expect(await service.refund(input)).toMatchObject({
      ok: true,
      kind: "ALREADY_REFUNDED",
      orderId,
    });
    const wallet = await sql<{
      balance_vnd: string;
    }>`select balance_vnd from wallet_account where customer_id = ${customerId}`.execute(ctx.db);
    expect(wallet.rows[0]?.balance_vnd).toBe("100000");
    const credits = await sql<{
      count: string;
    }>`select count(*)::text as count from wallet_ledger l join wallet_account a on a.id=l.wallet_account_id where a.customer_id=${customerId} and l.idempotency_key=${`refund:${orderId}`}`.execute(
      ctx.db,
    );
    expect(credits.rows[0]?.count).toBe("1");
  });

  it("serializes concurrent refunds into one credit and one notification", async () => {
    const { orderId, customerId } = await seedRefundCandidate();
    const service = createWalletRefundService(ctx.db);
    const input = { orderId, correlationId: "refund-race", approvedBy: "12345" };

    const results = await Promise.all([service.refund(input), service.refund(input)]);

    expect(results.every((result) => result.ok)).toBe(true);
    expect(results.map((result) => result.ok && result.kind).sort()).toEqual([
      "ALREADY_REFUNDED",
      "REFUNDED",
    ]);

    const state = await sql<{
      refund_credits: string;
      refunded_events: string;
      status: string;
      transition_to_status: string;
      transition_reason: string;
      transition_actor_type: string;
      transition_occurred_at: Date;
    }>`select
        (select count(*)::text
           from wallet_ledger l
           join wallet_account a on a.id = l.wallet_account_id
          where a.customer_id = ${customerId}
            and l.idempotency_key = ${`refund:${orderId}`}
            and l.entry_type = 'CREDIT') as refund_credits,
        (select count(*)::text
           from outbox_event
          where aggregate_id = ${orderId}
            and event_type = 'WalletRefunded') as refunded_events,
        (select status from "order" where id = ${orderId}) as status,
        (select to_status from order_transition
          where order_id = ${orderId}
          order by occurred_at desc, id desc limit 1) as transition_to_status,
        (select reason_code from order_transition
          where order_id = ${orderId}
          order by occurred_at desc, id desc limit 1) as transition_reason,
        (select actor_type from order_transition
          where order_id = ${orderId}
          order by occurred_at desc, id desc limit 1) as transition_actor_type,
        (select occurred_at from order_transition
          where order_id = ${orderId}
          order by occurred_at desc, id desc limit 1) as transition_occurred_at
    `.execute(ctx.db);

    expect(state.rows[0]).toMatchObject({
      refund_credits: "1",
      refunded_events: "1",
      status: "REFUNDED",
      transition_to_status: "REFUNDED",
      transition_reason: "WALLET_REFUND",
      transition_actor_type: "root-admin",
    });
    expect(state.rows[0]?.transition_occurred_at).toBeInstanceOf(Date);
  });
  it("refunds a PAID order and releases a prepayment reserve exactly once", async () => {
    const { orderId, customerId, assetId } = await seedRefundCandidate("PAID", {
      reserveLocal: true,
    });
    const service = createWalletRefundService(ctx.db);
    const input = { orderId, correlationId: "paid-refund", approvedBy: "12345" };

    expect(await service.refund(input)).toMatchObject({
      ok: true,
      kind: "REFUNDED",
      orderId,
    });

    const first = await sql<{
      order_status: string;
      order_version: number;
      asset_status: string;
      reserved_order_id: string | null;
      asset_version: number;
      refund_credits: string;
      refund_events: string;
    }>`
      select
        (select status from "order" where id = ${orderId}) as order_status,
        (select version from "order" where id = ${orderId}) as order_version,
        (select status from digital_asset where id = ${assetId}) as asset_status,
        (select reserved_order_id from digital_asset where id = ${assetId}) as reserved_order_id,
        (select version from digital_asset where id = ${assetId}) as asset_version,
        (select count(*)::text from wallet_ledger l
          join wallet_account a on a.id = l.wallet_account_id
          where a.customer_id = ${customerId}
            and l.idempotency_key = ${`refund:${orderId}`}) as refund_credits,
        (select count(*)::text from outbox_event
          where aggregate_id = ${orderId} and event_type = 'WalletRefunded') as refund_events
    `.execute(ctx.db);

    expect(first.rows[0]).toMatchObject({
      order_status: "REFUNDED",
      order_version: 3,
      asset_status: "AVAILABLE",
      reserved_order_id: null,
      asset_version: 2,
      refund_credits: "1",
      refund_events: "1",
    });

    expect(await service.refund(input)).toMatchObject({
      ok: true,
      kind: "ALREADY_REFUNDED",
      orderId,
    });
    const replay = await sql<{ status: string; version: number }>`
      select status, version from digital_asset where id = ${assetId}
    `.execute(ctx.db);
    expect(replay.rows[0]).toEqual({ status: "AVAILABLE", version: 2 });
  });

  it.each(["PROCESSING", "COMPLETED"] as const)(
    "refuses %s before wallet credit",
    async (status) => {
      const { orderId, customerId } = await seedRefundCandidate(status);
      const result = await createWalletRefundService(ctx.db).refund({
        orderId,
        correlationId: `fulfilled-${status.toLowerCase()}`,
        approvedBy: "12345",
      });
      expect(result).toMatchObject({ ok: false, code: "ALREADY_FULFILLED" });

      const state = await sql<{ status: string; balance_vnd: string; credits: string }>`
        select
          (select status from "order" where id = ${orderId}) as status,
          (select balance_vnd from wallet_account where customer_id = ${customerId}) as balance_vnd,
          (select count(*)::text from wallet_ledger l
            join wallet_account a on a.id = l.wallet_account_id
            where a.customer_id = ${customerId}
              and l.idempotency_key = ${`refund:${orderId}`}) as credits
      `.execute(ctx.db);
      expect(state.rows[0]).toEqual({ status, balance_vnd: "0", credits: "0" });
    },
  );
  it.each(["PROCESSING", "SENT"] as const)(
    "refuses file delivery %s evidence before wallet credit",
    async (deliveryStatus) => {
      const { orderId, customerId } = await seedRefundCandidate("REFUND_PENDING", {
        fileDelivery: { status: deliveryStatus },
      });
      const result = await createWalletRefundService(ctx.db).refund({
        orderId,
        correlationId: `file-${deliveryStatus.toLowerCase()}`,
        approvedBy: "12345",
      });
      expect(result).toMatchObject({ ok: false, code: "ALREADY_FULFILLED" });

      const state = await sql<{ status: string; balance_vnd: string; credits: string }>`
        select
          (select status from "order" where id = ${orderId}) as status,
          (select balance_vnd from wallet_account where customer_id = ${customerId}) as balance_vnd,
          (select count(*)::text from wallet_ledger l
            join wallet_account a on a.id = l.wallet_account_id
            where a.customer_id = ${customerId}
              and l.idempotency_key = ${`refund:${orderId}`}) as credits
      `.execute(ctx.db);
      expect(state.rows[0]).toEqual({
        status: "REFUND_PENDING",
        balance_vnd: "0",
        credits: "0",
      });
    },
  );

  it.each(["SEND_FAILED", null] as const)(
    "refuses ambiguous FAILED file delivery evidence (%s) before wallet credit",
    async (lastError) => {
      const { orderId, customerId } = await seedRefundCandidate("REFUND_PENDING", {
        fileDelivery: { status: "FAILED", lastError },
      });
      const result = await createWalletRefundService(ctx.db).refund({
        orderId,
        correlationId: "ambiguous-file-failure",
        approvedBy: "12345",
      });
      expect(result).toMatchObject({ ok: false, code: "ALREADY_FULFILLED" });

      const state = await sql<{ status: string; balance_vnd: string; credits: string }>`
        select
          (select status from "order" where id = ${orderId}) as status,
          (select balance_vnd from wallet_account where customer_id = ${customerId}) as balance_vnd,
          (select count(*)::text from wallet_ledger l
            join wallet_account a on a.id = l.wallet_account_id
            where a.customer_id = ${customerId}
              and l.idempotency_key = ${`refund:${orderId}`}) as credits
      `.execute(ctx.db);
      expect(state.rows[0]).toEqual({
        status: "REFUND_PENDING",
        balance_vnd: "0",
        credits: "0",
      });
    },
  );

  it.each(["INVALID_STORAGE_REFERENCE", "FILE_HASH_MISMATCH", "FILE_SIZE_MISMATCH"] as const)(
    "allows known pre-send FAILED evidence (%s)",
    async (lastError) => {
      const { orderId, customerId } = await seedRefundCandidate("REFUND_PENDING", {
        fileDelivery: { status: "FAILED", lastError },
      });
      const result = await createWalletRefundService(ctx.db).refund({
        orderId,
        correlationId: "deterministic-file-failure",
        approvedBy: "12345",
      });
      expect(result).toMatchObject({ ok: true, kind: "REFUNDED", orderId });

      const state = await sql<{ status: string; balance_vnd: string; credits: string }>`
      select
        (select status from "order" where id = ${orderId}) as status,
        (select balance_vnd from wallet_account where customer_id = ${customerId}) as balance_vnd,
        (select count(*)::text from wallet_ledger l
          join wallet_account a on a.id = l.wallet_account_id
          where a.customer_id = ${customerId}
            and l.idempotency_key = ${`refund:${orderId}`}) as credits
    `.execute(ctx.db);
      expect(state.rows[0]).toEqual({
        status: "REFUNDED",
        balance_vnd: "100000",
        credits: "1",
      });
    },
  );

  it("does not treat QUEUED file delivery as send evidence", async () => {
    const { orderId, customerId } = await seedRefundCandidate("REFUND_PENDING", {
      fileDelivery: { status: "QUEUED" },
    });
    const result = await createWalletRefundService(ctx.db).refund({
      orderId,
      correlationId: "queued-file",
      approvedBy: "12345",
    });
    expect(result).toMatchObject({ ok: true, kind: "REFUNDED", orderId });

    const state = await sql<{ status: string; balance_vnd: string }>`
      select
        (select status from "order" where id = ${orderId}) as status,
        (select balance_vnd from wallet_account where customer_id = ${customerId}) as balance_vnd
    `.execute(ctx.db);
    expect(state.rows[0]).toEqual({ status: "REFUNDED", balance_vnd: "100000" });
  });

  it("rejects refunds that are not pending or were not wallet paid", async () => {
    const notPending = await seedRefundCandidate("PENDING_PAYMENT");
    expect(
      await createWalletRefundService(ctx.db).refund({
        orderId: notPending.orderId,
        correlationId: "c",
        approvedBy: "12345",
      }),
    ).toMatchObject({ ok: false, code: "NOT_ELIGIBLE" });
    await sql`truncate table wallet_ledger, wallet_account, "order", product_variant, product, category, customer cascade`.execute(
      ctx.db,
    );
    const noWalletPayment = await seedRefundCandidate();
    await sql`delete from wallet_ledger where idempotency_key like ${`purchase:${noWalletPayment.orderId}:%`}`.execute(
      ctx.db,
    );
    expect(
      await createWalletRefundService(ctx.db).refund({
        orderId: noWalletPayment.orderId,
        correlationId: "c2",
        approvedBy: "12345",
      }),
    ).toMatchObject({ ok: false, code: "NOT_WALLET_PAID" });
  });
});
