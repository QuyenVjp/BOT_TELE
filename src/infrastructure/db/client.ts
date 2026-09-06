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

/** Fixed channels carry only a wake hint; durable rows remain the payload. */
export const DB_WAKE_CHANNELS = {
  telegram: "bot_tele_telegram_inbox",
  sepay: "bot_tele_sepay_inbox",
  outbox: "bot_tele_outbox",
} as const;

export type DbWakeChannel = (typeof DB_WAKE_CHANNELS)[keyof typeof DB_WAKE_CHANNELS];

export interface DbWakeListener {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface DbWakeListenerOptions {
  callbacks: Partial<Record<DbWakeChannel, () => void | Promise<void>>>;
  initialBackoffMs?: number;
  maxBackoffMs?: number;
  random?: () => number;
}

/**
 * Dedicated LISTEN connection. Notifications are hints only: callbacks must
 * drain durable queues and polling remains the recovery path.
 */
export function createDbWakeListener(
  pool: pg.Pool,
  options: DbWakeListenerOptions,
): DbWakeListener {
  const random = options.random ?? Math.random;
  const initialBackoff = options.initialBackoffMs ?? 250;
  const maxBackoff = options.maxBackoffMs ?? 30_000;
  let client: pg.PoolClient | undefined;
  let stopped = true;
  let connecting: Promise<void> | undefined;
  let reconnectTimer: NodeJS.Timeout | undefined;

  const wake = (channel: string): void => {
    const callback = options.callbacks[channel as DbWakeChannel];
    if (callback) void Promise.resolve(callback()).catch(() => undefined);
  };
  const scheduleReconnect = (delay: number): void => {
    if (stopped || reconnectTimer) return;
    const jittered = Math.min(maxBackoff, delay * (0.8 + random() * 0.4));
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      void connect(Math.min(maxBackoff, delay * 2));
    }, jittered);
  };
  const connect = async (backoff: number): Promise<void> => {
    if (stopped || connecting) return connecting;
    connecting = (async () => {
      try {
        const next = await pool.connect();
        if (stopped) {
          next.release();
          return;
        }
        client = next;
        next.on("notification", (message) => wake(message.channel));
        next.once("error", () => {
          if (client === next) {
            client = undefined;
            next.release(true);
            scheduleReconnect(backoff);
          }
        });
        next.once("end", () => {
          if (client === next) {
            client = undefined;
            scheduleReconnect(backoff);
          }
        });
        for (const channel of Object.values(DB_WAKE_CHANNELS)) {
          await next.query(`LISTEN ${channel}`);
        }
        // Close the startup race: drain after LISTEN is active.
        for (const channel of Object.values(DB_WAKE_CHANNELS)) wake(channel);
      } catch {
        client = undefined;
        scheduleReconnect(backoff);
      } finally {
        connecting = undefined;
      }
    })();
    return connecting;
  };

  return {
    async start() {
      if (!stopped) return;
      stopped = false;
      await connect(initialBackoff);
    },
    async stop() {
      stopped = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = undefined;
      const active = client;
      client = undefined;
      if (active) {
        try {
          await active.query("UNLISTEN *");
        } finally {
          active.release(true);
        }
      }
      await connecting;
    },
  };
}

/** Liveness probe: `SELECT 1`. Throws if the database is unreachable. */
export async function pingDb(db: Kysely<Database>): Promise<void> {
  await sql`select 1`.execute(db);
}
