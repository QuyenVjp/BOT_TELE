import { sql } from "kysely";
import type { Db } from "../../infrastructure/db/transaction.js";
import type { RateLimiter } from "../risk/service.js";
import type { VerifiedSePayEvidence } from "./sepay-ingress.js";
import { applyPaymentEvidence, type ApplyEvidenceResult } from "./service.js";

/**
 * Bounded SePay reconciliation (T054, FR-012).
 *
 * Reconciliation is the recovery path for missing webhooks. It queries a bounded
 * provider window and feeds every returned transaction back through the SAME
 * `applyPaymentEvidence` verification/match pipeline as the live webhook — it can
 * NEVER bypass those rules or silently mark an order paid. Because the settlement
 * service dedupes by provider transaction id and enforces exactly-once effects,
 * re-running reconciliation is safe: a transaction the webhook already recorded
 * comes back as `ALREADY_APPLIED`, and a mismatch becomes a Discrepancy.
 *
 * SePay API v2 documents page/per_page transaction lists. It also documents
 * `since_id` as a created-after UUID cursor, which is not compatible with our
 * transaction-date windows unless SePay also guarantees matching ordering. The
 * recovery worker therefore uses only fixed-window page checkpoints and performs
 * a full page-1 rescan after each empty page/window completion; canonical bank
 * transaction idempotence absorbs duplicates while late rows remain recoverable.
 */

/** The provider read port — a thin adapter over SePay's transaction-list API. */
export interface SePayReconciliationPort {
  /**
   * Return verified provider transactions within `[fromSec, toSec]`. The adapter
   * is responsible for signature/schema verification so every element is already
   * trustworthy evidence; the matcher still decides settle vs discrepancy.
   *
   * `sinceId` is retained for non-recovery callers, but recovery does not use it.
   */
  listTransactions(
    fromSec: number,
    toSec: number,
    limit?: number,
    options?: { page?: number; sinceId?: string },
  ): Promise<VerifiedSePayEvidence[]>;
}

export interface SePayReconciliationCursor {
  provider: string;
  windowFromSec: number;
  windowToSec: number;
  page: number;
  perPage: number;
  generation: number;
}

export interface SePayReconciliationCursorStore {
  claim(
    provider: string,
    proposedWindowFromSec: number,
    proposedWindowToSec: number,
    perPage: number,
  ): Promise<SePayReconciliationCursor>;
  advancePage(cursor: SePayReconciliationCursor): Promise<SePayReconciliationCursor>;
  completeWindow(
    cursor: SePayReconciliationCursor,
    nextWindowFromSec: number,
    nextWindowToSec: number,
    perPage: number,
  ): Promise<SePayReconciliationCursor>;
}

export const SEPAY_RECONCILIATION_CURSOR_CONFLICT = "SEPAY_RECONCILIATION_CURSOR_CONFLICT";

function assertWindow(provider: string, windowFromSec: number, windowToSec: number): void {
  if (!/^[a-z][a-z0-9_-]{0,63}$/.test(provider)) throw new Error("INVALID_SEPAY_CURSOR_PROVIDER");
  if (
    !Number.isInteger(windowFromSec) ||
    windowFromSec < 0 ||
    !Number.isInteger(windowToSec) ||
    windowToSec < windowFromSec
  ) {
    throw new Error("INVALID_SEPAY_CURSOR_WINDOW");
  }
}

function assertPerPage(perPage: number): void {
  if (!Number.isInteger(perPage) || perPage < 1 || perPage > 100)
    throw new Error("INVALID_SEPAY_CURSOR_PER_PAGE");
}

function cursorFromRow(row: {
  provider: string;
  window_from_sec: number;
  window_to_sec: number;
  page: number;
  per_page: number;
  generation: number;
}): SePayReconciliationCursor {
  return {
    provider: row.provider,
    windowFromSec: row.window_from_sec,
    windowToSec: row.window_to_sec,
    page: row.page,
    perPage: row.per_page,
    generation: row.generation,
  };
}

export function createPostgresSePayReconciliationCursorStore(
  db: Db,
): SePayReconciliationCursorStore {
  return {
    async claim(provider, proposedWindowFromSec, proposedWindowToSec, perPage) {
      assertWindow(provider, proposedWindowFromSec, proposedWindowToSec);
      assertPerPage(perPage);
      const result = await sql<{
        provider: string;
        window_from_sec: number;
        window_to_sec: number;
        page: number;
        per_page: number;
        generation: number;
      }>`
        insert into sepay_reconciliation_cursor
          (provider, window_from_sec, window_to_sec, page, per_page, generation)
        values (${provider}, ${proposedWindowFromSec}, ${proposedWindowToSec}, 1, ${perPage}, 1)
        on conflict (provider) do update set updated_at = now()
        returning provider, window_from_sec, window_to_sec, page, per_page, generation
      `.execute(db);
      return cursorFromRow(result.rows[0]!);
    },
    async advancePage(cursor) {
      assertWindow(cursor.provider, cursor.windowFromSec, cursor.windowToSec);
      assertPerPage(cursor.perPage);
      const result = await sql<{
        provider: string;
        window_from_sec: number;
        window_to_sec: number;
        page: number;
        per_page: number;
        generation: number;
      }>`
        update sepay_reconciliation_cursor
        set page = page + 1, generation = generation + 1, updated_at = now()
        where provider = ${cursor.provider}
          and window_from_sec = ${cursor.windowFromSec}
          and window_to_sec = ${cursor.windowToSec}
          and page = ${cursor.page}
          and per_page = ${cursor.perPage}
          and generation = ${cursor.generation}
        returning provider, window_from_sec, window_to_sec, page, per_page, generation
      `.execute(db);
      if (!result.rows[0]) throw new Error(SEPAY_RECONCILIATION_CURSOR_CONFLICT);
      return cursorFromRow(result.rows[0]);
    },
    async completeWindow(cursor, nextWindowFromSec, nextWindowToSec, perPage) {
      assertWindow(cursor.provider, cursor.windowFromSec, cursor.windowToSec);
      assertWindow(cursor.provider, nextWindowFromSec, nextWindowToSec);
      assertPerPage(cursor.perPage);
      assertPerPage(perPage);
      const result = await sql<{
        provider: string;
        window_from_sec: number;
        window_to_sec: number;
        page: number;
        per_page: number;
        generation: number;
      }>`
        update sepay_reconciliation_cursor
        set window_from_sec = ${nextWindowFromSec},
            window_to_sec = ${nextWindowToSec},
            page = 1,
            per_page = ${perPage},
            generation = generation + 1,
            updated_at = now()
        where provider = ${cursor.provider}
          and window_from_sec = ${cursor.windowFromSec}
          and window_to_sec = ${cursor.windowToSec}
          and page = ${cursor.page}
          and per_page = ${cursor.perPage}
          and generation = ${cursor.generation}
        returning provider, window_from_sec, window_to_sec, page, per_page, generation
      `.execute(db);
      if (!result.rows[0]) throw new Error(SEPAY_RECONCILIATION_CURSOR_CONFLICT);
      return cursorFromRow(result.rows[0]);
    },
  };
}

export interface ReconcileOptions {
  port: SePayReconciliationPort;
  /** Inclusive lower bound of the provider window (epoch seconds). */
  windowFromSec: number;
  /** Inclusive upper bound of the provider window (epoch seconds). */
  windowToSec: number;
  /** Optional per-window provider-call budget; omit for unbounded. */
  rateLimiter?: RateLimiter;
  /** Bucket key for the budget (defaults to the provider name). */
  rateLimitKey?: string;
  /** Injectable clock for deterministic late-payment decisions. */
  now?: Date;
  /** Hard cap for provider rows processed in this run (1..100). */
  maxTransactions?: number;
  page?: number;
  sinceId?: string;
}

export interface ReconcileSummary {
  fetched: number;
  scanned: number;
  recovered: number;
  alreadyPresent: number;
  discrepancies: number;
  throttled: number;
  errors: number;
  pageComplete: boolean;
  windowComplete: boolean;
  lastProviderCursor: string | null;
}

const PROVIDER_CURSOR_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function sePayProviderCursorId(providerTransactionId: string): string | null {
  const raw = providerTransactionId.startsWith("api:")
    ? providerTransactionId.slice(4)
    : providerTransactionId;
  return PROVIDER_CURSOR_UUID.test(raw) ? raw : null;
}

export async function reconcileSePay(db: Db, options: ReconcileOptions): Promise<ReconcileSummary> {
  const { port, windowFromSec, windowToSec } = options;
  const key = options.rateLimitKey ?? "sepay-reconcile";
  const now = options.now ?? new Date();
  const maxTransactions = options.maxTransactions ?? 100;
  if (!Number.isInteger(maxTransactions) || maxTransactions < 1 || maxTransactions > 100) {
    throw new RangeError("SePay reconciliation maxTransactions must be between 1 and 100");
  }

  const fetched = await port.listTransactions(windowFromSec, windowToSec, maxTransactions, {
    page: options.page ?? 1,
    ...(options.sinceId !== undefined ? { sinceId: options.sinceId } : {}),
  });
  const txns = fetched.slice(0, maxTransactions);

  const summary: ReconcileSummary = {
    fetched: fetched.length,
    scanned: 0,
    recovered: 0,
    alreadyPresent: 0,
    discrepancies: 0,
    throttled: Math.max(0, fetched.length - txns.length),
    errors: 0,
    pageComplete: fetched.length === 0,
    windowComplete: fetched.length === 0,
    lastProviderCursor: null,
  };

  for (let index = 0; index < txns.length; index += 1) {
    const txn = txns[index]!;
    if (options.rateLimiter && !options.rateLimiter.tryConsume(key)) {
      summary.throttled += txns.length - index;
      return summary;
    }
    summary.scanned += 1;

    let result: ApplyEvidenceResult;
    try {
      result = await applyPaymentEvidence(db, txn, now);
    } catch {
      summary.errors += 1;
      return summary;
    }
    if (!result.ok) {
      summary.errors += 1;
      return summary;
    }
    switch (result.kind) {
      case "SETTLED":
        summary.recovered += 1;
        break;
      case "ALREADY_APPLIED":
        summary.alreadyPresent += 1;
        break;
      case "DISCREPANCY":
        summary.discrepancies += 1;
        break;
    }
    summary.lastProviderCursor = sePayProviderCursorId(txn.providerTransactionId);
  }

  summary.pageComplete = fetched.length <= maxTransactions;
  return summary;
}
