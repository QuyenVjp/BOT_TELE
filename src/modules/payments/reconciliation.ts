import type { Db } from "../../infrastructure/db/transaction.js";
import type { RateLimiter } from "../risk/service.js";
import type { VerifiedSePayEvidence } from "./sepay-ingress.js";
import { applyPaymentEvidence } from "./service.js";

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
 * Provider calls are budgeted: a `RateLimiter` (Redis-backed in prod, in-memory
 * in tests) caps how many transactions we process per window; anything beyond the
 * budget is `throttled` and deferred to the next window rather than hammering the
 * provider.
 */

/** The provider read port — a thin adapter over SePay's transaction-list API. */
export interface SePayReconciliationPort {
  /**
   * Return verified provider transactions within `[fromSec, toSec]`. The adapter
   * is responsible for signature/schema verification so every element is already
   * trustworthy evidence; the matcher still decides settle vs discrepancy.
   */
  listTransactions(
    fromSec: number,
    toSec: number,
    limit?: number,
    options?: { page?: number; sinceId?: string },
  ): Promise<VerifiedSePayEvidence[]>;
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
  /** Transactions returned by the provider for the window. */
  fetched: number;
  /** Transactions actually processed (fetched minus throttled). */
  scanned: number;
  /** Missing-webhook transactions recovered into a fresh settlement. */
  recovered: number;
  /** Transactions already recorded (webhook beat us) — no new effect. */
  alreadyPresent: number;
  /** Transactions that failed the match and became a discrepancy. */
  discrepancies: number;
  /** Transactions deferred because the provider-call budget was exhausted. */
  throttled: number;
  /** Unexpected service errors (kept so a poison row can't hide). */
  errors: number;
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
    ...(options.page !== undefined ? { page: options.page } : {}),
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
  };

  for (const txn of txns) {
    // Respect the provider-call budget before doing any work for this row.
    if (options.rateLimiter && !options.rateLimiter.tryConsume(key)) {
      summary.throttled += 1;
      continue;
    }
    summary.scanned += 1;

    let result: Awaited<ReturnType<typeof applyPaymentEvidence>>;
    try {
      // Each evidence item owns its own database transaction. A poison provider
      // row therefore rolls back only itself and cannot abort the bounded batch.
      result = await applyPaymentEvidence(db, txn, now);
    } catch {
      summary.errors += 1;
      continue;
    }
    if (!result.ok) {
      summary.errors += 1;
      continue;
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
  }

  return summary;
}
