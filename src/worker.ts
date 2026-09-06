/**
 * Worker entrypoint (T134).
 *
 * The worker is the authoritative side-effect dispatcher: it drains the
 * transactional outbox and performs Telegram sends/edits, SePay reconciliation,
 * supplier provisioning, and delivery notifications. It owns no authoritative
 * business state; PostgreSQL plus the outbox remain the source of truth.
 *
 * Polling is SINGLE-FLIGHT: a new cycle never starts while a previous one is
 * still running, so overlapping setInterval ticks cannot process the same
 * claimed batch twice. Shutdown waits for the in-flight cycle with a bound.
 *
 * See plan.md "Delivery Phases" and contracts/application-commands.md.
 */
import { pathToFileURL } from "node:url";
import { sql } from "kysely";
import { newId } from "./shared/ids/index.js";
import type { Db } from "./infrastructure/db/transaction.js";
import { withTransaction } from "./infrastructure/db/transaction.js";
import { appendAuditEvent } from "./modules/identity/audit.js";
import type { Vault } from "./infrastructure/vault/port.js";
import { pruneTelegramUsernameData } from "./infrastructure/inbox/telegram.js";
import type { SePayReconciliationPort } from "./modules/payments/reconciliation.js";
import type { SupplierPort } from "./modules/supplier/port.js";
import type { RecoveryTelemetry } from "./modules/recovery-result.js";
import { recoverExpiredOrdersBatch } from "./modules/commerce/recovery.js";
import {
  recoverExpiredDeliveryBundlesBatch,
  recoverStaleReservationsBatch,
} from "./modules/digital-goods/recovery.js";
import {
  cleanupDeliveryNotificationCapabilitiesBatch,
  recoverStoredDeliveryNotificationHandoffsBatch,
} from "./modules/digital-goods/delivery-notification.js";
import { recoverSePayBatch } from "./modules/payments/recovery.js";
import { setTimeout as delayNotification } from "node:timers/promises";
import { recoverSupplierOrdersBatch } from "./modules/supplier/recovery.js";
import type { LatencyMetrics } from "./infrastructure/observability/tracing.js";
import { subscribeRestock, unsubscribeRestock, listRestockSubscriptions } from "./modules/catalog/restock.js";
import { reserveNotificationSlot, pauseNotificationRate, notificationPauseRemaining } from "./modules/notification/rate-limit.js";
import {
  cancelBroadcast,
  claimNotificationDeliveries,
  createBroadcast,
  enqueueBroadcastRecipients,
  getBroadcastStatus,
  getNotificationPreferences,
  handleNotificationOutboxEvent,
  markBroadcastPreviewed,
  previewBroadcastAudience,
  processNotificationDeliveryClaim,
  setNotificationPreferences,
  type BroadcastAudience,
} from "./modules/notification/service.js";

interface Stoppable {
  stop: () => Promise<void>;
}

export interface RecoveryCycleResult {
  orders: RecoveryTelemetry;
  reservations: RecoveryTelemetry;
  deliveryBundles: RecoveryTelemetry;
  notificationHandoffs: RecoveryTelemetry;
  deliveryCapabilities: RecoveryTelemetry;
  usernamePrivacy: { observationsDeleted: number; identitiesCleared: number };
  sePay: RecoveryTelemetry | null;
  supplier: RecoveryTelemetry | null;
}

export async function runRecoveryJobsOnce(input: {
  db: Db;
  batchSize: number;
  now?: Date;
  sePayPort: SePayReconciliationPort | null;
  supplierPort: SupplierPort | null;
  vault: Vault;
}): Promise<RecoveryCycleResult> {
  const now = input.now ?? new Date();
  const orders = await recoverExpiredOrdersBatch(input.db, { batchSize: input.batchSize, now });
  const reservations = await recoverStaleReservationsBatch(input.db, {
    batchSize: input.batchSize,
    now,
  });
  const deliveryBundles = await recoverExpiredDeliveryBundlesBatch(input.db, {
    batchSize: input.batchSize,
    now,
  });
  const notificationHandoffs = await recoverStoredDeliveryNotificationHandoffsBatch(input.db, {
    batchSize: input.batchSize,
    now,
  });
  const deliveryCapabilities = await cleanupDeliveryNotificationCapabilitiesBatch(
    input.db,
    input.vault,
    { batchSize: input.batchSize, retentionSeconds: 86_400, now },
  );
  const usernamePrivacy = await pruneTelegramUsernameData(input.db, {
    batchSize: input.batchSize,
    retentionDays: 30,
    now,
  });
  const sePay = input.sePayPort
    ? await recoverSePayBatch(input.db, { batchSize: input.batchSize, now, port: input.sePayPort })
    : null;
  const supplier = input.supplierPort
    ? await recoverSupplierOrdersBatch(input.db, {
        batchSize: input.batchSize,
        now,
        resolvePort: () => input.supplierPort,
        vault: input.vault,
      })
    : null;
  return {
    orders,
    reservations,
    deliveryBundles,
    notificationHandoffs,
    deliveryCapabilities,
    usernamePrivacy,
    sePay,
    supplier,
  };
}

export async function presentAdminCustomerFinancialDetail(db: Db, customerId: string) {
  const result = await sql<{
    id: string;
    status: string;
    balance_vnd: string | null;
    orders: number;
    telegram_user_id: string | null;
    username: string | null;
    display_name: string | null;
    reachable: boolean | null;
    phone_number: string | null;
    total_paid_purchase_vnd: string;
    wallet_spent_vnd: string;
  }>`
    select c.id, c.status, wa.balance_vnd,
      (select count(*)::int from "order" o where o.customer_id = c.id) as orders,
      coalesce((
        select sum(o.price_vnd)::bigint
        from "order" o
        where o.customer_id = c.id
          and o.status in ('PAID','PROCESSING','COMPLETED','REFUND_PENDING')
      ), 0)::text as total_paid_purchase_vnd,
      coalesce((
        select sum(case
          when l.entry_type = 'DEBIT' and l.idempotency_key like 'purchase:%' then l.amount_vnd
          when l.entry_type = 'CREDIT' and l.idempotency_key like 'refund:%' then -l.amount_vnd
          else 0
        end)::bigint
        from wallet_ledger l
        where l.wallet_account_id = wa.id
          and (l.idempotency_key like 'purchase:%' or l.idempotency_key like 'refund:%')
      ), 0)::text as wallet_spent_vnd,
      cps.telegram_user_id, cps.username, cps.display_name, cps.reachable,
      case when cps.phone_shared_at is not null then cps.phone_number end as phone_number
    from customer c
    left join wallet_account wa on wa.customer_id = c.id
    left join customer_profile_snapshot cps on cps.customer_id = c.id
    where c.id = ${customerId}
    limit 1
  `.execute(db);
  const row = result.rows[0];
  if (!row) return { text: "Không tìm thấy khách hàng.", buttons: [[{ text: "Admin", callbackData: "admin:menu" }]] };
  const recent = await sql<{ order_number: string; status: string; price_vnd: string }>`select order_number,status,price_vnd from "order" where customer_id=${customerId} order by created_at desc,id desc limit 1`.execute(db);
  const ledger = await sql<{ entry_type: string; amount_vnd: string; reason: string; created_at: Date }>`select l.entry_type,l.amount_vnd,l.reason,l.created_at from wallet_ledger l join wallet_account a on a.id=l.wallet_account_id where a.customer_id=${customerId} order by l.created_at desc,l.id desc limit 10`.execute(db);
  return {
    text: [
      "Khách hàng",
      "",
      `ID: ${row.id}`,
      `Trạng thái: ${row.status}`,
      `Tên hiển thị: ${row.display_name ?? "chưa có"}`,
      `Telegram: ${row.telegram_user_id ?? "chưa có"}${row.username ? ` (@${row.username})` : ""}`,
      `Có thể nhắn: ${row.reachable ? "có" : "không"}`,
      `SĐT: ${row.phone_number ?? "chưa chia sẻ"}`,
      `Số dư ví: ${BigInt(row.balance_vnd ?? 0).toLocaleString("vi-VN")} ₫`,
      `Số đơn: ${row.orders}`,
      `Tổng đã chi qua đơn đã thanh toán: ${BigInt(row.total_paid_purchase_vnd).toLocaleString("vi-VN")} ₫`,
      "Hoàn tiền: đơn REFUNDED không tính vào tổng; REFUND_PENDING vẫn tính đến khi hoàn tất.",
      `Chi ròng từ ví: ${BigInt(row.wallet_spent_vnd).toLocaleString("vi-VN")} ₫`,
      `Đơn gần nhất: ${recent.rows[0] ? `${recent.rows[0].order_number} · ${recent.rows[0].status} · ${BigInt(recent.rows[0].price_vnd).toLocaleString("vi-VN")} ₫` : "chưa có"}`,
      "10 giao dịch ví gần nhất:",
      ...ledger.rows.map(entry => `${entry.entry_type} ${BigInt(entry.amount_vnd).toLocaleString("vi-VN")} ₫ · ${entry.reason} · ${new Date(entry.created_at).toISOString()}`),
    ].join("\n"),
    buttons: [[{ text: "Admin", callbackData: "admin:menu" }]],
  };
}

export async function queueAdminCustomerMessage(db: Db, input: { customerId: string; content: string; actorId: string; correlationId: string }) {
  return withTransaction(db, async (trx) => {
    const target = await sql<{ chat_id: string }>`
      select cps.chat_id
      from customer c
      join customer_profile_snapshot cps on cps.customer_id = c.id and cps.reachable
      where c.id = ${input.customerId} and c.status = 'ACTIVE'
      limit 1
    `.execute(trx);
    const chatId = target.rows[0]?.chat_id;
    if (!chatId) return false;
    const campaignId = `admin-message:${input.customerId}:${input.correlationId}`;
    await sql`insert into notification_campaign(id, class, content, status, created_by, idempotency_key) values (${campaignId}, 'CRITICAL_SERVICE', ${input.content}, 'QUEUED', ${input.actorId}, ${campaignId}) on conflict (idempotency_key) do nothing`.execute(trx);
    await sql`insert into notification_delivery(id, campaign_id, customer_id, chat_id) values (${newId()}, ${campaignId}, ${input.customerId}, ${chatId}) on conflict (campaign_id, customer_id) do nothing`.execute(trx);
    await appendAuditEvent(trx, { actorType: "ROOT_ADMIN", actorId: input.actorId, action: "customer.message", targetType: "Customer", targetId: input.customerId, reason: "Root admin queued customer notification", correlationId: input.correlationId, metadataRedacted: { length: input.content.length } });
    return true;
  });
}


export interface WorkerSchedulerLogger {
  info: (data: unknown, message: string) => void;
  error: (data: unknown, message: string) => void;
}

export interface WorkerScheduler {
  start: () => void;
  stop: () => Promise<boolean>;
}

export type WorkerSchedulerTimer = NodeJS.Timeout;

export interface WorkerWakeListener {
  start: () => Promise<void>;
  stop: () => Promise<void>;
}

export interface WorkerSchedulerInput {
  lanes: Record<string, () => Promise<void>>;
  pollIntervalMs: number;
  recoveryIntervalMs: number;
  logger: WorkerSchedulerLogger;
  metrics?: LatencyMetrics;
  wakeListener?: WorkerWakeListener;
  setInterval?: (handler: () => void, timeout: number) => WorkerSchedulerTimer;
  clearInterval?: (timer: WorkerSchedulerTimer) => void;
  shutdownTimeoutMs?: number;
}


export function createWorkerScheduler(input: WorkerSchedulerInput): WorkerScheduler {
  const setTimer = input.setInterval ?? ((handler, timeout) => setInterval(handler, timeout));
  const clearTimer = input.clearInterval ?? ((timer) => clearInterval(timer));
  const timers: WorkerSchedulerTimer[] = [];
  const inFlight = new Map<string, Promise<void>>();
  let stopping = false;
  let started = false;

  const run = (name: string): void => {
    const lane = input.lanes[name];
    if (stopping || inFlight.has(name) || !lane) return;
    const startedAt = performance.now();
    const job = (async () => {
      try {
        await lane();
        input.metrics?.observe(`worker.lane.${name}.duration_ms`, performance.now() - startedAt);
      } catch (error) {
        input.metrics?.observe(`worker.lane.${name}.duration_ms`, performance.now() - startedAt, true);
        input.logger.error(
          { lane: name, err: error instanceof Error ? error.message : "unknown error" },
          `${name} worker lane failed`,
        );
      }
    })();
    inFlight.set(name, job);
    void job.finally(() => {
      if (inFlight.get(name) === job) inFlight.delete(name);
    });
  };

  return {
    start() {
      if (stopping || started) return;
      started = true;
      void input.wakeListener?.start().catch((error) => {
        input.logger.error({ err: error instanceof Error ? error.message : "unknown error" }, "worker wake listener failed");
      });
      for (const name of Object.keys(input.lanes)) {
        run(name);
        const interval = name === "recovery" ? input.recoveryIntervalMs : input.pollIntervalMs;
        timers.push(setTimer(() => run(name), interval));
      }
    },
    async stop() {
      if (stopping) return true;
      stopping = true;
      await input.wakeListener?.stop();
      for (const timer of timers) clearTimer(timer);
      timers.length = 0;
      const pending = [...inFlight.values()];
      if (pending.length === 0) return true;
      let timeoutHandle: NodeJS.Timeout | undefined;
      const timeout = new Promise<false>((resolve) => {
        timeoutHandle = setTimeout(() => resolve(false), input.shutdownTimeoutMs ?? 10_000);
      });
      const completed = Promise.allSettled(pending).then(() => true as const);
      try {
        return await Promise.race([completed, timeout]);
      } finally {
        if (timeoutHandle) clearTimeout(timeoutHandle);
      }
    },
  };
}

export interface NotificationDeliveryLaneInput {
  db: Db;
  responder: Parameters<typeof processNotificationDeliveryClaim>[2];
  ratePerSecond: number;
  maxAttempts: number;
  batchSize?: number;
  workers?: number;
  sleep?: (ms: number) => Promise<void>;
}

export async function runNotificationDeliveryLane(input: NotificationDeliveryLaneInput): Promise<void> {
  const deliveries = await claimNotificationDeliveries(input.db, input.batchSize ?? 100);
  let next = 0;
  const sleep = input.sleep ?? delayNotification;
  const sendNext = async (): Promise<void> => {
    while (next < deliveries.length) {
      const delivery = deliveries[next++]!;
      const delay = await reserveNotificationSlot(input.db, delivery.chatId, input.ratePerSecond);
      if (delay > 0) await sleep(delay);
      let pause = await notificationPauseRemaining(input.db);
      while (pause > 0) {
        await sleep(pause);
        pause = await notificationPauseRemaining(input.db);
      }
      await processNotificationDeliveryClaim(input.db, delivery, input.responder, {
        maxAttempts: input.maxAttempts,
        retryAfterSeconds: error => error instanceof Error && "retryAfterSeconds" in error && typeof error.retryAfterSeconds === "number" ? error.retryAfterSeconds : null,
        onRateLimit: seconds => pauseNotificationRate(input.db, seconds),
      });
    }
  };
  await Promise.all(Array.from({ length: input.workers ?? 4 }, sendNext));
}


async function bootstrap(): Promise<void> {
  // Load local `.env` for development; production should inject environment
  // variables through the deployment secret manager.
  await import("dotenv/config");

  const { loadConfig } = await import("./config/index.js");
  const config = loadConfig(process.env);

  const { createLogger } = await import("./infrastructure/observability/logger.js");
  const logger = createLogger(config);

  const { createDb } = await import("./infrastructure/db/client.js");
  const { createVault } = await import("./infrastructure/vault/adapter.js");
  const { drainOutboxOnce } = await import("./infrastructure/outbox/worker.js");
  const { createFulfillmentOutboxHandler } = await import("./modules/digital-goods/handlers.js");
  const { createFulfillmentTelemetry } = await import("./modules/digital-goods/telemetry.js");
  const { createSandboxSupplierAdapter } = await import("./modules/supplier/adapters/primary.js");
  const { createSePayApiPort } = await import("./modules/payments/sepay-api.js");
  const {
    consumeTelegramUsernameObservation,
    createPostgresTelegramInbox,
    processTelegramInboxBatch,
  } = await import("./infrastructure/inbox/telegram.js");
  const { createPostgresSePayInbox, processSePayInboxBatch } =
    await import("./infrastructure/inbox/sepay.js");
  const { applyPaymentEvidence } = await import("./modules/payments/service.js");
  const { createPostgresRateLimiter, DEFAULT_TELEGRAM_RATE_LIMIT_POLICIES } =
    await import("./modules/risk/service.js");
  const { createBuyNowCallbackCodec, createCallbackTokenCodec } =
    await import("./bot/callback-codec.js");
  const { createCatalogCallbacks } = await import("./bot/callbacks/catalog.js");
  const { createCheckoutCallbacks } = await import("./bot/callbacks/checkout.js");
  const { createHistoryCallbacks } = await import("./bot/callbacks/history.js");
  const { createSupportCallbacks } = await import("./bot/callbacks/support.js");
  const { presentPaymentScreen } = await import("./bot/presenters/payment.js");
  const { createWalletLedgerService } = await import("./modules/wallet/ledger.js");
  const { presentWalletTopup, applyWalletTopupEvidence } = await import("./modules/wallet/topup.js");
  const { createWalletPurchaseService } = await import("./modules/wallet/purchase.js");
  const { createTelegramDomainDispatcher } = await import("./bot/callbacks/telegram-dispatch.js");
  const { createGrammyResponder } = await import("./bot/grammy-responder.js");
  const { createSearchParser } = await import("./modules/catalog/search-parser-adapter.js");
  const { findOrderById, findOrderByNumber } = await import("./modules/commerce/repository.js");
  const { bootstrapRootTelegramIdentity, ensureTelegramIdentity, resolveTelegramCustomerId } =
    await import("./modules/identity/channel-identity.js");
  const { upsertTelegramCustomerProfileSnapshot } = await import("./modules/identity/customer-profile.js");
  const { createAdminConfirmation } = await import("./modules/identity/admin-confirmation.js");
  const { createAdminCallbacks, OWNER_COMMANDS } = await import("./bot/callbacks/admin.js");
  const { importDigitalInventory } = await import("./modules/digital-goods/inventory-import.js");
  const {
    cancelInventoryImportSession,
    confirmInventoryImportSession,
    getInventoryImportSession,
    stageInventoryImportInput,
    startInventoryImportSession,
  } = await import("./modules/digital-goods/inventory-import-session.js");
  const { createDurableProductDraftWorkflow, createProductDraftRepository } =
    await import("./modules/catalog/product-draft.js");
  const { createAdminProduct } = await import("./modules/catalog/admin-products.js");
  const {
    presentAdminBroadcastAudience,
    presentAdminBroadcastPreview,
    presentAdminBroadcastPrompt,
    presentAdminBroadcastStatus,
    presentAdminDenied,
    presentAdminDashboard,
    presentAdminInventory,
    presentAdminMarketingMenu,
    presentAdminMenu,
    presentAdminProductDetail,
    presentAdminProducts,
    presentHighRiskChallenge,
    presentHighRiskDone,
    presentInventoryImportPreview,
    presentInventoryImportPrompt,
    presentProductDraftPreview,
    presentKillSwitchDone,
  } = await import("./bot/presenters/admin.js");

  const dbHandle = createDb({ connectionString: config.DATABASE_URL });
  const vault = createVault({
    driver: config.VAULT_DRIVER,
    endpoint: config.VAULT_ENDPOINT,
    token: config.VAULT_TOKEN,
    namespace: config.VAULT_NAMESPACE,
    timeoutMs: config.VAULT_TIMEOUT_MS,
    maxAttempts: config.VAULT_MAX_ATTEMPTS,
    egressPolicy: {
      allowedHosts: config.VAULT_EGRESS_HOST_ALLOWLIST,
      allowedPorts: config.VAULT_EGRESS_PORT_ALLOWLIST,
      allowedCidrs: config.VAULT_EGRESS_CIDR_ALLOWLIST,
    },
  });
  await vault.health?.();
  const telemetry = createFulfillmentTelemetry();
  // Fixture supplier for local/dev; production swaps an HTTP adapter (T143).
  const supplier =
    config.SUPPLIER_DRIVER === "fixture" ? createSandboxSupplierAdapter({ mode: "fulfill" }) : null;
  const sePayRecoveryPort =
    config.SEPAY_API_TOKEN.length > 0
      ? createSePayApiPort({
          baseUrl: config.SEPAY_API_BASE_URL,
          token: config.SEPAY_API_TOKEN,
        })
      : null;

  const handler = createFulfillmentOutboxHandler({
    db: dbHandle.db,
    vault,
    supplier,
    deliveryBaseUrl: `${config.APP_BASE_URL.replace(/\/$/, "")}/d`,
    bundleTtlSeconds: config.DELIVERY_BUNDLE_TTL_SECONDS,
    deliverySession: {
      config: {
        key: config.DELIVERY_SESSION_HMAC_KEY,
        keyVersion: config.DELIVERY_SESSION_KEY_VERSION,
        audience: "delivery-reveal",
        ...(config.DELIVERY_SESSION_PREVIOUS_HMAC_KEY &&
        config.DELIVERY_SESSION_PREVIOUS_KEY_VERSION !== undefined &&
        config.DELIVERY_SESSION_PREVIOUS_KEY_GRACE_UNTIL
          ? {
              previousKey: config.DELIVERY_SESSION_PREVIOUS_HMAC_KEY,
              previousKeyVersion: config.DELIVERY_SESSION_PREVIOUS_KEY_VERSION,
              previousKeyGraceUntil: new Date(config.DELIVERY_SESSION_PREVIOUS_KEY_GRACE_UNTIL),
            }
          : {}),
      },
      ttlSeconds: config.DELIVERY_SESSION_TTL_SECONDS,
    },
    telemetry,
    // Telegram notifier is wired once the bot client is available (T150).
    // Until then the outbox still advances domain state; notification is a
    // best-effort side effect.
  });

  const callbackConfig = {
    key: config.BUY_NOW_CALLBACK_HMAC_KEY,
    keyVersion: config.BUY_NOW_CALLBACK_KEY_VERSION,
    ttlSeconds: config.BUY_NOW_CALLBACK_TTL_SECONDS,
    clockSkewSeconds: config.BUY_NOW_CALLBACK_CLOCK_SKEW_SECONDS,
  };
  const buyNowCodec = createBuyNowCallbackCodec(callbackConfig);
  const callbackCodec = createCallbackTokenCodec(callbackConfig);
  const resolveCustomerId = (telegramUserId: string): Promise<string | null> =>
    resolveTelegramCustomerId(dbHandle.db, telegramUserId);
  const catalog = createCatalogCallbacks({
    db: dbHandle.db,
    parser: createSearchParser({
      driver: config.SEARCH_PARSER_DRIVER,
      timeoutMs: config.SEARCH_PARSER_TIMEOUT_MS,
    }),
    callbackCodec: buyNowCodec,
  });
  const checkout = createCheckoutCallbacks({
    db: dbHandle.db,
    merchant: {
      merchantAccountId: config.SEPAY_MERCHANT_ACCOUNT_ID,
      beneficiaryAccountNumber: config.VIETQR_ACCOUNT_NUMBER,
      bankBin: config.VIETQR_BANK_BIN,
      accountName: config.VIETQR_ACCOUNT_NAME,
      bankName: config.VIETQR_BANK_NAME,
      bankAlias: config.VIETQR_BANK_ALIAS,
      template: config.VIETQR_TEMPLATE,
    },
    callbackCodec: buyNowCodec,
    resolveCustomerId,
  });
  const history = createHistoryCallbacks({ db: dbHandle.db });
  const notificationService = { getNotificationPreferences, setNotificationPreferences };
  const walletLedger = createWalletLedgerService(dbHandle.db);
  const walletPurchase = createWalletPurchaseService(dbHandle.db);
  const merchant = {
    merchantAccountId: config.SEPAY_MERCHANT_ACCOUNT_ID,
    beneficiaryAccountNumber: config.VIETQR_ACCOUNT_NUMBER,
    bankBin: config.VIETQR_BANK_BIN,
    accountName: config.VIETQR_ACCOUNT_NAME,
    bankName: config.VIETQR_BANK_NAME,
    bankAlias: config.VIETQR_BANK_ALIAS,
    template: config.VIETQR_TEMPLATE,
  };
  const support = createSupportCallbacks({ db: dbHandle.db });
  const rootIdentity =
    config.ADMIN_TELEGRAM_USER_ID > 0
      ? await bootstrapRootTelegramIdentity(dbHandle.db, {
          telegramUserId: String(config.ADMIN_TELEGRAM_USER_ID),
        })
      : null;
  const adminCallbacks = rootIdentity
    ? createAdminCallbacks({
        db: dbHandle.db,
        vault,
        rootConfig: {
          adminTelegramUserId: config.ADMIN_TELEGRAM_USER_ID,
          expectedUsername: config.ADMIN_EXPECTED_USERNAME,
        },
        rootChannelIdentityId: rootIdentity.channelIdentityId,
        confirmation: createAdminConfirmation(dbHandle.db),
        inventoryImport: async (input) => {
          const result = await importDigitalInventory({
            ...input,
            db: dbHandle.db,
            vault,
            config: {
              adminTelegramUserId: config.ADMIN_TELEGRAM_USER_ID,
              expectedUsername: config.ADMIN_EXPECTED_USERNAME,
            },
          });
          if (!result.ok) throw new Error(result.code);
          return result.summary;
        },
      })
    : null;
  const productDraftWorkflow = createDurableProductDraftWorkflow(
    createProductDraftRepository(dbHandle.db),
  );
  const telegramInbox = createPostgresTelegramInbox(dbHandle.db);
  const sepayInbox = createPostgresSePayInbox(dbHandle.db);
  const telegramLimiter = createPostgresRateLimiter(
    dbHandle.db,
    DEFAULT_TELEGRAM_RATE_LIMIT_POLICIES,
  );
  const telegramResponder = createGrammyResponder(
    config.TELEGRAM_BOT_TOKEN,
    undefined,
    config.NODE_ENV !== "production" ? logger : undefined,
  );
  const telegramDispatcher = createTelegramDomainDispatcher({
    codec: callbackCodec,
    resolveCustomerId,
    catalog,
    checkout,
    history,
    support,
    resolveOrderById: (orderId) => findOrderById(dbHandle.db, orderId),
    resolveOrderIdByNumber: async (orderNumber) =>
      (await findOrderByNumber(dbHandle.db, orderNumber))?.id ?? null,
    resolveCatalogPage: async (cursorVariantId) => {
      const result = await sql<{ category_id: string; sort_order: number }>`
        select p.category_id, v.sort_order
        from product_variant v
        join product p on p.id = v.product_id
        where v.id = ${cursorVariantId}
        limit 1
      `.execute(dbHandle.db);
      const row = result.rows[0];
      return row
        ? {
            categoryId: row.category_id,
            cursor: Buffer.from(`${row.sort_order}:${cursorVariantId}`, "utf8").toString("base64url"),
          }
        : null;
    },
    restock: {
      async subscribe(customerId, variantId) {
        await subscribeRestock(dbHandle.db, customerId, variantId);
        await setNotificationPreferences(dbHandle.db, { customerId, shopUpdates: true });
        return { text: "Đã đăng ký báo có hàng.", buttons: [] };
      },
      async unsubscribe(customerId, variantId) {
        await unsubscribeRestock(dbHandle.db, customerId, variantId);
        return { text: "Đã hủy báo có hàng.", buttons: [] };
      },
      async list(customerId) {
        const subscriptions = await listRestockSubscriptions(dbHandle.db, customerId);
        return { text: `Đang theo dõi ${subscriptions.length} sản phẩm.`, buttons: [] };
      },
    },
    notification: {
      async settings(customerId) {
        const p = await notificationService.getNotificationPreferences(dbHandle.db, customerId);
        return { text: `Cài đặt thông báo: cập nhật ${p.shopUpdates ? "BẬT" : "TẮT"}, hoạt động ${p.purchaseActivity ? "BẬT" : "TẮT"}. Gửi “🛍 Tắt cập nhật sản phẩm” hoặc “📣 Tắt hoạt động mua hàng” để đổi trạng thái.`, buttons: [] };
      },
      async toggle(customerId, kind) {
        const p = await notificationService.getNotificationPreferences(dbHandle.db, customerId);
        const next = await notificationService.setNotificationPreferences(dbHandle.db, { customerId, ...(kind === "shop" ? { shopUpdates: !p.shopUpdates } : { purchaseActivity: !p.purchaseActivity }) });
        return { text: `Đã ${kind === "shop" ? (next.shopUpdates ? "bật" : "tắt") : (next.purchaseActivity ? "bật" : "tắt")} thông báo.`, buttons: [] };
      },
      async subscriptions(customerId) {
        const rows = await sql<{ variant_id: string }>`select variant_id from restock_subscription where customer_id=${customerId} and active order by created_at`.execute(dbHandle.db);
        return { text: rows.rows.length ? `🔔 Đang theo dõi ${rows.rows.length} sản phẩm báo có hàng.` : "Bạn chưa theo dõi sản phẩm nào.", buttons: [] };
      },
    },
    shopUrl: config.APP_BASE_URL,
    async walletAccount(ctx) {
      const customerId = await resolveCustomerId(ctx.telegramUserId);
      if (!customerId) return { text: "Không xác minh được khách hàng.", buttons: [[{ text: "Menu chính", callbackData: "menu:main" }]] };
      const account = await walletLedger.ensureAccount(customerId);
      if (!account) return { text: "Không tìm thấy tài khoản khách hàng.", buttons: [[{ text: "Menu chính", callbackData: "menu:main" }]] };
      return {
        text: `Ví của bạn\n\nSố dư: ${account.balanceVnd.toLocaleString("vi-VN")} ₫`,
        buttons: [[{ text: "Nạp ví", callbackData: "wallet:topup" }], [{ text: "Menu chính", callbackData: "menu:main" }]],
      };
    },
    async walletTopup(ctx) {
      const customerId = await resolveCustomerId(ctx.telegramUserId);
      if (!customerId) return { text: "Không xác minh được khách hàng.", buttons: [[{ text: "Menu chính", callbackData: "menu:main" }]] };
      const result = await presentWalletTopup({ db: dbHandle.db, customerId, amountVnd: 100000n, correlationId: ctx.correlationId, ...merchant });
      return result.ok ? presentPaymentScreen(result.presentation) : { text: "Không tạo được mã nạp ví. Vui lòng thử lại.", buttons: [[{ text: "Ví", callbackData: "wallet:account" }]] };
    },
    async walletPay(ctx, orderNumber) {
      const customerId = await resolveCustomerId(ctx.telegramUserId);
      if (!customerId) return { text: "Không xác minh được khách hàng.", buttons: [[{ text: "Menu chính", callbackData: "menu:main" }]] };
      const orderId = (await findOrderByNumber(dbHandle.db, orderNumber))?.id;
      if (!orderId) return { text: "Không tìm thấy đơn hàng.", buttons: [[{ text: "Đơn hàng", callbackData: "ord:list" }]] };
      const result = await walletPurchase.purchase({ customerId, orderId, idempotencyKey: `telegram:${ctx.telegramUserId}:${orderId}`, correlationId: ctx.correlationId });
      return result.ok
        ? { text: "Đã thanh toán bằng ví. Chúng tôi sẽ giao tài khoản ngay.", buttons: [[{ text: "Xem đơn", callbackData: `ord:view:${orderId}` }], [{ text: "Menu chính", callbackData: "menu:main" }]] }
        : { text: result.message, buttons: [[{ text: "Nạp ví", callbackData: "wallet:topup" }], [{ text: "Đơn hàng", callbackData: "ord:list" }]] };
    },
    admin: {
      async presentAdminCustomerDetail(ctx, customerId) {
        if (Number(ctx.telegramUserId) !== config.ADMIN_TELEGRAM_USER_ID || ctx.chatType !== "private") return presentAdminDenied("NOT_ROOT_ADMIN");
        return presentAdminCustomerFinancialDetail(dbHandle.db, customerId);
      },
      async sendAdminCustomerMessage(ctx, input) {
        if (Number(ctx.telegramUserId) !== config.ADMIN_TELEGRAM_USER_ID || ctx.chatType !== "private") return presentAdminDenied("NOT_ROOT_ADMIN");
        const content = input.text.trim();
        if (!content || content.length > 4096) return { text: "Nội dung tin nhắn không hợp lệ.", buttons: [[{ text: "Admin", callbackData: "admin:menu" }]] };
        const queued = await queueAdminCustomerMessage(dbHandle.db, {
          customerId: input.customerId,
          content,
          actorId: String(ctx.telegramUserId),
          correlationId: ctx.correlationId,
        });
        return queued ? { text: "Đã đưa tin nhắn vào hàng đợi gửi khách hàng.", buttons: [[{ text: "Admin", callbackData: "admin:menu" }]] } : { text: "Khách hàng không có kênh Telegram khả dụng.", buttons: [[{ text: "Admin", callbackData: "admin:menu" }]] };
      },
      async mainMenu(input) {
        if (!adminCallbacks) return presentAdminDenied("NOT_ROOT_ADMIN");
        const result = await adminCallbacks.handle({
          command: "order.inspect",
          actor: { numericUserId: Number(input.telegramUserId), chatType: "private" },
          targetId: "admin-menu",
          reason: "Admin menu access",
          correlationId: input.correlationId,
        });
        return result.ok ? presentAdminMenu() : presentAdminDenied(result.code === "WRONG_CONTEXT" ? "WRONG_CONTEXT" : "NOT_ROOT_ADMIN");
      },
      async dashboard(input) {
        if (!adminCallbacks) return presentAdminDenied("NOT_ROOT_ADMIN");
        const gate = await adminCallbacks.handle({
          command: "order.inspect",
          actor: { numericUserId: Number(input.telegramUserId), chatType: "private" },
          targetId: "admin-dashboard",
          reason: "Admin dashboard access",
          correlationId: input.correlationId,
        });
        if (!gate.ok) return presentAdminDenied(gate.code === "WRONG_CONTEXT" ? "WRONG_CONTEXT" : "NOT_ROOT_ADMIN");
        const result = await sql<{
          active_products: number;
          out_of_stock: number;
          low_stock: number;
          available_inventory: number;
          orders_today: number;
          paid_today: number;
          revenue_today_vnd: string | number;
          pending_payment: number;
          payment_review: number;
          fulfillment_failures: number;
        }>`
          with variant_stock as (
            select v.id as variant_id, count(da.id)::int as available
            from product_variant v
            left join digital_asset da on da.variant_id = v.id and da.status = 'AVAILABLE'
            where v.is_active
            group by v.id
          )
          select
            (select count(*)::int from product where is_active) as active_products,
            (select count(*)::int from variant_stock where available = 0) as out_of_stock,
            (select count(*)::int from variant_stock where available between 1 and 2) as low_stock,
            coalesce((select sum(available)::int from variant_stock), 0) as available_inventory,
            (select count(*)::int from "order" where created_at >= date_trunc('day', now())) as orders_today,
            (select count(*)::int from "order" where status in ('PAID', 'PROCESSING', 'COMPLETED') and paid_at >= date_trunc('day', now())) as paid_today,
            coalesce((select sum(price_vnd)::bigint from "order" where status in ('PAID', 'PROCESSING', 'COMPLETED') and paid_at >= date_trunc('day', now())), 0) as revenue_today_vnd,
            (select count(*)::int from "order" where status = 'PENDING_PAYMENT') as pending_payment,
            (select count(*)::int from "order" where status = 'PAYMENT_NEEDS_REVIEW') as payment_review,
            (select count(*)::int from "order" where status = 'FULFILLMENT_NEEDS_REVIEW') as fulfillment_failures
        `.execute(dbHandle.db);
        const row = result.rows[0] ?? {
          active_products: 0,
          out_of_stock: 0,
          low_stock: 0,
          available_inventory: 0,
          orders_today: 0,
          paid_today: 0,
          revenue_today_vnd: 0,
          pending_payment: 0,
          payment_review: 0,
          fulfillment_failures: 0,
        };
        return presentAdminDashboard({
          activeProducts: row.active_products,
          outOfStock: row.out_of_stock,
          lowStock: row.low_stock,
          availableInventory: row.available_inventory,
          ordersToday: row.orders_today,
          paidToday: row.paid_today,
          revenueTodayVnd: BigInt(row.revenue_today_vnd),
          pendingPayment: row.pending_payment,
          paymentReview: row.payment_review,
          fulfillmentFailures: row.fulfillment_failures,
        });
      },
      async products(input) {
        if (!adminCallbacks) return presentAdminDenied("NOT_ROOT_ADMIN");
        const gate = await adminCallbacks.handle({
          command: "order.inspect",
          actor: { numericUserId: Number(input.telegramUserId), chatType: "private" },
          targetId: "admin-products",
          reason: "Admin products access",
          correlationId: input.correlationId,
        });
        if (!gate.ok) return presentAdminDenied(gate.code === "WRONG_CONTEXT" ? "WRONG_CONTEXT" : "NOT_ROOT_ADMIN");
        const result = await sql<{ id: string; name: string; active: boolean }>`
          select id, name_vi as name, is_active as active
          from product
          order by sort_order asc, id asc
          limit 20
        `.execute(dbHandle.db);
        return presentAdminProducts(result.rows);
      },
      async productDetail(input) {
        if (!adminCallbacks) return presentAdminDenied("NOT_ROOT_ADMIN");
        const gate = await adminCallbacks.handle({
          command: "order.inspect",
          actor: { numericUserId: Number(input.telegramUserId), chatType: "private" },
          targetId: input.productId,
          reason: "Admin product detail access",
          correlationId: input.correlationId,
        });
        if (!gate.ok) return presentAdminDenied(gate.code === "WRONG_CONTEXT" ? "WRONG_CONTEXT" : "NOT_ROOT_ADMIN");
        const result = await sql<{
          id: string;
          name: string;
          slug: string;
          category_name: string;
          description: string | null;
          active: boolean;
          variant_count: number;
          min_price_vnd: string | null;
        }>`
          select
            p.id,
            p.name_vi as name,
            p.slug,
            c.name_vi as category_name,
            p.short_description_vi as description,
            p.is_active as active,
            count(v.id)::int as variant_count,
            min(v.price_vnd)::bigint as min_price_vnd
          from product p
          join category c on c.id = p.category_id
          left join product_variant v on v.product_id = p.id
          where p.id = ${input.productId}
          group by p.id, c.name_vi
          limit 1
        `.execute(dbHandle.db);
        const row = result.rows[0];
        if (!row) return { text: "Sản phẩm không còn hợp lệ.", buttons: [[{ text: "Products", callbackData: "admin:products" }]] };
        return presentAdminProductDetail({
          id: row.id,
          name: row.name,
          slug: row.slug,
          categoryName: row.category_name,
          description: row.description,
          active: row.active,
          variantCount: row.variant_count,
          minPriceVnd: BigInt(row.min_price_vnd ?? 0),
        });
      },
      async handleToken(input) {
        const command = OWNER_COMMANDS[input.option];
        if (!command || !adminCallbacks) return presentAdminDenied("NOT_ROOT_ADMIN");
        const result = await adminCallbacks.handle({
          command,
          actor: { numericUserId: Number(input.telegramUserId), chatType: "private" },
          targetId: input.targetId,
          reason: "Signed Telegram owner callback",
          correlationId: input.correlationId,
        });
        if (!result.ok) return presentAdminDenied(result.code === "WRONG_CONTEXT" ? "WRONG_CONTEXT" : "NOT_ROOT_ADMIN");
        if (result.needsConfirmation) return presentHighRiskChallenge({ confirmationId: result.confirmationId, challenge: result.challenge, expiresAt: result.expiresAt, action: command });
        if (command === "catalog.activate" || command === "catalog.deactivate") return presentKillSwitchDone({ command, targetId: input.targetId });
        return result.inventorySummary
          ? { text: `✅ Nhập kho: ${result.inventorySummary.imported} mới, ${result.inventorySummary.duplicates} trùng, ${result.inventorySummary.invalid} lỗi`, buttons: [[{ text: "Menu chính", callbackData: "menu:main" }]] }
          : { text: "✅ Đã ghi nhận lệnh quản trị.", buttons: [[{ text: "Menu chính", callbackData: "menu:main" }]] };
      },
      async confirm(input) {
        if (!adminCallbacks) return presentAdminDenied("NOT_ROOT_ADMIN");
        if (input.chatType !== "private") return presentAdminDenied("WRONG_CONTEXT");
        const result = await adminCallbacks.confirm({
          confirmationId: input.confirmationId,
          challenge: input.challenge,
          actor: { numericUserId: Number(input.telegramUserId), chatType: input.chatType },
          correlationId: input.correlationId,
        });
        return result.ok ? presentHighRiskDone("admin.confirm") : { text: "❌ Xác nhận thất bại hoặc đã hết hạn", buttons: [[{ text: "Admin", callbackData: "admin:menu" }]] };
      },
      async inventory(input) {
        if (!adminCallbacks) return presentAdminDenied("NOT_ROOT_ADMIN");
        const gate = await adminCallbacks.handle({
          command: "order.inspect",
          actor: { numericUserId: Number(input.telegramUserId), chatType: "private" },
          targetId: "admin-inventory",
          reason: "Admin inventory access",
          correlationId: input.correlationId,
        });
        if (!gate.ok) return presentAdminDenied(gate.code === "WRONG_CONTEXT" ? "WRONG_CONTEXT" : "NOT_ROOT_ADMIN");
        const result = await sql<{ available_inventory: number }>`
          select count(*)::int as available_inventory
          from digital_asset
          where status = 'AVAILABLE'
        `.execute(dbHandle.db);
        return presentAdminInventory(result.rows[0]?.available_inventory ?? 0);
      },
      async importPreview(input) {
        if (!adminCallbacks) return presentAdminDenied("NOT_ROOT_ADMIN");
        const gate = await adminCallbacks.handle({
          command: "order.inspect",
          actor: { numericUserId: Number(input.telegramUserId), chatType: "private" },
          targetId: "admin-inventory-import",
          reason: "Admin inventory import preview",
          correlationId: input.correlationId,
        });
        if (!gate.ok) return presentAdminDenied(gate.code === "WRONG_CONTEXT" ? "WRONG_CONTEXT" : "NOT_ROOT_ADMIN");
        const session = await startInventoryImportSession(dbHandle.db, {
          actor: { numericUserId: Number(input.telegramUserId), chatType: "private" },
          config: { adminTelegramUserId: config.ADMIN_TELEGRAM_USER_ID, expectedUsername: config.ADMIN_EXPECTED_USERNAME },
          correlationId: input.correlationId,
        });
        if (!session.ok) return presentAdminDenied(session.code === "WRONG_CONTEXT" ? "WRONG_CONTEXT" : "NOT_ROOT_ADMIN");
        return presentInventoryImportPrompt();
      },
      async importText(input) {
        if (!adminCallbacks) return null;
        const session = await getInventoryImportSession(dbHandle.db, String(input.telegramUserId));
        if (!session || session.status === "COMMITTED" || session.status === "CANCELLED") return null;
        const result = await stageInventoryImportInput(dbHandle.db, vault, {
          actor: { numericUserId: Number(input.telegramUserId), chatType: input.chatType as "private" },
          config: { adminTelegramUserId: config.ADMIN_TELEGRAM_USER_ID, expectedUsername: config.ADMIN_EXPECTED_USERNAME },
          correlationId: input.correlationId,
          rawInput: input.text,
        });
        if (!result.ok) {
          if (result.code === "NOT_FOUND" || result.code === "EXPIRED") return null;
          return {
            text: "Dữ liệu nhập kho không hợp lệ. Dán lại nội dung CSV đúng định dạng.",
            buttons: [[{ text: "↩️ Huỷ nhập kho", callbackData: "admin:inventory:cancel" }], [{ text: "📦 Nhập kho", callbackData: "admin:inventory:import" }]],
          };
        }
        const preview = result.preview;
        return presentInventoryImportPreview({
          ready: preview.ready,
          invalid: preview.invalid,
          duplicates: preview.duplicates,
          variants: preview.lines.filter((line) => line.classification === "READY" && line.variantId).map((line) => line.variantId!),
        });
      },
      async importConfirm(input) {
        if (!adminCallbacks) return presentAdminDenied("NOT_ROOT_ADMIN");
        const result = await confirmInventoryImportSession(dbHandle.db, vault, {
          actor: { numericUserId: Number(input.telegramUserId), chatType: "private" },
          config: { adminTelegramUserId: config.ADMIN_TELEGRAM_USER_ID, expectedUsername: config.ADMIN_EXPECTED_USERNAME },
          correlationId: input.correlationId,
        });
        if (!result.ok) {
          return {
            text:
              result.code === "NOT_READY"
                ? "Phiên nhập kho chưa sẵn sàng. Hãy dán dữ liệu trước."
                : result.code === "BUSY"
                  ? "Phiên nhập kho đang được xử lý."
                  : result.code === "EXPIRED"
                    ? "Phiên nhập kho đã hết hạn. Hãy tạo lại phiên mới."
                    : "Không thể xác nhận nhập kho.",
            buttons: [[{ text: "📦 Nhập kho", callbackData: "admin:inventory:import" }], [{ text: "🛍 Sản phẩm", callbackData: "admin:products" }]],
          };
        }
        return {
          text: `✅ Nhập kho: ${result.summary.imported} mới, ${result.summary.duplicates} trùng, ${result.summary.invalid} lỗi`,
          buttons: [[{ text: "📦 Kho hàng", callbackData: "admin:inventory" }, { text: "🛍 Sản phẩm", callbackData: "admin:products" }]],
        };
      },
      async marketing(input) {
        if (!adminCallbacks) return presentAdminDenied("NOT_ROOT_ADMIN");
        const gate = await adminCallbacks.handle({
          command: "order.inspect",
          actor: { numericUserId: Number(input.telegramUserId), chatType: "private" },
          targetId: "admin-marketing",
          reason: "Admin marketing access",
          correlationId: input.correlationId,
        });
        return gate.ok ? presentAdminMarketingMenu() : presentAdminDenied(gate.code === "WRONG_CONTEXT" ? "WRONG_CONTEXT" : "NOT_ROOT_ADMIN");
      },
      async broadcastCompose(input) {
        if (!adminCallbacks) return presentAdminDenied("NOT_ROOT_ADMIN");
        const gate = await adminCallbacks.handle({
          command: "order.inspect",
          actor: { numericUserId: Number(input.telegramUserId), chatType: "private" },
          targetId: "admin-broadcast-compose",
          reason: "Admin broadcast compose",
          correlationId: input.correlationId,
        });
        return gate.ok ? presentAdminBroadcastAudience() : presentAdminDenied(gate.code === "WRONG_CONTEXT" ? "WRONG_CONTEXT" : "NOT_ROOT_ADMIN");
      },
      async broadcastAudience(input) {
        if (Number(input.telegramUserId) !== config.ADMIN_TELEGRAM_USER_ID || input.chatType !== "private") return presentAdminDenied("NOT_ROOT_ADMIN");
        await sql`delete from notification_campaign where created_by=${String(input.telegramUserId)} and status='DRAFT' and idempotency_key like ${`admin-broadcast:${input.telegramUserId}:%`}`.execute(dbHandle.db);
        await createBroadcast(dbHandle.db, { class: "CRITICAL_SERVICE", content: "DRAFT", createdBy: String(input.telegramUserId), idempotencyKey: `admin-broadcast:${input.telegramUserId}:${input.correlationId}`, audience: input.audience });
        return presentAdminBroadcastPrompt(input.audience);
      },
      async broadcastText(input) {
        if (Number(input.telegramUserId) !== config.ADMIN_TELEGRAM_USER_ID || input.chatType !== "private") return null;
        const draft = await sql<{ id: string; audience: BroadcastAudience }>`select id,audience from notification_campaign where created_by=${String(input.telegramUserId)} and status='DRAFT' and idempotency_key like ${`admin-broadcast:${input.telegramUserId}:%`} order by created_at desc limit 1`.execute(dbHandle.db);
        const row = draft.rows[0];
        if (!row) return null;
        const content = input.text.trim();
        if (!content || content.length > 4096) return { text: "Nội dung thông báo không hợp lệ.", buttons: [[{ text: "Huỷ", callbackData: `admin:marketing:cancel:${row.id}` }]] };
        await markBroadcastPreviewed(dbHandle.db, { campaignId: row.id, createdBy: String(input.telegramUserId), content });
        const count = await previewBroadcastAudience(dbHandle.db, row.audience, String(config.ADMIN_TELEGRAM_USER_ID));
        return presentAdminBroadcastPreview({ campaignId: row.id, audience: row.audience, count, content });
      },
      async broadcastConfirm(input) {
        if (Number(input.telegramUserId) !== config.ADMIN_TELEGRAM_USER_ID || input.chatType !== "private") return presentAdminDenied("NOT_ROOT_ADMIN");
        await enqueueBroadcastRecipients(dbHandle.db, input.campaignId, String(config.ADMIN_TELEGRAM_USER_ID), String(input.telegramUserId));
        const status = await getBroadcastStatus(dbHandle.db, input.campaignId);
        return status ? presentAdminBroadcastStatus(status) : { text: "Không tìm thấy thông báo.", buttons: [[{ text: "📣 Tiếp thị", callbackData: "admin:marketing" }]] };
      },
      async broadcastCancel(input) {
        if (Number(input.telegramUserId) !== config.ADMIN_TELEGRAM_USER_ID || input.chatType !== "private") return presentAdminDenied("NOT_ROOT_ADMIN");
        const campaignId = input.campaignId ?? (await sql<{ id: string }>`select id from notification_campaign where created_by=${String(input.telegramUserId)} and status='DRAFT' and idempotency_key like ${`admin-broadcast:${input.telegramUserId}:%`} order by created_at desc limit 1`.execute(dbHandle.db)).rows[0]?.id;
        if (campaignId) await cancelBroadcast(dbHandle.db, campaignId);
        return { text: "Đã huỷ thông báo.", buttons: [[{ text: "📣 Tiếp thị", callbackData: "admin:marketing" }]] };
      },
      async broadcastStatus(input) {
        if (Number(input.telegramUserId) !== config.ADMIN_TELEGRAM_USER_ID || input.chatType !== "private") return presentAdminDenied("NOT_ROOT_ADMIN");
        const status = await getBroadcastStatus(dbHandle.db, input.campaignId);
        return status ? presentAdminBroadcastStatus(status) : { text: "Không tìm thấy thông báo.", buttons: [[{ text: "📣 Tiếp thị", callbackData: "admin:marketing" }]] };
      },
      async importCancel(input) {
        if (!adminCallbacks) return presentAdminDenied("NOT_ROOT_ADMIN");
        const result = await cancelInventoryImportSession(dbHandle.db, vault, {
          actor: { numericUserId: Number(input.telegramUserId), chatType: "private" },
          config: { adminTelegramUserId: config.ADMIN_TELEGRAM_USER_ID, expectedUsername: config.ADMIN_EXPECTED_USERNAME },
          correlationId: input.correlationId,
        });
        if (!result.ok) return presentAdminDenied(result.code === "WRONG_CONTEXT" ? "WRONG_CONTEXT" : "NOT_ROOT_ADMIN");
        return { text: "Đã huỷ phiên nhập kho.", buttons: [[{ text: "📦 Kho hàng", callbackData: "admin:inventory" }], [{ text: "🛍 Sản phẩm", callbackData: "admin:products" }]] };
      },
      workflow: {
        async start(input) {
          if (Number(input.telegramUserId) !== config.ADMIN_TELEGRAM_USER_ID || input.chatType !== "private") return presentAdminDenied("NOT_ROOT_ADMIN");
          await productDraftWorkflow.start(input.telegramUserId);
          return { text: "Bước 1/6 — Nhập tên sản phẩm. Gõ /cancel để huỷ.", buttons: [[{ text: "Huỷ", callbackData: "admin:products:cancel" }]] };
        },
        async messageText(input) {
          if (Number(input.telegramUserId) !== config.ADMIN_TELEGRAM_USER_ID || input.chatType !== "private") return null;
          if (input.text === "/cancel") return this.cancel(input);
          const current = await productDraftWorkflow.get(input.telegramUserId);
          if (!current) return null;
          const result = await productDraftWorkflow.advance(input.telegramUserId, input.text);
          if (!result.ok) return { text: result.error === "INVALID_PRICE" ? "Giá không hợp lệ. Ví dụ: 120000." : "Dữ liệu không hợp lệ, vui lòng thử lại.", buttons: [[{ text: "Huỷ", callbackData: "admin:products:cancel" }]] };
          if (result.draft.step === "confirm") return presentProductDraftPreview(result.draft as Required<typeof result.draft>);
          const prompts: Record<string, string> = { sku: "Bước 2/6 — Nhập SKU.", category: "Bước 3/6 — Chọn danh mục.", price: "Bước 4/6 — Nhập giá bán.", description: "Bước 5/6 — Nhập mô tả.", threshold: "Bước 6/6 — Nhập ngưỡng cảnh báo tồn kho." };
          return { text: prompts[result.draft.step] ?? "Tiếp tục.", buttons: [[{ text: "Huỷ", callbackData: "admin:products:cancel" }]] };
        },
        async category(input) {
          if (Number(input.telegramUserId) !== config.ADMIN_TELEGRAM_USER_ID || input.chatType !== "private") return presentAdminDenied("NOT_ROOT_ADMIN");
          const current = await productDraftWorkflow.get(input.telegramUserId);
          if (!current || current.step !== "category") return { text: "Phiên tạo sản phẩm không còn hợp lệ.", buttons: [[{ text: "Products", callbackData: "admin:products" }]] };
          if (!input.categoryId) {
            const rows = await sql<{ id: string; name_vi: string }>`select id, name_vi from category where is_active order by sort_order, id limit 20`.execute(dbHandle.db);
            return { text: "Bước 3/6 — Chọn danh mục.", buttons: rows.rows.map((row) => [{ text: row.name_vi, callbackData: `admin:products:category:${row.id}` }]) };
          }
          const exists = await sql<{ id: string }>`select id from category where id = ${input.categoryId} and is_active`.execute(dbHandle.db);
          if (!exists.rows[0]) return { text: "Danh mục không hợp lệ.", buttons: [[{ text: "Products", callbackData: "admin:products" }]] };
          const result = await productDraftWorkflow.advance(input.telegramUserId, input.categoryId);
          return result.ok ? { text: "Bước 4/6 — Nhập giá bán.", buttons: [[{ text: "Huỷ", callbackData: "admin:products:cancel" }]] } : { text: "Không thể chọn danh mục.", buttons: [] };
        },
        async confirm(input) {
          if (Number(input.telegramUserId) !== config.ADMIN_TELEGRAM_USER_ID || input.chatType !== "private") return presentAdminDenied("NOT_ROOT_ADMIN");
          const draft = await productDraftWorkflow.get(input.telegramUserId);
          if (!draft || draft.step !== "confirm" || !draft.name || !draft.slug || !draft.sku || !draft.categoryId || draft.priceVnd === undefined || draft.description === undefined || draft.lowStockThreshold === undefined) return { text: "Phiên tạo sản phẩm đã hết hạn hoặc chưa đủ dữ liệu.", buttons: [[{ text: "Products", callbackData: "admin:products" }]] };
          try {
            const product = await createAdminProduct({ actor: { numericUserId: Number(input.telegramUserId), chatType: "private" }, config: { adminTelegramUserId: config.ADMIN_TELEGRAM_USER_ID, expectedUsername: config.ADMIN_EXPECTED_USERNAME }, db: dbHandle.db, categoryId: draft.categoryId, name: draft.name, slug: draft.slug, sku: draft.sku, description: draft.description, priceVnd: draft.priceVnd, reason: "Admin product creation", correlationId: input.correlationId });
            await productDraftWorkflow.cancel(input.telegramUserId);
            return { text: `✅ Đã tạo sản phẩm ${product.name}\nSKU: ${product.sku}\nGiá: ${product.priceVnd.toLocaleString("vi-VN")} ₫`, buttons: [[{ text: "Inventory", callbackData: "admin:inventory" }, { text: "Products", callbackData: "admin:products" }]] };
          } catch (error) {
            if (error instanceof Error && /23505|CONFLICT|conflict/i.test(error.message)) return { text: "SKU này vừa được tạo bởi thao tác khác. Vui lòng chọn SKU khác.", buttons: [[{ text: "Products", callbackData: "admin:products" }]] };
            throw error;
          }
        },
        async cancel(input) {
          if (Number(input.telegramUserId) !== config.ADMIN_TELEGRAM_USER_ID || input.chatType !== "private") return presentAdminDenied("NOT_ROOT_ADMIN");
          await productDraftWorkflow.cancel(input.telegramUserId);
          return { text: "Đã huỷ thao tác.", buttons: [[{ text: "Products", callbackData: "admin:products" }]] };
        },
      },
    },
    responder: telegramResponder,
  });
  const notificationRate = Number(process.env.NOTIFICATION_RATE_PER_SECOND ?? 20);
  if (!Number.isInteger(notificationRate) || notificationRate < 1 || notificationRate > 25) throw new RangeError("NOTIFICATION_RATE_PER_SECOND must be 1..25");
  const notificationLane = async (): Promise<void> => {
    await runNotificationDeliveryLane({
      db: dbHandle.db,
      responder: telegramResponder,
      ratePerSecond: notificationRate,
      maxAttempts: config.OUTBOX_MAX_ATTEMPTS,
    });
  };
  const ownerId = `worker-${newId().slice(-12)}`;
  const telegramOwnerId = `telegram-${newId().slice(-12)}`;
  const sepayOwnerId = `sepay-${newId().slice(-12)}`;

  let shuttingDown = false;

  const outboxLane = async (): Promise<void> => {
    const result = await drainOutboxOnce(dbHandle.db, {
      batchSize: 20,
      maxAttempts: config.OUTBOX_MAX_ATTEMPTS,
      handler: (event) => event.eventType === "StockDelta" ? handleNotificationOutboxEvent(dbHandle.db, event) : handler(event),
      ownerId,
    });
    if (result.claimed > 0) {
      logger.info({ ...result, ownerId }, "outbox drain cycle");
    }
  };
  const telegramLane = async (): Promise<void> => {
    const result = await processTelegramInboxBatch({
      inbox: telegramInbox,
      limiter: telegramLimiter,
      handler: async (envelope) => {
        const observedUsername = await consumeTelegramUsernameObservation(
          dbHandle.db,
          envelope.actorUserId,
        );
        const identity = await ensureTelegramIdentity(dbHandle.db, {
          telegramUserId: envelope.actorUserId,
          ...(observedUsername ? { observedUsername } : {}),
        });
        await upsertTelegramCustomerProfileSnapshot(dbHandle.db, {
          customerId: identity.customerId,
          telegramUserId: envelope.actorUserId,
          chatId: envelope.chatId,
          username: envelope.actorUsername ?? observedUsername ?? null,
          firstName: envelope.firstName ?? null,
          lastName: envelope.lastName ?? null,
          languageCode: envelope.languageCode ?? null,
          phoneNumber: envelope.contactPhoneNumber ?? null,
          reachable: true,
        });
        await telegramDispatcher.handle(envelope);
      },
      owner: telegramOwnerId,
      batchSize: 20,
      maxAttempts: config.OUTBOX_MAX_ATTEMPTS,
    });
    if (result.claimed > 0) logger.info({ ...result, ownerId: telegramOwnerId }, "telegram inbox dispatch cycle");
  };
  const sepayLane = async (): Promise<void> => {
    const result = await processSePayInboxBatch({
      inbox: sepayInbox,
      handler: (evidence) => {
        const code = (evidence.structuredCode ?? evidence.content ?? evidence.reference)?.trim().toUpperCase() ?? "";
        return code.startsWith("NAPVI") ? applyWalletTopupEvidence(dbHandle.db, evidence) : applyPaymentEvidence(dbHandle.db, evidence);
      },
      owner: sepayOwnerId,
      batchSize: 20,
      maxAttempts: config.OUTBOX_MAX_ATTEMPTS,
    });
    if (result.claimed > 0) logger.info({ ...result, ownerId: sepayOwnerId }, "sepay inbox dispatch cycle");
  };
  const recoveryLane = async (): Promise<void> => {
    const recovery = await runRecoveryJobsOnce({
      db: dbHandle.db,
      batchSize: 20,
      sePayPort: sePayRecoveryPort,
      supplierPort: supplier,
      vault,
    });
    logger.info(
      { recovery, sePayRecoveryConfigured: sePayRecoveryPort !== null, supplierRecoveryConfigured: supplier !== null },
      "bounded recovery cycle",
    );
  };
  const { createDbWakeListener, DB_WAKE_CHANNELS } = await import("./infrastructure/db/client.js");
  const wakeListener = createDbWakeListener(dbHandle.pool, {
    callbacks: {
      [DB_WAKE_CHANNELS.outbox]: outboxLane,
      [DB_WAKE_CHANNELS.telegram]: telegramLane,
      [DB_WAKE_CHANNELS.sepay]: sepayLane,
    },
  });
  const scheduler = createWorkerScheduler({
    lanes: { outbox: outboxLane, telegram: telegramLane, sepay: sepayLane, notifications: notificationLane, recovery: recoveryLane },
    pollIntervalMs: config.OUTBOX_POLL_INTERVAL_MS,
    recoveryIntervalMs: 60_000,
    logger,
    wakeListener,
  });
  scheduler.start();

  const started: Stoppable[] = [
    {
      async stop() {
        await scheduler.stop();
        await dbHandle.close();
      },
    },
  ];

  logger.info(
    {
      nodeEnv: config.NODE_ENV,
      pollMs: config.OUTBOX_POLL_INTERVAL_MS,
      ownerId,
      telegramOwnerId,
      recoveryIntervalMs: 60_000,
      sePayRecoveryConfigured: sePayRecoveryPort !== null,
      supplierRecoveryConfigured: supplier !== null,
    },
    "worker process starting (outbox + fulfillment)",
  );

  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, "worker draining");
    for (const resource of started.reverse()) {
      try {
        await resource.stop();
      } catch (error) {
        logger.error(
          { err: error instanceof Error ? error.message : "unknown error" },
          "error during worker shutdown",
        );
      }
    }
    process.exit(0);
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

// Only auto-run when invoked as the process entrypoint, not when imported by tests.
const invokedPath = process.argv[1];
const isEntry = invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href;
if (isEntry) {
  bootstrap().catch((err: unknown) => {
    process.stderr.write(
      `worker failed to start: ${err instanceof Error ? err.message : "unknown error"}\n`,
    );
    process.exit(1);
  });
}

export { bootstrap };
