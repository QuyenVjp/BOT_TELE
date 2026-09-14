import { copyFile, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import pg from "pg";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { sql } from "kysely";
import { createDb } from "../src/infrastructure/db/client.js";
import { runMigrationsOnPinnedConnection } from "../src/infrastructure/db/migrate.js";
import { seedRcDataset } from "../tests/helpers/rc-dataset.js";

const PG_IMAGE = "postgres:16-alpine";
const PG_USER = "phase2_migration";
const PG_DB = "phase2_migration";
const EXTRA_MOVEMENTS = 450_000;
const MIGRATIONS_DIR = resolve("src/infrastructure/db/migrations");
const VARIANT_ID = "01VAR0" + "1".padStart(20, "0");
const ORDER_ID = "01ARD0" + "1".padStart(20, "0");

type ExplainSummary = {
  executionMs: number;
  sharedHitBlocks: number;
  sharedReadBlocks: number;
  nodeTypes: string[];
};

type LockSample = {
  atMs: number;
  locks: Array<{ relname: string; mode: string; granted: boolean; count: number }>;
  progress: Array<{ relname: string; phase: string; blocksDone: string; blocksTotal: string }>;
};

/**
 * The migration boundary this profile measures. The default cap keeps the tree at the
 * phase-2 indexes (070) that the assertions below describe, so a later migration cannot
 * silently change what this run measures — and the `071_…` rollback probe written into
 * the copy stays the only file with that prefix.
 */
const PHASE2_TREE_MAX = 70;

async function copyMigrationTree(maxNumber: number = PHASE2_TREE_MAX): Promise<string> {
  const target = await mkdtemp(join("/tmp", "bot-tele-migrations-"));
  const files = (await readdir(MIGRATIONS_DIR))
    .filter((file) => file.endsWith(".sql"))
    .filter((file) => Number(file.slice(0, 3)) <= maxNumber);
  await Promise.all(files.map((file) => copyFile(join(MIGRATIONS_DIR, file), join(target, file))));
  return target;
}

async function databaseReceipt(client: pg.Client): Promise<{ head: string | null; count: number }> {
  const result = await client.query<{ filename: string; count: string }>(
    "select max(filename) as filename, count(*)::text as count from schema_migrations",
  );
  return { head: result.rows[0]?.filename ?? null, count: Number(result.rows[0]?.count ?? 0) };
}

async function explain(client: pg.Client, text: string, value: string): Promise<ExplainSummary> {
  const result = await client.query<{ "QUERY PLAN": Array<Record<string, unknown>> }>(
    `explain (analyze, buffers, format json) ${text}`,
    [value],
  );
  const root = result.rows[0]?.["QUERY PLAN"]?.[0] ?? {};
  const plan = (root.Plan ?? {}) as Record<string, unknown>;
  const nodeTypes: string[] = [];
  let sharedHitBlocks = 0;
  let sharedReadBlocks = 0;
  const visit = (node: Record<string, unknown>): void => {
    if (typeof node["Node Type"] === "string") nodeTypes.push(node["Node Type"]);
    sharedHitBlocks += Number(node["Shared Hit Blocks"] ?? 0);
    sharedReadBlocks += Number(node["Shared Read Blocks"] ?? 0);
    for (const child of (node.Plans as Record<string, unknown>[] | undefined) ?? []) visit(child);
  };
  visit(plan);
  return {
    executionMs: Number(Number(root["Execution Time"] ?? 0).toFixed(3)),
    sharedHitBlocks,
    sharedReadBlocks,
    nodeTypes,
  };
}

async function relationSizes(client: pg.Client): Promise<Record<string, number>> {
  const result = await client.query<{ name: string; bytes: string }>(
    `select name, pg_total_relation_size(name::regclass)::text as bytes
     from unnest($1::text[]) as names(name)`,
    [
      [
        "quantity_stock_ledger",
        "payment_intent",
        "quantity_stock_variant_created_idx",
        "payment_intent_order_created_idx",
      ],
    ],
  );
  return Object.fromEntries(result.rows.map((row) => [row.name, Number(row.bytes)]));
}

async function monitorRelations(
  client: pg.Client,
  stop: () => boolean,
  startedAt: number,
): Promise<LockSample[]> {
  const samples: LockSample[] = [];
  while (!stop()) {
    const locks = await client.query<{
      relname: string;
      mode: string;
      granted: boolean;
      count: string;
    }>(
      `select c.relname, l.mode, l.granted, count(*)::text as count
       from pg_locks l join pg_class c on c.oid=l.relation
       where c.relname = any($1::text[])
       group by c.relname, l.mode, l.granted`,
      [
        [
          "quantity_stock_ledger",
          "payment_intent",
          "quantity_stock_variant_created_idx",
          "payment_intent_order_created_idx",
        ],
      ],
    );
    const progress = await client.query<{
      relname: string;
      phase: string;
      blocksDone: string;
      blocksTotal: string;
    }>(
      `select relid::regclass::text as relname, phase, blocks_done::text as "blocksDone", blocks_total::text as "blocksTotal"
       from pg_stat_progress_create_index`,
    );
    if (locks.rows.length > 0 || progress.rows.length > 0) {
      samples.push({
        atMs: Number((performance.now() - startedAt).toFixed(3)),
        locks: locks.rows.map((row) => ({ ...row, count: Number(row.count) })),
        progress: progress.rows,
      });
    }
    await sleep(5);
  }
  return samples;
}

async function probeWriter(
  connectionString: string,
  startedAt: number,
): Promise<Record<string, unknown>> {
  await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
  const writer = createDb({ connectionString });
  const beginMs = performance.now();
  try {
    await writer.db.transaction().execute(async (trx) => {
      await sql`set local lock_timeout = '2s'`.execute(trx);
      await sql`
        insert into quantity_stock_ledger
          (id, variant_id, entry_type, quantity_delta, quantity_after, idempotency_key)
        values
          (${`phase2-writer-${randomBytes(8).toString("hex")}`}, ${VARIANT_ID}, 'ADJUST', 1, 999999, ${`phase2-writer-${Date.now()}`})
      `.execute(trx);
      throw new Error("ROLLBACK_PROBE");
    });
    return {
      result: "UNEXPECTED_COMMIT",
      elapsedMs: Number((performance.now() - beginMs).toFixed(3)),
      startedMs: Number((beginMs - startedAt).toFixed(3)),
    };
  } catch (error) {
    return {
      result:
        error instanceof Error && error.message === "ROLLBACK_PROBE"
          ? "ROLLED_BACK"
          : error instanceof Error
            ? error.name
            : "ERROR",
      message: error instanceof Error ? error.message : String(error),
      elapsedMs: Number((performance.now() - beginMs).toFixed(3)),
      startedMs: Number((beginMs - startedAt).toFixed(3)),
    };
  } finally {
    await writer.close();
  }
}

async function main(): Promise<void> {
  const password = randomBytes(24).toString("hex");
  let container: StartedTestContainer | undefined;
  let handle: ReturnType<typeof createDb> | undefined;
  let measurementClient: pg.Client | undefined;
  let baselineDir: string | undefined;
  let failureDir: string | undefined;
  try {
    container = await new GenericContainer(PG_IMAGE)
      .withEnvironment({ POSTGRES_USER: PG_USER, POSTGRES_PASSWORD: password, POSTGRES_DB: PG_DB })
      .withExposedPorts(5432)
      .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
      .withStartupTimeout(120_000)
      .start();
    const connectionString = `postgresql://${PG_USER}:${encodeURIComponent(password)}@${container.getHost()}:${container.getMappedPort(5432)}/${PG_DB}`;
    handle = createDb({ connectionString });

    const cleanStartedAt = performance.now();
    const clean = await runMigrationsOnPinnedConnection(connectionString);
    const cleanDurationMs = Number((performance.now() - cleanStartedAt).toFixed(3));
    const cleanClient = new pg.Client({ connectionString });
    await cleanClient.connect();
    const cleanReceipt = await databaseReceipt(cleanClient);
    const idempotent = await runMigrationsOnPinnedConnection(connectionString);
    const idempotentReceipt = await databaseReceipt(cleanClient);
    await cleanClient.end();

    await sql`drop schema public cascade`.execute(handle.db);
    await sql`create schema public`.execute(handle.db);
    await handle.close();
    handle = undefined;

    baselineDir = await copyMigrationTree(69);
    const baseline = await runMigrationsOnPinnedConnection(connectionString, baselineDir);
    const seeded = createDb({ connectionString });
    await seedRcDataset(seeded.db);
    await sql`
      insert into quantity_stock_ledger (id, variant_id, entry_type, quantity_delta, quantity_after, idempotency_key)
      select '01XTR0' || lpad(gs::text, 20, '0'),
        '01VAR0' || lpad((((gs - 1) % 500) + 1)::text, 20, '0'),
        'ADJUST', 1, 999999, 'phase2-migration-extra-' || gs
      from generate_series(1, ${EXTRA_MOVEMENTS}) gs
    `.execute(seeded.db);
    await seeded.close();

    measurementClient = new pg.Client({ connectionString });
    await measurementClient.connect();
    const beforeInventory = await explain(
      measurementClient,
      `select id, variant_id, created_at, quantity_after
       from quantity_stock_ledger where variant_id=$1
       order by created_at desc, id desc limit 50`,
      VARIANT_ID,
    );
    const beforePayment = await explain(
      measurementClient,
      `select id, order_id, status, created_at
       from payment_intent where order_id=$1
       order by created_at desc, id desc limit 50`,
      ORDER_ID,
    );
    const beforeSizes = await measurementClient.query<{
      table_name: string;
      rows: string;
      bytes: string;
    }>(
      `select table_name, rows::text, bytes::text from (
         select 'quantity_stock_ledger' as table_name,
           (select count(*) from quantity_stock_ledger) as rows,
           pg_total_relation_size('quantity_stock_ledger') as bytes
         union all
         select 'payment_intent', (select count(*) from payment_intent), pg_total_relation_size('payment_intent')
       ) sizes`,
    );

    let monitoring = true;
    const migrationStartedAt = performance.now();
    const monitorPromise = monitorRelations(
      measurementClient,
      () => !monitoring,
      migrationStartedAt,
    );
    const writerPromise = probeWriter(connectionString, migrationStartedAt);
    let upgrade: Awaited<ReturnType<typeof runMigrationsOnPinnedConnection>> | undefined;
    let upgradeError: unknown;
    try {
      upgrade = await runMigrationsOnPinnedConnection(connectionString);
    } catch (error) {
      upgradeError = error;
    } finally {
      monitoring = false;
    }
    const [lockResult, writerResult] = await Promise.allSettled([monitorPromise, writerPromise]);
    if (upgradeError) throw upgradeError;
    if (!upgrade || lockResult.status !== "fulfilled" || writerResult.status !== "fulfilled")
      throw new Error("migration measurement did not collect complete concurrent evidence");
    const migrationDurationMs = Number((performance.now() - migrationStartedAt).toFixed(3));
    const lockSamples = lockResult.value;
    const writer = writerResult.value;
    const afterInventory = await explain(
      measurementClient,
      `select id, variant_id, created_at, quantity_after
       from quantity_stock_ledger where variant_id=$1
       order by created_at desc, id desc limit 50`,
      VARIANT_ID,
    );
    const afterPayment = await explain(
      measurementClient,
      `select id, order_id, status, created_at
       from payment_intent where order_id=$1
       order by created_at desc, id desc limit 50`,
      ORDER_ID,
    );
    const afterSizes = await relationSizes(measurementClient);
    const afterReceipt = await databaseReceipt(measurementClient);
    await measurementClient.end();
    measurementClient = undefined;

    const secondUpgrade = await runMigrationsOnPinnedConnection(connectionString);
    failureDir = await copyMigrationTree();
    await writeFile(
      join(failureDir, "071_phase2_rollback_probe.sql"),
      "create table phase2_rollback_probe (id integer primary key);\nselect 1 / 0;\n",
    );
    let rollbackError = "";
    try {
      await runMigrationsOnPinnedConnection(connectionString, failureDir);
    } catch (error) {
      rollbackError = error instanceof Error ? error.message : String(error);
    }
    const failureClient = new pg.Client({ connectionString });
    await failureClient.connect();
    const rollbackCheck = await failureClient.query<{ table_exists: boolean; applied: boolean }>(
      `select to_regclass('public.phase2_rollback_probe') is not null as table_exists,
        exists(select 1 from schema_migrations where filename='071_phase2_rollback_probe.sql') as applied`,
    );
    await failureClient.end();

    console.log(
      JSON.stringify(
        {
          result:
            clean.applied.length > 0 &&
            cleanReceipt.head === "070_phase2_hot_indexes.sql" &&
            idempotent.applied.length === 0 &&
            idempotentReceipt.head === cleanReceipt.head &&
            baseline.applied.at(-1) === "069_step_up_authorization_binding.sql" &&
            upgrade.applied.length === 1 &&
            upgrade.applied[0] === "070_phase2_hot_indexes.sql" &&
            secondUpgrade.applied.length === 0 &&
            rollbackError.length > 0 &&
            rollbackCheck.rows[0]?.table_exists === false &&
            rollbackCheck.rows[0]?.applied === false
              ? "PASS"
              : "FAIL",
          productionData: false,
          cleanPath: {
            durationMs: cleanDurationMs,
            applied: clean.applied.length,
            receipt: cleanReceipt,
          },
          idempotency: {
            applied: idempotent.applied.length,
            already: idempotent.alreadyApplied.length,
          },
          baseline069: { applied: baseline.applied.length, head: baseline.applied.at(-1) ?? null },
          dataset: { baseCounts: seededCounts(), extraQuantityMovements: EXTRA_MOVEMENTS },
          before: { inventory: beforeInventory, payment: beforePayment, tables: beforeSizes.rows },
          upgrade: {
            durationMs: migrationDurationMs,
            applied: upgrade.applied,
            receipt: afterReceipt,
            indexSizesBytes: afterSizes,
            lockSamples: lockSamples.length,
            lockSampleDetails: lockSamples.slice(0, 12),
            writer,
          },
          after: { inventory: afterInventory, payment: afterPayment },
          idempotencyAfter070: {
            applied: secondUpgrade.applied,
            already: secondUpgrade.alreadyApplied,
          },
          rollback: {
            errorObserved: rollbackError.length > 0,
            error: rollbackError,
            tableExists: rollbackCheck.rows[0]?.table_exists ?? null,
            migrationRecorded: rollbackCheck.rows[0]?.applied ?? null,
          },
        },
        null,
        2,
      ),
    );
  } finally {
    const cleanupClient: pg.Client | undefined = measurementClient;
    measurementClient = undefined;
    const cleanupHandle: ReturnType<typeof createDb> | undefined = handle;
    handle = undefined;
    await cleanupClient?.end().catch(() => undefined);
    await cleanupHandle?.close().catch(() => undefined);
    await container?.stop().catch(() => undefined);
    await rm(baselineDir ?? "", { recursive: true, force: true }).catch(() => undefined);
    await rm(failureDir ?? "", { recursive: true, force: true }).catch(() => undefined);
  }
}

function seededCounts(): { orders: number; quantityStockLedger: number } {
  return { orders: 20_000, quantityStockLedger: 50_000 + EXTRA_MOVEMENTS };
}

await main();
