import type { Db, Trx } from "../../infrastructure/db/transaction.js";
import { withTransaction } from "../../infrastructure/db/transaction.js";
import { enqueueOutboxEvent } from "../../infrastructure/outbox/repository.js";
import { newId } from "../../shared/ids/index.js";
import { findOrderById, findOrderByIdForUpdate, transitionOrder } from "../commerce/repository.js";
import {
  confirmPreorderDepositInTransaction,
  finalizePreorderInTransaction,
  lockPreorderForSettlement,
  preorderPayableLeg,
  recordPreorderPaymentIntent,
  type PreorderSettlementTarget,
} from "../commerce/preorder.js";
import { isSupportedCatalogRoute } from "../catalog/domain.js";
import { orderHasActiveReservation } from "../digital-goods/repository.js";
import { isVerifiedSePayEvidence, type VerifiedSePayEvidence } from "./sepay-ingress.js";
import { decideMatch, LATE_PAYMENT_SKEW_MS, type MatchableIntent } from "./domain.js";
import { projectDiscrepancyOrderStatus, projectSettlement } from "./projection.js";
import {
  expireIntent,
  findIntentByContent,
  findIntentByIdForUpdate,
  findLiveIntentByOrder,
  findLiveIntentByPreorderLeg,
  flagIntentNeedsReview,
  insertBankTransactionIfNew,
  insertDiscrepancy,
  insertPresentedIntent,
  insertSettledAllocation,
  settleIntent,
} from "./repository.js";
import { presentPayment, type PaymentPresentation } from "./vietqr.js";
import { generateOrderPaymentCode, generatePreorderPaymentCode } from "./payment-code.js";

/**
 * Payment settlement service (T053, T128).
 *
 * Two write paths:
 *  - `presentPaymentForOrder` creates (or reuses) a live PaymentIntent and
 *    returns the VietQR presentation view. Initiation only — never settles.
 *    Refuses to mint a QR for an order under PAYMENT_NEEDS_REVIEW.
 *  - `applyPaymentEvidence` is the single write path for verified SePay (or
 *    reconciliation) evidence. Safe under at-least-once delivery:
 *      1. resolve the evidence to ONE canonical bank_transaction row (provider
 *         alias → same provider id → cross-source correlation key);
 *      2. a replay short-circuits as already-applied; an ambiguous cross-source
 *         correlation is stored and recorded for review, never merged;
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
  | {
      ok: true;
      kind: "SETTLED";
      intentId: string;
      /** Owning Order; null for a preorder deposit (no Order exists yet). */
      orderId: string | null;
      bankTransactionId: string;
    }
  | { ok: true; kind: "ALREADY_APPLIED" }
  | {
      /**
       * Two canonical rows already share this transfer's cross-source
       * correlation key, so the arrival could not be attributed to either one.
       * It is stored and recorded for review — never merged, never guessed.
       */
      ok: true;
      kind: "AMBIGUOUS_CORRELATION";
      discrepancyId: string;
      candidateIds: string[];
    }
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

    // T157 / FR-006a: every payable order must still match a supported route
    // and pass its fulfillment readiness check before any Payment Intent/VietQR
    // is minted. This keeps supplier/file/service orders payable while still
    // blocking legacy unsupported policies and hand-inserted local-stock rows
    // that skipped BuyNow's durable reservation.
    const hasPayableRoute = isSupportedCatalogRoute({
      stockPolicy: order.supplierPolicySnapshot,
      fulfillmentType: order.fulfillmentType,
    });
    if (!hasPayableRoute) {
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
    // Direct order payments use their own namespace so wallet and order
    // evidence cannot share a payment code family.
    const transferContent = generateOrderPaymentCode(order.orderNumber);
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

export interface PresentPreorderPaymentInput {
  /**
   * Server-derived owner of the reservation. Required: the owner predicate runs
   * inside the locked read, so a foreign reservation reads exactly like a missing
   * one and a leaked reservation id alone authorises nothing.
   */
  customerId: string;
  reservationId: string;
  /** Deposit (queue hold) or the remaining balance owed once stock is allocated. */
  leg: "DEPOSIT" | "BALANCE";
  merchantAccountId: string;
  /** VietQR beneficiary account number; intentionally distinct from SePay identity. */
  beneficiaryAccountNumber: string;
  bankBin: string;
  accountName: string;
  bankName?: string;
  bankAlias?: string;
  template?: string;
  correlationId: string;
  /** Intent TTL for the deposit leg in seconds (default 3600). */
  ttlSeconds?: number;
}

export type PresentPreorderPaymentResult =
  | {
      ok: true;
      intentId: string;
      presentation: PaymentPresentation;
      productName: string;
      variantName: string;
    }
  | { ok: false; error: "NOT_FOUND" | "NOT_PAYABLE" | "AMOUNT_INVALID" };

/** Bounded deposit-QR window: long enough to open a bank app, short enough to free the queue. */
const MIN_PREORDER_TTL_SECONDS = 300;
const MAX_PREORDER_TTL_SECONDS = 6 * 3600;
const DEFAULT_PREORDER_TTL_SECONDS = 3600;

/**
 * Mint (or reuse) the live PaymentIntent for one preorder leg and return the
 * VietQR presentation. Re-opening the same leg returns the same live intent and
 * payment code, so the customer never sees two competing QRs for one payment —
 * and a stale QR from a previous window is closed before a fresh one is minted
 * (a transfer against a closed intent becomes an ops discrepancy, never a
 * silent settlement).
 */
export async function presentPreorderPayment(
  db: Db,
  input: PresentPreorderPaymentInput,
): Promise<PresentPreorderPaymentResult> {
  return withTransaction(db, async (trx) => {
    const reservation = await lockPreorderForSettlement(trx, input.reservationId, input.customerId);
    if (!reservation) return { ok: false, error: "NOT_FOUND" };
    if (preorderPayableLeg(reservation.status) !== input.leg) {
      return { ok: false, error: "NOT_PAYABLE" };
    }

    const amountVnd = input.leg === "DEPOSIT" ? reservation.depositVnd : reservation.balanceVnd;
    if (!Number.isInteger(amountVnd) || amountVnd <= 0) {
      return { ok: false, error: "AMOUNT_INVALID" };
    }

    const presentation = (fields: {
      amountVnd: number;
      transferContent: string;
      expiresAt: Date;
    }): PaymentPresentation =>
      presentPayment({
        bankBin: input.bankBin,
        accountNumber: input.beneficiaryAccountNumber,
        accountName: input.accountName,
        amountVnd: fields.amountVnd,
        transferContent: fields.transferContent,
        // A preorder has no public order number; the payment code IS the reference
        // the customer types and support can match.
        orderNumber: fields.transferContent,
        expiresAt: fields.expiresAt,
        ...(input.bankName !== undefined ? { bankName: input.bankName } : {}),
        ...(input.bankAlias !== undefined ? { bankAlias: input.bankAlias } : {}),
        ...(input.template !== undefined ? { template: input.template } : {}),
      });

    const now = new Date();
    const existing = await findLiveIntentByPreorderLeg(trx, reservation.id, input.leg);
    if (existing && existing.expiresAt.getTime() > now.getTime()) {
      return {
        ok: true,
        intentId: existing.id,
        presentation: presentation({
          amountVnd: existing.amountVnd,
          transferContent: existing.transferContent,
          expiresAt: existing.expiresAt,
        }),
        productName: reservation.productName,
        variantName: reservation.variantName,
      };
    }
    if (existing) await expireIntent(trx, existing.id, existing.version);

    const ttlSeconds = Math.min(
      MAX_PREORDER_TTL_SECONDS,
      Math.max(
        MIN_PREORDER_TTL_SECONDS,
        Math.trunc(input.ttlSeconds ?? DEFAULT_PREORDER_TTL_SECONDS),
      ),
    );
    // The balance leg is bound to the deadline the customer was told: paying
    // after `balance_due_until` must not settle, so the QR must not outlive it.
    const expiresAt =
      input.leg === "BALANCE" &&
      reservation.balanceDueUntil !== null &&
      reservation.balanceDueUntil.getTime() > now.getTime()
        ? reservation.balanceDueUntil
        : new Date(now.getTime() + ttlSeconds * 1000);
    const transferContent = generatePreorderPaymentCode(reservation.id, input.leg);
    const intentId = newId();

    const inserted = await insertPresentedIntent(trx, {
      id: intentId,
      orderId: null,
      preorderId: reservation.id,
      kind: input.leg,
      amountVnd,
      merchantAccountId: input.merchantAccountId,
      transferContent,
      expiresAt,
    });
    let liveIntentId: string = intentId;
    if (!inserted) {
      // A concurrent presentation won. Only a live intent for THIS reservation
      // and THIS leg is acceptable; anything else is a real uniqueness break.
      const raced = await findLiveIntentByPreorderLeg(trx, reservation.id, input.leg);
      if (!raced) {
        throw new Error("preorder payment-intent conflict did not belong to this reservation");
      }
      liveIntentId = raced.id;
    }

    await recordPreorderPaymentIntent(trx, {
      reservationId: reservation.id,
      leg: input.leg,
      paymentIntentId: liveIntentId,
    });

    if (inserted) {
      await enqueueOutboxEvent(trx, {
        id: newId(),
        aggregateType: "PaymentIntent",
        aggregateId: intentId,
        aggregateVersion: 1,
        eventType: "PaymentIntentPresented",
        payloadRedacted: {
          intentId,
          preorderId: reservation.id,
          leg: input.leg,
          amountVnd,
          correlationId: input.correlationId,
        },
      });
    }

    return {
      ok: true,
      intentId: liveIntentId,
      presentation: presentation({ amountVnd, transferContent, expiresAt }),
      productName: reservation.productName,
      variantName: reservation.variantName,
    };
  });
}

const SCHEMA_VERSION = "sepay.v1";
const SIGNATURE_STATUS = "VERIFIED";

/**
 * Settle one preorder leg against its reservation.
 *
 * Runs with the reservation row already locked, so the payable check here is
 * authoritative. All money-safety outcomes are explicit:
 *  - reservation still payable → allocation + intent SUCCEEDED + PaymentSettled,
 *    then the domain transition (deposit confirmed / purchase finalised + OrderPaid);
 *  - reservation no longer payable (forfeited, cancelled, already settled) →
 *    ops discrepancy, never a silent settle and never a silent drop.
 * A replay of the same evidence never reaches here (bank_transaction dedupe), and
 * a second distinct transfer against a settled intent is a `decideMatch`
 * discrepancy, so no leg can be paid twice.
 */
async function settlePreorderLeg(
  trx: Trx,
  input: {
    intent: MatchableIntent & { version: number };
    reservation: PreorderSettlementTarget | null;
    evidence: VerifiedSePayEvidence;
    bankTransactionId: string;
  },
): Promise<ApplyEvidenceResult> {
  const { intent, reservation, evidence } = input;
  const leg = intent.kind === "DEPOSIT" || intent.kind === "BALANCE" ? intent.kind : null;
  const payable =
    leg !== null &&
    reservation !== null &&
    (leg === "DEPOSIT"
      ? reservation.status === "WAITING_DEPOSIT"
      : preorderPayableLeg(reservation.status) === "BALANCE");

  if (!payable) {
    const discrepancyId = await insertDiscrepancy(trx, {
      type: "UNMATCHED",
      bankTransactionId: input.bankTransactionId,
      paymentIntentId: intent.id,
      orderId: null,
      reason: `money arrived for non-payable preorder leg=${leg ?? "UNKNOWN"} status=${reservation?.status ?? "MISSING"}`,
      owner: "payments",
    });
    // A live intent is flagged so it cannot settle later; an already non-live
    // intent (voided at cancel/forfeit) needs no flag.
    if (intent.status === "CREATED" || intent.status === "PRESENTED") {
      await flagIntentNeedsReview(trx, intent.id, intent.version);
    }
    return { ok: true, kind: "DISCREPANCY", type: "UNMATCHED", discrepancyId };
  }

  await insertSettledAllocation(trx, {
    bankTransactionId: input.bankTransactionId,
    paymentIntentId: intent.id,
    allocatedAmountVnd: evidence.amountVnd,
    decisionCode: "EXACT_MATCH",
    correlationId: evidence.correlationId,
  });

  const intentVersion = await settleIntent(trx, intent.id, intent.version);

  await enqueueOutboxEvent(trx, {
    id: newId(),
    aggregateType: "PaymentIntent",
    aggregateId: intent.id,
    aggregateVersion: intentVersion,
    eventType: "PaymentSettled",
    payloadRedacted: {
      intentId: intent.id,
      preorderId: reservation!.id,
      leg,
      bankTransactionId: input.bankTransactionId,
      amountVnd: evidence.amountVnd,
      correlationId: evidence.correlationId,
    },
  });

  let orderId: string | null = null;
  if (leg === "DEPOSIT") {
    const confirmed = await confirmPreorderDepositInTransaction(trx, {
      reservationId: reservation!.id,
      paymentIntentId: intent.id,
    });
    if (!confirmed.ok) {
      // Unreachable: payability was checked under the reservation lock. Throw so
      // the whole transaction rolls back instead of recording money that changed
      // nothing.
      throw new Error(`preorder deposit did not confirm: ${confirmed.code}`);
    }
  } else {
    const settled = await finalizePreorderInTransaction(trx, {
      reservationId: reservation!.id,
      paymentIntentId: intent.id,
      correlationId: evidence.correlationId,
    });
    if (!settled.ok) {
      throw new Error(`preorder balance did not settle: ${settled.code}`);
    }
    orderId = settled.orderId;
  }

  return {
    ok: true,
    kind: "SETTLED",
    intentId: intent.id,
    orderId,
    bankTransactionId: input.bankTransactionId,
  };
}

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
    if (bankTxn.kind === "AMBIGUOUS") {
      // Two canonical rows already share this physical transfer's correlation
      // key, so this arrival cannot be attributed to one of them without
      // guessing. It is stored (no evidence is dropped) and recorded for a human.
      // The matcher MUST NOT run: a sibling row already settled the intent, so
      // matching would report a false `UNMATCHED` / "intent not settleable" and
      // turn settled revenue into an operator incident.
      const discrepancyId = await insertDiscrepancy(trx, {
        type: "AMBIGUOUS_CORRELATION",
        bankTransactionId: bankTxn.id,
        paymentIntentId: null,
        orderId: null,
        reason: `ambiguous cross-source correlation; candidates ${bankTxn.candidateIds.join(", ")}`,
        owner: "payments",
      });
      return {
        ok: true,
        kind: "AMBIGUOUS_CORRELATION",
        discrepancyId,
        candidateIds: bankTxn.candidateIds,
      };
    }
    const bankTxnId = bankTxn.id;

    // 2. Resolve the intent, then lock its owner before the intent itself
    // (Order -> Intent, reservation -> Intent) in the same order used by
    // cancel/expiry/hold-release. Settlement and cancellation therefore converge
    // without stale-version exceptions or deadlocks.
    const matchKey =
      (evidence.structuredCode ?? evidence.content ?? evidence.reference)?.trim() ?? "";
    const candidate = matchKey.length > 0 ? await findIntentByContent(trx, matchKey) : null;
    const lockedPreorder =
      candidate?.preorderId !== null && candidate?.preorderId !== undefined
        ? await lockPreorderForSettlement(trx, candidate.preorderId)
        : null;
    const lockedOrder = candidate?.orderId
      ? await findOrderByIdForUpdate(trx, candidate.orderId)
      : null;
    const intent =
      candidate && (lockedPreorder || lockedOrder)
        ? await findIntentByIdForUpdate(trx, candidate.id)
        : candidate;
    const decision = decideMatch(evidence, intent, now);

    if (decision.kind === "SETTLE") {
      if (!intent) {
        // decideMatch only returns SETTLE when an intent is present, but keep
        // the branch for type narrowing under exactOptionalPropertyTypes.
        return { ok: false, error: "settle without intent" };
      }

      // Preorder deposit / balance legs settle against a reservation, never an
      // Order: until the reservation is paid in full there is nothing to deliver.
      if (decision.preorderId) {
        return settlePreorderLeg(trx, {
          intent,
          reservation: lockedPreorder,
          evidence,
          bankTransactionId: bankTxnId,
        });
      }

      const order = lockedOrder ?? (await findOrderByIdForUpdate(trx, decision.orderId!));
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
          aggregateId: order.id,
          aggregateVersion: paid.version,
          eventType: "OrderPaid",
          payloadRedacted: {
            orderId: order.id,
            intentId: decision.intentId,
            correlationId: evidence.correlationId,
          },
        });
      }

      return {
        ok: true,
        kind: "SETTLED",
        intentId: decision.intentId,
        orderId: order.id,
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
    // A preorder intent has no Order: hold expiry / shop cancel already closed the
    // reservation's live intents, so there is no Order state to freeze.
    if (intent?.orderId) {
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
