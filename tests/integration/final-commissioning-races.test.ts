import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { newId } from "../../src/shared/ids/index.js";
import { enqueueOutboxEvent } from "../../src/infrastructure/outbox/repository.js";
import { withTransaction } from "../../src/infrastructure/db/transaction.js";
import {
  countAdminPublicationBlockers,
  getProductPublicationReadiness,
  publishProduct,
  registerResaleEvidence,
  type PublishProductResult,
} from "../../src/modules/catalog/publication.js";
import {
  getStoreMode,
  transitionStoreMode,
  transitionStoreModeInTransaction,
  type StoreModeTransitionResult,
} from "../../src/modules/commerce/store-mode.js";
import { startPostgresContainer, type PgTestContext } from "../helpers/pg-container.js";

let ctx: PgTestContext;

beforeAll(async () => {
  ctx = await startPostgresContainer();
}, 180_000);

afterAll(async () => {
  await ctx?.teardown();
});

beforeEach(async () => {
  await sql`
    truncate table audit_event, store_mode_transition, store_control, resale_evidence,
      digital_asset, product_variant, product, category, discrepancy, outbox_event,
      support_ticket, customer cascade
  `.execute(ctx.db);
  await sql`
    insert into store_control (id, status, updated_at, updated_by, version)
    values ('main', 'CLOSED', now(), 'system', 1)
  `.execute(ctx.db);
});

async function tick(): Promise<void> {
  const yielded = Promise.withResolvers<void>();
  setImmediate(yielded.resolve);
  await yielded.promise;
}

async function seedProduct(isTest: boolean): Promise<{ productId: string; variantId: string }> {
  const categoryId = newId();
  const productId = newId();
  const variantId = newId();
  await sql`
    insert into category (id, name_vi, slug, is_active, sort_order)
    values (${categoryId}, 'AI', ${`ai-${categoryId}`}, true, 1)
  `.execute(ctx.db);
  await sql`
    insert into product (id, category_id, name_vi, slug, is_active, sort_order, is_test, is_archived)
    values (${productId}, ${categoryId}, 'GPT Plus', ${`gpt-${productId}`}, true, 1, ${isTest}, false)
  `.execute(ctx.db);
  await sql`
    insert into product_variant
      (id, product_id, sku, name_vi, price_vnd, duration_code, delivery_type,
       fulfillment_type, warranty_days, stock_policy, is_active, sort_order)
    values
      (${variantId}, ${productId}, ${`GPT-${variantId}`}, '1 tháng', 250000, 'P1M', 'CREDENTIAL',
       'STOCK_ACCOUNT', 30, 'LOCAL_ONLY', true, 1)
  `.execute(ctx.db);
  await sql`
    insert into digital_asset (id, variant_id, source_type, vault_ref, fingerprint_hash, status)
    values (${newId()}, ${variantId}, 'TEST_FIXTURE', 'test-vault-ref', ${newId()}, 'AVAILABLE')
  `.execute(ctx.db);
  return { productId, variantId };
}

async function addEvidence(variantId: string, requestId: string) {
  const result = await registerResaleEvidence(ctx.db, {
    variantId,
    source: "OWNER_ATTESTATION",
    reference: `owner-ticket-${requestId}`,
    summary: "Owner verified supplier resale authorization.",
    requestId,
    actorId: "admin",
    reason: "Record resale evidence",
    correlationId: requestId,
  });
  if (!result.ok) throw new Error(result.message);
  return result;
}

async function waitForQueueContention(): Promise<"OPEN" | "BLOCKED"> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if ((await getStoreMode(ctx.db)) === "OPEN") return "OPEN";
    const waiting = await sql<{ count: string }>`
      select count(*)::text as count
        from pg_locks l
        join pg_class c on c.oid = l.relation
       where not l.granted
         and c.relname in ('discrepancy', 'outbox_event', 'support_ticket')
    `.execute(ctx.db);
    if (Number(waiting.rows[0]?.count ?? "0") > 0) return "BLOCKED";
    await tick();
  }
  throw new Error("queue gate did not reach an observable contention state");
}

async function waitForPublicationContention(): Promise<"STORE" | "PRODUCT"> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const locks = await sql<{
      store_waiting: string;
      advisory_waiting: string;
    }>`
      select
        count(*) filter (
          where l.locktype = 'transactionid'
            and a.wait_event = 'transactionid'
            and position('store_control' in a.query) > 0
        )::text as store_waiting,
        count(*) filter (where l.locktype = 'advisory')::text as advisory_waiting
        from pg_locks l
        left join pg_stat_activity a on a.pid = l.pid
       where not l.granted
    `.execute(ctx.db);
    if (Number(locks.rows[0]?.store_waiting ?? "0") > 0) return "STORE";
    if (Number(locks.rows[0]?.advisory_waiting ?? "0") > 0) return "PRODUCT";
    await tick();
  }
  throw new Error("publication did not reach an observable contention state");
}

async function expectConcurrentPublicationCount(count: number): Promise<void> {
  const fixture = await seedProduct(true);
  await addEvidence(fixture.variantId, `publication-idempotency-${count}`);
  const readiness = await getProductPublicationReadiness(ctx.db, fixture.productId);
  if (!readiness?.canPublish) throw new Error("publication fixture is not ready");

  const results = await Promise.all(
    Array.from({ length: count }, () =>
      publishProduct(ctx.db, {
        productId: fixture.productId,
        expectedPublicationVersion: readiness.publicationVersion,
        actorId: "admin",
        reason: "Concurrent publication idempotency test",
        correlationId: "publication-idempotency",
      }),
    ),
  );
  expect(results.filter((result) => result.ok && result.kind === "PUBLISHED")).toHaveLength(1);
  expect(
    results.every(
      (result) =>
        (result.ok && (result.kind === "PUBLISHED" || result.kind === "REPLAYED")) ||
        (!result.ok && result.code === "VERSION_CONFLICT"),
    ),
  ).toBe(true);
  const audits = await sql<{ count: string }>`
    select count(*)::text as count
      from audit_event
     where action = 'catalog.publish' and target_id = ${fixture.productId}
  `.execute(ctx.db);
  expect(audits.rows[0]?.count).toBe("1");
}

describe("final commissioning concurrency invariants", () => {
  it("includes blocked TEST products in operations publication count", async () => {
    await seedProduct(true);
    const readyTest = await seedProduct(true);
    await addEvidence(readyTest.variantId, "operations-ready-test");
    await seedProduct(false);

    expect(await countAdminPublicationBlockers(ctx.db)).toBe(2);
  });
  it("two operations cannot open while an actionable queue insert is uncommitted", async () => {
    const ready = await seedProduct(false);
    await addEvidence(ready.variantId, "queue-race-ready");
    const productReadiness = await getProductPublicationReadiness(ctx.db, ready.productId);
    if (!productReadiness?.canPublish) throw new Error("queue race fixture is not ready");
    const published = await publishProduct(ctx.db, {
      productId: ready.productId,
      expectedPublicationVersion: productReadiness.publicationVersion,
      actorId: "admin",
      reason: "Queue race fixture publication",
      correlationId: "queue-race-publication",
    });
    if (!published.ok) throw new Error(published.message);

    const insertReleased = Promise.withResolvers<void>();
    const inserted = Promise.withResolvers<void>();
    const insertPromise = withTransaction(ctx.db, async (trx) => {
      await sql`
        insert into discrepancy (id, type, status, reason, owner)
        values (${newId()}, 'UNMATCHED', 'OPEN', 'concurrent queue insertion', 'payments')
      `.execute(trx);
      inserted.resolve();
      await insertReleased.promise;
    });
    await inserted.promise;

    const openPromise = transitionStoreMode(ctx.db, {
      targetMode: "OPEN",
      expectedVersion: 1,
      requestId: "queue-race-open",
      actorId: "admin",
      reason: "Concurrent queue gate test",
      correlationId: "queue-race-open",
    });
    let observed: "OPEN" | "BLOCKED";
    try {
      observed = await waitForQueueContention();
    } finally {
      insertReleased.resolve();
    }

    const [openResult] = await Promise.all([openPromise, insertPromise]);
    expect(observed).toBe("BLOCKED");
    expect(openResult).toMatchObject({ ok: false, code: "NOT_READY" });
    expect(await getStoreMode(ctx.db)).toBe("CLOSED");
  });

  it("two concurrent attempts with one outbox identity leave one durable row", async () => {
    const input = {
      aggregateType: "Order" as const,
      aggregateId: newId(),
      aggregateVersion: 1,
      eventType: "OrderPaid" as const,
      payloadRedacted: { source: "same-identity" },
    };
    const results = await Promise.allSettled(
      Array.from({ length: 2 }, (_, index) =>
        withTransaction(ctx.db, (trx) =>
          enqueueOutboxEvent(trx, { ...input, id: `${newId()}-${index}` }),
        ),
      ),
    );
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const row = await sql<{ count: string }>`
      select count(*)::text as count
        from outbox_event
       where aggregate_type = ${input.aggregateType}
         and aggregate_id = ${input.aggregateId}
         and aggregate_version = ${input.aggregateVersion}
         and event_type = ${input.eventType}
    `.execute(ctx.db);
    expect(row.rows[0]?.count).toBe("1");
  });

  it("ten concurrent attempts with one outbox identity leave one durable row", async () => {
    const input = {
      aggregateType: "PaymentIntent" as const,
      aggregateId: newId(),
      aggregateVersion: 7,
      eventType: "PaymentSettled" as const,
      payloadRedacted: { source: "same-identity" },
    };
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, (_, index) =>
        withTransaction(ctx.db, (trx) =>
          enqueueOutboxEvent(trx, { ...input, id: `${newId()}-${index}` }),
        ),
      ),
    );
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const row = await sql<{ count: string }>`
      select count(*)::text as count
        from outbox_event
       where aggregate_type = ${input.aggregateType}
         and aggregate_id = ${input.aggregateId}
         and aggregate_version = ${input.aggregateVersion}
         and event_type = ${input.eventType}
    `.execute(ctx.db);
    expect(row.rows[0]?.count).toBe("1");
  });

  it("serializes publication behind a concurrent CLOSED-to-TEST transition", async () => {
    const fixture = await seedProduct(true);
    await addEvidence(fixture.variantId, "publication-test-race");
    const readiness = await getProductPublicationReadiness(ctx.db, fixture.productId);
    if (!readiness?.canPublish) throw new Error("publication race fixture is not ready");

    await sql`
      create or replace function test_hold_publication() returns trigger language plpgsql as $$
      begin
        if old.is_test and not new.is_test then
          perform pg_advisory_xact_lock(742002);
        end if;
        return new;
      end
      $$
    `.execute(ctx.db);
    await sql`
      create trigger test_hold_publication_trigger
      before update of is_test on product
      for each row execute function test_hold_publication()
    `.execute(ctx.db);
    const blocker = await ctx.handle.pool.connect();
    await blocker.query("select pg_advisory_lock(742002)");

    const modeReady = Promise.withResolvers<void>();
    const modeReleased = Promise.withResolvers<void>();
    const modePromise = withTransaction(ctx.db, async (trx) => {
      const result = await transitionStoreModeInTransaction(trx, {
        targetMode: "TEST",
        expectedVersion: 1,
        requestId: "publication-test-race-mode",
        actorId: "admin",
        reason: "Concurrent publication race test",
        correlationId: "publication-test-race-mode",
      });
      modeReady.resolve();
      await modeReleased.promise;
      return result;
    });
    const publicationPromise = (async () => {
      await modeReady.promise;
      return publishProduct(ctx.db, {
        productId: fixture.productId,
        expectedPublicationVersion: readiness.publicationVersion,
        actorId: "admin",
        reason: "Concurrent publication race test",
        correlationId: "publication-test-race",
      });
    })();

    let observed: "STORE" | "PRODUCT";
    let publication: PublishProductResult;
    let mode: StoreModeTransitionResult;
    try {
      observed = await waitForPublicationContention();
      modeReleased.resolve();
      await blocker.query("select pg_advisory_unlock(742002)");
      [publication, mode] = await Promise.all([publicationPromise, modePromise]);
    } finally {
      modeReleased.resolve();
      await blocker.query("select pg_advisory_unlock(742002)").catch(() => undefined);
      await blocker.query("select pg_advisory_unlock_all()").catch(() => undefined);
      await Promise.allSettled([publicationPromise, modePromise]);
      await sql`drop trigger if exists test_hold_publication_trigger on product`.execute(ctx.db);
      await sql`drop function if exists test_hold_publication()`.execute(ctx.db);
      blocker.release();
    }

    expect(observed).toBe("STORE");
    expect(mode).toMatchObject({ ok: true, control: { status: "TEST" } });
    expect(publication).toMatchObject({ ok: false, code: "NOT_READY" });
    await expect(
      sql<{
        is_test: boolean;
      }>`select is_test from product where id = ${fixture.productId}`.execute(ctx.db),
    ).resolves.toMatchObject({ rows: [{ is_test: true }] });
  });

  it("two concurrent publication attempts on one product publish once", async () => {
    await expectConcurrentPublicationCount(2);
  });

  it("ten concurrent publication attempts on one product publish once", async () => {
    await expectConcurrentPublicationCount(10);
  });
});
