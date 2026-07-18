import type { Executor } from "../../infrastructure/db/transaction.js";
import { decideMatch, type MatchDecision, type PaymentEvidence } from "./domain.js";
import { findIntentByContent } from "./repository.js";

/**
 * Deterministic evidence matcher (T052).
 *
 * Resolves the candidate PaymentIntent by transfer content, then delegates the
 * settle-vs-discrepancy decision to pure `decideMatch`. The repository is the
 * only side effect; the decision itself is a pure function so property tests
 * can exercise it without a database.
 */

export interface MatchResult {
  decision: MatchDecision;
  /** Present when an intent was found (even if the decision is a discrepancy). */
  intent: Awaited<ReturnType<typeof findIntentByContent>>;
}

/**
 * Look up the intent for the evidence content and decide settle or discrepancy.
 * `now` is injectable so late-payment property tests stay deterministic.
 */
export async function matchEvidence(
  exec: Executor,
  evidence: PaymentEvidence,
  now: Date = new Date(),
): Promise<MatchResult> {
  const content = evidence.content?.trim() ?? "";
  const intent = content.length > 0 ? await findIntentByContent(exec, content) : null;
  const decision = decideMatch(evidence, intent, now);
  return { decision, intent };
}
