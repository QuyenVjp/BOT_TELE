import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { newId } from "../../src/shared/ids/index.js";
import { applyPaymentEvidence } from "../../src/modules/payments/service.js";
import type { PaymentEvidence } from "../../src/modules/payments/domain.js";
import type { VerifiedSePayEvidence } from "../../src/modules/payments/sepay-ingress.js";
import type { SePayReconciliationPort } from "../../src/modules/payments/reconciliation.js";
import { SePayApiError } from "../../src/modules/payments/sepay-api.js";
import {
  PAYMENT_CHECK_COOLDOWN_SECONDS,
  reconcileForPaymentCheck,
} from "../../src/modules/payments/check-now.js";
import { startPostgresContainer, type PgTestContext } from "../helpers/pg-container.js";
import { verifiedSePayEvidence } from "../helpers/verified-sepay.js";

/**
 * S3 — "Kiểm tra thanh toán": the on-demand check behind the checkout button.
 *
 * The click must be a real check (a matching provider transfer settles the order
 * through the SAME evidence pipeline as the webhook) and must stay cheap:
 *   - unconfigured provider → NOT_CONFIGURED, nothing written;
 *   - inside the cooldown → COOLDOWN, no provider call;
 *   - another runner holds the recovery advisory lock → IN_FLIGHT, no provider call;
 *   - provider failure → FAILED, order untouched, next click throttled;
 *   - five simultaneous clicks → at most one provider call;
 *   - a transfer the webhook already settled → no second allocation.
 */

/** The recovery advisory lock owned by `recoverSePayBatch` (not exported there). */
const SEPAY_RECOVERY_ADVISORY_LOCK = 7_021_680_412;

let ctx: PgTestContext;

beforeAll(async () => {
  ctx = await startPostgresContainer();
}, 180_000);

afterAll(async () => {
  await ctx?.teardown();
});

interface Fixture {
  orderId: string;
  intentId: string;
  content: string;
  amount: number;
  account: string;
}

async function seedPayableOrder(): Promise<Fixture> {
  const customerId = newId();
  const categoryId = newId();
  const productId = newId();
  const variantId = newId();
  const orderId = newId();
  const intentId = newId();
  const content = "ORD" + newId().slice(-12);
  const amount = 150000;
  const account = "0123456789";

  await sql`insert into customer (id, status, locale) values (${customerId}, 'ACTIVE', 'vi')`.execute(
    ctx.db,
  );
  const slug = categoryId.slice(-8);
  await sql`insert into category (id, name_vi, slug, is_active, sort_order) values (${categoryId}, 'C', ${slug}, true, 1)`.execute(
    ctx.db,
  );
  await sql`insert into product (id, category_id, name_vi, slug, is_active, sort_order) values (${productId}, ${categoryId}, 'P', ${slug}, true, 1)`.execute(
    ctx.db,
  );
  await sql`
    insert into product_variant (id, product_id, sku, name_vi, price_vnd, duration_code, delivery_type, stock_policy, resale_evidence_id)
    values (${variantId}, ${productId}, ${"SKU-" + variantId}, 'V', ${amount}, 'P1M', 'CREDENTIAL', 'LOCAL_ONLY', 'RES-1')
  `.execute(ctx.db);
  await sql`
    insert into "order" (id, order_number, customer_id, variant_id, product_name_vi, variant_name_vi,
      price_vnd, duration_code, delivery_type, status)
    values (${orderId}, ${"ORD-" + orderId}, ${customerId}, ${variantId}, 'P', 'V',
      ${amount}, 'P1M', 'CREDENTIAL', 'PENDING_PAYMENT')
  `.execute(ctx.db);
  await sql`
    insert into payment_intent (id, order_id, status, amount_vnd, merchant_account_id, transfer_content, expires_at)
    values (${intentId}, ${orderId}, 'PRESENTED', ${amount}, ${account}, ${content}, now() + interval '15 minutes')
  `.execute(ctx.db);

  return { orderId, intentId, content, amount, account };
}

function providerTxn(f: Fixture, over: Partial<PaymentEvidence> = {}): VerifiedSePayEvidence {
  return verifiedSePayEvidence({
    provider: "sepay",
    providerTransactionId: "api:" + randomUUID(),
    direction: "IN",
    merchantAccountId: f.account,
    amountVnd: f.amount,
    content: f.content,
    reference: "FT-" + newId().slice(-6),
    transactedAt: new Date(),
    rawHash: "hash-" + newId(),
    correlationId: "check-" + newId().slice(-6),
    ...over,
  });
}

let webhookSequence = 93_700;

/** The webhook surface identifies a transfer by INTEGER id (the legacy alias). */
function webhookTxn(f: Fixture, over: Partial<PaymentEvidence> = {}): VerifiedSePayEvidence {
  webhookSequence += 1;
  return providerTxn(f, { providerTransactionId: String(webhookSequence), ...over });
}

interface FakePort {
  port: SePayReconciliationPort;
  calls: number;
  txns: VerifiedSePayEvidence[];
}

/** No network: the provider surface is a fixed (mutable) list plus a call counter. */
function fakePort(txns: VerifiedSePayEvidence[]): FakePort {
  const fake: FakePort = {
    calls: 0,
    txns,
    port: {
      listTransactions: () => {
        fake.calls += 1;
        return Promise.resolve(fake.txns);
      },
    },
  };
  return fake;
}

async function orderStatus(orderId: string): Promise<string | undefined> {
  const r = await sql<{ status: string }>`select status from "order" where id = ${orderId}`.execute(
    ctx.db,
  );
  return r.rows[0]?.status;
}

async function intentStatus(intentId: string): Promise<string | undefined> {
  const r = await sql<{
    status: string;
  }>`select status from payment_intent where id = ${intentId}`.execute(ctx.db);
  return r.rows[0]?.status;
}

async function countSettledAllocations(): Promise<number> {
  const r = await sql<{ count: number }>`
    select count(*)::int as count from payment_allocation where status = 'SETTLED'
  `.execute(ctx.db);
  return r.rows[0]?.count ?? -1;
}

async function countBankTransactions(): Promise<number> {
  const r = await sql<{
    count: number;
  }>`select count(*)::int as count from bank_transaction`.execute(ctx.db);
  return r.rows[0]?.count ?? -1;
}

async function countDiscrepancies(): Promise<number> {
  const r = await sql<{ count: number }>`select count(*)::int as count from discrepancy`.execute(
    ctx.db,
  );
  return r.rows[0]?.count ?? -1;
}

async function lastStartedAtMs(): Promise<number | null> {
  const r = await sql<{ last_started_at: Date | string | null }>`
    select last_started_at
    from sepay_reconciliation_cursor
    where provider = 'sepay'
  `.execute(ctx.db);
  const value = r.rows[0]?.last_started_at;
  if (value === null || value === undefined) return null;
  return (value instanceof Date ? value : new Date(value)).getTime();
}

/** Hold the recovery advisory lock on its own connection, like a concurrent runner. */
async function holdRecoveryAdvisoryLock(): Promise<{ release(): Promise<void> }> {
  let acquired!: () => void;
  const ready = new Promise<void>((resolve) => {
    acquired = resolve;
  });
  let unlock!: () => void;
  const gate = new Promise<void>((resolve) => {
    unlock = resolve;
  });
  const done = ctx.db.connection().execute(async (connection) => {
    await sql`select pg_advisory_lock(${SEPAY_RECOVERY_ADVISORY_LOCK})`.execute(connection);
    acquired();
    await gate;
    await sql`select pg_advisory_unlock(${SEPAY_RECOVERY_ADVISORY_LOCK})`.execute(connection);
  });
  await ready;
  return {
    async release() {
      unlock();
      await done;
    },
  };
}

beforeEach(async () => {
  await sql`truncate table sepay_reconciliation_cursor, outbox_event, payment_allocation, discrepancy, bank_transaction, payment_intent, order_transition, "order", product_variant, product, category, customer cascade`.execute(
    ctx.db,
  );
});

describe("payment check (S3)", () => {
  it("reports NOT_CONFIGURED without touching the database when the port is absent", async () => {
    const f = await seedPayableOrder();
    const result = await reconcileForPaymentCheck(ctx.db, { port: null, now: new Date() });
    expect(result.reason).toBe("NOT_CONFIGURED");
    expect(await lastStartedAtMs()).toBeNull();
    expect(await orderStatus(f.orderId)).toBe("PENDING_PAYMENT");
    expect(await countSettledAllocations()).toBe(0);
  });

  it("RAN: a matching provider transfer settles the order through the shared pipeline", async () => {
    const f = await seedPayableOrder();
    const now = new Date();
    const fake = fakePort([providerTxn(f)]);

    const result = await reconcileForPaymentCheck(ctx.db, { port: fake.port, now });

    expect(result.reason).toBe("RAN");
    expect(fake.calls).toBe(1);
    expect(await orderStatus(f.orderId)).toBe("PAID");
    expect(await intentStatus(f.intentId)).toBe("SUCCEEDED");
    expect(await countSettledAllocations()).toBe(1);
    // The cooldown stamp is written from the caller's clock, before the provider call.
    expect(await lastStartedAtMs()).toBe(now.getTime());
  });

  it("COOLDOWN: clicks inside the window never reach the provider", async () => {
    const f = await seedPayableOrder();
    const now = new Date();
    const fake = fakePort([providerTxn(f)]);
    const check = (at: Date) => reconcileForPaymentCheck(ctx.db, { port: fake.port, now: at });

    expect((await check(now)).reason).toBe("RAN");
    expect((await check(now)).reason).toBe("COOLDOWN");
    const insideMs = now.getTime() + (PAYMENT_CHECK_COOLDOWN_SECONDS - 1) * 1000;
    expect((await check(new Date(insideMs))).reason).toBe("COOLDOWN");
    expect(fake.calls).toBe(1);

    // Past the window a fresh unpaid order is checked again. Without it the claim
    // would be 0 (the first order is already paid) and the reason would be IN_FLIGHT.
    const second = await seedPayableOrder();
    fake.txns = [providerTxn(second)];
    const outsideMs = now.getTime() + PAYMENT_CHECK_COOLDOWN_SECONDS * 1000;
    expect((await check(new Date(outsideMs))).reason).toBe("RAN");
    expect(fake.calls).toBe(2);
    expect(await orderStatus(second.orderId)).toBe("PAID");
  });

  it("IN_FLIGHT: a concurrent runner holding the advisory lock is not disturbed", async () => {
    const f = await seedPayableOrder();
    const fake = fakePort([providerTxn(f)]);
    const holder = await holdRecoveryAdvisoryLock();
    try {
      const result = await reconcileForPaymentCheck(ctx.db, { port: fake.port, now: new Date() });
      expect(result.reason).toBe("IN_FLIGHT");
      expect(fake.calls).toBe(0);
      expect(await orderStatus(f.orderId)).toBe("PENDING_PAYMENT");
    } finally {
      await holder.release();
    }
    // The losing attempt took the lock nowhere, so it must not throttle the next click.
    expect(await lastStartedAtMs()).toBeNull();
  });

  it("FAILED: a provider failure leaves the order unpaid and throttles the retry", async () => {
    const f = await seedPayableOrder();
    const now = new Date();
    let calls = 0;
    const port: SePayReconciliationPort = {
      listTransactions() {
        calls += 1;
        return Promise.reject(new SePayApiError("RATE_LIMITED", "provider rate limit", 5));
      },
    };

    expect((await reconcileForPaymentCheck(ctx.db, { port, now })).reason).toBe("FAILED");
    expect(calls).toBe(1);
    expect(await orderStatus(f.orderId)).toBe("PENDING_PAYMENT");
    expect(await intentStatus(f.intentId)).toBe("PRESENTED");
    expect(await countSettledAllocations()).toBe(0);
    expect(await countDiscrepancies()).toBe(0);
    expect(await lastStartedAtMs()).toBe(now.getTime());

    // The provider deadline still gates a retry even when the manual cooldown is disabled.
    expect(
      (
        await reconcileForPaymentCheck(ctx.db, {
          port,
          now: new Date(now.getTime() + 1_000),
          cooldownSeconds: 0,
        })
      ).reason,
    ).toBe("COOLDOWN");
    expect(calls).toBe(1);
    expect(
      (
        await reconcileForPaymentCheck(ctx.db, {
          port,
          now: new Date(now.getTime() + 6_000),
          cooldownSeconds: 0,
        })
      ).reason,
    ).toBe("FAILED");
    expect(calls).toBe(2);
  });
  it("collapses simultaneous clicks into a single provider call", async () => {
    const f = await seedPayableOrder();
    const txn = providerTxn(f);
    let calls = 0;
    let providerEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      providerEntered = resolve;
    });
    let openProvider!: () => void;
    const holdProvider = new Promise<void>((resolve) => {
      openProvider = resolve;
    });
    const port: SePayReconciliationPort = {
      async listTransactions() {
        calls += 1;
        providerEntered();
        await holdProvider;
        return [txn];
      },
    };

    let resolved = 0;
    let fourResolved!: () => void;
    const othersDone = new Promise<void>((resolve) => {
      fourResolved = resolve;
    });
    const now = new Date();
    const tasks = Array.from({ length: 5 }, () =>
      reconcileForPaymentCheck(ctx.db, { port, now }).then((result) => {
        resolved += 1;
        if (resolved === 4) fourResolved();
        return result.reason;
      }),
    );

    // The winner is parked inside the provider call, so it holds the advisory lock
    // while the other four attempt and fail to take it — a deterministic race.
    await entered;
    await othersDone;
    openProvider();
    const reasons = await Promise.all(tasks);

    expect(calls).toBe(1);
    expect(reasons.filter((reason) => reason === "RAN")).toHaveLength(1);
    expect(
      reasons.filter(
        (reason) => reason === "RAN" || reason === "IN_FLIGHT" || reason === "COOLDOWN",
      ),
    ).toHaveLength(5);
    expect(await countSettledAllocations()).toBe(1);
    expect(await orderStatus(f.orderId)).toBe("PAID");
  });

  it("never double-applies a transfer the webhook already settled", async () => {
    const settled = await seedPayableOrder();
    const pending = await seedPayableOrder();
    const at = new Date(Date.now() - 60_000);
    const reference = "FT-" + newId().slice(-6);
    // One physical transfer, two surfaces: the webhook recorded it by integer id,
    // the provider list exposes it as an API v2 UUID.
    const webhook = webhookTxn(settled, { reference, transactedAt: at });
    const api = providerTxn(settled, {
      reference,
      transactedAt: new Date(at.getTime() + 1_000),
    });

    expect(await applyPaymentEvidence(ctx.db, webhook)).toMatchObject({
      ok: true,
      kind: "SETTLED",
    });
    expect(await countSettledAllocations()).toBe(1);
    expect(await countBankTransactions()).toBe(1);

    // The click runs because `pending` is still owed; the re-seen transfer is a no-op.
    const fake = fakePort([api]);
    const result = await reconcileForPaymentCheck(ctx.db, { port: fake.port, now: new Date() });

    expect(result.reason).toBe("RAN");
    expect(fake.calls).toBe(1);
    expect(await countSettledAllocations()).toBe(1);
    expect(await countBankTransactions()).toBe(1);
    expect(await countDiscrepancies()).toBe(0);
    expect(await orderStatus(settled.orderId)).toBe("PAID");
    // Read-only: checking never invents a payment for an order it did not match.
    expect(await orderStatus(pending.orderId)).toBe("PENDING_PAYMENT");
  });
});
