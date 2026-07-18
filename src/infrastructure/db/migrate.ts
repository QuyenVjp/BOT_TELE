import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { sql, type Kysely } from "kysely";
import pg from "pg";
import type { Database, DbHandle } from "./client.js";

/**
 * Minimal forward-only SQL migration runner + CLI entrypoint (T117 / T120).
 *
 * - Migrations are plain `.sql` files in `./migrations`, applied in filename
 *   order (zero-padded numeric prefix). Each file runs inside one transaction.
 * - A `schema_migrations` bookkeeping table records applied filenames, so
 *   re-running is idempotent and safe on every boot.
 * - Advisory lock is taken on a PINNED connection (session-scoped). Using a
 *   pooled Kysely handle for lock+unlock is wrong: the unlock can land on a
 *   different session than the lock, leaving the lock held forever and allowing
 *   concurrent booters to race. We therefore check out one `pg.PoolClient` for
 *   the entire run.
 *
 * CLI: `npm run migrate` (or `tsx src/infrastructure/db/migrate.ts`).
 * Requires DATABASE_URL in the environment. Never logs the connection string.
 */

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "migrations");

// Arbitrary but stable key so concurrent booters serialize on the same lock.
const MIGRATION_LOCK_KEY = 776_1234;

export interface MigrationResult {
  applied: string[];
  alreadyApplied: string[];
}

/** Minimal surface shared by `pg.Client` and `pg.PoolClient`. */
interface PgQueryable {
  query: pg.PoolClient["query"];
}

async function ensureMigrationsTable(db: Kysely<Database> | PgQueryable): Promise<void> {
  const q = `
    create table if not exists schema_migrations (
      filename    text primary key,
      applied_at  timestamptz not null default now()
    )
  `;
  if (isPgQueryable(db)) {
    await db.query(q);
  } else {
    await sql.raw(q).execute(db);
  }
}

async function appliedFilenames(db: Kysely<Database> | PgQueryable): Promise<Set<string>> {
  if (isPgQueryable(db)) {
    const res = await db.query<{ filename: string }>("select filename from schema_migrations");
    return new Set(res.rows.map((r) => r.filename));
  }
  const rows = await sql<{ filename: string }>`select filename from schema_migrations`.execute(db);
  return new Set(rows.rows.map((r) => r.filename));
}

/** List `.sql` migration files in deterministic (sorted) order. */
export async function listMigrationFiles(dir: string = MIGRATIONS_DIR): Promise<string[]> {
  const entries = await readdir(dir);
  return entries.filter((f) => f.endsWith(".sql")).sort((a, b) => a.localeCompare(b));
}

/**
 * Apply pending migrations using a PINNED connection for the advisory lock.
 *
 * Prefer this over the Kysely-only form when concurrent runners are possible
 * (boot, CI, multi-replica deploy). The lock and unlock are guaranteed to run
 * on the same PostgreSQL session.
 */
export async function runMigrationsOnPinnedConnection(
  connectionString: string,
  dir: string = MIGRATIONS_DIR,
): Promise<MigrationResult> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    // Session-scoped advisory lock on THIS connection only.
    await client.query("select pg_advisory_lock($1)", [MIGRATION_LOCK_KEY]);
    try {
      return await applyPending(client, dir);
    } finally {
      await client.query("select pg_advisory_unlock($1)", [MIGRATION_LOCK_KEY]);
    }
  } finally {
    await client.end();
  }
}

/**
 * Apply pending migrations via a Kysely handle.
 *
 * WARNING: the advisory lock is taken through the pool and is NOT pinned to a
 * single session. Prefer {@link runMigrationsOnPinnedConnection} for production
 * and concurrent use. Kept for test helpers that already hold a DbHandle and
 * run single-threaded.
 */
export async function runMigrations(
  db: Kysely<Database>,
  dir: string = MIGRATIONS_DIR,
): Promise<MigrationResult> {
  // Best-effort lock through the pool. Documented as not race-safe under
  // concurrent multi-process boot; the CLI and production path use the pinned
  // form above.
  await sql`select pg_advisory_lock(${MIGRATION_LOCK_KEY})`.execute(db);
  try {
    return await applyPending(db, dir);
  } finally {
    await sql`select pg_advisory_unlock(${MIGRATION_LOCK_KEY})`.execute(db);
  }
}

async function applyPending(
  db: Kysely<Database> | PgQueryable,
  dir: string,
): Promise<MigrationResult> {
  await ensureMigrationsTable(db);

  const applied: string[] = [];
  const alreadyApplied: string[] = [];
  const done = await appliedFilenames(db);
  const files = await listMigrationFiles(dir);

  for (const filename of files) {
    if (done.has(filename)) {
      alreadyApplied.push(filename);
      continue;
    }
    const contents = await readFile(join(dir, filename), "utf8");
    if (isPgQueryable(db)) {
      await db.query("begin");
      try {
        await db.query(contents);
        await db.query("insert into schema_migrations (filename) values ($1)", [filename]);
        await db.query("commit");
      } catch (err) {
        await db.query("rollback");
        throw err;
      }
    } else {
      await db.transaction().execute(async (trx) => {
        await sql.raw(contents).execute(trx);
        await sql`
          insert into schema_migrations (filename) values (${filename})
        `.execute(trx);
      });
    }
    applied.push(filename);
  }

  return { applied, alreadyApplied };
}

function isPgQueryable(db: Kysely<Database> | PgQueryable): db is PgQueryable {
  return typeof (db as PgQueryable).query === "function" && !("transaction" in (db as object));
}

// ---------------------------------------------------------------------------
// CLI entrypoint — `npm run migrate`
// ---------------------------------------------------------------------------

async function cliMain(): Promise<void> {
  // Local `.env` for development; production injects DATABASE_URL.
  await import("dotenv/config");

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString || connectionString.trim().length === 0) {
    process.stderr.write("migrate failed: DATABASE_URL is required\n");
    process.exit(1);
  }

  // Never log the connection string (it carries credentials).
  process.stdout.write("migrate: acquiring advisory lock and applying pending files…\n");
  const result = await runMigrationsOnPinnedConnection(connectionString);
  process.stdout.write(
    `migrate: applied=${result.applied.length} already=${result.alreadyApplied.length}\n`,
  );
  if (result.applied.length > 0) {
    process.stdout.write(`migrate: new files: ${result.applied.join(", ")}\n`);
  }
}

const invokedPath = process.argv[1];
const isEntry = invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href;
if (isEntry) {
  cliMain().catch((err: unknown) => {
    process.stderr.write(
      `migrate failed: ${err instanceof Error ? err.message : "unknown error"}\n`,
    );
    process.exit(1);
  });
}

// Re-export the handle type so callers that previously imported createDb via
// this module still type-check. Not used by the CLI itself.
export type { DbHandle };
