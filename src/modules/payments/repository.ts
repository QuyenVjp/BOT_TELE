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
 *   - bank_transaction_alias (provider, alias_type, alias_value) → cross-source identity
 *   - payment_allocation (bank_transaction_id) where SETTLED → one settlement
 *   - payment_allocation (payment_intent_id) where SETTLED → one settlement per intent
 *   - payment_intent (transfer_content) where live → one live intent per content
 */

/**
 * Cross-source SePay identity: one physical bank transfer, one canonical row.
 *
 * The two provider surfaces carry DIFFERENT ids for the same money — the webhook
 * an integer (`92704`), the API v2 list a UUID (`api:…`) — and SePay documents
 * no translation between them. Identity is therefore resolved in three layers,
 * strongest first, and never guessed:
 *
 *   1. an alias we have already mapped to a canonical row
 *      (`bank_transaction_alias`, unique per (provider, alias_type, alias_value));
 *   2. the same provider transaction id (same surface re-delivering), compared
 *      field-by-field so a mutated body stays a REFERENCE_COLLISION;
 *   3. the account-scoped correlation key, which only merges when the bank
 *      reference is present and EXACTLY ONE candidate sits inside the window.
 *      More than one candidate is `AMBIGUOUS`: the arrival is stored and the
 *      caller records a review signal instead of merging.
 */
export type BankTransactionAliasType = "webhook_legacy_id" | "api_v2_uuid" | "provider_reference";

export interface BankTransactionAlias {
  aliasType: BankTransactionAliasType;
  aliasValue: string;
}

export type BankTransactionIdentity =
  | { kind: "INSERTED"; id: string }
  | { kind: "DUPLICATE"; id: string }
  | { kind: "MUTATION"; id: string }
  | { kind: "AMBIGUOUS"; id: string; candidateIds: string[] };

/**
 * The provider aliases one piece of evidence carries. `provider_reference` is
 * deliberately never derived: a bank reference code is not globally unique (some
 * banks send none, formats differ per bank), so it may only be used inside the
 * account-scoped correlation key below.
 */
export function deriveBankTransactionAliases(
  providerTransactionId: string,
): BankTransactionAlias[] {
  // `api:` marks the v2 surface. EVERYTHING else came from the webhook surface, so a
  // non-v2 id is labelled as such rather than dropped: an unlabelled id is invisible to
  // step 1 of ingestion, which is where cross-surface linking begins. The SQL backfill in
  // migration 066 applies exactly this rule, and the agreement is asserted by
  // tests/integration/sepay-cross-source-identity.test.ts.
  if (providerTransactionId.startsWith("api:") && providerTransactionId.length > 4) {
    return [{ aliasType: "api_v2_uuid", aliasValue: providerTransactionId.slice(4) }];
  }
  if (providerTransactionId.length === 0) return [];
  return [{ aliasType: "webhook_legacy_id", aliasValue: providerTransactionId }];
}

/**
 * The correlation key, in the ONE definition the SQL backfill must agree with
 * (`bank_transaction_correlation_key` in
 * src/infrastructure/db/migrations/066_sepay_transaction_alias.sql; the equality
 * is asserted by tests/integration/sepay-cross-source-identity.test.ts).
 *
 *   sepay | merchant_account_id | direction | amount_vnd | normalize(reference)
 *
 * normalize = trim → collapse internal whitespace → uppercase. A null or
 * whitespace-only reference yields NULL and NOTHING correlates on it: without a
 * bank reference there is no per-account-unique field, and amount+time alone
 * could join two legitimate transfers. The time window is not part of the key —
 * a bucket boundary would break matching across it — the query applies it.
 */
export function bankTransactionCorrelationKey(input: {
  merchantAccountId: string;
  direction: string;
  amountVnd: number;
  reference: string | null;
}): string | null {
  const reference = (input.reference ?? "")
    .trim()
    .replace(/[ \t\n\r\f\v]+/g, " ")
    .toUpperCase();
  if (reference === "") return null;
  return `sepay|${input.merchantAccountId}|${input.direction}|${input.amountVnd}|${reference}`;
}

/**
 * Tolerance for the cross-source `transacted_at` window. SePay timestamps have
 * second-level resolution and the surfaces format them differently (webhook
 * `YYYY-MM-DD HH:mm:ss` in GMT+7, API v2 ISO-8601), so one transfer can be
 * stamped a couple of seconds apart across surfaces. ±120s absorbs that skew and
 * stays far narrower than the gap between two real transfers that happen to
 * share an account, amount, and bank reference.
 */
const CORRELATION_WINDOW_SECONDS = 120;

/** Columns shared by every identity lookup; `bt` is the alias in each query. */
const BANK_TRANSACTION_ROW_COLUMNS = sql`
  bt.id, bt.provider_transaction_id, bt.direction, bt.merchant_account_id,
  bt.amount_vnd, bt.content, bt.raw_hash
`;

interface BankTransactionRow {
  id: string;
  provider_transaction_id: string;
  direction: string;
  merchant_account_id: string;
  amount_vnd: string;
  content: string | null;
  raw_hash: string;
}

/** The canonical row for one provider id on one provider, if it exists. */
async function findBankTransactionRow(
  exec: Executor,
  provider: string,
  providerTransactionId: string,
): Promise<BankTransactionRow | null> {
  const result = await sql<BankTransactionRow>`
    select ${BANK_TRANSACTION_ROW_COLUMNS}
    from bank_transaction bt
    where bt.provider = ${provider}
      and bt.provider_transaction_id = ${providerTransactionId}
  `.execute(exec);
  return result.rows[0] ?? null;
}

/**
 * Record every alias this evidence carries on the canonical row. The conflict
 * clause is the point: an alias already mapped keeps the row it points at, so
 * concurrent deliveries of one provider id converge instead of racing to
 * re-point the mapping (the unique index is what makes it one row, not two).
 */
export async function attachBankTransactionAliases(
  exec: Executor,
  bankTransactionId: string,
  provider: string,
  aliases: BankTransactionAlias[],
): Promise<void> {
  for (const alias of aliases) {
    await sql`
      insert into bank_transaction_alias
        (id, bank_transaction_id, provider, alias_type, alias_value)
      values
        (${newId()}, ${bankTransactionId}, ${provider}, ${alias.aliasType}, ${alias.aliasValue})
      on conflict (provider, alias_type, alias_value) do nothing
    `.execute(exec);
  }
}

/**
 * Resolve evidence against a row we already hold. Same provider id → the
 * verified payload fingerprint decides replay versus collision (unchanged from
 * the original dedupe). Different surface → only the business facts can be
 * compared, because the payload fingerprint belongs to the other surface.
 */
async function resolveAgainstExisting(
  exec: Executor,
  row: BankTransactionRow,
  evidence: PaymentEvidence,
  aliases: BankTransactionAlias[],
): Promise<BankTransactionIdentity> {
  await attachBankTransactionAliases(exec, row.id, evidence.provider, aliases);
  const same =
    row.provider_transaction_id !== evidence.providerTransactionId
      ? row.direction === evidence.direction &&
        row.merchant_account_id === evidence.merchantAccountId &&
        Number(row.amount_vnd) === evidence.amountVnd
      : row.direction === evidence.direction &&
        row.merchant_account_id === evidence.merchantAccountId &&
        Number(row.amount_vnd) === evidence.amountVnd &&
        row.content === evidence.content &&
        row.raw_hash === evidence.rawHash;
  return same ? { kind: "DUPLICATE", id: row.id } : { kind: "MUTATION", id: row.id };
}

/**
 * Insert verified evidence as a canonical bank transaction.
 *
 * Order matters and is never reordered: alias → same provider id → correlation
 * key. `AMBIGUOUS` means two rows already share this transfer's correlation key,
 * so the new evidence is stored (nothing is lost) but attributed to neither.
 *
 * Concurrency: Read Committed plus the provider-id unique index is enough for
 * two deliveries of the SAME surface — the loser's insert conflicts, re-reads
 * the winner, and reports DUPLICATE/MUTATION. It is NOT enough for the two
 * surfaces arriving at once: they carry different provider ids and different
 * alias types, so neither unique index collides and both would insert. The
 * transaction-scoped advisory lock on the correlation key serializes that
 * decision, so the second arrival's candidate query runs after the first
 * commits and sees it.
 */
export async function insertBankTransactionIfNew(
  exec: Executor,
  evidence: PaymentEvidence,
  signatureStatus: string,
  schemaVersion: string,
): Promise<BankTransactionIdentity> {
  const aliases = deriveBankTransactionAliases(evidence.providerTransactionId);

  // 1. A provider id we have already mapped. Strong and deterministic.
  for (const alias of aliases) {
    const hit = await sql<BankTransactionRow>`
      select ${BANK_TRANSACTION_ROW_COLUMNS}
      from bank_transaction bt
      join bank_transaction_alias a on a.bank_transaction_id = bt.id
      where a.provider = ${evidence.provider}
        and a.alias_type = ${alias.aliasType}
        and a.alias_value = ${alias.aliasValue}
    `.execute(exec);
    if (hit.rows[0]) return resolveAgainstExisting(exec, hit.rows[0], evidence, aliases);
  }

  // 2. Same surface, same provider id — the row may predate the alias table.
  const sameSurface = await findBankTransactionRow(
    exec,
    evidence.provider,
    evidence.providerTransactionId,
  );
  if (sameSurface) return resolveAgainstExisting(exec, sameSurface, evidence, aliases);

  // 3. Cross-source: find the canonical row by the account-scoped key.
  const correlationKey = bankTransactionCorrelationKey(evidence);
  let candidateIds: string[] = [];
  if (correlationKey !== null) {
    await sql`
      select pg_advisory_xact_lock(
        hashtext('bank_transaction_correlation'), hashtext(${correlationKey})
      )
    `.execute(exec);
    const halfWindowMs = CORRELATION_WINDOW_SECONDS * 1000;
    const candidates = await sql<BankTransactionRow>`
      select ${BANK_TRANSACTION_ROW_COLUMNS}
      from bank_transaction bt
      where bt.provider = ${evidence.provider}
        and bt.correlation_key = ${correlationKey}
        and bt.transacted_at between
          ${new Date(evidence.transactedAt.getTime() - halfWindowMs).toISOString()}::timestamptz
          and ${new Date(evidence.transactedAt.getTime() + halfWindowMs).toISOString()}::timestamptz
      order by bt.id
    `.execute(exec);
    // A candidate from the SAME surface cannot be this transfer: one surface never reports the
    // same transfer twice (a repeat carries the same provider id and is caught in step 2). So a
    // same-surface candidate is a DIFFERENT physical transfer that merely shares the key, and
    // its presence makes the match ambiguous — merging would have to pick one of two transfers.
    //
    // Only the other surface can be the same transfer, and only when it is the sole candidate:
    //  - no same-surface candidate and exactly one cross-surface candidate → merge.
    //  - anything else → store the arrival (nothing is lost) and report AMBIGUOUS.
    const candidateIdsInWindow = candidates.rows.map((row) => row.id);
    const sameSurfaceIds = new Set<string>();
    if (candidateIdsInWindow.length > 0) {
      const existing = await sql<{ bank_transaction_id: string }>`
        select distinct bank_transaction_id
        from bank_transaction_alias
        where provider = ${evidence.provider}
          and alias_type in (${sql.join(aliases.map((alias) => sql`${alias.aliasType}`))})
          and bank_transaction_id in (${sql.join(candidateIdsInWindow.map((id) => sql`${id}`))})
      `.execute(exec);
      for (const row of existing.rows) sameSurfaceIds.add(row.bank_transaction_id);
    }
    const crossSurface = candidates.rows.filter((row) => !sameSurfaceIds.has(row.id));
    const unambiguousCrossSource = sameSurfaceIds.size === 0 && crossSurface.length === 1;
    if (unambiguousCrossSource) {
      return resolveAgainstExisting(exec, crossSurface[0]!, evidence, aliases);
    }
    // Ambiguous only when there is something to be ambiguous ABOUT: a second transfer on this
    // surface, or several candidates on the other.
    candidateIds = sameSurfaceIds.size > 0 || crossSurface.length > 1 ? candidateIdsInWindow : [];
  }

  const id = newId();
  const inserted = await sql<{ id: string }>`
    insert into bank_transaction
      (id, provider, provider_transaction_id, direction, merchant_account_id,
       amount_vnd, content, reference, transacted_at, raw_hash, signature_status, schema_version,
       correlation_key)
    values
      (${id}, ${evidence.provider}, ${evidence.providerTransactionId}, ${evidence.direction},
       ${evidence.merchantAccountId}, ${evidence.amountVnd}, ${evidence.content},
       ${evidence.reference}, ${evidence.transactedAt.toISOString()}, ${evidence.rawHash},
       ${signatureStatus}, ${schemaVersion}, ${correlationKey})
    on conflict (provider, provider_transaction_id) do nothing
    returning id
  `.execute(exec);
  if (!inserted.rows[0]) {
    // A concurrent delivery of the same provider id won the insert.
    const winner = await findBankTransactionRow(
      exec,
      evidence.provider,
      evidence.providerTransactionId,
    );
    if (!winner) throw new Error("Bank transaction conflict winner was not found");
    return resolveAgainstExisting(exec, winner, evidence, aliases);
  }
  await attachBankTransactionAliases(exec, id, evidence.provider, aliases);
  return candidateIds.length > 0
    ? { kind: "AMBIGUOUS", id, candidateIds }
    : { kind: "INSERTED", id };
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

/*
 * Owner-scoped intent reads (BOLA/IDOR).
 *
 * A payment intent is owned by a customer either through its Order or through
 * its preorder reservation. The predicate joins to that owner, so a foreign
 * intent is never returned; the failure shape matches the un-scoped lookups — a
 * non-owned intent is indistinguishable from a missing one (`null`, no throw).
 */

/** Intent columns qualified for owner-scoped joins (both sides own `id`/`status`). */
const OWNER_SCOPED_INTENT_COLUMNS = sql`
  i.id, i.order_id, i.preorder_id, i.kind, i.amount_vnd, i.merchant_account_id,
  i.transfer_content, i.status, i.expires_at, i.version
`;

/**
 * Owner-scoped intent read. Order-backed intents only: a preorder intent has no
 * `order_id`, so use {@link findLiveIntentByPreorderLegForOwner} for those.
 * Returns null when the id is missing, is a preorder leg, or belongs to another
 * customer.
 */
export async function findIntentByIdForOwner(
  exec: Executor,
  intentId: string,
  customerId: string,
): Promise<(MatchableIntent & { version: number }) | null> {
  const result = await sql<IntentRow>`
    select ${OWNER_SCOPED_INTENT_COLUMNS}
    from payment_intent i
    join "order" o on o.id = i.order_id
    where i.id = ${intentId} and o.customer_id = ${customerId}
    limit 1
  `.execute(exec);
  const row = result.rows[0];
  return row ? toMatchableIntent(row) : null;
}

/** Owner-scoped live intent for an order: another customer's order yields null. */
export async function findLiveIntentByOrderForOwner(
  exec: Executor,
  orderId: string,
  customerId: string,
): Promise<(MatchableIntent & { version: number }) | null> {
  const result = await sql<IntentRow>`
    select ${OWNER_SCOPED_INTENT_COLUMNS}
    from payment_intent i
    join "order" o on o.id = i.order_id
    where i.order_id = ${orderId}
      and o.customer_id = ${customerId}
      and i.status in ('CREATED','PRESENTED')
    limit 1
  `.execute(exec);
  const row = result.rows[0];
  return row ? toMatchableIntent(row) : null;
}

/** Owner-scoped live intent for one preorder leg; another customer's reservation yields null. */
export async function findLiveIntentByPreorderLegForOwner(
  exec: Executor,
  preorderId: string,
  kind: "DEPOSIT" | "BALANCE",
  customerId: string,
): Promise<(MatchableIntent & { version: number }) | null> {
  const result = await sql<IntentRow>`
    select ${OWNER_SCOPED_INTENT_COLUMNS}
    from payment_intent i
    join preorder_reservation p on p.id = i.preorder_id
    where i.preorder_id = ${preorderId}
      and p.customer_id = ${customerId}
      and i.kind = ${kind}
      and i.status in ('CREATED','PRESENTED')
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

/**
 * Discrepancy types this writer can persist. `AMBIGUOUS_CORRELATION` is the
 * cross-source identity signal: two canonical rows matched one physical
 * transfer, so a human decides. It is intentionally NOT part of the matcher's
 * vocabulary in domain.ts — `decideMatch` never returns it, because the arrival
 * is neither an unmatched payment (nothing is unsettled) nor a replay.
 */
export type PersistedDiscrepancyType = DiscrepancyType | "AMBIGUOUS_CORRELATION";

/** Record a typed discrepancy for manual/automated review. */
export async function insertDiscrepancy(
  exec: Executor,
  input: {
    type: PersistedDiscrepancyType;
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
