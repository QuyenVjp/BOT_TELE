import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cp, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { sql } from "kysely";
import type { StartedPg } from "../helpers/pg-container.js";
import { runMigrations } from "../../src/infrastructure/db/migrate.js";
import { dockerAvailable, startPostgres } from "../helpers/pg-container.js";

const repoRoot = resolve(import.meta.dirname, "..", "..");
const hasDocker = await dockerAvailable();
const migrationsDir = resolve(repoRoot, "src", "infrastructure", "db", "migrations");

const PLATFORM_MIGRATION = "093_supplier_catalog_platform.sql";
const SUPPLIER_REPAIR = "105_supplier_order_schema_repair.sql";
const ORDER_SEARCH_REPAIR = "106_admin_order_search_prompt_state.sql";
const DELIVERY_RECOVERY_REPAIR = "107_file_delivery_recover_confirmation.sql";
let started: StartedPg | undefined;

beforeAll(async () => {
  if (hasDocker) started = await startPostgres();
}, 180_000);

afterAll(async () => {
  await started?.stop();
});

describe.skipIf(!hasDocker)("post-104 migration repairs", () => {
  it("discovers both additive repairs on a fresh runner", async () => {
    await resetSchema();

    const result = await runMigrations(db(), migrationsDir);

    expect(result.applied).toContain(ORDER_SEARCH_REPAIR);
    expect(result.applied).toContain(DELIVERY_RECOVERY_REPAIR);
    expect(result.applied).not.toContain("102_admin_order_search_prompt.sql");

    const callbackConstraint = await sql<{ definition: string }>`
      select pg_get_constraintdef(oid) as definition
      from pg_constraint
      where conrelid = 'admin_callback_state'::regclass
        and conname = 'admin_callback_state_kind_check'
    `.execute(db());
    expect(callbackConstraint.rows[0]?.definition).toContain("ORDER_SEARCH_PROMPT");
  }, 180_000);
  it("preserves owner state when root 102 precedes pending 093", async () => {
    await resetSchema();
    const before093 = await createMigrationDirThrough(92);

    try {
      const baseline = await runMigrations(db(), before093);
      expect(baseline.applied).not.toContain(PLATFORM_MIGRATION);
      const root102 = await readFile(
        resolve(repoRoot, "102_admin_order_search_prompt.sql"),
        "utf8",
      );
      await sql.raw(root102).execute(db());
      await sql`
        insert into admin_callback_state
          (id, admin_telegram_user_id, kind, payload_redacted, expires_at)
        values
          ('pre-093-order-search-state', '99887766', 'ORDER_SEARCH_PROMPT',
           '{"query":"ORD-PRE-093"}'::jsonb, timestamptz '2030-01-01T00:00:00Z')
      `.execute(db());

      const upgrade = await runMigrations(db(), migrationsDir);
      expect(upgrade.applied).toContain(PLATFORM_MIGRATION);
      expect(upgrade.applied).toContain("103_admin_inventory_import_callback_state.sql");
      expect(upgrade.applied).toContain(ORDER_SEARCH_REPAIR);
      expect(upgrade.applied).toContain(DELIVERY_RECOVERY_REPAIR);

      const ownerState = await sql<{ kind: string; payload: unknown }>`
        select kind, payload_redacted as payload
        from admin_callback_state
        where id = 'pre-093-order-search-state'
      `.execute(db());
      expect(ownerState.rows[0]).toEqual({
        kind: "ORDER_SEARCH_PROMPT",
        payload: { query: "ORD-PRE-093" },
      });
    } finally {
      await rm(before093, { recursive: true, force: true });
    }
  }, 180_000);
  it("preserves an existing ORDER_SEARCH_PROMPT row when migration 103 first runs", async () => {
    await resetSchema();
    const before103 = await createMigrationDirThrough(101);

    try {
      await runMigrations(db(), before103);
      const root102 = await readFile(
        resolve(repoRoot, "102_admin_order_search_prompt.sql"),
        "utf8",
      );
      await sql.raw(root102).execute(db());
      await sql`
        insert into admin_callback_state
          (id, admin_telegram_user_id, kind, payload_redacted, expires_at)
        values
          ('pre-103-order-search-state', '99887766', 'ORDER_SEARCH_PROMPT',
           '{"query":"ORD-PRE-103"}'::jsonb, timestamptz '2030-01-01T00:00:00Z')
      `.execute(db());

      const upgrade = await runMigrations(db(), migrationsDir);
      expect(upgrade.applied).toContain("103_admin_inventory_import_callback_state.sql");
      const ownerState = await sql<{ kind: string; payload: unknown }>`
        select kind, payload_redacted as payload
        from admin_callback_state
        where id = 'pre-103-order-search-state'
      `.execute(db());
      expect(ownerState.rows[0]).toEqual({
        kind: "ORDER_SEARCH_PROMPT",
        payload: { query: "ORD-PRE-103" },
      });
      expect((await runMigrations(db(), migrationsDir)).applied).toEqual([]);
    } finally {
      await rm(before103, { recursive: true, force: true });
    }
  }, 180_000);

  it("upgrades a pre-repair snapshot, preserves owner state, and is rerunnable", async () => {
    await resetSchema();
    const beforeRepairs = await createMigrationDirThrough(104);

    try {
      const baseline = await runMigrations(db(), beforeRepairs);
      expect(baseline.applied).not.toContain(SUPPLIER_REPAIR);
      expect(baseline.applied).not.toContain(ORDER_SEARCH_REPAIR);
      await sql`alter table supplier_order drop constraint if exists supplier_order_attempt_count_chk`.execute(
        db(),
      );
      await sql`alter table supplier_order drop constraint if exists supplier_order_retry_after_chk`.execute(
        db(),
      );
      await sql`drop index if exists supplier_order_provider_client_uq`.execute(db());
      await sql`alter table supplier_order alter column attempt_count drop not null`.execute(db());

      await seedLegacySupplierOrder();
      await sql`
        update supplier_order
        set attempt_count = null
        where id = 'legacy-supplier-order'
      `.execute(db());

      await sql`alter table admin_callback_state drop constraint if exists admin_callback_state_kind_check`.execute(
        db(),
      );
      await sql`
        insert into admin_callback_state
          (id, admin_telegram_user_id, kind, payload_redacted, expires_at)
        values
          ('legacy-order-search-state', '99887766', 'ORDER_SEARCH_PROMPT',
           '{"query":"ORD-LEGACY"}'::jsonb, timestamptz '2030-01-01T00:00:00Z')
      `.execute(db());

      const upgrade = await runMigrations(db(), migrationsDir);
      expect(upgrade.applied).toEqual([
        SUPPLIER_REPAIR,
        ORDER_SEARCH_REPAIR,
        DELIVERY_RECOVERY_REPAIR,
      ]);

      await sql`
        insert into supplier_order
          (id, supplier_id, supplier_sku_id, order_id, idempotency_key, request_fingerprint,
           status, cost_vnd_snapshot, sale_price_vnd_snapshot, margin_vnd_snapshot, submitted_at)
        values
          ('new-default-supplier-order', 'migration-supplier', 'migration-sku', 'migration-order',
           'new-default-key', 'new-default-fingerprint', 'SUBMITTED', 120000, 199000, 79000, now())
      `.execute(db());

      const proof = await sql<{
        legacyQueryKey: string | null;
        legacyFingerprintVersion: number;
        newFingerprintVersion: number;
        newAttemptCount: number;
        queryIndex: string | null;
        providerClientIndex: string | null;
        fingerprintConstraint: string | null;
        callbackKind: string;
        callbackPayload: unknown;
      }>`
        select
          (select query_key from supplier_order where id = 'legacy-supplier-order') as "legacyQueryKey",
          (select request_fingerprint_version from supplier_order
           where id = 'legacy-supplier-order') as "legacyFingerprintVersion",
          (select request_fingerprint_version from supplier_order
           where id = 'new-default-supplier-order') as "newFingerprintVersion",
          (select attempt_count from supplier_order
           where id = 'new-default-supplier-order') as "newAttemptCount",
          to_regclass('public.supplier_order_query_key_uq')::text as "queryIndex",
          to_regclass('public.supplier_order_provider_client_uq')::text as "providerClientIndex",
          (select pg_get_constraintdef(oid) from pg_constraint
           where conrelid = 'supplier_order'::regclass
             and conname = 'supplier_order_request_fingerprint_version_chk') as "fingerprintConstraint",
          (select kind from admin_callback_state where id = 'legacy-order-search-state') as "callbackKind",
          (select payload_redacted from admin_callback_state where id = 'legacy-order-search-state') as "callbackPayload"
      `.execute(db());

      expect(proof.rows[0]).toMatchObject({
        legacyQueryKey: "legacy-provider-query-key",
        legacyFingerprintVersion: 1,
        newFingerprintVersion: 2,
        newAttemptCount: 0,
        queryIndex: "supplier_order_query_key_uq",
        providerClientIndex: "supplier_order_provider_client_uq",
        callbackKind: "ORDER_SEARCH_PROMPT",
        callbackPayload: { query: "ORD-LEGACY" },
      });
      expect(proof.rows[0]?.fingerprintConstraint).toMatch(/1.*2/s);

      // Exercise the SQL itself a second time rather than only relying on the
      // runner receipt table to skip already-applied filenames.
      await sql`
        delete from schema_migrations
        where filename in (${SUPPLIER_REPAIR}, ${ORDER_SEARCH_REPAIR})
      `.execute(db());
      const rerun = await runMigrations(db(), migrationsDir);
      expect(rerun.applied).toEqual([SUPPLIER_REPAIR, ORDER_SEARCH_REPAIR]);
      expect(rerun.alreadyApplied).toContain("104_inventory_import_generation_fencing.sql");

      const preserved = await sql<{ kind: string; payload: unknown; queryKey: string | null }>`
        select
          (select kind from admin_callback_state where id = 'legacy-order-search-state') as kind,
          (select payload_redacted from admin_callback_state where id = 'legacy-order-search-state') as payload,
          (select query_key from supplier_order where id = 'legacy-supplier-order') as "queryKey"
      `.execute(db());
      expect(preserved.rows[0]).toEqual({
        kind: "ORDER_SEARCH_PROMPT",
        payload: { query: "ORD-LEGACY" },
        queryKey: "legacy-provider-query-key",
      });
    } finally {
      await rm(beforeRepairs, { recursive: true, force: true });
    }
  }, 180_000);
  it("upgrades a pre-107 snapshot without rewriting confirmations", async () => {
    await resetSchema();
    const beforeRepair = await createMigrationDirThrough(106);

    try {
      const baseline = await runMigrations(db(), beforeRepair);
      expect(baseline.applied).not.toContain(DELIVERY_RECOVERY_REPAIR);
      await sql`
        insert into customer (id) values ('migration-confirmation-customer')
      `.execute(db());
      await sql`
        insert into channel_identity
          (id, customer_id, channel, channel_user_id)
        values
          ('migration-confirmation-identity', 'migration-confirmation-customer',
           'TELEGRAM', '9988776655')
      `.execute(db());
      await sql`
        insert into admin_confirmation
          (id, root_channel_identity_id, action_fingerprint, challenge_hash,
           status, expires_at, correlation_id, allowlisted_command_ref)
        values
          ('legacy-confirmation', 'migration-confirmation-identity',
           'legacy-action', 'legacy-challenge', 'CREATED',
           timestamptz '2030-01-01T00:00:00Z', 'legacy-correlation',
           'discrepancy.resolve')
      `.execute(db());

      const upgrade = await runMigrations(db(), migrationsDir);
      expect(upgrade.applied).toEqual([DELIVERY_RECOVERY_REPAIR]);

      const preserved = await sql<{
        id: string;
        allowlistedCommandRef: string | null;
        status: string;
      }>`
        select id, allowlisted_command_ref as "allowlistedCommandRef", status
        from admin_confirmation
        where id = 'legacy-confirmation'
      `.execute(db());
      expect(preserved.rows[0]).toEqual({
        id: "legacy-confirmation",
        allowlistedCommandRef: "discrepancy.resolve",
        status: "CREATED",
      });

      await sql`
        insert into admin_confirmation
          (id, root_channel_identity_id, action_fingerprint, challenge_hash,
           status, expires_at, correlation_id, allowlisted_command_ref)
        values
          ('new-recovery-confirmation', 'migration-confirmation-identity',
           'recovery-action', 'recovery-challenge', 'CREATED',
           timestamptz '2030-01-01T00:00:00Z', 'recovery-correlation',
           'file_delivery.recover')
      `.execute(db());

      await expect(
        sql`
        insert into admin_confirmation
          (id, root_channel_identity_id, action_fingerprint, challenge_hash,
           status, expires_at, correlation_id, allowlisted_command_ref)
        values
          ('unknown-confirmation', 'migration-confirmation-identity',
           'unknown-action', 'unknown-challenge', 'CREATED',
           timestamptz '2030-01-01T00:00:00Z', 'unknown-correlation',
           'unknown.command')
      `.execute(db()),
      ).rejects.toThrow(/admin_confirmation_command_ref_ck/);

      await sql`delete from schema_migrations where filename = ${DELIVERY_RECOVERY_REPAIR}`.execute(
        db(),
      );
      const rerun = await runMigrations(db(), migrationsDir);
      expect(rerun.applied).toEqual([DELIVERY_RECOVERY_REPAIR]);
      const afterRerun = await sql<{ count: number }>`
        select count(*)::int as count
        from admin_confirmation
        where id in ('legacy-confirmation', 'new-recovery-confirmation')
      `.execute(db());
      expect(afterRerun.rows[0]?.count).toBe(2);
    } finally {
      await rm(beforeRepair, { recursive: true, force: true });
    }
  }, 180_000);
});

async function resetSchema(): Promise<void> {
  await sql`drop schema public cascade`.execute(db());
  await sql`create schema public`.execute(db());
}
function db() {
  if (!started) throw new Error("migration test database was not started");
  return started.handle.db;
}

async function seedLegacySupplierOrder(): Promise<void> {
  await sql`
    insert into category (id, name_vi, slug)
    values ('migration-category', 'Migration category', 'migration-category')
  `.execute(db());
  await sql`
    insert into product (id, category_id, name_vi, slug)
    values ('migration-product', 'migration-category', 'Migration product', 'migration-product')
  `.execute(db());
  await sql`
    insert into product_variant
      (id, product_id, sku, name_vi, price_vnd, duration_code, delivery_type, stock_policy)
    values
      ('migration-variant', 'migration-product', 'MIGRATION-SKU', 'Migration variant',
       199000, 'P1M', 'CREDENTIAL', 'SUPPLIER_ONLY')
  `.execute(db());
  await sql`
    insert into customer (id)
    values ('migration-customer')
  `.execute(db());
  await sql`
    insert into "order"
      (id, order_number, customer_id, variant_id, product_name_vi, variant_name_vi,
       price_vnd, duration_code, delivery_type, status, paid_at)
    values
      ('migration-order', 'ORD-MIGRATION', 'migration-customer', 'migration-variant',
       'Migration product', 'Migration variant', 199000, 'P1M', 'CREDENTIAL', 'PAID', now())
  `.execute(db());
  await sql`
    insert into supplier (id, name, adapter_type, credential_vault_ref, status)
    values ('migration-supplier', 'Migration supplier', 'TEST', 'vault:migration', 'ACTIVE')
  `.execute(db());
  await sql`
    insert into supplier_sku
      (id, supplier_id, variant_id, external_sku, cost_vnd, region, delivery_type, is_active)
    values
      ('migration-sku', 'migration-supplier', 'migration-variant', 'MIGRATION-EXT-SKU',
       120000, 'VN', 'CREDENTIAL', true)
  `.execute(db());
  await sql`
    update product_variant
    set supplier_sku_id = 'migration-sku'
    where id = 'migration-variant'
  `.execute(db());
  await sql`
    insert into supplier_order
      (id, supplier_id, supplier_sku_id, order_id, idempotency_key, request_fingerprint,
       external_order_id, status, cost_vnd_snapshot, sale_price_vnd_snapshot,
       margin_vnd_snapshot, submitted_at)
    values
      ('legacy-supplier-order', 'migration-supplier', 'migration-sku', 'migration-order',
       'legacy-idempotency-key', 'legacy-fingerprint', 'legacy-provider-query-key',
       'UNKNOWN', 120000, 199000, 79000, now())
  `.execute(db());
}

async function createMigrationDirThrough(maxMigration: number): Promise<string> {
  const dir = await mkdtemp(resolve(tmpdir(), "telegram-shop-migrations-"));
  const files = await readdir(migrationsDir);
  for (const filename of files) {
    const match = /^(\d+)/u.exec(filename);
    if (!match || Number(match[1]) > maxMigration) continue;
    await cp(resolve(migrationsDir, filename), resolve(dir, filename));
  }
  return dir;
}
