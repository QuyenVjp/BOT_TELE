import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { newId } from "../../src/shared/ids/index.js";
import {
  createWalletLedgerService,
  planLedgerMovement,
  type WalletMutationKind,
} from "../../src/modules/wallet/ledger.js";
import { runMigrations } from "../../src/infrastructure/db/migrate.js";
import {
  dockerAvailable,
  startPostgresContainer,
  type PgTestContext,
} from "../helpers/pg-container.js";

const hasDocker = await dockerAvailable();
let ctx: PgTestContext;

const migrationsDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../src/infrastructure/db/migrations",
);

beforeAll(async () => {
  if (hasDocker) ctx = await startPostgresContainer();
}, 180_000);

afterAll(async () => {
  await ctx?.teardown();
});

beforeEach(async () => {
  await sql`truncate table wallet_ledger, wallet_account, customer cascade`.execute(ctx.db);
});

async function seedCustomer(customerId: string): Promise<void> {
  await sql`insert into customer (id, status, locale) values (${customerId}, 'ACTIVE', 'vi-VN')`.execute(
    ctx.db,
  );
}

interface BalanceRow {
  debits: string;
  credits: string;
}

async function ledgerTotals(): Promise<{ debits: bigint; credits: bigint }> {
  const rows = await sql<BalanceRow>`
    select
      coalesce(sum(amount_minor) filter (where side = 'DEBIT'), 0)::text as debits,
      coalesce(sum(amount_minor) filter (where side = 'CREDIT'), 0)::text as credits
    from ledger_posting
  `.execute(ctx.db);
  return {
    debits: BigInt(rows.rows[0]?.debits ?? "0"),
    credits: BigInt(rows.rows[0]?.credits ?? "0"),
  };
}

async function expectChartBalanced(): Promise<void> {
  const totals = await ledgerTotals();
  expect(totals.debits).toBe(totals.credits);
}

describe("double-entry ledger planning", () => {
  it("maps each movement convention to a balanced posting pair", () => {
    const cases: Array<[WalletMutationKind, string, string, string, string]> = [
      ["CREDIT", "topup:intent:tx", "TOPUP", "EXTERNAL:BANK_SETTLEMENT", "DEBIT"],
      ["DEBIT", "purchase:order:key", "PURCHASE", "SHOP:REVENUE", "CREDIT"],
      ["CREDIT", "refund:order", "REFUND", "SHOP:REFUND_EXPENSE", "DEBIT"],
      [
        "CREDIT",
        "admin-adjustment:credit",
        "CREDIT_ADJUSTMENT",
        "SHOP:ADJUSTMENT_EXPENSE",
        "DEBIT",
      ],
      ["DEBIT", "admin-adjustment:debit", "DEBIT_ADJUSTMENT", "SHOP:ADJUSTMENT_INCOME", "CREDIT"],
    ];
    for (const [kind, key, type, code, counterSide] of cases) {
      const plan = planLedgerMovement(kind, key);
      expect(plan).toEqual({
        transactionType: type,
        walletSide: kind,
        counterAccountCode: code,
        counterSide,
      });
    }
  });

  it("never lets a recognised prefix pick the wrong direction", () => {
    // A debit that claims to be a top-up cannot exist; the pair still balances.
    const plan = planLedgerMovement("DEBIT", "topup:wrong-direction");
    expect(plan.transactionType).toBe("DEBIT_ADJUSTMENT");
    expect(plan.counterSide).not.toBe(plan.walletSide);
    expect(planLedgerMovement("CREDIT", "purchase:wrong-direction").counterSide).not.toBe("CREDIT");
  });
});

describe.skipIf(!hasDocker)("double-entry ledger (PostgreSQL)", () => {
  it("records a balanced transaction with the right counter-leg for every movement kind", async () => {
    const service = createWalletLedgerService(ctx.db);
    const customerId = newId();
    await seedCustomer(customerId);

    const movements = [
      { kind: "credit", amount: 500_000n, key: "topup:intent-1:tx-1", type: "TOPUP" },
      { kind: "debit", amount: 120_000n, key: "purchase:order-1:key-1", type: "PURCHASE" },
      { kind: "credit", amount: 120_000n, key: "refund:order-1", type: "REFUND" },
      { kind: "credit", amount: 20_000n, key: "manual-credit-1", type: "CREDIT_ADJUSTMENT" },
      { kind: "debit", amount: 5_000n, key: "manual-debit-1", type: "DEBIT_ADJUSTMENT" },
    ] as const;

    for (const movement of movements) {
      const result = await service[movement.kind]({
        customerId,
        amountVnd: movement.amount,
        idempotencyKey: movement.key,
        correlationId: `corr-${movement.key}`,
        reason: movement.key,
      });
      expect(result.ok, `${movement.kind} ${movement.key}`).toBe(true);
    }

    const transactions = await sql<{ transaction_type: string; posting_count: number }>`
      select t.transaction_type, count(p.id)::int as posting_count
      from ledger_transaction t
      join ledger_posting p on p.transaction_id = t.id
      group by t.id, t.transaction_type
      order by t.created_at asc, t.id asc
    `.execute(ctx.db);

    expect(transactions.rows.map((r) => r.transaction_type)).toEqual(movements.map((m) => m.type));
    expect(transactions.rows.every((r) => r.posting_count === 2)).toBe(true);

    // Each counter-leg names exactly one system account, and no leg is self-referential.
    const counterLegs = await sql<{ code: string; side: string; amount_minor: string }>`
      select a.code, p.side, p.amount_minor::text
      from ledger_posting p
      join ledger_account a on a.id = p.account_id
      where a.account_type <> 'LIABILITY'
      order by p.created_at asc, p.id asc
    `.execute(ctx.db);
    expect(counterLegs.rows).toEqual([
      { code: "EXTERNAL:BANK_SETTLEMENT", side: "DEBIT", amount_minor: "500000" },
      { code: "SHOP:REVENUE", side: "CREDIT", amount_minor: "120000" },
      { code: "SHOP:REFUND_EXPENSE", side: "DEBIT", amount_minor: "120000" },
      { code: "SHOP:ADJUSTMENT_EXPENSE", side: "DEBIT", amount_minor: "20000" },
      { code: "SHOP:ADJUSTMENT_INCOME", side: "CREDIT", amount_minor: "5000" },
    ]);

    // The materialised wallet cache equals the ledger liability balance.
    const cache = await sql<{ cached: string; ledger: string }>`
      select w.balance_vnd::text as cached,
             coalesce(sum(case when p.side = 'CREDIT' then p.amount_minor else -p.amount_minor end), 0)::text as ledger
      from wallet_account w
      join ledger_account a on a.wallet_account_id = w.id
      left join ledger_posting p on p.account_id = a.id
      where w.customer_id = ${customerId}
      group by w.id, w.balance_vnd
    `.execute(ctx.db);
    expect(cache.rows[0]).toEqual({ cached: "515000", ledger: "515000" });

    // True double entry: the whole chart of accounts nets to zero.
    await expectChartBalanced();
  });

  it("posts exactly once per idempotency key, including across wallets", async () => {
    const service = createWalletLedgerService(ctx.db);
    const customerId = newId();
    await seedCustomer(customerId);

    const input = {
      customerId,
      amountVnd: 90_000n,
      idempotencyKey: "topup:replay:intent",
      correlationId: "corr-replay",
      reason: "replay",
    };
    const first = await service.credit(input);
    const second = await service.credit({ ...input, correlationId: "corr-replay-2" });
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.inserted).toBe(true);
    expect(second.inserted).toBe(false);
    expect(second.entryId).toBe(first.entryId);

    const counts = await sql<{ transactions: number; postings: number }>`
      select (select count(*)::int from ledger_transaction) as transactions,
             (select count(*)::int from ledger_posting) as postings
    `.execute(ctx.db);
    expect(counts.rows[0]).toEqual({ transactions: 1, postings: 2 });
    await expectChartBalanced();
  });

  it("refuses to commit an unbalanced transaction", async () => {
    const customerId = newId();
    await seedCustomer(customerId);
    const service = createWalletLedgerService(ctx.db);
    await service.credit({
      customerId,
      amountVnd: 10_000n,
      idempotencyKey: "topup:seed",
      correlationId: "corr",
      reason: "seed",
    });

    const wallet = await sql<{ id: string }>`
      select w.id from wallet_account w where w.customer_id = ${customerId}
    `.execute(ctx.db);
    const walletAccountId = wallet.rows[0]!.id;
    const systemAccounts = await sql<{ id: string; code: string }>`
      select id, code from ledger_account where code in ('EXTERNAL:BANK_SETTLEMENT', 'SHOP:REVENUE')
    `.execute(ctx.db);
    const debitAccount = systemAccounts.rows.find((r) => r.code === "EXTERNAL:BANK_SETTLEMENT")!;
    const creditAccount = systemAccounts.rows.find((r) => r.code === "SHOP:REVENUE")!;
    const transactionId = newId();

    // No wallet leg, so only the balance invariant can reject this: 100 <> 99.
    await expect(
      ctx.db.transaction().execute(async (trx) => {
        await sql`
          insert into ledger_transaction (id, transaction_type, wallet_account_id, idempotency_key, correlation_id, reason)
          values (${transactionId}, 'CREDIT_ADJUSTMENT', ${walletAccountId}, ${`unbalanced:${transactionId}`}, 'corr', 'unbalanced')
        `.execute(trx);
        await sql`
          insert into ledger_posting (id, transaction_id, account_id, side, amount_minor)
          values (${newId()}, ${transactionId}, ${debitAccount.id}, 'DEBIT', 100)
        `.execute(trx);
        await sql`
          insert into ledger_posting (id, transaction_id, account_id, side, amount_minor)
          values (${newId()}, ${transactionId}, ${creditAccount.id}, 'CREDIT', 99)
        `.execute(trx);
      }),
    ).rejects.toThrow(/unbalanced ledger transaction/i);

    const leftovers = await sql<{ count: number }>`
      select count(*)::int as count from ledger_transaction where id = ${transactionId}
    `.execute(ctx.db);
    expect(leftovers.rows[0]?.count).toBe(0);
    await expectChartBalanced();
  });

  it("refuses to commit when the cached wallet balance disagrees with the ledger", async () => {
    const customerId = newId();
    await seedCustomer(customerId);
    const service = createWalletLedgerService(ctx.db);
    const seeded = await service.credit({
      customerId,
      amountVnd: 10_000n,
      idempotencyKey: "topup:cache",
      correlationId: "corr",
      reason: "seed",
    });
    expect(seeded.ok).toBe(true);

    const wallet = await sql<{ id: string; account_id: string }>`
      select w.id, a.id as account_id from wallet_account w
      join ledger_account a on a.wallet_account_id = w.id
      where w.customer_id = ${customerId}
    `.execute(ctx.db);
    const walletAccountId = wallet.rows[0]!.id;
    const ledgerAccountId = wallet.rows[0]!.account_id;
    const transactionId = newId();
    const counter = await sql<{ id: string }>`
      select id from ledger_account where code = 'EXTERNAL:BANK_SETTLEMENT'
    `.execute(ctx.db);

    // Balanced postings, but the cache is never updated to match them.
    await expect(
      ctx.db.transaction().execute(async (trx) => {
        await sql`
          insert into ledger_transaction (id, transaction_type, wallet_account_id, idempotency_key, correlation_id, reason)
          values (${transactionId}, 'TOPUP', ${walletAccountId}, ${`cache-drift:${transactionId}`}, 'corr', 'drift')
        `.execute(trx);
        await sql`
          insert into ledger_posting (id, transaction_id, account_id, side, amount_minor)
          values (${newId()}, ${transactionId}, ${ledgerAccountId}, 'CREDIT', 500)
        `.execute(trx);
        await sql`
          insert into ledger_posting (id, transaction_id, account_id, side, amount_minor)
          values (${newId()}, ${transactionId}, ${counter.rows[0]!.id}, 'DEBIT', 500)
        `.execute(trx);
      }),
    ).rejects.toThrow(/balance cache .* disagrees with ledger/i);
  });

  it("makes postings and transactions append-only", async () => {
    const customerId = newId();
    await seedCustomer(customerId);
    const service = createWalletLedgerService(ctx.db);
    await service.credit({
      customerId,
      amountVnd: 10_000n,
      idempotencyKey: "topup:immutable",
      correlationId: "corr",
      reason: "seed",
    });

    await expect(
      sql`update ledger_posting set amount_minor = 999999`.execute(ctx.db),
    ).rejects.toThrow(/append-only/i);
    await expect(sql`delete from ledger_posting`.execute(ctx.db)).rejects.toThrow(/append-only/i);
    await expect(
      sql`update ledger_transaction set reason = 'rewritten'`.execute(ctx.db),
    ).rejects.toThrow(/append-only/i);
    await expect(sql`delete from ledger_transaction`.execute(ctx.db)).rejects.toThrow(
      /append-only/i,
    );
  });

  it("cannot overspend under 100 concurrent debits", async () => {
    const service = createWalletLedgerService(ctx.db);
    const customerId = newId();
    await seedCustomer(customerId);

    const funded = await service.credit({
      customerId,
      amountVnd: 100_000n,
      idempotencyKey: "topup:race",
      correlationId: "corr-race",
      reason: "race seed",
    });
    expect(funded.ok).toBe(true);
    if (!funded.ok) return;
    expect(funded.account.balanceVnd).toBe(100_000n);

    const attempts = Array.from({ length: 100 }, (_, index) =>
      service.debit({
        customerId,
        amountVnd: 1_000n,
        idempotencyKey: `purchase:race:${index}`,
        correlationId: `corr-race-${index}`,
        reason: "concurrent debit",
      }),
    );
    const results = await Promise.all(attempts);
    const succeeded = results.filter((r) => r.ok && r.inserted).length;

    expect(succeeded).toBeLessThanOrEqual(100);
    const balance = await service.ensureAccount(customerId);
    expect(balance?.balanceVnd).toBe(100_000n - BigInt(succeeded) * 1_000n);
    expect(balance!.balanceVnd >= 0n).toBe(true);

    // Every failed attempt must have been an insufficient-funds refusal.
    for (const result of results) {
      if (!result.ok) expect(result.code).toBe("INSUFFICIENT_FUNDS");
    }

    const postings = await sql<{ debits: string; credits: string }>`
      select
        coalesce(sum(amount_minor) filter (where side = 'DEBIT'), 0)::text as debits,
        coalesce(sum(amount_minor) filter (where side = 'CREDIT'), 0)::text as credits
      from ledger_posting
    `.execute(ctx.db);
    expect(postings.rows[0]!.debits).toBe(postings.rows[0]!.credits);
    await expectChartBalanced();
  }, 60_000);

  it("keeps the ledger balanced across a randomised workload", async () => {
    const service = createWalletLedgerService(ctx.db);
    const customerId = newId();
    await seedCustomer(customerId);

    let expectedBalance = 0n;
    let seed = 20260911;
    const nextRandom = (): number => {
      // Deterministic LCG keeps the run reproducible without a property-test runtime.
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };

    for (let index = 0; index < 120; index += 1) {
      const credit = nextRandom() < 0.6 || expectedBalance === 0n;
      const amount = BigInt(1 + Math.floor(nextRandom() * 50_000));
      const key = credit ? `manual-credit:${index}` : `manual-debit:${index}`;
      const result = await service[credit ? "credit" : "debit"]({
        customerId,
        amountVnd: amount,
        idempotencyKey: key,
        correlationId: `corr-${index}`,
        reason: key,
      });
      if (result.ok) {
        expectedBalance += credit ? amount : -amount;
      } else {
        expect(result.code).toBe("INSUFFICIENT_FUNDS");
      }
      expect(result.ok || !credit).toBe(true);
    }

    const balance = await service.ensureAccount(customerId);
    expect(balance?.balanceVnd).toBe(expectedBalance);
    await expectChartBalanced();
  }, 60_000);

  /**
   * The consistency queries published in `docs/04-security/SECURITY_HARDENING.md`
   * are the operator's reconciliation procedure. Running them here keeps the
   * documented commands honest: if a schema change makes one of them wrong, this
   * fails before an operator runs it against production.
   */
  it("passes the documented reconciliation queries after real traffic", async () => {
    const service = createWalletLedgerService(ctx.db);
    const customerId = newId();
    const secondCustomerId = newId();
    await seedCustomer(customerId);
    await seedCustomer(secondCustomerId);

    for (const [who, index] of [
      [customerId, 0],
      [customerId, 1],
      [secondCustomerId, 2],
    ] as const) {
      await service.credit({
        customerId: who,
        amountVnd: 200_000n,
        idempotencyKey: `topup:recon:${index}`,
        correlationId: `recon-${index}`,
        reason: "reconciliation seed",
      });
    }
    await service.debit({
      customerId,
      amountVnd: 75_000n,
      idempotencyKey: "purchase:recon:0",
      correlationId: "recon-purchase",
      reason: "reconciliation purchase",
    });
    await service.credit({
      customerId,
      amountVnd: 25_000n,
      idempotencyKey: "refund:recon:0",
      correlationId: "recon-refund",
      reason: "reconciliation refund",
    });

    // 1. Every posted transaction balances.
    const unbalanced = await sql<{ transaction_id: string }>`
      select transaction_id
      from ledger_posting
      group by transaction_id
      having coalesce(sum(amount_minor) filter (where side = 'DEBIT'), 0)
          <> coalesce(sum(amount_minor) filter (where side = 'CREDIT'), 0)
    `.execute(ctx.db);
    expect(unbalanced.rows).toEqual([]);

    // 2. The cached balance agrees with the ledger for every wallet.
    const drifted = await sql<{ id: string }>`
      select w.id
      from wallet_account w
      join ledger_account a on a.wallet_account_id = w.id
      left join ledger_posting p on p.account_id = a.id
      group by w.id, w.balance_vnd
      having w.balance_vnd <> coalesce(sum(
        case when p.side = 'CREDIT' then p.amount_minor else -p.amount_minor end), 0)
    `.execute(ctx.db);
    expect(drifted.rows).toEqual([]);

    // 3. No orphan postings, and no posting on a missing account.
    const orphans = await sql<{ id: string }>`
      select p.id from ledger_posting p
      left join ledger_transaction t on t.id = p.transaction_id
      left join ledger_account a on a.id = p.account_id
      where t.id is null or a.id is null
    `.execute(ctx.db);
    expect(orphans.rows).toEqual([]);

    // 4. No duplicate idempotency key may have posted money twice.
    const duplicated = await sql<{ idempotency_key: string }>`
      select idempotency_key from ledger_transaction
      group by idempotency_key having count(*) > 1
    `.execute(ctx.db);
    expect(duplicated.rows).toEqual([]);

    // 5. No silent money creation: the whole chart of accounts nets to zero.
    //    Debit legs: 3 topups x 200k (bank settlement) + 1 purchase 75k (wallet
    //    leg) + 1 refund 25k (refund expense).
    const totals = await ledgerTotals();
    expect(totals.debits).toBe(totals.credits);
    expect(totals.debits).toBe(3n * 200_000n + 75_000n + 25_000n);

    // 6. Every liability account holds a non-negative balance, i.e. no wallet
    //    is overdrawn (the DEBIT path would have refused).
    const overdrawn = await sql<{ id: string }>`
      select a.id from ledger_account a
      join ledger_posting p on p.account_id = a.id
      where a.account_type = 'LIABILITY'
      group by a.id
      having sum(case when p.side = 'CREDIT' then p.amount_minor else -p.amount_minor end) < 0
    `.execute(ctx.db);
    expect(overdrawn.rows).toEqual([]);
  }, 60_000);
});

describe.skipIf(!hasDocker)("double-entry ledger migration", () => {
  it("backfills existing single-entry history into balanced transactions", async () => {
    // Build a database at the pre-052 schema, seed representative single-entry
    // history, then apply 052 through the real runner and inspect the result.
    const { db, teardown } = await startPostgresForUpgrade();
    try {
      const customerId = newId();
      await sql`insert into customer (id, status, locale) values (${customerId}, 'ACTIVE', 'vi-VN')`.execute(
        db,
      );
      const walletAccountId = newId();
      await sql`insert into wallet_account (id, customer_id, balance_vnd) values (${walletAccountId}, ${customerId}, 400000)`.execute(
        db,
      );
      const legacy = [
        { type: "CREDIT", amount: 500_000, key: "topup:intent-9:tx-9", before: 0, after: 500_000 },
        {
          type: "DEBIT",
          amount: 150_000,
          key: "purchase:order-9:key-9",
          before: 500_000,
          after: 350_000,
        },
        { type: "CREDIT", amount: 50_000, key: "refund:order-9", before: 350_000, after: 400_000 },
      ] as const;
      for (const entry of legacy) {
        await sql`
          insert into wallet_ledger
            (id, wallet_account_id, entry_type, amount_vnd, balance_before_vnd, balance_after_vnd, idempotency_key, correlation_id, reason)
          values (${newId()}, ${walletAccountId}, ${entry.type}, ${entry.amount}, ${entry.before}, ${entry.after}, ${entry.key}, 'corr', ${entry.key})
        `.execute(db);
      }

      await runMigrations(db, migrationsDir);

      const transactions = await sql<{ transaction_type: string }>`
        select transaction_type from ledger_transaction order by created_at asc, id asc
      `.execute(db);
      expect(transactions.rows.map((r) => r.transaction_type)).toEqual([
        "TOPUP",
        "PURCHASE",
        "REFUND",
      ]);

      const counts = await sql<{ transactions: number; postings: number }>`
        select (select count(*)::int from ledger_transaction) as transactions,
               (select count(*)::int from ledger_posting) as postings
      `.execute(db);
      expect(counts.rows[0]).toEqual({ transactions: 3, postings: 6 });

      const totals = await sql<{ debits: string; credits: string }>`
        select
          coalesce(sum(amount_minor) filter (where side = 'DEBIT'), 0)::text as debits,
          coalesce(sum(amount_minor) filter (where side = 'CREDIT'), 0)::text as credits
        from ledger_posting
      `.execute(db);
      expect(totals.rows[0]!.debits).toBe(totals.rows[0]!.credits);

      const cache = await sql<{ cached: string; ledger: string }>`
        select w.balance_vnd::text as cached,
               coalesce(sum(case when p.side = 'CREDIT' then p.amount_minor else -p.amount_minor end), 0)::text as ledger
        from wallet_account w
        join ledger_account a on a.wallet_account_id = w.id
        left join ledger_posting p on p.account_id = a.id
        where w.id = ${walletAccountId}
        group by w.id, w.balance_vnd
      `.execute(db);
      expect(cache.rows[0]).toEqual({ cached: "400000", ledger: "400000" });

      const orphans = await sql<{ count: number }>`
        select count(*)::int as count
        from ledger_posting p
        left join ledger_transaction t on t.id = p.transaction_id
        left join ledger_account a on a.id = p.account_id
        where t.id is null or a.id is null
      `.execute(db);
      expect(orphans.rows[0]?.count).toBe(0);
    } finally {
      await teardown();
    }
  }, 240_000);
});

/**
 * Start a container whose schema is frozen just before migration 052, so the
 * upgrade path can be exercised against representative existing data.
 */
async function startPostgresContainerBeforeDoubleEntry() {
  const started = await startPostgresContainer();
  await sql`drop schema public cascade`.execute(started.db);
  await sql`create schema public`.execute(started.db);
  return started;
}

async function startPostgresForUpgrade() {
  const started = await startPostgresContainerBeforeDoubleEntry();
  const tempDir = await mkdtemp(join(tmpdir(), "ledger-upgrade-"));
  const files = (await readdir(migrationsDir)).filter(
    (name) => name.endsWith(".sql") && name < "052_",
  );
  for (const name of files) {
    await copyFile(join(migrationsDir, name), join(tempDir, name));
  }
  await runMigrations(started.db, tempDir);
  await rm(tempDir, { recursive: true, force: true });
  return started;
}
