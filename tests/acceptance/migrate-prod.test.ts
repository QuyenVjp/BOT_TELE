import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { cp, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { sql } from "kysely";
import { listMigrationFiles, runMigrations } from "../../src/infrastructure/db/migrate.js";
import { createInMemoryVault } from "../../src/infrastructure/vault/testing-adapter.js";
import type { QueryOrderInput, SupplierPort } from "../../src/modules/supplier/port.js";
import { recoverUnknownSupplierOrder } from "../../src/modules/supplier/service.js";
import { dockerAvailable, startPostgres } from "../helpers/pg-container.js";

const repoRoot = resolve(import.meta.dirname, "..", "..");
const hasDocker = await dockerAvailable();

describe("compiled production migration entrypoint (T173)", () => {
  it("defines migrate:prod as a Node launch of the compiled migration artifact", () => {
    const pkg = JSON.parse(readFileSync(resolve(repoRoot, "package.json"), "utf8")) as {
      scripts?: Record<string, string>;
    };
    expect(pkg.scripts?.["migrate:prod"]).toBe("node dist/infrastructure/db/migrate.js");
    expect(pkg.scripts?.["migrate:prod"]).not.toContain("tsx");
  });

  it("has a compiled migration artifact that can run without tsx", async () => {
    const artifact = resolve(repoRoot, "dist", "infrastructure", "db", "migrate.js");
    expect(existsSync(artifact), "run npm run build before this acceptance lane").toBe(true);
    if (!hasDocker) return;

    const started = await startPostgres();
    try {
      const result = await runCompiledMigration(started.connectionString);
      expect(result.code, result.stderr).toBe(0);
      expect(`${result.stdout}\n${result.stderr}`).toMatch(/migrate: applied=/);
    } finally {
      await started.stop();
    }
  }, 180_000);

  it("upgrades a SePay-only 008 database with compiled migrate:prod and preserves rows", async () => {
    if (!hasDocker) return;
    const started = await startPostgres();
    const baselineDir = await createBaselineMigrationDir();
    try {
      await resetTo008(started, baselineDir);
      await sql`insert into customer (id) values ('legacy-customer')`.execute(started.handle.db);
      await sql`
        insert into channel_identity
          (id, customer_id, channel, channel_user_id, observed_username)
        values ('legacy-identity', 'legacy-customer', 'telegram', '7788990011', 'observed_user')
      `.execute(started.handle.db);

      const result = await runCompiledMigration(started.connectionString);
      expect(result.code, result.stderr).toBe(0);
      const proof = await sql<{
        channel: string;
        observed_username: string | null;
        delivery_session: string | null;
        handoff: string | null;
        compensation: string | null;
        supplier_canary_run: string | null;
        applied_094_count: string;
        applied_095_count: string;
      }>`
        select ci.channel, ci.observed_username,
          to_regclass('public.delivery_session')::text as delivery_session,
          to_regclass('public.delivery_notification_handoff')::text as handoff,
          to_regclass('public.delivery_capability_compensation')::text as compensation,
          to_regclass('public.supplier_canary_run')::text as supplier_canary_run,
          (select count(*)::text from schema_migrations
           where filename = '094_supplier_owner_canary.sql') as applied_094_count,
          (select count(*)::text from schema_migrations
           where filename = '095_supplier_unknown_query_key_backfill.sql') as applied_095_count
        from channel_identity ci where ci.id = 'legacy-identity'
      `.execute(started.handle.db);
      expect(proof.rows[0]).toMatchObject({
        channel: "TELEGRAM",
        observed_username: "observed_user",
        delivery_session: "delivery_session",
        handoff: "delivery_notification_handoff",
        compensation: "delivery_capability_compensation",
        supplier_canary_run: "supplier_canary_run",
        applied_094_count: "1",
        applied_095_count: "1",
      });
    } finally {
      await rm(baselineDir, { recursive: true, force: true });
      await started.stop();
    }
  }, 180_000);

  it("upgrades the prior expanded-008 shape without recreating or losing delivery rows", async () => {
    if (!hasDocker) return;
    const started = await startPostgres();
    const baselineDir = await createBaselineMigrationDir();
    try {
      await resetTo008(started, baselineDir);
      await installExpanded008Shape(started);
      await sql`insert into customer (id) values ('expanded-customer')`.execute(started.handle.db);
      await sql`
        insert into channel_identity (id, customer_id, channel, channel_user_id)
        values ('expanded-identity', 'expanded-customer', 'TELEGRAM', '88776655')
      `.execute(started.handle.db);
      await seedHistoricalDeliveryRows(started);

      const result = await runCompiledMigration(started.connectionString);
      expect(result.code, result.stderr).toBe(0);
      const proof = await sql<{
        channel: string;
        count: string;
        session_count: string;
        handoff_count: string;
        capability_key: string;
        capability_ref_nullable: string;
        status_constraint: string;
        due_index: string;
        processing_index: string;
        compensation: string | null;
        activated: boolean;
      }>`
        select ci.channel,
          (select count(*)::text from schema_migrations
           where filename = '009_identity_delivery_security.sql') as count,
          (select count(*)::text from delivery_session where id = 'expanded-session') as session_count,
          (select count(*)::text from delivery_notification_handoff where id = 'expanded-handoff') as handoff_count,
          (select capability_key from delivery_notification_handoff where id = 'expanded-handoff') as capability_key,
          (select is_nullable from information_schema.columns
           where table_schema = 'public' and table_name = 'delivery_notification_handoff'
             and column_name = 'capability_ref') as capability_ref_nullable,
          (select pg_get_constraintdef(oid) from pg_constraint
           where conrelid = 'delivery_notification_handoff'::regclass
             and conname = 'delivery_notification_handoff_status_ck') as status_constraint,
          pg_get_indexdef('delivery_notification_due_idx'::regclass) as due_index,
          pg_get_indexdef('delivery_notification_processing_lease_idx'::regclass) as processing_index,
          to_regclass('public.delivery_capability_compensation')::text as compensation,
          (select activated_at is not null from delivery_session
           where id = 'expanded-session') as activated
        from channel_identity ci where ci.id = 'expanded-identity'
      `.execute(started.handle.db);
      expect(proof.rows[0]).toMatchObject({
        channel: "TELEGRAM",
        count: "1",
        session_count: "1",
        handoff_count: "1",
        capability_key: "expanded-bundle:88776655",
        capability_ref_nullable: "YES",
        compensation: "delivery_capability_compensation",
        activated: true,
      });
      expect(proof.rows[0]?.status_constraint).toMatch(/PREPARED.*STORED.*READY.*PROCESSING/s);
      expect(proof.rows[0]?.due_index).toContain(
        "status = ANY (ARRAY['PREPARED'::text, 'STORED'::text, 'READY'::text, 'RETRY'::text])",
      );
      expect(proof.rows[0]?.due_index).not.toContain("PROCESSING");
      expect(proof.rows[0]?.processing_index).toContain("(claim_expires_at, id)");
      expect(proof.rows[0]?.processing_index).toContain("status = 'PROCESSING'::text");
    } finally {
      await rm(baselineDir, { recursive: true, force: true });
      await started.stop();
    }
  }, 180_000);

  it("fails closed and preserves both rows on a telegram/TELEGRAM collision", async () => {
    if (!hasDocker) return;
    const started = await startPostgres();
    const baselineDir = await createBaselineMigrationDir();
    try {
      await resetTo008(started, baselineDir);
      await sql`insert into customer (id) values ('customer-a'), ('customer-b')`.execute(
        started.handle.db,
      );
      await sql`
        insert into channel_identity (id, customer_id, channel, channel_user_id)
        values
          ('identity-a', 'customer-a', 'telegram', '99887766'),
          ('identity-b', 'customer-b', 'TELEGRAM', '99887766')
      `.execute(started.handle.db);

      const result = await runCompiledMigration(started.connectionString);
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain("TELEGRAM_CHANNEL_COLLISION");
      const preserved = await sql<{ count: string }>`
        select count(*)::text as count from channel_identity where channel_user_id = '99887766'
      `.execute(started.handle.db);
      expect(preserved.rows[0]?.count).toBe("2");
    } finally {
      await rm(baselineDir, { recursive: true, force: true });
      await started.stop();
    }
  }, 180_000);
  it("applies the UNKNOWN query-key backfill after 094 is already recorded and scopes keys per supplier", async () => {
    if (!hasDocker) return;
    const started = await startPostgres();
    const baselineDir = await createPreMigrationDir("094_supplier_owner_canary.sql");
    const recorded094Dir = await createSingle094MigrationDir();
    try {
      await sql`drop schema public cascade`.execute(started.handle.db);
      await sql`create schema public`.execute(started.handle.db);
      const baseline = await runMigrations(started.handle.db, baselineDir);
      expect(baseline.applied.some((file) => file.startsWith("093_"))).toBe(true);
      expect(baseline.applied).not.toContain("094_supplier_owner_canary.sql");
      await sql`insert into customer (id) values ('pre-canary-customer')`.execute(
        started.handle.db,
      );
      await seedPreCanarySupplierRecoveryRows(started);
      await seedCrossSupplierUnknownRow(started);

      const before = await sql<{ canary_table: string | null; query_key_column: string | null }>`
        select
          to_regclass('public.supplier_canary_run')::text as canary_table,
          (select column_name from information_schema.columns
           where table_schema = 'public' and table_name = 'supplier_order'
             and column_name = 'query_key' limit 1) as query_key_column
      `.execute(started.handle.db);
      expect(before.rows[0]).toEqual({ canary_table: null, query_key_column: null });

      const recorded094 = await runMigrations(started.handle.db, recorded094Dir);
      expect(recorded094.applied).toEqual(["094_supplier_owner_canary.sql"]);
      const after094 = await sql<{
        legacy_query_key: string | null;
        legacy_external_order_id: string | null;
        applied_094_count: string;
        applied_095_count: string;
      }>`
        select
          (select query_key from supplier_order where id = 'pre-canary-unknown') as legacy_query_key,
          (select external_order_id from supplier_order where id = 'pre-canary-unknown') as legacy_external_order_id,
          (select count(*)::text from schema_migrations
           where filename = '094_supplier_owner_canary.sql') as applied_094_count,
          (select count(*)::text from schema_migrations
           where filename = '095_supplier_unknown_query_key_backfill.sql') as applied_095_count
      `.execute(started.handle.db);
      expect(after094.rows[0]).toEqual({
        legacy_query_key: null,
        legacy_external_order_id: "legacy-query-key",
        applied_094_count: "1",
        applied_095_count: "0",
      });

      const upgrade = await runCompiledMigration(started.connectionString);
      expect(upgrade.code, upgrade.stderr).toBe(0);
      expect(upgrade.stdout).toMatch(/migrate: applied=1/);
      const proof = await sql<{
        canary_table: string | null;
        query_key_column: string | null;
        command_constraint: string | null;
        canary_status_constraint: string | null;
        preserved_customers: string;
        legacy_supplier_id: string;
        second_supplier_id: string;
        legacy_query_key: string | null;
        second_supplier_query_key: string | null;
        legacy_external_order_id: string | null;
        second_supplier_external_order_id: string | null;
        provider_external_order_id: string | null;
        provider_query_key: string | null;
        query_key_index: string | null;
        applied_094_count: string;
        applied_095_count: string;
      }>`
        select
          to_regclass('public.supplier_canary_run')::text as canary_table,
          (select column_name from information_schema.columns
           where table_schema = 'public' and table_name = 'supplier_order'
             and column_name = 'query_key' limit 1) as query_key_column,
          (select pg_get_constraintdef(oid) from pg_constraint
           where conrelid = 'admin_confirmation'::regclass
             and conname = 'admin_confirmation_command_ref_ck') as command_constraint,
          (select pg_get_constraintdef(oid) from pg_constraint
           where conrelid = 'supplier_canary_run'::regclass and contype = 'c'
             and pg_get_constraintdef(oid) like '%PREVIEWED%') as canary_status_constraint,
          (select count(*)::text from customer where id = 'pre-canary-customer') as preserved_customers,
          (select supplier_id from supplier_order where id = 'pre-canary-unknown') as legacy_supplier_id,
          (select supplier_id from supplier_order where id = 'pre-canary-unknown-other') as second_supplier_id,
          (select query_key from supplier_order where id = 'pre-canary-unknown') as legacy_query_key,
          (select query_key from supplier_order where id = 'pre-canary-unknown-other')
            as second_supplier_query_key,
          (select external_order_id from supplier_order where id = 'pre-canary-unknown')
            as legacy_external_order_id,
          (select external_order_id from supplier_order where id = 'pre-canary-unknown-other')
            as second_supplier_external_order_id,
          (select external_order_id from supplier_order where id = 'pre-canary-pending')
            as provider_external_order_id,
          (select query_key from supplier_order where id = 'pre-canary-pending') as provider_query_key,
          pg_get_indexdef(to_regclass('public.supplier_order_query_key_uq')::oid) as query_key_index,
          (select count(*)::text from schema_migrations
           where filename = '094_supplier_owner_canary.sql') as applied_094_count,
          (select count(*)::text from schema_migrations
           where filename = '095_supplier_unknown_query_key_backfill.sql') as applied_095_count
      `.execute(started.handle.db);
      expect(proof.rows[0]).toMatchObject({
        canary_table: "supplier_canary_run",
        query_key_column: "query_key",
        preserved_customers: "1",
        legacy_supplier_id: "pre-canary-supplier",
        second_supplier_id: "pre-canary-supplier-other",
        legacy_query_key: "legacy-query-key",
        second_supplier_query_key: "legacy-query-key",
        legacy_external_order_id: "legacy-query-key",
        second_supplier_external_order_id: "legacy-query-key",
        provider_external_order_id: "provider-order-123",
        provider_query_key: null,
        applied_094_count: "1",
        applied_095_count: "1",
      });
      expect(proof.rows[0]?.query_key_index).toContain("(supplier_id, query_key)");
      expect(proof.rows[0]?.command_constraint).toContain("supplier.canary.purchase");
      expect(proof.rows[0]?.canary_status_constraint).toContain("SUBMITTED");
      expect(proof.rows[0]?.canary_status_constraint).toContain("UNKNOWN");

      const reentry = await runCompiledMigration(started.connectionString);
      expect(reentry.code, reentry.stderr).toBe(0);
      expect(reentry.stdout).toMatch(/migrate: applied=0/);
      const receipts = await sql<{
        applied_094_count: string;
        applied_095_count: string;
      }>`
        select
          (select count(*)::text from schema_migrations
           where filename = '094_supplier_owner_canary.sql') as applied_094_count,
          (select count(*)::text from schema_migrations
           where filename = '095_supplier_unknown_query_key_backfill.sql') as applied_095_count
      `.execute(started.handle.db);
      expect(receipts.rows[0]).toEqual({ applied_094_count: "1", applied_095_count: "1" });

      let creates = 0;
      const queries: QueryOrderInput[] = [];
      const port: SupplierPort = {
        getAvailability: async () => ({
          status: "AVAILABLE",
          observedAt: new Date().toISOString(),
        }),
        createOrder: async () => {
          creates += 1;
          throw new Error("legacy UNKNOWN recovery must not create");
        },
        queryOrder: async (input) => {
          queries.push(input);
          return { status: "PENDING", externalOrderId: "provider-order-recovered" };
        },
        cancelOrder: async () => ({ status: "UNSUPPORTED" }),
        requestRefund: async () => ({ status: "UNSUPPORTED" }),
        reconcile: async () => ({ observations: [], nextCursor: null }),
      };
      const recovered = await recoverUnknownSupplierOrder(started.handle.db, {
        supplierOrderId: "pre-canary-unknown",
        queryKey: "caller-fallback-key",
        expectedSku: "PRE-CANARY-SKU",
        deliveryType: "CREDENTIAL",
        durationCode: "P1M",
        region: "VN",
        correlationId: "pre-canary-recovery",
        port,
        vault: createInMemoryVault(),
      });
      expect(recovered).toEqual({ ok: true, kind: "PENDING" });
      expect(queries).toEqual([{ queryKey: "legacy-query-key", expectedSku: "PRE-CANARY-SKU" }]);
      expect(creates).toBe(0);

      const preservedProviderId = await sql<{ external_order_id: string | null }>`
        select external_order_id from supplier_order where id = 'pre-canary-pending'
      `.execute(started.handle.db);
      expect(preservedProviderId.rows[0]?.external_order_id).toBe("provider-order-123");
    } finally {
      await rm(baselineDir, { recursive: true, force: true });
      await rm(recorded094Dir, { recursive: true, force: true });
      await started.stop();
    }
  }, 180_000);
  it("rolls back the UNKNOWN query-key backfill on a per-supplier collision", async () => {
    if (!hasDocker) return;
    const started = await startPostgres();
    const baselineDir = await createPreMigrationDir("094_supplier_owner_canary.sql");
    const recorded094Dir = await createSingle094MigrationDir();
    try {
      await sql`drop schema public cascade`.execute(started.handle.db);
      await sql`create schema public`.execute(started.handle.db);
      const baseline = await runMigrations(started.handle.db, baselineDir);
      expect(baseline.applied.some((file) => file.startsWith("093_"))).toBe(true);
      await sql`insert into customer (id) values ('pre-canary-customer')`.execute(
        started.handle.db,
      );
      await seedPreCanarySupplierRecoveryRows(started);

      const recorded094 = await runMigrations(started.handle.db, recorded094Dir);
      expect(recorded094.applied).toEqual(["094_supplier_owner_canary.sql"]);
      await sql`
        update supplier_order
        set status = 'UNKNOWN',
            idempotency_key = 'legacy-query-key',
            provider_client_order_id = 'legacy-query-key',
            external_order_id = null,
            query_key = 'legacy-query-key'
        where id = 'pre-canary-pending'
      `.execute(started.handle.db);
      const result = await runCompiledMigration(started.connectionString);
      expect(result.code).not.toBe(0);
      const proof = await sql<{
        legacy_external_order_id: string | null;
        legacy_query_key: string | null;
        current_status: string;
        current_external_order_id: string | null;
        current_provider_client_order_id: string | null;
        current_query_key: string | null;
        applied_094_count: string;
        applied_095_count: string;
        query_key_index: string | null;
      }>`
        select
          (select external_order_id from supplier_order where id = 'pre-canary-unknown')
            as legacy_external_order_id,
          (select query_key from supplier_order where id = 'pre-canary-unknown')
            as legacy_query_key,
          (select status from supplier_order where id = 'pre-canary-pending') as current_status,
          (select external_order_id from supplier_order where id = 'pre-canary-pending')
            as current_external_order_id,
          (select provider_client_order_id from supplier_order where id = 'pre-canary-pending')
            as current_provider_client_order_id,
          (select query_key from supplier_order where id = 'pre-canary-pending')
            as current_query_key,
          (select count(*)::text from schema_migrations
           where filename = '094_supplier_owner_canary.sql') as applied_094_count,
          (select count(*)::text from schema_migrations
           where filename = '095_supplier_unknown_query_key_backfill.sql') as applied_095_count,
          to_regclass('public.supplier_order_query_key_uq')::text as query_key_index
      `.execute(started.handle.db);
      expect(proof.rows[0]).toEqual({
        legacy_external_order_id: "legacy-query-key",
        legacy_query_key: null,
        current_status: "UNKNOWN",
        current_external_order_id: null,
        current_provider_client_order_id: "legacy-query-key",
        current_query_key: "legacy-query-key",
        applied_094_count: "1",
        applied_095_count: "0",
        query_key_index: null,
      });
    } finally {
      await rm(baselineDir, { recursive: true, force: true });
      await rm(recorded094Dir, { recursive: true, force: true });
      await started.stop();
    }
  }, 180_000);
  it("upgrades pre-096 notification deliveries without loss and records migration once", async () => {
    if (!hasDocker) return;
    const started = await startPostgres();
    const pre096Dir = await createPreMigrationDir("096_notification_send_uncertain.sql");
    try {
      await sql`drop schema public cascade`.execute(started.handle.db);
      await sql`create schema public`.execute(started.handle.db);
      const baseline = await runMigrations(started.handle.db, pre096Dir);
      expect(baseline.applied).toContain("094_supplier_owner_canary.sql");
      expect(baseline.applied).toContain("095_supplier_unknown_query_key_backfill.sql");

      await sql`
        insert into customer (id) values
          ('pre095-pending-customer'), ('pre095-sent-customer'),
          ('pre095-retry-customer'), ('pre095-suppressed-customer'),
          ('pre095-dead-customer'), ('pre095-uncertain-customer')
      `.execute(started.handle.db);
      await sql`
        insert into notification_campaign
          (id, class, content, status, idempotency_key, created_by)
        values
          ('pre095-campaign', 'CRITICAL_SERVICE', 'preserve me', 'QUEUED',
           'pre095-campaign', 'test')
      `.execute(started.handle.db);
      await sql`
        insert into notification_delivery (id, campaign_id, customer_id, chat_id, status)
        values
          ('pre095-pending', 'pre095-campaign', 'pre095-pending-customer', '10001', 'PENDING'),
          ('pre095-sent', 'pre095-campaign', 'pre095-sent-customer', '10002', 'SENT'),
          ('pre095-retry', 'pre095-campaign', 'pre095-retry-customer', '10003', 'RETRY'),
          ('pre095-suppressed', 'pre095-campaign', 'pre095-suppressed-customer', '10004', 'SUPPRESSED'),
          ('pre095-dead', 'pre095-campaign', 'pre095-dead-customer', '10005', 'DEAD')
      `.execute(started.handle.db);
      await sql`
        update notification_delivery
        set attempts = 1, message_id = 'telegram-pre095-sent',
            sent_at = '2020-01-02T03:04:05.000Z'
        where id = 'pre095-sent'
      `.execute(started.handle.db);
      await sql`
        update notification_delivery
        set attempts = 3, next_attempt_at = '2099-01-02T03:04:05.000Z',
            last_error = 'temporary-pre095-failure'
        where id = 'pre095-retry'
      `.execute(started.handle.db);
      await sql`
        insert into category (id, name_vi, slug)
        values ('pre095-category', 'Pre-095', 'pre095-category')
      `.execute(started.handle.db);
      await sql`
        insert into product (id, category_id, name_vi, slug)
        values ('pre095-product', 'pre095-category', 'Pre-095 product', 'pre095-product')
      `.execute(started.handle.db);
      await sql`
        insert into product_variant
          (id, product_id, sku, name_vi, price_vnd, duration_code, delivery_type, stock_policy)
        values
          ('pre095-manual-variant', 'pre095-product', 'PRE095-MANUAL', 'Manual', 1000, '1M', 'MANUAL_REVIEW', 'PAUSED'),
          ('pre095-stock-variant', 'pre095-product', 'PRE095-STOCK', 'Stock', 1000, '1M', 'CREDENTIAL', 'LOCAL_ONLY')
      `.execute(started.handle.db);
      await sql`
        insert into "order"
          (id, order_number, customer_id, variant_id, product_name_vi, variant_name_vi,
           price_vnd, duration_code, delivery_type, status, paid_at)
        values
          ('pre095-manual-sent-order', 'PRE095-MANUAL-SENT', 'pre095-sent-customer', 'pre095-manual-variant',
           'Manual', 'Plan', 1000, '1M', 'MANUAL_REVIEW', 'PAID', '2020-01-02T03:04:05.000Z'),
          ('pre095-manual-retry-order', 'PRE095-MANUAL-RETRY', 'pre095-sent-customer', 'pre095-manual-variant',
           'Manual', 'Plan', 1000, '1M', 'MANUAL_REVIEW', 'PAID', '2020-01-02T03:04:05.000Z'),
          ('pre095-normal-order', 'PRE095-NORMAL', 'pre095-pending-customer', 'pre095-stock-variant',
           'Stock', 'Plan', 1000, '1M', 'CREDENTIAL', 'PAID', '2020-01-02T03:04:05.000Z')
      `.execute(started.handle.db);
      await sql`
        insert into notification_campaign
          (id, class, content, status, idempotency_key, created_by)
        values
          ('admin-payment-settled:pre095-manual-sent-order', 'CRITICAL_SERVICE', 'legacy manual sent', 'COMPLETED',
           'admin-payment-settled:pre095-manual-sent-order', 'test'),
          ('admin-payment-settled:pre095-manual-retry-order', 'CRITICAL_SERVICE', 'legacy manual retry', 'QUEUED',
           'admin-payment-settled:pre095-manual-retry-order', 'test'),
          ('admin-payment-settled:pre095-normal-order', 'CRITICAL_SERVICE', 'ordinary payment alert', 'COMPLETED',
           'admin-payment-settled:pre095-normal-order', 'test')
      `.execute(started.handle.db);
      await sql`
        insert into notification_delivery (id, campaign_id, customer_id, chat_id, status)
        values
          ('pre095-manual-sent-delivery', 'admin-payment-settled:pre095-manual-sent-order', 'pre095-sent-customer', '10007', 'SENT'),
          ('pre095-manual-retry-delivery', 'admin-payment-settled:pre095-manual-retry-order', 'pre095-sent-customer', '10008', 'RETRY'),
          ('pre095-normal-delivery', 'admin-payment-settled:pre095-normal-order', 'pre095-pending-customer', '10009', 'SENT')
      `.execute(started.handle.db);
      await sql`
        update notification_delivery
        set attempts = 2, message_id = 'telegram-pre095-manual-sent',
            sent_at = '2020-01-02T03:04:05.000Z'
        where id = 'pre095-manual-sent-delivery'
      `.execute(started.handle.db);
      await sql`
        update notification_delivery
        set attempts = 3, next_attempt_at = '2099-01-02T03:04:05.000Z',
            last_error = 'temporary-pre095-manual-failure'
        where id = 'pre095-manual-retry-delivery'
      `.execute(started.handle.db);
      await sql`
        insert into notification_campaign_audience (campaign_id, stage, customer_id, chat_id)
        values
          ('admin-payment-settled:pre095-manual-retry-order', 'PREVIEW', 'pre095-sent-customer', '10008'),
          ('admin-payment-settled:pre095-manual-retry-order', 'CONFIRMED', 'pre095-sent-customer', '10008')
      `.execute(started.handle.db);
      await sql`
        update notification_campaign
        set previewed_at = '2020-01-02T03:04:05.000Z',
            confirmed_at = '2020-01-02T03:04:05.000Z',
            confirmed_by = 'test-owner'
        where id = 'admin-payment-settled:pre095-manual-retry-order'
      `.execute(started.handle.db);

      const fulfillmentTypes = await sql<{ id: string; fulfillment_type: string }>`
        select id, fulfillment_type from "order"
        where id in ('pre095-manual-sent-order', 'pre095-manual-retry-order', 'pre095-normal-order')
        order by id
      `.execute(started.handle.db);
      expect(fulfillmentTypes.rows).toEqual([
        { id: "pre095-manual-retry-order", fulfillment_type: "MANUAL_FULFILLMENT" },
        { id: "pre095-manual-sent-order", fulfillment_type: "MANUAL_FULFILLMENT" },
        { id: "pre095-normal-order", fulfillment_type: "STOCK_ACCOUNT" },
      ]);

      const campaignBefore = await sql<{
        id: string;
        class: string;
        content: string;
        status: string;
        idempotency_key: string;
        created_by: string;
        created_at: Date;
        audience: string;
        previewed_at: Date | null;
        product_variant_id: string | null;
        revision: number;
        previewed_content_hash: string | null;
        previewed_audience_hash: string | null;
        previewed_audience_count: number | null;
        confirmed_at: Date | null;
        confirmed_by: string | null;
        audience_hash: string | null;
        buttons: unknown;
      }>`
        select id, class, content, status, idempotency_key, created_by, created_at,
          audience, previewed_at, product_variant_id, revision,
          previewed_content_hash, previewed_audience_hash, previewed_audience_count,
          confirmed_at, confirmed_by, audience_hash, buttons
        from notification_campaign
        where id like 'admin-payment-settled:pre095-%'
        order by id
      `.execute(started.handle.db);
      const manualDeliveriesBefore = await sql<{
        id: string;
        campaign_id: string;
        customer_id: string;
        chat_id: string;
        status: string;
        attempts: number;
        next_attempt_at: Date;
        last_error: string | null;
        sent_at: Date | null;
        message_id: string | null;
      }>`
        select id, campaign_id, customer_id, chat_id, status, attempts,
          next_attempt_at, last_error, sent_at, message_id
        from notification_delivery
        where id in ('pre095-manual-sent-delivery', 'pre095-manual-retry-delivery', 'pre095-normal-delivery')
        order by id
      `.execute(started.handle.db);
      const audienceBefore = await sql<{
        campaign_id: string;
        stage: string;
        customer_id: string;
        chat_id: string;
      }>`
        select campaign_id, stage, customer_id, chat_id
        from notification_campaign_audience
        where campaign_id = 'admin-payment-settled:pre095-manual-retry-order'
        order by stage, customer_id
      `.execute(started.handle.db);
      const rekeyManualCampaign = (id: string): string =>
        id.startsWith("admin-payment-settled:pre095-manual-")
          ? id.replace("admin-payment-settled:", "admin-manual-order:")
          : id;

      expect(campaignBefore.rows).toHaveLength(3);
      expect(manualDeliveriesBefore.rows).toHaveLength(3);
      expect(audienceBefore.rows).toHaveLength(2);

      const manualCampaignIds = new Set([
        "admin-payment-settled:pre095-manual-sent-order",
        "admin-payment-settled:pre095-manual-retry-order",
      ]);
      const expectedCampaigns = campaignBefore.rows
        .map((campaign) => ({
          ...campaign,
          id: rekeyManualCampaign(campaign.id),
          idempotency_key: manualCampaignIds.has(campaign.id)
            ? rekeyManualCampaign(campaign.id)
            : campaign.idempotency_key,
        }))
        .sort((left, right) => left.id.localeCompare(right.id));
      const expectedManualDeliveries = manualDeliveriesBefore.rows
        .map((delivery) => ({
          ...delivery,
          campaign_id: rekeyManualCampaign(delivery.campaign_id),
        }))
        .sort((left, right) => left.id.localeCompare(right.id));
      const expectedAudience = audienceBefore.rows.map((audience) => ({
        ...audience,
        campaign_id: rekeyManualCampaign(audience.campaign_id),
      }));
      await sql`
        insert into notification_campaign
          (id, class, content, status, idempotency_key, created_by)
        values
          ('admin-manual-order:pre095-manual-retry-order', 'CRITICAL_SERVICE', 'conflicting target', 'QUEUED',
           'admin-manual-order:pre095-manual-retry-order', 'test')
      `.execute(started.handle.db);

      await expect(runMigrations(started.handle.db)).rejects.toThrow(
        /manual alert campaign identity collision/,
      );
      const campaignsAfterCollision = await sql<{ count: string }>`
        select count(*)::text as count from notification_campaign
        where id in (
          'admin-payment-settled:pre095-manual-sent-order',
          'admin-payment-settled:pre095-manual-retry-order'
        )
      `.execute(started.handle.db);
      expect(campaignsAfterCollision.rows[0]?.count).toBe("2");
      const deliveriesAfterCollision = await sql<{
        id: string;
        campaign_id: string;
        customer_id: string;
        chat_id: string;
        status: string;
        attempts: number;
        next_attempt_at: Date;
        last_error: string | null;
        sent_at: Date | null;
        message_id: string | null;
      }>`
        select id, campaign_id, customer_id, chat_id, status, attempts,
          next_attempt_at, last_error, sent_at, message_id
        from notification_delivery
        where id in ('pre095-manual-sent-delivery', 'pre095-manual-retry-delivery', 'pre095-normal-delivery')
        order by id
      `.execute(started.handle.db);
      expect(deliveriesAfterCollision.rows).toEqual(manualDeliveriesBefore.rows);
      const audienceAfterCollision = await sql<{
        campaign_id: string;
        stage: string;
        customer_id: string;
        chat_id: string;
      }>`
        select campaign_id, stage, customer_id, chat_id
        from notification_campaign_audience
        where campaign_id = 'admin-payment-settled:pre095-manual-retry-order'
        order by stage, customer_id
      `.execute(started.handle.db);
      expect(audienceAfterCollision.rows).toEqual(audienceBefore.rows);
      const receiptAfterCollision = await sql<{ count: string }>`
        select count(*)::text as count from schema_migrations
        where filename = '096_notification_send_uncertain.sql'
      `.execute(started.handle.db);
      expect(receiptAfterCollision.rows[0]?.count).toBe("0");
      await sql`
        delete from notification_campaign
        where id = 'admin-manual-order:pre095-manual-retry-order'
      `.execute(started.handle.db);

      const legacyRows = [
        { id: "pre095-dead", status: "DEAD" },
        { id: "pre095-pending", status: "PENDING" },
        { id: "pre095-retry", status: "RETRY" },
        { id: "pre095-sent", status: "SENT" },
        { id: "pre095-suppressed", status: "SUPPRESSED" },
      ];
      const before = await sql<{
        id: string;
        status: string;
        attempts: number;
        next_attempt_at: Date;
        last_error: string | null;
        sent_at: Date | null;
        message_id: string | null;
      }>`
        select id, status, attempts, next_attempt_at, last_error, sent_at, message_id
        from notification_delivery
        where campaign_id = 'pre095-campaign' order by id
      `.execute(started.handle.db);
      expect(before.rows.map(({ id, status }) => ({ id, status }))).toEqual(legacyRows);
      expect(before.rows.find(({ id }) => id === "pre095-sent")).toMatchObject({
        attempts: 1,
        sent_at: expect.any(Date),
        message_id: "telegram-pre095-sent",
      });
      expect(before.rows.find(({ id }) => id === "pre095-retry")).toMatchObject({
        attempts: 3,
        next_attempt_at: expect.any(Date),
        last_error: "temporary-pre095-failure",
      });
      const upgrade = await runMigrations(started.handle.db);
      expect(upgrade.applied).toContain("096_notification_send_uncertain.sql");
      const after = await sql<{
        id: string;
        status: string;
        attempts: number;
        next_attempt_at: Date;
        last_error: string | null;
        sent_at: Date | null;
        message_id: string | null;
      }>`
        select id, status, attempts, next_attempt_at, last_error, sent_at, message_id
        from notification_delivery
        where campaign_id = 'pre095-campaign' order by id
      `.execute(started.handle.db);
      expect(after.rows).toEqual(before.rows);

      const afterManualCampaigns = await sql<{
        id: string;
        class: string;
        content: string;
        status: string;
        idempotency_key: string;
        created_by: string;
        created_at: Date;
        audience: string;
        previewed_at: Date | null;
        product_variant_id: string | null;
        revision: number;
        previewed_content_hash: string | null;
        previewed_audience_hash: string | null;
        previewed_audience_count: number | null;
        confirmed_at: Date | null;
        confirmed_by: string | null;
        audience_hash: string | null;
        buttons: unknown;
      }>`
        select id, class, content, status, idempotency_key, created_by, created_at,
          audience, previewed_at, product_variant_id, revision,
          previewed_content_hash, previewed_audience_hash, previewed_audience_count,
          confirmed_at, confirmed_by, audience_hash, buttons
        from notification_campaign
        where id in (
          'admin-manual-order:pre095-manual-sent-order',
          'admin-manual-order:pre095-manual-retry-order',
          'admin-payment-settled:pre095-normal-order'
        )
        order by id
      `.execute(started.handle.db);
      expect(afterManualCampaigns.rows).toEqual(expectedCampaigns);

      const afterManualDeliveries = await sql<{
        id: string;
        campaign_id: string;
        customer_id: string;
        chat_id: string;
        status: string;
        attempts: number;
        next_attempt_at: Date;
        last_error: string | null;
        sent_at: Date | null;
        message_id: string | null;
      }>`
        select id, campaign_id, customer_id, chat_id, status, attempts,
          next_attempt_at, last_error, sent_at, message_id
        from notification_delivery
        where id in ('pre095-manual-sent-delivery', 'pre095-manual-retry-delivery', 'pre095-normal-delivery')
        order by id
      `.execute(started.handle.db);
      expect(afterManualDeliveries.rows).toEqual(expectedManualDeliveries);

      const afterAudience = await sql<{
        campaign_id: string;
        stage: string;
        customer_id: string;
        chat_id: string;
      }>`
        select campaign_id, stage, customer_id, chat_id
        from notification_campaign_audience
        where campaign_id = 'admin-manual-order:pre095-manual-retry-order'
        order by stage, customer_id
      `.execute(started.handle.db);
      expect(afterAudience.rows).toEqual(expectedAudience);
      const preservedConfirmedAudience = await sql<{
        campaign_id: string;
        stage: string;
        customer_id: string;
        chat_id: string;
      }>`
        select campaign_id, stage, customer_id, chat_id
        from notification_campaign_audience
        where campaign_id = 'admin-payment-settled:pre095-manual-retry-order'
          and stage = 'CONFIRMED'
        order by stage, customer_id
      `.execute(started.handle.db);
      expect(preservedConfirmedAudience.rows).toEqual(
        audienceBefore.rows.filter(({ stage }) => stage === "CONFIRMED"),
      );

      const retainedLegacyManual = await sql<{
        id: string;
        status: string;
        delivery_count: number;
      }>`
        select legacy.id, legacy.status, count(delivery.id)::int as delivery_count
        from notification_campaign legacy
        left join notification_delivery delivery on delivery.campaign_id = legacy.id
        where legacy.id in (
          'admin-payment-settled:pre095-manual-sent-order',
          'admin-payment-settled:pre095-manual-retry-order'
        )
        group by legacy.id, legacy.status
        order by legacy.id
      `.execute(started.handle.db);
      expect(retainedLegacyManual.rows).toEqual([
        {
          id: "admin-payment-settled:pre095-manual-retry-order",
          status: "CANCELLED",
          delivery_count: 0,
        },
      ]);

      await sql`
        insert into notification_delivery (id, campaign_id, customer_id, chat_id, status)
        values
          ('pre095-uncertain', 'pre095-campaign', 'pre095-uncertain-customer',
           '10006', 'SEND_UNCERTAIN')
      `.execute(started.handle.db);
      await expect(
        sql`update notification_delivery set status = 'INVALID'
            where id = 'pre095-pending'`.execute(started.handle.db),
      ).rejects.toThrow();
      const unchanged = await sql<{ status: string }>`
        select status from notification_delivery where id = 'pre095-pending'
      `.execute(started.handle.db);
      expect(unchanged.rows).toEqual([{ status: "PENDING" }]);

      const replay = await runMigrations(started.handle.db);
      expect(replay.applied).not.toContain("096_notification_send_uncertain.sql");
      expect(replay.alreadyApplied).toContain("096_notification_send_uncertain.sql");
      const receipt = await sql<{ count: string }>`
        select count(*)::text as count from schema_migrations
        where filename = '096_notification_send_uncertain.sql'
      `.execute(started.handle.db);
      expect(receipt.rows[0]?.count).toBe("1");
    } finally {
      await rm(pre096Dir, { recursive: true, force: true });
      await started.stop();
    }
  }, 180_000);
});

async function createBaselineMigrationDir(): Promise<string> {
  const dir = await mkdtemp(resolve(tmpdir(), "telegram-shop-migrations-"));
  const source = resolve(repoRoot, "src", "infrastructure", "db", "migrations");
  const files = await readdir(source);
  for (let number = 1; number <= 8; number += 1) {
    const prefix = String(number).padStart(3, "0") + "_";
    const resolved = files.find((candidate) => candidate.startsWith(prefix));
    if (!resolved) throw new Error(`missing baseline migration ${prefix}`);
    await cp(resolve(source, resolved), resolve(dir, resolved));
  }
  return dir;
}

async function resetTo008(
  started: Awaited<ReturnType<typeof startPostgres>>,
  baselineDir: string,
): Promise<void> {
  await sql`drop schema public cascade`.execute(started.handle.db);
  await sql`create schema public`.execute(started.handle.db);
  await runMigrations(started.handle.db, baselineDir);
}

async function installExpanded008Shape(started: Awaited<ReturnType<typeof startPostgres>>) {
  await sql
    .raw(
      `
    create table delivery_session (
      id text primary key, bundle_id text not null references delivery_bundle (id),
      customer_id text not null references customer (id), telegram_user_id text not null,
      audience text not null, nonce_hash text not null unique, key_version integer not null,
      expires_at timestamptz not null, used_at timestamptz, revoked_at timestamptz,
      created_at timestamptz not null default now()
    );
    create index delivery_session_live_idx
      on delivery_session (bundle_id, customer_id, expires_at)
      where used_at is null and revoked_at is null;
    create table delivery_notification_handoff (
      id text primary key, bundle_id text not null references delivery_bundle (id),
      customer_id text not null references customer (id), telegram_chat_id text not null,
      capability_ref text not null unique, payload_redacted jsonb not null default '{}'::jsonb,
      status text not null check (status in ('RETRY','PROCESSING','SENT','DEAD')),
      attempt_count integer not null default 0, next_attempt_at timestamptz not null default now(),
      claimed_by text, claim_generation bigint not null default 0,
      claim_expires_at timestamptz, sent_at timestamptz, last_error_code text,
      created_at timestamptz not null default now(), unique (bundle_id, telegram_chat_id)
    );
    create index delivery_notification_due_idx
      on delivery_notification_handoff (next_attempt_at, id)
      where status = 'RETRY';
    alter table channel_identity
      add constraint channel_identity_channel_ck check (channel = 'TELEGRAM');
  `,
    )
    .execute(started.handle.db);
}

async function seedHistoricalDeliveryRows(started: Awaited<ReturnType<typeof startPostgres>>) {
  await sql`
    insert into category (id, name_vi, slug, is_active, sort_order)
    values ('expanded-category', 'Category', 'expanded-category', true, 1)
  `.execute(started.handle.db);
  await sql`
    insert into product (id, category_id, name_vi, slug, is_active, sort_order)
    values ('expanded-product', 'expanded-category', 'Product', 'expanded-product', true, 1)
  `.execute(started.handle.db);
  await sql`
    insert into product_variant
      (id, product_id, sku, name_vi, price_vnd, duration_code, delivery_type,
       stock_policy, resale_evidence_id)
    values ('expanded-variant', 'expanded-product', 'EXPANDED-SKU', 'Variant', 100000,
      'P1M', 'CREDENTIAL', 'LOCAL_ONLY', 'RES-EXPANDED')
  `.execute(started.handle.db);
  await sql`
    insert into "order"
      (id, order_number, customer_id, variant_id, product_name_vi, variant_name_vi,
       price_vnd, duration_code, delivery_type, status, paid_at)
    values ('expanded-order', 'ORD-EXPANDED', 'expanded-customer', 'expanded-variant',
      'Product', 'Variant', 100000, 'P1M', 'CREDENTIAL', 'PAID', now())
  `.execute(started.handle.db);
  await sql`
    insert into digital_asset
      (id, variant_id, source_type, vault_ref, fingerprint_hash, status, reserved_order_id)
    values ('expanded-asset', 'expanded-variant', 'LOCAL', 'vault:expanded-asset',
      'expanded-fingerprint', 'READY', 'expanded-order')
  `.execute(started.handle.db);
  await sql`
    insert into delivery_bundle
      (id, order_id, customer_id, asset_id, token_hash, status, expires_at)
    values ('expanded-bundle', 'expanded-order', 'expanded-customer', 'expanded-asset',
      repeat('a', 64), 'AVAILABLE', now() + interval '1 day')
  `.execute(started.handle.db);
  await sql`
    insert into delivery_session
      (id, bundle_id, customer_id, telegram_user_id, audience, nonce_hash, key_version, expires_at)
    values ('expanded-session', 'expanded-bundle', 'expanded-customer', '88776655',
      'delivery-reveal', repeat('b', 64), 1, now() + interval '1 hour')
  `.execute(started.handle.db);
  await sql`
    insert into delivery_notification_handoff
      (id, bundle_id, customer_id, telegram_chat_id, capability_ref, payload_redacted, status)
    values ('expanded-handoff', 'expanded-bundle', 'expanded-customer', '88776655',
      'vault:expanded-capability', '{}'::jsonb, 'RETRY')
  `.execute(started.handle.db);
}

async function runCompiledMigration(
  databaseUrl: string,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, ["dist/infrastructure/db/migrate.js"], {
      cwd: repoRoot,
      env: { ...process.env, DATABASE_URL: databaseUrl, NODE_ENV: "production" },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (data) => {
      stdout += String(data);
    });
    child.stderr.on("data", (data) => {
      stderr += String(data);
    });
    child.on("close", (code) => resolvePromise({ code, stdout, stderr }));
  });
}
async function createPreMigrationDir(cutoff: string): Promise<string> {
  const dir = await mkdtemp(resolve(tmpdir(), "telegram-shop-pre-migrations-"));
  const source = resolve(repoRoot, "src", "infrastructure", "db", "migrations");
  for (const file of await listMigrationFiles(source)) {
    if (file.localeCompare(cutoff) >= 0) break;
    await cp(resolve(source, file), resolve(dir, file));
  }
  return dir;
}

async function createSingle094MigrationDir(): Promise<string> {
  const dir = await mkdtemp(resolve(tmpdir(), "telegram-shop-094-migration-"));
  const source = resolve(repoRoot, "src", "infrastructure", "db", "migrations");
  const filename = "094_supplier_owner_canary.sql";
  await cp(resolve(source, filename), resolve(dir, filename));
  return dir;
}

async function seedPreCanarySupplierRecoveryRows(
  started: Awaited<ReturnType<typeof startPostgres>>,
): Promise<void> {
  await sql`
    insert into category (id, name_vi, slug, is_active, sort_order)
    values ('pre-canary-category', 'Category', 'pre-canary-category', true, 1)
  `.execute(started.handle.db);
  await sql`
    insert into product (id, category_id, name_vi, slug, is_active, sort_order)
    values ('pre-canary-product', 'pre-canary-category', 'Product', 'pre-canary-product', true, 1)
  `.execute(started.handle.db);
  await sql`
    insert into product_variant
      (id, product_id, sku, name_vi, price_vnd, duration_code, delivery_type,
       stock_policy, resale_evidence_id)
    values ('pre-canary-variant', 'pre-canary-product', 'PRE-CANARY-SKU', 'Variant', 199000,
      'P1M', 'CREDENTIAL', 'SUPPLIER_ONLY', 'RES-PRE-CANARY')
  `.execute(started.handle.db);
  await sql`
    insert into "order"
      (id, order_number, customer_id, variant_id, product_name_vi, variant_name_vi,
       price_vnd, duration_code, delivery_type, status, paid_at)
    values ('pre-canary-order', 'ORD-PRE-CANARY', 'pre-canary-customer', 'pre-canary-variant',
      'Product', 'Variant', 199000, 'P1M', 'CREDENTIAL', 'PAID', now())
  `.execute(started.handle.db);
  await sql`
    insert into supplier (id, name, adapter_type, credential_vault_ref, status)
    values ('pre-canary-supplier', 'Supplier', 'sandbox', 'vault:pre-canary', 'ACTIVE')
  `.execute(started.handle.db);
  await sql`
    insert into supplier_sku
      (id, supplier_id, variant_id, external_sku, cost_vnd, region, delivery_type, is_active)
    values ('pre-canary-sku', 'pre-canary-supplier', 'pre-canary-variant', 'PRE-CANARY-SKU',
      120000, 'VN', 'CREDENTIAL', true)
  `.execute(started.handle.db);
  await sql`
    insert into supplier_order
      (id, supplier_id, supplier_sku_id, order_id, idempotency_key, request_fingerprint,
       external_order_id, status, cost_vnd_snapshot, sale_price_vnd_snapshot,
       margin_vnd_snapshot, submitted_at)
    values
      ('pre-canary-unknown', 'pre-canary-supplier', 'pre-canary-sku', 'pre-canary-order',
       'legacy-idempotency', 'legacy-fingerprint', 'legacy-query-key', 'UNKNOWN',
       120000, 199000, 79000, now()),
      ('pre-canary-pending', 'pre-canary-supplier', 'pre-canary-sku', 'pre-canary-order',
       'provider-idempotency', 'provider-fingerprint', 'provider-order-123', 'PENDING',
       120000, 199000, 79000, now())
  `.execute(started.handle.db);
}

async function seedCrossSupplierUnknownRow(
  started: Awaited<ReturnType<typeof startPostgres>>,
): Promise<void> {
  await sql`
    insert into supplier (id, name, adapter_type, credential_vault_ref, status)
    values ('pre-canary-supplier-other', 'Other Supplier', 'sandbox',
      'vault:pre-canary-other', 'ACTIVE')
  `.execute(started.handle.db);
  await sql`
    insert into supplier_sku
      (id, supplier_id, variant_id, external_sku, cost_vnd, region, delivery_type, is_active)
    values ('pre-canary-sku-other', 'pre-canary-supplier-other', 'pre-canary-variant',
      'PRE-CANARY-SKU', 120000, 'VN', 'CREDENTIAL', true)
  `.execute(started.handle.db);
  await sql`
    insert into supplier_order
      (id, supplier_id, supplier_sku_id, order_id, idempotency_key, request_fingerprint,
       external_order_id, status, cost_vnd_snapshot, sale_price_vnd_snapshot,
       margin_vnd_snapshot, submitted_at)
    values ('pre-canary-unknown-other', 'pre-canary-supplier-other', 'pre-canary-sku-other',
      'pre-canary-order', 'legacy-idempotency-other', 'legacy-fingerprint-other',
      'legacy-query-key', 'UNKNOWN', 120000, 199000, 79000, now())
  `.execute(started.handle.db);
}
