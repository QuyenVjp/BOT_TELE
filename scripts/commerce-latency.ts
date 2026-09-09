import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { performance } from "node:perf_hooks";
import { sql } from "kysely";
import { createApp } from "../src/app.js";
import { createCallbackTokenCodec } from "../src/bot/callback-codec.js";
import { createCatalogCallbacks } from "../src/bot/callbacks/catalog.js";
import type { PresentedMessage } from "../src/bot/presenters/catalog.js";
import { createPostgresTelegramInbox } from "../src/infrastructure/inbox/telegram.js";
import type { Vault } from "../src/infrastructure/vault/port.js";
import { createWalletLedgerService } from "../src/modules/wallet/ledger.js";
import { startPostgresContainer, type PgTestContext } from "../tests/helpers/pg-container.js";

const DUPLICATE_CREDIT_CONCURRENCY = 16;
const DISTINCT_CREDIT_CONCURRENCY = 20;
const CALLBACK_SAMPLES = 25;
const DOMAIN_CALLBACK_SEQUENTIAL = 25;
const DOMAIN_CALLBACK_CONCURRENT = 10;
const AUTH_VALUE = randomBytes(24).toString("hex");

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function percentile(values: number[], p: number): number {
  assert(values.length > 0, "percentile requires samples");
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[idx]!;
}

function report(name: string, values: number[], extra = ""): void {
  console.log(
    `${name}: n=${values.length}${extra} p50=${percentile(values, 50).toFixed(2)}ms p95=${percentile(values, 95).toFixed(2)}ms`,
  );
}

async function seedCustomer(ctx: PgTestContext, customerId: string): Promise<void> {
  await sql`insert into customer (id, status, locale) values (${customerId}, 'ACTIVE', 'vi-VN')`.execute(
    ctx.db,
  );
}

async function walletCounts(
  ctx: PgTestContext,
  customerId: string,
): Promise<{
  accountCount: number;
  ledgerCount: number;
  balanceVnd: bigint;
}> {
  const result = await sql<{ account_count: number; ledger_count: number; balance_vnd: string }>`
    select
      (select count(*)::int from wallet_account where customer_id = ${customerId}) as account_count,
      (select count(*)::int from wallet_ledger l join wallet_account a on a.id = l.wallet_account_id where a.customer_id = ${customerId}) as ledger_count,
      coalesce((select balance_vnd::text from wallet_account where customer_id = ${customerId}), '0') as balance_vnd
  `.execute(ctx.db);
  const row = result.rows[0];
  assert(row, "wallet count query returned no row");
  return {
    accountCount: row.account_count,
    ledgerCount: row.ledger_count,
    balanceVnd: BigInt(row.balance_vnd),
  };
}

async function measureWallet(ctx: PgTestContext): Promise<void> {
  const customerId = "commerce-latency-customer";
  await seedCustomer(ctx, customerId);
  const wallet = createWalletLedgerService(ctx.db);

  const duplicateStart = performance.now();
  const duplicate = await Promise.all(
    Array.from({ length: DUPLICATE_CREDIT_CONCURRENCY }, (_unused, i) =>
      wallet.credit({
        customerId,
        amountVnd: 150_000n,
        idempotencyKey: "topup:commerce-latency:duplicate",
        correlationId: `duplicate-${i}`,
        reason: "synthetic duplicate topup",
      }),
    ),
  );
  const duplicateElapsed = performance.now() - duplicateStart;
  assert(
    duplicate.every((result) => result.ok),
    "duplicate credit call failed",
  );
  assert(
    duplicate.filter((result) => result.ok && result.inserted).length === 1,
    "duplicate credit inserted more than one ledger row",
  );
  let counts = await walletCounts(ctx, customerId);
  assert(counts.accountCount === 1, `expected one wallet account, got ${counts.accountCount}`);
  assert(counts.ledgerCount === 1, `expected one duplicate ledger row, got ${counts.ledgerCount}`);
  assert(
    counts.balanceVnd === 150_000n,
    `expected duplicate balance 150000, got ${counts.balanceVnd}`,
  );
  console.log(
    `wallet duplicate credit: concurrency=${DUPLICATE_CREDIT_CONCURRENCY} elapsed=${duplicateElapsed.toFixed(2)}ms inserted=1 balance=${counts.balanceVnd}`,
  );

  const distinctLatencies = await Promise.all(
    Array.from({ length: DISTINCT_CREDIT_CONCURRENCY }, async (_unused, i) => {
      const started = performance.now();
      const result = await wallet.credit({
        customerId,
        amountVnd: 1_000n,
        idempotencyKey: `topup:commerce-latency:distinct:${i}`,
        correlationId: `distinct-${i}`,
        reason: "synthetic distinct topup",
      });
      assert(result.ok && result.inserted, `distinct credit ${i} did not insert`);
      return performance.now() - started;
    }),
  );
  counts = await walletCounts(ctx, customerId);
  assert(
    counts.ledgerCount === 1 + DISTINCT_CREDIT_CONCURRENCY,
    `expected ${1 + DISTINCT_CREDIT_CONCURRENCY} ledger rows, got ${counts.ledgerCount}`,
  );
  assert(
    counts.balanceVnd === 150_000n + BigInt(DISTINCT_CREDIT_CONCURRENCY) * 1_000n,
    `unexpected distinct-credit balance ${counts.balanceVnd}`,
  );
  report(
    "wallet distinct credits",
    distinctLatencies,
    ` concurrency=${DISTINCT_CREDIT_CONCURRENCY}`,
  );
}

async function inboxRows(
  ctx: PgTestContext,
): Promise<{ total: number; retry: number; processing: number }> {
  const result = await sql<{ total: number; retry: number; processing: number }>`
    select
      count(*)::int as total,
      count(*) filter (where processing_status = 'RETRY')::int as retry,
      count(*) filter (where processing_status = 'PROCESSING')::int as processing
    from webhook_inbox
    where source = 'telegram'
  `.execute(ctx.db);
  const row = result.rows[0];
  assert(row, "telegram inbox count query returned no row");
  return row;
}

async function injectTelegramCallback(app: FastifyInstance, updateId: number): Promise<number> {
  const started = performance.now();
  const response = await app.inject({
    method: "POST",
    url: "/telegram/webhook",
    headers: {
      "content-type": "application/json",
      "x-telegram-bot-api-secret-token": AUTH_VALUE,
    },
    payload: {
      update_id: updateId,
      callback_query: {
        id: `callback-${updateId}`,
        from: { id: 880000000 + updateId, first_name: "Synthetic" },
        message: { message_id: updateId, chat: { id: 880000000 + updateId, type: "private" } },
        data: "pay:refresh:synthetic-order",
      },
    },
  });
  assert(response.statusCode === 200, `telegram callback ingress returned ${response.statusCode}`);
  assert(
    response.json().method === "answerCallbackQuery",
    "callback ingress did not ACK callback query",
  );
  return performance.now() - started;
}

async function measureTelegramIngress(ctx: PgTestContext): Promise<void> {
  const inbox = createPostgresTelegramInbox(ctx.db);
  const app = await createApp({
    db: ctx.db,
    vault: {
      write: async () => "vault:unused",
      reveal: async () => "unused",
      delete: async () => undefined,
    } as Vault,
    telegram: { path: "/telegram/webhook", secretToken: AUTH_VALUE, inbox },
    sepay: { path: "/webhooks/sepay", handler: async () => ({ status: 503, body: { ok: false } }) },
    bodyLimitBytes: 65_536,
    logger: false,
  });
  try {
    const first = await injectTelegramCallback(app, 910001);
    let rows = await inboxRows(ctx);
    assert(
      rows.total === 1 && rows.retry === 1,
      "telegram callback was not durable at ACK observation",
    );
    const claimed = await inbox.claimDue({
      owner: "commerce-latency-leased-row",
      batchSize: 1,
      leaseSeconds: 30,
    });
    assert(claimed.length === 1, "leased-row setup did not claim first callback");

    const leasedRowAck = await injectTelegramCallback(app, 910002);
    rows = await inboxRows(ctx);
    assert(
      rows.total === 2,
      `expected second callback persisted with one leased row, got ${rows.total}`,
    );
    assert(
      rows.processing === 1 && rows.retry === 1,
      "unexpected inbox state with one leased unprocessed row",
    );
    console.log(
      `telegram durable callback ingress: first_ack=${first.toFixed(2)}ms leased_row_ack=${leasedRowAck.toFixed(2)}ms persisted_at_ack_observation=true`,
    );

    const latencies: number[] = [];
    for (let i = 0; i < CALLBACK_SAMPLES; i += 1) {
      latencies.push(await injectTelegramCallback(app, 920000 + i));
    }
    rows = await inboxRows(ctx);
    assert(
      rows.total === 2 + CALLBACK_SAMPLES,
      `expected ${2 + CALLBACK_SAMPLES} webhook rows, got ${rows.total}`,
    );
    report("telegram HTTP callback ingress", latencies, " transport=Fastify.inject");
    console.log(
      "HTTP ingress timing only; local catalog callback timing is measured separately below.",
    );
  } finally {
    await app.close();
  }
}

async function measureCatalogCallbackLayer(ctx: PgTestContext): Promise<void> {
  const categoryId = "commerce-latency-category";
  await sql`
    insert into category (id, name_vi, slug, is_active, sort_order)
    values (${categoryId}, 'Latency Category', 'latency-category', true, 1)
  `.execute(ctx.db);

  await sql`
    insert into product (id, category_id, name_vi, slug, is_active, sort_order, is_test, is_archived)
    values ('commerce-latency-product', ${categoryId}, 'Latency Product', 'latency-product', true, 1, false, false)
  `.execute(ctx.db);
  await sql`
    insert into product_variant
      (id, product_id, sku, name_vi, price_vnd, duration_code, delivery_type, warranty_days,
       stock_policy, resale_evidence_id, is_active, sort_order)
    values
      ('commerce-latency-variant', 'commerce-latency-product', 'LAT-1M', '1 tháng', 250000, 'P1M',
       'CREDENTIAL', 30, 'LOCAL_ONLY', 'RES-LAT', true, 1)
  `.execute(ctx.db);
  const callbacks = createCatalogCallbacks({
    db: ctx.db,
    pageSize: 10,
    parser: { parse: async () => ({}) },
    callbackCodec: createCallbackTokenCodec({
      key: "test-only-commerce-latency-callback-key-material",
      keyVersion: 1,
      ttlSeconds: 900,
      clockSkewSeconds: 5,
    }),
  });
  const assertCategory = (message: PresentedMessage): void => {
    assert(message.text === "Chọn danh mục:", "category callback returned unexpected text");
    assert(
      message.buttons.some((row) =>
        row.some(
          (button) =>
            button.text === "Latency Category" && button.callbackData === `cat:view:${categoryId}`,
        ),
      ),
      "category callback did not include seeded category button",
    );
  };

  const sequential: number[] = [];
  for (let i = 0; i < DOMAIN_CALLBACK_SEQUENTIAL; i += 1) {
    const started = performance.now();
    assertCategory(await callbacks.categoryList());
    sequential.push(performance.now() - started);
  }
  report(
    "local catalog category callback layer",
    sequential,
    " branch=categoryList transport=none",
  );

  const concurrent = await Promise.all(
    Array.from({ length: DOMAIN_CALLBACK_CONCURRENT }, async () => {
      const started = performance.now();
      assertCategory(await callbacks.categoryList());
      return performance.now() - started;
    }),
  );
  report(
    "local catalog category callback layer concurrent",
    concurrent,
    ` concurrency=${DOMAIN_CALLBACK_CONCURRENT} branch=categoryList transport=none`,
  );
}

async function main(): Promise<void> {
  let ctx: PgTestContext | undefined;
  try {
    ctx = await startPostgresContainer();
    await measureWallet(ctx);
    await measureTelegramIngress(ctx);
    await measureCatalogCallbackLayer(ctx);
    console.log(
      "Commerce latency check complete. Synthetic local PostgreSQL/Fastify only; no Telegram network, no credentials, no production SLO.",
    );
  } finally {
    await ctx?.teardown();
  }
}

await main();
