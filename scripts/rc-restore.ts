import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { performance } from "node:perf_hooks";
import { sql } from "kysely";
import { GenericContainer, Wait } from "testcontainers";
import { createDb, type DbHandle } from "../src/infrastructure/db/client.js";
import { runMigrations } from "../src/infrastructure/db/migrate.js";
import { seedRcDataset, verifyRcDataset } from "../tests/helpers/rc-dataset.js";

const user = "drill";
const password = randomBytes(16).toString("hex");
const sourceDb = "source";
const restoredDb = "restored";
const dumpPath = `/tmp/rc-restore-${randomBytes(8).toString("hex")}.dump`;

const container = await new GenericContainer("postgres:16-alpine")
  .withEnvironment({ POSTGRES_USER: user, POSTGRES_PASSWORD: password, POSTGRES_DB: sourceDb })
  .withExposedPorts(5432)
  .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
  .withStartupTimeout(120_000)
  .start();

const connection = (database: string) => {
  const url = new URL(
    `postgresql://${container.getHost()}:${container.getMappedPort(5432)}/${database}`,
  );
  url.username = user;
  url.password = password;
  return url.toString();
};

const source = createDb({ connectionString: connection(sourceDb) });
let restored: DbHandle | undefined;

async function command(args: string[]) {
  const result = await container.exec(args);
  assert.equal(result.exitCode, 0, `Disposable ${args[0]} failed`);
}

async function snapshot(db: typeof source.db) {
  const rows = await sql<{
    customers: number;
    orders: number;
    walletLedger: number;
    inventoryMovements: number;
    products: number;
    variants: number;
    notificationDeliveries: number;
    paymentIntents: number;
    paymentAllocations: number;
    bankTransactions: number;
    auditEvents: number;
    campaigns: number;
  }>`
    select
      (select count(*)::int from customer) as customers,
      (select count(*)::int from "order") as orders,
      (select count(*)::int from wallet_ledger) as "walletLedger",
      (select count(*)::int from quantity_stock_ledger) as "inventoryMovements",
      (select count(*)::int from product) as products,
      (select count(*)::int from product_variant) as variants,
      (select count(*)::int from notification_delivery) as "notificationDeliveries",
      (select count(*)::int from payment_intent) as "paymentIntents",
      (select count(*)::int from payment_allocation) as "paymentAllocations",
      (select count(*)::int from bank_transaction) as "bankTransactions",
      (select count(*)::int from audit_event) as "auditEvents",
      (select count(*)::int from notification_campaign) as campaigns
  `.execute(db);
  const row = rows.rows[0];
  assert.ok(row, "snapshot returned no rows");
  return row;
}

try {
  await runMigrations(source.db);
  const seeded = await seedRcDataset(source.db);
  const before = await snapshot(source.db);

  assert.deepEqual(before, {
    ...seeded.counts,
    paymentIntents: 20_000,
    paymentAllocations: 20_000,
    bankTransactions: 20_000,
    auditEvents: 20_000,
    campaigns: 2,
  });

  const dumpStarted = performance.now();
  await command(["pg_dump", "-U", user, "-d", sourceDb, "-Fc", "-f", dumpPath]);
  const dumpMs = Math.round(performance.now() - dumpStarted);

  await command(["createdb", "-U", user, restoredDb]);

  const restoreStarted = performance.now();
  await command(["pg_restore", "-U", user, "-d", restoredDb, "--exit-on-error", dumpPath]);
  const restoreMs = Math.round(performance.now() - restoreStarted);

  restored = createDb({ connectionString: connection(restoredDb) });
  assert.deepEqual(await snapshot(restored.db), before);
  await verifyRcDataset(restored.db);

  console.log(
    JSON.stringify({
      result: "PASS",
      productionData: false,
      counts: before,
      timingsMs: { dump: dumpMs, restore: restoreMs },
    }),
  );
} finally {
  await restored?.close();
  await source.close();
  await container.stop();
}
