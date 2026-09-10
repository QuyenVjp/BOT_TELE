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
import {
  listCategoriesWithCounts,
  createCategory,
  renameCategory,
  setCategoryActive,
  reorderCategory,
  ensureDefaultCategories,
  getOrCreateUncategorizedCategory,
  listFeaturedProducts,
  getProductDetail,
} from "./modules/catalog/repository.js";
import { createCatalogCache } from "./modules/catalog/cache.js";
import {
  getGroupCommerceSettings,
  updateGroupCommerceSettings,
  buildInlineQueryResults,
  parseNaturalSalesQA,
} from "./modules/catalog/group-commerce.js";

const BOT_USERNAME = "tier20ai_bot";
const BOT_USER_ID = 8394662759;
import {
  presentGroupShopPanel,
  presentGroupProductCard,
  presentGroupWelcome,
  presentGroupPrivacyNotice,
  presentGroupAdminPanel,
} from "./bot/presenters/group.js";
import { issueProductLinkToken } from "./modules/catalog/product-link-token.js";
import { pathToFileURL } from "node:url";
import { sql } from "kysely";
import { isId, newId } from "./shared/ids/index.js";
import { sealPresentedMessageCallbacks } from "./bot/callback-sealer.js";
import type { CallbackTokenCodec } from "./bot/callback-codec.js";
import type { Db } from "./infrastructure/db/transaction.js";
import type { FulfillmentType, InventoryField } from "./modules/catalog/fulfillment-type.js";
import type {
  presentAdminOrderDetail,
  presentAdminOrders as presentAdminOrdersPresenter,
} from "./bot/presenters/admin.js";
import type { PresentedMessage } from "./bot/presenters/catalog.js";
import type { WalletAccount } from "./modules/wallet/ledger.js";
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
  openTelegramDeliveryHandoff,
  processDeliveryNotificationBatch,
  recoverStoredDeliveryNotificationHandoffsBatch,
} from "./modules/digital-goods/delivery-notification.js";
import { recoverSePayBatch } from "./modules/payments/recovery.js";
import { setTimeout as delayNotification } from "node:timers/promises";
import { recoverSupplierOrdersBatch } from "./modules/supplier/recovery.js";
import type { LatencyMetrics } from "./infrastructure/observability/tracing.js";
import { subscribeRestock, unsubscribeRestock } from "./modules/catalog/restock.js";
import {
  reserveNotificationSlot,
  pauseNotificationRate,
  notificationPauseRemaining,
} from "./modules/notification/rate-limit.js";
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
  previewStockAnnouncementBroadcast,
  processNotificationDeliveryClaim,
  setNotificationPreferences,
  type BroadcastAudience,
  type NotificationResponder,
} from "./modules/notification/service.js";
import type { AdminCustomerFilter } from "./modules/admin/customer-operations.js";
import {
  listAdminCustomers,
  resolveAdminCallbackState,
  startAdminCustomerMessageDraft,
  consumeAdminCustomerMessageDraft,
  createAdminCallbackState,
  queueAdminCustomerMessage,
} from "./modules/admin/customer-operations.js";
import type { AdminOrderStatusFilter } from "./modules/admin/order-operations.js";
import {
  getAdminOrderDetail,
  listAdminOrders,
  resolveAdminOrderState,
  resolveOrderCustomerForRelay,
} from "./modules/admin/order-operations.js";
import { appendAuditEvent, listAuditEvents } from "./modules/identity/audit.js";

export function marketingBroadcastClassForAudience(
  audience: BroadcastAudience,
): "SHOP_UPDATE" | "PURCHASE_ACTIVITY" {
  return audience === "activity" ? "PURCHASE_ACTIVITY" : "SHOP_UPDATE";
}

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

export async function presentAdminCustomerFinancialDetail(
  db: Db,
  customerId: string,
  adminTelegramUserId = "system",
) {
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
  if (!row)
    return {
      text: "Không tìm thấy khách hàng.",
      buttons: [[{ text: "Admin", callbackData: "admin:menu" }]],
    };
  const recent = await sql<{
    order_number: string;
    status: string;
    price_vnd: string;
  }>`select order_number,status,price_vnd from "order" where customer_id=${customerId} order by created_at desc,id desc limit 1`.execute(
    db,
  );
  const ledger = await sql<{
    entry_type: string;
    amount_vnd: string;
    reason: string;
    created_at: Date;
  }>`select l.entry_type,l.amount_vnd,l.reason,l.created_at from wallet_ledger l join wallet_account a on a.id=l.wallet_account_id where a.customer_id=${customerId} order by l.created_at desc,l.id desc limit 10`.execute(
    db,
  );
  const messageStateId = await createAdminCallbackState(db, {
    adminTelegramUserId,
    kind: "CUSTOMER_MESSAGE_PROMPT",
    payload: { customerId },
  });
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
      ...ledger.rows.map(
        (entry) =>
          `${entry.entry_type} ${BigInt(entry.amount_vnd).toLocaleString("vi-VN")} ₫ · ${entry.reason} · ${new Date(entry.created_at).toISOString()}`,
      ),
    ].join("\n"),
    buttons: [
      [{ text: "✉️ Nhắn khách", callbackData: `admin:customers:message:${messageStateId}` }],
      [
        { text: "👥 Khách hàng", callbackData: "admin:customers" },
        { text: "Admin", callbackData: "admin:menu" },
      ],
    ],
  };
}

export async function presentAdminCustomers(
  db: Db,
  input: {
    adminTelegramUserId: string;
    filter?: AdminCustomerFilter;
    query?: string | null;
    cursor?: string | null;
  },
) {
  const page = await listAdminCustomers(db, input);
  const label = page.query ? `Tìm: ${page.query}` : `Lọc: ${page.filter}`;
  return {
    text: [
      "Khách hàng",
      label,
      "",
      ...page.items.map(
        (customer) =>
          `• ${customer.displayName ?? customer.username ?? customer.telegramUserId ?? customer.id} · ${customer.orderCount} đơn · ${customer.totalSpendVnd.toLocaleString("vi-VN")} ₫${customer.lastOrderNumber ? ` · ${customer.lastOrderNumber}` : ""}`,
      ),
    ].join("\n"),
    buttons: [
      ...page.items.map((customer) => [
        {
          text:
            customer.displayName ??
            customer.username ??
            customer.telegramUserId ??
            customer.id.slice(-6),
          callbackData: `admin:customers:view:${customer.stateId}`,
        },
      ]),
      [{ text: "🔎 Tìm khách", callbackData: "admin:customers:search" }],
      [
        { text: "Gần đây", callbackData: "admin:customers:filter:recent" },
        { text: "Top chi", callbackData: "admin:customers:filter:top_spend" },
      ],
      [
        { text: "Không nhắn được", callbackData: "admin:customers:filter:unreachable" },
        { text: "Hỗ trợ mở", callbackData: "admin:customers:filter:support_open" },
      ],
      [{ text: "Cần soát thanh toán", callbackData: "admin:customers:filter:payment_review" }],
      ...(page.nextStateId
        ? [[{ text: "Trang sau", callbackData: `admin:customers:page:${page.nextStateId}` }]]
        : []),
      [{ text: "Admin", callbackData: "admin:menu" }],
    ],
  };
}

export async function presentAdminCustomerSearchPrompt(db: Db, adminTelegramUserId: string) {
  await createAdminCallbackState(db, {
    adminTelegramUserId,
    kind: "CUSTOMER_SEARCH_PROMPT",
    payload: {},
  });
  return {
    text: "Nhập Telegram ID, username, số điện thoại đã chia sẻ, hoặc mã đơn hàng để tìm khách.",
    buttons: [[{ text: "Huỷ", callbackData: "admin:customers" }]],
  };
}

export async function presentAdminCustomerMessagePrompt(
  db: Db,
  input: { adminTelegramUserId: string; stateId: string },
) {
  const state = await resolveAdminCallbackState(db, {
    adminTelegramUserId: input.adminTelegramUserId,
    stateId: input.stateId,
  });
  const customerId =
    typeof state?.payload.customerId === "string" ? state.payload.customerId : null;
  if (state?.kind !== "CUSTOMER_MESSAGE_PROMPT" || !customerId)
    return {
      text: "Phiên nhắn khách đã hết hạn.",
      buttons: [[{ text: "👥 Khách hàng", callbackData: "admin:customers" }]],
    };
  await startAdminCustomerMessageDraft(db, {
    adminTelegramUserId: input.adminTelegramUserId,
    customerId,
  });
  return {
    text: "Nhập nội dung tin nhắn gửi khách ở tin nhắn tiếp theo.",
    buttons: [[{ text: "Huỷ", callbackData: "admin:customers" }]],
  };
}

export async function handleAdminCustomerFreeText(
  db: Db,
  input: { adminTelegramUserId: string; text: string; actorId: string; correlationId: string },
) {
  const messageDraft = await consumeAdminCustomerMessageDraft(db, input.adminTelegramUserId);
  if (messageDraft) {
    const content = input.text.trim();
    if (!content || content.length > 4096)
      return {
        text: "Nội dung tin nhắn không hợp lệ.",
        buttons: [[{ text: "👥 Khách hàng", callbackData: "admin:customers" }]],
      };
    const queued = await queueAdminCustomerMessage(db, {
      customerId: messageDraft.customerId,
      content,
      actorId: input.actorId,
      correlationId: input.correlationId,
    });
    return queued
      ? {
          text: "Đã đưa tin nhắn vào hàng đợi gửi khách hàng.",
          buttons: [[{ text: "👥 Khách hàng", callbackData: "admin:customers" }]],
        }
      : {
          text: "Khách hàng không có kênh Telegram khả dụng.",
          buttons: [[{ text: "👥 Khách hàng", callbackData: "admin:customers" }]],
        };
  }
  return presentAdminCustomers(db, {
    adminTelegramUserId: input.adminTelegramUserId,
    query: input.text,
  });
}

export async function presentAdminOrders(
  db: Db,
  presenters: { presentAdminOrders: typeof presentAdminOrdersPresenter },
  input: {
    adminTelegramUserId: string;
    filter?: AdminOrderStatusFilter;
    query?: string | null;
    cursor?: string | null;
  },
) {
  return presenters.presentAdminOrders(await listAdminOrders(db, input));
}

export async function presentAdminOrderState(
  db: Db,
  presenters: {
    presentAdminOrderDetail: typeof presentAdminOrderDetail;
    presentAdminOrders: typeof presentAdminOrdersPresenter;
  },
  input: { adminTelegramUserId: string; stateId: string },
) {
  const state = await resolveAdminOrderState(db, input);
  if (state?.kind === "ORDER_DETAIL" && state.orderId) {
    const detail = await getAdminOrderDetail(db, {
      adminTelegramUserId: input.adminTelegramUserId,
      orderId: state.orderId,
    });
    return detail
      ? presenters.presentAdminOrderDetail(detail)
      : {
          text: "Không tìm thấy đơn hàng.",
          buttons: [[{ text: "Đơn hàng", callbackData: "admin:orders" }]],
        };
  }
  if (state?.kind === "ORDER_PAGE") {
    return presentAdminOrders(db, presenters, {
      adminTelegramUserId: input.adminTelegramUserId,
      filter: state.filter ?? "all",
      query: state.query ?? null,
      cursor: state.cursor ?? null,
    });
  }
  return {
    text: "Phiên đơn hàng đã hết hạn.",
    buttons: [[{ text: "Đơn hàng", callbackData: "admin:orders" }]],
  };
}

export async function presentAdminOrderMessagePrompt(
  db: Db,
  input: { adminTelegramUserId: string; stateId: string },
) {
  const relay = await resolveOrderCustomerForRelay(db, input);
  if (!relay)
    return {
      text: "Phiên nhắn theo đơn đã hết hạn.",
      buttons: [[{ text: "Đơn hàng", callbackData: "admin:orders" }]],
    };
  await startAdminCustomerMessageDraft(db, {
    adminTelegramUserId: input.adminTelegramUserId,
    customerId: relay.customerId,
  });
  return {
    text: "Nhập nội dung tin nhắn gửi khách của đơn này ở tin nhắn tiếp theo.",
    buttons: [[{ text: "Huỷ", callbackData: "admin:orders" }]],
  };
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
        input.metrics?.observe(
          `worker.lane.${name}.duration_ms`,
          performance.now() - startedAt,
          true,
        );
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
        input.logger.error(
          { err: error instanceof Error ? error.message : "unknown error" },
          "worker wake listener failed",
        );
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

export function createSealedNotificationResponder(input: {
  responder: NotificationResponder;
  codec: CallbackTokenCodec;
  resolveOrderId(orderNumber: string): Promise<string | null>;
}): NotificationResponder {
  return {
    send: async (messageInput) =>
      input.responder.send({
        ...messageInput,
        message: await sealPresentedMessageCallbacks(messageInput.message, {
          codec: input.codec,
          telegramUserId: messageInput.telegramUserId,
          resolveOrderId: input.resolveOrderId,
        }),
      }),
  };
}

export interface NotificationDeliveryLaneInput {
  db: Db;
  responder: NotificationResponder;
  ratePerSecond: number;
  maxAttempts: number;
  batchSize?: number;
  workers?: number;
  sleep?: (ms: number) => Promise<void>;
}

export async function runNotificationDeliveryLane(
  input: NotificationDeliveryLaneInput,
): Promise<void> {
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
        retryAfterSeconds: (error) =>
          error instanceof Error &&
          "retryAfterSeconds" in error &&
          typeof error.retryAfterSeconds === "number"
            ? error.retryAfterSeconds
            : null,
        onRateLimit: (seconds) => pauseNotificationRate(input.db, seconds),
      });
    }
  };
  await Promise.all(Array.from({ length: input.workers ?? 4 }, sendNext));
}

export async function restockVariantLabel(db: Db, variantId: string): Promise<string | null> {
  const row = (
    await sql<{ product_name: string; variant_name: string }>`
      select p.name_vi as product_name, v.name_vi as variant_name
      from product_variant v join product p on p.id = v.product_id
      where v.id = ${variantId}
      limit 1
    `.execute(db)
  ).rows[0];
  return row ? `${row.product_name} — ${row.variant_name}` : null;
}

export async function presentRestockList(db: Db, customerId: string) {
  const rows = (
    await sql<{ variant_id: string; product_name: string; variant_name: string }>`
      select rs.variant_id, p.name_vi as product_name, v.name_vi as variant_name
      from restock_subscription rs
      join product_variant v on v.id = rs.variant_id
      join product p on p.id = v.product_id
      where rs.customer_id = ${customerId} and rs.active
      order by rs.created_at
    `.execute(db)
  ).rows;
  return {
    text: rows.length
      ? `🔔 Đang theo dõi:\n${rows.map((r, i) => `${i + 1}. ${r.product_name} — ${r.variant_name}`).join("\n")}`
      : "Bạn chưa theo dõi sản phẩm nào.",
    buttons: rows.map((r) => [
      {
        text: `Hủy ${r.product_name} — ${r.variant_name}`,
        callbackData: `rst:unsub:${r.variant_id}`,
      },
    ]),
  };
}

async function bootstrap(): Promise<void> {
  // Local `.env` only. Production is loaded by `node --env-file=` before this
  // process starts; dotenv would fill gaps from a repo `.env` and must not mix in.
  if (process.env.NODE_ENV !== "production") {
    await import("dotenv/config");
  }

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
  const { classifyPaymentCode } = await import("./modules/payments/payment-code.js");
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
  const {
    WALLET_TOPUP_PRESET_AMOUNTS,
    applyWalletTopupEvidence,
    cancelLiveWalletTopup,
    clearWalletTopupSelection,
    formatVnd,
    isAwaitingWalletTopupAmount,
    loadLatestWalletTopup,
    loadWalletTopupSelection,
    parseWalletTopupAmount,
    presentWalletTopup,
    renderWalletTopupConfirmation,
    renderWalletTopupPicker,
    saveWalletTopupAwaitingAmount,
    saveWalletTopupSelection,
  } = await import("./modules/wallet/topup.js");
  const { createWalletPurchaseService } = await import("./modules/wallet/purchase.js");
  const { createTelegramDomainDispatcher } = await import("./bot/callbacks/telegram-dispatch.js");
  const { createGrammyDocumentSender, createGrammyResponder, ensureTelegramCommandMenu } =
    await import("./bot/grammy-responder.js");
  const { createSearchParser } = await import("./modules/catalog/search-parser-adapter.js");
  const { findOrderById, findOrderByNumber } = await import("./modules/commerce/repository.js");
  const { bootstrapRootTelegramIdentity, ensureTelegramIdentity, resolveTelegramCustomerId } =
    await import("./modules/identity/channel-identity.js");
  const { upsertTelegramCustomerProfileSnapshot } =
    await import("./modules/identity/customer-profile.js");
  const { createAdminConfirmation } = await import("./modules/identity/admin-confirmation.js");
  const { createAdminCallbacks, OWNER_COMMANDS } = await import("./bot/callbacks/admin.js");
  const { importDigitalInventory } = await import("./modules/digital-goods/inventory-import.js");
  const {
    createInventoryImportTemplate,
    cancelInventoryImportSession,
    confirmInventoryImportSession,
    getInventoryImportSession,
    stageInventoryImportDocument,
    stageInventoryImportInput,
    startInventoryImportSession,
  } = await import("./modules/digital-goods/inventory-import-session.js");
  const {
    cancelFileArtifactImportSession,
    confirmFileArtifactImportSession,
    createTelegramFileDownloader,
    createTelegramTextFileDownloader,
    getFileArtifactImportSession,
    stageFileArtifactDocument,
    startFileArtifactImportSession,
  } = await import("./modules/digital-goods/file-artifact-import-session.js");
  const { getManualTaskById, listManualFulfillmentTasks } =
    await import("./modules/digital-goods/manual-fulfillment.js");
  const {
    createDurableProductDraftWorkflow,
    createProductDraftRepository,
    generateSkuProposal,
    toggleOptionalField,
    addCustomField,
    setCustomFieldFlags,
    removeCustomField,
    applyAdvancedRaw,
    previousStep,
  } = await import("./modules/catalog/product-draft.js");
  const { DESCRIPTION_TEMPLATES } = await import("./modules/catalog/description-templates.js");
  const { createAdminProduct, createAdminVariant, updateAdminVariant } =
    await import("./modules/catalog/admin-products.js");
  const { getStoreMode, setStoreMode, addTestCustomer, listTestCustomers } =
    await import("./modules/commerce/store-mode.js");
  const { adjustQuantityStock, listVariantInventoryHistory } =
    await import("./modules/catalog/quantity-stock.js");
  const {
    selectVariantSupplierMapping,
    clearVariantSupplierMapping,
    markSupplierSkuManuallyVerified,
  } = await import("./modules/supplier/admin.js");
  const { approveReplacementCaseInTransaction } =
    await import("./modules/digital-goods/replacement.js");
  const {
    presentAdminBroadcastAudience,
    presentAdminBroadcastPreview,
    presentAdminBroadcastPrompt,
    presentAdminBroadcastStatus,
    presentAdminDenied,
    presentAdminDashboard,
    presentAdminInventory,
    presentAdminInventoryProduct,
    presentAdminInventoryVariant,
    presentAdminInventoryHistory,
    presentQuantityStockAdjustPreview,
    presentQuantityStockAdjustReasonPrompt,
    presentQuantityStockAdjustDone,
    presentAdminMarketingMenu,
    presentAdminMenu,
    presentAdminProducts,
    presentAdminProductDetail,
    presentAdminStoreMode,
    presentAdminStoreOpenConfirmation,
    presentAdminTestCustomers,
    presentAdminTestCustomerPrompt,
    presentAdminCategories,
    presentAdminCategoryPrompt,
    presentHighRiskChallenge,
    presentHighRiskDone,
    presentInventoryImportPreview,
    presentInventoryImportPrompt,
    presentInventoryImportTemplate,
    presentFileArtifactImportDone,
    presentFileArtifactImportPreview,
    presentProductDraftPreview,
    presentAdminVariantDraft,
    presentAdminVariantMutationDone,
    presentKillSwitchDone,
    presentAdminSupplierActionDone,
    presentAdminSupplierVariant,
    presentAdminSuppliersMenu,
    presentAdminSupportQueue,
    presentAdminOrderDetail,
    presentAdminOrders: presentAdminOrdersPage,
    presentAdminOrderSearchPrompt,
    presentAuditList,
    presentAdminInventoryProductPicker,
    presentAdminInventoryVariantPicker,
    presentAdminTestLab,
    presentAdminPreorders,
  } = await import("./bot/presenters/admin.js");
  const {
    presentWizardNameStep,
    presentWizardSkuStep,
    presentWizardCategoryStep,
    presentFulfillmentTypeChoices,
    presentWizardDescriptionStep,
    presentWizardDescriptionCustomPrompt,
    presentWizardVariantStep,
    presentWizardDeliveryStep,
    presentWizardCustomFieldFlags,
    presentWizardCategoryCreatePrompt,
    presentWizardCustomFieldPrompt,
    presentWizardAdvancedPrompt,
    presentWizardVisibilityStep,
  } = await import("./bot/presenters/admin-wizard.js");
  const { loadPreorderVariantConfig, presentPreorderConsent, createPreorderReservation } =
    await import("./modules/commerce/preorder.js");
  const { shopCancelPreorder } = await import("./modules/commerce/shop-cancel.js");
  const { generateCustomerAlias } = await import("./modules/marketing/social-proof.js");
  const { formatSePayReconciliationAdminText, getSePayReconciliationStatus } =
    await import("./modules/payments/reconciliation-status.js");
  const { presentCustomerNotificationPreferences } = await import("./bot/presenters/customer.js");
  const { presentDeliveryReveal } = await import("./bot/presenters/delivery.js");
  const { presentAdminManualTaskDetail, presentAdminManualTasks } =
    await import("./bot/presenters/manual-fulfillment.js");

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
  const telegramDocumentSender = createGrammyDocumentSender(
    config.TELEGRAM_BOT_TOKEN,
    undefined,
    config.NODE_ENV !== "production" ? logger : undefined,
  );

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
    ...(config.PRIVATE_ARTIFACT_ROOT
      ? {
          fileDelivery: {
            storageRoots: [config.PRIVATE_ARTIFACT_ROOT],
            sender: telegramDocumentSender,
          },
        }
      : {}),
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
  const catalogCache = createCatalogCache({ ttlMs: 15_000 });
  await ensureDefaultCategories(dbHandle.db);
  catalogCache.invalidate();
  const catalog = createCatalogCallbacks({
    db: dbHandle.db,
    parser: createSearchParser({
      driver: config.SEARCH_PARSER_DRIVER,
      timeoutMs: config.SEARCH_PARSER_TIMEOUT_MS,
    }),
    callbackCodec: buyNowCodec,
    cache: catalogCache,
    productLinkSecret: config.BUY_NOW_CALLBACK_HMAC_KEY,
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
    adminTelegramUserId: config.ADMIN_TELEGRAM_USER_ID,
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
  const walletTopupBounds = {
    minVnd: config.WALLET_TOPUP_MIN_VND,
    maxVnd: config.WALLET_TOPUP_MAX_VND,
  };
  function walletTopupPickerMessage(account: WalletAccount): PresentedMessage {
    return {
      text: renderWalletTopupPicker(account, walletTopupBounds),
      buttons: [
        ...WALLET_TOPUP_PRESET_AMOUNTS.filter(
          (amount) => amount >= walletTopupBounds.minVnd && amount <= walletTopupBounds.maxVnd,
        ).map((amount) => [
          { text: formatVnd(amount), callbackData: `wallet:topup:amount:${amount}` },
        ]),
        [{ text: "Nhập số khác", callbackData: "wallet:topup:custom" }],
        [{ text: "Ví", callbackData: "wallet:account" }],
        [{ text: "Menu chính", callbackData: "menu:main" }],
      ],
    };
  }

  function walletTopupCustomPrompt(error?: string): PresentedMessage {
    return {
      text: [
        ...(error ? [error, ""] : []),
        "Nhập số tiền muốn nạp.",
        `Cho phép từ ${formatVnd(walletTopupBounds.minVnd)} đến ${formatVnd(walletTopupBounds.maxVnd)}.`,
        "Ví dụ: 50000, 50.000 hoặc 50,000.",
      ].join("\n"),
      buttons: [[{ text: "Huỷ", callbackData: "wallet:topup:cancel" }]],
    };
  }

  function walletTopupConfirmMessage(amountVnd: bigint, balanceVnd: bigint): PresentedMessage {
    return {
      text: renderWalletTopupConfirmation({
        selectedAmountVnd: amountVnd,
        currentBalanceVnd: balanceVnd,
      }),
      buttons: [
        [{ text: "Tạo mã VietQR", callbackData: "wallet:topup:confirm" }],
        [{ text: "Đổi số tiền", callbackData: "wallet:topup:change" }],
        [{ text: "Huỷ", callbackData: "wallet:topup:cancel" }],
      ],
    };
  }

  function walletTopupPaymentScreen(message: PresentedMessage): PresentedMessage {
    return {
      ...message,
      buttons: [
        [{ text: "Kiểm tra nạp ví", callbackData: "wallet:topup:status" }],
        [{ text: "Đổi số tiền", callbackData: "wallet:topup:change" }],
        [{ text: "Huỷ", callbackData: "wallet:topup:cancel" }],
        ...message.buttons,
      ],
    };
  }
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
        supportReplacementApprove: async (input) => {
          const result = await approveReplacementCaseInTransaction(input.exec, {
            caseId: input.caseId,
            approvedBy: input.actorId,
            correlationId: input.correlationId,
            deliveryBaseUrl: `${config.APP_BASE_URL.replace(/\/$/, "")}/d`,
            bundleTtlSeconds: config.DELIVERY_BUNDLE_TTL_SECONDS,
          });
          return { ok: result.ok };
        },
      })
    : null;
  const productDraftWorkflow = createDurableProductDraftWorkflow(
    createProductDraftRepository(dbHandle.db),
  );
  const renderWizardStep = async (draft: {
    step: string;
    name?: string | undefined;
    sku?: string | undefined;
    categoryId?: string | undefined;
    categoryName?: string | undefined;
    fulfillmentType?: FulfillmentType | undefined;
    variantName?: string | undefined;
    priceVnd?: bigint | undefined;
    inventoryFields?: InventoryField[] | undefined;
    deliveryConfig?:
      { selectedOptionalFields: string[]; customFields: InventoryField[] } | undefined;
  }): Promise<PresentedMessage> => {
    switch (draft.step) {
      case "sku":
        return presentWizardSkuStep(draft as never, generateSkuProposal(draft.name ?? ""));
      case "category": {
        await ensureDefaultCategories(dbHandle.db);
        const rows = await sql<{ id: string; name_vi: string; parent_id: string | null }>`
          select id, name_vi, parent_id from category where is_active
          order by coalesce(parent_id, id), sort_order, id limit 40
        `.execute(dbHandle.db);
        return presentWizardCategoryStep(
          rows.rows.map((row) => ({
            id: row.id,
            name: row.parent_id ? `↳ ${row.name_vi}` : row.name_vi,
          })),
        );
      }
      case "productType":
        return presentFulfillmentTypeChoices();
      case "description":
        return presentWizardDescriptionStep(draft.fulfillmentType);
      case "variant":
        return presentWizardVariantStep(draft as never);
      case "deliveryConfig":
        return presentWizardDeliveryStep(draft as never);
      case "visibilityFlags":
        return presentWizardVisibilityStep(draft as never);
      case "confirm": {
        const categoryName =
          draft.categoryName ??
          (draft.categoryId
            ? (
                await sql<{ name: string }>`
                  select name_vi as name from category where id = ${draft.categoryId} limit 1
                `.execute(dbHandle.db)
              ).rows[0]?.name
            : undefined);
        return presentProductDraftPreview({
          ...(draft as Required<typeof draft>),
          ...(categoryName ? { categoryName } : {}),
        } as Parameters<typeof presentProductDraftPreview>[0]);
      }
      case "name":
      default:
        return presentWizardNameStep(draft as never);
    }
  };
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
  try {
    await ensureTelegramCommandMenu({
      botToken: config.TELEGRAM_BOT_TOKEN,
      adminTelegramUserId: config.ADMIN_TELEGRAM_USER_ID,
    });
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.message : "unknown error" },
      "telegram command menu sync failed",
    );
  }
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
            cursor: Buffer.from(`${row.sort_order}:${cursorVariantId}`, "utf8").toString(
              "base64url",
            ),
          }
        : null;
    },
    restock: {
      async subscribe(customerId, variantId) {
        const label = await restockVariantLabel(dbHandle.db, variantId);
        if (!label) return { text: "Sản phẩm không tồn tại.", buttons: [] };
        await subscribeRestock(dbHandle.db, customerId, variantId);
        return { text: `Đã đăng ký báo có hàng: ${label}.`, buttons: [] };
      },
      async unsubscribe(customerId, variantId) {
        const label = await restockVariantLabel(dbHandle.db, variantId);
        await unsubscribeRestock(dbHandle.db, customerId, variantId);
        return { text: `Đã hủy báo có hàng${label ? `: ${label}` : ""}.`, buttons: [] };
      },
      async list(customerId) {
        return presentRestockList(dbHandle.db, customerId);
      },
    },
    adminRootUserId: config.ADMIN_TELEGRAM_USER_ID,
    observeCallback: (event) => {
      logger.info(
        {
          ack_ms: event.ackMs,
          server_issue_ack_ms: event.serverIssueAckMs,
          telegram_rtt_ms: event.telegramRttMs,
          render_ms: event.renderMs,
          action: event.action,
        },
        "catalog.callback.timing",
      );
    },
    sepayReconciliationText: async () => {
      const status = await getSePayReconciliationStatus(dbHandle.db);
      return formatSePayReconciliationAdminText(status);
    },
    preorder: {
      async consent(variantId) {
        const preorderConfig = await loadPreorderVariantConfig(dbHandle.db, variantId);
        if (!preorderConfig)
          return {
            text: "Sản phẩm không tồn tại hoặc chưa hỗ trợ đặt cọc.",
            buttons: [[{ text: "🛒 Về trang chủ", callbackData: "shop:home" }]],
          };
        return presentPreorderConsent(preorderConfig);
      },
      async create(input) {
        const res = await createPreorderReservation(dbHandle.db, {
          customerId: input.customerId,
          variantId: input.variantId,
          telegramUserId: input.telegramUserId,
          isRootAdmin:
            config.ADMIN_TELEGRAM_USER_ID !== undefined &&
            String(input.telegramUserId) === String(config.ADMIN_TELEGRAM_USER_ID),
        });
        if (!res.ok) {
          const msg =
            res.code === "STORE_CLOSED"
              ? "Cửa hàng đang đóng. Vui lòng quay lại sau."
              : res.code === "STORE_TEST_ONLY"
                ? "Sản phẩm này chỉ dành cho khách test trong chế độ TEST."
                : res.code === "QUEUE_FULL"
                  ? "Hàng chờ đặt cọc cho sản phẩm này đã đầy. Vui lòng quay lại sau."
                  : res.code === "ALREADY_PREORDERED"
                    ? "Bạn đã có một suất đặt cọc đang chờ xử lý cho sản phẩm này."
                    : "Không thể thực hiện đặt cọc lúc này.";
          return { text: msg, buttons: [[{ text: "🛒 Về trang chủ", callbackData: "shop:home" }]] };
        }
        return {
          text: [
            "✅ ĐẶT CỌC THÀNH CÔNG",
            "",
            `Sản phẩm: ${res.config.productName} · ${res.config.variantName}`,
            `Tiền cọc: ${res.depositVnd.toLocaleString("vi-VN")} ₫`,
            `Khi hàng về còn thanh toán: ${res.balanceVnd.toLocaleString("vi-VN")} ₫`,
            "",
            "Trạng thái: ⏳ Đang chờ đợt hàng mới về",
            "Hệ thống sẽ gửi thông báo giữ hàng ngay khi đợt hàng tiếp theo được nhập kho!",
          ].join("\n"),
          buttons: [
            [{ text: "📦 Xem các sản phẩm khác", callbackData: "shop:home" }],
            [{ text: "💬 Hỗ trợ", callbackData: "supp:open" }],
          ],
        };
      },
    },
    notificationPreferences: {
      async get(customerId) {
        const pref = await sql<{ marketing_opt_in: boolean; social_proof_opt_in: boolean }>`
          select marketing_opt_in, social_proof_opt_in from customer_notification_preference where customer_id = ${customerId}
        `.execute(dbHandle.db);
        const row = pref.rows[0];
        return presentCustomerNotificationPreferences({
          marketing: row?.marketing_opt_in ?? true,
          socialProof: row?.social_proof_opt_in ?? true,
        });
      },
      async toggle(customerId, kind) {
        const current = await sql<{ marketing_opt_in: boolean; social_proof_opt_in: boolean }>`
          select marketing_opt_in, social_proof_opt_in from customer_notification_preference where customer_id = ${customerId}
        `.execute(dbHandle.db);
        const curRow = current.rows[0];
        const nextMarketing =
          kind === "marketing"
            ? !(curRow?.marketing_opt_in ?? true)
            : (curRow?.marketing_opt_in ?? true);
        const nextSocial =
          kind === "social"
            ? !(curRow?.social_proof_opt_in ?? true)
            : (curRow?.social_proof_opt_in ?? true);
        await sql`
          insert into customer_notification_preference (customer_id, marketing_opt_in, social_proof_opt_in, updated_at)
          values (${customerId}, ${nextMarketing}, ${nextSocial}, now())
          on conflict (customer_id) do update
          set marketing_opt_in = ${nextMarketing},
              social_proof_opt_in = ${nextSocial},
              updated_at = now()
        `.execute(dbHandle.db);
        return presentCustomerNotificationPreferences({
          marketing: nextMarketing,
          socialProof: nextSocial,
        });
      },
    },
    notification: {
      async settings(customerId) {
        const p = await notificationService.getNotificationPreferences(dbHandle.db, customerId);
        return {
          text: `Cài đặt thông báo: cập nhật ${p.shopUpdates ? "BẬT" : "TẮT"}, hoạt động ${p.purchaseActivity ? "BẬT" : "TẮT"}. Bấm “🛍 Cập nhật sản phẩm” hoặc “📣 Hoạt động mua hàng” để đổi trạng thái.`,
          buttons: [],
        };
      },
      async toggle(customerId, kind) {
        const p = await notificationService.getNotificationPreferences(dbHandle.db, customerId);
        const next = await notificationService.setNotificationPreferences(dbHandle.db, {
          customerId,
          ...(kind === "shop"
            ? { shopUpdates: !p.shopUpdates }
            : { purchaseActivity: !p.purchaseActivity }),
        });
        return {
          text: `Đã ${kind === "shop" ? (next.shopUpdates ? "bật" : "tắt") : next.purchaseActivity ? "bật" : "tắt"} thông báo.`,
          buttons: [],
        };
      },
      async subscriptions(customerId) {
        return presentRestockList(dbHandle.db, customerId);
      },
    },
    async openDelivery(ctx, handoffId) {
      if (!config.DELIVERY_SESSION_HMAC_KEY) {
        return {
          text: "Giao hàng không khả dụng.",
          buttons: [[{ text: "Menu chính", callbackData: "menu:main" }]],
        };
      }
      const opened = await openTelegramDeliveryHandoff({
        db: dbHandle.db,
        vault,
        sessionConfig: {
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
        telegramUserId: ctx.telegramUserId,
        handoffId,
        correlationId: ctx.correlationId,
      });
      if (!opened.ok) {
        return {
          text: opened.message,
          buttons: [
            [{ text: "🧾 Đơn hàng", callbackData: "ord:list" }],
            [{ text: "💬 Hỗ trợ", callbackData: "sup:open" }],
          ],
        };
      }
      return presentDeliveryReveal(opened);
    },
    async walletAccount(ctx) {
      const customerId = await resolveCustomerId(ctx.telegramUserId);
      if (!customerId)
        return {
          text: "Không xác minh được khách hàng.",
          buttons: [[{ text: "Menu chính", callbackData: "menu:main" }]],
        };
      const account = await walletLedger.ensureAccount(customerId);
      if (!account)
        return {
          text: "Không tìm thấy tài khoản khách hàng.",
          buttons: [[{ text: "Menu chính", callbackData: "menu:main" }]],
        };
      return {
        text: `Ví của bạn\n\nSố dư: ${formatVnd(account.balanceVnd)}`,
        buttons: [
          [{ text: "Nạp ví", callbackData: "wallet:topup" }],
          [{ text: "Menu chính", callbackData: "menu:main" }],
        ],
      };
    },
    async walletTopup(ctx, action = { kind: "PICK" }) {
      const customerId = await resolveCustomerId(ctx.telegramUserId);
      if (!customerId)
        return {
          text: "Không xác minh được khách hàng.",
          buttons: [[{ text: "Menu chính", callbackData: "menu:main" }]],
        };
      const account = await walletLedger.ensureAccount(customerId);
      if (!account)
        return {
          text: "Không tìm thấy tài khoản khách hàng.",
          buttons: [[{ text: "Menu chính", callbackData: "menu:main" }]],
        };
      if (action.kind === "CUSTOM") {
        await saveWalletTopupAwaitingAmount({
          db: dbHandle.db,
          customerId,
          ttlSeconds: config.PAYMENT_INTENT_TTL_SECONDS,
        });
        return walletTopupCustomPrompt();
      }
      if (action.kind === "SELECT") {
        const parsed = parseWalletTopupAmount(action.amountVnd.toString(), walletTopupBounds);
        if (!parsed.ok) return walletTopupPickerMessage(account);
        await saveWalletTopupSelection({
          db: dbHandle.db,
          customerId,
          amountVnd: parsed.amountVnd,
          ttlSeconds: config.PAYMENT_INTENT_TTL_SECONDS,
        });
        return walletTopupConfirmMessage(parsed.amountVnd, account.balanceVnd);
      }
      if (action.kind === "CONFIRM") {
        const amountVnd = await loadWalletTopupSelection(dbHandle.db, customerId);
        if (!amountVnd)
          return walletTopupCustomPrompt(
            "Phiên chọn số tiền đã hết hạn. Nhập lại số tiền muốn nạp.",
          );
        const result = await presentWalletTopup({
          db: dbHandle.db,
          customerId,
          amountVnd,
          correlationId: ctx.correlationId,
          ...merchant,
        });
        return result.ok
          ? walletTopupPaymentScreen(await presentPaymentScreen(result.presentation))
          : walletTopupPickerMessage(account);
      }
      if (action.kind === "STATUS") {
        const latest = await loadLatestWalletTopup(dbHandle.db, customerId);
        if (!latest) return walletTopupPickerMessage(account);
        return {
          text: [
            "Trạng thái nạp ví",
            "",
            `Số tiền: ${formatVnd(latest.amountVnd)}`,
            `Nội dung chuyển khoản: ${latest.transferContent}`,
            `Trạng thái: ${latest.status}`,
          ].join("\n"),
          buttons: [
            [{ text: "Kiểm tra lại", callbackData: "wallet:topup:status" }],
            [{ text: "Đổi số tiền", callbackData: "wallet:topup:change" }],
            [{ text: "Huỷ", callbackData: "wallet:topup:cancel" }],
            [{ text: "Ví", callbackData: "wallet:account" }],
          ],
        };
      }
      if (action.kind === "CHANGE") {
        await cancelLiveWalletTopup({ db: dbHandle.db, customerId });
        await clearWalletTopupSelection(dbHandle.db, customerId);
        return walletTopupPickerMessage(account);
      }
      if (action.kind === "CANCEL") {
        await cancelLiveWalletTopup({ db: dbHandle.db, customerId });
        await clearWalletTopupSelection(dbHandle.db, customerId);
        return {
          text: "Đã huỷ nạp ví chưa thanh toán.",
          buttons: [
            [{ text: "Ví", callbackData: "wallet:account" }],
            [{ text: "Menu chính", callbackData: "menu:main" }],
          ],
        };
      }
      return walletTopupPickerMessage(account);
    },
    async walletTopupText(ctx, text) {
      const customerId = await resolveCustomerId(ctx.telegramUserId);
      if (!customerId) return null;
      if (!(await isAwaitingWalletTopupAmount(dbHandle.db, customerId))) return null;
      const account = await walletLedger.ensureAccount(customerId);
      if (!account)
        return {
          text: "Không tìm thấy tài khoản khách hàng.",
          buttons: [[{ text: "Menu chính", callbackData: "menu:main" }]],
        };
      const parsed = parseWalletTopupAmount(text, walletTopupBounds);
      if (!parsed.ok) return walletTopupCustomPrompt(parsed.error);
      await saveWalletTopupSelection({
        db: dbHandle.db,
        customerId,
        amountVnd: parsed.amountVnd,
        ttlSeconds: config.PAYMENT_INTENT_TTL_SECONDS,
      });
      return walletTopupConfirmMessage(parsed.amountVnd, account.balanceVnd);
    },
    async walletPay(ctx, orderNumber) {
      const customerId = await resolveCustomerId(ctx.telegramUserId);
      if (!customerId)
        return {
          text: "Không xác minh được khách hàng.",
          buttons: [[{ text: "Menu chính", callbackData: "menu:main" }]],
        };
      const orderId = (await findOrderByNumber(dbHandle.db, orderNumber))?.id;
      if (!orderId)
        return {
          text: "Không tìm thấy đơn hàng.",
          buttons: [[{ text: "Đơn hàng", callbackData: "ord:list" }]],
        };
      const result = await walletPurchase.purchase({
        customerId,
        orderId,
        idempotencyKey: `telegram:${ctx.telegramUserId}:${orderId}`,
        correlationId: ctx.correlationId,
      });
      return result.ok
        ? {
            text: "Đã thanh toán bằng ví. Chúng tôi sẽ giao tài khoản ngay.",
            buttons: [
              [{ text: "Xem đơn", callbackData: `ord:view:${orderId}` }],
              [{ text: "Menu chính", callbackData: "menu:main" }],
            ],
          }
        : {
            text: result.message,
            buttons: [
              [{ text: "Nạp ví", callbackData: "wallet:topup" }],
              [{ text: "Đơn hàng", callbackData: "ord:list" }],
            ],
          };
    },
    admin: {
      async orders(input) {
        if (
          Number(input.telegramUserId) !== config.ADMIN_TELEGRAM_USER_ID ||
          input.chatType !== "private"
        )
          return presentAdminDenied("NOT_ROOT_ADMIN");
        return presentAdminOrders(
          dbHandle.db,
          { presentAdminOrders: presentAdminOrdersPage },
          {
            adminTelegramUserId: input.telegramUserId,
            ...(input.filter === undefined ? {} : { filter: input.filter }),
            ...(input.query === undefined ? {} : { query: input.query }),
            ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
          },
        );
      },
      async orderState(input) {
        if (
          Number(input.telegramUserId) !== config.ADMIN_TELEGRAM_USER_ID ||
          input.chatType !== "private"
        )
          return presentAdminDenied("NOT_ROOT_ADMIN");
        return presentAdminOrderState(
          dbHandle.db,
          { presentAdminOrderDetail, presentAdminOrders: presentAdminOrdersPage },
          { adminTelegramUserId: input.telegramUserId, stateId: input.stateId },
        );
      },
      async orderSearch(input) {
        if (
          Number(input.telegramUserId) !== config.ADMIN_TELEGRAM_USER_ID ||
          input.chatType !== "private"
        )
          return presentAdminDenied("NOT_ROOT_ADMIN");
        return presentAdminOrderSearchPrompt();
      },
      async orderMessagePrompt(input) {
        if (
          Number(input.telegramUserId) !== config.ADMIN_TELEGRAM_USER_ID ||
          input.chatType !== "private"
        )
          return presentAdminDenied("NOT_ROOT_ADMIN");
        return presentAdminOrderMessagePrompt(dbHandle.db, {
          adminTelegramUserId: input.telegramUserId,
          stateId: input.stateId,
        });
      },
      async orderText(input) {
        if (
          Number(input.telegramUserId) !== config.ADMIN_TELEGRAM_USER_ID ||
          input.chatType !== "private"
        )
          return null;
        return handleAdminCustomerFreeText(dbHandle.db, {
          adminTelegramUserId: input.telegramUserId,
          text: input.text,
          actorId: input.telegramUserId,
          correlationId: input.correlationId,
        });
      },
      async customers(input) {
        if (
          Number(input.telegramUserId) !== config.ADMIN_TELEGRAM_USER_ID ||
          input.chatType !== "private"
        )
          return presentAdminDenied("NOT_ROOT_ADMIN");
        return presentAdminCustomers(dbHandle.db, {
          adminTelegramUserId: input.telegramUserId,
          ...(input.filter === undefined ? {} : { filter: input.filter }),
          ...(input.query === undefined ? {} : { query: input.query }),
          ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
        });
      },
      async customerState(input) {
        if (
          Number(input.telegramUserId) !== config.ADMIN_TELEGRAM_USER_ID ||
          input.chatType !== "private"
        )
          return presentAdminDenied("NOT_ROOT_ADMIN");
        const state = await resolveAdminCallbackState(dbHandle.db, {
          adminTelegramUserId: input.telegramUserId,
          stateId: input.stateId,
        });
        if (state?.kind === "CUSTOMER_DETAIL" && typeof state.payload.customerId === "string")
          return presentAdminCustomerFinancialDetail(
            dbHandle.db,
            state.payload.customerId,
            input.telegramUserId,
          );
        if (state?.kind === "CUSTOMER_PAGE")
          return presentAdminCustomers(dbHandle.db, {
            adminTelegramUserId: input.telegramUserId,
            ...(typeof state.payload.filter === "string"
              ? { filter: state.payload.filter as AdminCustomerFilter }
              : {}),
            query: typeof state.payload.query === "string" ? state.payload.query : null,
            cursor: typeof state.payload.cursor === "string" ? state.payload.cursor : null,
          });
        return {
          text: "Phiên khách hàng đã hết hạn.",
          buttons: [[{ text: "👥 Khách hàng", callbackData: "admin:customers" }]],
        };
      },
      async customerSearch(input) {
        if (
          Number(input.telegramUserId) !== config.ADMIN_TELEGRAM_USER_ID ||
          input.chatType !== "private"
        )
          return presentAdminDenied("NOT_ROOT_ADMIN");
        return presentAdminCustomerSearchPrompt(dbHandle.db, input.telegramUserId);
      },
      async customerMessagePrompt(input) {
        if (
          Number(input.telegramUserId) !== config.ADMIN_TELEGRAM_USER_ID ||
          input.chatType !== "private"
        )
          return presentAdminDenied("NOT_ROOT_ADMIN");
        return presentAdminCustomerMessagePrompt(dbHandle.db, {
          adminTelegramUserId: input.telegramUserId,
          stateId: input.stateId,
        });
      },
      async customerText(input) {
        if (
          Number(input.telegramUserId) !== config.ADMIN_TELEGRAM_USER_ID ||
          input.chatType !== "private"
        )
          return null;
        return handleAdminCustomerFreeText(dbHandle.db, {
          adminTelegramUserId: input.telegramUserId,
          text: input.text,
          actorId: input.telegramUserId,
          correlationId: input.correlationId,
        });
      },
      async presentAdminCustomerDetail(ctx, customerId) {
        if (
          Number(ctx.telegramUserId) !== config.ADMIN_TELEGRAM_USER_ID ||
          ctx.chatType !== "private"
        )
          return presentAdminDenied("NOT_ROOT_ADMIN");
        return presentAdminCustomerFinancialDetail(dbHandle.db, customerId, ctx.telegramUserId);
      },
      async sendAdminCustomerMessage(ctx, input) {
        if (
          Number(ctx.telegramUserId) !== config.ADMIN_TELEGRAM_USER_ID ||
          ctx.chatType !== "private"
        )
          return presentAdminDenied("NOT_ROOT_ADMIN");
        return handleAdminCustomerFreeText(dbHandle.db, {
          adminTelegramUserId: ctx.telegramUserId,
          text: input.text,
          actorId: String(ctx.telegramUserId),
          correlationId: ctx.correlationId,
        });
      },
      async support(input) {
        if (input.chatType !== "private") return presentAdminDenied("WRONG_CONTEXT");
        if (!adminCallbacks) return presentAdminDenied("NOT_ROOT_ADMIN");
        const gate = await adminCallbacks.handle({
          command: "order.inspect",
          actor: { numericUserId: Number(input.telegramUserId), chatType: input.chatType },
          targetId: "admin-support",
          reason: "Admin support queue access",
          correlationId: input.correlationId,
        });
        if (!gate.ok)
          return presentAdminDenied(
            gate.code === "WRONG_CONTEXT" ? "WRONG_CONTEXT" : "NOT_ROOT_ADMIN",
          );
        const rows = await sql<{
          case_id: string;
          order_id: string;
          order_number: string;
          customer_id: string;
          reason_code: string;
          safe_summary: string | null;
        }>`
          select rc.id as case_id, rc.order_id, o.order_number, o.customer_id,
                 rc.reason_code, st.safe_summary
          from replacement_case rc
          join "order" o on o.id = rc.order_id
          left join support_ticket st on st.order_id = rc.order_id and st.reason_code = 'ASSET_NOT_WORKING'
          where rc.status in ('OPEN','APPROVED')
          order by rc.opened_at asc, rc.id asc
          limit 10
        `.execute(dbHandle.db);
        return presentAdminSupportQueue(
          rows.rows.map((row) => ({
            caseId: row.case_id,
            orderId: row.order_id,
            orderNumber: row.order_number,
            customerId: row.customer_id,
            reasonCode: row.reason_code,
            safeSummary: row.safe_summary,
          })),
        );
      },
      async supportApprove(input) {
        if (input.chatType !== "private") return presentAdminDenied("WRONG_CONTEXT");
        if (!adminCallbacks) return presentAdminDenied("NOT_ROOT_ADMIN");
        const result = await adminCallbacks.handle({
          command: "support.replacement.approve",
          actor: { numericUserId: Number(input.telegramUserId), chatType: input.chatType },
          targetId: input.caseId,
          reason: "Replacement approval requested from Telegram admin support UI",
          correlationId: input.correlationId,
        });
        if (!result.ok)
          return presentAdminDenied(
            result.code === "WRONG_CONTEXT" ? "WRONG_CONTEXT" : "NOT_ROOT_ADMIN",
          );
        return result.needsConfirmation
          ? presentHighRiskChallenge({
              confirmationId: result.confirmationId,
              challenge: result.challenge,
              expiresAt: result.expiresAt,
              action: "support.replacement.approve",
            })
          : presentHighRiskDone("support.replacement.approve");
      },
      async manualTasks(input) {
        if (input.chatType !== "private") return presentAdminDenied("WRONG_CONTEXT");
        if (!adminCallbacks) return presentAdminDenied("NOT_ROOT_ADMIN");
        const gate = await adminCallbacks.handle({
          command: "order.inspect",
          actor: { numericUserId: Number(input.telegramUserId), chatType: input.chatType },
          targetId: "admin-manual-fulfillment",
          reason: "Admin manual fulfillment access",
          correlationId: input.correlationId,
        });
        if (!gate.ok)
          return presentAdminDenied(
            gate.code === "WRONG_CONTEXT" ? "WRONG_CONTEXT" : "NOT_ROOT_ADMIN",
          );
        return presentAdminManualTasks(
          await listManualFulfillmentTasks(dbHandle.db, { status: "OPEN" }),
        );
      },
      async manualTask(input) {
        if (input.chatType !== "private") return presentAdminDenied("WRONG_CONTEXT");
        if (!adminCallbacks) return presentAdminDenied("NOT_ROOT_ADMIN");
        const gate = await adminCallbacks.handle({
          command: "order.inspect",
          actor: { numericUserId: Number(input.telegramUserId), chatType: input.chatType },
          targetId: input.taskId,
          reason: "Admin manual fulfillment detail",
          correlationId: input.correlationId,
        });
        if (!gate.ok)
          return presentAdminDenied(
            gate.code === "WRONG_CONTEXT" ? "WRONG_CONTEXT" : "NOT_ROOT_ADMIN",
          );
        const task = await getManualTaskById(dbHandle.db, input.taskId);
        if (!task)
          return {
            text: "Không tìm thấy tác vụ thủ công.",
            buttons: [[{ text: "🛠 Xử lý thủ công", callbackData: "admin:manual" }]],
          };
        const confirmationStateId =
          task.status === "OPEN"
            ? await createAdminCallbackState(dbHandle.db, {
                adminTelegramUserId: input.telegramUserId,
                kind: "MANUAL_TASK_COMPLETE",
                payload: { taskId: task.id },
              })
            : undefined;
        return presentAdminManualTaskDetail({
          task,
          ...(confirmationStateId ? { confirmationStateId } : {}),
        });
      },
      async manualComplete(input) {
        if (input.chatType !== "private") return presentAdminDenied("WRONG_CONTEXT");
        if (!adminCallbacks) return presentAdminDenied("NOT_ROOT_ADMIN");
        const state = await resolveAdminCallbackState(dbHandle.db, {
          adminTelegramUserId: input.telegramUserId,
          stateId: input.stateId,
        });
        const taskId =
          state?.kind === "MANUAL_TASK_COMPLETE" && typeof state.payload.taskId === "string"
            ? state.payload.taskId
            : null;
        if (!taskId)
          return {
            text: "Phiên xác nhận tác vụ đã hết hạn.",
            buttons: [[{ text: "🛠 Xử lý thủ công", callbackData: "admin:manual" }]],
          };
        const result = await adminCallbacks.handle({
          command: "manual_fulfillment.complete",
          actor: { numericUserId: Number(input.telegramUserId), chatType: input.chatType },
          targetId: taskId,
          reason: "Manual fulfillment completion requested from Telegram admin UI",
          correlationId: input.correlationId,
        });
        if (!result.ok)
          return presentAdminDenied(
            result.code === "WRONG_CONTEXT" ? "WRONG_CONTEXT" : "NOT_ROOT_ADMIN",
          );
        return result.needsConfirmation
          ? presentHighRiskChallenge({
              confirmationId: result.confirmationId,
              challenge: result.challenge,
              expiresAt: result.expiresAt,
              action: "manual_fulfillment.complete",
            })
          : presentHighRiskDone("manual_fulfillment.complete");
      },
      async mainMenu(input) {
        if (input.chatType !== "private") return presentAdminDenied("WRONG_CONTEXT");
        if (!adminCallbacks) return presentAdminDenied("NOT_ROOT_ADMIN");
        const result = await adminCallbacks.handle({
          command: "order.inspect",
          actor: { numericUserId: Number(input.telegramUserId), chatType: "private" },
          targetId: "admin-menu",
          reason: "Admin menu access",
          correlationId: input.correlationId,
        });
        return result.ok
          ? presentAdminMenu(await getStoreMode(dbHandle.db))
          : presentAdminDenied(
              result.code === "WRONG_CONTEXT" ? "WRONG_CONTEXT" : "NOT_ROOT_ADMIN",
            );
      },
      async storeMode(input) {
        if (input.chatType !== "private") return presentAdminDenied("WRONG_CONTEXT");
        if (Number(input.telegramUserId) !== config.ADMIN_TELEGRAM_USER_ID)
          return presentAdminDenied("NOT_ROOT_ADMIN");
        return presentAdminStoreMode(await getStoreMode(dbHandle.db));
      },
      async storeTest(input) {
        if (input.chatType !== "private") return presentAdminDenied("WRONG_CONTEXT");
        if (Number(input.telegramUserId) !== config.ADMIN_TELEGRAM_USER_ID)
          return presentAdminDenied("NOT_ROOT_ADMIN");
        await setStoreMode(dbHandle.db, "TEST", input.telegramUserId);
        await appendAuditEvent(dbHandle.db, {
          actorType: "ROOT_ADMIN",
          actorId: input.telegramUserId,
          action: "store.test",
          targetType: "StoreControl",
          targetId: "main",
          reason: "Bật chế độ TEST — chỉ khách test mua được sản phẩm test",
          correlationId: input.correlationId,
        });
        return presentAdminStoreMode(await getStoreMode(dbHandle.db));
      },
      async storeOpen(input) {
        if (input.chatType !== "private") return presentAdminDenied("WRONG_CONTEXT");
        if (Number(input.telegramUserId) !== config.ADMIN_TELEGRAM_USER_ID)
          return presentAdminDenied("NOT_ROOT_ADMIN");
        const counts = await sql<{ active_products: number; in_stock_variants: number }>`
          with public_variants as (
            select v.id, v.fulfillment_type
            from product_variant v
            join product p on p.id = v.product_id
            where v.is_active and p.is_active and not p.is_test and not p.is_archived
              and v.price_vnd > 0
          ),
          stock as (
            select pv.id,
              case
                when pv.fulfillment_type in ('STOCK_ACCOUNT','STOCK_CODE') then (
                  select count(*)::int from digital_asset a where a.variant_id = pv.id and a.status = 'AVAILABLE'
                )
                when pv.fulfillment_type = 'QUANTITY_STOCK' then coalesce((
                  select q.available_quantity from variant_quantity_stock q where q.variant_id = pv.id
                ), 0)::int
                when pv.fulfillment_type in ('MANUAL_FULFILLMENT','UNLIMITED_SERVICE') then 1
                when pv.fulfillment_type = 'DIGITAL_FILE' then (
                  select count(*)::int from variant_file_artifact f where f.variant_id = pv.id and f.is_active
                )
                else 0
              end as available
            from public_variants pv
          )
          select
            (select count(distinct p.id)::int from product p
              join product_variant v on v.product_id = p.id and v.is_active
              where p.is_active and not p.is_test and not p.is_archived) as active_products,
            (select count(*)::int from stock where available > 0) as in_stock_variants
        `.execute(dbHandle.db);
        const row = counts.rows[0] ?? { active_products: 0, in_stock_variants: 0 };
        if (row.active_products === 0)
          return {
            text: "Không thể mở bán: chưa có sản phẩm public đang hoạt động.\n\nTạo và kích hoạt ít nhất một sản phẩm public trước, hoặc dùng 🧪 Chế độ TEST để thử luồng mua.",
            buttons: [
              [{ text: "🧪 Chế độ TEST", callbackData: "admin:store:test" }],
              [{ text: "⬅️ Quay lại", callbackData: "admin:store:mode" }],
            ],
          };
        return presentAdminStoreOpenConfirmation({
          activeProducts: row.active_products,
          inStockVariants: row.in_stock_variants,
        });
      },
      async storeOpenConfirm(input) {
        if (input.chatType !== "private") return presentAdminDenied("WRONG_CONTEXT");
        if (Number(input.telegramUserId) !== config.ADMIN_TELEGRAM_USER_ID)
          return presentAdminDenied("NOT_ROOT_ADMIN");
        await setStoreMode(dbHandle.db, "OPEN", input.telegramUserId);
        await appendAuditEvent(dbHandle.db, {
          actorType: "ROOT_ADMIN",
          actorId: input.telegramUserId,
          action: "store.open",
          targetType: "StoreControl",
          targetId: "main",
          reason: "Mở bán công khai (xác nhận qua nút)",
          correlationId: input.correlationId,
        });
        return presentAdminStoreMode(await getStoreMode(dbHandle.db));
      },
      async storeClose(input) {
        if (input.chatType !== "private") return presentAdminDenied("WRONG_CONTEXT");
        if (Number(input.telegramUserId) !== config.ADMIN_TELEGRAM_USER_ID)
          return presentAdminDenied("NOT_ROOT_ADMIN");
        await setStoreMode(dbHandle.db, "CLOSED", input.telegramUserId);
        await appendAuditEvent(dbHandle.db, {
          actorType: "ROOT_ADMIN",
          actorId: input.telegramUserId,
          action: "store.close",
          targetType: "StoreControl",
          targetId: "main",
          reason: "Đóng cửa hàng tạm dừng bán",
          correlationId: input.correlationId,
        });
        return presentAdminStoreMode(await getStoreMode(dbHandle.db));
      },
      async dashboard(input) {
        if (input.chatType !== "private") return presentAdminDenied("WRONG_CONTEXT");
        if (!adminCallbacks) return presentAdminDenied("NOT_ROOT_ADMIN");
        const gate = await adminCallbacks.handle({
          command: "order.inspect",
          actor: { numericUserId: Number(input.telegramUserId), chatType: "private" },
          targetId: "admin-dashboard",
          reason: "Admin dashboard access",
          correlationId: input.correlationId,
        });
        if (!gate.ok)
          return presentAdminDenied(
            gate.code === "WRONG_CONTEXT" ? "WRONG_CONTEXT" : "NOT_ROOT_ADMIN",
          );
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
            select v.id as variant_id,
              v.low_stock_threshold,
              case
                when v.fulfillment_type = 'QUANTITY_STOCK' then coalesce(q.available_quantity, 0)::int
                else count(da.id)::int
              end as available
            from product_variant v
            left join digital_asset da on da.variant_id = v.id and da.status = 'AVAILABLE'
            left join variant_quantity_stock q on q.variant_id = v.id
            where v.is_active
            group by v.id, q.available_quantity
          )
          select
            (select count(*)::int from product where is_active) as active_products,
            (select count(*)::int from variant_stock where available = 0) as out_of_stock,
            (select count(*)::int from variant_stock where low_stock_threshold is not null and low_stock_threshold > 0 and available > 0 and available <= low_stock_threshold) as low_stock,
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
      async audit(input) {
        if (input.chatType !== "private") return presentAdminDenied("WRONG_CONTEXT");
        if (!adminCallbacks) return presentAdminDenied("NOT_ROOT_ADMIN");
        const gate = await adminCallbacks.handle({
          command: "order.inspect",
          actor: { numericUserId: Number(input.telegramUserId), chatType: "private" },
          targetId: "admin-inventory",
          reason: "Admin inventory audit access",
          correlationId: input.correlationId,
        });
        if (!gate.ok)
          return presentAdminDenied(
            gate.code === "WRONG_CONTEXT" ? "WRONG_CONTEXT" : "NOT_ROOT_ADMIN",
          );
        return presentAuditList(
          await listAuditEvents(dbHandle.db, {
            targetType: "DigitalAsset",
            targetId: "manual",
            limit: 10,
          }),
        );
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
        if (!gate.ok)
          return presentAdminDenied(
            gate.code === "WRONG_CONTEXT" ? "WRONG_CONTEXT" : "NOT_ROOT_ADMIN",
          );
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
        if (!gate.ok)
          return presentAdminDenied(
            gate.code === "WRONG_CONTEXT" ? "WRONG_CONTEXT" : "NOT_ROOT_ADMIN",
          );
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
        if (!row)
          return {
            text: "Sản phẩm không còn hợp lệ.",
            buttons: [[{ text: "Products", callbackData: "admin:products" }]],
          };
        const variants = await sql<{
          id: string;
          name: string;
          sku: string;
          price_vnd: string;
          active: boolean;
          fulfillment_type: string;
          version: number;
        }>`
          select id, name_vi as name, sku, price_vnd::text as price_vnd, is_active as active, fulfillment_type, version
          from product_variant
          where product_id = ${input.productId}
          order by sort_order asc, id asc
          limit 20
        `.execute(dbHandle.db);
        return presentAdminProductDetail({
          id: row.id,
          name: row.name,
          slug: row.slug,
          categoryName: row.category_name,
          description: row.description,
          active: row.active,
          variantCount: row.variant_count,
          minPriceVnd: BigInt(row.min_price_vnd ?? 0),
          variants: variants.rows.map((variant) => ({
            id: variant.id,
            name: variant.name,
            sku: variant.sku,
            priceVnd: BigInt(variant.price_vnd),
            active: variant.active,
            fulfillmentType: variant.fulfillment_type,
            expectedVersion: variant.version,
          })),
        });
      },
      async variantCreatePrompt(input) {
        if (input.chatType !== "private") return presentAdminDenied("WRONG_CONTEXT");
        if (!adminCallbacks) return presentAdminDenied("NOT_ROOT_ADMIN");
        const gate = await adminCallbacks.handle({
          command: "order.inspect",
          actor: { numericUserId: Number(input.telegramUserId), chatType: "private" },
          targetId: input.productId,
          reason: "Admin variant create access",
          correlationId: input.correlationId,
        });
        if (!gate.ok)
          return presentAdminDenied(
            gate.code === "WRONG_CONTEXT" ? "WRONG_CONTEXT" : "NOT_ROOT_ADMIN",
          );
        const product = await sql<{
          id: string;
        }>`select id from product where id=${input.productId} limit 1`.execute(dbHandle.db);
        if (!product.rows[0])
          return {
            text: "Sản phẩm không còn hợp lệ.",
            buttons: [[{ text: "🛍 Sản phẩm", callbackData: "admin:products" }]],
          };
        await productDraftWorkflow.startVariant(input.telegramUserId, input.productId);
        return {
          text: "Bước 2/8 — Nhập SKU biến thể.",
          buttons: [[{ text: "Huỷ", callbackData: "admin:products:cancel" }]],
        };
      },
      async variantEditPrompt(input) {
        if (input.chatType !== "private") return presentAdminDenied("WRONG_CONTEXT");
        if (!adminCallbacks) return presentAdminDenied("NOT_ROOT_ADMIN");
        const row = (
          await sql<{
            id: string;
            product_id: string;
            name: string;
            sku: string;
            price_vnd: string;
            duration_code: string;
            warranty_days: number;
            low_stock_threshold: number | null;
            version: number;
          }>`select id, product_id, name_vi as name, sku, price_vnd::text as price_vnd, duration_code, warranty_days, low_stock_threshold, version from product_variant where id=${input.variantId} limit 1`.execute(
            dbHandle.db,
          )
        ).rows[0];
        if (!row)
          return {
            text: "Biến thể không còn hợp lệ.",
            buttons: [[{ text: "🛍 Sản phẩm", callbackData: "admin:products" }]],
          };
        const gate = await adminCallbacks.handle({
          command: "order.inspect",
          actor: { numericUserId: Number(input.telegramUserId), chatType: "private" },
          targetId: row.product_id,
          reason: "Admin variant edit access",
          correlationId: input.correlationId,
        });
        if (!gate.ok)
          return presentAdminDenied(
            gate.code === "WRONG_CONTEXT" ? "WRONG_CONTEXT" : "NOT_ROOT_ADMIN",
          );
        const stateId = await createAdminCallbackState(dbHandle.db, {
          adminTelegramUserId: input.telegramUserId,
          kind: "ADMIN_VARIANT_UPDATE",
          payload: { productId: row.product_id, variantId: row.id, expectedVersion: row.version },
        });
        return presentAdminVariantDraft({
          stateId,
          productId: row.product_id,
          variantId: row.id,
          expectedVersion: row.version,
          sku: row.sku,
          name: row.name,
          priceVnd: BigInt(row.price_vnd),
          durationCode: row.duration_code,
          warrantyDays: row.warranty_days,
          lowStockThreshold: row.low_stock_threshold,
        });
      },
      async suppliers(input) {
        if (input.chatType !== "private") return presentAdminDenied("WRONG_CONTEXT");
        if (!adminCallbacks) return presentAdminDenied("NOT_ROOT_ADMIN");
        const gate = await adminCallbacks.handle({
          command: "order.inspect",
          actor: { numericUserId: Number(input.telegramUserId), chatType: "private" },
          targetId: "admin-suppliers",
          reason: "Admin suppliers access",
          correlationId: input.correlationId,
        });
        if (!gate.ok)
          return presentAdminDenied(
            gate.code === "WRONG_CONTEXT" ? "WRONG_CONTEXT" : "NOT_ROOT_ADMIN",
          );
        const result = await sql<{
          id: string;
          name: string;
          adapter_type: string;
          status: string;
          active_mappings: number;
          variant_id: string | null;
          variant_name: string | null;
        }>`
          select s.id, s.name, s.adapter_type, s.status,
            count(ss.id) over (partition by s.id)::int as active_mappings,
            ss.variant_id,
            v.name_vi as variant_name
          from supplier s
          left join supplier_sku ss on ss.supplier_id = s.id and ss.is_active
          left join product_variant v on v.id = ss.variant_id
          where s.status = 'ACTIVE'
          order by s.name asc, ss.external_sku asc, s.id asc
          limit 20
        `.execute(dbHandle.db);
        return presentAdminSuppliersMenu(
          result.rows.map((supplier) => ({
            id: supplier.id,
            name: supplier.name,
            adapterType: supplier.adapter_type,
            status: supplier.status,
            activeMappings: supplier.active_mappings,
            ...(supplier.variant_id ? { variantId: supplier.variant_id } : {}),
            ...(supplier.variant_name ? { variantName: supplier.variant_name } : {}),
          })),
        );
      },
      async supplierVariant(input) {
        if (input.chatType !== "private") return presentAdminDenied("WRONG_CONTEXT");
        if (!adminCallbacks) return presentAdminDenied("NOT_ROOT_ADMIN");
        const gate = await adminCallbacks.handle({
          command: "order.inspect",
          actor: { numericUserId: Number(input.telegramUserId), chatType: "private" },
          targetId: input.variantId,
          reason: "Admin supplier variant access",
          correlationId: input.correlationId,
        });
        if (!gate.ok)
          return presentAdminDenied(
            gate.code === "WRONG_CONTEXT" ? "WRONG_CONTEXT" : "NOT_ROOT_ADMIN",
          );
        const variant = await sql<{
          id: string;
          name: string;
          sku: string;
          supplier_sku_id: string | null;
        }>`select id, name_vi as name, sku, supplier_sku_id from product_variant where id = ${input.variantId} limit 1`.execute(
          dbHandle.db,
        );
        const row = variant.rows[0];
        if (!row)
          return {
            text: "Biến thể không còn hợp lệ.",
            buttons: [[{ text: "🚚 Nhà cung cấp", callbackData: "admin:suppliers" }]],
          };
        const mappings = await sql<{
          supplier_sku_id: string;
          supplier_name: string;
          external_sku: string;
          cost_vnd: string | number;
          region: string | null;
          active: boolean;
          last_verified_at: Date | string | null;
        }>`
          select ss.id as supplier_sku_id, s.name as supplier_name, ss.external_sku, ss.cost_vnd, ss.region, ss.is_active as active, ss.last_verified_at
          from supplier_sku ss
          join supplier s on s.id = ss.supplier_id
          where ss.variant_id = ${input.variantId} and s.status = 'ACTIVE'
          order by case when ss.id = ${row.supplier_sku_id} then 0 else 1 end, ss.external_sku asc
          limit 20
        `.execute(dbHandle.db);
        return presentAdminSupplierVariant({
          variantId: row.id,
          variantName: row.name,
          sku: row.sku,
          mappings: mappings.rows.map((mapping) => ({
            supplierSkuId: mapping.supplier_sku_id,
            supplierName: mapping.supplier_name,
            externalSku: mapping.external_sku,
            costVnd: BigInt(mapping.cost_vnd),
            region: mapping.region,
            active: mapping.active,
            selected: mapping.supplier_sku_id === row.supplier_sku_id,
            lastVerifiedAt: mapping.last_verified_at
              ? new Date(mapping.last_verified_at).toISOString()
              : null,
          })),
        });
      },
      async supplierSelect(input) {
        if (input.chatType !== "private") return presentAdminDenied("WRONG_CONTEXT");
        const mapping = await sql<{
          variant_id: string;
        }>`select variant_id from supplier_sku where id = ${input.supplierSkuId} limit 1`.execute(
          dbHandle.db,
        );
        const variantId = mapping.rows[0]?.variant_id;
        if (!variantId)
          return {
            text: "Mapping nhà cung cấp không còn hợp lệ.",
            buttons: [[{ text: "🚚 Nhà cung cấp", callbackData: "admin:suppliers" }]],
          };
        const result = await selectVariantSupplierMapping({
          db: dbHandle.db,
          actor: { numericUserId: Number(input.telegramUserId), chatType: "private" },
          config: {
            adminTelegramUserId: config.ADMIN_TELEGRAM_USER_ID,
            expectedUsername: config.ADMIN_EXPECTED_USERNAME,
          },
          variantId,
          supplierSkuId: input.supplierSkuId,
          reason: "Admin selected supplier mapping",
          correlationId: input.correlationId,
        });
        return result.ok
          ? presentAdminSupplierActionDone({ action: "select", variantId })
          : presentAdminDenied(
              result.code === "WRONG_CONTEXT" ? "WRONG_CONTEXT" : "NOT_ROOT_ADMIN",
            );
      },
      async supplierClear(input) {
        if (input.chatType !== "private") return presentAdminDenied("WRONG_CONTEXT");
        const result = await clearVariantSupplierMapping({
          db: dbHandle.db,
          actor: { numericUserId: Number(input.telegramUserId), chatType: "private" },
          config: {
            adminTelegramUserId: config.ADMIN_TELEGRAM_USER_ID,
            expectedUsername: config.ADMIN_EXPECTED_USERNAME,
          },
          variantId: input.variantId,
          reason: "Admin cleared supplier mapping",
          correlationId: input.correlationId,
        });
        return result.ok
          ? presentAdminSupplierActionDone({ action: "clear", variantId: input.variantId })
          : presentAdminDenied(
              result.code === "WRONG_CONTEXT" ? "WRONG_CONTEXT" : "NOT_ROOT_ADMIN",
            );
      },
      async supplierVerify(input) {
        if (input.chatType !== "private") return presentAdminDenied("WRONG_CONTEXT");
        const mapping = await sql<{
          variant_id: string;
        }>`select variant_id from supplier_sku where id = ${input.supplierSkuId} limit 1`.execute(
          dbHandle.db,
        );
        const variantId = mapping.rows[0]?.variant_id;
        if (!variantId)
          return {
            text: "Mapping nhà cung cấp không còn hợp lệ.",
            buttons: [[{ text: "🚚 Nhà cung cấp", callbackData: "admin:suppliers" }]],
          };
        const result = await markSupplierSkuManuallyVerified({
          db: dbHandle.db,
          actor: { numericUserId: Number(input.telegramUserId), chatType: "private" },
          config: {
            adminTelegramUserId: config.ADMIN_TELEGRAM_USER_ID,
            expectedUsername: config.ADMIN_EXPECTED_USERNAME,
          },
          variantId,
          supplierSkuId: input.supplierSkuId,
          reason: "Admin manually verified supplier mapping",
          correlationId: input.correlationId,
        });
        return result.ok
          ? presentAdminSupplierActionDone({ action: "verify", variantId })
          : presentAdminDenied(
              result.code === "WRONG_CONTEXT" ? "WRONG_CONTEXT" : "NOT_ROOT_ADMIN",
            );
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
        if (!result.ok)
          return presentAdminDenied(
            result.code === "WRONG_CONTEXT" ? "WRONG_CONTEXT" : "NOT_ROOT_ADMIN",
          );
        if (result.needsConfirmation)
          return presentHighRiskChallenge({
            confirmationId: result.confirmationId,
            challenge: result.challenge,
            expiresAt: result.expiresAt,
            action: command,
          });
        if (command === "catalog.activate" || command === "catalog.deactivate")
          return presentKillSwitchDone({ command, targetId: input.targetId });
        return result.inventorySummary
          ? {
              text: `✅ Nhập kho: ${result.inventorySummary.imported} mới, ${result.inventorySummary.duplicates} trùng, ${result.inventorySummary.invalid} lỗi`,
              buttons: [[{ text: "Menu chính", callbackData: "menu:main" }]],
            }
          : {
              text: "✅ Đã ghi nhận lệnh quản trị.",
              buttons: [[{ text: "Menu chính", callbackData: "menu:main" }]],
            };
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
        return result.ok
          ? presentHighRiskDone("admin.confirm")
          : {
              text: "❌ Xác nhận thất bại hoặc đã hết hạn",
              buttons: [[{ text: "Admin", callbackData: "admin:menu" }]],
            };
      },
      async inventory(input) {
        if (input.chatType !== "private") return presentAdminDenied("WRONG_CONTEXT");
        if (!adminCallbacks) return presentAdminDenied("NOT_ROOT_ADMIN");
        const gate = await adminCallbacks.handle({
          command: "order.inspect",
          actor: { numericUserId: Number(input.telegramUserId), chatType: input.chatType },
          targetId: "admin-inventory",
          reason: "Admin inventory access",
          correlationId: input.correlationId,
        });
        if (!gate.ok)
          return presentAdminDenied(
            gate.code === "WRONG_CONTEXT" ? "WRONG_CONTEXT" : "NOT_ROOT_ADMIN",
          );
        const result = await sql<{
          id: string;
          name: string;
          variant_count: number;
          in_stock: number;
          low_stock: number;
          out_stock: number;
          active: boolean;
          total_products: number;
          total_variants: number;
          total_in_stock: number;
          total_low_stock: number;
          total_out_stock: number;
        }>`
          with variant_stock as (
            select v.id, v.product_id, v.low_stock_threshold, v.is_active as active,
              case
                when v.fulfillment_type = 'QUANTITY_STOCK' then coalesce((select q.available_quantity from variant_quantity_stock q where q.variant_id = v.id), 0)::int
                when v.fulfillment_type = 'DIGITAL_FILE' then coalesce((select count(*) from variant_file_artifact a where a.variant_id = v.id and a.is_active), 0)::int
                when v.fulfillment_type = 'SUPPLIER_API' then coalesce((select count(*) from supplier_sku ss where ss.variant_id = v.id and ss.is_active), 0)::int
                else coalesce((select count(*) from digital_asset da where da.variant_id = v.id and da.status = 'AVAILABLE'), 0)::int
              end as available
            from product_variant v
          ), product_stock as (
            select p.id, p.name_vi as name, p.is_active as active, p.sort_order, count(vs.id)::int as variant_count,
              count(vs.id) filter (where vs.available > 0)::int as in_stock,
              count(vs.id) filter (where vs.low_stock_threshold is not null and vs.low_stock_threshold > 0 and vs.available > 0 and vs.available <= vs.low_stock_threshold)::int as low_stock,
              count(vs.id) filter (where vs.available <= 0)::int as out_stock
            from product p
            left join variant_stock vs on vs.product_id = p.id
            where p.is_archived = false
            group by p.id, p.name_vi, p.is_active, p.sort_order
          )
          select id, name, active, variant_count, in_stock, low_stock, out_stock,
            count(*) over()::int as total_products,
            coalesce(sum(variant_count) over(), 0)::int as total_variants,
            coalesce(sum(in_stock) over(), 0)::int as total_in_stock,
            coalesce(sum(low_stock) over(), 0)::int as total_low_stock,
            coalesce(sum(out_stock) over(), 0)::int as total_out_stock
          from product_stock
          order by sort_order asc, id asc
          limit 20
        `.execute(dbHandle.db);
        const extraCounts = await sql<{ held: number; waiting: number }>`
          select
            coalesce((select count(*)::int from digital_asset da join product_variant pv on pv.id = da.variant_id join product p on p.id = pv.product_id where da.status = 'RESERVED' and p.is_archived = false), 0)::int as held,
            coalesce((select count(*)::int from preorder_reservation pr where pr.status in ('WAITING_DEPOSIT', 'DEPOSIT_PAID')), 0)::int as waiting
        `.execute(dbHandle.db);
        const held = extraCounts.rows[0]?.held ?? 0;
        const waiting = extraCounts.rows[0]?.waiting ?? 0;
        return presentAdminInventory(
          result.rows.map((row) => ({
            id: row.id,
            name: row.name,
            active: row.active,
            variantCount: row.variant_count,
            inStock: row.in_stock,
            lowStock: row.low_stock,
            outOfStock: row.out_stock,
          })),
          {
            products: result.rows[0]?.total_products ?? 0,
            variants: result.rows[0]?.total_variants ?? 0,
            inStock: result.rows[0]?.total_in_stock ?? 0,
            lowStock: result.rows[0]?.total_low_stock ?? 0,
            outOfStock: result.rows[0]?.total_out_stock ?? 0,
            held,
            waiting,
          },
        );
      },
      async inventoryProduct(input) {
        if (input.chatType !== "private") return presentAdminDenied("WRONG_CONTEXT");
        if (!adminCallbacks) return presentAdminDenied("NOT_ROOT_ADMIN");
        const gate = await adminCallbacks.handle({
          command: "order.inspect",
          actor: { numericUserId: Number(input.telegramUserId), chatType: input.chatType },
          targetId: input.productId,
          reason: "Admin inventory product access",
          correlationId: input.correlationId,
        });
        if (!gate.ok)
          return presentAdminDenied(
            gate.code === "WRONG_CONTEXT" ? "WRONG_CONTEXT" : "NOT_ROOT_ADMIN",
          );
        const product = await sql<{
          id: string;
          name: string;
        }>`select id, name_vi as name from product where id = ${input.productId} limit 1`.execute(
          dbHandle.db,
        );
        const row = product.rows[0];
        if (!row)
          return {
            text: "Sản phẩm không còn hợp lệ.",
            buttons: [[{ text: "📦 Kho hàng", callbackData: "admin:inventory" }]],
          };
        const variants = await sql<{
          id: string;
          name: string;
          sku: string;
          fulfillment_type:
            | "STOCK_ACCOUNT"
            | "STOCK_CODE"
            | "DIGITAL_FILE"
            | "SUPPLIER_API"
            | "MANUAL_FULFILLMENT"
            | "QUANTITY_STOCK"
            | "UNLIMITED_SERVICE";
          available: number;
          reserved: number;
          delivered: number;
          error: number;
          low_stock_threshold: number | null;
          stock_version: number | null;
          active: boolean;
        }>`
          select v.id, v.name_vi as name, v.sku, v.fulfillment_type, v.is_active as active,
            case
              when v.fulfillment_type = 'QUANTITY_STOCK' then coalesce(q.available_quantity, 0)::int
              when v.fulfillment_type = 'DIGITAL_FILE' then coalesce((select count(*) from variant_file_artifact a where a.variant_id = v.id and a.is_active), 0)::int
              when v.fulfillment_type = 'SUPPLIER_API' then coalesce((select count(*) from supplier_sku ss where ss.variant_id = v.id and ss.is_active), 0)::int
              else coalesce((select count(*) from digital_asset da where da.variant_id = v.id and da.status = 'AVAILABLE'), 0)::int
            end as available,
            coalesce((select count(*) from digital_asset da where da.variant_id = v.id and da.status in ('RESERVED','READY')), 0)::int as reserved,
            coalesce((select count(*) from digital_asset da where da.variant_id = v.id and da.status = 'DELIVERED'), 0)::int as delivered,
            coalesce((select count(*) from digital_asset da where da.variant_id = v.id and da.status in ('FAILED','SUPPLIER_NEEDS_REVIEW','COMPROMISED','REVOKED')), 0)::int as error,
            v.low_stock_threshold,
            case when v.fulfillment_type = 'QUANTITY_STOCK' then q.version::int else null end as stock_version
          from product_variant v
          left join variant_quantity_stock q on q.variant_id = v.id
          where v.product_id = ${input.productId}
          order by v.sort_order asc, v.id asc
          limit 20
        `.execute(dbHandle.db);
        return presentAdminInventoryProduct({
          id: row.id,
          name: row.name,
          variants: variants.rows.map((variant) => ({
            id: variant.id,
            name: variant.name,
            sku: variant.sku,
            active: variant.active,
            fulfillmentType: variant.fulfillment_type,
            available: variant.available,
            reserved: variant.reserved,
            delivered: variant.delivered,
            error: variant.error,
            lowStockThreshold: variant.low_stock_threshold,
            importSupported:
              variant.fulfillment_type === "STOCK_ACCOUNT" ||
              variant.fulfillment_type === "STOCK_CODE",
            fileImportSupported: variant.fulfillment_type === "DIGITAL_FILE",
            supplierSupported: variant.fulfillment_type === "SUPPLIER_API",
            quantityAdjustSupported:
              variant.fulfillment_type === "QUANTITY_STOCK" && variant.stock_version !== null,
          })),
        });
      },
      async inventoryVariant(input) {
        if (input.chatType !== "private") return presentAdminDenied("WRONG_CONTEXT");
        if (!adminCallbacks) return presentAdminDenied("NOT_ROOT_ADMIN");
        const gate = await adminCallbacks.handle({
          command: "order.inspect",
          actor: { numericUserId: Number(input.telegramUserId), chatType: input.chatType },
          targetId: input.variantId,
          reason: "Admin inventory variant access",
          correlationId: input.correlationId,
        });
        if (!gate.ok)
          return presentAdminDenied(
            gate.code === "WRONG_CONTEXT" ? "WRONG_CONTEXT" : "NOT_ROOT_ADMIN",
          );
        const result = await sql<{
          product_id: string;
          id: string;
          name: string;
          sku: string;
          fulfillment_type:
            | "STOCK_ACCOUNT"
            | "STOCK_CODE"
            | "DIGITAL_FILE"
            | "SUPPLIER_API"
            | "MANUAL_FULFILLMENT"
            | "QUANTITY_STOCK"
            | "UNLIMITED_SERVICE";
          inventory_fields: unknown;
          available: number;
          reserved: number;
          delivered: number;
          error: number;
          stock_version: number | null;
          low_stock_threshold: number | null;
          active: boolean;
        }>`
          select v.product_id, v.id, v.name_vi as name, v.sku, v.fulfillment_type, v.inventory_fields, v.is_active as active,
            case
              when v.fulfillment_type = 'QUANTITY_STOCK' then coalesce(q.available_quantity, 0)::int
              when v.fulfillment_type = 'DIGITAL_FILE' then coalesce((select count(*) from variant_file_artifact a where a.variant_id = v.id and a.is_active), 0)::int
              when v.fulfillment_type = 'SUPPLIER_API' then coalesce((select count(*) from supplier_sku ss where ss.variant_id = v.id and ss.is_active), 0)::int
              else coalesce((select count(*) from digital_asset da where da.variant_id = v.id and da.status = 'AVAILABLE'), 0)::int
            end as available,
            coalesce((select count(*) from digital_asset da where da.variant_id = v.id and da.status in ('RESERVED','READY')), 0)::int as reserved,
            coalesce((select count(*) from digital_asset da where da.variant_id = v.id and da.status = 'DELIVERED'), 0)::int as delivered,
            coalesce((select count(*) from digital_asset da where da.variant_id = v.id and da.status in ('FAILED','SUPPLIER_NEEDS_REVIEW','COMPROMISED','REVOKED')), 0)::int as error,
            case when v.fulfillment_type = 'QUANTITY_STOCK' then q.version::int else null end as stock_version,
            v.low_stock_threshold
          from product_variant v
          left join variant_quantity_stock q on q.variant_id = v.id
          where v.id = ${input.variantId}
          limit 1
        `.execute(dbHandle.db);
        const variant = result.rows[0];
        if (!variant)
          return {
            text: "Biến thể không còn hợp lệ.",
            buttons: [[{ text: "📦 Kho hàng", callbackData: "admin:inventory" }]],
          };
        return presentAdminInventoryVariant({
          productId: variant.product_id,
          id: variant.id,
          name: variant.name,
          sku: variant.sku,
          active: variant.active,
          fulfillmentType: variant.fulfillment_type,
          available: variant.available,
          reserved: variant.reserved,
          delivered: variant.delivered,
          error: variant.error,
          lowStockThreshold: variant.low_stock_threshold,
          importSupported:
            variant.fulfillment_type === "STOCK_ACCOUNT" ||
            variant.fulfillment_type === "STOCK_CODE",
          fileImportSupported: variant.fulfillment_type === "DIGITAL_FILE",
          supplierSupported: variant.fulfillment_type === "SUPPLIER_API",
          announceSupported:
            variant.available > 0 &&
            (variant.fulfillment_type === "STOCK_ACCOUNT" ||
              variant.fulfillment_type === "STOCK_CODE" ||
              variant.fulfillment_type === "QUANTITY_STOCK"),
          ...(variant.stock_version === null ? {} : { stockVersion: variant.stock_version }),
          inventoryFields: Array.isArray(variant.inventory_fields)
            ? (variant.inventory_fields as [])
            : [],
        });
      },
      async stockAnnouncementPreview(input) {
        if (input.chatType !== "private") return presentAdminDenied("WRONG_CONTEXT");
        if (!adminCallbacks) return presentAdminDenied("NOT_ROOT_ADMIN");
        const gate = await adminCallbacks.handle({
          command: "order.inspect",
          actor: { numericUserId: Number(input.telegramUserId), chatType: input.chatType },
          targetId: input.variantId,
          reason: "Admin stock announcement preview",
          correlationId: input.correlationId,
        });
        if (!gate.ok)
          return presentAdminDenied(
            gate.code === "WRONG_CONTEXT" ? "WRONG_CONTEXT" : "NOT_ROOT_ADMIN",
          );
        const preview = await previewStockAnnouncementBroadcast(dbHandle.db, {
          variantId: input.variantId,
          createdBy: String(input.telegramUserId),
          correlationId: input.correlationId,
        });
        return preview
          ? presentAdminBroadcastPreview(preview)
          : {
              text: "Biến thể không còn hợp lệ để thông báo.",
              buttons: [[{ text: "📦 Kho hàng", callbackData: "admin:inventory" }]],
            };
      },
      async inventoryHistory(input) {
        if (input.chatType !== "private") return presentAdminDenied("WRONG_CONTEXT");
        if (!adminCallbacks) return presentAdminDenied("NOT_ROOT_ADMIN");
        const gate = await adminCallbacks.handle({
          command: "order.inspect",
          actor: { numericUserId: Number(input.telegramUserId), chatType: input.chatType },
          targetId: input.variantId,
          reason: "Admin inventory history access",
          correlationId: input.correlationId,
        });
        if (!gate.ok)
          return presentAdminDenied(
            gate.code === "WRONG_CONTEXT" ? "WRONG_CONTEXT" : "NOT_ROOT_ADMIN",
          );
        const history = await listVariantInventoryHistory({
          db: dbHandle.db,
          actor: { numericUserId: Number(input.telegramUserId), chatType: input.chatType },
          config: {
            adminTelegramUserId: config.ADMIN_TELEGRAM_USER_ID,
            expectedUsername: config.ADMIN_EXPECTED_USERNAME,
          },
          variantId: input.variantId,
          correlationId: input.correlationId,
        });
        if (!history.ok)
          return history.code === "NOT_FOUND"
            ? {
                text: "Biến thể không còn hợp lệ.",
                buttons: [[{ text: "📦 Kho hàng", callbackData: "admin:inventory" }]],
              }
            : presentAdminDenied(history.code);
        return presentAdminInventoryHistory({
          productId: history.productId,
          variantId: history.variantId,
          variantName: history.variantName,
          rows: history.rows,
        });
      },
      async testLab(input) {
        if (input.chatType !== "private") return presentAdminDenied("WRONG_CONTEXT");
        if (!adminCallbacks) return presentAdminDenied("NOT_ROOT_ADMIN");
        const testProducts = await sql<{ id: string; name_vi: string; is_active: boolean }>`
          select id, name_vi, is_active from product where is_test = true or is_archived = true order by sort_order asc
        `.execute(dbHandle.db);
        const canaryOrders = await sql<{ order_number: string; status: string; price_vnd: string }>`
          select order_number, status, price_vnd::text from "order" where order_number like '%CANARY%' or order_number in ('ORD-20260908-NJVSQW4T', 'ORD-20260908-16QVJNC6') order by created_at desc limit 5
        `.execute(dbHandle.db);
        return presentAdminTestLab({
          testProducts: testProducts.rows.map((p) => ({
            id: p.id,
            name: p.name_vi,
            active: p.is_active,
          })),
          canaryOrders: canaryOrders.rows.map((o) => ({
            orderNumber: o.order_number,
            status: o.status,
            priceVnd: Number(o.price_vnd),
          })),
        });
      },
      async testCustomers(input) {
        if (input.chatType !== "private") return presentAdminDenied("WRONG_CONTEXT");
        if (Number(input.telegramUserId) !== config.ADMIN_TELEGRAM_USER_ID)
          return presentAdminDenied("NOT_ROOT_ADMIN");
        const customers = await listTestCustomers(dbHandle.db);
        return presentAdminTestCustomers({
          customers: customers.map((c) => ({ id: c.id, telegramUserId: c.telegramUserId })),
        });
      },
      async testCustomerAddPrompt(input) {
        if (input.chatType !== "private") return presentAdminDenied("WRONG_CONTEXT");
        if (Number(input.telegramUserId) !== config.ADMIN_TELEGRAM_USER_ID)
          return presentAdminDenied("NOT_ROOT_ADMIN");
        await createAdminCallbackState(dbHandle.db, {
          adminTelegramUserId: input.telegramUserId,
          kind: "TEST_CUSTOMER_ADD",
          payload: {},
        });
        return presentAdminTestCustomerPrompt();
      },
      async testCustomerDelete(input) {
        if (input.chatType !== "private") return presentAdminDenied("WRONG_CONTEXT");
        if (Number(input.telegramUserId) !== config.ADMIN_TELEGRAM_USER_ID)
          return presentAdminDenied("NOT_ROOT_ADMIN");
        const row = await sql<{ telegram_user_id: string }>`
          delete from test_customer_allowlist where id = ${input.ref} returning telegram_user_id
        `.execute(dbHandle.db);
        const removed = row.rows[0]?.telegram_user_id;
        if (removed)
          await appendAuditEvent(dbHandle.db, {
            actorType: "ROOT_ADMIN",
            actorId: input.telegramUserId,
            action: "test_customer.remove",
            targetType: "TestCustomer",
            targetId: removed,
            reason: "Xoá khách test khỏi allowlist",
            correlationId: input.correlationId,
          });
        const customers = await listTestCustomers(dbHandle.db);
        return presentAdminTestCustomers({
          customers: customers.map((c) => ({ id: c.id, telegramUserId: c.telegramUserId })),
        });
      },
      async testCustomerText(input) {
        if (input.chatType !== "private") return null;
        const state = await sql<{ id: string }>`
          select id from admin_callback_state
          where admin_telegram_user_id = ${input.telegramUserId}
            and kind = 'TEST_CUSTOMER_ADD' and expires_at > now()
          order by created_at desc limit 1
        `.execute(dbHandle.db);
        if (!state.rows[0]) return null;
        const telegramId = input.text.trim();
        if (!/^\d{5,15}$/u.test(telegramId))
          return {
            text: "Telegram ID không hợp lệ. Chỉ gồm chữ số (vd: 123456789).",
            buttons: [[{ text: "⬅️ Quay lại", callbackData: "admin:testlab:testers" }]],
          };
        await addTestCustomer(dbHandle.db, telegramId, input.telegramUserId);
        await sql`delete from admin_callback_state where id = ${state.rows[0].id}`.execute(
          dbHandle.db,
        );
        await appendAuditEvent(dbHandle.db, {
          actorType: "ROOT_ADMIN",
          actorId: input.telegramUserId,
          action: "test_customer.add",
          targetType: "TestCustomer",
          targetId: telegramId,
          reason: "Thêm khách test vào allowlist",
          correlationId: input.correlationId,
        });
        const customers = await listTestCustomers(dbHandle.db);
        return presentAdminTestCustomers({
          customers: customers.map((c) => ({ id: c.id, telegramUserId: c.telegramUserId })),
        });
      },
      async categories(input) {
        if (input.chatType !== "private") return presentAdminDenied("WRONG_CONTEXT");
        if (Number(input.telegramUserId) !== config.ADMIN_TELEGRAM_USER_ID)
          return presentAdminDenied("NOT_ROOT_ADMIN");
        await ensureDefaultCategories(dbHandle.db);
        const rows = await listCategoriesWithCounts(dbHandle.db);
        return presentAdminCategories({
          categories: rows.map((c) => ({
            id: c.id,
            nameVi: c.name_vi,
            active: c.is_active,
            productCount: c.product_count,
            parentId: c.parent_id ?? null,
          })),
        });
      },
      async categoryCreatePrompt(input) {
        if (input.chatType !== "private") return presentAdminDenied("WRONG_CONTEXT");
        if (Number(input.telegramUserId) !== config.ADMIN_TELEGRAM_USER_ID)
          return presentAdminDenied("NOT_ROOT_ADMIN");
        await createAdminCallbackState(dbHandle.db, {
          adminTelegramUserId: input.telegramUserId,
          kind: "CATEGORY_CREATE",
          payload: {},
        });
        return presentAdminCategoryPrompt();
      },
      async categoryAction(input) {
        if (input.chatType !== "private") return presentAdminDenied("WRONG_CONTEXT");
        if (Number(input.telegramUserId) !== config.ADMIN_TELEGRAM_USER_ID)
          return presentAdminDenied("NOT_ROOT_ADMIN");
        const renderList = async () => {
          const rows = await listCategoriesWithCounts(dbHandle.db);
          return presentAdminCategories({
            categories: rows.map((c) => ({
              id: c.id,
              nameVi: c.name_vi,
              active: c.is_active,
              productCount: c.product_count,
            })),
          });
        };
        if (input.action === "rename") {
          await createAdminCallbackState(dbHandle.db, {
            adminTelegramUserId: input.telegramUserId,
            kind: "CATEGORY_RENAME",
            payload: { categoryId: input.ref },
          });
          return {
            text: "Nhập tên mới cho danh mục.",
            buttons: [[{ text: "⬅️ Quay lại", callbackData: "admin:categories" }]],
          };
        }
        if (input.action === "toggle") {
          const cur = await sql<{ is_active: boolean }>`
            select is_active from category where id = ${input.ref} limit 1
          `.execute(dbHandle.db);
          if (cur.rows[0]) await setCategoryActive(dbHandle.db, input.ref, !cur.rows[0].is_active);
          catalogCache.invalidate();
          return renderList();
        }
        if (input.action === "up" || input.action === "down") {
          await reorderCategory(dbHandle.db, input.ref, input.action);
          catalogCache.invalidate();
          return renderList();
        }
        return renderList();
      },
      async categoryText(input) {
        if (input.chatType !== "private") return null;
        const state = await sql<{
          id: string;
          kind: string;
          payload_redacted: Record<string, unknown>;
        }>`
          select id, kind, payload_redacted from admin_callback_state
          where admin_telegram_user_id = ${input.telegramUserId}
            and kind in ('CATEGORY_CREATE', 'CATEGORY_RENAME') and expires_at > now()
          order by created_at desc limit 1
        `.execute(dbHandle.db);
        const row = state.rows[0];
        if (!row) return null;
        const name = input.text.trim().slice(0, 80);
        if (!name)
          return {
            text: "Tên danh mục không hợp lệ.",
            buttons: [[{ text: "⬅️ Quay lại", callbackData: "admin:categories" }]],
          };
        if (row.kind === "CATEGORY_CREATE") {
          await createCategory(dbHandle.db, { nameVi: name });
          catalogCache.invalidate();
          await appendAuditEvent(dbHandle.db, {
            actorType: "ROOT_ADMIN",
            actorId: input.telegramUserId,
            action: "category.create",
            targetType: "Category",
            targetId: name,
            reason: "Tạo danh mục từ admin UI",
            correlationId: input.correlationId,
          });
        } else {
          const categoryId = row.payload_redacted.categoryId;
          if (typeof categoryId !== "string") return null;
          await renameCategory(dbHandle.db, categoryId, name);
          catalogCache.invalidate();
          await appendAuditEvent(dbHandle.db, {
            actorType: "ROOT_ADMIN",
            actorId: input.telegramUserId,
            action: "category.rename",
            targetType: "Category",
            targetId: categoryId,
            reason: `Đổi tên danh mục thành: ${name}`,
            correlationId: input.correlationId,
          });
        }
        await sql`delete from admin_callback_state where id = ${row.id}`.execute(dbHandle.db);
        const rows = await listCategoriesWithCounts(dbHandle.db);
        return presentAdminCategories({
          categories: rows.map((c) => ({
            id: c.id,
            nameVi: c.name_vi,
            active: c.is_active,
            productCount: c.product_count,
            parentId: c.parent_id ?? null,
          })),
        });
      },
      async preorders(input, route) {
        if (input.chatType !== "private") return presentAdminDenied("WRONG_CONTEXT");
        if (!adminCallbacks) return presentAdminDenied("NOT_ROOT_ADMIN");
        if (route?.startsWith("preorders:cancel:")) {
          const preorderId = route.slice("preorders:cancel:".length);
          if (isId(preorderId)) {
            await shopCancelPreorder(dbHandle.db, {
              preorderId,
              actorTelegramUserId: input.telegramUserId,
              reason: "Shop không thể cung cấp sản phẩm này.",
              correlationId: input.correlationId,
            });
          }
          route = "preorders:filter:refund_due";
        }
        const filter = route ? route.replace(/^preorders(:filter:)?/u, "") || "all" : "all";
        let whereClause = sql`true`;
        if (filter === "waiting_deposit") whereClause = sql`pr.status = 'WAITING_DEPOSIT'`;
        else if (filter === "deposit_paid") whereClause = sql`pr.status = 'DEPOSIT_PAID'`;
        else if (filter === "allocated") whereClause = sql`pr.status = 'ALLOCATED'`;
        else if (filter === "balance_due") whereClause = sql`pr.status = 'BALANCE_DUE'`;
        else if (filter === "fulfilled")
          whereClause = sql`pr.status in ('FULLY_PAID', 'FULFILLED')`;
        else if (filter === "forfeited")
          whereClause = sql`pr.status in ('DEPOSIT_FORFEITED', 'HOLD_EXPIRED')`;
        else if (filter === "refund_due")
          whereClause = sql`pr.status in ('REFUND_DUE', 'SHOP_CANCELLED')`;

        const list = await sql<{
          id: string;
          variant_id: string;
          product_name: string;
          variant_name: string;
          status: string;
          deposit_amount_vnd: string;
          balance_amount_vnd: string;
          customer_id: string;
          hold_until: Date | string | null;
        }>`
          select
            pr.id, pr.variant_id, p.name_vi as product_name, v.name_vi as variant_name,
            pr.status, pr.deposit_amount_vnd::text, pr.balance_amount_vnd::text,
            pr.customer_id,
            pr.hold_until
          from preorder_reservation pr
          join product_variant v on v.id = pr.variant_id
          join product p on p.id = v.product_id
          join customer c on c.id = pr.customer_id
          where ${whereClause}
          order by pr.created_at desc
          limit 15
        `.execute(dbHandle.db);

        return presentAdminPreorders({
          items: list.rows.map((r) => ({
            id: r.id,
            variantId: r.variant_id,
            productName: r.product_name,
            variantName: r.variant_name,
            status: r.status,
            depositVnd: Number(r.deposit_amount_vnd),
            balanceVnd: Number(r.balance_amount_vnd),
            customerName: generateCustomerAlias(r.customer_id),
            holdUntil: r.hold_until,
          })),
          filter,
        });
      },
      async inventoryAdd(input) {
        if (input.chatType !== "private") return presentAdminDenied("WRONG_CONTEXT");
        if (!adminCallbacks) return presentAdminDenied("NOT_ROOT_ADMIN");
        const prods = await sql<{ id: string; name_vi: string }>`
          select id, name_vi from product where is_archived = false and is_active = true order by sort_order asc
        `.execute(dbHandle.db);
        return presentAdminInventoryProductPicker(
          prods.rows.map((p) => ({ id: p.id, name: p.name_vi })),
          "import",
        );
      },
      async inventoryTemplateSelect(input) {
        if (input.chatType !== "private") return presentAdminDenied("WRONG_CONTEXT");
        if (!adminCallbacks) return presentAdminDenied("NOT_ROOT_ADMIN");
        const prods = await sql<{ id: string; name_vi: string }>`
          select id, name_vi from product where is_archived = false and is_active = true order by sort_order asc
        `.execute(dbHandle.db);
        return presentAdminInventoryProductPicker(
          prods.rows.map((p) => ({ id: p.id, name: p.name_vi })),
          "template",
        );
      },
      async inventoryPasteSelect(input) {
        if (input.chatType !== "private") return presentAdminDenied("WRONG_CONTEXT");
        if (!adminCallbacks) return presentAdminDenied("NOT_ROOT_ADMIN");
        const prods = await sql<{ id: string; name_vi: string }>`
          select id, name_vi from product where is_archived = false and is_active = true order by sort_order asc
        `.execute(dbHandle.db);
        return presentAdminInventoryProductPicker(
          prods.rows.map((p) => ({ id: p.id, name: p.name_vi })),
          "paste",
        );
      },
      async inventoryPickProduct(input, route) {
        if (input.chatType !== "private") return presentAdminDenied("WRONG_CONTEXT");
        if (!adminCallbacks) return presentAdminDenied("NOT_ROOT_ADMIN");
        const parts = route.split(":");
        const offset = parts[0] === "admin" ? 1 : 0;
        const rawAction = parts[offset + 2];
        if (rawAction !== "import" && rawAction !== "template" && rawAction !== "paste") {
          return {
            text: "Yêu cầu không hợp lệ.",
            buttons: [[{ text: "Quay lại Kho", callbackData: "admin:inventory" }]],
          };
        }
        const action = rawAction;
        const productId = parts[offset + 3] ?? "";
        if (!productId) {
          return {
            text: "Sản phẩm không tồn tại.",
            buttons: [[{ text: "Quay lại Kho", callbackData: "admin:inventory" }]],
          };
        }
        const prod = await sql<{ id: string; name_vi: string }>`
          select id, name_vi from product where id = ${productId} limit 1
        `.execute(dbHandle.db);
        if (!prod.rows[0])
          return {
            text: "Sản phẩm không tồn tại.",
            buttons: [[{ text: "Quay lại Kho", callbackData: "admin:inventory" }]],
          };
        const vars = await sql<{
          id: string;
          name_vi: string;
          sku: string;
          fulfillment_type: FulfillmentType;
          available: number;
        }>`
          select v.id, v.name_vi, v.sku, v.fulfillment_type,
            coalesce((select count(*)::int from digital_asset da where da.variant_id = v.id and da.status = 'AVAILABLE'), 0)::int as available
          from product_variant v
          where v.product_id = ${productId} and v.is_active = true
          order by v.sort_order asc
        `.execute(dbHandle.db);
        return presentAdminInventoryVariantPicker(
          { id: prod.rows[0].id, name: prod.rows[0].name_vi },
          vars.rows.map((v) => ({
            id: v.id,
            name: v.name_vi,
            sku: v.sku,
            fulfillmentType: v.fulfillment_type,
            available: v.available,
          })),
          action,
        );
      },
      async quantityAdjustPreview(input) {
        if (input.chatType !== "private") return presentAdminDenied("WRONG_CONTEXT");
        if (!adminCallbacks) return presentAdminDenied("NOT_ROOT_ADMIN");
        const gate = await adminCallbacks.handle({
          command: "order.inspect",
          actor: { numericUserId: Number(input.telegramUserId), chatType: input.chatType },
          targetId: input.variantId,
          reason: "Admin quantity stock adjustment preview",
          correlationId: input.correlationId,
        });
        if (!gate.ok)
          return presentAdminDenied(
            gate.code === "WRONG_CONTEXT" ? "WRONG_CONTEXT" : "NOT_ROOT_ADMIN",
          );
        const result = await sql<{
          product_id: string;
          name: string;
          sku: string;
          available: number;
          version: number;
        }>`
          select v.product_id, v.name_vi as name, v.sku, q.available_quantity::int as available, q.version::int as version
          from product_variant v
          join variant_quantity_stock q on q.variant_id = v.id
          where v.id = ${input.variantId} and v.fulfillment_type = 'QUANTITY_STOCK' and v.is_active
          limit 1
        `.execute(dbHandle.db);
        const row = result.rows[0];
        if (!row)
          return {
            text: "Biến thể tồn kho số lượng không còn hợp lệ.",
            buttons: [[{ text: "📦 Kho hàng", callbackData: "admin:inventory" }]],
          };
        if (row.version !== input.expectedStockVersion)
          return {
            text: "Tồn kho đã thay đổi, mở lại biến thể để điều chỉnh.",
            buttons: [
              [{ text: "📦 Kho hàng", callbackData: `admin:inventory:variant:${input.variantId}` }],
            ],
          };
        const nextAvailable = row.available + input.delta;
        if (nextAvailable < 0)
          return {
            text: "Không thể điều chỉnh tồn kho xuống số âm.",
            buttons: [
              [{ text: "📦 Kho hàng", callbackData: `admin:inventory:variant:${input.variantId}` }],
            ],
          };
        await createAdminCallbackState(dbHandle.db, {
          adminTelegramUserId: input.telegramUserId,
          kind: "QUANTITY_STOCK_ADJUST_CONFIRM",
          payload: {
            variantId: input.variantId,
            variantName: row.name,
            sku: row.sku,
            available: row.available,
            delta: input.delta,
            expectedStockVersion: input.expectedStockVersion,
            idempotencyKey: `quantity-adjust:${input.variantId}:${input.expectedStockVersion}:${input.delta}`,
            nextAvailable,
          },
        });
        return presentQuantityStockAdjustReasonPrompt({
          variantName: row.name,
          delta: input.delta,
          nextAvailable,
        });
      },
      async quantityAdjustConfirm(input) {
        if (input.chatType !== "private") return presentAdminDenied("WRONG_CONTEXT");
        const state = await resolveAdminCallbackState(dbHandle.db, {
          adminTelegramUserId: input.telegramUserId,
          stateId: input.stateId,
        });
        if (state?.kind !== "QUANTITY_STOCK_ADJUST_CONFIRM")
          return {
            text: "Phiên điều chỉnh tồn kho đã hết hạn.",
            buttons: [[{ text: "📦 Kho hàng", callbackData: "admin:inventory" }]],
          };
        const { variantId, delta, expectedStockVersion, idempotencyKey, reason } = state.payload;
        if (
          typeof variantId !== "string" ||
          typeof delta !== "number" ||
          typeof expectedStockVersion !== "number" ||
          typeof idempotencyKey !== "string" ||
          typeof reason !== "string"
        )
          return {
            text: "Phiên điều chỉnh tồn kho không hợp lệ.",
            buttons: [[{ text: "📦 Kho hàng", callbackData: "admin:inventory" }]],
          };
        const adjusted = await adjustQuantityStock({
          db: dbHandle.db,
          actor: { numericUserId: Number(input.telegramUserId), chatType: input.chatType },
          config: {
            adminTelegramUserId: config.ADMIN_TELEGRAM_USER_ID,
            expectedUsername: config.ADMIN_EXPECTED_USERNAME,
          },
          variantId,
          delta,
          expectedStockVersion,
          idempotencyKey,
          reason,
          correlationId: input.correlationId,
        });
        return adjusted.ok
          ? presentQuantityStockAdjustDone(adjusted)
          : {
              text:
                adjusted.code === "NEGATIVE_STOCK"
                  ? "Không thể điều chỉnh tồn kho xuống số âm."
                  : "Không thể điều chỉnh tồn kho. Mở lại biến thể để thử lại.",
              buttons: [
                [{ text: "📦 Kho hàng", callbackData: `admin:inventory:variant:${variantId}` }],
              ],
            };
      },
      async quantityAdjustText(input) {
        if (input.chatType !== "private") return null;
        const state = await sql<{ id: string; payload_redacted: Record<string, unknown> }>`
          select id, payload_redacted
          from admin_callback_state
          where admin_telegram_user_id = ${input.telegramUserId}
            and kind = 'QUANTITY_STOCK_ADJUST_CONFIRM'
            and expires_at > now()
          order by created_at desc
          limit 1
        `.execute(dbHandle.db);
        const payload = state.rows[0]?.payload_redacted;
        if (!payload) return null;
        const {
          variantId,
          variantName,
          sku,
          available,
          delta,
          expectedStockVersion,
          idempotencyKey,
          nextAvailable,
        } = payload;
        if (
          typeof variantId !== "string" ||
          typeof variantName !== "string" ||
          typeof sku !== "string" ||
          typeof available !== "number" ||
          typeof delta !== "number" ||
          typeof expectedStockVersion !== "number" ||
          typeof idempotencyKey !== "string" ||
          typeof nextAvailable !== "number"
        )
          return null;
        const reason = input.text.trim().slice(0, 200);
        if (!reason)
          return {
            text: "Lý do điều chỉnh không hợp lệ.",
            buttons: [
              [{ text: "📦 Kho hàng", callbackData: `admin:inventory:variant:${variantId}` }],
            ],
          };
        await sql`
          update admin_callback_state
          set payload_redacted = ${JSON.stringify({ ...payload, reason })}::jsonb
          where id = ${state.rows[0]!.id}
        `.execute(dbHandle.db);
        return presentQuantityStockAdjustPreview({
          stateId: state.rows[0]!.id,
          variantName,
          sku,
          delta,
          available,
          nextAvailable,
          expectedStockVersion,
        });
      },
      async importPreview(input) {
        if (input.chatType !== "private") return presentAdminDenied("WRONG_CONTEXT");
        if (!adminCallbacks) return presentAdminDenied("NOT_ROOT_ADMIN");
        if (!input.variantId) {
          return {
            text: "Chọn biến thể tài khoản/mã kho trước khi nhập kho.",
            buttons: [[{ text: "📦 Kho hàng", callbackData: "admin:inventory" }]],
          };
        }
        const variant = await sql<{
          id: string;
          name: string;
          sku: string;
          fulfillment_type: string;
          inventory_fields: unknown;
        }>`
          select id, name_vi as name, sku, fulfillment_type, inventory_fields
          from product_variant
          where id = ${input.variantId}
          limit 1
        `.execute(dbHandle.db);
        const row = variant.rows[0];
        if (
          !row ||
          (row.fulfillment_type !== "STOCK_ACCOUNT" &&
            row.fulfillment_type !== "STOCK_CODE" &&
            row.fulfillment_type !== "DIGITAL_FILE")
        ) {
          return {
            text: "Biến thể này không hỗ trợ nhập kho theo phiên.",
            buttons: [[{ text: "📦 Kho hàng", callbackData: "admin:inventory" }]],
          };
        }
        const gate = await adminCallbacks.handle({
          command: "order.inspect",
          actor: { numericUserId: Number(input.telegramUserId), chatType: "private" },
          targetId: row.id,
          reason: "Admin inventory import preview",
          correlationId: input.correlationId,
        });
        if (!gate.ok) {
          return presentAdminDenied(
            gate.code === "WRONG_CONTEXT" ? "WRONG_CONTEXT" : "NOT_ROOT_ADMIN",
          );
        }
        if (row.fulfillment_type === "DIGITAL_FILE") {
          const session = await startFileArtifactImportSession(dbHandle.db, {
            actor: { numericUserId: Number(input.telegramUserId), chatType: "private" },
            config: {
              adminTelegramUserId: config.ADMIN_TELEGRAM_USER_ID,
              expectedUsername: config.ADMIN_EXPECTED_USERNAME,
            },
            correlationId: input.correlationId,
            variantId: row.id,
          });
          if (!session.ok) {
            return {
              text: "Không thể bắt đầu nhập tệp.",
              buttons: [[{ text: "📦 Kho hàng", callbackData: "admin:inventory" }]],
            };
          }
          return presentInventoryImportPrompt({
            variantId: row.id,
            variantName: row.name,
            sku: row.sku,
            kind: "file",
          });
        }
        const session = await startInventoryImportSession(dbHandle.db, {
          actor: { numericUserId: Number(input.telegramUserId), chatType: "private" },
          config: {
            adminTelegramUserId: config.ADMIN_TELEGRAM_USER_ID,
            expectedUsername: config.ADMIN_EXPECTED_USERNAME,
          },
          correlationId: input.correlationId,
          variantId: row.id,
        });
        if (!session.ok)
          return presentAdminDenied(
            session.code === "WRONG_CONTEXT" ? "WRONG_CONTEXT" : "NOT_ROOT_ADMIN",
          );
        return presentInventoryImportPrompt({
          variantId: row.id,
          variantName: row.name,
          sku: row.sku,
          fulfillmentType: row.fulfillment_type === "STOCK_CODE" ? "STOCK_CODE" : "STOCK_ACCOUNT",
          inventoryFields: Array.isArray(row.inventory_fields) ? (row.inventory_fields as []) : [],
        });
      },
      async importTemplate(input) {
        if (!adminCallbacks) return null;
        const result = await createInventoryImportTemplate(dbHandle.db, {
          actor: { numericUserId: Number(input.telegramUserId), chatType: "private" },
          config: {
            adminTelegramUserId: config.ADMIN_TELEGRAM_USER_ID,
            expectedUsername: config.ADMIN_EXPECTED_USERNAME,
          },
          correlationId: input.correlationId,
          variantId: input.variantId,
        });
        if (!result.ok) {
          if (result.code === "NOT_ROOT_ADMIN" || result.code === "WRONG_CONTEXT")
            return presentAdminDenied(result.code);
          return null;
        }
        return presentInventoryImportTemplate({
          variantName: result.template.variantName,
          sku: result.template.sku,
          filename: `${result.template.variantId}-inventory-template.csv`,
          csv: result.template.csv,
          requiredFields: result.template.requiredFields,
          optionalFields: result.template.optionalFields,
        });
      },
      async importText(input) {
        if (!adminCallbacks) return null;
        const session = await getInventoryImportSession(dbHandle.db, String(input.telegramUserId));
        if (!session || session.status === "COMMITTED" || session.status === "CANCELLED")
          return null;
        try {
          const result = await stageInventoryImportInput(dbHandle.db, vault, {
            actor: {
              numericUserId: Number(input.telegramUserId),
              chatType: input.chatType as "private",
            },
            config: {
              adminTelegramUserId: config.ADMIN_TELEGRAM_USER_ID,
              expectedUsername: config.ADMIN_EXPECTED_USERNAME,
            },
            correlationId: input.correlationId,
            rawInput: input.text,
          });
          if (!result.ok) {
            if (result.code === "NOT_FOUND" || result.code === "EXPIRED") return null;
            return {
              text: "Dữ liệu nhập kho không hợp lệ. Dán lại nội dung CSV đúng định dạng.",
              buttons: [
                [{ text: "↩️ Huỷ nhập kho", callbackData: "admin:inventory:cancel" }],
                [{ text: "📦 Nhập kho", callbackData: "admin:inventory:import" }],
              ],
            };
          }
          const preview = result.preview;
          return presentInventoryImportPreview({
            ready: preview.ready,
            invalid: preview.invalid,
            duplicates: preview.duplicates,
            variants: preview.lines
              .filter((line) => line.classification === "READY" && line.variantId)
              .map((line) => line.variantId!),
          });
        } catch (error) {
          logger.error(
            {
              err: error instanceof Error ? error.message : "unknown",
              name: error instanceof Error ? error.name : undefined,
              code: error instanceof Error && "code" in error ? error.code : undefined,
            },
            "inventory import text failed",
          );
          return {
            text: "Không lưu được dữ liệu nhập kho. Thử dán lại hoặc gửi file CSV.",
            buttons: [
              [{ text: "↩️ Huỷ nhập kho", callbackData: "admin:inventory:cancel" }],
              [{ text: "📦 Nhập kho", callbackData: "admin:inventory:import" }],
            ],
          };
        }
      },
      async importDocument(input) {
        if (!adminCallbacks) return null;
        const textSession = await getInventoryImportSession(
          dbHandle.db,
          String(input.telegramUserId),
        );
        if (
          textSession &&
          textSession.status !== "COMMITTED" &&
          textSession.status !== "CANCELLED"
        ) {
          const result = await stageInventoryImportDocument(dbHandle.db, vault, {
            actor: { numericUserId: Number(input.telegramUserId), chatType: "private" },
            config: {
              adminTelegramUserId: config.ADMIN_TELEGRAM_USER_ID,
              expectedUsername: config.ADMIN_EXPECTED_USERNAME,
            },
            correlationId: input.correlationId,
            document: input.document,
            downloader: createTelegramTextFileDownloader(config.TELEGRAM_BOT_TOKEN),
          });
          if (!result.ok)
            return {
              text: "Tệp nhập kho không hợp lệ. Chỉ nhận .csv/.txt tối đa 64 KB / 500 dòng và đúng header.",
              buttons: [
                [{ text: "↩️ Huỷ nhập kho", callbackData: "admin:inventory:cancel" }],
                [{ text: "📦 Kho hàng", callbackData: "admin:inventory" }],
              ],
            };
          const preview = result.preview;
          return presentInventoryImportPreview({
            ready: preview.ready,
            invalid: preview.invalid,
            duplicates: preview.duplicates,
            variants: preview.lines
              .filter((line) => line.classification === "READY" && line.variantId)
              .map((line) => line.variantId!),
          });
        }
        const session = await getFileArtifactImportSession(
          dbHandle.db,
          String(input.telegramUserId),
        );
        if (!session || session.status !== "WAITING_DOCUMENT") return null;
        const result = await stageFileArtifactDocument(dbHandle.db, {
          actor: { numericUserId: Number(input.telegramUserId), chatType: "private" },
          config: {
            adminTelegramUserId: config.ADMIN_TELEGRAM_USER_ID,
            expectedUsername: config.ADMIN_EXPECTED_USERNAME,
          },
          sessionId: session.sessionId,
          generation: session.generation,
          document: input.document,
          downloader: createTelegramFileDownloader(config.TELEGRAM_BOT_TOKEN),
          privateArtifactRoot: config.PRIVATE_ARTIFACT_ROOT,
          correlationId: input.correlationId,
        });
        if (!result.ok)
          return {
            text: "Không thể nhập tệp. Hãy gửi tài liệu Telegram hợp lệ tối đa 20 MB.",
            buttons: [
              [{ text: "↩️ Huỷ nhập kho", callbackData: "admin:inventory:cancel" }],
              [{ text: "📦 Kho hàng", callbackData: "admin:inventory" }],
            ],
          };
        const stateId = await createAdminCallbackState(dbHandle.db, {
          adminTelegramUserId: input.telegramUserId,
          kind: "FILE_ARTIFACT_IMPORT_CONFIRM",
          payload: {
            sessionId: result.session.sessionId,
            generation: result.session.generation,
            artifactId: result.artifact.id,
          },
        });
        return presentFileArtifactImportPreview({
          stateId,
          filename: result.artifact.filename,
          sizeBytes: result.artifact.sizeBytes,
          sha256: result.artifact.sha256,
        });
      },
      async importFileConfirm(input) {
        if (!adminCallbacks) return presentAdminDenied("NOT_ROOT_ADMIN");
        const state = await resolveAdminCallbackState(dbHandle.db, {
          adminTelegramUserId: input.telegramUserId,
          stateId: input.stateId,
        });
        const payload = state?.payload;
        const sessionId =
          state?.kind === "FILE_ARTIFACT_IMPORT_CONFIRM" && typeof payload?.sessionId === "string"
            ? payload.sessionId
            : null;
        const generation = typeof payload?.generation === "number" ? payload.generation : null;
        const artifactId = typeof payload?.artifactId === "string" ? payload.artifactId : null;
        if (!sessionId || generation === null || !artifactId)
          return {
            text: "Phiên xác nhận tệp đã hết hạn.",
            buttons: [[{ text: "📦 Kho hàng", callbackData: "admin:inventory" }]],
          };
        const result = await confirmFileArtifactImportSession(dbHandle.db, {
          actor: { numericUserId: Number(input.telegramUserId), chatType: "private" },
          config: {
            adminTelegramUserId: config.ADMIN_TELEGRAM_USER_ID,
            expectedUsername: config.ADMIN_EXPECTED_USERNAME,
          },
          sessionId,
          generation,
          artifactId,
          privateArtifactRoot: config.PRIVATE_ARTIFACT_ROOT,
          correlationId: input.correlationId,
        });
        return result.ok
          ? presentFileArtifactImportDone({ filename: result.artifact.filename })
          : {
              text: "Không thể kích hoạt tệp đã nhập.",
              buttons: [[{ text: "📦 Kho hàng", callbackData: "admin:inventory" }]],
            };
      },
      async importConfirm(input) {
        if (input.chatType !== "private") return presentAdminDenied("WRONG_CONTEXT");
        if (!adminCallbacks) return presentAdminDenied("NOT_ROOT_ADMIN");
        const result = await confirmInventoryImportSession(dbHandle.db, vault, {
          actor: { numericUserId: Number(input.telegramUserId), chatType: input.chatType },
          config: {
            adminTelegramUserId: config.ADMIN_TELEGRAM_USER_ID,
            expectedUsername: config.ADMIN_EXPECTED_USERNAME,
          },
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
            buttons: [
              [{ text: "📦 Nhập kho", callbackData: "admin:inventory:import" }],
              [{ text: "🛍 Sản phẩm", callbackData: "admin:products" }],
            ],
          };
        }
        return {
          text: `✅ Nhập kho: ${result.summary.imported} mới, ${result.summary.duplicates} trùng, ${result.summary.invalid} lỗi`,
          buttons: [
            [
              { text: "📦 Kho hàng", callbackData: "admin:inventory" },
              { text: "🛍 Sản phẩm", callbackData: "admin:products" },
            ],
          ],
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
        return gate.ok
          ? presentAdminMarketingMenu()
          : presentAdminDenied(gate.code === "WRONG_CONTEXT" ? "WRONG_CONTEXT" : "NOT_ROOT_ADMIN");
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
        return gate.ok
          ? presentAdminBroadcastAudience()
          : presentAdminDenied(gate.code === "WRONG_CONTEXT" ? "WRONG_CONTEXT" : "NOT_ROOT_ADMIN");
      },
      async broadcastAudience(input) {
        if (
          Number(input.telegramUserId) !== config.ADMIN_TELEGRAM_USER_ID ||
          input.chatType !== "private"
        )
          return presentAdminDenied("NOT_ROOT_ADMIN");
        await sql`delete from notification_campaign where created_by=${String(input.telegramUserId)} and status='DRAFT' and idempotency_key like ${`admin-broadcast:${input.telegramUserId}:%`}`.execute(
          dbHandle.db,
        );
        await createBroadcast(dbHandle.db, {
          class: marketingBroadcastClassForAudience(input.audience),
          content: "DRAFT",
          createdBy: String(input.telegramUserId),
          idempotencyKey: `admin-broadcast:${input.telegramUserId}:${input.correlationId}`,
          audience: input.audience,
        });
        return presentAdminBroadcastPrompt(input.audience);
      },
      async broadcastText(input) {
        if (
          Number(input.telegramUserId) !== config.ADMIN_TELEGRAM_USER_ID ||
          input.chatType !== "private"
        )
          return null;
        const draft = await sql<{
          id: string;
          audience: BroadcastAudience;
        }>`select id,audience from notification_campaign where created_by=${String(input.telegramUserId)} and status='DRAFT' and idempotency_key like ${`admin-broadcast:${input.telegramUserId}:%`} order by created_at desc limit 1`.execute(
          dbHandle.db,
        );
        const row = draft.rows[0];
        if (!row) return null;
        const content = input.text.trim();
        if (!content || content.length > 4096)
          return {
            text: "Nội dung thông báo không hợp lệ.",
            buttons: [[{ text: "Huỷ", callbackData: `admin:marketing:cancel:${row.id}` }]],
          };
        await markBroadcastPreviewed(dbHandle.db, {
          campaignId: row.id,
          createdBy: String(input.telegramUserId),
          content,
        });
        const count = await previewBroadcastAudience(
          dbHandle.db,
          row.audience,
          String(config.ADMIN_TELEGRAM_USER_ID),
        );
        return presentAdminBroadcastPreview({
          campaignId: row.id,
          audience: row.audience,
          count,
          content,
        });
      },
      async broadcastConfirm(input) {
        if (
          Number(input.telegramUserId) !== config.ADMIN_TELEGRAM_USER_ID ||
          input.chatType !== "private"
        )
          return presentAdminDenied("NOT_ROOT_ADMIN");
        await enqueueBroadcastRecipients(
          dbHandle.db,
          input.campaignId,
          String(config.ADMIN_TELEGRAM_USER_ID),
          String(input.telegramUserId),
        );
        const status = await getBroadcastStatus(dbHandle.db, input.campaignId);
        return status
          ? presentAdminBroadcastStatus(status)
          : {
              text: "Không tìm thấy thông báo.",
              buttons: [[{ text: "📣 Tiếp thị", callbackData: "admin:marketing" }]],
            };
      },
      async broadcastCancel(input) {
        if (
          Number(input.telegramUserId) !== config.ADMIN_TELEGRAM_USER_ID ||
          input.chatType !== "private"
        )
          return presentAdminDenied("NOT_ROOT_ADMIN");
        const campaignId =
          input.campaignId ??
          (
            await sql<{
              id: string;
            }>`select id from notification_campaign where created_by=${String(input.telegramUserId)} and status='DRAFT' and idempotency_key like ${`admin-broadcast:${input.telegramUserId}:%`} order by created_at desc limit 1`.execute(
              dbHandle.db,
            )
          ).rows[0]?.id;
        if (campaignId) await cancelBroadcast(dbHandle.db, campaignId);
        return {
          text: "Đã huỷ thông báo.",
          buttons: [[{ text: "📣 Tiếp thị", callbackData: "admin:marketing" }]],
        };
      },
      async broadcastStatus(input) {
        if (
          Number(input.telegramUserId) !== config.ADMIN_TELEGRAM_USER_ID ||
          input.chatType !== "private"
        )
          return presentAdminDenied("NOT_ROOT_ADMIN");
        const status = await getBroadcastStatus(dbHandle.db, input.campaignId);
        return status
          ? presentAdminBroadcastStatus(status)
          : {
              text: "Không tìm thấy thông báo.",
              buttons: [[{ text: "📣 Tiếp thị", callbackData: "admin:marketing" }]],
            };
      },
      async importCancel(input) {
        if (!adminCallbacks) return presentAdminDenied("NOT_ROOT_ADMIN");
        const fileSession = await getFileArtifactImportSession(
          dbHandle.db,
          String(input.telegramUserId),
        );
        if (fileSession) {
          const result = await cancelFileArtifactImportSession(dbHandle.db, {
            actor: { numericUserId: Number(input.telegramUserId), chatType: "private" },
            config: {
              adminTelegramUserId: config.ADMIN_TELEGRAM_USER_ID,
              expectedUsername: config.ADMIN_EXPECTED_USERNAME,
            },
            correlationId: input.correlationId,
          });
          if (!result.ok)
            return presentAdminDenied(
              result.code === "WRONG_CONTEXT" ? "WRONG_CONTEXT" : "NOT_ROOT_ADMIN",
            );
          return {
            text: "Đã huỷ phiên nhập tệp.",
            buttons: [
              [{ text: "📦 Kho hàng", callbackData: "admin:inventory" }],
              [{ text: "🛍 Sản phẩm", callbackData: "admin:products" }],
            ],
          };
        }
        const result = await cancelInventoryImportSession(dbHandle.db, vault, {
          actor: { numericUserId: Number(input.telegramUserId), chatType: "private" },
          config: {
            adminTelegramUserId: config.ADMIN_TELEGRAM_USER_ID,
            expectedUsername: config.ADMIN_EXPECTED_USERNAME,
          },
          correlationId: input.correlationId,
        });
        if (!result.ok)
          return presentAdminDenied(
            result.code === "WRONG_CONTEXT" ? "WRONG_CONTEXT" : "NOT_ROOT_ADMIN",
          );
        return {
          text: "Đã huỷ phiên nhập kho.",
          buttons: [
            [{ text: "📦 Kho hàng", callbackData: "admin:inventory" }],
            [{ text: "🛍 Sản phẩm", callbackData: "admin:products" }],
          ],
        };
      },
      workflow: {
        async start(input) {
          if (
            Number(input.telegramUserId) !== config.ADMIN_TELEGRAM_USER_ID ||
            input.chatType !== "private"
          )
            return presentAdminDenied("NOT_ROOT_ADMIN");
          const existing = await productDraftWorkflow.get(input.telegramUserId);
          if (existing && !existing.existingProductId) {
            return {
              text: `⚠️ Bạn đang có một bản nháp tạo sản phẩm chưa hoàn tất: "${existing.name || "Chưa đặt tên"}".\n\nBạn muốn tiếp tục hay huỷ bản nháp để tạo mới?`,
              buttons: [
                [{ text: "▶️ Tiếp tục tạo sản phẩm", callbackData: "admin:products:back" }],
                [{ text: "🗑 Huỷ bản nháp", callbackData: "admin:products:cancel" }],
              ],
            };
          }
          const draft = await productDraftWorkflow.start(input.telegramUserId);
          return renderWizardStep(draft);
        },
        async messageText(input) {
          if (
            Number(input.telegramUserId) !== config.ADMIN_TELEGRAM_USER_ID ||
            input.chatType !== "private"
          )
            return null;
          if (input.text === "/cancel") return this.cancel(input);
          const variantState = await resolveAdminCallbackState(dbHandle.db, {
            adminTelegramUserId: input.telegramUserId,
            stateId: input.text.split("|")[0]?.trim() ?? "",
          });
          if (variantState?.kind === "ADMIN_VARIANT_UPDATE")
            return this.variantText?.(input) ?? null;

          // Wizard sub-flow text states (category create / custom field / advanced / custom description).
          const subState = await sql<{ id: string; kind: string }>`
            select id, kind from admin_callback_state
            where admin_telegram_user_id = ${input.telegramUserId}
              and kind in ('WIZARD_CATEGORY_CREATE','WIZARD_CUSTOM_FIELD','WIZARD_ADVANCED','WIZARD_DESC_CUSTOM')
              and expires_at > now()
            order by created_at desc limit 1
          `.execute(dbHandle.db);
          const pendingSub = subState.rows[0];
          if (pendingSub) {
            const repo = createProductDraftRepository(dbHandle.db);
            const draft = await productDraftWorkflow.get(input.telegramUserId);
            if (!draft) {
              await sql`delete from admin_callback_state where id = ${pendingSub.id}`.execute(
                dbHandle.db,
              );
              return null;
            }
            const text = input.text.trim();
            if (pendingSub.kind === "WIZARD_CATEGORY_CREATE") {
              const name = text.slice(0, 80);
              if (!name)
                return {
                  text: "Tên danh mục không hợp lệ.",
                  buttons: [[{ text: "❌ Huỷ", callbackData: "admin:products:cancel" }]],
                };
              const created = await createCategory(dbHandle.db, { nameVi: name });
              await appendAuditEvent(dbHandle.db, {
                actorType: "ROOT_ADMIN",
                actorId: input.telegramUserId,
                action: "category.create",
                targetType: "Category",
                targetId: created.id,
                reason: "Tạo danh mục từ wizard tạo sản phẩm",
                correlationId: input.correlationId,
              });
              await sql`delete from admin_callback_state where id = ${pendingSub.id}`.execute(
                dbHandle.db,
              );
              const next = {
                ...draft,
                categoryId: created.id,
                categoryName: created.name_vi,
                step: "productType" as const,
                expiresAt: Date.now() + 15 * 60_000,
              };
              await repo.save(next);
              return renderWizardStep(next);
            }
            if (pendingSub.kind === "WIZARD_CUSTOM_FIELD") {
              const label = text.slice(0, 60);
              if (!label)
                return {
                  text: "Tên trường không hợp lệ.",
                  buttons: [[{ text: "❌ Huỷ", callbackData: "admin:products:cancel" }]],
                };
              await sql`delete from admin_callback_state where id = ${pendingSub.id}`.execute(
                dbHandle.db,
              );
              const next = addCustomField(draft, { label });
              await repo.save(next);
              return renderWizardStep(next);
            }
            if (pendingSub.kind === "WIZARD_ADVANCED") {
              await sql`delete from admin_callback_state where id = ${pendingSub.id}`.execute(
                dbHandle.db,
              );
              const next = applyAdvancedRaw(draft, text);
              await repo.save(next);
              return renderWizardStep(next);
            }
            // WIZARD_DESC_CUSTOM
            const description = text.slice(0, 2000);
            if (!description)
              return {
                text: "Mô tả không được để trống.",
                buttons: [[{ text: "❌ Huỷ", callbackData: "admin:products:cancel" }]],
              };
            await sql`delete from admin_callback_state where id = ${pendingSub.id}`.execute(
              dbHandle.db,
            );
            const next = {
              ...draft,
              description,
              descriptionVi: description,
              step: "variant" as const,
              expiresAt: Date.now() + 15 * 60_000,
            };
            await repo.save(next);
            return renderWizardStep(next);
          }

          const current = await productDraftWorkflow.get(input.telegramUserId);
          if (!current) return null;
          if (current.step === "sku") {
            const rawSku = input.text.trim().toUpperCase();
            const dup = await sql<{
              id: string;
            }>`select id from product_variant where sku = ${rawSku} limit 1`.execute(dbHandle.db);
            if (dup.rows[0]) {
              const proposal = generateSkuProposal(current.name ?? "");
              return {
                text: `❌ SKU "${rawSku}" đã được sử dụng. Hãy nhập SKU khác.\n\nĐề xuất: ${proposal}`,
                buttons: [
                  [
                    {
                      text: `✨ Dùng SKU đề xuất: ${proposal}`,
                      callbackData: `admin:products:apply-sku:${proposal}`,
                    },
                  ],
                  [
                    { text: "⬅️ Quay lại", callbackData: "admin:products:back" },
                    { text: "❌ Huỷ", callbackData: "admin:products:cancel" },
                  ],
                ],
              };
            }
          }

          const result = await productDraftWorkflow.advance(input.telegramUserId, input.text);
          if (!result.ok) {
            let errorMsg = "Dữ liệu không hợp lệ, vui lòng thử lại.";
            if (result.error === "INVALID_VARIANT") {
              errorMsg = "Định dạng chưa đúng. Nhập: Tên biến thể | Giá\nVí dụ: 1 tháng | 250000";
            } else if (result.error === "INVALID_SKU") {
              errorMsg =
                "SKU không hợp lệ. SKU chỉ gồm chữ, số, dấu - hoặc _ (không chứa khoảng trắng).";
            } else if (result.error === "INVALID_QUANTITY") {
              errorMsg = "Số lượng không hợp lệ. Vui lòng nhập số nguyên dương.";
            } else if (result.error === "INVALID_SUPPLIER_CONFIG") {
              errorMsg =
                "Cấu hình nhà cung cấp chưa đúng. Định dạng: supplierId | externalSku | costVnd | region";
            } else if (result.error === "INVALID_INVENTORY_FIELDS") {
              errorMsg = "Cấu trúc kho chưa hợp lệ. Hãy kiểm tra lại các trường đã chọn.";
            } else if (result.error === "DRAFT_EXPIRED") {
              errorMsg = "Phiên tạo sản phẩm đã hết hạn. Hãy bắt đầu lại.";
            } else if (result.error === "INVALID_VALUE") {
              errorMsg = "Dữ liệu không được để trống hoặc vượt quá độ dài cho phép.";
            }
            return {
              text: `⚠️ ${errorMsg}`,
              buttons: [
                [
                  { text: "⬅️ Quay lại", callbackData: "admin:products:back" },
                  { text: "❌ Huỷ", callbackData: "admin:products:cancel" },
                ],
              ],
            };
          }
          return renderWizardStep(result.draft);
        },
        async applySku(input) {
          if (
            Number(input.telegramUserId) !== config.ADMIN_TELEGRAM_USER_ID ||
            input.chatType !== "private"
          )
            return presentAdminDenied("NOT_ROOT_ADMIN");
          const current = await productDraftWorkflow.get(input.telegramUserId);
          if (!current || current.step !== "sku")
            return {
              text: "Phiên tạo sản phẩm không ở bước SKU.",
              buttons: [[{ text: "🛍 Sản phẩm", callbackData: "admin:products" }]],
            };
          const rawSku = input.sku.trim().toUpperCase();
          const dup = await sql<{
            id: string;
          }>`select id from product_variant where sku = ${rawSku} limit 1`.execute(dbHandle.db);
          if (dup.rows[0]) {
            return {
              text: `❌ SKU "${rawSku}" đã được sử dụng. Hãy nhập SKU khác.`,
              buttons: [
                [
                  { text: "⬅️ Quay lại", callbackData: "admin:products:back" },
                  { text: "❌ Huỷ", callbackData: "admin:products:cancel" },
                ],
              ],
            };
          }
          const result = await productDraftWorkflow.advance(input.telegramUserId, rawSku);
          if (!result.ok) {
            return {
              text: "Không thể áp dụng SKU này. Vui lòng nhập thủ công.",
              buttons: [[{ text: "❌ Huỷ", callbackData: "admin:products:cancel" }]],
            };
          }
          return renderWizardStep(result.draft);
        },
        async back(input) {
          if (
            Number(input.telegramUserId) !== config.ADMIN_TELEGRAM_USER_ID ||
            input.chatType !== "private"
          )
            return presentAdminDenied("NOT_ROOT_ADMIN");
          const current = await productDraftWorkflow.get(input.telegramUserId);
          if (!current) return presentAdminMenu(await getStoreMode(dbHandle.db));
          const prev = previousStep(current);
          const repo = createProductDraftRepository(dbHandle.db);
          await repo.save(prev);
          return renderWizardStep(prev);
        },
        async variantText(input) {
          if (
            Number(input.telegramUserId) !== config.ADMIN_TELEGRAM_USER_ID ||
            input.chatType !== "private"
          )
            return null;
          const parts = input.text.split("|").map((part) => part.trim());
          const state = await resolveAdminCallbackState(dbHandle.db, {
            adminTelegramUserId: input.telegramUserId,
            stateId: parts[0] ?? "",
          });
          if (!state || state.kind !== "ADMIN_VARIANT_UPDATE") return null;
          const productId =
            typeof state.payload.productId === "string" ? state.payload.productId : null;
          const variantId =
            typeof state.payload.variantId === "string" ? state.payload.variantId : null;
          if (!productId || !variantId)
            return {
              text: "Phiên biến thể đã hết hạn.",
              buttons: [[{ text: "🛍 Sản phẩm", callbackData: "admin:products" }]],
            };
          const expectedVersion =
            typeof state.payload.expectedVersion === "number"
              ? state.payload.expectedVersion
              : null;
          const [, name, price, durationCode, warranty, threshold] = parts;
          if (!expectedVersion)
            return {
              text: "Phiên sửa biến thể đã hết hạn.",
              buttons: [
                [{ text: "🛍 Sản phẩm", callbackData: `admin:products:detail:${productId}` }],
              ],
            };
          if (price && !/^\d+$/.test(price))
            return {
              text: "Giá biến thể không hợp lệ.",
              buttons: [
                [{ text: "🛍 Sản phẩm", callbackData: `admin:products:detail:${productId}` }],
              ],
            };
          if (warranty && !/^\d+$/.test(warranty))
            return {
              text: "Bảo hành không hợp lệ.",
              buttons: [
                [{ text: "🛍 Sản phẩm", callbackData: `admin:products:detail:${productId}` }],
              ],
            };
          if (threshold && threshold !== "-" && !/^\d+$/.test(threshold))
            return {
              text: "Ngưỡng tồn không hợp lệ.",
              buttons: [
                [{ text: "🛍 Sản phẩm", callbackData: `admin:products:detail:${productId}` }],
              ],
            };
          const ok = await updateAdminVariant({
            actor: { numericUserId: Number(input.telegramUserId), chatType: "private" },
            config: {
              adminTelegramUserId: config.ADMIN_TELEGRAM_USER_ID,
              expectedUsername: config.ADMIN_EXPECTED_USERNAME,
            },
            db: dbHandle.db,
            productId,
            variantId,
            expectedVersion,
            ...(name ? { name } : {}),
            ...(price ? { priceVnd: BigInt(price) } : {}),
            ...(durationCode ? { durationCode } : {}),
            ...(warranty ? { warrantyDays: Number(warranty) } : {}),
            ...(threshold === undefined || threshold === ""
              ? {}
              : { lowStockThreshold: threshold === "-" ? null : Number(threshold) }),
            reason: "Admin variant update",
            correlationId: input.correlationId,
          });
          return ok
            ? presentAdminVariantMutationDone({
                productId,
                variantName: name || variantId,
                action: "updated",
              })
            : {
                text: "Biến thể đã thay đổi, mở lại để sửa.",
                buttons: [
                  [{ text: "🛍 Sản phẩm", callbackData: `admin:products:detail:${productId}` }],
                ],
              };
        },
        async category(input) {
          if (
            Number(input.telegramUserId) !== config.ADMIN_TELEGRAM_USER_ID ||
            input.chatType !== "private"
          )
            return presentAdminDenied("NOT_ROOT_ADMIN");
          const current = await productDraftWorkflow.get(input.telegramUserId);
          if (!current || current.step !== "category")
            return {
              text: "Phiên tạo sản phẩm không còn ở bước chọn danh mục.",
              buttons: [[{ text: "🛍 Sản phẩm", callbackData: "admin:products" }]],
            };
          if (!input.categoryId) return renderWizardStep(current);
          const found = await sql<{ id: string; name_vi: string }>`
            select id, name_vi from category where id = ${input.categoryId} and is_active limit 1
          `.execute(dbHandle.db);
          const row = found.rows[0];
          if (!row)
            return {
              text: "Danh mục không hợp lệ hoặc đã bị tắt.",
              buttons: [[{ text: "⬅️ Quay lại", callbackData: "admin:products:back" }]],
            };
          const result = await productDraftWorkflow.advance(input.telegramUserId, row.id);
          if (!result.ok) return { text: "Không thể chọn danh mục.", buttons: [] };
          const repo = createProductDraftRepository(dbHandle.db);
          const named = { ...result.draft, categoryName: row.name_vi };
          await repo.save(named);
          return renderWizardStep(named);
        },
        async categoryNew(input) {
          if (
            Number(input.telegramUserId) !== config.ADMIN_TELEGRAM_USER_ID ||
            input.chatType !== "private"
          )
            return presentAdminDenied("NOT_ROOT_ADMIN");
          const current = await productDraftWorkflow.get(input.telegramUserId);
          if (!current || current.step !== "category")
            return {
              text: "Phiên tạo sản phẩm không còn ở bước chọn danh mục.",
              buttons: [[{ text: "🛍 Sản phẩm", callbackData: "admin:products" }]],
            };
          await createAdminCallbackState(dbHandle.db, {
            adminTelegramUserId: input.telegramUserId,
            kind: "WIZARD_CATEGORY_CREATE",
            payload: {},
          });
          return presentWizardCategoryCreatePrompt();
        },
        async categoryNone(input) {
          if (
            Number(input.telegramUserId) !== config.ADMIN_TELEGRAM_USER_ID ||
            input.chatType !== "private"
          )
            return presentAdminDenied("NOT_ROOT_ADMIN");
          const current = await productDraftWorkflow.get(input.telegramUserId);
          if (!current || current.step !== "category")
            return {
              text: "Phiên tạo sản phẩm không còn ở bước chọn danh mục.",
              buttons: [[{ text: "🛍 Sản phẩm", callbackData: "admin:products" }]],
            };
          const uncategorized = await getOrCreateUncategorizedCategory(dbHandle.db);
          const result = await productDraftWorkflow.advance(input.telegramUserId, uncategorized.id);
          if (!result.ok) return { text: "Không thể chọn danh mục.", buttons: [] };
          const repo = createProductDraftRepository(dbHandle.db);
          const named = { ...result.draft, categoryName: uncategorized.name_vi };
          await repo.save(named);
          return renderWizardStep(named);
        },
        async fulfillmentType(input) {
          if (
            Number(input.telegramUserId) !== config.ADMIN_TELEGRAM_USER_ID ||
            input.chatType !== "private"
          )
            return presentAdminDenied("NOT_ROOT_ADMIN");
          const current = await productDraftWorkflow.get(input.telegramUserId);
          if (!current || current.step !== "productType")
            return {
              text: "Phiên tạo sản phẩm không còn ở bước chọn loại.",
              buttons: [[{ text: "🛍 Sản phẩm", callbackData: "admin:products" }]],
            };
          const result = await productDraftWorkflow.advance(
            input.telegramUserId,
            input.fulfillmentType,
          );
          if (!result.ok)
            return {
              text: "Loại sản phẩm không hợp lệ.",
              buttons: [
                [
                  { text: "⬅️ Quay lại", callbackData: "admin:products:back" },
                  { text: "❌ Huỷ", callbackData: "admin:products:cancel" },
                ],
              ],
            };
          return renderWizardStep(result.draft);
        },
        async descriptionTemplate(input) {
          if (
            Number(input.telegramUserId) !== config.ADMIN_TELEGRAM_USER_ID ||
            input.chatType !== "private"
          )
            return presentAdminDenied("NOT_ROOT_ADMIN");
          const current = await productDraftWorkflow.get(input.telegramUserId);
          if (!current || current.step !== "description" || !current.fulfillmentType)
            return {
              text: "Phiên tạo sản phẩm không còn ở bước mô tả.",
              buttons: [[{ text: "🛍 Sản phẩm", callbackData: "admin:products" }]],
            };
          const template = DESCRIPTION_TEMPLATES[current.fulfillmentType];
          const repo = createProductDraftRepository(dbHandle.db);
          const next = {
            ...current,
            description: template.description,
            descriptionVi: template.description,
            whatCustomerReceivesVi: template.whatCustomerReceives,
            usageInstructionsVi: template.usageInstructions,
            warrantyVi: template.warranty,
            step: "variant" as const,
            expiresAt: Date.now() + 15 * 60_000,
          };
          await repo.save(next);
          return renderWizardStep(next);
        },
        async descriptionCustom(input) {
          if (
            Number(input.telegramUserId) !== config.ADMIN_TELEGRAM_USER_ID ||
            input.chatType !== "private"
          )
            return presentAdminDenied("NOT_ROOT_ADMIN");
          const current = await productDraftWorkflow.get(input.telegramUserId);
          if (!current || current.step !== "description")
            return {
              text: "Phiên tạo sản phẩm không còn ở bước mô tả.",
              buttons: [[{ text: "🛍 Sản phẩm", callbackData: "admin:products" }]],
            };
          await createAdminCallbackState(dbHandle.db, {
            adminTelegramUserId: input.telegramUserId,
            kind: "WIZARD_DESC_CUSTOM",
            payload: {},
          });
          return presentWizardDescriptionCustomPrompt();
        },
        async deliveryToggle(input) {
          if (
            Number(input.telegramUserId) !== config.ADMIN_TELEGRAM_USER_ID ||
            input.chatType !== "private"
          )
            return presentAdminDenied("NOT_ROOT_ADMIN");
          const current = await productDraftWorkflow.get(input.telegramUserId);
          if (!current || current.step !== "deliveryConfig")
            return {
              text: "Phiên tạo sản phẩm không còn ở bước cấu hình giao hàng.",
              buttons: [[{ text: "🛍 Sản phẩm", callbackData: "admin:products" }]],
            };
          const repo = createProductDraftRepository(dbHandle.db);
          const next = toggleOptionalField(current, input.fieldName);
          await repo.save(next);
          return renderWizardStep(next);
        },
        async deliveryFlags(input) {
          if (
            Number(input.telegramUserId) !== config.ADMIN_TELEGRAM_USER_ID ||
            input.chatType !== "private"
          )
            return presentAdminDenied("NOT_ROOT_ADMIN");
          const current = await productDraftWorkflow.get(input.telegramUserId);
          const field = (current?.inventoryFields ?? []).find((f) => f.name === input.fieldName);
          if (!current || !field)
            return {
              text: "Trường tùy chỉnh không còn tồn tại.",
              buttons: [[{ text: "⬅️ Quay lại", callbackData: "admin:products:dc:back" }]],
            };
          return presentWizardCustomFieldFlags(field.name, field.label, {
            required: field.required,
            secret: field.secret,
            customerVisible: field.customerVisible,
          });
        },
        async deliveryFlag(input) {
          if (
            Number(input.telegramUserId) !== config.ADMIN_TELEGRAM_USER_ID ||
            input.chatType !== "private"
          )
            return presentAdminDenied("NOT_ROOT_ADMIN");
          const current = await productDraftWorkflow.get(input.telegramUserId);
          const field = (current?.inventoryFields ?? []).find((f) => f.name === input.fieldName);
          if (!current || !field)
            return {
              text: "Trường tùy chỉnh không còn tồn tại.",
              buttons: [[{ text: "⬅️ Quay lại", callbackData: "admin:products:dc:back" }]],
            };
          const key = input.flagKey;
          if (key !== "required" && key !== "secret" && key !== "customerVisible")
            return presentWizardCustomFieldFlags(field.name, field.label, {
              required: field.required,
              secret: field.secret,
              customerVisible: field.customerVisible,
            });
          const repo = createProductDraftRepository(dbHandle.db);
          const next = setCustomFieldFlags(current, field.name, { [key]: !field[key] });
          await repo.save(next);
          const updated = (next.inventoryFields ?? []).find((f) => f.name === field.name)!;
          return presentWizardCustomFieldFlags(updated.name, updated.label, {
            required: updated.required,
            secret: updated.secret,
            customerVisible: updated.customerVisible,
          });
        },
        async deliveryRemove(input) {
          if (
            Number(input.telegramUserId) !== config.ADMIN_TELEGRAM_USER_ID ||
            input.chatType !== "private"
          )
            return presentAdminDenied("NOT_ROOT_ADMIN");
          const current = await productDraftWorkflow.get(input.telegramUserId);
          if (!current)
            return {
              text: "Phiên tạo sản phẩm đã hết hạn.",
              buttons: [[{ text: "🛍 Sản phẩm", callbackData: "admin:products" }]],
            };
          const repo = createProductDraftRepository(dbHandle.db);
          const next = removeCustomField(current, input.fieldName);
          await repo.save(next);
          return renderWizardStep(next);
        },
        async deliveryCustom(input) {
          if (
            Number(input.telegramUserId) !== config.ADMIN_TELEGRAM_USER_ID ||
            input.chatType !== "private"
          )
            return presentAdminDenied("NOT_ROOT_ADMIN");
          const current = await productDraftWorkflow.get(input.telegramUserId);
          if (!current || current.step !== "deliveryConfig")
            return {
              text: "Phiên tạo sản phẩm không còn ở bước cấu hình giao hàng.",
              buttons: [[{ text: "🛍 Sản phẩm", callbackData: "admin:products" }]],
            };
          await createAdminCallbackState(dbHandle.db, {
            adminTelegramUserId: input.telegramUserId,
            kind: "WIZARD_CUSTOM_FIELD",
            payload: {},
          });
          return presentWizardCustomFieldPrompt();
        },
        async deliveryAdvanced(input) {
          if (
            Number(input.telegramUserId) !== config.ADMIN_TELEGRAM_USER_ID ||
            input.chatType !== "private"
          )
            return presentAdminDenied("NOT_ROOT_ADMIN");
          const current = await productDraftWorkflow.get(input.telegramUserId);
          if (!current || current.step !== "deliveryConfig")
            return {
              text: "Phiên tạo sản phẩm không còn ở bước cấu hình giao hàng.",
              buttons: [[{ text: "🛍 Sản phẩm", callbackData: "admin:products" }]],
            };
          await createAdminCallbackState(dbHandle.db, {
            adminTelegramUserId: input.telegramUserId,
            kind: "WIZARD_ADVANCED",
            payload: {},
          });
          return presentWizardAdvancedPrompt();
        },
        async deliveryDone(input) {
          if (
            Number(input.telegramUserId) !== config.ADMIN_TELEGRAM_USER_ID ||
            input.chatType !== "private"
          )
            return presentAdminDenied("NOT_ROOT_ADMIN");
          const current = await productDraftWorkflow.get(input.telegramUserId);
          if (!current || current.step !== "deliveryConfig")
            return {
              text: "Phiên tạo sản phẩm không còn ở bước cấu hình giao hàng.",
              buttons: [[{ text: "🛍 Sản phẩm", callbackData: "admin:products" }]],
            };
          const result = await productDraftWorkflow.advance(input.telegramUserId, "done");
          if (!result.ok)
            return {
              text: "Cấu trúc kho chưa hợp lệ. Hãy kiểm tra lại các trường đã chọn.",
              buttons: [[{ text: "⬅️ Quay lại", callbackData: "admin:products:dc:back" }]],
            };
          return renderWizardStep(result.draft);
        },
        async deliveryBack(input) {
          if (
            Number(input.telegramUserId) !== config.ADMIN_TELEGRAM_USER_ID ||
            input.chatType !== "private"
          )
            return presentAdminDenied("NOT_ROOT_ADMIN");
          const current = await productDraftWorkflow.get(input.telegramUserId);
          if (!current)
            return {
              text: "Phiên tạo sản phẩm đã hết hạn.",
              buttons: [[{ text: "🛍 Sản phẩm", callbackData: "admin:products" }]],
            };
          return renderWizardStep({ ...current, step: "deliveryConfig" });
        },
        async visibilityAction(input: {
          telegramUserId: string;
          chatType: string;
          correlationId: string;
          action: string;
        }) {
          if (
            Number(input.telegramUserId) !== config.ADMIN_TELEGRAM_USER_ID ||
            input.chatType !== "private"
          )
            return presentAdminDenied("NOT_ROOT_ADMIN");
          const draft = await productDraftWorkflow.get(input.telegramUserId);
          if (!draft || (draft.step !== "visibilityFlags" && draft.step !== "deliveryConfig"))
            return {
              text: "Phiên tạo sản phẩm không còn ở bước cài đặt hiển thị.",
              buttons: [[{ text: "🛍 Sản phẩm", callbackData: "admin:products" }]],
            };
          const repo = createProductDraftRepository(dbHandle.db);
          const storeMode = await getStoreMode(dbHandle.db);

          if (input.action === "done") {
            let visibility = draft.visibility ?? "TEST_ONLY";
            if (visibility === "PUBLIC" && storeMode !== "OPEN") {
              visibility = "TEST_ONLY";
              draft.visibility = "TEST_ONLY";
            }
            const result = await productDraftWorkflow.advance(
              input.telegramUserId,
              JSON.stringify({
                visibility,
                isFeatured: draft.isFeatured ?? false,
                preorderEnabled: draft.preorderEnabled ?? false,
                lowStockThreshold: draft.lowStockThreshold ?? 3,
              }),
            );
            if (!result.ok) return renderWizardStep(draft);
            return renderWizardStep(result.draft);
          }
          if (input.action === "test") {
            draft.visibility = "TEST_ONLY";
          } else if (input.action === "draft") {
            draft.visibility = "DRAFT";
          } else if (input.action === "public") {
            if (storeMode !== "OPEN") {
              return {
                text: "⚠️ Cửa hàng đang ở chế độ ĐÓNG hoặc TEST.\nChỉ có thể tạo sản phẩm 'Chỉ test' hoặc 'Bản nháp'.",
                buttons: [
                  [{ text: "🧪 Đặt Chỉ test", callbackData: "admin:products:vis:test" }],
                  [{ text: "📝 Đặt Bản nháp", callbackData: "admin:products:vis:draft" }],
                  [{ text: "⬅️ Quay lại", callbackData: "admin:products:dc:done" }],
                ],
              };
            }
            draft.visibility = "PUBLIC";
          } else if (input.action === "toggle_featured") {
            draft.isFeatured = draft.isFeatured ? false : true;
          } else if (input.action === "toggle_preorder") {
            draft.preorderEnabled = draft.preorderEnabled ? false : true;
          }
          await repo.save(draft);
          return renderWizardStep(draft);
        },
        async review(input) {
          if (
            Number(input.telegramUserId) !== config.ADMIN_TELEGRAM_USER_ID ||
            input.chatType !== "private"
          )
            return presentAdminDenied("NOT_ROOT_ADMIN");
          const draft = await productDraftWorkflow.get(input.telegramUserId);
          if (draft?.step !== "confirm")
            return {
              text: "Chưa có nháp sản phẩm sẵn sàng xác nhận.",
              buttons: [[{ text: "🛍 Sản phẩm", callbackData: "admin:products" }]],
            };
          return renderWizardStep(draft);
        },
        async confirm(input) {
          if (
            Number(input.telegramUserId) !== config.ADMIN_TELEGRAM_USER_ID ||
            input.chatType !== "private"
          )
            return presentAdminDenied("NOT_ROOT_ADMIN");
          const draft = await productDraftWorkflow.get(input.telegramUserId);
          if (
            !draft ||
            draft.step !== "confirm" ||
            !draft.sku ||
            !draft.variantName ||
            draft.priceVnd === undefined ||
            !draft.fulfillmentType ||
            !draft.inventoryFields ||
            (!draft.existingProductId && (!draft.name || !draft.slug || !draft.categoryId))
          )
            return {
              text: "Phiên tạo sản phẩm đã hết hạn hoặc chưa đủ dữ liệu.",
              buttons: [[{ text: "🛍 Sản phẩm", callbackData: "admin:products" }]],
            };
          try {
            const product = draft.existingProductId
              ? await createAdminVariant({
                  actor: { numericUserId: Number(input.telegramUserId), chatType: "private" },
                  config: {
                    adminTelegramUserId: config.ADMIN_TELEGRAM_USER_ID,
                    expectedUsername: config.ADMIN_EXPECTED_USERNAME,
                  },
                  db: dbHandle.db,
                  productId: draft.existingProductId,
                  variantId: newId(),
                  sku: draft.sku,
                  name: draft.variantName,
                  fulfillmentType: draft.fulfillmentType,
                  inventoryFields: draft.inventoryFields,
                  lowStockThreshold: draft.lowStockThreshold ?? null,
                  ...(draft.serviceInstructions === undefined
                    ? {}
                    : { serviceInstructions: draft.serviceInstructions }),
                  ...(draft.initialQuantity === undefined
                    ? {}
                    : { initialQuantity: draft.initialQuantity }),
                  ...(draft.fileArtifact === undefined ? {} : { fileArtifact: draft.fileArtifact }),
                  ...(draft.supplierConfig === undefined
                    ? {}
                    : { supplierConfig: draft.supplierConfig }),
                  active: draft.fulfillmentType === "DIGITAL_FILE" ? false : true,
                  priceVnd: draft.priceVnd,
                  reason: "Admin variant creation",
                  correlationId: input.correlationId,
                } as Parameters<typeof createAdminVariant>[0])
              : await createAdminProduct({
                  actor: { numericUserId: Number(input.telegramUserId), chatType: "private" },
                  config: {
                    adminTelegramUserId: config.ADMIN_TELEGRAM_USER_ID,
                    expectedUsername: config.ADMIN_EXPECTED_USERNAME,
                  },
                  db: dbHandle.db,
                  categoryId: draft.categoryId!,
                  name: draft.name!,
                  slug: draft.slug!,
                  sku: draft.sku,
                  variantName: draft.variantName,
                  fulfillmentType: draft.fulfillmentType,
                  inventoryFields: draft.inventoryFields,
                  ...(draft.description === undefined ? {} : { description: draft.description }),
                  ...(draft.descriptionVi === undefined
                    ? {}
                    : { descriptionVi: draft.descriptionVi }),
                  ...(draft.whatCustomerReceivesVi === undefined
                    ? {}
                    : { whatCustomerReceivesVi: draft.whatCustomerReceivesVi }),
                  ...(draft.usageInstructionsVi === undefined
                    ? {}
                    : { usageInstructionsVi: draft.usageInstructionsVi }),
                  ...(draft.deliveryEtaVi === undefined
                    ? {}
                    : { deliveryEtaVi: draft.deliveryEtaVi }),
                  ...(draft.warrantyVi === undefined ? {} : { warrantyVi: draft.warrantyVi }),
                  ...(draft.supportVi === undefined ? {} : { supportVi: draft.supportVi }),
                  ...(draft.termsVi === undefined ? {} : { termsVi: draft.termsVi }),
                  ...(draft.tags === undefined ? {} : { tags: draft.tags }),
                  ...(draft.compareAtPriceVnd === undefined
                    ? {}
                    : { compareAtPriceVnd: draft.compareAtPriceVnd }),
                  ...(draft.serviceInstructions === undefined
                    ? {}
                    : { serviceInstructions: draft.serviceInstructions }),
                  ...(draft.initialQuantity === undefined
                    ? {}
                    : { initialQuantity: draft.initialQuantity }),
                  ...(draft.fileArtifact === undefined ? {} : { fileArtifact: draft.fileArtifact }),
                  ...(draft.supplierConfig === undefined
                    ? {}
                    : { supplierConfig: draft.supplierConfig }),
                  isTest: draft.visibility === "TEST_ONLY",
                  active:
                    input.active ??
                    (draft.visibility === "DRAFT" || draft.fulfillmentType === "DIGITAL_FILE"
                      ? false
                      : draft.visibility === "PUBLIC"
                        ? (await getStoreMode(dbHandle.db)) === "OPEN"
                        : true),
                  isFeatured: draft.isFeatured ?? false,
                  preorderEnabled: draft.preorderEnabled ?? false,
                  lowStockThreshold: draft.lowStockThreshold ?? null,
                  priceVnd: draft.priceVnd,
                  reason: "Admin product creation",
                  correlationId: input.correlationId,
                } as Parameters<typeof createAdminProduct>[0]);
            await productDraftWorkflow.cancel(input.telegramUserId);
            const stockBacked =
              product.fulfillmentType === "STOCK_ACCOUNT" ||
              product.fulfillmentType === "STOCK_CODE" ||
              product.fulfillmentType === "QUANTITY_STOCK";
            const primaryButton =
              product.fulfillmentType === "DIGITAL_FILE"
                ? {
                    text: "📎 Nhập tệp để kích hoạt",
                    callbackData: `admin:inventory:variant:${product.variantId}`,
                  }
                : stockBacked
                  ? {
                      text: "📦 Nhập kho ngay",
                      callbackData: `admin:inventory:variant:${product.variantId}`,
                    }
                  : {
                      text: "👁 Xem như khách",
                      callbackData: `shop:product:${product.id}`,
                    };
            return {
              text: `✅ ĐÃ TẠO SẢN PHẨM\n\n${product.name}\nBiến thể: ${draft.variantName}\nSKU: ${product.sku}\nGiá: ${product.priceVnd.toLocaleString("vi-VN")} ₫\nTrạng thái: ${product.active ? "Đang mở bán" : "Nháp / Chưa mở bán"}`,
              buttons: [
                [
                  primaryButton,
                  { text: "✏️ Chỉnh sửa", callbackData: `admin:products:detail:${product.id}` },
                ],
                stockBacked
                  ? [
                      { text: "👁 Xem như khách", callbackData: `shop:product:${product.id}` },
                      { text: "➕ Tạo sản phẩm khác", callbackData: "admin:products:create" },
                    ]
                  : [
                      { text: "➕ Tạo sản phẩm khác", callbackData: "admin:products:create" },
                      { text: "🏠 Quản trị", callbackData: "admin:menu" },
                    ],
                ...(stockBacked ? [[{ text: "🏠 Quản trị", callbackData: "admin:menu" }]] : []),
              ],
            };
          } catch (error) {
            if (error instanceof Error && /23505|CONFLICT|conflict/i.test(error.message))
              return {
                text: "SKU này vừa được tạo bởi thao tác khác. Vui lòng chọn SKU khác.",
                buttons: [[{ text: "🛍 Sản phẩm", callbackData: "admin:products" }]],
              };
            throw error;
          }
        },
        async cancel(input) {
          if (
            Number(input.telegramUserId) !== config.ADMIN_TELEGRAM_USER_ID ||
            input.chatType !== "private"
          )
            return presentAdminDenied("NOT_ROOT_ADMIN");
          await productDraftWorkflow.cancel(input.telegramUserId);
          const fileSession = await getFileArtifactImportSession(
            dbHandle.db,
            String(input.telegramUserId),
          );
          if (fileSession) {
            await cancelFileArtifactImportSession(dbHandle.db, {
              actor: { numericUserId: Number(input.telegramUserId), chatType: "private" },
              config: {
                adminTelegramUserId: config.ADMIN_TELEGRAM_USER_ID,
                expectedUsername: config.ADMIN_EXPECTED_USERNAME,
              },
              correlationId: input.correlationId,
            });
          }
          const inventoryCancel = await cancelInventoryImportSession(dbHandle.db, vault, {
            actor: { numericUserId: Number(input.telegramUserId), chatType: "private" },
            config: {
              adminTelegramUserId: config.ADMIN_TELEGRAM_USER_ID,
              expectedUsername: config.ADMIN_EXPECTED_USERNAME,
            },
            correlationId: input.correlationId,
          });
          if (!inventoryCancel.ok && inventoryCancel.code !== "NOT_FOUND") {
            return presentAdminDenied(
              inventoryCancel.code === "WRONG_CONTEXT" ? "WRONG_CONTEXT" : "NOT_ROOT_ADMIN",
            );
          }
          return {
            text: "Đã huỷ thao tác.",
            buttons: [
              [{ text: "📦 Kho hàng", callbackData: "admin:inventory" }],
              [{ text: "🛍 Sản phẩm", callbackData: "admin:products" }],
            ],
          };
        },
      },
      async communityMenu(_input) {
        if (!adminCallbacks) return presentAdminDenied("NOT_ROOT_ADMIN");
        const settings = await getGroupCommerceSettings(dbHandle.db);
        let membershipStatus: "NOT_MEMBER" | "MEMBER" | "ADMIN" = "MEMBER";
        let canPin = false;
        let canManageTopics = false;
        if (telegramResponder.getChatMember) {
          try {
            const member = (await telegramResponder.getChatMember(
              settings.group_chat_id,
              BOT_USER_ID,
            )) as {
              status?: string;
              can_pin_messages?: boolean;
              can_manage_topics?: boolean;
            } | null;
            if (member?.status === "administrator" || member?.status === "creator") {
              membershipStatus = "ADMIN";
              canPin = Boolean(member.can_pin_messages);
              canManageTopics = Boolean(member.can_manage_topics);
            } else if (member?.status === "member") {
              membershipStatus = "MEMBER";
            } else {
              membershipStatus = "NOT_MEMBER";
            }
          } catch {
            membershipStatus = "NOT_MEMBER";
          }
        }
        return presentGroupAdminPanel({
          chatTitle: "AI Codex Việt Nam",
          membershipStatus,
          canPin,
          canManageTopics,
          shopPanelEnabled: settings.shop_panel_enabled,
          welcomeEnabled: settings.welcome_enabled,
          replyMode: settings.group_reply_mode,
          restockEnabled: settings.restock_publishing_enabled,
          socialProofMode: settings.social_proof_mode,
        });
      },
      async communityAction(input) {
        if (!adminCallbacks) return presentAdminDenied("NOT_ROOT_ADMIN");
        const settings = await getGroupCommerceSettings(dbHandle.db);
        if (input.action === "refresh_pin") {
          const panel = presentGroupShopPanel({
            botUsername: BOT_USERNAME,
          });
          if (settings.shop_panel_message_id && telegramResponder.send) {
            try {
              await telegramResponder.send({
                chatId: settings.group_chat_id,
                messageId: settings.shop_panel_message_id,
                message: panel,
              });
            } catch {
              // fall through to send new
            }
          } else if (telegramResponder.send) {
            await telegramResponder.send({
              chatId: settings.group_chat_id,
              messageId: null,
              message: panel,
            });
          }
          return {
            text: "✅ Đã làm mới bảng ghim shop trong nhóm cộng đồng.",
            buttons: [[{ text: "↩️ Quay lại Cộng đồng", callbackData: "admin:community" }]],
          };
        }
        if (input.action === "test_msg") {
          if (telegramResponder.send) {
            await telegramResponder.send({
              chatId: settings.group_chat_id,
              messageId: null,
              message: {
                text: "🧪 *TIER20 GROUP TEST*\n\nĐây là thông báo kiểm thử kết nối bot với nhóm cộng đồng AI Codex Việt Nam.",
                buttons: [
                  [
                    {
                      text: "🛒 Mở Shop",
                      url: `https://t.me/${BOT_USERNAME}?start=shop`,
                      callbackData: "",
                    },
                  ],
                ],
              },
            });
          }
          return {
            text: "✅ Đã gửi bài test vào nhóm cộng đồng.",
            buttons: [[{ text: "↩️ Quay lại Cộng đồng", callbackData: "admin:community" }]],
          };
        }
        if (input.action === "toggle_reply_mode") {
          const next =
            settings.group_reply_mode === "MENTION_ONLY" ? "PASSIVE_COMMERCE" : "MENTION_ONLY";
          await updateGroupCommerceSettings(dbHandle.db, { group_reply_mode: next });
          return this.communityMenu ? await this.communityMenu(input) : presentAdminMenu();
        }
        if (input.action === "stats") {
          const stats = await sql<{ count: number; action: string }>`
            select action, count(*)::int as count
            from group_acquisition_log
            group by action
          `.execute(dbHandle.db);
          const statMap = Object.fromEntries(stats.rows.map((r) => [r.action, r.count]));
          return {
            text: [
              "📊 *THỐNG KÊ CỘNG ĐỒNG*",
              "",
              `• Lượt mở thẻ sản phẩm: ${statMap["CARD_OPEN"] ?? 0}`,
              `• Lượt bấm Mua riêng: ${statMap["BUY_START"] ?? 0}`,
              `• Đơn hàng hoàn tất từ nhóm: ${statMap["CHECKOUT_COMPLETE"] ?? 0}`,
            ].join("\n"),
            buttons: [[{ text: "↩️ Quay lại", callbackData: "admin:community" }]],
          };
        }
        return {
          text: "Thao tác không hỗ trợ.",
          buttons: [[{ text: "Quay lại", callbackData: "admin:community" }]],
        };
      },
    },
    group: {
      async buildInlineResults(query, actorUserId) {
        const isRootOrTester = Number(actorUserId) === config.ADMIN_TELEGRAM_USER_ID;
        return buildInlineQueryResults(dbHandle.db, {
          query,
          botUsername: BOT_USERNAME,
          linkSecret: config.BUY_NOW_CALLBACK_HMAC_KEY,
          isRootOrTester,
        });
      },
      async handleWelcome(envelope) {
        const settings = await getGroupCommerceSettings(dbHandle.db);
        if (!settings.welcome_enabled) return null;
        const now = Date.now();
        if (
          settings.last_welcome_at &&
          now - new Date(settings.last_welcome_at).getTime() <
            settings.welcome_cooldown_seconds * 1000
        ) {
          return null;
        }
        await updateGroupCommerceSettings(dbHandle.db, {
          last_welcome_at: new Date(now),
        });
        const names = (envelope.newChatMembers ?? []).map((m) => m.firstName);
        return presentGroupWelcome({
          memberNames: names.length > 0 ? names : ["bạn"],
          botUsername: BOT_USERNAME,
        });
      },
      async handleShopPanel(_envelope) {
        return presentGroupShopPanel({
          botUsername: BOT_USERNAME,
        });
      },
      async handleHotProducts(_envelope) {
        const prods = await listFeaturedProducts(dbHandle.db, "public", 3);
        if (prods.length === 0) {
          return presentGroupShopPanel({
            botUsername: BOT_USERNAME,
          });
        }
        const prod = prods[0]!;
        const detail = await getProductDetail(dbHandle.db, prod.id, "public");
        const token = issueProductLinkToken(prod.id, { secret: config.BUY_NOW_CALLBACK_HMAC_KEY });
        return presentGroupProductCard({
          name: prod.name_vi,
          shortDescription: prod.short_description_vi,
          priceVnd: Number(prod.min_price_vnd),
          isOutOfStock: prod.total_available <= 0,
          stockLabel: prod.total_available > 0 ? `Còn hàng (${prod.total_available})` : "Hết hàng",
          deliveryTypeLabel: "Tự động 24/7",
          warrantyText: detail?.warranty_vi ?? null,
          productToken: token,
          botUsername: BOT_USERNAME,
        });
      },
      async handleSearchPrompt(_envelope) {
        return presentGroupShopPanel({
          botUsername: BOT_USERNAME,
        });
      },
      async handleNewProducts(_envelope) {
        return presentGroupShopPanel({
          botUsername: BOT_USERNAME,
        });
      },
      async handleStockSummary(_envelope) {
        return presentGroupShopPanel({
          botUsername: BOT_USERNAME,
        });
      },
      async handleSupport(_envelope) {
        return presentGroupPrivacyNotice("general", BOT_USERNAME);
      },
      async handlePrivacyNotice(topic) {
        return presentGroupPrivacyNotice(topic, BOT_USERNAME);
      },
      async handleNaturalQA(envelope) {
        const settings = await getGroupCommerceSettings(dbHandle.db);
        if (
          settings.group_reply_mode !== "MENTION_ONLY" &&
          settings.group_reply_mode !== "PASSIVE_COMMERCE"
        ) {
          return null;
        }
        return parseNaturalSalesQA(dbHandle.db, {
          question: envelope.messageText ?? "",
          botUsername: BOT_USERNAME,
          linkSecret: config.BUY_NOW_CALLBACK_HMAC_KEY,
          ...(envelope.replyToText ? { replyToText: envelope.replyToText } : {}),
        });
      },
    },
    responder: telegramResponder,
  });
  const notificationRate = Number(process.env.NOTIFICATION_RATE_PER_SECOND ?? 20);
  if (!Number.isInteger(notificationRate) || notificationRate < 1 || notificationRate > 25)
    throw new RangeError("NOTIFICATION_RATE_PER_SECOND must be 1..25");
  const notificationLane = async (): Promise<void> => {
    await runNotificationDeliveryLane({
      db: dbHandle.db,
      responder: createSealedNotificationResponder({
        responder: telegramResponder,
        codec: callbackCodec,
        resolveOrderId: async (orderNumber) =>
          (await findOrderByNumber(dbHandle.db, orderNumber))?.id ?? null,
      }),
      ratePerSecond: notificationRate,
      maxAttempts: config.OUTBOX_MAX_ATTEMPTS,
    });
    if (config.DELIVERY_SESSION_HMAC_KEY) {
      await processDeliveryNotificationBatch({
        db: dbHandle.db,
        vault,
        sender: {
          send: async (input) => {
            const lines = [
              "✅ GIAO HÀNG THÀNH CÔNG",
              "",
              input.product?.name ? `📦 ${input.product.name}` : "📦 Đơn hàng của bạn",
              "",
              "Nhấn nút bên dưới để xem thông tin nhận hàng (chỉ hiện một lần, đừng chia sẻ).",
            ];
            if (input.product?.usageInstructionsVi)
              lines.push("", `📘 Hướng dẫn: ${input.product.usageInstructionsVi}`);
            if (input.product?.warrantyVi)
              lines.push("", `🛡 Bảo hành: ${input.product.warrantyVi}`);
            await telegramResponder.send({
              chatId: input.chatId,
              messageId: null,
              message: {
                text: lines.join("\n"),
                buttons: [
                  [
                    {
                      text: "🔐 Nhận hàng ngay",
                      callbackData: `delivery:open:${input.handoffId}`,
                    },
                  ],
                  [{ text: "🧾 Đơn hàng", callbackData: "ord:list" }],
                  [{ text: "💬 Hỗ trợ", callbackData: "sup:open" }],
                ],
              },
            });
          },
        },
        owner: ownerId,
        batchSize: 10,
        maxAttempts: config.OUTBOX_MAX_ATTEMPTS,
        sessionConfig: {
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
        sessionTtlSeconds: config.DELIVERY_SESSION_TTL_SECONDS,
      });
    }
  };
  const ownerId = `worker-${newId().slice(-12)}`;
  const telegramOwnerId = `telegram-${newId().slice(-12)}`;
  const sepayOwnerId = `sepay-${newId().slice(-12)}`;

  let shuttingDown = false;

  const outboxLane = async (): Promise<void> => {
    const result = await drainOutboxOnce(dbHandle.db, {
      batchSize: 20,
      maxAttempts: config.OUTBOX_MAX_ATTEMPTS,
      handler: (event) =>
        event.eventType === "StockDelta"
          ? handleNotificationOutboxEvent(dbHandle.db, event, {
              rootTelegramUserId: config.ADMIN_TELEGRAM_USER_ID,
            })
          : handler(event),
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
        try {
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
        } catch (error) {
          logger.error(
            {
              err: error instanceof Error ? error.message : "unknown",
              name: error instanceof Error ? error.name : undefined,
              code: error instanceof Error && "code" in error ? error.code : undefined,
              action: envelope.action,
              hasInventoryImportText: envelope.inventoryImportText === true,
              hasMessageText: Boolean(envelope.messageText),
            },
            "telegram inbox handler failed",
          );
          throw error;
        }
      },
      owner: telegramOwnerId,
      batchSize: 20,
      maxAttempts: config.OUTBOX_MAX_ATTEMPTS,
    });
    if (result.claimed > 0)
      logger.info({ ...result, ownerId: telegramOwnerId }, "telegram inbox dispatch cycle");
  };
  const sepayLane = async (): Promise<void> => {
    const result = await processSePayInboxBatch({
      inbox: sepayInbox,
      handler: (evidence) => {
        const code = evidence.structuredCode ?? evidence.content ?? evidence.reference;
        const family = classifyPaymentCode(code);
        if (family === "WALLET_TOPUP") {
          return applyWalletTopupEvidence(dbHandle.db, evidence);
        }
        return applyPaymentEvidence(dbHandle.db, evidence);
      },
      owner: sepayOwnerId,
      batchSize: 20,
      maxAttempts: config.OUTBOX_MAX_ATTEMPTS,
    });
    if (result.claimed > 0)
      logger.info({ ...result, ownerId: sepayOwnerId }, "sepay inbox dispatch cycle");
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
      {
        recovery,
        sePayRecoveryConfigured: sePayRecoveryPort !== null,
        supplierRecoveryConfigured: supplier !== null,
      },
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
    lanes: {
      outbox: outboxLane,
      telegram: telegramLane,
      sepay: sepayLane,
      notifications: notificationLane,
      recovery: recoveryLane,
    },
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
