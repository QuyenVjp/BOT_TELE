import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { withTransaction } from "../../src/infrastructure/db/transaction.js";
import type { Db, Trx } from "../../src/infrastructure/db/transaction.js";
import { insertBankTransactionIfNew } from "../../src/modules/payments/repository.js";
import type { PaymentEvidence } from "../../src/modules/payments/domain.js";
import {
  applyWalletTopupEvidence,
  cancelLiveWalletTopup,
  presentWalletTopup,
} from "../../src/modules/wallet/topup.js";
import type { PaymentPresentation } from "../../src/modules/payments/vietqr.js";
import { newId } from "../../src/shared/ids/index.js";
import { verifiedSePayEvidence } from "../helpers/verified-sepay.js";
import {
  dockerAvailable,
  startPostgresContainer,
  type PgTestContext,
} from "../helpers/pg-container.js";

const hasDocker = await dockerAvailable();
let ctx: PgTestContext;

beforeAll(async () => {
  if (hasDocker) ctx = await startPostgresContainer();
}, 180_000);

afterAll(async () => {
  await ctx?.teardown();
});

beforeEach(async () => {
  await sql`truncate table outbox_event, wallet_topup_intent, wallet_ledger, wallet_account, bank_transaction, customer cascade`.execute(
    ctx.db,
  );
});

interface PresentedTopupFixture {
  customerId: string;
  intentId: string;
  presentation: Pick<PaymentPresentation, "amountVnd" | "transferContent">;
}

describe.skipIf(!hasDocker)("wallet topup evidence integration", () => {
  async function seedPresentedTopup(amountVnd: bigint = 150_000n): Promise<PresentedTopupFixture> {
    const customerId = newId();
    await sql`insert into customer (id, status, locale) values (${customerId}, 'ACTIVE', 'vi-VN')`.execute(
      ctx.db,
    );

    const presented = await presentWalletTopup({
      db: ctx.db,
      customerId,
      amountVnd,
      merchantAccountId: "0123456789",
      beneficiaryAccountNumber: "0123456789",
      bankBin: "970422",
      accountName: "BOT TELE",
      correlationId: "present-" + newId().slice(-8),
    });
    expect(presented.ok).toBe(true);
    if (!presented.ok) throw new Error(presented.error);
    return { customerId, intentId: presented.intentId, presentation: presented.presentation };
  }

  function evidenceFor(topup: PresentedTopupFixture, overrides: Partial<PaymentEvidence> = {}) {
    return verifiedSePayEvidence({
      provider: "sepay",
      providerTransactionId: "SEPAY-" + newId(),
      direction: "IN",
      merchantAccountId: "0123456789",
      amountVnd: topup.presentation.amountVnd,
      content: topup.presentation.transferContent,
      structuredCode: topup.presentation.transferContent,
      reference: "FT-" + newId().slice(-6),
      transactedAt: new Date(),
      rawHash: "hash-" + newId(),
      correlationId: "corr-" + newId().slice(-6),
      ...overrides,
    });
  }

  function pauseWalletTopupExpiryTrigger(db: Db): Db {
    return new Proxy(db, {
      get(target, property) {
        if (property !== "transaction") {
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        }
        return () => ({
          execute: <T>(callback: (trx: Trx) => Promise<T>) =>
            target.transaction().execute(async (trx) => {
              await sql`
                select
                  set_config('app.wallet_topup_lock_test', 'on', true),
                  set_config('application_name', 'wallet-topup-present-lock-test', true)
              `.execute(trx);
              return callback(trx);
            }),
        });
      },
    }) as Db;
  }

  async function waitForPresentationStatementLock(): Promise<void> {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const waiting = await sql<{ count: number }>`
        select count(*)::int as count
        from pg_stat_activity
        where application_name = 'wallet-topup-present-lock-test'
          and wait_event_type = 'Lock'
      `.execute(ctx.db);
      if ((waiting.rows[0]?.count ?? 0) > 0) return;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    throw new Error("wallet topup presentation did not reach the lock barrier");
  }

  async function waitForWalletAccountLock(isSettled: () => boolean): Promise<boolean> {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline && !isSettled()) {
      const waiting = await sql<{ count: number }>`
        select count(*)::int as count
        from pg_stat_activity
        where datname = current_database()
          and wait_event_type = 'Lock'
          and lower(coalesce(query, '')) like '%wallet_account%'
          and lower(coalesce(query, '')) like '%for update%'
      `.execute(ctx.db);
      if ((waiting.rows[0]?.count ?? 0) > 0) return true;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    return false;
  }

  it("credits 100 concurrent duplicate topup replays once and emits one credit event", async () => {
    const topup = await seedPresentedTopup();
    const providerTransactionId = "SEPAY-DUP-" + newId();
    const evidence = evidenceFor(topup, { providerTransactionId });

    const results = await Promise.all(
      Array.from({ length: 100 }, () => applyWalletTopupEvidence(ctx.db, evidence)),
    );

    expect(results.filter((result) => result.ok && result.kind === "CREDITED")).toHaveLength(1);
    expect(results.filter((result) => result.ok && result.kind === "ALREADY_APPLIED")).toHaveLength(
      99,
    );

    const rows = await sql<{
      balance_vnd: string;
      ledger_count: string;
      credit_count: string;
      credited_events: string;
      bank_txns: string;
      status: string;
    }>`
      select
        (select balance_vnd::text from wallet_account where customer_id = ${topup.customerId}) as balance_vnd,
        (select count(*)::text from wallet_ledger where idempotency_key = ${`topup:${topup.intentId}:${providerTransactionId}`}) as ledger_count,
        (select count(*)::text from wallet_ledger where idempotency_key = ${`topup:${topup.intentId}:${providerTransactionId}`} and entry_type = 'CREDIT') as credit_count,
        (select count(*)::text from outbox_event where aggregate_id = ${topup.intentId} and event_type = 'WalletTopupCredited') as credited_events,
        (select count(*)::text from bank_transaction where provider = 'sepay' and provider_transaction_id = ${providerTransactionId}) as bank_txns,
        (select status from wallet_topup_intent where id = ${topup.intentId}) as status
    `.execute(ctx.db);

    expect(rows.rows[0]).toEqual({
      balance_vnd: "150000",
      ledger_count: "1",
      credit_count: "1",
      credited_events: "1",
      bank_txns: "1",
      status: "SUCCEEDED",
    });
  });
  it("rejects future-dated evidence without changing topup or wallet state", async () => {
    const topup = await seedPresentedTopup();
    const providerTransactionId = "SEPAY-FUTURE-" + newId();
    const result = await applyWalletTopupEvidence(
      ctx.db,
      evidenceFor(topup, {
        providerTransactionId,
        transactedAt: new Date(Date.now() + 5 * 60_000),
      }),
    );

    expect(result).toEqual({ ok: false, error: "invalid transaction time" });
    const rows = await sql<{
      status: string;
      balance_vnd: string;
      ledger_count: string;
      bank_transactions: string;
    }>`
      select
        (select status from wallet_topup_intent where id = ${topup.intentId}) as status,
        (select balance_vnd::text from wallet_account where customer_id = ${topup.customerId}) as balance_vnd,
        (select count(*)::text from wallet_ledger) as ledger_count,
        (select count(*)::text from bank_transaction where provider_transaction_id = ${providerTransactionId}) as bank_transactions
    `.execute(ctx.db);
    expect(rows.rows[0]).toEqual({
      status: "PRESENTED",
      balance_vnd: "0",
      ledger_count: "0",
      bank_transactions: "0",
    });
  });

  it("does not deadlock topup amount replacement against concurrent settlement", async () => {
    await sql
      .raw(
        `
      create or replace function test_pause_wallet_topup_update() returns trigger
      language plpgsql as $$
      begin
        if current_setting('app.wallet_topup_lock_test', true) = 'on' then
          perform pg_advisory_xact_lock(910000, 777);
        end if;
        return null;
      end;
      $$
    `,
      )
      .execute(ctx.db);
    await sql
      .raw(
        `
      create trigger test_pause_wallet_topup_update
      before update on wallet_topup_intent
      for each statement execute function test_pause_wallet_topup_update()
    `,
      )
      .execute(ctx.db);

    const topup = await seedPresentedTopup();
    const lockReady = Promise.withResolvers<void>();
    const releaseLock = Promise.withResolvers<void>();
    const blocker = ctx.db.transaction().execute(async (trx) => {
      await sql`select pg_advisory_xact_lock(910000, 777)`.execute(trx);
      lockReady.resolve();
      await releaseLock.promise;
    });
    await lockReady.promise;
    const replacement = presentWalletTopup({
      db: pauseWalletTopupExpiryTrigger(ctx.db),
      customerId: topup.customerId,
      amountVnd: 200_000n,
      merchantAccountId: "0123456789",
      beneficiaryAccountNumber: "0123456789",
      bankBin: "970422",
      accountName: "BOT TELE",
      correlationId: "present-replacement-" + newId().slice(-8),
    });
    let settlementObserved: Promise<void> | undefined;

    try {
      await waitForPresentationStatementLock();
      let settlementFinished = false;
      const settlement = applyWalletTopupEvidence(ctx.db, evidenceFor(topup));
      settlementObserved = settlement.then(
        () => {
          settlementFinished = true;
        },
        () => {
          settlementFinished = true;
        },
      );
      const observedLockInversion = await waitForWalletAccountLock(() => settlementFinished);
      releaseLock.resolve();

      const [replacementResult, settlementResult] = await Promise.all([replacement, settlement]);
      await settlementObserved;
      expect(observedLockInversion).toBe(false);
      expect(replacementResult.ok).toBe(true);
      expect(settlementResult).toMatchObject({ ok: true, kind: "CREDITED" });
    } finally {
      releaseLock.resolve();
      await blocker;
      await Promise.allSettled([replacement, ...(settlementObserved ? [settlementObserved] : [])]);
      await sql
        .raw(
          `
        drop trigger if exists test_pause_wallet_topup_update on wallet_topup_intent;
        drop function if exists test_pause_wallet_topup_update();
      `,
        )
        .execute(ctx.db);
    }
  }, 15_000);

  it("does not credit a matching live topup when bank identity is ambiguous", async () => {
    const topup = await seedPresentedTopup();
    const reference = "FT-" + newId().slice(-6);
    const transactedAt = new Date();
    const firstCandidate = evidenceFor(topup, {
      providerTransactionId: "SEPAY-CANDIDATE-" + newId(),
      reference,
      transactedAt,
    });
    const secondCandidate = evidenceFor(topup, {
      providerTransactionId: "SEPAY-CANDIDATE-" + newId(),
      reference,
      transactedAt: new Date(transactedAt.getTime() + 30_000),
    });

    const first = await withTransaction(ctx.db, (trx) =>
      insertBankTransactionIfNew(trx, firstCandidate, "VERIFIED", "sepay.v1"),
    );
    const second = await withTransaction(ctx.db, (trx) =>
      insertBankTransactionIfNew(trx, secondCandidate, "VERIFIED", "sepay.v1"),
    );
    expect(first).toMatchObject({ kind: "INSERTED" });
    expect(second).toMatchObject({ kind: "AMBIGUOUS" });
    if (first.kind !== "INSERTED" || second.kind !== "AMBIGUOUS") {
      throw new Error("expected two distinct correlation candidates");
    }
    expect(second.candidateIds).toEqual([first.id]);

    const arrival = evidenceFor(topup, {
      providerTransactionId: "api:" + newId(),
      reference,
      transactedAt: new Date(transactedAt.getTime() + 60_000),
    });
    await expect(applyWalletTopupEvidence(ctx.db, arrival)).resolves.toEqual({
      ok: true,
      kind: "NEEDS_REVIEW",
    });

    const rows = await sql<{
      status: string;
      balance_vnd: string;
      ledger_count: string;
      credit_count: string;
      credited_events: string;
      bank_txns: string;
      review_count: string;
    }>`
      select
        (select status from wallet_topup_intent where id = ${topup.intentId}) as status,
        (select balance_vnd::text from wallet_account where customer_id = ${topup.customerId}) as balance_vnd,
        (
          select count(*)::text
          from wallet_ledger l
          join wallet_account a on a.id = l.wallet_account_id
          where a.customer_id = ${topup.customerId}
        ) as ledger_count,
        (
          select count(*)::text
          from wallet_ledger l
          join wallet_account a on a.id = l.wallet_account_id
          where a.customer_id = ${topup.customerId} and l.entry_type = 'CREDIT'
        ) as credit_count,
        (
          select count(*)::text
          from outbox_event
          where aggregate_id = ${topup.intentId} and event_type = 'WalletTopupCredited'
        ) as credited_events,
        (select count(*)::text from bank_transaction where provider = 'sepay') as bank_txns,
        (
          select count(*)::text
          from discrepancy
          where type = 'AMBIGUOUS_CORRELATION'
        ) as review_count
    `.execute(ctx.db);

    expect(rows.rows[0]).toEqual({
      status: "NEEDS_REVIEW",
      balance_vnd: "0",
      ledger_count: "0",
      credit_count: "0",
      credited_events: "0",
      bank_txns: "3",
      review_count: "1",
    });
    const review = await sql<{ type: string; reason: string }>`
      select type, reason from discrepancy where type = 'AMBIGUOUS_CORRELATION'
    `.execute(ctx.db);
    expect(review.rows).toHaveLength(1);
    expect(review.rows[0]?.type).toBe("AMBIGUOUS_CORRELATION");
    expect(review.rows[0]?.reason).toContain(first.id);
    expect(review.rows[0]?.reason).toContain(second.id);
  });

  it("credits a concurrent duplicate topup replay once and emits one credit event", async () => {
    const topup = await seedPresentedTopup();
    const providerTransactionId = "SEPAY-DUP-" + newId();
    const evidence = evidenceFor(topup, { providerTransactionId });

    const results = await Promise.all([
      applyWalletTopupEvidence(ctx.db, evidence),
      applyWalletTopupEvidence(ctx.db, evidence),
    ]);

    expect(results).toContainEqual({ ok: true, kind: "CREDITED" });
    expect(results).toContainEqual({ ok: true, kind: "ALREADY_APPLIED" });

    const rows = await sql<{
      balance_vnd: string;
      ledger_count: string;
      ledger_sum: string | null;
      credit_count: string;
      credited_events: string;
      bank_txns: string;
      status: string;
    }>`
      select
        (select balance_vnd::text from wallet_account where customer_id = ${topup.customerId}) as balance_vnd,
        (select count(*)::text from wallet_ledger where idempotency_key = ${`topup:${topup.intentId}:${providerTransactionId}`}) as ledger_count,
        (select sum(amount_vnd)::text from wallet_ledger where idempotency_key = ${`topup:${topup.intentId}:${providerTransactionId}`}) as ledger_sum,
        (select count(*)::text from wallet_ledger where idempotency_key = ${`topup:${topup.intentId}:${providerTransactionId}`} and entry_type = 'CREDIT' and balance_before_vnd = 0 and balance_after_vnd = 150000) as credit_count,
        (select count(*)::text from outbox_event where aggregate_id = ${topup.intentId} and event_type = 'WalletTopupCredited') as credited_events,
        (select count(*)::text from bank_transaction where provider = 'sepay' and provider_transaction_id = ${providerTransactionId}) as bank_txns,
        (select status from wallet_topup_intent where id = ${topup.intentId}) as status
    `.execute(ctx.db);

    expect(rows.rows[0]).toEqual({
      balance_vnd: "150000",
      ledger_count: "1",
      ledger_sum: "150000",
      credit_count: "1",
      credited_events: "1",
      bank_txns: "1",
      status: "SUCCEEDED",
    });
  });

  it.each([
    ["underpayment", -1, "NEEDS_REVIEW", "0", "0"],
    ["exact amount", 0, "SUCCEEDED", "1", "150000"],
    ["overpayment", 1, "NEEDS_REVIEW", "0", "0"],
  ] as const)(
    "applies the topup amount boundary for %s",
    async (_label, delta, status, ledgerCount, balance) => {
      const topup = await seedPresentedTopup();
      const result = await applyWalletTopupEvidence(
        ctx.db,
        evidenceFor(topup, { amountVnd: topup.presentation.amountVnd + delta }),
      );

      expect(result).toEqual({
        ok: true,
        kind: status === "SUCCEEDED" ? "CREDITED" : "NEEDS_REVIEW",
      });

      const rows = await sql<{
        status: string;
        ledger_count: string;
        balance_vnd: string;
      }>`
        select
          (select status from wallet_topup_intent where id = ${topup.intentId}) as status,
          (select count(*)::text from wallet_ledger where idempotency_key like ${`topup:${topup.intentId}:%`}) as ledger_count,
          (select balance_vnd::text from wallet_account where customer_id = ${topup.customerId}) as balance_vnd
      `.execute(ctx.db);

      expect(rows.rows[0]).toEqual({ status, ledger_count: ledgerCount, balance_vnd: balance });
    },
  );

  it("cancels only unpaid live topup and preserves a succeeded topup ledger credit", async () => {
    const succeeded = await seedPresentedTopup(150_000n);
    const providerTransactionId = "SEPAY-CREDIT-" + newId();
    await expect(
      applyWalletTopupEvidence(ctx.db, evidenceFor(succeeded, { providerTransactionId })),
    ).resolves.toEqual({ ok: true, kind: "CREDITED" });

    const unpaid = await presentWalletTopup({
      db: ctx.db,
      customerId: succeeded.customerId,
      amountVnd: 200_000n,
      merchantAccountId: "0123456789",
      beneficiaryAccountNumber: "0123456789",
      bankBin: "970422",
      accountName: "BOT TELE",
      correlationId: "present-unpaid-" + newId().slice(-8),
    });
    expect(unpaid.ok).toBe(true);
    if (!unpaid.ok) throw new Error(unpaid.error);

    await expect(
      cancelLiveWalletTopup({ db: ctx.db, customerId: succeeded.customerId }),
    ).resolves.toEqual({ cancelled: true });

    const rows = await sql<{
      succeeded_status: string;
      unpaid_status: string;
      balance_vnd: string;
      ledger_sum: string | null;
      credit_count: string;
    }>`
      select
        (select status from wallet_topup_intent where id = ${succeeded.intentId}) as succeeded_status,
        (select status from wallet_topup_intent where id = ${unpaid.intentId}) as unpaid_status,
        (select balance_vnd::text from wallet_account where customer_id = ${succeeded.customerId}) as balance_vnd,
        (
          select sum(l.amount_vnd)::text
          from wallet_ledger l
          join wallet_account a on a.id = l.wallet_account_id
          where a.customer_id = ${succeeded.customerId}
        ) as ledger_sum,
        (
          select count(*)::text
          from wallet_ledger l
          join wallet_account a on a.id = l.wallet_account_id
          where a.customer_id = ${succeeded.customerId} and l.entry_type = 'CREDIT'
        ) as credit_count
    `.execute(ctx.db);

    expect(rows.rows[0]).toEqual({
      succeeded_status: "SUCCEEDED",
      unpaid_status: "EXPIRED",
      balance_vnd: "150000",
      ledger_sum: "150000",
      credit_count: "1",
    });
  });
});
