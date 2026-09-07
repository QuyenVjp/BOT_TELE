import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { listMigrationFiles } from "../../src/infrastructure/db/migrate.js";

const migrationsDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../src/infrastructure/db/migrations",
);

describe("Feature 001 migration upgrade path (T183/T186)", () => {
  it("freezes 008 as SePay-only and reserves 009 for identity/delivery security", async () => {
    const files = await listMigrationFiles(migrationsDir);
    expect(files).toContain("008_sepay_inbox_security.sql");
    expect(files).toContain("009_identity_delivery_security.sql");
    expect(files).toContain("009a_delivery_capability_compensation.sql");
    expect(files).not.toContain("009_notifications_quantity.sql");
    expect(files).not.toContain("010_ai_support.sql");

    const sepayOnly = await readFile(join(migrationsDir, "008_sepay_inbox_security.sql"), "utf8");
    expect(sepayOnly).not.toMatch(/create table\s+delivery_session/i);
    expect(sepayOnly).not.toMatch(/create table\s+delivery_notification_handoff/i);
    expect(sepayOnly).not.toMatch(/alter table\s+channel_identity/i);
  });

  it("migration 009 is idempotent and fails closed on telegram case collisions", async () => {
    const migration = await readFile(
      join(migrationsDir, "009_identity_delivery_security.sql"),
      "utf8",
    );
    expect(migration).toMatch(/create table if not exists\s+delivery_session/i);
    expect(migration).toMatch(/create table if not exists\s+delivery_notification_handoff/i);
    expect(migration).toMatch(/capability_key\s+text\s+not null/i);
    expect(migration).toMatch(/alter column capability_ref drop not null/i);
    expect(migration).toMatch(/PREPARED.*STORED.*READY/is);
    expect(migration).toMatch(/collision/i);
    expect(migration).toMatch(/raise exception/i);
  });

  it("adds the Feature 001 compensation ledger without rewriting frozen 008 or applied 009", async () => {
    const migration = await readFile(
      join(migrationsDir, "009a_delivery_capability_compensation.sql"),
      "utf8",
    );
    expect(migration).toMatch(/add column if not exists activated_at/i);
    expect(migration).toMatch(/create table if not exists\s+delivery_capability_compensation/i);
    expect(migration).toMatch(/capability_ref\s+text\s+not null\s+unique/i);
    expect(migration).toMatch(/cleanup_after\s+timestamptz\s+not null/i);
  });

  it("extends durable admin confirmation commands in a forward migration", async () => {
    const files = await listMigrationFiles(migrationsDir);
    expect(files).toContain("036_support_replacement_confirmation.sql");

    const frozen = await readFile(join(migrationsDir, "006_admin_confirmation.sql"), "utf8");
    expect(frozen).toMatch(/admin_confirmation_command_ref_ck/i);
    expect(frozen).not.toMatch(/support\.replacement\.approve/i);

    const migration = await readFile(
      join(migrationsDir, "036_support_replacement_confirmation.sql"),
      "utf8",
    );
    expect(migration).toMatch(/drop constraint if exists admin_confirmation_command_ref_ck/i);
    expect(migration).toMatch(/add constraint admin_confirmation_command_ref_ck/i);
    expect(migration).toMatch(/discrepancy\.resolve/i);
    expect(migration).toMatch(/wallet\.refund/i);
    expect(migration).toMatch(/manual_fulfillment\.complete/i);
    expect(migration).toMatch(/support\.replacement\.approve/i);
  });
});
