import { sql } from "kysely";
import type { Db, Executor } from "../../infrastructure/db/transaction.js";
import { withTransaction } from "../../infrastructure/db/transaction.js";
import { enqueueOutboxEvent } from "../../infrastructure/outbox/repository.js";
import { insertBankTransactionIfNew } from "../payments/repository.js";
import { isVerifiedSePayEvidence, type VerifiedSePayEvidence } from "../payments/sepay-ingress.js";
import { presentPayment, type PaymentPresentation } from "../payments/vietqr.js";
import { newId } from "../../shared/ids/index.js";
import { creditWalletLedgerEntry, ensureWalletAccount } from "./ledger.js";

export type WalletTopupStatus =
  "CREATED" | "PRESENTED" | "SUCCEEDED" | "EXPIRED" | "FAILED" | "NEEDS_REVIEW";

export interface WalletTopupIntent {
  id: string;
  customerId: string;
  walletAccountId: string;
  amountVnd: bigint;
  merchantAccountId: string;
  transferContent: string;
  status: WalletTopupStatus;
  expiresAt: Date;
  version: number;
}

export type TopupMatchDecision =
  | { kind: "SETTLE" }
  | {
      kind: "DISCREPANCY";
      reason:
        | "UNMATCHED"
        | "WRONG_ACCOUNT"
        | "UNDERPAYMENT"
        | "OVERPAYMENT"
        | "LATE_PAYMENT"
        | "NOT_LIVE";
    };

export function decideTopupMatch(
  evidence: Pick<
    VerifiedSePayEvidence,
    "direction" | "merchantAccountId" | "amountVnd" | "transactedAt"
  >,
  intent: Pick<
    WalletTopupIntent,
    "merchantAccountId" | "amountVnd" | "status" | "expiresAt"
  > | null,
): TopupMatchDecision {
  if (evidence.direction !== "IN" || !intent) return { kind: "DISCREPANCY", reason: "UNMATCHED" };
  if (evidence.merchantAccountId !== intent.merchantAccountId)
    return { kind: "DISCREPANCY", reason: "WRONG_ACCOUNT" };
  if (BigInt(evidence.amountVnd) < intent.amountVnd)
    return { kind: "DISCREPANCY", reason: "UNDERPAYMENT" };
  if (BigInt(evidence.amountVnd) > intent.amountVnd)
    return { kind: "DISCREPANCY", reason: "OVERPAYMENT" };
  if (intent.status !== "CREATED" && intent.status !== "PRESENTED")
    return { kind: "DISCREPANCY", reason: "NOT_LIVE" };
  if (evidence.transactedAt.getTime() > intent.expiresAt.getTime() + 60_000)
    return { kind: "DISCREPANCY", reason: "LATE_PAYMENT" };
  return { kind: "SETTLE" };
}

export async function presentWalletTopup(input: {
  db: Db;
  customerId: string;
  amountVnd: bigint;
  merchantAccountId: string;
  beneficiaryAccountNumber: string;
  bankBin: string;
  accountName: string;
  bankName?: string;
  bankAlias?: string;
  correlationId: string;
  ttlSeconds?: number;
}): Promise<
  { ok: true; intentId: string; presentation: PaymentPresentation } | { ok: false; error: string }
> {
  if (input.amountVnd <= 0n || input.amountVnd > BigInt(Number.MAX_SAFE_INTEGER))
    return { ok: false, error: "invalid amount" };

  return withTransaction(input.db, async (trx) => {
    const account = await ensureWalletAccount(trx, input.customerId);
    if (!account) return { ok: false, error: "customer not found" };
    await sql`
      update wallet_topup_intent set status = 'EXPIRED', version = version + 1
      where customer_id = ${input.customerId} and status in ('CREATED','PRESENTED')
        and expires_at <= now()
    `.execute(trx);
    const existing = await findLiveTopupByCustomer(trx, input.customerId);
    if (existing) return { ok: true, intentId: existing.id, presentation: render(input, existing) };

    const id = newId();
    const expiresAt = new Date(Date.now() + (input.ttlSeconds ?? 900) * 1000);
    const transferContent = `NAPVI${id.slice(-12)}`.toUpperCase();
    await sql`
      insert into wallet_topup_intent
        (id, customer_id, wallet_account_id, amount_vnd, merchant_account_id, transfer_content, status, expires_at, presented_at)
      values
        (${id}, ${input.customerId}, ${account.id}, ${input.amountVnd.toString()}, ${input.merchantAccountId}, ${transferContent}, 'PRESENTED', ${expiresAt.toISOString()}, now())
    `.execute(trx);
    const intent: WalletTopupIntent = {
      id,
      customerId: input.customerId,
      walletAccountId: account.id,
      amountVnd: input.amountVnd,
      merchantAccountId: input.merchantAccountId,
      transferContent,
      status: "PRESENTED",
      expiresAt,
      version: 1,
    };
    await enqueueOutboxEvent(trx, {
      id: newId(),
      aggregateType: "WalletTopupIntent",
      aggregateId: id,
      aggregateVersion: 1,
      eventType: "WalletTopupPresented",
      payloadRedacted: {
        intentId: id,
        customerId: input.customerId,
        amountVnd: Number(input.amountVnd),
        correlationId: input.correlationId,
      },
    });
    return { ok: true, intentId: id, presentation: render(input, intent) };
  });
}

export async function applyWalletTopupEvidence(
  db: Db,
  evidence: VerifiedSePayEvidence,
): Promise<
  { ok: true; kind: "CREDITED" | "ALREADY_APPLIED" | "NEEDS_REVIEW" } | { ok: false; error: string }
> {
  if (!isVerifiedSePayEvidence(evidence))
    return { ok: false, error: "unverified payment evidence" };
  return withTransaction(db, async (trx) => {
    const bankTxn = await insertBankTransactionIfNew(trx, evidence, "VERIFIED", "sepay.v1");
    if (bankTxn.kind === "DUPLICATE") return { ok: true, kind: "ALREADY_APPLIED" };
    if (bankTxn.kind === "MUTATION") return { ok: true, kind: "NEEDS_REVIEW" };

    const key = (evidence.structuredCode ?? evidence.content ?? evidence.reference)?.trim() ?? "";
    const intent = key ? await findTopupByContentForUpdate(trx, key) : null;
    const decision = decideTopupMatch(evidence, intent);
    if (decision.kind !== "SETTLE" || !intent) {
      if (intent) await markTopupNeedsReview(trx, intent.id, intent.version);
      return { ok: true, kind: "NEEDS_REVIEW" };
    }

    await sql`
      update wallet_topup_intent
      set status = 'SUCCEEDED', settled_at = now(), version = version + 1
      where id = ${intent.id} and version = ${intent.version}
    `.execute(trx);
    const ledger = await creditWalletLedgerEntry(trx, {
      customerId: intent.customerId,
      amountVnd: intent.amountVnd,
      idempotencyKey: `topup:${intent.id}:${evidence.providerTransactionId}`,
      correlationId: evidence.correlationId,
      reason: "sepay wallet topup",
    });
    if (!ledger.ok) throw new Error("wallet topup ledger mutation failed");
    await enqueueOutboxEvent(trx, {
      id: newId(),
      aggregateType: "WalletTopupIntent",
      aggregateId: intent.id,
      aggregateVersion: intent.version + 1,
      eventType: "WalletTopupCredited",
      payloadRedacted: {
        intentId: intent.id,
        customerId: intent.customerId,
        amountVnd: Number(intent.amountVnd),
        correlationId: evidence.correlationId,
      },
    });
    return { ok: true, kind: ledger.inserted ? "CREDITED" : "ALREADY_APPLIED" };
  });
}

function render(
  input: {
    bankBin: string;
    beneficiaryAccountNumber: string;
    accountName: string;
    bankName?: string;
    bankAlias?: string;
  },
  intent: WalletTopupIntent,
): PaymentPresentation {
  return presentPayment({
    bankBin: input.bankBin,
    accountNumber: input.beneficiaryAccountNumber,
    accountName: input.accountName,
    amountVnd: Number(intent.amountVnd),
    transferContent: intent.transferContent,
    orderNumber: `TOPUP-${intent.id.slice(-8)}`,
    expiresAt: intent.expiresAt,
    ...(input.bankName !== undefined ? { bankName: input.bankName } : {}),
    ...(input.bankAlias !== undefined ? { bankAlias: input.bankAlias } : {}),
  });
}

async function findLiveTopupByCustomer(
  exec: Executor,
  customerId: string,
): Promise<WalletTopupIntent | null> {
  const result = await sql<TopupRow>`
    select * from wallet_topup_intent
    where customer_id = ${customerId} and status in ('CREATED','PRESENTED')
    order by created_at desc
    limit 1
  `.execute(exec);
  return result.rows[0] ? mapTopup(result.rows[0]) : null;
}

async function findTopupByContentForUpdate(
  exec: Executor,
  content: string,
): Promise<WalletTopupIntent | null> {
  const result = await sql<TopupRow>`
    select * from wallet_topup_intent
    where transfer_content = ${content}
    order by created_at desc
    limit 1
    for update
  `.execute(exec);
  return result.rows[0] ? mapTopup(result.rows[0]) : null;
}

async function markTopupNeedsReview(exec: Executor, id: string, version: number): Promise<void> {
  await sql`
    update wallet_topup_intent
    set status = 'NEEDS_REVIEW', version = version + 1
    where id = ${id} and version = ${version}
  `.execute(exec);
}

type TopupRow = {
  id: string;
  customer_id: string;
  wallet_account_id: string;
  amount_vnd: string;
  merchant_account_id: string;
  transfer_content: string;
  status: WalletTopupStatus;
  expires_at: Date | string;
  version: number;
};

function mapTopup(row: TopupRow): WalletTopupIntent {
  return {
    id: row.id,
    customerId: row.customer_id,
    walletAccountId: row.wallet_account_id,
    amountVnd: BigInt(row.amount_vnd),
    merchantAccountId: row.merchant_account_id,
    transferContent: row.transfer_content,
    status: row.status,
    expiresAt: row.expires_at instanceof Date ? row.expires_at : new Date(row.expires_at),
    version: row.version,
  };
}
