import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { cp, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { sql } from "kysely";
import { listMigrationFiles, runMigrations } from "../../src/infrastructure/db/migrate.js";
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
  it("upgrades a pre-094 database with the durable supplier canary schema", async () => {
    if (!hasDocker) return;
    const started = await startPostgres();
    const baselineDir = await createPreCanaryMigrationDir();
    try {
      await sql`drop schema public cascade`.execute(started.handle.db);
      await sql`create schema public`.execute(started.handle.db);
      const baseline = await runMigrations(started.handle.db, baselineDir);
      expect(baseline.applied.some((file) => file.startsWith("093_"))).toBe(true);
      expect(baseline.applied).not.toContain("094_supplier_owner_canary.sql");
      await sql`insert into customer (id) values ('pre-canary-customer')`.execute(
        started.handle.db,
      );

      const before = await sql<{ canary_table: string | null; query_key_column: string | null }>`
        select
          to_regclass('public.supplier_canary_run')::text as canary_table,
          (select column_name from information_schema.columns
           where table_schema = 'public' and table_name = 'supplier_order'
             and column_name = 'query_key' limit 1) as query_key_column
      `.execute(started.handle.db);
      expect(before.rows[0]).toEqual({ canary_table: null, query_key_column: null });

      const upgrade = await runMigrations(started.handle.db);
      expect(upgrade.applied).toContain("094_supplier_owner_canary.sql");
      const proof = await sql<{
        canary_table: string | null;
        query_key_column: string | null;
        command_constraint: string | null;
        canary_status_constraint: string | null;
        preserved_customers: string;
        applied_count: string;
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
          (select count(*)::text from schema_migrations
           where filename = '094_supplier_owner_canary.sql') as applied_count
      `.execute(started.handle.db);
      expect(proof.rows[0]).toMatchObject({
        canary_table: "supplier_canary_run",
        query_key_column: "query_key",
        preserved_customers: "1",
        applied_count: "1",
      });
      expect(proof.rows[0]?.command_constraint).toContain("supplier.canary.purchase");
      expect(proof.rows[0]?.canary_status_constraint).toContain("SUBMITTED");
      expect(proof.rows[0]?.canary_status_constraint).toContain("UNKNOWN");
    } finally {
      await rm(baselineDir, { recursive: true, force: true });
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
async function createPreCanaryMigrationDir(): Promise<string> {
  const dir = await mkdtemp(resolve(tmpdir(), "telegram-shop-pre-canary-migrations-"));
  const source = resolve(repoRoot, "src", "infrastructure", "db", "migrations");
  const files = await listMigrationFiles(source);
  for (const file of files) {
    if (file.localeCompare("094_supplier_owner_canary.sql") >= 0) break;
    await cp(resolve(source, file), resolve(dir, file));
  }
  return dir;
}
