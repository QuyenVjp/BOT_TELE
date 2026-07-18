import type { Kysely, Transaction } from "kysely";
import type { Database } from "./client.js";

/**
 * Typed transaction boundary.
 *
 * - Every business mutation that must be atomic (order + outbox event, payment
 *   allocation + intent state, asset claim + bundle) runs inside `withTransaction`
 *   so the transactional-outbox invariant holds: the domain change and its event
 *   commit together or not at all (SR-006).
 * - The callback receives a `Transaction<Database>` which is API-compatible with
 *   the plain `Kysely` instance, so repositories accept either an ambient handle
 *   or an in-flight transaction (the "unit of work" seam) without branching.
 */

export type Db = Kysely<Database>;
export type Trx = Transaction<Database>;

/** A handle that can execute queries — either the pool or an open transaction. */
export type Executor = Db | Trx;

export async function withTransaction<T>(db: Db, fn: (trx: Trx) => Promise<T>): Promise<T> {
  return db.transaction().execute(fn);
}
