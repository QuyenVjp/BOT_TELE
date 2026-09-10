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
