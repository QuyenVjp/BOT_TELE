import { sql } from "kysely";
import type { Db } from "../../infrastructure/db/transaction.js";
import type { RateLimiter } from "../risk/service.js";
import { recoverSePayBatch } from "./recovery.js";
import type { SePayReconciliationPort } from "./reconciliation.js";

/**
 * "Kiểm tra thanh toán" — an on-demand, read-only payment check.
 *
 * This is the manual trigger behind the checkout button. It is NOT a second
 * settlement path: it calls the existing `recoverSePayBatch`, which
 *  - reads the provider (SePay transaction list) and nothing else — no provider
 *    mutation, no order write of its own,
 *  - takes the shared `SEPAY_RECOVERY_ADVISORY_LOCK`, so a user click can never
 *    run concurrently with the recovery worker or another click,
 *  - passes every provider row through `applyPaymentEvidence`, the SAME
 *    verification/match pipeline as the live webhook.
 *
 * Therefore this module can NEVER mark an order paid: a transfer settles only
 * because the evidence matched (amount, account, transfer content) under the
 * normal rules. An unmatched or mismatched arrival becomes a Discrepancy, and a
 * transfer already recorded by the webhook comes back as `ALREADY_APPLIED`.
 *
 * Three layers keep impatient clicking from becoming provider spam:
 *  1. `PAYMENT_CHECK_COOLDOWN_SECONDS` — per-provider cursor cooldown, enforced here.
 *  2. the recovery advisory lock — enforced by `recoverSePayBatch`.
 *  3. the `PAYMENT_CHECK` rate limit — enforced at the bot dispatch layer.
 */

/** Minimum spacing between two provider-visible checks, across all users. */
export const PAYMENT_CHECK_COOLDOWN_SECONDS = 20;

export type PaymentCheckReason = "RAN" | "COOLDOWN" | "IN_FLIGHT" | "FAILED" | "NOT_CONFIGURED";

export interface PaymentCheckResult {
  reason: PaymentCheckReason;
}

export async function reconcileForPaymentCheck(
  db: Db,
  options: {
    port: SePayReconciliationPort | null;
    rateLimiter?: RateLimiter;
    now?: Date;
    cooldownSeconds?: number;
  },
): Promise<PaymentCheckResult> {
  const { port } = options;
  if (port === null) return { reason: "NOT_CONFIGURED" };

  const now = options.now ?? new Date();
  const requested = options.cooldownSeconds;
  // A bad value must not silently disable the spam guard: fall back to the default.
  const cooldownSeconds =
    requested !== undefined && Number.isFinite(requested) && requested >= 0
      ? requested
      : PAYMENT_CHECK_COOLDOWN_SECONDS;

  const cursor = await sql<{
    last_started_at: Date | string | null;
    retry_after_until: Date | string | null;
  }>`
    select last_started_at, retry_after_until
    from sepay_reconciliation_cursor
    where provider = 'sepay'
  `.execute(db);
  const lastStartedAt = cursor.rows[0]?.last_started_at;
  if (lastStartedAt != null) {
    const startedMs =
      lastStartedAt instanceof Date ? lastStartedAt.getTime() : new Date(lastStartedAt).getTime();
    if (Number.isFinite(startedMs) && now.getTime() - startedMs < cooldownSeconds * 1000) {
      return { reason: "COOLDOWN" };
    }
  }
  const retryAfterUntil = cursor.rows[0]?.retry_after_until;
  const retryAfterMs =
    retryAfterUntil instanceof Date
      ? retryAfterUntil.getTime()
      : retryAfterUntil
        ? new Date(retryAfterUntil).getTime()
        : NaN;
  if (Number.isFinite(retryAfterMs) && retryAfterMs > now.getTime()) {
    return { reason: "COOLDOWN" };
  }

  // Unexpected database errors are intentionally NOT caught: the caller decides.
  // Provider failures are already contained inside `recoverSePayBatch` and are
  // reported through its `failed` counter.
  const telemetry = await recoverSePayBatch(db, {
    batchSize: 1,
    port,
    now,
    ...(options.rateLimiter ? { rateLimiter: options.rateLimiter } : {}),
  });

  // The caller only asks when its own order is still pending, so a zero claim
  // means there was nothing for this call to do and no cursor write happened:
  // either another runner holds the advisory lock (contention — check again
  // later) or no unpaid intent remains (already settled).
  if (telemetry.claimed === 0) return { reason: "IN_FLIGHT" };
  if (telemetry.failed > 0) return { reason: "FAILED" };
  return { reason: "RAN" };
}
