import { Kysely, PostgresDialect, sql } from "kysely";
import pg from "pg";

/**
 * PostgreSQL connection + Kysely instance (source of truth).
 *
 * - A single pooled connection per process; the pool is created lazily and
 *   closed on graceful shutdown.
 * - VND money columns are `bigint`; node-postgres returns bigint columns as
 *   strings by default, so we register a parser that keeps them exact (never
 *   coerced to a lossy JS number). Application code wraps them via `makeVnd`.
 * - No schema types are hard-coded here beyond the migration bookkeeping table;
 *   modules bring their own typed row shapes at their repository boundary.
 */

const { Pool, types } = pg;

// OID 20 = int8/bigint. Keep exact by parsing to string (never lossy number).
// Application converts to bigint/Vnd at the repository boundary.
types.setTypeParser(20, (value) => value);
// OID 1700 = numeric. Keep as string to preserve precision.
types.setTypeParser(1700, (value) => value);

export interface DbHandle {
  readonly db: Kysely<Database>;
  readonly pool: pg.Pool;
  close(): Promise<void>;
}

/**
 * Minimal database surface. Individual modules extend their own row types at
 * the repository boundary; the shared instance stays intentionally loose so
 * the migration runner and generic helpers can operate over any table.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface Database {}

export interface CreateDbOptions {
  connectionString: string;
  /** Max pool size; small default suits a modular monolith. */
  maxConnections?: number;
  /** Statement timeout guards runaway queries (ms). */
  statementTimeoutMs?: number;
}

export function createDb(options: CreateDbOptions): DbHandle {
  const pool = new Pool({
    connectionString: options.connectionString,
    max: options.maxConnections ?? 10,
    statement_timeout: options.statementTimeoutMs ?? 15_000,
    // Fail fast on a dead connection rather than hanging a request.
    connectionTimeoutMillis: 5_000,
  });

  const db = new Kysely<Database>({
    dialect: new PostgresDialect({ pool }),
  });

  return {
    db,
    pool,
    async close() {
      await db.destroy();
    },
  };
}

/** Liveness probe: `SELECT 1`. Throws if the database is unreachable. */
export async function pingDb(db: Kysely<Database>): Promise<void> {
  await sql`select 1`.execute(db);
}
