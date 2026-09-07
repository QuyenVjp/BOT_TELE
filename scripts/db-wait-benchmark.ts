import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { startPostgresContainer } from "../tests/helpers/pg-container.js";
const ctx = await startPostgresContainer();
try {
  const pool = ctx.handle.pool;
  const held = await Promise.all(
    Array.from({ length: pool.options.max ?? 10 }, () => pool.connect()),
  );
  const begin = performance.now();
  const waiting = pool.connect();
  const releaseTimer = setTimeout(() => held.pop()!.release(), 100);
  const client = await waiting;
  clearTimeout(releaseTimer);
  const poolWaitMs = performance.now() - begin;
  assert.ok(poolWaitMs >= 80);
  const blocker = held[0]!;
  await blocker.query("select pg_advisory_lock(743221)");
  const lockBegin = performance.now();
  const lock = client.query("select pg_advisory_lock(743221)");
  const unlockTimer = setTimeout(() => {
    void blocker.query("select pg_advisory_unlock(743221)");
  }, 100);
  await lock;
  clearTimeout(unlockTimer);
  const lockWaitMs = performance.now() - lockBegin;
  assert.ok(lockWaitMs >= 80);
  await client.query("select pg_advisory_unlock(743221)");
  client.release();
  for (const c of held) c.release();
  console.log(
    JSON.stringify({
      probe: "controlled-pool-and-advisory-lock-waits",
      poolWaitMs,
      lockWaitMs,
      inducedHoldMs: 100,
      production: false,
    }),
  );
} finally {
  await ctx.teardown();
}
