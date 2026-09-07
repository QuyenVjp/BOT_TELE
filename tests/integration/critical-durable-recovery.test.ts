import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { newId } from "../../src/shared/ids/index.js";
import {
  recoverCriticalJob,
  type CriticalRecoveryFamily,
} from "../../src/modules/recovery/critical-durable-recovery.js";
import { startPostgresContainer, type PgTestContext } from "../helpers/pg-container.js";

let ctx: PgTestContext;

beforeAll(async () => {
  ctx = await startPostgresContainer();
}, 120_000);

afterAll(async () => {
  await ctx?.teardown();
});

beforeEach(async () => {
  await sql`drop trigger if exists test_stale_outbox on outbox_event`.execute(ctx.db);
  await sql`drop function if exists test_bump_outbox_generation() cascade`.execute(ctx.db);
  await sql`
    truncate table delivery_notification_handoff, delivery_bundle, digital_asset,
      supplier_order, supplier_sku, supplier, notification_delivery, notification_campaign,
      webhook_inbox, outbox_event, audit_event, order_transition, "order",
      product_variant, product, category, customer cascade
  `.execute(ctx.db);
});

const operator = {
  rootAdminTelegramUserId: "111222333",
  configuredRootAdminTelegramUserId: "111222333",
  reason: "RC local dead-letter retry after operator review",
  correlationId: "rc-recovery-test",
};

async function auditFor(targetId: string) {
  const rows = await sql<{
    action: string;
    actor_type: string;
    actor_id: string;
    metadata_redacted: unknown;
  }>`
    select action, actor_type, actor_id, metadata_redacted
    from audit_event where target_id = ${targetId}
  `.execute(ctx.db);
  return rows.rows;
}

async function seedCommerce(status = "PAID") {
  const categoryId = newId();
  const productId = newId();
  const variantId = newId();
  const customerId = newId();
  const orderId = newId();
  const assetId = newId();
  const bundleId = newId();
  const slug = categoryId.slice(-8);
  await sql`insert into category (id, name_vi, slug, is_active, sort_order) values (${categoryId}, 'C', ${slug}, true, 1)`.execute(
    ctx.db,
  );
  await sql`insert into product (id, category_id, name_vi, slug, is_active, sort_order) values (${productId}, ${categoryId}, 'P', ${slug}, true, 1)`.execute(
    ctx.db,
  );
  await sql`
    insert into product_variant (id, product_id, sku, name_vi, price_vnd, duration_code, delivery_type, stock_policy, resale_evidence_id)
    values (${variantId}, ${productId}, ${"SKU-" + variantId}, 'V', 100000, 'P1M', 'CREDENTIAL', 'LOCAL_ONLY', 'RES-1')
  `.execute(ctx.db);
  await sql`insert into customer(id,status,locale) values(${customerId},'ACTIVE','vi')`.execute(
    ctx.db,
  );
  await sql`
    insert into "order" (id, order_number, customer_id, variant_id, product_name_vi,
      variant_name_vi, price_vnd, duration_code, delivery_type, status, paid_at)
    values (${orderId}, ${"ORD-" + orderId}, ${customerId}, ${variantId}, 'P', 'V',
      100000, 'P1M', 'CREDENTIAL', ${status}, now())
  `.execute(ctx.db);
  await sql`
    insert into digital_asset (id, variant_id, source_type, vault_ref, fingerprint_hash, status, reserved_order_id)
    values (${assetId}, ${variantId}, 'LOCAL', ${"vault:" + assetId}, ${"fp-" + assetId}, 'READY', ${orderId})
  `.execute(ctx.db);
  await sql`
    insert into delivery_bundle (id, order_id, customer_id, asset_id, token_hash, status, expires_at)
    values (${bundleId}, ${orderId}, ${customerId}, ${assetId}, ${"token-" + bundleId}, 'AVAILABLE', now() + interval '1 hour')
  `.execute(ctx.db);
  return { categoryId, productId, variantId, customerId, orderId, assetId, bundleId };
}

async function deadOutbox(eventType = "OrderPaid", aggregateId?: string) {
  const id = newId();
  const orderId = aggregateId ?? (await seedCommerce()).orderId;
  await sql`
    insert into outbox_event
      (id, aggregate_type, aggregate_id, aggregate_version, event_type, payload_redacted,
       attempt_count, next_attempt_at, last_error_code, dead_lettered_at,
       claimed_by, claimed_at, claim_expires_at, claim_generation)
    values
      (${id}, 'Order', ${orderId}, 1, ${eventType},
       ${JSON.stringify({ orderId, token: "must-not-audit" })}::jsonb,
       8, now() + interval '1 hour', 'FixtureError', now() - interval '1 minute',
       null, null, null, 3)
  `.execute(ctx.db);
  return id;
}

async function customer() {
  const id = newId();
  await sql`insert into customer(id,status,locale) values(${id},'ACTIVE','vi')`.execute(ctx.db);
  return id;
}

async function deadNotification(lastError = "rate-limited") {
  const customerId = await customer();
  const campaignId = newId();
  const id = newId();
  await sql`
    insert into notification_campaign(id,class,content,status,created_by,idempotency_key,audience,previewed_at)
    values (${campaignId}, 'CRITICAL_SERVICE', 'safe retry', 'QUEUED', 'root', ${campaignId}, 'all', now())
  `.execute(ctx.db);
  await sql`
    insert into notification_delivery
      (id,campaign_id,customer_id,chat_id,status,attempts,next_attempt_at,last_error,claimed_by,claim_generation,claim_expires_at)
    values (${id},${campaignId},${customerId},'111222333','DEAD',5,now() + interval '1 hour',${lastError},null,4,null)
  `.execute(ctx.db);
  return id;
}

async function deadHandoff(lastErrorCode = "DeliveryNotificationSendTimeoutError") {
  const seeded = await seedCommerce("PROCESSING");
  const id = newId();
  await sql`
    insert into delivery_notification_handoff
      (id,bundle_id,customer_id,telegram_chat_id,capability_key,capability_ref,status,attempt_count,
       next_attempt_at,claimed_by,claim_generation,claim_expires_at,last_error_code)
    values (${id},${seeded.bundleId},${seeded.customerId},'111222333',${newId()},'vault:cap','DEAD',7,
      now() + interval '1 hour',null,6,null,${lastErrorCode})
  `.execute(ctx.db);
  return id;
}

async function deadWebhook(source: "telegram" | "sepay") {
  const id = newId();
  await sql`
    insert into webhook_inbox
      (id,source,source_event_id,raw_hash,signature_status,processing_status,envelope,attempt_count,
       next_attempt_at,dead_lettered_at,claimed_by,claim_generation,claim_expires_at,last_error_code)
    values (${id},${source},${newId()},${"a".repeat(64)},'VERIFIED','DEAD',${JSON.stringify({ kind: "verified" })}::jsonb,
      4, null, now() - interval '1 minute', null, 5, null, 'HANDLER_FAILED')
  `.execute(ctx.db);
  return id;
}

async function supplierOrder(
  status: "UNKNOWN" | "PENDING" | "SUBMITTED" | "FULFILLED" = "UNKNOWN",
) {
  const seeded = await seedCommerce("PAID");
  const supplierId = newId();
  const supplierSkuId = newId();
  const supplierOrderId = newId();
  await sql`insert into supplier (id, name, adapter_type, credential_vault_ref) values (${supplierId}, 'S', 'fixture', 'vault:supplier')`.execute(
    ctx.db,
  );
  await sql`
    insert into supplier_sku (id, supplier_id, variant_id, external_sku, cost_vnd, region, delivery_type)
    values (${supplierSkuId}, ${supplierId}, ${seeded.variantId}, 'EXT-SKU', 100000, 'VN', 'CREDENTIAL')
  `.execute(ctx.db);
  await sql`
    insert into supplier_order
      (id, supplier_id, supplier_sku_id, order_id, idempotency_key, request_fingerprint,
       external_order_id, status, cost_vnd_snapshot, sale_price_vnd_snapshot, margin_vnd_snapshot,
       submitted_at, last_queried_at, next_reconcile_at)
    values (${supplierOrderId}, ${supplierId}, ${supplierSkuId}, ${seeded.orderId}, ${"key-" + supplierOrderId}, ${"fp-" + supplierOrderId},
      ${"external-" + supplierOrderId}, ${status}, 100000, 150000, 50000,
      now() - interval '10 minutes', now() - interval '5 minutes', null)
  `.execute(ctx.db);
  return { ...seeded, supplierOrderId };
}

describe("critical durable recovery", () => {
  it.each([
    ["outbox" as const, deadOutbox],
    ["notification_delivery" as const, deadNotification],
    [
      "delivery_notification_handoff" as const,
      () => deadHandoff("DeliveryNotificationRetryableError"),
    ],
    ["telegram_inbox" as const, () => deadWebhook("telegram")],
    ["sepay_inbox" as const, () => deadWebhook("sepay")],
  ])(
    "requeues one terminal %s row with a root audit and retry fields only",
    async (family, seed) => {
      const id = await seed();
      const result = await recoverCriticalJob(ctx.db, { family, id, ...operator });

      expect(result).toEqual({ ok: true, family, id, recovered: true });
      const audit = await auditFor(id);
      expect(audit).toHaveLength(1);
      expect(JSON.stringify(audit)).not.toContain("must-not-audit");
      expect(JSON.stringify(audit)).not.toContain("FixtureError");
    },
  );

  it("rejects unknown job families fail-closed", async () => {
    const result = await recoverCriticalJob(ctx.db, {
      family: "unknown" as CriticalRecoveryFamily,
      id: newId(),
      ...operator,
    });

    expect(result).toMatchObject({ ok: false, code: "UNSUPPORTED_JOB_FAMILY" });
  });

  it("requires the actor to match the configured root admin", async () => {
    const id = await deadOutbox("WalletRefunded");

    const result = await recoverCriticalJob(ctx.db, {
      family: "outbox",
      id,
      ...operator,
      rootAdminTelegramUserId: "222333444",
    });

    expect(result).toMatchObject({ ok: false, code: "NOT_ROOT_ADMIN" });
    const row = await sql<{ dead_lettered_at: Date | null; claim_generation: string }>`
      select dead_lettered_at, claim_generation::text from outbox_event where id=${id}
    `.execute(ctx.db);
    expect(row.rows[0]?.dead_lettered_at).not.toBeNull();
    expect(row.rows[0]?.claim_generation).toBe("3");
    expect(await auditFor(id)).toHaveLength(0);
  });

  it("rejects unsupported outbox event types fail-closed", async () => {
    const id = await deadOutbox("SupplierOrderCreateRequested");

    const result = await recoverCriticalJob(ctx.db, { family: "outbox", id, ...operator });

    expect(result).toMatchObject({ ok: false, code: "UNSUPPORTED_JOB_FAMILY" });
    const row = await sql<{ dead_lettered_at: Date | null; claim_generation: string }>`
      select dead_lettered_at, claim_generation::text from outbox_event where id=${id}
    `.execute(ctx.db);
    expect(row.rows[0]?.dead_lettered_at).not.toBeNull();
    expect(row.rows[0]?.claim_generation).toBe("3");
    expect(await auditFor(id)).toHaveLength(0);
  });

  it.each([
    [
      "outbox" as const,
      async () => {
        const id = await deadOutbox();
        await sql`update outbox_event set claimed_by='live', claim_expires_at=now()+interval '1 minute' where id=${id}`.execute(
          ctx.db,
        );
        return id;
      },
    ],
    [
      "notification_delivery" as const,
      async () => {
        const id = await deadNotification();
        await sql`update notification_delivery set claimed_by='live', claim_expires_at=now()+interval '1 minute' where id=${id}`.execute(
          ctx.db,
        );
        return id;
      },
    ],
    [
      "delivery_notification_handoff" as const,
      async () => {
        const id = await deadHandoff();
        await sql`update delivery_notification_handoff set claimed_by='live', claim_expires_at=now()+interval '1 minute' where id=${id}`.execute(
          ctx.db,
        );
        return id;
      },
    ],
  ])("denies active leases for %s", async (family, seed) => {
    const id = await seed();

    await expect(recoverCriticalJob(ctx.db, { family, id, ...operator })).resolves.toMatchObject({
      ok: false,
      code: "ACTIVE_LEASE",
    });
    expect(await auditFor(id)).toHaveLength(0);
  });

  it("rejects non-terminal rows", async () => {
    const id = await deadNotification();
    await sql`update notification_delivery set status='RETRY' where id=${id}`.execute(ctx.db);

    await expect(
      recoverCriticalJob(ctx.db, { family: "notification_delivery", id, ...operator }),
    ).resolves.toMatchObject({ ok: false, code: "NOT_TERMINAL" });
  });

  it("rejects already recovered outbox rows", async () => {
    const id = await deadOutbox();
    await expect(
      recoverCriticalJob(ctx.db, { family: "outbox", id, ...operator }),
    ).resolves.toMatchObject({ ok: true });

    await expect(
      recoverCriticalJob(ctx.db, { family: "outbox", id, ...operator }),
    ).resolves.toMatchObject({
      ok: false,
      code: "NOT_TERMINAL",
    });
    expect(await auditFor(id)).toHaveLength(1);
  });

  it("returns not found without audit", async () => {
    const id = newId();

    const result = await recoverCriticalJob(ctx.db, { family: "telegram_inbox", id, ...operator });

    expect(result).toMatchObject({ ok: false, code: "NOT_FOUND" });
    expect(await auditFor(id)).toHaveLength(0);
  });

  it("is generation fenced so two concurrent retries produce one effective recovery", async () => {
    const id = await deadOutbox();

    const [a, b] = await Promise.all([
      recoverCriticalJob(ctx.db, { family: "outbox", id, ...operator }),
      recoverCriticalJob(ctx.db, { family: "outbox", id, ...operator }),
    ]);

    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
    const row = await sql<{ dead: Date | null; generation: string; audits: number }>`
      select dead_lettered_at as dead, claim_generation::text as generation,
        (select count(*)::int from audit_event where target_id=${id}) as audits
      from outbox_event where id=${id}
    `.execute(ctx.db);
    expect(row.rows[0]).toMatchObject({ dead: null, generation: "4", audits: 1 });
  });

  it("reports stale generation conflicts without clearing the dead letter", async () => {
    const id = await deadOutbox();
    await sql`
      create function test_bump_outbox_generation() returns trigger language plpgsql as $$
      begin
        new.claim_generation := old.claim_generation + 2;
        return new;
      end;
      $$
    `.execute(ctx.db);
    await sql`
      create trigger test_stale_outbox before update on outbox_event
      for each row when (old.id = '${sql.raw(id)}') execute function test_bump_outbox_generation()
    `.execute(ctx.db);

    const result = await recoverCriticalJob(ctx.db, { family: "outbox", id, ...operator });

    expect(result).toMatchObject({ ok: false, code: "STALE" });
    const row = await sql<{ dead_lettered_at: Date | null; claim_generation: string }>`
      select dead_lettered_at, claim_generation::text from outbox_event where id=${id}
    `.execute(ctx.db);
    expect(row.rows[0]?.dead_lettered_at).not.toBeNull();
    expect(row.rows[0]?.claim_generation).toBe("3");
    expect(await auditFor(id)).toHaveLength(0);
  });

  it("queues supplier reconciliation instead of replaying ambiguous OrderPaid", async () => {
    const seeded = await supplierOrder("UNKNOWN");
    const id = await deadOutbox("OrderPaid", seeded.orderId);

    const result = await recoverCriticalJob(ctx.db, { family: "outbox", id, ...operator });

    expect(result).toEqual({ ok: true, family: "outbox", id, recovered: true });
    const row = await sql<{
      outbox_dead_lettered_at: Date | null;
      outbox_generation: string;
      supplier_status: string;
      supplier_external_order_id: string | null;
      next_reconcile_at: Date | null;
      supplier_version: number;
    }>`
      select oe.dead_lettered_at as outbox_dead_lettered_at,
        oe.claim_generation::text as outbox_generation,
        so.status as supplier_status,
        so.external_order_id as supplier_external_order_id,
        so.next_reconcile_at,
        so.version as supplier_version
      from outbox_event oe
      join supplier_order so on so.order_id = oe.aggregate_id
      where oe.id=${id}
    `.execute(ctx.db);
    expect(row.rows[0]).toMatchObject({
      outbox_dead_lettered_at: expect.any(Date),
      outbox_generation: "3",
      supplier_status: "UNKNOWN",
      supplier_external_order_id: expect.stringContaining("external-"),
      next_reconcile_at: expect.any(Date),
      supplier_version: 2,
    });
    const audit = await auditFor(id);
    expect(audit).toHaveLength(1);
    expect(audit[0]?.metadata_redacted).toMatchObject({
      beforeState: "DEAD_WITH_AMBIGUOUS_SUPPLIER_ORDER",
      afterState: "SUPPLIER_RECONCILE_QUEUED",
    });
  });

  it("routes existing supplier ambiguity to reconciliation instead of create retry", async () => {
    const seeded = await supplierOrder("UNKNOWN");

    const result = await recoverCriticalJob(ctx.db, {
      family: "supplier_order",
      id: seeded.supplierOrderId,
      ...operator,
    });

    expect(result).toEqual({
      ok: true,
      family: "supplier_order",
      id: seeded.supplierOrderId,
      recovered: true,
    });
    const row = await sql<{
      next_reconcile_at: Date | null;
      last_queried_at: Date | null;
      version: number;
    }>`
      select next_reconcile_at, last_queried_at, version from supplier_order where id=${seeded.supplierOrderId}
    `.execute(ctx.db);
    expect(row.rows[0]?.next_reconcile_at).toBeInstanceOf(Date);
    expect(row.rows[0]?.last_queried_at).toBeNull();
    expect(row.rows[0]?.version).toBe(2);
  });

  it("rejects terminal supplier orders", async () => {
    const seeded = await supplierOrder("FULFILLED");

    const result = await recoverCriticalJob(ctx.db, {
      family: "supplier_order",
      id: seeded.supplierOrderId,
      ...operator,
    });

    expect(result).toMatchObject({ ok: false, code: "NOT_TERMINAL" });
  });

  it("recovers safe internal outbox work", async () => {
    const id = await deadOutbox("WalletRefunded");

    const result = await recoverCriticalJob(ctx.db, { family: "outbox", id, ...operator });

    expect(result).toEqual({ ok: true, family: "outbox", id, recovered: true });
    const row = await sql<{
      dead_lettered_at: Date | null;
      next_attempt_at: Date | null;
      last_error_code: string | null;
    }>`
      select dead_lettered_at, next_attempt_at, last_error_code from outbox_event where id=${id}
    `.execute(ctx.db);
    expect(row.rows[0]?.dead_lettered_at).toBeNull();
    expect(row.rows[0]?.next_attempt_at).toBeInstanceOf(Date);
    expect(row.rows[0]?.last_error_code).toBeNull();
  });

  it.each([
    ["notification_delivery" as const, () => deadNotification("TelegramAmbiguousSendError")],
    ["delivery_notification_handoff" as const, () => deadHandoff("TelegramAmbiguousSendError")],
    [
      "delivery_notification_handoff" as const,
      () => deadHandoff("DeliveryNotificationSendTimeoutError"),
    ],
  ])("gates ambiguous Telegram terminal checks for %s", async (family, seed) => {
    const id = await seed();

    await expect(recoverCriticalJob(ctx.db, { family, id, ...operator })).resolves.toMatchObject({
      ok: false,
      code: "MANUAL_REVIEW_REQUIRED",
    });
    expect(await auditFor(id)).toHaveLength(0);
  });
});
