import type { Db } from "../../infrastructure/db/transaction.js";
import { withTransaction } from "../../infrastructure/db/transaction.js";
import { enqueueOutboxEvent } from "../../infrastructure/outbox/repository.js";
import { newId } from "../../shared/ids/index.js";
import { findOrderById, findOrderByIdForUpdate, transitionOrder } from "../commerce/repository.js";
import { requiresLocalReservation } from "../catalog/domain.js";
import { orderHasActiveReservation } from "../digital-goods/repository.js";
import { isVerifiedSePayEvidence, type VerifiedSePayEvidence } from "./sepay-ingress.js";
import { decideMatch, LATE_PAYMENT_SKEW_MS } from "./domain.js";
import { projectDiscrepancyOrderStatus, projectSettlement } from "./projection.js";
import {
  findIntentByContent,
  findIntentByIdForUpdate,
  findLiveIntentByOrder,
  flagIntentNeedsReview,
  insertBankTransactionIfNew,
  insertDiscrepancy,
  insertPresentedIntent,
  insertSettledAllocation,
  settleIntent,
} from "./repository.js";
import { presentPayment, type PaymentPresentation } from "./vietqr.js";

/**
 * Payment settlement service (T053, T128).
 *
 * Two write paths:
 *  - `presentPaymentForOrder` creates (or reuses) a live PaymentIntent and
 *    returns the VietQR presentation view. Initiation only — never settles.
 *    Refuses to mint a QR for an order under PAYMENT_NEEDS_REVIEW.
 *  - `applyPaymentEvidence` is the single write path for verified SePay (or
 *    reconciliation) evidence. Safe under at-least-once delivery:
 *      1. insert bank_transaction with ON CONFLICT DO NOTHING on the provider txn id;
 *      2. on conflict (replay) short-circuit as already-applied;
 *      3. match the evidence against the live intent;
 *      4. on SETTLE: consult `projectSettlement` — only emit OrderPaid when the
 *         Order is still payable; money for a cancelled/expired Order becomes a
 *         discrepancy instead of a silent delivery (T123/T128);
 *      5. on DISCREPANCY: record the discrepancy, flag the intent, freeze the
 *         Order at PAYMENT_NEEDS_REVIEW so a refresh cannot mint a second QR.
 *
 * All of the above runs in ONE transaction so the domain change and its outbox
 * events commit together (SR-006).
 */

export type ApplyEvidenceResult =
  | { ok: true; kind: "SETTLED"; intentId: string; orderId: string; bankTransactionId: string }
  | { ok: true; kind: "ALREADY_APPLIED" }
  | { ok: true; kind: "DISCREPANCY"; type: string; discrepancyId: string }
  | { ok: false; error: string };

export type PresentPaymentResult =
  { ok: true; intentId: string; presentation: PaymentPresentation } | { ok: false; error: string };

export interface PresentPaymentForOrderInput {
  orderId: string;
  merchantAccountId: string;
  /** VietQR beneficiary account number; intentionally distinct from SePay identity. */
  beneficiaryAccountNumber: string;
  bankBin: string;
  accountName: string;
  /** Validated bank display name used by the payment presenter. */
  bankName?: string;
  /** Public VietQR bank alias used only by the image URL renderer. */
  bankAlias?: string;
  correlationId: string;
  /** Intent TTL in seconds (default 900). */
  ttlSeconds?: number;
  /** Optional template override (defaults to NAPAS compact). */
  template?: string;
}

/**
 * Mint (or reuse) a live PaymentIntent for an unpaid order and return the
 * VietQR presentation. Re-presenting the same order returns the same live
 * intent + content so the customer never sees two competing QRs.
 */
export async function presentPaymentForOrder(
  db: Db,
  input: PresentPaymentForOrderInput,
): Promise<PresentPaymentResult> {
  return withTransaction(db, async (trx) => {
    const order = await findOrderById(trx, input.orderId);
    if (!order) return { ok: false, error: "order not found" };
    // Only a still-pending order may present a QR. An order under
    // PAYMENT_NEEDS_REVIEW (or paid/cancelled/expired) must not mint a new one
    // (T124 — refresh-mints-second-QR finding).
    if (order.status !== "PENDING_PAYMENT") {
      return { ok: false, error: "order not payable" };
    }

    // An order past its TTL must not mint a QR even if the expiry worker has not
    // run yet — otherwise a stale QR could be paid after the reservation lapsed.
    const now = new Date();
    if (order.expiresAt !== null && new Date(order.expiresAt).getTime() <= now.getTime()) {
      return { ok: false, error: "order expired" };
    }

    // T157 / FR-006a: a local-stock order must hold a VALID active reservation
    // (bound to this order AND variant, RESERVED, not past reserved_until)
    // before any Payment Intent/VietQR is minted. Without this gate a
    // hand-inserted PENDING_PAYMENT row (or a future code path that skips
    // BuyNow) could reintroduce the multi-customer final-stock race.
    const policy = order.supplierPolicySnapshot;
    if (!requiresLocalReservation(policy)) {
      return { ok: false, error: "policy blocked" };
    }
    const hasReservation = await orderHasActiveReservation(trx, order.id, order.variantId, now);
    if (!hasReservation) {
      return { ok: false, error: "no active reservation" };
    }

    // Reuse the live intent if one already exists (double-tap / reopen).
    const existing = await findLiveIntentByOrder(trx, order.id);
    if (existing) {
      const presentation = presentPayment({
        bankBin: input.bankBin,
        accountNumber: input.beneficiaryAccountNumber,
        accountName: input.accountName,
        amountVnd: existing.amountVnd,
        transferContent: existing.transferContent,
        orderNumber: order.orderNumber,
        expiresAt: existing.expiresAt,
        ...(input.bankName !== undefined ? { bankName: input.bankName } : {}),
        ...(input.bankAlias !== undefined ? { bankAlias: input.bankAlias } : {}),
        ...(input.template !== undefined ? { template: input.template } : {}),
      });
      return { ok: true, intentId: existing.id, presentation };
    }

    // Fresh intent: unique transfer content derived from the order number so
    // the customer can also type it, and so content→intent is deterministic.
    const amountVnd = Number(order.priceVnd);
    if (!Number.isInteger(amountVnd) || amountVnd <= 0) {
      return { ok: false, error: "order amount is not a positive integer VND" };
    }
    const ttlSeconds = input.ttlSeconds ?? 900;
    const expiresAt =
      order.expiresAt !== null
        ? new Date(order.expiresAt)
        : new Date(Date.now() + ttlSeconds * 1000);
    // Content: strip non-alnum from the order number and keep it short (EMVCo ≤25).
    const transferContent = order.orderNumber.replace(/[^A-Za-z0-9]/g, "").slice(0, 25);
    const intentId = newId();

    const inserted = await insertPresentedIntent(trx, {
      id: intentId,
      orderId: order.id,
      amountVnd,
      merchantAccountId: input.merchantAccountId,
      transferContent,
      expiresAt,
    });
    if (!inserted) {
      // ON CONFLICT waits for its winner, then this fresh READ COMMITTED
      // statement accepts only the winner for this exact Order. A collision on
      // transfer_content owned by another Order is not swallowed.
      const raced = await findLiveIntentByOrder(trx, order.id);
      if (!raced) {
        throw new Error("payment-intent uniqueness conflict did not belong to this order");
      }
      const presentation = presentPayment({
        bankBin: input.bankBin,
        accountNumber: input.beneficiaryAccountNumber,
        accountName: input.accountName,
        amountVnd: raced.amountVnd,
        transferContent: raced.transferContent,
        orderNumber: order.orderNumber,
        expiresAt: raced.expiresAt,
        ...(input.bankName !== undefined ? { bankName: input.bankName } : {}),
        ...(input.bankAlias !== undefined ? { bankAlias: input.bankAlias } : {}),
        ...(input.template !== undefined ? { template: input.template } : {}),
      });
      return { ok: true, intentId: raced.id, presentation };
    }

    // Emit PaymentIntentPresented (dedupe: intent id + version 1 + type).
    await enqueueOutboxEvent(trx, {
      id: newId(),
      aggregateType: "PaymentIntent",
      aggregateId: intentId,
      aggregateVersion: 1,
      eventType: "PaymentIntentPresented",
      payloadRedacted: {
        intentId,
        orderId: order.id,
        amountVnd,
        correlationId: input.correlationId,
      },
    });

    const presentation = presentPayment({
      bankBin: input.bankBin,
      accountNumber: input.beneficiaryAccountNumber,
      accountName: input.accountName,
      amountVnd,
      transferContent,
      orderNumber: order.orderNumber,
      expiresAt,
      ...(input.bankName !== undefined ? { bankName: input.bankName } : {}),
      ...(input.bankAlias !== undefined ? { bankAlias: input.bankAlias } : {}),
      ...(input.template !== undefined ? { template: input.template } : {}),
    });
    return { ok: true, intentId, presentation };
  });
}

const SCHEMA_VERSION = "sepay.v1";
const SIGNATURE_STATUS = "VERIFIED";

export async function applyPaymentEvidence(
  db: Db,
  evidence: VerifiedSePayEvidence,
  now: Date = new Date(),
): Promise<ApplyEvidenceResult> {
  if (!isVerifiedSePayEvidence(evidence)) {
    return { ok: false, error: "unverified payment evidence" };
  }
  const transactionMs = evidence.transactedAt.getTime();
  if (
    !Number.isFinite(transactionMs) ||
    !Number.isFinite(now.getTime()) ||
    transactionMs > now.getTime() + LATE_PAYMENT_SKEW_MS
  ) {
    return { ok: false, error: "invalid transaction time" };
  }
  return withTransaction(db, async (trx) => {
    // 1. Dedupe evidence by provider transaction id.
    const bankTxn = await insertBankTransactionIfNew(
      trx,
      evidence,
      SIGNATURE_STATUS,
      SCHEMA_VERSION,
    );
    if (bankTxn.kind === "DUPLICATE") {
      // Replay of already-processed evidence — no further side effects.
      return { ok: true, kind: "ALREADY_APPLIED" };
    }
    if (bankTxn.kind === "MUTATION") {
      const discrepancyId = await insertDiscrepancy(trx, {
        type: "REFERENCE_COLLISION",
        bankTransactionId: bankTxn.id,
        paymentIntentId: null,
        orderId: null,
        reason: "provider transaction id replayed with a different verified fingerprint",
        owner: "payments",
      });
      return {
        ok: true,
        kind: "DISCREPANCY",
        type: "REFERENCE_COLLISION",
        discrepancyId,
      };
    }
    const bankTxnId = bankTxn.id;

    // 2. Resolve the intent, then lock Order -> Intent in the same order used
    // by cancel/expiry. This makes settlement and cancellation converge without
    // stale-version exceptions or deadlocks.
    const matchKey =
      (evidence.structuredCode ?? evidence.content ?? evidence.reference)?.trim() ?? "";
    const candidate = matchKey.length > 0 ? await findIntentByContent(trx, matchKey) : null;
    const lockedOrder = candidate ? await findOrderByIdForUpdate(trx, candidate.orderId) : null;
    const intent =
      candidate && lockedOrder ? await findIntentByIdForUpdate(trx, candidate.id) : candidate;
    const decision = decideMatch(evidence, intent, now);

    if (decision.kind === "SETTLE") {
      if (!intent) {
        // decideMatch only returns SETTLE when an intent is present, but keep
        // the branch for type narrowing under exactOptionalPropertyTypes.
        return { ok: false, error: "settle without intent" };
      }

      const order = lockedOrder ?? (await findOrderByIdForUpdate(trx, decision.orderId));
      if (!order) {
        return { ok: false, error: "order missing for settled intent" };
      }

      // Projection decides whether OrderPaid is legal. Money for a cancelled /
      // expired / otherwise dead order MUST NOT emit OrderPaid — it becomes a
      // discrepancy so ops can refund manually (T123/T128).
      const projection = projectSettlement(order.status);
      if (projection.kind === "MONEY_FOR_DEAD_ORDER") {
        const discrepancyId = await insertDiscrepancy(trx, {
          type: "UNMATCHED",
          bankTransactionId: bankTxnId,
          paymentIntentId: intent.id,
          orderId: order.id,
          reason: `money arrived for non-payable order status=${order.status}`,
          owner: "payments",
        });
        // Intent is already non-live after cancel/expire void, but if a race
        // left it live, flag it under review so it cannot settle later.
        if (intent.status === "CREATED" || intent.status === "PRESENTED") {
          await flagIntentNeedsReview(trx, intent.id, intent.version);
        }
        return {
          ok: true,
          kind: "DISCREPANCY",
          type: "UNMATCHED",
          discrepancyId,
        };
      }

      // 3a. Settle path: allocation + intent + (optional) order + outbox.
      await insertSettledAllocation(trx, {
        bankTransactionId: bankTxnId,
        paymentIntentId: decision.intentId,
        allocatedAmountVnd: evidence.amountVnd,
        decisionCode: "EXACT_MATCH",
        correlationId: evidence.correlationId,
      });

      const intentVersion = await settleIntent(trx, decision.intentId, intent.version);

      // PaymentSettled outbox (dedupe: payment_intent + new version + type).
      await enqueueOutboxEvent(trx, {
        id: newId(),
        aggregateType: "PaymentIntent",
        aggregateId: decision.intentId,
        aggregateVersion: intentVersion,
        eventType: "PaymentSettled",
        payloadRedacted: {
          intentId: decision.intentId,
          orderId: decision.orderId,
          bankTransactionId: bankTxnId,
          amountVnd: evidence.amountVnd,
          correlationId: evidence.correlationId,
        },
      });

      // OrderPaid is emitted ONLY on the payable path. Already-paid is
      // idempotent (no second event) — the unique outbox key would also reject
      // a replay, but we never enqueue a second one.
      if (projection.kind === "SETTLE_AND_PAY") {
        const paid = await transitionOrder(
          trx,
          order,
          "PAID",
          "PAYMENT_SETTLED",
          evidence.correlationId,
          {
            type: "SYSTEM",
            id: "payments",
          },
        );
        await enqueueOutboxEvent(trx, {
          id: newId(),
          aggregateType: "Order",
          aggregateId: decision.orderId,
          aggregateVersion: paid.version,
          eventType: "OrderPaid",
          payloadRedacted: {
            orderId: decision.orderId,
            intentId: decision.intentId,
            correlationId: evidence.correlationId,
          },
        });
      }

      return {
        ok: true,
        kind: "SETTLED",
        intentId: decision.intentId,
        orderId: decision.orderId,
        bankTransactionId: bankTxnId,
      };
    }

    // 3b. Discrepancy path.
    const discrepancyId = await insertDiscrepancy(trx, {
      type: decision.type,
      bankTransactionId: bankTxnId,
      paymentIntentId: intent?.id ?? null,
      orderId: intent?.orderId ?? null,
      reason: decision.reason,
      owner: "payments",
    });

    // Flag a live intent so operators can see it needs review; skip if the
    // intent was already non-live (expired/settled) or never existed.
    if (intent && (intent.status === "CREATED" || intent.status === "PRESENTED")) {
      const intentVersion = await flagIntentNeedsReview(trx, intent.id, intent.version);
      await enqueueOutboxEvent(trx, {
        id: newId(),
        aggregateType: "PaymentIntent",
        aggregateId: intent.id,
        aggregateVersion: intentVersion,
        eventType: "PaymentNeedsReview",
        payloadRedacted: {
          intentId: intent.id,
          orderId: intent.orderId,
          discrepancyType: decision.type,
          reason: decision.reason,
          correlationId: evidence.correlationId,
        },
      });
    }

    // Freeze the Order under review so a refresh cannot mint a second QR
    // (T124 — independent review finding: discrepancy left Order PENDING_PAYMENT).
    if (intent) {
      const order = lockedOrder ?? (await findOrderByIdForUpdate(trx, intent.orderId));
      if (order) {
        const target = projectDiscrepancyOrderStatus(order.status);
        if (target !== null) {
          await transitionOrder(trx, order, target, "PAYMENT_DISCREPANCY", evidence.correlationId, {
            type: "SYSTEM",
            id: "payments",
          });
        }
      }
    }

    return {
      ok: true,
      kind: "DISCREPANCY",
      type: decision.type,
      discrepancyId,
    };
  });
}
