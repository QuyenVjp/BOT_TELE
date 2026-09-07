import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "kysely";
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
