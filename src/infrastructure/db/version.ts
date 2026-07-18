import { AppError } from "../../shared/errors/index.js";

/**
 * Optimistic concurrency helper.
 *
 * Every mutable aggregate carries an integer `version` (data-model.md
 * Conventions). A guarded update writes `set version = version + 1 where id = ?
 * and version = ?`. If zero rows change, another writer moved first — we raise a
 * stable CONFLICT rather than silently clobbering their change.
 *
 * This keeps concurrency control declarative at the repository boundary; no
 * module hand-rolls the compare-and-set check.
 */

export class VersionConflictError extends AppError {
  constructor(aggregate: string, id: string, expectedVersion: number) {
    super("CONFLICT", "The record was modified by another operation", {
      aggregate,
      id,
      expectedVersion,
    });
    this.name = "VersionConflictError";
  }
}

/**
 * Assert that a guarded, version-checked update actually matched a row.
 *
 * @param result       rows affected (or the returned rows length) from the update
 * @param aggregate    aggregate name for diagnostics (e.g. "order")
 * @param id           aggregate id that was targeted
 * @param expectedVersion the version the caller expected to still hold
 */
export function assertVersionUpdated(
  result: { numUpdatedRows: bigint } | number,
  aggregate: string,
  id: string,
  expectedVersion: number,
): void {
  const changed = typeof result === "number" ? result : Number(result.numUpdatedRows);
  if (changed < 1) {
    throw new VersionConflictError(aggregate, id, expectedVersion);
  }
}

/** Next version value for an optimistic write. */
export function nextVersion(current: number): number {
  return current + 1;
}
