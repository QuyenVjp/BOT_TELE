import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { newId } from "../../src/shared/ids/index.js";
import { applyPaymentEvidence } from "../../src/modules/payments/service.js";
import type { PaymentEvidence } from "../../src/modules/payments/domain.js";
import type { VerifiedSePayEvidence } from "../../src/modules/payments/sepay-ingress.js";
import {
  attachBankTransactionAliases,
  bankTransactionCorrelationKey,
} from "../../src/modules/payments/repository.js";
import {
  reconcileSePay,
  type SePayReconciliationPort,
} from "../../src/modules/payments/reconciliation.js";
import {
  dockerAvailable,
  startPostgresContainer,
  type PgTestContext,
} from "../helpers/pg-container.js";
import { verifiedSePayEvidence } from "../helpers/verified-sepay.js";

/**
 * Cross-source SePay identity: one physical transfer, one canonical row.
 *
 * The webhook carries an integer id (`92704`); the API v2 transaction list
 * carries a UUID (`api:…`). SePay documents no translation between the two and
 * no API v2 lookup by webhook id, so before this feature the second surface
 * inserted a SECOND bank_transaction row for the same money — and the intent it
 * then failed to settle (already settled by the sibling row) surfaced as a
 * spurious `UNMATCHED` / "intent not settleable" operator incident instead of
 * settled revenue.
 *
 * Every case below uses REAL provider id shapes and runs against a real
 * PostgreSQL: `tests/helpers/verified-sepay.ts` still crosses the real
 * HMAC/schema verifier, so nothing here bypasses the trust boundary.
 */

const hasDocker = await dockerAvailable();
let ctx: PgTestContext;

beforeAll(async () => {
  if (hasDocker) ctx = await startPostgresContainer();
}, 180_000);

afterAll(async () => {
  await ctx?.teardown();
});

beforeEach(async () => {
  await sql`truncate table bank_transaction_alias, outbox_event, payment_allocation, discrepancy, bank_transaction, payment_intent, order_transition, "order", product_variant, product, category, customer cascade`.execute(
    ctx.db,
  );
});

interface Fixture {
  orderId: string;
  intentId: string;
  content: string;
  amount: number;
  account: string;
}

/** The physical facts of one bank transfer, shared across both provider surfaces. */
interface Transfer {
  account: string;
  amount: number;
  content: string;
  reference: string | null;
  transactedAt: Date;
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

function transferOf(f: Fixture, reference: string | null, transactedAt: Date): Transfer {
  return {
    account: f.account,
    amount: f.amount,
    content: f.content,
    reference,
    transactedAt,
  };
}

/** A bank reference code scoped to this fixture, shaped like a real one. */
function referenceFor(f: Fixture): string {
  return "FT" + f.orderId.slice(-10).toUpperCase();
}

let webhookSequence = 92_700;

/** The webhook surface identifies a transfer with an integer id. */
function nextWebhookId(): string {
  webhookSequence += 1;
  return String(webhookSequence);
}

/** The API v2 surface identifies the same transfer with a UUID. */
function nextApiId(): string {
  return "api:" + randomUUID();
}

function evidenceFor(
  transfer: Transfer,
  providerTransactionId: string,
  overrides: Partial<PaymentEvidence> = {},
): VerifiedSePayEvidence {
  return verifiedSePayEvidence({
    provider: "sepay",
    providerTransactionId,
    direction: "IN",
    merchantAccountId: transfer.account,
    amountVnd: transfer.amount,
    content: transfer.content,
    reference: transfer.reference,
    transactedAt: transfer.transactedAt,
    rawHash: "hash-" + newId(),
    correlationId: "corr-" + newId().slice(-6),
    ...overrides,
  });
}

function portOf(txns: VerifiedSePayEvidence[]): SePayReconciliationPort {
  return {
    listTransactions() {
      return Promise.resolve(txns);
    },
  };
}

async function countBankTransactions(): Promise<number> {
  const r = await sql<{
    count: string;
  }>`select count(*)::text as count from bank_transaction`.execute(ctx.db);
  return Number(r.rows[0]?.count);
}

async function countSettledAllocations(): Promise<number> {
  const r = await sql<{
    count: string;
  }>`select count(*)::text as count from payment_allocation where status = 'SETTLED'`.execute(
    ctx.db,
  );
  return Number(r.rows[0]?.count);
}

async function countAliases(): Promise<number> {
  const r = await sql<{
    count: string;
  }>`select count(*)::text as count from bank_transaction_alias`.execute(ctx.db);
  return Number(r.rows[0]?.count);
}

async function countDiscrepancies(type: string): Promise<number> {
  const r = await sql<{ count: string }>`
    select count(*)::text as count from discrepancy where type = ${type}
  `.execute(ctx.db);
  return Number(r.rows[0]?.count);
}

async function orderStatus(orderId: string): Promise<string | undefined> {
  const r = await sql<{ status: string }>`select status from "order" where id = ${orderId}`.execute(
    ctx.db,
  );
  return r.rows[0]?.status;
}

async function aliasesOf(
  bankTransactionId: string,
): Promise<{ alias_type: string; alias_value: string }[]> {
  const r = await sql<{ alias_type: string; alias_value: string }>`
    select alias_type, alias_value from bank_transaction_alias
    where bank_transaction_id = ${bankTransactionId}
    order by alias_type
  `.execute(ctx.db);
  return r.rows;
}

async function onlyBankTransactionId(): Promise<string> {
  const r = await sql<{ id: string }>`select id from bank_transaction`.execute(ctx.db);
  const id = r.rows[0]?.id;
  if (!id) throw new Error("expected exactly one bank_transaction row");
  return id;
}

describe.skipIf(!hasDocker)("SePay cross-source transaction identity", () => {
  it("1. keeps one canonical row when the webhook arrives before API v2", async () => {
    const f = await seedPayableOrder();
    const at = new Date();
    const reference = referenceFor(f);
    const webhook = evidenceFor(transferOf(f, reference, at), nextWebhookId());
    const api = evidenceFor(transferOf(f, reference, new Date(at.getTime() + 1_000)), nextApiId());

    expect(await applyPaymentEvidence(ctx.db, webhook)).toMatchObject({
      ok: true,
      kind: "SETTLED",
    });
    // The API v2 surface describes the SAME money: it resolves to the row the
    // webhook wrote instead of inserting a second one.
    expect(await applyPaymentEvidence(ctx.db, api)).toMatchObject({
      ok: true,
      kind: "ALREADY_APPLIED",
    });

    expect(await countBankTransactions()).toBe(1);
    expect(await countSettledAllocations()).toBe(1);
    expect(await orderStatus(f.orderId)).toBe("PAID");
    // Both provider ids are recorded against the one canonical row.
    expect(await aliasesOf(await onlyBankTransactionId())).toEqual([
      { alias_type: "api_v2_uuid", alias_value: api.providerTransactionId.slice(4) },
      { alias_type: "webhook_legacy_id", alias_value: webhook.providerTransactionId },
    ]);
    // The row was stored under the shared correlation key.
    const stored = await sql<{ correlation_key: string | null }>`
      select correlation_key from bank_transaction
    `.execute(ctx.db);
    expect(stored.rows[0]?.correlation_key).toBe(
      bankTransactionCorrelationKey({
        merchantAccountId: f.account,
        direction: "IN",
        amountVnd: f.amount,
        reference,
      }),
    );
    // The bug this feature removes: no spurious UNMATCHED operator incident.
    expect(await countDiscrepancies("UNMATCHED")).toBe(0);

    // Reconciliation now counts the second surface as already present.
    const summary = await reconcileSePay(ctx.db, {
      port: portOf([api]),
      windowFromSec: 0,
      windowToSec: Math.floor(Date.now() / 1000),
    });
    expect(summary).toMatchObject({
      scanned: 1,
      recovered: 0,
      alreadyPresent: 1,
      ambiguousCorrelations: 0,
      discrepancies: 0,
    });
    expect(await countBankTransactions()).toBe(1);
  });

  it("2. keeps one canonical row when API v2 arrives before the webhook", async () => {
    const f = await seedPayableOrder();
    const at = new Date();
    const reference = referenceFor(f);
    const api = evidenceFor(transferOf(f, reference, at), nextApiId());
    const webhook = evidenceFor(
      transferOf(f, reference, new Date(at.getTime() + 2_000)),
      nextWebhookId(),
    );

    expect(await applyPaymentEvidence(ctx.db, api)).toMatchObject({ ok: true, kind: "SETTLED" });
    expect(await applyPaymentEvidence(ctx.db, webhook)).toMatchObject({
      ok: true,
      kind: "ALREADY_APPLIED",
    });

    expect(await countBankTransactions()).toBe(1);
    expect(await countSettledAllocations()).toBe(1);
    expect(await orderStatus(f.orderId)).toBe("PAID");
    expect(await aliasesOf(await onlyBankTransactionId())).toEqual([
      { alias_type: "api_v2_uuid", alias_value: api.providerTransactionId.slice(4) },
      { alias_type: "webhook_legacy_id", alias_value: webhook.providerTransactionId },
    ]);
    expect(await countDiscrepancies("UNMATCHED")).toBe(0);
  });

  it("3. keeps one canonical row when both surfaces arrive concurrently", async () => {
    const f = await seedPayableOrder();
    const at = new Date();
    const reference = referenceFor(f);
    const webhook = evidenceFor(transferOf(f, reference, at), nextWebhookId());
    const api = evidenceFor(transferOf(f, reference, at), nextApiId());

    const results = await Promise.all([
      applyPaymentEvidence(ctx.db, webhook),
      applyPaymentEvidence(ctx.db, api),
    ]);

    // Exactly one settlement, the other surface recognised as already applied.
    expect(results.filter((r) => r.ok && r.kind === "SETTLED")).toHaveLength(1);
    expect(results.filter((r) => r.ok && r.kind === "ALREADY_APPLIED")).toHaveLength(1);
    expect(await countBankTransactions()).toBe(1);
    expect(await countSettledAllocations()).toBe(1);
    expect(await countAliases()).toBe(2);
    expect(await countDiscrepancies("UNMATCHED")).toBe(0);
  });

  it("4. does not correlate the same reference on a different account", async () => {
    const f = await seedPayableOrder();
    const at = new Date();
    const reference = referenceFor(f);
    const first = evidenceFor(transferOf(f, reference, at), nextWebhookId());
    const other = evidenceFor(
      { ...transferOf(f, reference, at), account: "9999999999" },
      nextWebhookId(),
    );

    expect(await applyPaymentEvidence(ctx.db, first)).toMatchObject({ kind: "SETTLED" });
    await applyPaymentEvidence(ctx.db, other);

    // The key is account-scoped: a reference that repeats on another account is
    // a different transfer, and both rows survive.
    expect(await countBankTransactions()).toBe(2);
    expect(await countSettledAllocations()).toBe(1);
  });

  it("5. does not correlate the same amount and time with a different reference", async () => {
    const f = await seedPayableOrder();
    const at = new Date();
    const first = evidenceFor(transferOf(f, referenceFor(f), at), nextWebhookId());
    const second = evidenceFor(
      transferOf(f, "FT" + newId().slice(-10).toUpperCase(), new Date(at.getTime() + 5_000)),
      nextWebhookId(),
    );

    expect(await applyPaymentEvidence(ctx.db, first)).toMatchObject({ kind: "SETTLED" });
    await applyPaymentEvidence(ctx.db, second);

    expect(await countBankTransactions()).toBe(2);
    expect(await countSettledAllocations()).toBe(1);
  });

  it("6. never correlates without a bank reference (the conservative branch)", async () => {
    const f = await seedPayableOrder();
    const at = new Date();
    const blank = evidenceFor(transferOf(f, null, at), nextWebhookId());
    const whitespace = evidenceFor(
      transferOf(f, "   ", new Date(at.getTime() + 1_000)),
      nextWebhookId(),
    );

    expect(await applyPaymentEvidence(ctx.db, blank)).toMatchObject({ kind: "SETTLED" });
    await applyPaymentEvidence(ctx.db, whitespace);

    // Amount + time alone could join two legitimate transfers, so with no
    // reference there is no key at all and nothing is merged.
    expect(await countBankTransactions()).toBe(2);
    const keys = await sql<{ correlation_key: string | null }>`
      select correlation_key from bank_transaction order by transacted_at
    `.execute(ctx.db);
    expect(keys.rows.every((row) => row.correlation_key === null)).toBe(true);
    expect(await countSettledAllocations()).toBe(1);
  });

  it("7. reports AMBIGUOUS without merging when several rows share the key", async () => {
    const f = await seedPayableOrder();
    const at = new Date();
    const reference = referenceFor(f);
    const settled = evidenceFor(transferOf(f, reference, at), nextWebhookId());
    expect(await applyPaymentEvidence(ctx.db, settled)).toMatchObject({ kind: "SETTLED" });
    const firstId = await onlyBankTransactionId();

    // A historical duplicate row carrying the same correlation key (the shape a
    // pre-migration database can legitimately hold: the backfill labels it and
    // never merges it).
    const historicalId = newId();
    const historicalProviderTransactionId = nextApiId();
    await sql`
      insert into bank_transaction
        (id, provider, provider_transaction_id, direction, merchant_account_id, amount_vnd,
         content, reference, transacted_at, raw_hash, signature_status, schema_version,
         correlation_key)
      values
        (${historicalId}, 'sepay', ${historicalProviderTransactionId}, 'IN', ${f.account}, ${f.amount},
         ${f.content}, ${reference}, ${new Date(at.getTime() + 30_000).toISOString()},
         ${"hash-" + newId()}, 'VERIFIED', 'sepay.v1',
         ${bankTransactionCorrelationKey({
           merchantAccountId: f.account,
           direction: "IN",
           amountVnd: f.amount,
           reference,
         })})
    `.execute(ctx.db);
    // Label it the way migration 066's backfill labels history.
    await attachBankTransactionAliases(ctx.db, historicalId, "sepay", [
      {
        aliasType: "api_v2_uuid",
        aliasValue: historicalProviderTransactionId.slice(4),
      },
    ]);

    const arrival = evidenceFor(
      transferOf(f, reference, new Date(at.getTime() + 60_000)),
      nextWebhookId(),
    );
    const result = await applyPaymentEvidence(ctx.db, arrival);

    expect(result).toMatchObject({ ok: true, kind: "AMBIGUOUS_CORRELATION" });
    if (!result.ok || result.kind !== "AMBIGUOUS_CORRELATION") {
      throw new Error("expected an ambiguous correlation result");
    }
    expect([...result.candidateIds].sort()).toEqual([firstId, historicalId].sort());

    // Nothing merged, nothing dropped: the arrival is a third row with its alias.
    expect(await countBankTransactions()).toBe(3);
    expect(await countAliases()).toBe(3);
    const review = await sql<{ type: string; reason: string }>`
      select type, reason from discrepancy order by type
    `.execute(ctx.db);
    expect(review.rows).toHaveLength(1);
    expect(review.rows[0]?.type).toBe("AMBIGUOUS_CORRELATION");
    expect(review.rows[0]?.reason).toContain(firstId);
    expect(review.rows[0]?.reason).toContain(historicalId);
    // The failure mode this replaces: a settled payment reported as UNMATCHED.
    expect(await countDiscrepancies("UNMATCHED")).toBe(0);
    expect(await countSettledAllocations()).toBe(1);
    expect(await orderStatus(f.orderId)).toBe("PAID");
  });

  it("8. cannot point one alias value at a second canonical row", async () => {
    const firstId = newId();
    const secondId = newId();
    for (const id of [firstId, secondId]) {
      await sql`
        insert into bank_transaction
          (id, provider, provider_transaction_id, direction, merchant_account_id, amount_vnd,
           content, reference, transacted_at, raw_hash, signature_status, schema_version)
        values
          (${id}, 'sepay', ${"ptx-" + id}, 'IN', ${"0123456789"}, ${150000},
           null, null, now(), ${"hash-" + id}, 'VERIFIED', 'sepay.v1')
      `.execute(ctx.db);
    }

    await attachBankTransactionAliases(ctx.db, firstId, "sepay", [
      { aliasType: "webhook_legacy_id", aliasValue: "888888" },
    ]);
    // The same alias offered for another row is a no-op, not a re-point.
    await attachBankTransactionAliases(ctx.db, secondId, "sepay", [
      { aliasType: "webhook_legacy_id", aliasValue: "888888" },
    ]);

    const mapped = await sql<{ bank_transaction_id: string }>`
      select bank_transaction_id from bank_transaction_alias
      where provider = 'sepay' and alias_type = 'webhook_legacy_id' and alias_value = '888888'
    `.execute(ctx.db);
    expect(mapped.rows).toEqual([{ bank_transaction_id: firstId }]);
    expect(await countAliases()).toBe(1);

    // Even a direct insert cannot steal the mapping.
    await expect(
      sql`
        insert into bank_transaction_alias
          (id, bank_transaction_id, provider, alias_type, alias_value)
        values (${newId()}, ${secondId}, 'sepay', 'webhook_legacy_id', '888888')
      `.execute(ctx.db),
    ).rejects.toThrow();
    expect(await countAliases()).toBe(1);
  });

  it("9. treats a redelivered webhook with the same body as a duplicate", async () => {
    const f = await seedPayableOrder();
    const webhook = evidenceFor(transferOf(f, referenceFor(f), new Date()), nextWebhookId());

    expect(await applyPaymentEvidence(ctx.db, webhook)).toMatchObject({ kind: "SETTLED" });
    expect(await applyPaymentEvidence(ctx.db, webhook)).toMatchObject({
      ok: true,
      kind: "ALREADY_APPLIED",
    });

    expect(await countBankTransactions()).toBe(1);
    expect(await countAliases()).toBe(1);
    expect(await countSettledAllocations()).toBe(1);
    expect(await countDiscrepancies("REFERENCE_COLLISION")).toBe(0);
  });

  it("10. keeps REFERENCE_COLLISION for a mutated body under the same webhook id", async () => {
    const f = await seedPayableOrder();
    const original = evidenceFor(transferOf(f, referenceFor(f), new Date()), nextWebhookId());
    expect(await applyPaymentEvidence(ctx.db, original)).toMatchObject({ kind: "SETTLED" });

    const mutated = verifiedSePayEvidence({
      ...original,
      content: "NOI DUNG DA BI SUA",
      rawHash: "mutated-raw-hash",
    });
    expect(await applyPaymentEvidence(ctx.db, mutated)).toMatchObject({
      ok: true,
      kind: "DISCREPANCY",
      type: "REFERENCE_COLLISION",
    });

    expect(await countBankTransactions()).toBe(1);
    expect(await countSettledAllocations()).toBe(1);
  });

  it("11. agrees with the SQL backfill formula on the same inputs", async () => {
    const account = "0123456789";
    const amount = 150000;
    const cases: (string | null)[] = [
      null,
      "",
      "   ",
      "  ft  123  ",
      "ft\t456",
      "677760.050523.080001",
    ];

    const ids: string[] = [];
    for (const reference of cases) {
      const id = newId();
      ids.push(id);
      await sql`
        insert into bank_transaction
          (id, provider, provider_transaction_id, direction, merchant_account_id, amount_vnd,
           content, reference, transacted_at, raw_hash, signature_status, schema_version)
        values
          (${id}, 'sepay', ${"agree-" + id}, 'IN', ${account}, ${amount},
           null, ${reference}, now(), ${"hash-" + id}, 'VERIFIED', 'sepay.v1')
      `.execute(ctx.db);
    }

    // The exact statement migration 066 runs for its backfill.
    await sql`
      update bank_transaction
      set correlation_key = bank_transaction_correlation_key(
            merchant_account_id, direction, amount_vnd, reference
          )
      where correlation_key is null
    `.execute(ctx.db);

    for (let index = 0; index < cases.length; index += 1) {
      const reference = cases[index]!;
      const expected = bankTransactionCorrelationKey({
        merchantAccountId: account,
        direction: "IN",
        amountVnd: amount,
        reference,
      });
      const stored = await sql<{ correlation_key: string | null }>`
        select correlation_key from bank_transaction where id = ${ids[index]}
      `.execute(ctx.db);
      expect(stored.rows[0]?.correlation_key, `stored key for ${JSON.stringify(reference)}`).toBe(
        expected,
      );
      const direct = await sql<{ key: string | null }>`
        select bank_transaction_correlation_key(
          ${account}::text, 'IN'::text, ${amount}::bigint, ${reference}::text
        ) as key
      `.execute(ctx.db);
      expect(direct.rows[0]?.key, `SQL key for ${JSON.stringify(reference)}`).toBe(expected);
    }

    // No reference ⇒ no key ⇒ nothing to correlate on.
    expect(
      bankTransactionCorrelationKey({
        merchantAccountId: account,
        direction: "IN",
        amountVnd: amount,
        reference: null,
      }),
    ).toBeNull();
  });
  it("does NOT merge two genuine same-surface transfers that share the key", async () => {
    // One surface cannot report one transfer twice (a repeat carries the same provider id and
    // is caught earlier), so two rows from the SAME surface are two physical transfers. A
    // customer paying the same amount twice, minutes apart, with a bank reference the bank
    // happened to repeat, must keep both payments — collapsing them would silently swallow
    // the second one.
    const f = await seedPayableOrder();
    const at = new Date();
    const reference = referenceFor(f);
    const first = evidenceFor(transferOf(f, reference, at), nextWebhookId());
    expect(await applyPaymentEvidence(ctx.db, first)).toMatchObject({ kind: "SETTLED" });

    // Same account, amount, direction and reference, two seconds later: the correlation key
    // matches, but it is a DIFFERENT transfer reported by the same surface.
    const second = evidenceFor(
      transferOf(f, reference, new Date(at.getTime() + 2_000)),
      nextWebhookId(),
    );
    await applyPaymentEvidence(ctx.db, second);

    expect(await countBankTransactions()).toBe(2);
  });

  it("labels every historical row, including ids that are neither numeric nor api:", async () => {
    // The backfill must not skip an id shape. A row left without an alias is invisible to the
    // alias step of ingestion, which is where cross-surface linking starts.
    const historicalId = newId();
    const historicalProviderId = "SEPAY-" + randomUUID();
    await sql`
      insert into bank_transaction
        (id, provider, provider_transaction_id, direction, merchant_account_id, amount_vnd,
         content, reference, transacted_at, raw_hash, signature_status, schema_version)
      values
        (${historicalId}, 'sepay', ${historicalProviderId}, 'IN', 'acct-legacy', 1000,
         'legacy', 'REF-LEGACY', now(), ${"hash-" + newId()}, 'VERIFIED', 'sepay.v1')
    `.execute(ctx.db);

    // Re-running the labelling statement the migration uses must label it too.
    await sql`
      insert into bank_transaction_alias (id, bank_transaction_id, provider, alias_type, alias_value)
      select gen_random_uuid()::text, bt.id, bt.provider,
             case when bt.provider_transaction_id like 'api:%' then 'api_v2_uuid'
                  else 'webhook_legacy_id' end,
             case when bt.provider_transaction_id like 'api:%' then substr(bt.provider_transaction_id, 5)
                  else bt.provider_transaction_id end
      from bank_transaction bt
      where length(bt.provider_transaction_id) > 0
      on conflict (provider, alias_type, alias_value) do nothing
    `.execute(ctx.db);

    const labelled = await sql<{ n: number }>`
      select count(*)::int as n from bank_transaction_alias where bank_transaction_id = ${historicalId}
    `.execute(ctx.db);
    expect(labelled.rows[0]?.n).toBe(1);
  });
});
