import { sql } from "kysely";
import type { Db, Executor } from "../../infrastructure/db/transaction.js";
import { withTransaction } from "../../infrastructure/db/transaction.js";
import { newId } from "../../shared/ids/index.js";

export interface WalletAccount {
  id: string;
  customerId: string;
  balanceVnd: bigint;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export type WalletLedgerErrorCode =
  "CUSTOMER_NOT_FOUND" | "INVALID_AMOUNT" | "INSUFFICIENT_FUNDS" | "IDEMPOTENCY_CONFLICT";

export type WalletLedgerResult =
  | { ok: true; inserted: boolean; account: WalletAccount; entryId: string }
  | { ok: false; code: WalletLedgerErrorCode; message: string };

export interface WalletLedgerService {
  ensureAccount(customerId: string): Promise<WalletAccount | null>;
  credit(input: WalletLedgerMutationInput): Promise<WalletLedgerResult>;
  debit(input: WalletLedgerMutationInput): Promise<WalletLedgerResult>;
}

export interface WalletLedgerMutationInput {
  customerId: string;
  amountVnd: bigint;
  idempotencyKey: string;
  correlationId: string;
  reason: string;
}

export type WalletMutationKind = "CREDIT" | "DEBIT";

export type WalletMutationPlan =
  | { ok: true; nextBalanceVnd: bigint }
  | { ok: false; code: WalletLedgerErrorCode; message: string };

/**
 * Accounting classification of a wallet movement (THREAT_MODEL SEC-002).
 *
 * `wallet_account.balance_vnd` is a materialised cache; the postings added by
 * migration 052 are the authoritative record. Every movement is one balanced
 * transaction: the customer wallet liability leg plus exactly one counter-leg
 * naming where the money came from or went to.
 */
export type LedgerMovement =
  "TOPUP" | "PURCHASE" | "REFUND" | "CREDIT_ADJUSTMENT" | "DEBIT_ADJUSTMENT";

export interface LedgerMovementPlan {
  transactionType: LedgerMovement;
  /** Side of the customer wallet (liability) leg — always the wallet mutation kind. */
  walletSide: WalletMutationKind;
  /** Chart-of-accounts code for the counter-leg. */
  counterAccountCode: string;
  /** Side of the counter-leg (always the opposite of `walletSide`). */
  counterSide: WalletMutationKind;
}

export const LEDGER_SYSTEM_ACCOUNT_CODES = {
  BANK_SETTLEMENT: "EXTERNAL:BANK_SETTLEMENT",
  SHOP_REVENUE: "SHOP:REVENUE",
  REFUND_EXPENSE: "SHOP:REFUND_EXPENSE",
  ADJUSTMENT_EXPENSE: "SHOP:ADJUSTMENT_EXPENSE",
  ADJUSTMENT_INCOME: "SHOP:ADJUSTMENT_INCOME",
} as const;

/**
 * Map a wallet movement onto its balanced posting pair.
 *
 * The `wallet_ledger` idempotency-key prefix is this codebase's existing
 * movement convention (the admin customer view and the reconciliation queries
 * already branch on `purchase:`/`refund:`), so it is the single source of truth
 * here too. A recognised prefix only wins when its natural direction agrees with
 * the amount's sign; anything else falls back to an explicit adjustment pair, so
 * the result is always a balanced, cache-consistent transaction.
 */
export function planLedgerMovement(
  kind: WalletMutationKind,
  idempotencyKey: string,
): LedgerMovementPlan {
  let transactionType: LedgerMovement;
  let counterAccountCode: string;
  if (kind === "CREDIT" && idempotencyKey.startsWith("topup:")) {
    transactionType = "TOPUP";
    counterAccountCode = LEDGER_SYSTEM_ACCOUNT_CODES.BANK_SETTLEMENT;
  } else if (kind === "DEBIT" && idempotencyKey.startsWith("purchase:")) {
    transactionType = "PURCHASE";
    counterAccountCode = LEDGER_SYSTEM_ACCOUNT_CODES.SHOP_REVENUE;
  } else if (kind === "CREDIT" && idempotencyKey.startsWith("refund:")) {
    transactionType = "REFUND";
    counterAccountCode = LEDGER_SYSTEM_ACCOUNT_CODES.REFUND_EXPENSE;
  } else if (kind === "CREDIT") {
    transactionType = "CREDIT_ADJUSTMENT";
    counterAccountCode = LEDGER_SYSTEM_ACCOUNT_CODES.ADJUSTMENT_EXPENSE;
  } else {
    transactionType = "DEBIT_ADJUSTMENT";
    counterAccountCode = LEDGER_SYSTEM_ACCOUNT_CODES.ADJUSTMENT_INCOME;
  }

  return {
    transactionType,
    walletSide: kind,
    counterAccountCode,
    // The counter-leg always mirrors the wallet leg, so the pair balances exactly.
    counterSide: kind === "CREDIT" ? "DEBIT" : "CREDIT",
  };
}

type AccountRow = {
  id: string;
  customer_id: string;
  balance_vnd: string;
  version: number;
  created_at: Date | string;
  updated_at: Date | string;
};

type LedgerRow = {
  id: string;
  entry_type: WalletMutationKind;
  amount_vnd: string;
};

export function planWalletMutation(
  balanceVnd: bigint,
  amountVnd: bigint,
  kind: WalletMutationKind,
): WalletMutationPlan {
  if (typeof amountVnd !== "bigint" || amountVnd <= 0n) {
    return { ok: false, code: "INVALID_AMOUNT", message: "Số tiền ví phải là số nguyên dương." };
  }
  const nextBalanceVnd = kind === "CREDIT" ? balanceVnd + amountVnd : balanceVnd - amountVnd;
  if (nextBalanceVnd < 0n) {
    return {
      ok: false,
      code: "INSUFFICIENT_FUNDS",
      message: "Không đủ số dư ví để thực hiện giao dịch.",
    };
  }
  return { ok: true, nextBalanceVnd };
}

export async function ensureWalletAccount(
  exec: Executor,
  customerId: string,
): Promise<WalletAccount | null> {
  const customer = await sql<{ id: string }>`
    select id from customer where id = ${customerId} limit 1
  `.execute(exec);
  if (!customer.rows[0]) return null;

  await sql`
    insert into wallet_account (id, customer_id)
    values (${newId()}, ${customerId})
    on conflict (customer_id) do nothing
  `.execute(exec);

  const account = await lockAccount(exec, customerId);
  return account ? mapAccount(account) : null;
}

export async function creditWalletLedgerEntry(
  exec: Executor,
  input: WalletLedgerMutationInput,
): Promise<WalletLedgerResult> {
  return applyMutation(exec, input, "CREDIT");
}

export async function debitWalletLedgerEntry(
  exec: Executor,
  input: WalletLedgerMutationInput,
): Promise<WalletLedgerResult> {
  return applyMutation(exec, input, "DEBIT");
}

export function createWalletLedgerService(db: Db): WalletLedgerService {
  return {
    async ensureAccount(customerId) {
      return ensureWalletAccount(db, customerId);
    },
    async credit(input) {
      return withTransaction(db, async (trx) => creditWalletLedgerEntry(trx, input));
    },
    async debit(input) {
      return withTransaction(db, async (trx) => debitWalletLedgerEntry(trx, input));
    },
  };
}

async function applyMutation(
  exec: Executor,
  input: WalletLedgerMutationInput,
  kind: WalletMutationKind,
): Promise<WalletLedgerResult> {
  const account = await ensureWalletAccount(exec, input.customerId);
  if (!account) {
    return { ok: false, code: "CUSTOMER_NOT_FOUND", message: "Không tìm thấy khách hàng." };
  }

  const live = await lockAccount(exec, input.customerId);
  if (!live) {
    return { ok: false, code: "CUSTOMER_NOT_FOUND", message: "Không tìm thấy khách hàng." };
  }
  const current = mapAccount(live);

  const duplicate = await findLedgerByIdempotency(exec, current.id, input.idempotencyKey);
  if (duplicate) {
    if (duplicate.entry_type !== kind || BigInt(duplicate.amount_vnd) !== input.amountVnd) {
      return {
        ok: false,
        code: "IDEMPOTENCY_CONFLICT",
        message: "Khóa giao dịch đã được sử dụng cho giao dịch khác.",
      };
    }
    const fresh = await lockAccount(exec, input.customerId);
    return {
      ok: true,
      inserted: false,
      account: fresh ? mapAccount(fresh) : current,
      entryId: duplicate.id,
    };
  }

  const plan = planWalletMutation(current.balanceVnd, input.amountVnd, kind);
  if (!plan.ok) return plan;

  const updated = await sql`
    update wallet_account
    set balance_vnd = ${plan.nextBalanceVnd.toString()},
        version = ${current.version + 1},
        updated_at = now()
    where id = ${current.id} and version = ${current.version}
  `.execute(exec);
  if (Number(updated.numAffectedRows ?? 0) < 1) {
    throw new Error("wallet account version conflict");
  }

  const entryId = newId();
  await sql`
    insert into wallet_ledger (
      id, wallet_account_id, entry_type, amount_vnd, balance_before_vnd, balance_after_vnd,
      idempotency_key, correlation_id, reason
    ) values (
      ${entryId}, ${current.id}, ${kind}, ${input.amountVnd.toString()}, ${current.balanceVnd.toString()},
      ${plan.nextBalanceVnd.toString()}, ${input.idempotencyKey}, ${input.correlationId}, ${input.reason}
    )
  `.execute(exec);

  await writeBalancedLedgerTransaction(exec, {
    walletAccountId: current.id,
    movement: planLedgerMovement(kind, input.idempotencyKey),
    amountVnd: input.amountVnd,
    idempotencyKey: input.idempotencyKey,
    correlationId: input.correlationId,
    reason: input.reason,
    walletLedgerEntryId: entryId,
  });

  const fresh = await lockAccount(exec, input.customerId);
  return {
    ok: true,
    inserted: true,
    account: fresh
      ? mapAccount(fresh)
      : { ...current, balanceVnd: plan.nextBalanceVnd, version: current.version + 1 },
    entryId,
  };
}

interface LedgerTransactionInput {
  walletAccountId: string;
  movement: LedgerMovementPlan;
  amountVnd: bigint;
  idempotencyKey: string;
  correlationId: string;
  reason: string;
  walletLedgerEntryId: string;
}

/**
 * Re-create the five system accounts if they are missing.
 *
 * `ledger_account` is truncated along with `wallet_account` by test and reset
 * paths that use `TRUNCATE ... CASCADE`, so the writer cannot assume the seed
 * rows still exist. `on conflict (code) do nothing` keeps this a no-op in the
 * normal case.
 */
async function ensureSystemLedgerAccounts(exec: Executor): Promise<void> {
  await sql`
    insert into ledger_account (id, code, account_type, normal_side)
    values
      ('lac_sys_bank_settlement', ${LEDGER_SYSTEM_ACCOUNT_CODES.BANK_SETTLEMENT}, 'ASSET', 'DEBIT'),
      ('lac_sys_shop_revenue', ${LEDGER_SYSTEM_ACCOUNT_CODES.SHOP_REVENUE}, 'REVENUE', 'CREDIT'),
      ('lac_sys_refund_expense', ${LEDGER_SYSTEM_ACCOUNT_CODES.REFUND_EXPENSE}, 'EXPENSE', 'DEBIT'),
      ('lac_sys_adjustment_expense', ${LEDGER_SYSTEM_ACCOUNT_CODES.ADJUSTMENT_EXPENSE}, 'EXPENSE', 'DEBIT'),
      ('lac_sys_adjustment_income', ${LEDGER_SYSTEM_ACCOUNT_CODES.ADJUSTMENT_INCOME}, 'REVENUE', 'CREDIT')
    on conflict (code) do nothing
  `.execute(exec);
}

/**
 * Append the immutable double-entry record for a wallet movement.
 *
 * Two legs, equal amounts, opposite sides — the deferred constraint trigger from
 * migration 052 refuses to commit anything else, and a second deferred trigger
 * refuses a commit whose `wallet_account.balance_vnd` disagrees with the ledger.
 */
async function writeBalancedLedgerTransaction(
  exec: Executor,
  input: LedgerTransactionInput,
): Promise<void> {
  await ensureSystemLedgerAccounts(exec);

  const transactionId = newId();
  await sql`
    insert into ledger_transaction (
      id, transaction_type, wallet_account_id, idempotency_key, correlation_id, reason
    ) values (
      ${transactionId}, ${input.movement.transactionType}, ${input.walletAccountId},
      ${`wallet_ledger:${input.walletLedgerEntryId}`}, ${input.correlationId}, ${input.reason}
    )
  `.execute(exec);

  await sql`
    insert into ledger_posting (id, transaction_id, account_id, side, amount_minor)
    select ${newId()}, ${transactionId}, a.id, ${input.movement.walletSide}, ${input.amountVnd.toString()}::bigint
    from ledger_account a
    where a.wallet_account_id = ${input.walletAccountId}
    union all
    select ${newId()}, ${transactionId}, c.id, ${input.movement.counterSide}, ${input.amountVnd.toString()}::bigint
    from ledger_account c
    where c.code = ${input.movement.counterAccountCode}
  `.execute(exec);

  const postings = await sql<{ count: number; debit: string; credit: string }>`
    select count(*)::int as count,
           coalesce(sum(amount_minor) filter (where side = 'DEBIT'), 0)::text as debit,
           coalesce(sum(amount_minor) filter (where side = 'CREDIT'), 0)::text as credit
    from ledger_posting
    where transaction_id = ${transactionId}
  `.execute(exec);
  const written = postings.rows[0];
  if (!written || written.count !== 2 || written.debit !== written.credit) {
    // The deferred trigger would abort at COMMIT anyway; failing here keeps the
    // error next to the cause instead of at the end of the transaction.
    throw new Error("double-entry ledger posting failed to balance");
  }
}

async function lockAccount(exec: Executor, customerId: string): Promise<AccountRow | null> {
  const result = await sql<AccountRow>`
    select id, customer_id, balance_vnd, version, created_at, updated_at
    from wallet_account
    where customer_id = ${customerId}
    limit 1
    for update
  `.execute(exec);
  return result.rows[0] ?? null;
}

async function findLedgerByIdempotency(
  exec: Executor,
  walletAccountId: string,
  idempotencyKey: string,
): Promise<LedgerRow | null> {
  const result = await sql<LedgerRow>`
    select id, entry_type, amount_vnd
    from wallet_ledger
    where wallet_account_id = ${walletAccountId} and idempotency_key = ${idempotencyKey}
    limit 1
  `.execute(exec);
  return result.rows[0] ?? null;
}

function mapAccount(row: AccountRow): WalletAccount {
  return {
    id: row.id,
    customerId: row.customer_id,
    balanceVnd: BigInt(row.balance_vnd),
    version: row.version,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

/** One wallet movement, newest-first, as shown to the owner of the wallet. */
export interface WalletLedgerEntryView {
  entryType: string;
  amountVnd: bigint;
  balanceAfterVnd: bigint;
  reason: string;
  createdAt: Date;
}

/**
 * Read-only wallet history for a customer's private screen (goal §38 `📜 Lịch sử ví`).
 *
 * Projects only the fields a customer is allowed to see. The ledger's idempotency and
 * correlation keys stay in the database: they are internal bookkeeping, not customer content.
 */
export async function listWalletLedgerEntries(
  exec: Executor,
  customerId: string,
  limit = 10,
): Promise<WalletLedgerEntryView[]> {
  const capped = Math.min(Math.max(Math.trunc(limit), 1), 50);
  const result = await sql<{
    entry_type: string;
    amount_vnd: string;
    balance_after_vnd: string;
    reason: string | null;
    created_at: Date;
  }>`
    select l.entry_type, l.amount_vnd::text, l.balance_after_vnd::text, l.reason, l.created_at
    from wallet_ledger l
    join wallet_account a on a.id = l.wallet_account_id
    where a.customer_id = ${customerId}
    order by l.created_at desc, l.id desc
    limit ${capped}
  `.execute(exec);
  return result.rows.map((row) => ({
    entryType: row.entry_type,
    amountVnd: BigInt(row.amount_vnd),
    balanceAfterVnd: BigInt(row.balance_after_vnd),
    reason: row.reason ?? "",
    createdAt: row.created_at,
  }));
}
