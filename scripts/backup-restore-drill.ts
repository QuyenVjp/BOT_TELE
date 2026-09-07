import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { GenericContainer, Wait } from "testcontainers";
import { sql } from "kysely";
import { createDb } from "../src/infrastructure/db/client.js";
import { runMigrations } from "../src/infrastructure/db/migrate.js";

// This command cannot accept a production URL: both databases live in its disposable container.
const password = randomBytes(24).toString("hex");
const container = await new GenericContainer("postgres:16-alpine")
  .withEnvironment({ POSTGRES_USER: "drill", POSTGRES_PASSWORD: password, POSTGRES_DB: "source" })
  .withExposedPorts(5432)
  .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
  .start();
const connection = (database: string) => {
  const url = new URL(
    `postgresql://${container.getHost()}:${container.getMappedPort(5432)}/${database}`,
  );
  url.username = "drill";
  url.password = password;
  return url.toString();
};
const source = createDb({ connectionString: connection("source") });
let restored: ReturnType<typeof createDb> | undefined;
async function command(args: string[]) {
  const result = await container.exec(args);
  assert.equal(result.exitCode, 0, `Disposable ${args[0]} failed`);
}
async function snapshot(db: typeof source.db) {
  return (
    await sql<{ name: string; count: number }>`
    select 'customer' as name, count(*)::int as count from customer
    union all select 'order', count(*)::int from "order"
    union all select 'payment', count(*)::int from payment_intent
    union all select 'inventory', count(*)::int from digital_asset
    union all select 'wallet', count(*)::int from wallet_ledger
    union all select 'audit', count(*)::int from audit_event
    order by name
  `.execute(db)
  ).rows;
}
try {
  await runMigrations(source.db);
  await sql`insert into customer (id) values ('restore-synthetic-customer')`.execute(source.db);
  await sql`insert into wallet_account(id, customer_id, balance_vnd) values ('restore-wallet', 'restore-synthetic-customer', 100000)`.execute(
    source.db,
  );
  await sql`insert into wallet_ledger(id, wallet_account_id, entry_type, amount_vnd, balance_before_vnd, balance_after_vnd, idempotency_key, correlation_id, reason)
    values ('restore-credit', 'restore-wallet', 'CREDIT', 100000, 0, 100000, 'restore-credit', 'restore-drill', 'Synthetic restore fixture')`.execute(
    source.db,
  );
  await sql`insert into category(id,name_vi,slug) values ('restore-category','Synthetic','restore-category')`.execute(
    source.db,
  );
  await sql`insert into product(id,category_id,name_vi,slug) values ('restore-product','restore-category','Synthetic','restore-product')`.execute(
    source.db,
  );
  await sql`insert into product_variant(id,product_id,sku,name_vi,price_vnd,duration_code,delivery_type,stock_policy)
    values ('restore-variant','restore-product','RESTORE-SYNTHETIC','Synthetic',100000,'CUSTOM','CREDENTIAL','LOCAL_ONLY')`.execute(
    source.db,
  );
  await sql`insert into "order"(id,order_number,customer_id,variant_id,product_name_vi,variant_name_vi,price_vnd,duration_code,delivery_type,status)
    values ('restore-order','RESTORE-SYNTHETIC','restore-synthetic-customer','restore-variant','Synthetic','Synthetic',100000,'CUSTOM','CREDENTIAL','PENDING_PAYMENT')`.execute(
    source.db,
  );
  await sql`insert into payment_intent(id,order_id,status,amount_vnd,merchant_account_id,transfer_content,expires_at)
    values ('restore-payment','restore-order','CREATED',100000,'synthetic','RESTORE-SYNTHETIC',now()+interval '1 hour')`.execute(
    source.db,
  );
  await sql`insert into digital_asset(id,variant_id,source_type,vault_ref,fingerprint_hash,status)
    values ('restore-asset','restore-variant','LOCAL','synthetic-reference-not-a-credential','synthetic-fingerprint','AVAILABLE')`.execute(
    source.db,
  );
  await sql`insert into audit_event(id,actor_type,action,target_type,target_id,reason,correlation_id)
    values ('restore-audit','SYSTEM','restore.fixture','Order','restore-order','Synthetic fixture','restore-drill')`.execute(
    source.db,
  );
  const before = await snapshot(source.db);
  await command(["pg_dump", "-U", "drill", "-d", "source", "-Fc", "-f", "/tmp/commerce.dump"]);
  await command(["createdb", "-U", "drill", "restored"]);
  await command([
    "pg_restore",
    "-U",
    "drill",
    "-d",
    "restored",
    "--exit-on-error",
    "/tmp/commerce.dump",
  ]);
  restored = createDb({ connectionString: connection("restored") });
  assert.deepEqual(await snapshot(restored.db), before);
  const balance = await sql<{
    valid: boolean;
  }>`select wa.balance_vnd = sum(case when wl.entry_type='CREDIT' then wl.amount_vnd else -wl.amount_vnd end) as valid
    from wallet_account wa join wallet_ledger wl on wl.wallet_account_id=wa.id group by wa.id`.execute(
    restored.db,
  );
  assert.equal(balance.rows.length, 1);
  assert.equal(balance.rows[0]?.valid, true);
  const linked = await sql<{ count: number }>`select count(*)::int as count from "order" o
    join customer c on c.id=o.customer_id join product_variant v on v.id=o.variant_id
    join payment_intent p on p.order_id=o.id join digital_asset a on a.variant_id=v.id
    join audit_event e on e.target_id=o.id where o.id='restore-order' and p.amount_vnd=o.price_vnd`.execute(
    restored.db,
  );
  assert.equal(linked.rows[0]?.count, 1);
  await assert.rejects(
    sql`insert into customer(id) values ('restore-synthetic-customer')`.execute(restored.db),
  );
  await assert.rejects(
    sql`update wallet_account set balance_vnd=-1 where id='restore-wallet'`.execute(restored.db),
  );
  console.log(
    JSON.stringify({
      result: "PASS",
      fixture: "synthetic customer/order/payment/inventory/wallet/audit",
      restoredCounts: before,
      constraints: [
        "customer primary key",
        "nonnegative wallet balance",
        "ledger balance",
        "commerce relationships",
      ],
      productionData: false,
    }),
  );
} finally {
  await restored?.close();
  await source.close();
  await container.stop();
}
