import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { cp, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import type { DbHandle } from "../../src/infrastructure/db/client.js";
import { sql } from "kysely";
import { runMigrations } from "../../src/infrastructure/db/migrate.js";
import { dockerAvailable, startPostgres, type StartedPg } from "../helpers/pg-container.js";

const repoRoot = resolve(import.meta.dirname, "..", "..");
const hasDocker = await dockerAvailable();

describe("compiled production migration entrypoint (T173)", () => {
  it("defines migrate:prod as a Node launch of the compiled migration artifact", () => {
    const pkg = JSON.parse(readFileSync(resolve(repoRoot, "package.json"), "utf8")) as {
      scripts?: Record<string, string>;
    };
    expect(pkg.scripts?.["migrate:prod"]).toBe("node dist/infrastructure/db/migrate.js");
    expect(pkg.scripts?.["migrate:prod"]).not.toContain("tsx");
    expect(
      existsSync(resolve(repoRoot, "dist", "infrastructure", "db", "migrate.js")),
      "run npm run build before this acceptance lane",
    ).toBe(true);
  });

  it.skipIf(!hasDocker)(
    "runs compiled migrate:prod from an empty schema through the current head",
    async () => {
      const started = await startPostgres();
      try {
        await sql`drop schema public cascade`.execute(started.handle.db);
        await sql`create schema public`.execute(started.handle.db);

        const result = await runCompiledMigration(started.connectionString);
        expect(result.code, result.stderr).toBe(0);
        expect(`${result.stdout}\n${result.stderr}`).toMatch(/migrate: applied=/);

        const proof = await sql<{
          category: string | null;
          callback_constraint: string | null;
          command_constraint: string | null;
          head: string | null;
          migration_files: string[] | null;
          preorder_index: string | null;
          store_status: string | null;
        }>`
        select
          to_regclass('public.category')::text as category,
          (select pg_get_constraintdef(oid)
           from pg_constraint
           where conrelid = 'admin_callback_state'::regclass
             and conname = 'admin_callback_state_kind_check') as callback_constraint,
          (select pg_get_constraintdef(oid)
           from pg_constraint
           where conrelid = 'admin_confirmation'::regclass
             and conname = 'admin_confirmation_command_ref_ck') as command_constraint,
          (select max(filename) from schema_migrations) as head,
          coalesce(
            array_agg(filename order by filename)
              filter (where filename in (
                '100_preorder_reservation_order_id_idx.sql',
                '101_closed_seed_store.sql',
                '103_admin_inventory_import_callback_state.sql',
                '104_inventory_import_generation_fencing.sql',
                '105_supplier_order_schema_repair.sql',
                '106_admin_order_search_prompt_state.sql',
                '107_file_delivery_recover_confirmation.sql'
              )),
            '{}'::text[]
          ) as migration_files,
          to_regclass('public.preorder_reservation_order_id_idx')::text as preorder_index,
          (select status from store_control where id = 'main') as store_status
        from schema_migrations
      `.execute(started.handle.db);
        expect(proof.rows[0]).toMatchObject({
          category: "category",
          head: "107_file_delivery_recover_confirmation.sql",
          migration_files: [
            "100_preorder_reservation_order_id_idx.sql",
            "101_closed_seed_store.sql",
            "103_admin_inventory_import_callback_state.sql",
            "104_inventory_import_generation_fencing.sql",
            "105_supplier_order_schema_repair.sql",
            "106_admin_order_search_prompt_state.sql",
            "107_file_delivery_recover_confirmation.sql",
          ],
          preorder_index: "preorder_reservation_order_id_idx",
          store_status: "CLOSED",
        });
        expect(proof.rows[0]?.callback_constraint).toContain("ORDER_SEARCH_PROMPT");
        expect(proof.rows[0]?.command_constraint).toContain("file_delivery.recover");
      } finally {
        await started.stop();
      }
    },
    180_000,
  );
  /**
   * No historical dump is checked in. This bounded prior state runs the exact
   * migrations through 092, then applies the production-only root 102 SQL,
   * preserving the runner's real history contract without inventing a dump.
   */
  it.skipIf(!hasDocker)(
    "upgrades root 102 plus pending runner migrations with compiled migrate:prod",
    async () => {
      const started = await startPostgres();
      const before093Dir = await createMigrationDirThrough(92);
      try {
        await sql`drop schema public cascade`.execute(started.handle.db);
        await sql`create schema public`.execute(started.handle.db);
        const baseline = await runMigrations(started.handle.db, before093Dir);
        expect(baseline.applied).not.toContain("093_supplier_catalog_platform.sql");

        const root102 = await readFile(
          resolve(repoRoot, "102_admin_order_search_prompt.sql"),
          "utf8",
        );
        await sql.raw(root102).execute(started.handle.db);
        await sql`insert into customer (id) values ('compiled-recovery-customer')`.execute(
          started.handle.db,
        );
        await sql`
        insert into channel_identity (id, customer_id, channel, channel_user_id)
        values ('compiled-recovery-identity', 'compiled-recovery-customer', 'TELEGRAM', '9988776656')
      `.execute(started.handle.db);
        await sql`
        insert into admin_callback_state
          (id, admin_telegram_user_id, kind, payload_redacted, expires_at)
        values
          ('compiled-pre-093-order-search-state', '99887766', 'ORDER_SEARCH_PROMPT',
           '{"query":"ORD-COMPILED-PRE-093"}'::jsonb, timestamptz '2030-01-01T00:00:00Z')
      `.execute(started.handle.db);
        await seedCompiledMigrationLegacyRows(started);

        const result = await runCompiledMigration(started.connectionString);
        expect(result.code, result.stderr).toBe(0);
        expect(result.stdout).toContain("migrate: new files:");
        for (const filename of [
          "103_admin_inventory_import_callback_state.sql",
          "104_inventory_import_generation_fencing.sql",
          "105_supplier_order_schema_repair.sql",
          "106_admin_order_search_prompt_state.sql",
          "107_file_delivery_recover_confirmation.sql",
        ]) {
          expect(result.stdout).toContain(filename);
        }
        const selected = await sql<{ filename: string }>`
        select filename
        from schema_migrations
        where filename in (
          '093_supplier_catalog_platform.sql',
          '103_admin_inventory_import_callback_state.sql',
          '104_inventory_import_generation_fencing.sql',
          '105_supplier_order_schema_repair.sql',
          '106_admin_order_search_prompt_state.sql',
          '107_file_delivery_recover_confirmation.sql'
        )
        order by filename
      `.execute(started.handle.db);
        expect(selected.rows.map((row) => row.filename)).toEqual([
          "093_supplier_catalog_platform.sql",
          "103_admin_inventory_import_callback_state.sql",
          "104_inventory_import_generation_fencing.sql",
          "105_supplier_order_schema_repair.sql",
          "106_admin_order_search_prompt_state.sql",
          "107_file_delivery_recover_confirmation.sql",
        ]);
        const root102Receipt = await sql<{ count: string }>`
        select count(*)::text as count
        from schema_migrations
        where filename = '102_admin_order_search_prompt.sql'
      `.execute(started.handle.db);
        expect(root102Receipt.rows[0]?.count).toBe("0");
        const importSession = await sql<{ generation: string; input_vault_ref: string | null }>`
        select generation, input_vault_ref
        from admin_inventory_import
        where admin_telegram_user_id = 'compiled-legacy-import-admin'
      `.execute(started.handle.db);
        expect(importSession.rows).toHaveLength(1);
        expect(importSession.rows[0]?.input_vault_ref).toBe("vault:compiled-legacy-same-ref");
        expect(importSession.rows[0]?.generation.trim()).not.toBe("");

        const challengeRows = await sql<{
          generation: string;
          input_vault_ref: string | null;
          status: string;
        }>`
        select generation, input_vault_ref, status
        from google_sheets_inventory_intake_challenge
        where admin_telegram_user_id = 'compiled-legacy-import-admin'
        order by id
      `.execute(started.handle.db);
        expect(challengeRows.rows).toHaveLength(2);
        expect(challengeRows.rows.map((row) => row.status)).toEqual(["PREVIEWED", "PROCESSING"]);
        expect(challengeRows.rows.map((row) => row.input_vault_ref)).toEqual([
          "vault:compiled-legacy-same-ref",
          "vault:compiled-legacy-same-ref",
        ]);
        expect(challengeRows.rows.every((row) => row.generation.trim() !== "")).toBe(true);
        expect(new Set(challengeRows.rows.map((row) => row.generation)).size).toBe(2);
        expect(challengeRows.rows.map((row) => row.generation)).not.toContain(
          importSession.rows[0]?.generation,
        );

        const supplierOrders = await sql<{
          id: string;
          status: string;
          idempotency_key: string;
          request_fingerprint: string;
          external_order_id: string | null;
          query_key: string | null;
          request_fingerprint_version: number;
          attempt_count: number;
        }>`
        select id, status, idempotency_key, request_fingerprint, external_order_id,
          query_key, request_fingerprint_version, attempt_count
        from supplier_order
        where id in ('compiled-legacy-supplier-order', 'compiled-preserved-supplier-order')
        order by id
      `.execute(started.handle.db);
        expect(supplierOrders.rows).toEqual([
          {
            id: "compiled-legacy-supplier-order",
            status: "UNKNOWN",
            idempotency_key: "compiled-legacy-idempotency-key",
            request_fingerprint: "compiled-legacy-fingerprint",
            external_order_id: "compiled-legacy-provider-query-key",
            query_key: "compiled-legacy-provider-query-key",
            request_fingerprint_version: 1,
            attempt_count: 0,
          },
          {
            id: "compiled-preserved-supplier-order",
            status: "SUBMITTED",
            idempotency_key: "compiled-preserved-idempotency-key",
            request_fingerprint: "compiled-preserved-fingerprint",
            external_order_id: "compiled-preserved-provider-order",
            query_key: null,
            request_fingerprint_version: 1,
            attempt_count: 0,
          },
        ]);

        await sql`
        insert into admin_confirmation
          (id, root_channel_identity_id, action_fingerprint, challenge_hash,
           status, expires_at, correlation_id, allowlisted_command_ref, payload_redacted)
        values
          ('compiled-recovery-confirmation', 'compiled-recovery-identity',
           'compiled-file-delivery-recovery', 'compiled-recovery-challenge',
           'CREATED', timestamptz '2030-01-01T00:00:00Z',
           'compiled-recovery-correlation', 'file_delivery.recover',
           '{"targetId":"compiled-order"}'::jsonb)
      `.execute(started.handle.db);

        const proof = await sql<{
          callback_constraint: string | null;
          command_constraint: string | null;
          kind: string;
          owner: string;
          payload: unknown;
          receipt_count: string;
          recovery_confirmation_count: string;
          head: string | null;
          migration_104_inventory_generation: boolean;
          migration_104_intake_generation: boolean;
          migration_104_inventory_generation_check: boolean;
          migration_104_intake_generation_check: boolean;
          migration_105_supplier_query_key: boolean;
          migration_105_supplier_review_fence: boolean;
          migration_105_supplier_fingerprint_required: boolean;
          migration_105_supplier_attempt_required: boolean;
          migration_105_query_index: string | null;
          migration_105_provider_client_index: string | null;
        }>`
        select
          (select pg_get_constraintdef(oid)
           from pg_constraint
           where conrelid = 'admin_callback_state'::regclass
             and conname = 'admin_callback_state_kind_check') as callback_constraint,
          (select pg_get_constraintdef(oid)
           from pg_constraint
           where conrelid = 'admin_confirmation'::regclass
             and conname = 'admin_confirmation_command_ref_ck') as command_constraint,
          (select admin_telegram_user_id from admin_callback_state
           where id = 'compiled-pre-093-order-search-state') as owner,
          (select kind from admin_callback_state
           where id = 'compiled-pre-093-order-search-state') as kind,
          (select payload_redacted from admin_callback_state
           where id = 'compiled-pre-093-order-search-state') as payload,
          (select count(*)::text from schema_migrations) as receipt_count,
          (select max(filename) from schema_migrations) as head,
          (select count(*)::text from admin_confirmation
           where allowlisted_command_ref = 'file_delivery.recover')
            as recovery_confirmation_count,
          (select exists (
             select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'admin_inventory_import'
               and column_name = 'generation' and is_nullable = 'NO'
           )) as migration_104_inventory_generation,
          (select exists (
             select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'google_sheets_inventory_intake_challenge'
               and column_name = 'generation' and is_nullable = 'NO'
           )) as migration_104_intake_generation,
          (select exists (
             select 1 from pg_constraint
             where conrelid = 'admin_inventory_import'::regclass
               and conname = 'admin_inventory_import_generation_check'
           )) as migration_104_inventory_generation_check,
          (select exists (
             select 1 from pg_constraint
             where conrelid = 'google_sheets_inventory_intake_challenge'::regclass
               and conname = 'google_sheets_inventory_intake_challenge_generation_check'
           )) as migration_104_intake_generation_check,
          (select exists (
             select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'supplier_order'
               and column_name = 'query_key'
           )) as migration_105_supplier_query_key,
          (select exists (
             select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'supplier_order'
               and column_name = 'needs_review_at'
           )) as migration_105_supplier_review_fence,
          (select exists (
             select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'supplier_order'
               and column_name = 'request_fingerprint_version' and is_nullable = 'NO'
           )) as migration_105_supplier_fingerprint_required,
          (select exists (
             select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'supplier_order'
               and column_name = 'attempt_count' and is_nullable = 'NO'
           )) as migration_105_supplier_attempt_required,
          to_regclass('public.supplier_order_query_key_uq')::text as migration_105_query_index,
          to_regclass('public.supplier_order_provider_client_uq')::text
            as migration_105_provider_client_index
      `.execute(started.handle.db);
        expect(proof.rows[0]).toMatchObject({
          kind: "ORDER_SEARCH_PROMPT",
          owner: "99887766",
          payload: { query: "ORD-COMPILED-PRE-093" },
          head: "107_file_delivery_recover_confirmation.sql",
          migration_104_inventory_generation: true,
          migration_104_intake_generation: true,
          migration_104_inventory_generation_check: true,
          migration_104_intake_generation_check: true,
          migration_105_supplier_query_key: true,
          migration_105_supplier_review_fence: true,
          migration_105_supplier_fingerprint_required: true,
          migration_105_supplier_attempt_required: true,
          migration_105_query_index: "supplier_order_query_key_uq",
          migration_105_provider_client_index: "supplier_order_provider_client_uq",
          recovery_confirmation_count: "1",
        });
        expect(proof.rows[0]?.callback_constraint).toContain("ORDER_SEARCH_PROMPT");
        expect(proof.rows[0]?.callback_constraint).toContain("ADMIN_INVENTORY_IMPORT_CONFIRM");
        expect(proof.rows[0]?.command_constraint).toContain("file_delivery.recover");
        const stateBeforeRerun = await readCompiledMigrationState(started.handle.db);
        const receiptCount = proof.rows[0]?.receipt_count;

        const rerun = await runCompiledMigration(started.connectionString);
        expect(rerun.code, rerun.stderr).toBe(0);
        expect(rerun.stdout).toContain("migrate: applied=0");
        const afterRerun = await sql<{
          receipt_count: string;
          head: string | null;
          recovery_confirmation_count: string;
        }>`
        select
          count(*)::text as receipt_count,
          max(filename) as head,
          (select count(*)::text from admin_confirmation
           where allowlisted_command_ref = 'file_delivery.recover')
            as recovery_confirmation_count
        from schema_migrations
      `.execute(started.handle.db);
        expect(afterRerun.rows[0]).toEqual({
          receipt_count: receiptCount,
          head: "107_file_delivery_recover_confirmation.sql",
          recovery_confirmation_count: "1",
        });
        const stateAfterRerun = await readCompiledMigrationState(started.handle.db);
        expect(stateAfterRerun).toEqual(stateBeforeRerun);
      } finally {
        await rm(before093Dir, { recursive: true, force: true });
        await started.stop();
      }
    },
    180_000,
  );
  it.skipIf(!hasDocker)(
    "repairs legacy supplier-order DML through compiled migrate:prod",
    async () => {
      const started = await startPostgres();
      const before105Dir = await createMigrationDirThrough(104);
      try {
        await sql`drop schema public cascade`.execute(started.handle.db);
        await sql`create schema public`.execute(started.handle.db);
        const baseline = await runMigrations(started.handle.db, before105Dir);
        expect(baseline.applied).toContain("104_inventory_import_generation_fencing.sql");
        await sql`
        alter table supplier_order
          drop constraint if exists supplier_order_attempt_count_chk
      `.execute(started.handle.db);
        await sql`
        alter table supplier_order
          alter column attempt_count drop not null
      `.execute(started.handle.db);
        await seedCompiledMigrationLegacyRows(started);
        await sql`
        update supplier_order
        set attempt_count = null
        where id in ('compiled-legacy-supplier-order', 'compiled-preserved-supplier-order')
      `.execute(started.handle.db);

        const result = await runCompiledMigration(started.connectionString);
        expect(result.code, result.stderr).toBe(0);
        for (const filename of [
          "105_supplier_order_schema_repair.sql",
          "106_admin_order_search_prompt_state.sql",
          "107_file_delivery_recover_confirmation.sql",
        ]) {
          expect(result.stdout).toContain(filename);
        }
        const receipts = await sql<{ filename: string }>`
        select filename
        from schema_migrations
        where filename in (
          '104_inventory_import_generation_fencing.sql',
          '105_supplier_order_schema_repair.sql',
          '106_admin_order_search_prompt_state.sql',
          '107_file_delivery_recover_confirmation.sql'
        )
        order by filename
      `.execute(started.handle.db);
        expect(receipts.rows.map((row) => row.filename)).toEqual([
          "104_inventory_import_generation_fencing.sql",
          "105_supplier_order_schema_repair.sql",
          "106_admin_order_search_prompt_state.sql",
          "107_file_delivery_recover_confirmation.sql",
        ]);
        const head = await sql<{ head: string | null }>`
        select max(filename) as head from schema_migrations
      `.execute(started.handle.db);
        expect(head.rows[0]?.head).toBe("107_file_delivery_recover_confirmation.sql");

        const repaired = await sql<{
          id: string;
          status: string;
          external_order_id: string | null;
          query_key: string | null;
          request_fingerprint_version: number;
          attempt_count: number;
        }>`
        select id, status, external_order_id, query_key,
          request_fingerprint_version, attempt_count
        from supplier_order
        where id in ('compiled-legacy-supplier-order', 'compiled-preserved-supplier-order')
        order by id
      `.execute(started.handle.db);
        expect(repaired.rows).toEqual([
          {
            id: "compiled-legacy-supplier-order",
            status: "UNKNOWN",
            external_order_id: "compiled-legacy-provider-query-key",
            query_key: "compiled-legacy-provider-query-key",
            request_fingerprint_version: 1,
            attempt_count: 0,
          },
          {
            id: "compiled-preserved-supplier-order",
            status: "SUBMITTED",
            external_order_id: "compiled-preserved-provider-order",
            query_key: null,
            request_fingerprint_version: 1,
            attempt_count: 0,
          },
        ]);

        const rerun = await runCompiledMigration(started.connectionString);
        expect(rerun.code, rerun.stderr).toBe(0);
        expect(rerun.stdout).toContain("migrate: applied=0");
        const afterRerun = await sql<{
          receipt_count: string;
          head: string | null;
          legacy_query_key: string | null;
          legacy_attempt_count: number;
        }>`
        select
          (select count(*)::text from schema_migrations) as receipt_count,
          (select max(filename) from schema_migrations) as head,
          (select query_key from supplier_order
           where id = 'compiled-legacy-supplier-order') as legacy_query_key,
          (select attempt_count from supplier_order
           where id = 'compiled-legacy-supplier-order') as legacy_attempt_count
      `.execute(started.handle.db);
        expect(afterRerun.rows[0]).toMatchObject({
          head: "107_file_delivery_recover_confirmation.sql",
          legacy_query_key: "compiled-legacy-provider-query-key",
          legacy_attempt_count: 0,
        });
        expect(afterRerun.rows[0]?.receipt_count).toBe(String(baseline.applied.length + 3));
      } finally {
        await rm(before105Dir, { recursive: true, force: true });
        await started.stop();
      }
    },
    180_000,
  );

  it.skipIf(!hasDocker)(
    "upgrades a SePay-only 008 database with compiled migrate:prod and preserves rows",
    async () => {
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
        }>`
        select ci.channel, ci.observed_username,
          to_regclass('public.delivery_session')::text as delivery_session,
          to_regclass('public.delivery_notification_handoff')::text as handoff,
          to_regclass('public.delivery_capability_compensation')::text as compensation
        from channel_identity ci where ci.id = 'legacy-identity'
      `.execute(started.handle.db);
        expect(proof.rows[0]).toMatchObject({
          channel: "TELEGRAM",
          observed_username: "observed_user",
          delivery_session: "delivery_session",
          handoff: "delivery_notification_handoff",
          compensation: "delivery_capability_compensation",
        });
      } finally {
        await rm(baselineDir, { recursive: true, force: true });
        await started.stop();
      }
    },
    180_000,
  );

  it.skipIf(!hasDocker)(
    "upgrades the prior expanded-008 shape without recreating or losing delivery rows",
    async () => {
      const started = await startPostgres();
      const baselineDir = await createBaselineMigrationDir();
      try {
        await resetTo008(started, baselineDir);
        await installExpanded008Shape(started);
        await sql`insert into customer (id) values ('expanded-customer')`.execute(
          started.handle.db,
        );
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
    },
    180_000,
  );

  it.skipIf(!hasDocker)(
    "fails closed and preserves both rows on a telegram/TELEGRAM collision",
    async () => {
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
    },
    180_000,
  );
  it.skipIf(!hasDocker)(
    "isolates ambiguous legacy Sheets challenges while upgrading generation fencing",
    async () => {
      const started = await startPostgres();
      const before104Dir = await createMigrationDirThrough(103);
      const migrationsDir = resolve(repoRoot, "src", "infrastructure", "db", "migrations");
      const legacyRef = "vault:legacy-same-ref";
      try {
        await sql`drop schema public cascade`.execute(started.handle.db);
        await sql`create schema public`.execute(started.handle.db);
        await runMigrations(started.handle.db, before104Dir);
        await sql`
        insert into category (id, name_vi, slug, is_active, sort_order)
        values ('generation-category', 'Generation', 'generation-category', true, 1)
      `.execute(started.handle.db);
        await sql`
        insert into product (id, category_id, name_vi, slug, is_active, sort_order)
        values ('generation-product', 'generation-category', 'Generation product',
          'generation-product', true, 1)
      `.execute(started.handle.db);
        await sql`
        insert into product_variant
          (id, product_id, sku, name_vi, price_vnd, duration_code, delivery_type,
           stock_policy, fulfillment_type, inventory_fields, is_active, sort_order)
        values
          ('generation-variant', 'generation-product', 'GENERATION-SKU', 'Generation account',
           100000, 'P1M', 'CREDENTIAL', 'LOCAL_ONLY', 'STOCK_ACCOUNT',
           '[{"name":"email","label":"Email","required":true,"secret":false,"customerVisible":true},
             {"name":"password","label":"Password","required":true,"secret":true,"customerVisible":false}]'::jsonb,
           true, 1)
      `.execute(started.handle.db);
        await sql`
        insert into admin_inventory_import
          (admin_telegram_user_id, status, input_vault_ref, preview_ready,
           preview_invalid, preview_duplicates, preview_variants, selected_variant_id, expires_at)
        values
          ('987654321', 'READY', ${legacyRef}, 1, 0, 0, '["generation-variant"]'::jsonb,
           'generation-variant', now() + interval '15 minutes')
      `.execute(started.handle.db);
        await sql`
        insert into google_sheets_inventory_intake_challenge
          (id, challenge_hash, spreadsheet_id, owner_email, owner_subject,
           admin_telegram_user_id, variant_id, input_vault_ref, preview_ready,
           preview_invalid, preview_duplicates, status, expires_at)
        values
          ('legacy-generation-challenge-a', 'legacy-generation-hash-a', 'generation-sheet',
           'owner@example.test', 'legacy-owner', '987654321', 'generation-variant',
           ${legacyRef}, 1, 0, 0, 'PREVIEWED', now() + interval '15 minutes'),
          ('legacy-generation-challenge-b', 'legacy-generation-hash-b', 'generation-sheet',
           'owner@example.test', 'legacy-owner', '987654321', 'generation-variant',
           ${legacyRef}, 1, 0, 0, 'PROCESSING', now() + interval '15 minutes')
      `.execute(started.handle.db);

        await runMigrations(started.handle.db, migrationsDir);
        const session = await sql<{ generation: string; input_vault_ref: string }>`
        select generation, input_vault_ref
        from admin_inventory_import
        where admin_telegram_user_id = '987654321'
      `.execute(started.handle.db);
        const challenges = await sql<{ generation: string; status: string }>`
        select generation, status
        from google_sheets_inventory_intake_challenge
        order by id
      `.execute(started.handle.db);
        expect(session.rows[0]?.input_vault_ref).toBe(legacyRef);
        expect(challenges.rows).toHaveLength(2);
        expect(challenges.rows.every((row) => row.generation !== session.rows[0]?.generation)).toBe(
          true,
        );
        expect(new Set(challenges.rows.map((row) => row.generation)).size).toBe(2);
        expect(challenges.rows.map((row) => row.status)).toEqual(["PREVIEWED", "PROCESSING"]);
      } finally {
        await rm(before104Dir, { recursive: true, force: true });
        await started.stop();
      }
    },
    180_000,
  );
});
async function seedCompiledMigrationLegacyRows(started: StartedPg): Promise<void> {
  await sql`
    insert into category (id, name_vi, slug, is_active, sort_order)
    values ('compiled-migration-category', 'Compiled migration', 'compiled-migration-category', true, 1)
  `.execute(started.handle.db);
  await sql`
    insert into product (id, category_id, name_vi, slug, is_active, sort_order)
    values ('compiled-migration-product', 'compiled-migration-category', 'Compiled migration product',
      'compiled-migration-product', true, 1)
  `.execute(started.handle.db);
  await sql`
    insert into product_variant
      (id, product_id, sku, name_vi, price_vnd, duration_code, delivery_type,
       stock_policy, fulfillment_type, inventory_fields, is_active, sort_order)
    values
      ('compiled-migration-variant', 'compiled-migration-product', 'COMPILED-MIGRATION-SKU',
       'Compiled migration account', 100000, 'P1M', 'CREDENTIAL', 'LOCAL_ONLY',
       'STOCK_ACCOUNT', '[]'::jsonb, true, 1)
  `.execute(started.handle.db);
  await sql`
    insert into admin_inventory_import
      (admin_telegram_user_id, status, input_vault_ref, preview_ready,
       preview_invalid, preview_duplicates, preview_variants, selected_variant_id, expires_at)
    values
      ('compiled-legacy-import-admin', 'READY', 'vault:compiled-legacy-same-ref',
       1, 0, 0, '["compiled-migration-variant"]'::jsonb,
       'compiled-migration-variant', now() + interval '15 minutes')
  `.execute(started.handle.db);
  await sql`
    insert into google_sheets_inventory_intake_challenge
      (id, challenge_hash, spreadsheet_id, owner_email, owner_subject,
       admin_telegram_user_id, variant_id, input_vault_ref, preview_ready,
       preview_invalid, preview_duplicates, status, expires_at)
    values
      ('compiled-legacy-challenge-a', 'compiled-legacy-hash-a', 'compiled-legacy-sheet',
       'owner@example.test', 'compiled-legacy-owner', 'compiled-legacy-import-admin',
       'compiled-migration-variant', 'vault:compiled-legacy-same-ref', 1, 0, 0,
       'PREVIEWED', now() + interval '15 minutes'),
      ('compiled-legacy-challenge-b', 'compiled-legacy-hash-b', 'compiled-legacy-sheet',
       'owner@example.test', 'compiled-legacy-owner', 'compiled-legacy-import-admin',
       'compiled-migration-variant', 'vault:compiled-legacy-same-ref', 1, 0, 0,
       'PROCESSING', now() + interval '15 minutes')
  `.execute(started.handle.db);

  await sql`
    insert into customer (id)
    values ('compiled-migration-customer')
  `.execute(started.handle.db);
  await sql`
    insert into "order"
      (id, order_number, customer_id, variant_id, product_name_vi, variant_name_vi,
       price_vnd, duration_code, delivery_type, status, paid_at)
    values
      ('compiled-migration-order', 'ORD-COMPILED-MIGRATION', 'compiled-migration-customer',
       'compiled-migration-variant', 'Compiled migration product', 'Compiled migration account',
       100000, 'P1M', 'CREDENTIAL', 'PAID', now())
  `.execute(started.handle.db);
  await sql`
    insert into supplier
      (id, name, adapter_type, credential_vault_ref, status)
    values
      ('compiled-migration-supplier', 'Compiled migration supplier', 'TEST',
       'vault:compiled-migration-supplier', 'ACTIVE')
  `.execute(started.handle.db);
  await sql`
    insert into supplier_sku
      (id, supplier_id, variant_id, external_sku, cost_vnd, region, delivery_type, is_active)
    values
      ('compiled-migration-sku', 'compiled-migration-supplier', 'compiled-migration-variant',
       'COMPILED-MIGRATION-EXT-SKU', 70000, 'VN', 'CREDENTIAL', true)
  `.execute(started.handle.db);
  await sql`
    update product_variant
    set supplier_sku_id = 'compiled-migration-sku'
    where id = 'compiled-migration-variant'
  `.execute(started.handle.db);
  await sql`
    insert into supplier_order
      (id, supplier_id, supplier_sku_id, order_id, idempotency_key, request_fingerprint,
       external_order_id, status, cost_vnd_snapshot, sale_price_vnd_snapshot,
       margin_vnd_snapshot, submitted_at)
    values
      ('compiled-legacy-supplier-order', 'compiled-migration-supplier', 'compiled-migration-sku',
       'compiled-migration-order', 'compiled-legacy-idempotency-key',
       'compiled-legacy-fingerprint', 'compiled-legacy-provider-query-key',
       'UNKNOWN', 70000, 100000, 30000, now()),
      ('compiled-preserved-supplier-order', 'compiled-migration-supplier', 'compiled-migration-sku',
       'compiled-migration-order', 'compiled-preserved-idempotency-key',
       'compiled-preserved-fingerprint', 'compiled-preserved-provider-order',
       'SUBMITTED', 70000, 100000, 30000, now())
  `.execute(started.handle.db);
}

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
async function createMigrationDirThrough(maxMigration: number): Promise<string> {
  const dir = await mkdtemp(resolve(tmpdir(), "telegram-shop-migrations-"));
  const source = resolve(repoRoot, "src", "infrastructure", "db", "migrations");
  const files = await readdir(source);
  for (const filename of files) {
    const match = /^(\d+)/u.exec(filename);
    if (!match || Number(match[1]) > maxMigration) continue;
    await cp(resolve(source, filename), resolve(dir, filename));
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

type CompiledMigrationState = {
  callback_constraint: string | null;
  command_constraint: string | null;
  owner: string | null;
  kind: string | null;
  payload: unknown;
  inventory_generation_check: string | null;
  intake_generation_check: string | null;
  query_index: string | null;
  provider_client_index: string | null;
};

async function readCompiledMigrationState(db: DbHandle["db"]): Promise<CompiledMigrationState> {
  const result = await sql<CompiledMigrationState>`
    select
      (select pg_get_constraintdef(oid)
       from pg_constraint
       where conrelid = 'admin_callback_state'::regclass
         and conname = 'admin_callback_state_kind_check') as callback_constraint,
      (select pg_get_constraintdef(oid)
       from pg_constraint
       where conrelid = 'admin_confirmation'::regclass
         and conname = 'admin_confirmation_command_ref_ck') as command_constraint,
      (select admin_telegram_user_id from admin_callback_state
       where id = 'compiled-pre-093-order-search-state') as owner,
      (select kind from admin_callback_state
       where id = 'compiled-pre-093-order-search-state') as kind,
      (select payload_redacted from admin_callback_state
       where id = 'compiled-pre-093-order-search-state') as payload,
      (select pg_get_constraintdef(oid)
       from pg_constraint
       where conrelid = 'admin_inventory_import'::regclass
         and conname = 'admin_inventory_import_generation_check')
        as inventory_generation_check,
      (select pg_get_constraintdef(oid)
       from pg_constraint
       where conrelid = 'google_sheets_inventory_intake_challenge'::regclass
         and conname = 'google_sheets_inventory_intake_challenge_generation_check')
        as intake_generation_check,
      to_regclass('public.supplier_order_query_key_uq')::text as query_index,
      to_regclass('public.supplier_order_provider_client_uq')::text as provider_client_index
  `.execute(db);
  const state = result.rows[0];
  if (!state) throw new Error("compiled migration state query returned no rows");
  return state;
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
