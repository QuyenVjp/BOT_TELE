import { sql } from "kysely";
import type { Executor } from "../../infrastructure/db/transaction.js";
import { newId } from "../../shared/ids/index.js";
import { nextVersion, assertVersionUpdated } from "../../infrastructure/db/version.js";
import type {
  DiscrepancyType,
  MatchableIntent,
  PaymentEvidence,
  PaymentIntentStatus,
} from "./domain.js";

/**
 * Payment persistence + unique-effect conflict mapping (T049).
 *
 * Every write runs through the typed transaction boundary so the bank
 * transaction row, the allocation, the intent state change, and any outbox
 * event commit together. The unique keys carry the exactly-once guarantee:
 *   - bank_transaction (provider, provider_transaction_id) → evidence dedupe
 *   - payment_allocation (bank_transaction_id) where SETTLED → one settlement
 *   - payment_intent (transfer_content) where live → one live intent per content
 */

/**
 * Insert verified evidence as a bank transaction, deduplicating on the provider
 * transaction id. Returns the new row id, or `null` when the evidence was
 * already recorded (a replay) — the caller then short-circuits without
 * re-settling.
 */
export async function insertBankTransactionIfNew(
  exec: Executor,
  evidence: PaymentEvidence,
  signatureStatus: string,
  schemaVersion: string,
): Promise<
  | { kind: "INSERTED"; id: string }
  | { kind: "DUPLICATE"; id: string }
  | { kind: "MUTATION"; id: string }
> {
  const id = newId();
  const result = await sql<{ id: string }>`
    insert into bank_transaction
      (id, provider, provider_transaction_id, direction, merchant_account_id,
       amount_vnd, content, reference, transacted_at, raw_hash, signature_status, schema_version)
    values
      (${id}, ${evidence.provider}, ${evidence.providerTransactionId}, ${evidence.direction},
       ${evidence.merchantAccountId}, ${evidence.amountVnd}, ${evidence.content},
       ${evidence.reference}, ${evidence.transactedAt.toISOString()}, ${evidence.rawHash},
       ${signatureStatus}, ${schemaVersion})
    on conflict (provider, provider_transaction_id) do nothing
    returning id
  `.execute(exec);
  if (result.rows[0]) return { kind: "INSERTED", id: result.rows[0].id };
  const winner = await sql<{
    id: string;
    direction: string;
    merchant_account_id: string;
    amount_vnd: string;
    content: string | null;
    raw_hash: string;
  }>`
    select id, direction, merchant_account_id, amount_vnd, content, raw_hash
    from bank_transaction
    where provider = ${evidence.provider}
      and provider_transaction_id = ${evidence.providerTransactionId}
  `.execute(exec);
  const row = winner.rows[0];
  if (!row) throw new Error("Bank transaction conflict winner was not found");
  const same =
    row.direction === evidence.direction &&
    row.merchant_account_id === evidence.merchantAccountId &&
    Number(row.amount_vnd) === evidence.amountVnd &&
    row.content === evidence.content &&
    row.raw_hash === evidence.rawHash;
  return same ? { kind: "DUPLICATE", id: row.id } : { kind: "MUTATION", id: row.id };
}

interface IntentRow {
  id: string;
  order_id: string | null;
  preorder_id: string | null;
  kind: "ORDER" | "TOPUP" | "DEPOSIT" | "BALANCE";
  amount_vnd: string;
  merchant_account_id: string;
  transfer_content: string;
  status: PaymentIntentStatus;
  expires_at: Date | string;
  version: number;
}

const INTENT_COLUMNS = sql`
  id, order_id, preorder_id, kind, amount_vnd, merchant_account_id, transfer_content,
  status, expires_at, version
`;

function toMatchableIntent(row: IntentRow): MatchableIntent & { version: number } {
  const expires = row.expires_at instanceof Date ? row.expires_at : new Date(row.expires_at);
  return {
    id: row.id,
    orderId: row.order_id,
    preorderId: row.preorder_id,
    kind: row.kind,
    amountVnd: Number(row.amount_vnd),
    merchantAccountId: row.merchant_account_id,
    transferContent: row.transfer_content,
    status: row.status,
    expiresAt: expires,
    version: row.version,
  };
}

/**
 * Resolve the intent a transfer content points at. Returns the most recent
 * intent for that content so `decideMatch` can classify late / non-live cases;
 * the live-content unique index guarantees at most one CREATED/PRESENTED row.
 */
export async function findIntentByContent(
  exec: Executor,
  content: string,
): Promise<(MatchableIntent & { version: number }) | null> {
  const result = await sql<IntentRow>`
    select ${INTENT_COLUMNS}
    from payment_intent
    where transfer_content = ${content}
    order by created_at desc
    limit 1
  `.execute(exec);
  const row = result.rows[0];
  return row ? toMatchableIntent(row) : null;
}

/** Lock the selected intent after its Order lock has been acquired. */
export async function findIntentByIdForUpdate(
  exec: Executor,
  intentId: string,
): Promise<(MatchableIntent & { version: number }) | null> {
  const result = await sql<IntentRow>`
    select ${INTENT_COLUMNS}
    from payment_intent
    where id = ${intentId}
    for update
  `.execute(exec);
  const row = result.rows[0];
  return row ? toMatchableIntent(row) : null;
}

/**
 * Return the live (CREATED/PRESENTED) intent for an order, if any. The
 * unique active-intent-per-order index guarantees at most one row, so a fresh
 * presentation can reuse it instead of minting a second QR.
 */
export async function findLiveIntentByOrder(
  exec: Executor,
  orderId: string,
): Promise<(MatchableIntent & { version: number }) | null> {
  const result = await sql<IntentRow>`
    select ${INTENT_COLUMNS}
    from payment_intent
    where order_id = ${orderId} and status in ('CREATED','PRESENTED')
    limit 1
  `.execute(exec);
  const row = result.rows[0];
  return row ? toMatchableIntent(row) : null;
}

/**
 * Return the live (CREATED/PRESENTED) intent for one preorder leg. Deposit and
 * balance are distinct legs, so a reservation may hold at most one live intent
 * per leg (partial unique index `payment_intent_active_preorder_leg_uq`).
 */
export async function findLiveIntentByPreorderLeg(
  exec: Executor,
  preorderId: string,
  kind: "DEPOSIT" | "BALANCE",
): Promise<(MatchableIntent & { version: number }) | null> {
  const result = await sql<IntentRow>`
    select ${INTENT_COLUMNS}
    from payment_intent
    where preorder_id = ${preorderId} and kind = ${kind}
      and status in ('CREATED','PRESENTED')
    limit 1
  `.execute(exec);
  const row = result.rows[0];
  return row ? toMatchableIntent(row) : null;
}

export interface InsertIntentInput {
  id: string;
  /** Owning Order, or null for a preorder deposit/balance intent. */
  orderId: string | null;
  /** Owning reservation for a preorder intent. */
  preorderId?: string | null;
  kind?: "ORDER" | "DEPOSIT" | "BALANCE";
  amountVnd: number;
  merchantAccountId: string;
  transferContent: string;
  expiresAt: Date;
}

/**
 * Insert a PRESENTED payment intent. PostgreSQL may observe either partial
 * unique index first when two identical presentations race, so the statement
 * handles the uniqueness check without aborting. The service then accepts only
 * an existing live intent for this exact Order; any other conflict is raised.
 */
export async function insertPresentedIntent(
  exec: Executor,
  input: InsertIntentInput,
): Promise<boolean> {
  const result = await sql<{ id: string }>`
    insert into payment_intent
      (id, order_id, preorder_id, kind, status, amount_vnd, merchant_account_id,
       transfer_content, expires_at, presented_at)
    values
      (${input.id}, ${input.orderId}, ${input.preorderId ?? null}, ${input.kind ?? "ORDER"},
       'PRESENTED', ${input.amountVnd}, ${input.merchantAccountId},
       ${input.transferContent}, ${input.expiresAt.toISOString()}, now())
    on conflict do nothing
    returning id
  `.execute(exec);
  return result.rows[0]?.id === input.id;
}

/** Insert a SETTLED allocation. The unique index rejects a second settlement of the same evidence. */
export async function insertSettledAllocation(
  exec: Executor,
  input: {
    bankTransactionId: string;
    paymentIntentId: string;
    allocatedAmountVnd: number;
    decisionCode: string;
    correlationId: string;
  },
): Promise<void> {
  await sql`
    insert into payment_allocation
      (id, bank_transaction_id, payment_intent_id, allocated_amount_vnd, status, decision_code, correlation_id)
    values
      (${newId()}, ${input.bankTransactionId}, ${input.paymentIntentId},
       ${input.allocatedAmountVnd}, 'SETTLED', ${input.decisionCode}, ${input.correlationId})
  `.execute(exec);
}

/** Transition an intent to SUCCEEDED, stamping settled_at. Version-guarded. */
export async function settleIntent(
  exec: Executor,
  intentId: string,
  version: number,
): Promise<number> {
  const newVer = nextVersion(version);
  const result = await sql`
    update payment_intent
    set status = 'SUCCEEDED', settled_at = now(), version = ${newVer}
    where id = ${intentId} and version = ${version}
  `.execute(exec);
  assertVersionUpdated(
    { numUpdatedRows: BigInt(result.numAffectedRows ?? 0) },
    "payment_intent",
    intentId,
    version,
  );
  return newVer;
}

/** Transition an intent to NEEDS_REVIEW (discrepancy path). Version-guarded. */
export async function flagIntentNeedsReview(
  exec: Executor,
  intentId: string,
  version: number,
): Promise<number> {
  const newVer = nextVersion(version);
  const result = await sql`
    update payment_intent
    set status = 'NEEDS_REVIEW', version = ${newVer}
    where id = ${intentId} and version = ${version}
  `.execute(exec);
  assertVersionUpdated(
    { numUpdatedRows: BigInt(result.numAffectedRows ?? 0) },
    "payment_intent",
    intentId,
    version,
  );
  return newVer;
}

/**
 * Void every live (CREATED/PRESENTED) intent for an order — used by cancel and
 * expiry so a later bank transfer cannot settle a dead order (T128).
 *
 * Idempotent: already-voided / settled intents are left alone. Returns the
 * number of rows flipped.
 */
export async function voidLiveIntentsForOrder(exec: Executor, orderId: string): Promise<number> {
  const result = await sql`
    update payment_intent
    set status = 'FAILED', version = version + 1
    where order_id = ${orderId} and status in ('CREATED', 'PRESENTED')
  `.execute(exec);
  return Number(result.numAffectedRows ?? 0);
}

/**
 * Close a live preorder intent. Used when a reservation stops being payable
 * (`FAILED` on shop cancel) or when a hold lapses (`EXPIRED` on forfeiture) so a
 * later bank transfer hits a dead intent and becomes an ops discrepancy instead
 * of settling a reservation that no longer exists.
 */
export async function voidLiveIntentsForPreorder(
  exec: Executor,
  preorderId: string,
  target: "EXPIRED" | "FAILED",
): Promise<number> {
  const result = await sql`
    update payment_intent
    set status = ${target}, version = version + 1
    where preorder_id = ${preorderId} and status in ('CREATED', 'PRESENTED')
  `.execute(exec);
  return Number(result.numAffectedRows ?? 0);
}

/**
 * Version-guarded close of one still-live intent (stale QR replaced by a fresh
 * one for the same leg). Returns the new version.
 */
export async function expireIntent(
  exec: Executor,
  intentId: string,
  version: number,
): Promise<number> {
  const newVer = nextVersion(version);
  const result = await sql`
    update payment_intent
    set status = 'EXPIRED', version = ${newVer}
    where id = ${intentId} and version = ${version} and status in ('CREATED', 'PRESENTED')
  `.execute(exec);
  assertVersionUpdated(
    { numUpdatedRows: BigInt(result.numAffectedRows ?? 0) },
    "payment_intent",
    intentId,
    version,
  );
  return newVer;
}

/** Record a typed discrepancy for manual/automated review. */
export async function insertDiscrepancy(
  exec: Executor,
  input: {
    type: DiscrepancyType;
    bankTransactionId: string | null;
    paymentIntentId: string | null;
    orderId: string | null;
    reason: string;
    owner: string;
  },
): Promise<string> {
  const id = newId();
  await sql`
    insert into discrepancy
      (id, type, bank_transaction_id, payment_intent_id, order_id, status, reason, owner)
    values
      (${id}, ${input.type}, ${input.bankTransactionId}, ${input.paymentIntentId},
       ${input.orderId}, 'OPEN', ${input.reason}, ${input.owner})
  `.execute(exec);
  return id;
}
