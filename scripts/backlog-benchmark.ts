import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { sql } from "kysely";
import { startPostgresContainer } from "../tests/helpers/pg-container.js";
import { seedCatalog } from "../src/infrastructure/db/seeds/catalog.js";
import { listActiveCategories } from "../src/modules/catalog/repository.js";
import { drainOutboxOnce } from "../src/infrastructure/outbox/worker.js";

// No input database URL: all writes stay in this disposable synthetic database.
const ctx = await startPostgresContainer();
const samples: number[] = [];
let maxWaiting = 0;
let maxBusy = 0;
let readsDuringDrain = 0;
let draining = true;
const poolSamples = setInterval(() => {
  maxWaiting = Math.max(maxWaiting, ctx.handle.pool.waitingCount);
  maxBusy = Math.max(maxBusy, ctx.handle.pool.totalCount - ctx.handle.pool.idleCount);
}, 5);
try {
  await seedCatalog(ctx.db);
  await sql`insert into outbox_event
    (id, aggregate_type, aggregate_id, aggregate_version, event_type, payload_redacted)
    select 'backlog-' || n, 'SyntheticBenchmark', 'backlog-' || n, 1, 'StockDelta', '{}'::jsonb
    from generate_series(1, 10000) n`.execute(ctx.db);
  const started = performance.now();
  const drain = (async () => {
    let published = 0;
    while (published < 10000) {
      const result = await drainOutboxOnce(ctx.db, {
        batchSize: 100,
        maxAttempts: 1,
        ownerId: "synthetic-backlog-worker",
        handler: async () => ({ kind: "PUBLISHED" }),
      });
      assert.ok(result.claimed > 0, "backlog drain must make progress");
      published += result.published;
    }
    return published;
  })().finally(() => {
    draining = false;
  });
  const reads = (async () => {
    while (draining || samples.length < 200) {
      const before = performance.now();
      const categories = await listActiveCategories(ctx.db);
      assert.ok(categories.length > 0);
      samples.push(performance.now() - before);
      if (draining) readsDuringDrain += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  })();
  const [published] = await Promise.all([drain, reads]);
  assert.equal(published, 10000);
  assert.ok(readsDuringDrain > 0);
  const outstanding = await sql<{ count: number }>`select count(*)::int as count from outbox_event
    where aggregate_type = 'SyntheticBenchmark' and published_at is null`.execute(ctx.db);
  assert.equal(outstanding.rows[0]?.count, 0);
  samples.sort((a, b) => a - b);
  const percentile = (p: number) => samples[Math.ceil(samples.length * p) - 1];
  console.log(
    JSON.stringify({
      mode: "disposable-postgres-synthetic-outbox-mocked-handler",
      backlog: 10000,
      published,
      seconds: (performance.now() - started) / 1000,
      interactiveOperation: "listActiveCategories",
      samples: samples.length,
      readsDuringDrain,
      latencyMs: { p50: percentile(0.5), p95: percentile(0.95), p99: percentile(0.99) },
      maxPoolWaiting: maxWaiting,
      maxPoolBusy: maxBusy,
      production: false,
      externalSupplierOrTelegram: false,
    }),
  );
} finally {
  clearInterval(poolSamples);
  await ctx.teardown();
}
