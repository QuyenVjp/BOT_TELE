import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { newId } from "../../src/shared/ids/index.js";
import { createWalletLedgerService } from "../../src/modules/wallet/ledger.js";
import { dockerAvailable, startPostgresContainer, type PgTestContext } from "../helpers/pg-container.js";

const hasDocker = await dockerAvailable();
let ctx: PgTestContext;

beforeAll(async () => {
  if (hasDocker) ctx = await startPostgresContainer();
}, 180_000);

afterAll(async () => {
  await ctx?.teardown();
});

async function seedCustomer(customerId: string): Promise<void> {
  await sql`insert into customer (id, status, locale) values (${customerId}, 'ACTIVE', 'vi-VN')`.execute(ctx.db);
}

beforeEach(async () => {
  await sql`truncate table wallet_ledger, wallet_account, customer cascade`.execute(ctx.db);
});

describe.skipIf(!hasDocker)("wallet ledger service", () => {
  it("reconciles every mutation kind against signed ledger entries", async () => {
    const service = createWalletLedgerService(ctx.db);
    const customerId = newId();
    await seedCustomer(customerId);
    for (const [kind, amount, key] of [["credit", 500000n, "topup:test"], ["debit", 100000n, "purchase:test"], ["credit", 50000n, "refund:test"], ["credit", 25000n, "admin-adjustment:credit"], ["debit", 10000n, "admin-adjustment:debit"]] as const) {
      expect((await service[kind]({ customerId, amountVnd: amount, idempotencyKey: key, correlationId: key, reason: key })).ok).toBe(true);
      const rows = await sql<{ balanced: boolean }>`select a.balance_vnd=coalesce(sum(case when l.entry_type='CREDIT' then l.amount_vnd else -l.amount_vnd end),0) as balanced from wallet_account a left join wallet_ledger l on l.wallet_account_id=a.id group by a.id,a.balance_vnd`.execute(ctx.db);
      expect(rows.rows.every(row => row.balanced)).toBe(true);
    }
    expect((await service.ensureAccount(customerId))?.balanceVnd).toBe(465000n);
  });
  it("creates one account and one credit entry per idempotency key", async () => {
    const service = createWalletLedgerService(ctx.db);
    const customerId = newId();
    await seedCustomer(customerId);

    const first = await service.credit({
      customerId,
      amountVnd: 150_000n,
      idempotencyKey: "topup:1",
      correlationId: "corr-1",
      reason: "sepay topup",
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.inserted).toBe(true);
    expect(first.account.balanceVnd).toBe(150_000n);

    const second = await service.credit({
      customerId,
      amountVnd: 150_000n,
      idempotencyKey: "topup:1",
      correlationId: "corr-2",
      reason: "replay topup",
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.inserted).toBe(false);
    expect(second.account.balanceVnd).toBe(150_000n);

    const counts = await sql<{ account_count: number; ledger_count: number }>`
      select
        (select count(*)::int from wallet_account where customer_id = ${customerId}) as account_count,
        (select count(*)::int from wallet_ledger l join wallet_account a on a.id = l.wallet_account_id where a.customer_id = ${customerId}) as ledger_count
    `.execute(ctx.db);
    expect(counts.rows[0]).toEqual({ account_count: 1, ledger_count: 1 });
  });

  it("rejects debits that would make the balance negative", async () => {
    const service = createWalletLedgerService(ctx.db);
    const customerId = newId();
    await seedCustomer(customerId);

    const result = await service.debit({
      customerId,
      amountVnd: 1n,
      idempotencyKey: "purchase:1",
      correlationId: "corr-3",
      reason: "wallet purchase",
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("INSUFFICIENT_FUNDS");
    expect(result.message).toContain("Không đủ số dư");

    const counts = await sql<{ account_count: number; ledger_count: number }>`
      select
        (select count(*)::int from wallet_account where customer_id = ${customerId}) as account_count,
        (select count(*)::int from wallet_ledger l join wallet_account a on a.id = l.wallet_account_id where a.customer_id = ${customerId}) as ledger_count
    `.execute(ctx.db);
    expect(counts.rows[0]).toEqual({ account_count: 1, ledger_count: 0 });
  });
});
