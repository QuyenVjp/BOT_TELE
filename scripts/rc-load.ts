import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { sql } from "kysely";
import { createCallbackTokenCodec } from "../src/bot/callback-codec.js";
import { createCatalogCallbacks } from "../src/bot/callbacks/catalog.js";
import { createHistoryCallbacks } from "../src/bot/callbacks/history.js";
import { createTelegramDomainDispatcher } from "../src/bot/callbacks/telegram-dispatch.js";
import type { PresentedMessage } from "../src/bot/presenters/catalog.js";
import { createDb } from "../src/infrastructure/db/client.js";
import {
  claimDueOutboxBatch,
  markOutboxPublished,
} from "../src/infrastructure/outbox/repository.js";
import type { TelegramCommandEnvelope } from "../src/infrastructure/inbox/telegram.js";
import type { Vault } from "../src/infrastructure/vault/port.js";
import { listAdminCustomers } from "../src/modules/admin/customer-operations.js";
import { listAdminOrders } from "../src/modules/admin/order-operations.js";
import { listSellableVariants, getVariantById } from "../src/modules/catalog/repository.js";
import { searchCatalog } from "../src/modules/catalog/search.js";
import { listVariantInventoryHistory } from "../src/modules/catalog/quantity-stock.js";
import { listOrderHistory } from "../src/modules/commerce/history.js";
import { resolveTelegramCustomerId } from "../src/modules/identity/channel-identity.js";
import { claimNotificationDeliveries } from "../src/modules/notification/service.js";
import type { SupplierPort } from "../src/modules/supplier/port.js";
import { provisionFromSupplier } from "../src/modules/supplier/service.js";
import { createWalletLedgerService } from "../src/modules/wallet/ledger.js";
import { startPostgresContainer, type PgTestContext } from "../tests/helpers/pg-container.js";
import { seedRcDataset } from "../tests/helpers/rc-dataset.js";

const DOMAIN_READS = 1_000;
const DOMAIN_CALLBACKS = 1_000;
const CONCURRENCY = 20;
const ADMIN_TELEGRAM_USER_ID = "9000000001";
const CUSTOMER_ID = "01CST0" + "1".padStart(20, "0");
const VARIANT_ID = "01VAR0" + "1".padStart(20, "0");
const ORDER_ID = "01ARD0" + "1".padStart(20, "0");
const SUPPLIER_ID = "01SUP0" + "1".padStart(20, "0");
const SUPPLIER_SKU_ID = "01SSK0" + "1".padStart(20, "0");
const CATEGORY_ID = "01CAT0000000000000000001";

interface Metric {
  p50: number;
  p95: number;
  errors: number;
}

interface WaitSample {
  waitingSamples: number;
  lockWaitSamples: number;
  maxQueryAgeWhileWaitingMs: number;
  activeTransactions: number;
  maxSampledTransactionAgeMs: number;
}

interface ExplainRow {
  "QUERY PLAN": unknown;
}

function percentile(values: number[], p: number): number {
  assert(values.length > 0, "percentile requires samples");
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!;
}

function metric(values: number[], errors: number): Metric {
  return {
    p50: Number(percentile(values, 50).toFixed(3)),
    p95: Number(percentile(values, 95).toFixed(3)),
    errors,
  };
}

async function pooled(total: number, concurrency: number, work: (index: number) => Promise<void>) {
  let next = 0;
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      for (;;) {
        const index = next;
        next += 1;
        if (index >= total) return;
        await work(index);
      }
    }),
  );
}

async function timeMany(
  total: number,
  concurrency: number,
  work: (index: number) => Promise<string>,
) {
  const latencies: number[] = [];
  const errors: string[] = [];
  await pooled(total, concurrency, async (index) => {
    const started = performance.now();
    let op = "unknown";
    try {
      op = await work(index);
      latencies.push(performance.now() - started);
    } catch (error) {
      const maybe = error as { code?: unknown; name?: unknown; message?: unknown };
      errors.push(
        `${index}:${op}:${String(maybe.name ?? "Error")}:${String(maybe.code ?? "")}:${String(maybe.message ?? error)}`,
      );
    }
  });
  assert.equal(errors.length, 0, `load operation failures: ${errors.slice(0, 12).join("; ")}`);
  return metric(latencies, errors.length);
}

async function timed<T>(timings: number[], run: () => Promise<T>): Promise<T> {
  const started = performance.now();
  const result = await run();
  timings.push(performance.now() - started);
  return result;
}

function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

function delayedSupplier(delayMs: number, timings: number[]): SupplierPort {
  return {
    async getAvailability() {
      await timed(timings, () => sleep(delayMs));
      return { status: "UNKNOWN", observedAt: new Date().toISOString() };
    },
    async createOrder() {
      await timed(timings, () => sleep(delayMs));
      return { kind: "UNKNOWN", queryKey: "rc-load-delayed-supplier", reason: "timeout" };
    },
    async queryOrder() {
      await timed(timings, () => sleep(delayMs));
      return { status: "PENDING", externalOrderId: "rc-load-delayed-supplier" };
    },
    async cancelOrder() {
      await timed(timings, () => sleep(delayMs));
      return { status: "PENDING" };
    },
    async requestRefund() {
      await timed(timings, () => sleep(delayMs));
      return { status: "PENDING" };
    },
    async reconcile() {
      await timed(timings, () => sleep(delayMs));
      return { observations: [], nextCursor: null };
    },
  };
}

async function samplePgStatActivity(db: PgTestContext["db"]): Promise<WaitSample> {
  const row = await sql<{
    waiting_samples: string;
    lock_wait_samples: string;
    max_query_age_while_waiting_ms: string;
    active_transactions: string;
    max_sampled_transaction_age_ms: string;
  }>`
    select
      count(*) filter (where wait_event_type is not null and state = 'active')::text as waiting_samples,
      count(*) filter (where wait_event_type = 'Lock' and state = 'active')::text as lock_wait_samples,
      coalesce((max(extract(epoch from (clock_timestamp() - query_start)) * 1000) filter (where wait_event_type is not null and state = 'active')), 0)::bigint::text as max_query_age_while_waiting_ms,
      count(*) filter (where state = 'active' and xact_start is not null)::text as active_transactions,
      coalesce((max(extract(epoch from (clock_timestamp() - xact_start)) * 1000) filter (where state = 'active' and xact_start is not null)), 0)::bigint::text as max_sampled_transaction_age_ms
    from pg_stat_activity
    where datname = current_database()
      and pid <> pg_backend_pid()
  `.execute(db);
  const first = row.rows[0];
  assert.ok(first, "pg_stat_activity sample returned no row");
  return {
    waitingSamples: Number(first.waiting_samples),
    lockWaitSamples: Number(first.lock_wait_samples),
    maxQueryAgeWhileWaitingMs: Number(first.max_query_age_while_waiting_ms),
    activeTransactions: Number(first.active_transactions),
    maxSampledTransactionAgeMs: Number(first.max_sampled_transaction_age_ms),
  };
}

async function explain(db: PgTestContext["db"], name: string, query: ReturnType<typeof sql>) {
  const row = (await query.execute(db)).rows[0] as ExplainRow | undefined;
  assert.ok(row, `${name} explain returned no plan`);
  return { name, plan: row["QUERY PLAN"] };
}

async function explainHotPaths(ctx: PgTestContext) {
  return [
    await explain(
      ctx.db,
      "catalog.listSellableVariants",
      sql`explain (analyze, buffers, format json)
        select v.id, v.product_id, p.name_vi as product_name_vi, v.sku, v.name_vi,
          v.price_vnd, v.duration_code, v.delivery_type, v.warranty_days, v.stock_policy,
          v.sort_order, v.fulfillment_type, q.available_quantity::int as available_quantity,
          case when v.fulfillment_type='QUANTITY_STOCK' then coalesce(q.available_quantity,0)>0 else false end as is_ready
        from product_variant v join product p on p.id=v.product_id join category c on c.id=p.category_id
        left join variant_quantity_stock q on q.variant_id=v.id
        where c.is_active and p.is_active and v.is_active and v.price_vnd>0 and v.resale_evidence_id is not null
          and v.stock_policy in ('LOCAL_ONLY','LOCAL_THEN_SUPPLIER') and v.fulfillment_type <> 'SUPPLIER_API'
          and c.id=${CATEGORY_ID}
        order by v.sort_order asc, v.id asc limit 21`,
    ),
    await explain(
      ctx.db,
      "catalog.searchCatalog",
      sql`explain (analyze, buffers, format json)
        select v.id from product_variant v join product p on p.id=v.product_id join category c on c.id=p.category_id
        left join variant_quantity_stock q on q.variant_id=v.id
        where c.is_active and p.is_active and v.is_active and v.price_vnd>0 and v.resale_evidence_id is not null
          and v.stock_policy in ('LOCAL_ONLY','LOCAL_THEN_SUPPLIER') and v.fulfillment_type <> 'SUPPLIER_API'
          and to_tsvector('simple', lower(p.name_vi)) @@ to_tsquery('simple', 'rc:*')
        order by v.sort_order asc, v.id asc limit 21`,
    ),
    await explain(
      ctx.db,
      "commerce.listOrderHistory",
      sql`explain (analyze, buffers, format json)
        select id, order_number, customer_id, status, product_name_vi, variant_name_vi, price_vnd, created_at
        from "order" where customer_id=${CUSTOMER_ID} order by created_at desc, id desc limit 21`,
    ),
    await explain(
      ctx.db,
      "wallet.ensureAccount",
      sql`explain (analyze, buffers, format json)
        select id, customer_id, balance_vnd, version, created_at, updated_at from wallet_account
        where customer_id=${CUSTOMER_ID} limit 1 for update`,
    ),
    await explain(
      ctx.db,
      "wallet.ledgerByAccount",
      sql`explain (analyze, buffers, format json)
        select id, entry_type, amount_vnd from wallet_ledger
        where wallet_account_id='01WAL000000000000000001' and idempotency_key='rc-wallet-1-1' limit 1`,
    ),
    await explain(
      ctx.db,
      "admin.listCustomers",
      sql`explain (analyze, buffers, format json)
        with customer_base as (
          select c.id, coalesce(cps.telegram_user_id, ci.channel_user_id) as telegram_user_id,
            coalesce(cps.username, ci.observed_username) as username,
            greatest(c.last_seen_at, coalesce(cps.last_seen_at, c.last_seen_at), coalesce(ci.last_seen_at, c.last_seen_at)) as last_seen_at,
            (select count(*)::int from "order" o where o.customer_id=c.id) as order_count,
            coalesce((select sum(o.price_vnd)::bigint from "order" o where o.customer_id=c.id and o.status in ('PAID','PROCESSING','COMPLETED','REFUND_PENDING')),0) as total_spend_vnd
          from customer c left join customer_profile_snapshot cps on cps.customer_id=c.id
          left join channel_identity ci on ci.customer_id=c.id and ci.channel='TELEGRAM'
          where c.status='ACTIVE'
        ) select * from customer_base order by last_seen_at desc, id asc limit 21`,
    ),
    await explain(
      ctx.db,
      "admin.listOrders",
      sql`explain (analyze, buffers, format json)
        select o.id, o.order_number, o.customer_id, coalesce(cps.telegram_user_id, ci.channel_user_id) as telegram_user_id,
          o.status, (select pi.status from payment_intent pi where pi.order_id=o.id order by pi.created_at desc, pi.id desc limit 1) as payment_status,
          o.price_vnd, o.product_name_vi, o.variant_name_vi, o.created_at
        from "order" o left join customer_profile_snapshot cps on cps.customer_id=o.customer_id
        left join channel_identity ci on ci.customer_id=o.customer_id and ci.channel='TELEGRAM'
        order by o.created_at desc, o.id asc limit 21`,
    ),
    await explain(
      ctx.db,
      "admin.inventoryHistory",
      sql`explain (analyze, buffers, format json)
        with variant as (select product_id, id as variant_id, name_vi as variant_name from product_variant where id=${VARIANT_ID} limit 1),
        history as (
          select created_at as occurred_at from quantity_stock_ledger where variant_id=${VARIANT_ID}
          union all select occurred_at from audit_event where target_type='DigitalAsset' and target_id=${VARIANT_ID} and action='inventory.import'
        ) select v.product_id, v.variant_id, v.variant_name, h.occurred_at from variant v
        left join lateral (select occurred_at from history order by occurred_at desc limit 20) h on true
        order by h.occurred_at desc nulls last`,
    ),
    await explain(
      ctx.db,
      "notification.claimDeliveries",
      sql`explain (analyze, buffers, format json)
        with picked as (
          select d.id from notification_delivery d join notification_campaign c on c.id=d.campaign_id
          where d.status in ('PENDING','RETRY') and d.next_attempt_at<=now() and c.status='QUEUED'
            and (d.claim_expires_at is null or d.claim_expires_at<=now())
          order by d.next_attempt_at,d.id for update of d skip locked limit 20
        ) update notification_delivery d set status='RETRY', attempts=d.attempts+1,
          next_attempt_at=now()+interval '30 seconds', claimed_by='explain-only',
          claim_expires_at=now()+interval '30 seconds', claim_generation=d.claim_generation+1
        from picked p, notification_campaign c where d.id=p.id and c.id=d.campaign_id returning d.id`,
    ),
    await explain(
      ctx.db,
      "outbox.claimDueOutboxBatch",
      sql`explain (analyze, buffers, format json)
        update outbox_event as o set claimed_by='explain-only', claimed_at=now(),
          claim_expires_at=now()+interval '30 seconds', claim_generation=claim_generation+1
        from (
          select id from outbox_event where published_at is null and dead_lettered_at is null
            and (next_attempt_at is null or next_attempt_at<=now()) and (claim_expires_at is null or claim_expires_at<=now())
          order by occurred_at asc, id asc limit 20 for update skip locked
        ) candidates where o.id=candidates.id returning o.id`,
    ),
  ];
}

async function main(): Promise<void> {
  let ctx: PgTestContext | undefined;
  try {
    ctx = await startPostgresContainer();
    const seedStarted = performance.now();
    const dataset = await seedRcDataset(ctx.db);
    const seedMs = Math.round(performance.now() - seedStarted);
    const readiness = await sql<{ not_ready: number }>`
      select count(*)::int as not_ready
      from product_variant v
      left join variant_quantity_stock q on q.variant_id = v.id
      left join variant_service_fulfillment f on f.variant_id = v.id and f.is_active
      where v.id like '01VAR0%'
        and (v.fulfillment_type <> 'QUANTITY_STOCK'
          or coalesce(q.available_quantity, 0) <= 0
          or f.fulfillment_type <> v.fulfillment_type)
    `.execute(ctx.db);
    assert.equal(readiness.rows[0]?.not_ready, 0, "RC quantity-stock variants are not ready");

    await sql`
      insert into outbox_event (id, aggregate_type, aggregate_id, aggregate_version, event_type, payload_redacted)
      select '01LOB0' || lpad(gs::text, 20, '0'), 'RcLoad', '01LOB0' || lpad(gs::text, 20, '0'), 1, 'RcLoad', '{}'::jsonb
      from generate_series(1, 1000) gs
    `.execute(ctx.db);

    await sql`analyze`.execute(ctx.db);

    const domainCodec = createCallbackTokenCodec({
      key: "test-only-rc-load-domain-key-material-123456",
      keyVersion: 1,
      ttlSeconds: 900,
      clockSkewSeconds: 5,
    });
    const catalog = createCatalogCallbacks({
      db: ctx.db,
      pageSize: 20,
      parser: { parse: async (raw) => ({ query: raw }) },
      callbackCodec: createCallbackTokenCodec({
        key: "test-only-rc-load-callback-key-material-12345",
        keyVersion: 1,
        ttlSeconds: 900,
        clockSkewSeconds: 5,
      }),
    });
    const history = createHistoryCallbacks({ db: ctx.db, pageSize: 20 });
    const wallet = createWalletLedgerService(ctx.db);
    const sent: PresentedMessage[] = [];
    const dispatcher = createTelegramDomainDispatcher({
      codec: domainCodec,
      resolveCustomerId: (telegramUserId) => resolveTelegramCustomerId(ctx!.db, telegramUserId),
      resolveOrderById: async (orderId) => {
        const row = await sql<{
          id: string;
          order_number: string;
          customer_id: string;
          created_at: string;
        }>`
          select id, order_number, customer_id, created_at::text from "order" where id=${orderId} limit 1
        `.execute(ctx!.db);
        const order = row.rows[0];
        return order
          ? {
              id: order.id,
              orderNumber: order.order_number,
              customerId: order.customer_id,
              createdAt: order.created_at,
            }
          : null;
      },
      resolveOrderIdByNumber: async (orderNumber) =>
        (
          await sql<{
            id: string;
          }>`select id from "order" where order_number=${orderNumber} limit 1`.execute(ctx!.db)
        ).rows[0]?.id ?? null,
      resolveCatalogPage: async (cursorVariantId) => ({ categoryId: cursorVariantId, cursor: "" }),
      catalog,
      checkout: {
        buyNowFromCallback: async () => ({ text: "buy", buttons: [] }),
        refresh: async () => ({ text: "refresh", buttons: [] }),
        reopen: async () => ({ text: "reopen", buttons: [] }),
        cancel: async () => ({ text: "cancel", buttons: [] }),
      },
      history,
      support: {
        reasonMenu: () => ({ text: "support", buttons: [] }),
        open: async () => ({ text: "support open", buttons: [] }),
        list: async () => ({ text: "support list", buttons: [] }),
      },
      walletAccount: async (actionCtx) => {
        const customerId = await resolveTelegramCustomerId(ctx!.db, actionCtx.telegramUserId);
        assert.ok(customerId, "wallet callback customer not found");
        const account = await wallet.ensureAccount(customerId);
        assert.ok(account, "wallet account not found");
        return { text: `wallet ${account.balanceVnd}`, buttons: [] };
      },
      admin: {
        handleToken: async () => ({ text: "admin token unmeasured", buttons: [] }),
        mainMenu: async () => ({ text: "admin menu unmeasured", buttons: [] }),
        customerSearch: async () => {
          const page = await listAdminCustomers(ctx!.db, {
            adminTelegramUserId: ADMIN_TELEGRAM_USER_ID,
            limit: 20,
          });
          return { text: `customers ${page.items.length}`, buttons: [] };
        },
        orderSearch: async () => {
          const page = await listAdminOrders(ctx!.db, {
            adminTelegramUserId: ADMIN_TELEGRAM_USER_ID,
            limit: 20,
          });
          return { text: `orders ${page.items.length}`, buttons: [] };
        },
        inventoryHistory: async (input) => {
          const result = await listVariantInventoryHistory({
            db: ctx!.db,
            actor: { numericUserId: Number(input.telegramUserId), chatType: "private" },
            config: {
              adminTelegramUserId: Number(input.telegramUserId),
              expectedUsername: "rc_admin",
            },
            variantId: input.variantId,
            correlationId: input.correlationId,
          });
          assert.equal(
            result.ok,
            true,
            result.ok ? "" : `inventory history failed: ${result.code}`,
          );
          return { text: "inventory", buttons: [] };
        },
      },
      responder: {
        send: async (message) => {
          sent.push(message.message);
        },
      },
    });

    const readOp = async (index: number): Promise<string> => {
      switch (index % 8) {
        case 0:
          assert.ok(
            (await listSellableVariants(ctx!.db, { categoryId: CATEGORY_ID, limit: 20 })).items
              .length,
          );
          return "catalog.listSellableVariants";
        case 1:
          assert.ok(
            await getVariantById(ctx!.db, `01VAR0${String((index % 500) + 1).padStart(20, "0")}`),
          );
          return "catalog.getVariantById";
        case 2:
          assert.ok((await searchCatalog(ctx!.db, { query: "RC" }, { limit: 20 })).items.length);
          return "catalog.searchCatalog";
        case 3:
          assert.ok(
            (await listOrderHistory(ctx!.db, { customerId: CUSTOMER_ID, limit: 20 })).items.length,
          );
          return "commerce.listOrderHistory";
        case 4:
          assert.ok(await wallet.ensureAccount(CUSTOMER_ID));
          return "wallet.ensureAccount";
        case 5:
          assert.ok(
            (
              await listAdminCustomers(ctx!.db, {
                adminTelegramUserId: ADMIN_TELEGRAM_USER_ID,
                limit: 20,
              })
            ).items.length,
          );
          return "admin.listCustomers";
        case 6:
          assert.ok(
            (
              await listAdminOrders(ctx!.db, {
                adminTelegramUserId: ADMIN_TELEGRAM_USER_ID,
                limit: 20,
              })
            ).items.length,
          );
          return "admin.listOrders";
        default:
          assert.ok(
            (
              await claimDueOutboxBatch(ctx!.db, {
                batchSize: 1,
                ownerId: `rc-load-${index}`,
                leaseSeconds: 1,
              })
            ).length <= 1,
          );
          return "outbox.claimDueOutboxBatch";
      }
    };

    const callbackOp = async (index: number): Promise<string> => {
      const envelope: TelegramCommandEnvelope = {
        actorUserId: String(9000000001 + (index % 5000)),
        chatId: String(9000000001 + (index % 5000)),
        chatType: "private",
        messageId: `rc-load-${index}`,
        callbackQueryId: `rc-load-cb-${index}`,
        action: "MAIN_MENU",
      };
      switch (index % 6) {
        case 0:
          envelope.callbackData = "wallet:account";
          await dispatcher.handle(envelope);
          return "callback.walletAccount";
        case 1:
          envelope.command = "/catalog";
          await dispatcher.handle(envelope);
          return "callback.catalogMain";
        case 2:
          envelope.command = "/search";
          envelope.searchQuery = "RC";
          await dispatcher.handle(envelope);
          return "callback.catalogSearch";
        case 3:
          envelope.messageText = "🧾 Đơn hàng";
          await dispatcher.handle(envelope);
          return "callback.orderHistory";
        case 4:
          envelope.callbackData = "admin:customers:search";
          envelope.actorUserId = ADMIN_TELEGRAM_USER_ID;
          envelope.chatId = ADMIN_TELEGRAM_USER_ID;
          await dispatcher.handle(envelope);
          return "callback.adminCustomers";
        default:
          envelope.callbackData = domainCodec.issue({
            action: "RESTOCK_SUBSCRIBE",
            telegramUserId: envelope.actorUserId,
            resourceId: VARIANT_ID,
          });
          await dispatcher.handle(envelope);
          return "callback.restockSubscribe";
      }
    };

    const reads = await timeMany(DOMAIN_READS, CONCURRENCY, readOp);
    const callbacks = await timeMany(DOMAIN_CALLBACKS, CONCURRENCY, callbackOp);
    assert.equal(sent.length, DOMAIN_CALLBACKS, "not all callbacks sent a response");

    const notificationClaim = await claimNotificationDeliveries(ctx.db, 20);
    assert.ok(notificationClaim.length > 0, "notification queue claim returned no rows");

    let contention:
      | {
          outboxClaimed: number;
          readsDuringDrain: number;
          callbacksDuringDrain: number;
          backlogDomainReads: Metric;
          backlogTelegramDomainCallbacks: Metric;
          supplierOverlapDomainReads: Metric;
          supplierOverlapTelegramDomainCallbacks: Metric;
          supplier: Metric;
          supplierOutcome: string;
          waitSampling: {
            sampled: true;
            lockWaitSamples: number;
            maxQueryAgeWhileWaitingMs: number;
            maxSampledTransactionAgeMs: number;
          };
          drainClaimMs: Metric;
          drainPublishMs: Metric;
          pool: { waitingMax: number; totalCountMax: number; idleCountMin: number };
        }
      | undefined;
    if (process.argv.includes("--contention")) {
      await sql`
        insert into outbox_event (id, aggregate_type, aggregate_id, aggregate_version, event_type, payload_redacted)
        select '01CTN0' || lpad(gs::text, 20, '0'), 'RcContention', '01CTN0' || lpad(gs::text, 20, '0'), 1, 'RcContention', '{}'::jsonb
        from generate_series(1, 10000) gs
      `.execute(ctx.db);
      await sql`insert into supplier (id, name, adapter_type, credential_vault_ref, status) values (${SUPPLIER_ID}, 'RC delayed supplier', 'delayed', 'vault:rc-load', 'ACTIVE')`.execute(
        ctx.db,
      );
      await sql`insert into supplier_sku (id, supplier_id, variant_id, external_sku, cost_vnd, delivery_type, is_active) values (${SUPPLIER_SKU_ID}, ${SUPPLIER_ID}, ${VARIANT_ID}, 'RC-SUPPLIER-SKU', 50000, 'CREDENTIAL', true)`.execute(
        ctx.db,
      );

      const observerDb = createDb({ connectionString: ctx.connectionString, maxConnections: 2 });
      let poolSampler: ReturnType<typeof setInterval> | undefined;
      let waitSampler: ReturnType<typeof setInterval> | undefined;
      try {
        let draining = true;
        let contentionClaimed = 0;
        const poolSamples: { waiting: number; total: number; idle: number }[] = [];
        const waitSamples: WaitSample[] = [];
        poolSampler = setInterval(() => {
          poolSamples.push({
            waiting: ctx!.handle.pool.waitingCount,
            total: ctx!.handle.pool.totalCount,
            idle: ctx!.handle.pool.idleCount,
          });
        }, 25);
        waitSampler = setInterval(() => {
          void samplePgStatActivity(observerDb.db)
            .then((sample) => waitSamples.push(sample))
            .catch(() => undefined);
        }, 50);

        const claimDurations: number[] = [];
        const publishDurations: number[] = [];
        const drain = (async () => {
          for (;;) {
            const claimStarted = performance.now();
            const events = await claimDueOutboxBatch(ctx!.db, {
              batchSize: 100,
              ownerId: "rc-load-contention",
              leaseSeconds: 30,
            });
            claimDurations.push(performance.now() - claimStarted);
            if (events.length === 0) break;
            contentionClaimed += events.filter(
              (event) => event.aggregateType === "RcContention",
            ).length;
            const publishStarted = performance.now();
            await Promise.all(events.map((event) => markOutboxPublished(ctx!.db, event)));
            publishDurations.push(performance.now() - publishStarted);
          }
          draining = false;
        })();
        let readsDuringDrain = 0;
        let callbacksDuringDrain = 0;
        const [, backlogReads, backlogCallbacks] = await Promise.all([
          drain,
          timeMany(200, CONCURRENCY, async (index) => {
            const op = await readOp(index);
            if (draining) readsDuringDrain += 1;
            return op;
          }),
          timeMany(200, CONCURRENCY, async (index) => {
            const op = await callbackOp(index);
            if (draining) callbacksDuringDrain += 1;
            return op;
          }),
        ]);
        assert.equal(
          contentionClaimed,
          10000,
          "contention outbox drain did not claim all fixture rows",
        );
        assert.ok(
          readsDuringDrain + callbacksDuringDrain > 0,
          "domain workload did not overlap drain",
        );

        const paid = await sql<{
          id: string;
        }>`update "order" set status='PAID' where id=${ORDER_ID} returning id`.execute(ctx.db);
        assert.equal(paid.rows[0]?.id, ORDER_ID, `supplier fixture order not found: ${ORDER_ID}`);
        const supplierTimings: number[] = [];
        const vault: Vault = {
          write: async () => "vault:rc-load",
          reveal: async () => "rc-load",
          delete: async () => undefined,
        };
        const [supplierResult, supplierOverlapReads, supplierOverlapCallbacks] = await Promise.all([
          provisionFromSupplier(ctx.db, {
            orderId: ORDER_ID,
            supplierId: SUPPLIER_ID,
            supplierSkuId: SUPPLIER_SKU_ID,
            externalSku: "RC-SUPPLIER-SKU",
            costCeilingVnd: 100000,
            salePriceVnd: 150000,
            expectedSku: "RC-SUPPLIER-SKU",
            deliveryType: "CREDENTIAL",
            durationCode: "P1M",
            region: null,
            correlationId: "rc-load-delayed-supplier",
            idempotencyKey: "rc-load-delayed-supplier",
            port: delayedSupplier(10000, supplierTimings),
            vault,
          }),
          timeMany(200, CONCURRENCY, readOp),
          timeMany(200, CONCURRENCY, callbackOp),
        ]);
        assert.equal(
          supplierResult.ok,
          true,
          supplierResult.ok ? "" : `supplier service provisioning failed: ${supplierResult.code}`,
        );
        assert.equal(supplierResult.ok ? supplierResult.kind : "", "UNKNOWN");
        assert.equal(
          supplierResult.ok && supplierResult.kind === "UNKNOWN" ? supplierResult.queryKey : "",
          "rc-load-delayed-supplier",
        );

        contention = {
          outboxClaimed: contentionClaimed,
          readsDuringDrain,
          callbacksDuringDrain,
          backlogDomainReads: backlogReads,
          backlogTelegramDomainCallbacks: backlogCallbacks,
          supplierOverlapDomainReads: supplierOverlapReads,
          supplierOverlapTelegramDomainCallbacks: supplierOverlapCallbacks,
          supplier: metric(supplierTimings, 0),
          supplierOutcome: supplierResult.ok ? supplierResult.kind : supplierResult.code,
          waitSampling: {
            sampled: true,
            lockWaitSamples: waitSamples.reduce((sum, sample) => sum + sample.lockWaitSamples, 0),
            maxQueryAgeWhileWaitingMs: Math.max(
              0,
              ...waitSamples.map((sample) => sample.maxQueryAgeWhileWaitingMs),
            ),
            maxSampledTransactionAgeMs: Math.max(
              0,
              ...waitSamples.map((sample) => sample.maxSampledTransactionAgeMs),
            ),
          },
          drainClaimMs: metric(claimDurations, 0),
          drainPublishMs: metric(publishDurations, 0),
          pool: {
            waitingMax: Math.max(0, ...poolSamples.map((sample) => sample.waiting)),
            totalCountMax: Math.max(0, ...poolSamples.map((sample) => sample.total)),
            idleCountMin: Math.min(...poolSamples.map((sample) => sample.idle)),
          },
        };
      } finally {
        clearInterval(poolSampler);
        clearInterval(waitSampler);
        await observerDb.close();
      }
    }

    const plans = await explainHotPaths(ctx);

    console.log(
      JSON.stringify({
        result: "PASS",
        productionData: false,
        seedMs,
        dataset: dataset.counts,
        concurrency: CONCURRENCY,
        metrics: { domainReads: reads, telegramDomainCallbacks: callbacks },
        contention,
        notificationClaimed: notificationClaim.length,
        explains: plans,
      }),
    );
  } finally {
    await ctx?.teardown();
  }
}

await main();
