import { randomBytes } from "node:crypto";
import {
  constants,
  monitorEventLoopDelay,
  PerformanceObserver,
  performance,
} from "node:perf_hooks";
import { sql } from "kysely";
import type { FastifyInstance } from "fastify";
import { createApp } from "../src/app.js";
import { createPostgresTelegramInbox } from "../src/infrastructure/inbox/telegram.js";
import {
  claimDueOutboxBatch,
  markOutboxPublished,
} from "../src/infrastructure/outbox/repository.js";
import { getAdminHealthFacts } from "../src/modules/admin/health.js";
import { getAdminOverview } from "../src/modules/admin/overview.js";
import { listAdminCustomers } from "../src/modules/admin/customer-operations.js";
import { listAdminOrders } from "../src/modules/admin/order-operations.js";
import { listSellableVariants } from "../src/modules/catalog/repository.js";
import { searchCatalog } from "../src/modules/catalog/search.js";
import { listOrderHistory } from "../src/modules/commerce/history.js";
import {
  claimNotificationDeliveries,
  markNotificationSent,
} from "../src/modules/notification/service.js";
import { createWalletLedgerService } from "../src/modules/wallet/ledger.js";
import { newId } from "../src/shared/ids/index.js";
import type { Vault } from "../src/infrastructure/vault/port.js";
import { startPostgresContainer, type PgTestContext } from "../tests/helpers/pg-container.js";
import { seedRcDataset } from "../tests/helpers/rc-dataset.js";

const CATEGORY_ID = "01CAT0000000000000000001";
const CUSTOMER_ID = "01CST0" + "1".padStart(20, "0");
const TELEGRAM_SECRET = randomBytes(24).toString("hex");
const TICK_MS = 1_000;
const SAMPLE_MS = 5_000;
const LATENCY_SAMPLE_LIMIT = 2_048;
const EVENT_LOOP_SAMPLE_LIMIT = 2_048;
interface ErrorRecord {
  operation: string;
  message: string;
}

class BoundedLatency {
  private readonly samples: number[] = [];
  count = 0;
  errors = 0;
  totalMs = 0;
  minMs = Number.POSITIVE_INFINITY;
  maxMs = 0;

  add(valueMs: number): void {
    this.count += 1;
    this.totalMs += valueMs;
    this.minMs = Math.min(this.minMs, valueMs);
    this.maxMs = Math.max(this.maxMs, valueMs);
    if (this.samples.length < LATENCY_SAMPLE_LIMIT) {
      this.samples.push(valueMs);
    } else {
      this.samples[(this.count - 1) % LATENCY_SAMPLE_LIMIT] = valueMs;
    }
  }

  addError(): void {
    this.errors += 1;
  }

  summary(): {
    count: number;
    errors: number;
    p50Ms: number | null;
    p95Ms: number | null;
    p99Ms: number | null;
    maxMs: number | null;
    meanMs: number | null;
  } {
    if (this.samples.length === 0) {
      return {
        count: this.count,
        errors: this.errors,
        p50Ms: null,
        p95Ms: null,
        p99Ms: null,
        maxMs: null,
        meanMs: null,
      };
    }
    const sorted = [...this.samples].sort((a, b) => a - b);
    const percentile = (p: number): number =>
      Number(sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)]!.toFixed(3));
    return {
      count: this.count,
      errors: this.errors,
      p50Ms: percentile(0.5),
      p95Ms: percentile(0.95),
      p99Ms: percentile(0.99),
      maxMs: Number(this.maxMs.toFixed(3)),
      meanMs: Number((this.totalMs / this.count).toFixed(3)),
    };
  }
}

interface RuntimeMetrics {
  samples: number;
  firstRssBytes: number | null;
  lastRssBytes: number | null;
  maxRssBytes: number;
  firstHeapUsedBytes: number | null;
  lastHeapUsedBytes: number | null;
  maxHeapUsedBytes: number;
  firstExternalBytes: number | null;
  lastExternalBytes: number | null;
  maxExternalBytes: number;
}

interface PoolMetrics {
  samples: number;
  maxWaiting: number;
  maxTotal: number;
  minIdle: number | null;
  lastWaiting: number;
  lastTotal: number;
  lastIdle: number;
}

interface QueueMetrics {
  samples: number;
  maxTelegramPending: number;
  maxOutboxPending: number;
  maxNotificationPending: number;
  lastTelegramPending: number;
  lastOutboxPending: number;
  lastNotificationPending: number;
  maxTelegramOldestAgeMs: number;
  maxOutboxOldestAgeMs: number;
  maxNotificationOldestAgeMs: number;
}

interface EventLoopMetrics {
  samples: number;
  maxLagMs: number;
  totalLagMs: number;
  lagsMs: number[];
}
interface EventLoopProbeReport {
  monitorEventLoopDelay: {
    available: boolean;
    resolutionMs: number;
    p50Ms: number | null;
    p95Ms: number | null;
    p99Ms: number | null;
    meanMs: number | null;
    maxMs: number | null;
  };
  eventLoopUtilization: { activeMs: number; idleMs: number; utilization: number } | null;
  cpu: { userMicros: number; systemMicros: number; percent: number } | null;
  gc: {
    available: boolean;
    count: number;
    durationMs: number;
    byKind: Record<string, { count: number; durationMs: number }>;
  };
}

interface EventLoopProbe {
  stop: () => EventLoopProbeReport;
}

interface SoakMetrics {
  startedAt: string;
  ticks: number;
  errors: ErrorRecord[];
  latencies: Map<string, BoundedLatency>;
  runtime: RuntimeMetrics;
  pool: PoolMetrics;
  queues: QueueMetrics;
  eventLoop: EventLoopMetrics;
}

interface QueueSnapshot {
  telegramPending: number;
  outboxPending: number;
  notificationPending: number;
  telegramOldestAgeMs: number;
  outboxOldestAgeMs: number;
  notificationOldestAgeMs: number;
}

function requiredPositiveSeconds(raw: string | undefined): number {
  const seconds = Number(raw ?? "1800");
  if (!Number.isInteger(seconds) || seconds < 1) {
    throw new RangeError("SOAK_DURATION_SECONDS must be a positive integer");
  }
  return seconds;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function recordError(metrics: SoakMetrics, operation: string, error: unknown): void {
  const metric = metrics.latencies.get(operation) ?? new BoundedLatency();
  metric.addError();
  metrics.latencies.set(operation, metric);
  if (metrics.errors.length < 32) metrics.errors.push({ operation, message: messageOf(error) });
}

async function measured<T>(
  metrics: SoakMetrics,
  operation: string,
  work: () => Promise<T>,
): Promise<T | undefined> {
  const started = performance.now();
  try {
    const result = await work();
    const metric = metrics.latencies.get(operation) ?? new BoundedLatency();
    metric.add(performance.now() - started);
    metrics.latencies.set(operation, metric);
    return result;
  } catch (error) {
    recordError(metrics, operation, error);
    return undefined;
  }
}

function runtimeSample(metrics: SoakMetrics): void {
  const usage = process.memoryUsage();
  const runtime = metrics.runtime;
  runtime.samples += 1;
  runtime.firstRssBytes ??= usage.rss;
  runtime.firstHeapUsedBytes ??= usage.heapUsed;
  runtime.firstExternalBytes ??= usage.external;
  runtime.lastRssBytes = usage.rss;
  runtime.lastHeapUsedBytes = usage.heapUsed;
  runtime.lastExternalBytes = usage.external;
  runtime.maxRssBytes = Math.max(runtime.maxRssBytes, usage.rss);
  runtime.maxHeapUsedBytes = Math.max(runtime.maxHeapUsedBytes, usage.heapUsed);
  runtime.maxExternalBytes = Math.max(runtime.maxExternalBytes, usage.external);
}

function poolSample(ctx: PgTestContext, metrics: SoakMetrics): void {
  const pool = ctx.handle.pool;
  const state = metrics.pool;
  state.samples += 1;
  state.maxWaiting = Math.max(state.maxWaiting, pool.waitingCount);
  state.maxTotal = Math.max(state.maxTotal, pool.totalCount);
  state.minIdle = state.minIdle === null ? pool.idleCount : Math.min(state.minIdle, pool.idleCount);
  state.lastWaiting = pool.waitingCount;

  state.lastTotal = pool.totalCount;
  state.lastIdle = pool.idleCount;
}

function eventLoopSample(metrics: SoakMetrics, expectedAt: number): void {
  const lagMs = Math.max(0, performance.now() - expectedAt);
  const eventLoop = metrics.eventLoop;
  eventLoop.samples += 1;
  eventLoop.maxLagMs = Math.max(eventLoop.maxLagMs, lagMs);
  eventLoop.totalLagMs += lagMs;
  if (eventLoop.lagsMs.length < EVENT_LOOP_SAMPLE_LIMIT) {
    eventLoop.lagsMs.push(lagMs);
  } else {
    eventLoop.lagsMs[eventLoop.samples % EVENT_LOOP_SAMPLE_LIMIT] = lagMs;
  }
}

function eventLoopPercentile(eventLoop: EventLoopMetrics, percentile: number): number | null {
  if (eventLoop.lagsMs.length === 0) return null;
  const sorted = [...eventLoop.lagsMs].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * percentile) - 1);
  return Number(sorted[index]!.toFixed(3));
}
function toMilliseconds(nanoseconds: number): number | null {
  return Number.isFinite(nanoseconds) ? Number((nanoseconds / 1_000_000).toFixed(3)) : null;
}

function startEventLoopProbe(): EventLoopProbe {
  const startedAt = performance.now();
  const cpuStart = process.cpuUsage();
  const eluStart = performance.eventLoopUtilization();
  let histogram: ReturnType<typeof monitorEventLoopDelay> | null = null;
  try {
    histogram = monitorEventLoopDelay({ resolution: 20 });
    histogram.enable();
  } catch {
    histogram = null;
  }

  const gc = {
    available: false,
    count: 0,
    durationMs: 0,
    byKind: {} as Record<string, { count: number; durationMs: number }>,
  };
  let observer: PerformanceObserver | null = null;
  try {
    observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        const details = entry as PerformanceEntry & {
          detail?: { kind?: number };
        };
        const gcKind = details.detail?.kind ?? 0;
        const kind =
          gcKind & constants.NODE_PERFORMANCE_GC_MAJOR
            ? "major"
            : gcKind & 2
              ? "minor-mark-sweep"
              : gcKind & constants.NODE_PERFORMANCE_GC_MINOR
                ? "minor"
                : gcKind & constants.NODE_PERFORMANCE_GC_INCREMENTAL
                  ? "incremental"
                  : gcKind & constants.NODE_PERFORMANCE_GC_WEAKCB
                    ? "weakcb"
                    : "unknown";
        const durationMs = details.duration;
        const current = gc.byKind[kind] ?? { count: 0, durationMs: 0 };
        current.count += 1;
        current.durationMs += durationMs;
        gc.byKind[kind] = current;
        gc.available = true;
        gc.count += 1;
        gc.durationMs += durationMs;
      }
    });
    observer.observe({ entryTypes: ["gc"] });
  } catch {
    observer = null;
  }

  let report: EventLoopProbeReport | undefined;
  return {
    stop: () => {
      if (report) return report;
      histogram?.disable();
      observer?.disconnect();
      const elapsedMs = Math.max(1, performance.now() - startedAt);
      const cpu = process.cpuUsage(cpuStart);
      const elu = performance.eventLoopUtilization(eluStart);
      report = {
        monitorEventLoopDelay: {
          available: histogram !== null,
          resolutionMs: 20,
          p50Ms: histogram ? toMilliseconds(histogram.percentile(50)) : null,
          p95Ms: histogram ? toMilliseconds(histogram.percentile(95)) : null,
          p99Ms: histogram ? toMilliseconds(histogram.percentile(99)) : null,
          meanMs: histogram ? toMilliseconds(histogram.mean) : null,
          maxMs: histogram ? toMilliseconds(histogram.max) : null,
        },
        eventLoopUtilization: {
          activeMs: Number(elu.active.toFixed(3)),
          idleMs: Number(elu.idle.toFixed(3)),
          utilization: Number(elu.utilization.toFixed(6)),
        },
        cpu: {
          userMicros: cpu.user,
          systemMicros: cpu.system,
          percent: Number((((cpu.user + cpu.system) / (elapsedMs * 1_000)) * 100).toFixed(3)),
        },
        gc: {
          available: gc.available,
          count: gc.count,
          durationMs: Number(gc.durationMs.toFixed(3)),
          byKind: Object.fromEntries(
            Object.entries(gc.byKind).map(([kind, value]) => [
              kind,
              { count: value.count, durationMs: Number(value.durationMs.toFixed(3)) },
            ]),
          ),
        },
      };
      return report;
    },
  };
}

async function queueSnapshot(ctx: PgTestContext): Promise<QueueSnapshot> {
  const result = await sql<{
    telegram_pending: number;
    outbox_pending: number;
    notification_pending: number;
    telegram_oldest_age_ms: number;
    outbox_oldest_age_ms: number;
    notification_oldest_age_ms: number;
  }>`
    select
      (select count(*)::int from webhook_inbox where source = 'telegram' and processing_status in ('RETRY', 'PROCESSING')) as telegram_pending,
      (select count(*)::int from outbox_event where published_at is null and dead_lettered_at is null) as outbox_pending,
      (select count(*)::int from notification_delivery where status in ('PENDING', 'RETRY')) as notification_pending,
      coalesce((select extract(epoch from (clock_timestamp() - min(received_at))) * 1000 from webhook_inbox where source = 'telegram' and processing_status in ('RETRY', 'PROCESSING')), 0)::int as telegram_oldest_age_ms,
      coalesce((select extract(epoch from (clock_timestamp() - min(occurred_at))) * 1000 from outbox_event where published_at is null and dead_lettered_at is null), 0)::int as outbox_oldest_age_ms,
      coalesce((select extract(epoch from (clock_timestamp() - min(next_attempt_at))) * 1000 from notification_delivery where status in ('PENDING', 'RETRY')), 0)::int as notification_oldest_age_ms
  `.execute(ctx.db);
  const row = result.rows[0];
  if (!row) throw new Error("queue snapshot returned no row");
  return {
    telegramPending: row.telegram_pending,
    outboxPending: row.outbox_pending,
    notificationPending: row.notification_pending,
    telegramOldestAgeMs: Math.max(0, row.telegram_oldest_age_ms),
    outboxOldestAgeMs: Math.max(0, row.outbox_oldest_age_ms),
    notificationOldestAgeMs: Math.max(0, row.notification_oldest_age_ms),
  };
}

function queueSample(metrics: SoakMetrics, snapshot: QueueSnapshot): void {
  const state = metrics.queues;
  state.samples += 1;
  state.maxTelegramPending = Math.max(state.maxTelegramPending, snapshot.telegramPending);
  state.maxOutboxPending = Math.max(state.maxOutboxPending, snapshot.outboxPending);
  state.maxNotificationPending = Math.max(
    state.maxNotificationPending,
    snapshot.notificationPending,
  );
  state.maxTelegramOldestAgeMs = Math.max(
    state.maxTelegramOldestAgeMs,
    snapshot.telegramOldestAgeMs,
  );
  state.maxOutboxOldestAgeMs = Math.max(state.maxOutboxOldestAgeMs, snapshot.outboxOldestAgeMs);
  state.maxNotificationOldestAgeMs = Math.max(
    state.maxNotificationOldestAgeMs,
    snapshot.notificationOldestAgeMs,
  );
  state.lastTelegramPending = snapshot.telegramPending;
  state.lastOutboxPending = snapshot.outboxPending;
  state.lastNotificationPending = snapshot.notificationPending;
}

async function injectTelegramCallback(app: FastifyInstance, updateId: number): Promise<void> {
  const response = await app.inject({
    method: "POST",
    url: "/telegram/webhook",
    headers: {
      "content-type": "application/json",
      "x-telegram-bot-api-secret-token": TELEGRAM_SECRET,
    },
    payload: {
      update_id: updateId,
      callback_query: {
        id: `phase2-soak-callback-${updateId}`,
        from: { id: 9_000_000_000 + (updateId % 5_000), first_name: "Soak" },
        message: {
          message_id: updateId,
          chat: { id: 9_000_000_000 + (updateId % 5_000), type: "private" },
        },
        data: "pay:refresh:phase2-soak-order",
      },
    },
  });
  if (response.statusCode !== 200) {
    throw new Error(`telegram ingress returned ${response.statusCode}`);
  }
  if (response.json().method !== "answerCallbackQuery") {
    throw new Error("telegram ingress did not return callback ACK");
  }
}

async function runTick(
  ctx: PgTestContext,
  app: FastifyInstance,
  inbox: ReturnType<typeof createPostgresTelegramInbox>,
  wallet: ReturnType<typeof createWalletLedgerService>,
  metrics: SoakMetrics,
  tick: number,
): Promise<void> {
  const telegramOwner = `phase2-soak-${tick}`;
  await Promise.all([
    measured(metrics, "telegram.ingress", () => injectTelegramCallback(app, 2_000_000 + tick)),
    measured(metrics, "catalog.listSellableVariants", async () => {
      const page = await listSellableVariants(ctx.db, { categoryId: CATEGORY_ID, limit: 20 });
      if (page.items.length === 0) throw new Error("RC catalog page is empty");
    }),
    measured(metrics, "catalog.searchCatalog", async () => {
      const page = await searchCatalog(ctx.db, { query: "RC" }, { limit: 20 });
      if (page.items.length === 0) throw new Error("RC search page is empty");
    }),
    measured(metrics, "commerce.listOrderHistory", async () => {
      const page = await listOrderHistory(ctx.db, { customerId: CUSTOMER_ID, limit: 20 });
      if (page.items.length === 0) throw new Error("RC order history is empty");
    }),
    measured(metrics, "wallet.ensureAccount", async () => {
      if (!(await wallet.ensureAccount(CUSTOMER_ID))) throw new Error("wallet account missing");
    }),
    measured(metrics, "admin.overview", async () => {
      await getAdminOverview(ctx.db);
    }),
    measured(metrics, "admin.health", async () => {
      const health = await getAdminHealthFacts(ctx.db);
      if (health.database !== "ok") throw new Error("admin health database probe is down");
    }),
    measured(metrics, "admin.listCustomers", async () => {
      await listAdminCustomers(ctx.db, { adminTelegramUserId: "9000000001", limit: 20 });
    }),
    measured(metrics, "admin.listOrders", async () => {
      await listAdminOrders(ctx.db, { adminTelegramUserId: "9000000001", limit: 20 });
    }),
    measured(metrics, "telegram.claimAndComplete", async () => {
      const claims = await inbox.claimDue({
        owner: telegramOwner,
        batchSize: 20,
        leaseSeconds: 30,
      });
      for (const claim of claims) {
        if (!(await inbox.markProcessed(claim)))
          throw new Error("telegram claim completion lost lease");
      }
    }),
    measured(metrics, "outbox.claimAndComplete", async () => {
      const id = newId();
      await sql`
        insert into outbox_event
          (id, aggregate_type, aggregate_id, aggregate_version, event_type, payload_redacted)
        values (${id}, 'Phase2Soak', ${id}, ${tick}, 'Phase2SoakTick', '{}'::jsonb)
      `.execute(ctx.db);
      const claims = await claimDueOutboxBatch(ctx.db, {
        batchSize: 20,
        ownerId: `phase2-soak-outbox-${tick}`,
        leaseSeconds: 30,
      });
      for (const claim of claims) {
        if (!(await markOutboxPublished(ctx.db, claim)))
          throw new Error("outbox completion lost lease");
      }
    }),
    measured(metrics, "notification.claimAndComplete", async () => {
      const claims = await claimNotificationDeliveries(ctx.db, 20);
      for (const claim of claims) {
        if (!(await markNotificationSent(ctx.db, claim.id, claim.generation))) {
          throw new Error("notification completion lost lease");
        }
      }
    }),
  ]);
}

function summarize(
  metrics: SoakMetrics,
  durationSeconds: number,
  probe: EventLoopProbeReport | null,
): Record<string, unknown> {
  const latencySummary: Record<string, unknown> = {};
  for (const [operation, metric] of metrics.latencies) latencySummary[operation] = metric.summary();
  const runtime = metrics.runtime;
  return {
    result: metrics.errors.length === 0 ? "PASS" : "FAIL",
    productionData: false,
    durationSeconds,
    minimumDurationSatisfied: durationSeconds >= 1_800,
    ticks: metrics.ticks,
    errors: metrics.errors,
    latencies: latencySummary,
    runtime: {
      ...runtime,
      rssGrowthBytes:
        runtime.firstRssBytes === null || runtime.lastRssBytes === null
          ? null
          : runtime.lastRssBytes - runtime.firstRssBytes,
      heapUsedGrowthBytes:
        runtime.firstHeapUsedBytes === null || runtime.lastHeapUsedBytes === null
          ? null
          : runtime.lastHeapUsedBytes - runtime.firstHeapUsedBytes,
      externalGrowthBytes:
        runtime.firstExternalBytes === null || runtime.lastExternalBytes === null
          ? null
          : runtime.lastExternalBytes - runtime.firstExternalBytes,
    },
    pool: metrics.pool,
    queues: metrics.queues,
    eventLoop: {
      samples: metrics.eventLoop.samples,
      maxLagMs: Number(metrics.eventLoop.maxLagMs.toFixed(3)),
      totalLagMs: Number(metrics.eventLoop.totalLagMs.toFixed(3)),
      meanLagMs:
        metrics.eventLoop.samples === 0
          ? null
          : Number((metrics.eventLoop.totalLagMs / metrics.eventLoop.samples).toFixed(3)),
      p50LagMs: eventLoopPercentile(metrics.eventLoop, 0.5),
      p95LagMs: eventLoopPercentile(metrics.eventLoop, 0.95),
      p99LagMs: eventLoopPercentile(metrics.eventLoop, 0.99),
      monitorEventLoopDelay: probe?.monitorEventLoopDelay ?? null,
      eventLoopUtilization: probe?.eventLoopUtilization ?? null,
      cpu: probe?.cpu ?? null,
      gc: probe?.gc ?? null,
    },
    startedAt: metrics.startedAt,
  };
}

async function main(): Promise<Record<string, unknown>> {
  const durationSeconds = requiredPositiveSeconds(process.env.SOAK_DURATION_SECONDS);
  let ctx: PgTestContext | undefined;
  let app: FastifyInstance | undefined;
  let eventLoopProbe: EventLoopProbe | undefined;
  const metrics: SoakMetrics = {
    startedAt: new Date().toISOString(),
    ticks: 0,
    errors: [],
    latencies: new Map(),
    runtime: {
      samples: 0,
      firstRssBytes: null,
      lastRssBytes: null,
      maxRssBytes: 0,
      firstHeapUsedBytes: null,
      lastHeapUsedBytes: null,
      maxHeapUsedBytes: 0,
      firstExternalBytes: null,
      lastExternalBytes: null,
      maxExternalBytes: 0,
    },
    pool: {
      samples: 0,
      maxWaiting: 0,
      maxTotal: 0,
      minIdle: null,
      lastWaiting: 0,
      lastTotal: 0,
      lastIdle: 0,
    },
    queues: {
      samples: 0,
      maxTelegramPending: 0,
      maxOutboxPending: 0,
      maxNotificationPending: 0,
      lastTelegramPending: 0,
      lastOutboxPending: 0,
      lastNotificationPending: 0,
      maxTelegramOldestAgeMs: 0,
      maxOutboxOldestAgeMs: 0,
      maxNotificationOldestAgeMs: 0,
    },
    eventLoop: { samples: 0, maxLagMs: 0, totalLagMs: 0, lagsMs: [] },
  };
  try {
    ctx = await startPostgresContainer();
    const dataset = await seedRcDataset(ctx.db);
    if (dataset.counts.orders < 20_000) throw new Error("RC dataset did not seed 20,000 orders");
    const inbox = createPostgresTelegramInbox(ctx.db);
    const wallet = createWalletLedgerService(ctx.db);
    app = await createApp({
      db: ctx.db,
      vault: {
        write: async () => "vault:phase2-soak",
        reveal: async () => "phase2-soak",
        delete: async () => undefined,
      } as Vault,
      telegram: { path: "/telegram/webhook", secretToken: TELEGRAM_SECRET, inbox },
      sepay: {
        path: "/webhooks/sepay",
        handler: async () => ({ status: 503, body: { ok: false } }),
      },
      bodyLimitBytes: 65_536,
      logger: false,
    });
    eventLoopProbe = startEventLoopProbe();

    const deadline = performance.now() + durationSeconds * 1_000;
    let nextTick = performance.now();
    let nextSample = performance.now();
    let nextEventLoop = performance.now() + 1_000;
    while (performance.now() < deadline) {
      await runTick(ctx, app, inbox, wallet, metrics, metrics.ticks);
      metrics.ticks += 1;
      const now = performance.now();
      if (now >= nextSample) {
        runtimeSample(metrics);
        poolSample(ctx, metrics);
        const snapshot = await measured(metrics, "queue.snapshot", () => queueSnapshot(ctx!));
        if (snapshot) queueSample(metrics, snapshot);
        nextSample = now + SAMPLE_MS;
      }
      if (now >= nextEventLoop) {
        eventLoopSample(metrics, nextEventLoop);
        nextEventLoop += 1_000;
      }
      nextTick += TICK_MS;
      const waitMs = nextTick - performance.now();
      if (waitMs > 0) await sleep(waitMs);
      else nextTick = performance.now();
    }
    runtimeSample(metrics);
    poolSample(ctx, metrics);
    const finalSnapshot = await queueSnapshot(ctx);
    queueSample(metrics, finalSnapshot);
    const probeReport = eventLoopProbe?.stop() ?? null;
    return summarize(metrics, durationSeconds, probeReport);
  } finally {
    eventLoopProbe?.stop();
    await app?.close();
  }
}

const report = await main();
console.log(JSON.stringify(report, null, 2));
if (report.result !== "PASS") process.exitCode = 1;
