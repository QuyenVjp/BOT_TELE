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
  VARIANT_READY_SQL,
} from "./modules/catalog/repository.js";
import { createCatalogCache } from "./modules/catalog/cache.js";
import { resolveCatalogAudience } from "./modules/catalog/visibility.js";

import { pathToFileURL } from "node:url";
import { getAdminOverview } from "./modules/admin/overview.js";
import {
  updateAdminProductContent,
  ADMIN_PRODUCT_CONTENT_FIELDS,
} from "./modules/catalog/admin-products.js";
import { getAdminHealthFacts } from "./modules/admin/health.js";
import { loadBuildIdentity } from "./shared/build-identity.js";
import { sql } from "kysely";
import { isId, newId } from "./shared/ids/index.js";
import { formatVnd as formatMoneyVnd, makeVnd } from "./shared/money/index.js";
import { sealPresentedMessageCallbacks } from "./bot/callback-sealer.js";
import { createPinnedFetch } from "./infrastructure/net/pinned-fetch.js";
import type { CallbackTokenCodec } from "./bot/callback-codec.js";
import type { Db } from "./infrastructure/db/transaction.js";
import type { FulfillmentType, InventoryField } from "./modules/catalog/fulfillment-type.js";
import type {
  presentAdminOrderDetail,
  presentAdminOrders as presentAdminOrdersPresenter,
} from "./bot/presenters/admin.js";
import type { AdminCallbacks, HandleResult } from "./bot/callbacks/admin.js";
import type { AuthorizationJsonValue } from "./modules/identity/authorization-payload.js";
import type {
  SensitiveActionDeps,
  SensitiveActionKey,
  SensitiveAuthorizationRefusal,
} from "./modules/identity/sensitive-action.js";
import {
  authorizeSensitiveAdminAction,
  isSensitiveActionKey,
  isStepUpActionCategory,
  SENSITIVE_ACTION_POLICY,
  SensitiveAuthorizationRefusedError,
} from "./modules/identity/sensitive-action.js";
import { createStepUpService } from "./modules/identity/step-up.js";
import type { AdminProductView } from "./bot/presenters/admin.js";
import type { PresentedMessage } from "./bot/presenters/catalog.js";
import {
  presentAdminRefundConfirm,
  presentAdminRefundPaidConfirm,
  presentAdminRefundPayout,
  presentAdminRefundQueue,
  presentAdminWarrantyActionDone,
  presentAdminWarrantyClaim,
  presentAdminWarrantyQueue,
  presentAdminRefundAdjustPrompt,
  presentAdminWarrantyRejectReason,
  type AdminClaimView,
  type WarrantyQueueRow,
  type WarrantyQueueView,
} from "./bot/presenters/warranty-admin.js";
import {
  presentWarrantyClaim,
  presentWarrantyClaimSubmitted,
  presentWarrantyExpired,
  presentWarrantyIssueTypes,
  presentWarrantyNotCovered,
  presentWarrantyPolicy,
  presentWarrantyReportPreview,
} from "./bot/presenters/warranty.js";
import {
  approveClaimRefund,
  approveClaimReplacement,
  listClaimTimeline,
  markRefundPaid,
  openWarrantyClaim,
  rejectClaim,
  requestClaimInfo,
  verifyClaimDefect,
  ISSUE_TYPE_LABELS,
  type WarrantyIssueType,
} from "./modules/warranty/claims.js";
import {
  computeProratedRefund,
  isWithinWarranty,
  warrantyEndOf,
} from "./modules/warranty/proration.js";
import type { WalletAccount } from "./modules/wallet/ledger.js";
import type { Vault } from "./infrastructure/vault/port.js";
import type { GoogleSheetsApi } from "./infrastructure/google-sheets/client.js";
import {
  pruneTelegramUsernameData,
  createPostgresTelegramInbox,
} from "./infrastructure/inbox/telegram.js";
import type { SePayReconciliationPort } from "./modules/payments/reconciliation.js";
import type { SupplierPort } from "./modules/supplier/port.js";
import type { RecoveryTelemetry } from "./modules/recovery-result.js";
import type { PreorderStatus } from "./modules/commerce/preorder.js";
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
import { reconcileForPaymentCheck } from "./modules/payments/check-now.js";
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
  confirmBroadcast,
  createBroadcast,
  getBroadcastStatus,
  getNotificationPreferences,
  handleNotificationOutboxEvent,
  markBroadcastPreviewed,
  previewBroadcastAudience,
  previewStockAnnouncementBroadcast,
  processNotificationDeliveryClaim,
  setNotificationPreferences,
  type BroadcastAudience,
  type BroadcastRefusal,
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
import {
  ADMIN_PAYMENT_OPS_VIEWS,
  getAdminDiscrepancyDetail,
  isDiscrepancyResolutionCode,
  listAdminPaymentOps,
} from "./modules/admin/payment-ops.js";
import {
  countAdminPublicationBlockers,
  getProductPublicationReadiness,
  RESALE_EVIDENCE_SOURCES,
  type ResaleEvidenceSource,
} from "./modules/catalog/publication.js";
import {
  getTerminalOutboxOrphan,
  isOutboxDispositionCode,
  listTerminalOutboxOrphans,
} from "./infrastructure/outbox/disposition.js";
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
  inboxRetention: { payloadsRedacted: number; rowsPruned: number };
  sePay: RecoveryTelemetry | null;
  supplier: RecoveryTelemetry | null;
}

/** Conservative, documented retention defaults for the Telegram inbox. */
export const DEFAULT_TELEGRAM_INBOX_RETENTION = {
  processedRetentionDays: 30,
  deadRetentionDays: 90,
  staleRetryRetentionDays: 7,
  failedPayloadGraceSeconds: 600,
  batchSize: 200,
} as const;

export type TelegramInboxRetention = {
  processedRetentionDays: number;
  deadRetentionDays: number;
  staleRetryRetentionDays: number;
  failedPayloadGraceSeconds: number;
  batchSize: number;
};

export async function runRecoveryJobsOnce(input: {
  db: Db;
  batchSize: number;
  now?: Date;
  sePayPort: SePayReconciliationPort | null;
  supplierPort: SupplierPort | null;
  vault: Vault;
  inboxRetention?: Partial<TelegramInboxRetention>;
}): Promise<RecoveryCycleResult> {
  const now = input.now ?? new Date();
  const inboxRetention = { ...DEFAULT_TELEGRAM_INBOX_RETENTION, ...input.inboxRetention };
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
  // Admin inventory imports paste credentials into message text. The envelope is redacted
  // at the moment of successful/failed processing, and this job catches everything else:
  // historic rows, and in-flight rows that aged past the grace window.
  const inbox = createPostgresTelegramInbox(input.db);
  const payloadsRedacted = await inbox.sanitizePayloads({
    batchSize: inboxRetention.batchSize,
    retryGraceSeconds: inboxRetention.failedPayloadGraceSeconds,
  });
  const rowsPruned = await inbox.prune({
    processedRetentionDays: inboxRetention.processedRetentionDays,
    deadRetentionDays: inboxRetention.deadRetentionDays,
    staleRetryRetentionDays: inboxRetention.staleRetryRetentionDays,
    batchSize: inboxRetention.batchSize,
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
    inboxRetention: { payloadsRedacted, rowsPruned },
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
      buttons: [[{ text: "⌂ Trang quản trị", callbackData: "admin:menu" }]],
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
        { text: "⌂ Trang quản trị", callbackData: "admin:menu" },
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
        ? [
            [
              { text: "Trang sau", callbackData: `admin:customers:page:${page.nextStateId}` },
              { text: "⌂ Trang quản trị", callbackData: "admin:menu" },
            ],
          ]
        : [[{ text: "⌂ Trang quản trị", callbackData: "admin:menu" }]]),
    ],
  };
}

/**
 * The CRM search prompt's lifetime. The admission row and the gating state must share it: if the row
 * outlives the state, the ingress still admits the query while the gate finds nothing, and the text
 * falls through to the broadcast or import handlers — with a live draft that turns the owner's search
 * query into a broadcast body. Short on purpose: it means "type your query now", and it keeps the
 * prompt from winning the text chain long after the owner has moved on.
 */
const CUSTOMER_SEARCH_PROMPT_TTL_MINUTES = 3;

export async function presentAdminCustomerSearchPrompt(db: Db, adminTelegramUserId: string) {
  await createAdminCallbackState(db, {
    adminTelegramUserId,
    kind: "CUSTOMER_SEARCH_PROMPT",
    payload: {},
    ttlMinutes: CUSTOMER_SEARCH_PROMPT_TTL_MINUTES,
  });
  // The ingress admits a typed query only while a `customer_search_prompt` row is live, and until now
  // this prompt wrote only the callback state — so a query typed here was dropped before dispatch and
  // the two halves never met. Opening the same one-shot row the customer product-search prompt uses
  // makes admission line up with the consumer in handleAdminCustomerFreeText.
  await sql`
    insert into customer_search_prompt (chat_id, expires_at)
    values (${adminTelegramUserId},
            now() + (${CUSTOMER_SEARCH_PROMPT_TTL_MINUTES} * interval '1 minute'))
    on conflict (chat_id) do update set expires_at = excluded.expires_at, created_at = now()
  `.execute(db);

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
  // The search prompt is the only remaining reason a root's free text means "query the CRM". It is
  // one-shot: consuming it here is what lets every OTHER text fall through the dispatcher's chain,
  // where the product search, the broadcast compose and the import handlers each read their own
  // state. Before this, the unconditional return below swallowed every line the owner typed — the
  // owner could not search products and could not compose a broadcast, while normal customers were
  // never affected because this whole handler is root-gated by its caller.
  const prompted = await sql<{ id: string }>`
    delete from admin_callback_state
    where admin_telegram_user_id = ${input.adminTelegramUserId}
      and kind = 'CUSTOMER_SEARCH_PROMPT'
      and expires_at > now()
    returning id
  `.execute(db);
  if (prompted.rows.length === 0) return null;

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
  laneIntervals?: Readonly<Record<string, number>>;
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
        const interval =
          input.laneIntervals?.[name] ??
          (name === "recovery" ? input.recoveryIntervalMs : input.pollIntervalMs);
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
      from product_variant v
      join product p on p.id = v.product_id
      left join variant_quantity_stock q on q.variant_id = v.id
      where v.id = ${variantId}
        and v.is_active
        and p.is_active
        and not (${VARIANT_READY_SQL})
      limit 1
    `.execute(db)
  ).rows[0];
  return row ? `${row.product_name} — ${row.variant_name}` : null;
}

function adminWarrantyError(text: string): PresentedMessage {
  return {
    text,
    buttons: [
      [
        { text: "🛡 Danh sách bảo hành", callbackData: "admin:warranty" },
        { text: "🏠 Quản trị", callbackData: "admin:menu" },
      ],
    ],
  };
}

/** Every resolution refusal reads as a sentence the owner can act on, never as a code. */
function adminClaimErrorText(code: string): string {
  switch (code) {
    case "NOT_ROOT_ADMIN":
      return "Chỉ chủ shop mới xử lý được yêu cầu bảo hành.";
    case "NOT_FOUND":
      return "Không tìm thấy yêu cầu bảo hành.";
    case "ILLEGAL_STATE":
      return "Yêu cầu này đang ở trạng thái khác — mở lại để xem bước tiếp theo.";
    case "NOT_ALLOWED_BY_POLICY":
      return "Chính sách của sản phẩm này không cho phép thao tác đó.";
    case "OUT_OF_STOCK":
      return "Không còn tài khoản thay thế trong kho.";
    case "INVALID_REASON":
      return "Thiếu lý do hoặc số tiền không hợp lệ.";
    default:
      return "Không thực hiện được thao tác bảo hành.";
  }
}

const WARRANTY_QUEUE_VIEWS: readonly WarrantyQueueView[] = [
  "new",
  "verifying",
  "waiting_customer",
  "refund_due",
  "replacement",
  "done",
  "rejected",
  "overdue",
];

function isWarrantyQueueView(value: string): value is WarrantyQueueView {
  return (WARRANTY_QUEUE_VIEWS as readonly string[]).includes(value);
}

/** Which claim statuses belong to each queue view. */
const WARRANTY_VIEW_STATUSES: Record<WarrantyQueueView, readonly string[]> = {
  new: ["SUBMITTED"],
  verifying: ["TRIAGE", "VERIFIED_DEFECT"],
  waiting_customer: ["WAITING_CUSTOMER"],
  refund_due: ["REFUND_APPROVED", "REFUND_DUE"],
  replacement: ["REPLACEMENT_APPROVED"],
  done: ["REFUND_PAID", "RESOLVED"],
  rejected: ["REJECTED", "CANCELLED"],
  overdue: [],
};

async function warrantyQueueCounts(db: Db): Promise<Record<WarrantyQueueView, number>> {
  const counts: Record<WarrantyQueueView, number> = {
    new: 0,
    verifying: 0,
    waiting_customer: 0,
    refund_due: 0,
    replacement: 0,
    done: 0,
    rejected: 0,
    overdue: 0,
  };
  const grouped = await sql<{ status: string; n: string }>`
    select status, count(*)::text as n from warranty_claim group by status
  `.execute(db);
  for (const row of grouped.rows) {
    for (const view of WARRANTY_QUEUE_VIEWS) {
      if (WARRANTY_VIEW_STATUSES[view].includes(row.status)) counts[view] += Number(row.n);
    }
  }
  // Goal §44: a claim waiting on the shop past its review window is called out.
  const overdue = await sql<{ n: string }>`
    select count(*)::text as n from warranty_claim
    where status in ('SUBMITTED', 'TRIAGE') and review_sla_due_at is not null and review_sla_due_at < now()
  `.execute(db);
  counts.overdue = Number(overdue.rows[0]?.n ?? 0);
  counts.new = Math.max(0, counts.new - counts.overdue);
  return counts;
}

async function warrantyQueueRows(db: Db, view: WarrantyQueueView): Promise<WarrantyQueueRow[]> {
  const statuses = [...WARRANTY_VIEW_STATUSES[view]];
  // Overdue is a filter over the waiting views, and an empty status list is not a valid `= any`.
  const filter =
    view === "overdue"
      ? sql`c.status in ('SUBMITTED','TRIAGE') and c.review_sla_due_at is not null and c.review_sla_due_at < now()`
      : statuses.length === 0
        ? sql`false`
        : sql`c.status = any(${sql.val(statuses)}::text[])`;
  const rows = await sql<{
    id: string;
    claim_number: string;
    status: string;
    customer_id: string;
    product_name: string;
    approved_refund_vnd: string | null;
    calculated_refund_vnd: string;
  }>`
    select c.id, c.claim_number, c.status, c.customer_id,
           coalesce(c.approved_refund_vnd, c.calculated_refund_vnd)::text as approved_refund_vnd,
           c.calculated_refund_vnd::text as calculated_refund_vnd,
           p.name_vi as product_name
    from warranty_claim c
    join "order" o on o.id = c.order_id
    join product_variant v on v.id = o.variant_id
    join product p on p.id = v.product_id
    where ${filter}
    order by c.reported_at asc
    limit 20
  `.execute(db);
  return rows.rows.map((row) => ({
    claimId: row.id,
    claimNumber: row.claim_number,
    customerLabel: `Khách ${row.customer_id.slice(-4).toUpperCase()}`,
    productName: row.product_name,
    amountVnd: BigInt(row.approved_refund_vnd ?? row.calculated_refund_vnd),
    statusLabel: WARRANTY_STATUS_LABELS[row.status] ?? row.status,
  }));
}

/** Goal §18: one claim with everything the owner decides on. */
async function loadAdminWarrantyClaim(db: Db, claimId: string): Promise<AdminClaimView | null> {
  const rows = await sql<{
    id: string;
    claim_number: string;
    status: string;
    customer_id: string;
    order_number: string;
    product_name: string;
    issue_type: string;
    reported_at: Date | string;
    warranty_start: Date | string;
    warranty_end: Date | string;
    used_days: number;
    remaining_days: number;
    paid_amount_vnd: string;
    calculated_refund_vnd: string;
    approved_refund_vnd: string | null;
    original_asset_id: string | null;
    coverage_snapshot: string | null;
    exclusions_snapshot: string | null;
    refund_bank_name: string | null;
    refund_account_number: string | null;
    refund_account_holder: string | null;
    rejection_reason: string | null;
  }>`
    select c.id, c.claim_number, c.status, c.customer_id, o.order_number, p.name_vi as product_name,
           c.issue_type, c.reported_at, c.warranty_start, c.warranty_end, c.used_days,
           c.remaining_days, c.paid_amount_vnd::text as paid_amount_vnd,
           c.calculated_refund_vnd::text as calculated_refund_vnd,
           c.approved_refund_vnd::text as approved_refund_vnd, c.original_asset_id,
           c.coverage_snapshot, c.exclusions_snapshot, c.refund_bank_name,
           c.refund_account_number, c.refund_account_holder, c.rejection_reason
    from warranty_claim c
    join "order" o on o.id = c.order_id
    join product_variant v on v.id = o.variant_id
    join product p on p.id = v.product_id
    where c.id = ${claimId}
    limit 1
  `.execute(db);
  const row = rows.rows[0];
  if (!row) return null;
  const iso = (value: Date | string) =>
    value instanceof Date ? value.toISOString() : String(value);
  const openForDecision = ["SUBMITTED", "TRIAGE", "WAITING_CUSTOMER"].includes(row.status);
  return {
    id: row.id,
    claimNumber: row.claim_number,
    status: row.status,
    statusLabel: WARRANTY_STATUS_LABELS[row.status] ?? row.status,
    customerLabel: `Khách ${row.customer_id.slice(-4).toUpperCase()}`,
    orderNumber: row.order_number,
    productName: row.product_name,
    issueType: row.issue_type as WarrantyIssueType,
    reportedAt: iso(row.reported_at),
    warrantyStart: iso(row.warranty_start),
    warrantyEnd: iso(row.warranty_end),
    usedDays: row.used_days,
    remainingDays: row.remaining_days,
    paidAmountVnd: BigInt(row.paid_amount_vnd),
    calculatedRefundVnd: BigInt(row.calculated_refund_vnd),
    approvedRefundVnd: row.approved_refund_vnd === null ? null : BigInt(row.approved_refund_vnd),
    assetRef: row.original_asset_id ? `#${row.original_asset_id.slice(-8).toUpperCase()}` : null,
    coverageSnapshot: row.coverage_snapshot,
    exclusionsSnapshot: row.exclusions_snapshot,
    bankName: row.refund_bank_name,
    accountNumber: row.refund_account_number,
    accountHolder: row.refund_account_holder,
    rejectionReason: row.rejection_reason,
    timeline: await listClaimTimeline(db, row.id),
    canVerify: openForDecision,
    canReplace: ["VERIFIED_DEFECT"].includes(row.status),
    canRefund: ["VERIFIED_DEFECT"].includes(row.status),
  };
}

const WARRANTY_STATUS_LABELS: Record<string, string> = {
  SUBMITTED: "Mới",
  TRIAGE: "Đang kiểm tra",
  WAITING_CUSTOMER: "Chờ khách",
  VERIFIED_DEFECT: "Đã xác nhận lỗi",
  REPLACEMENT_APPROVED: "Đã duyệt đổi hàng",
  REFUND_APPROVED: "Đã duyệt hoàn tiền",
  REFUND_DUE: "Chờ chuyển tiền",
  REFUND_PAID: "Đã hoàn tiền",
  REJECTED: "Từ chối",
  RESOLVED: "Đã xử lý",
  CANCELLED: "Đã huỷ",
};

/**
 * Goal §26: the owner's adjustment arrives as "<amount> | <reason>". The amount is validated here
 * rather than trusted: a refund is money, and a typo must not become an approval.
 */
function parseRefundAdjustment(text: string): { amountVnd: bigint; reason: string } | null {
  const separator = text.indexOf("|");
  if (separator < 0) return null;
  const rawAmount = text.slice(0, separator).replace(/[.,\s]/gu, "");
  const reason = text.slice(separator + 1).trim();
  if (!/^\d{1,10}$/u.test(rawAmount)) return null;
  if (reason.length === 0 || reason.length > 200) return null;
  const amountVnd = BigInt(rawAmount);
  if (amountVnd <= 0n || amountVnd > 1_000_000_000n) return null;
  return { amountVnd, reason };
}

/**
 * Root-only. The warranty surface reads customer, claim and payout data, and `adminCallbacks` being
 * present only proves the feature is configured — it is built once from config, so it is non-null
 * for every caller. Every entry point therefore asks the admin callback layer to authorise this
 * specific actor, exactly as the sibling admin handlers do.
 */
async function requireRootAdmin(
  adminCallbacks: AdminCallbacks | null,
  input: { telegramUserId: string; chatType: string; correlationId: string },
  targetId: string,
  reason: string,
): Promise<null | "NOT_ROOT_ADMIN" | "WRONG_CONTEXT"> {
  // Returns the reason rather than a screen: the presenter lives behind a dynamic import that the
  // worker loads on demand, and every caller already has it in scope.
  if (!adminCallbacks) return "NOT_ROOT_ADMIN";
  const gate = await adminCallbacks.handle({
    command: "order.inspect",
    actor: { numericUserId: Number(input.telegramUserId), chatType: "private" },
    targetId,
    reason,
    correlationId: input.correlationId,
  });
  return gate.ok ? null : gate.code === "WRONG_CONTEXT" ? "WRONG_CONTEXT" : "NOT_ROOT_ADMIN";
}

/**
 * The broadcast send gate, in one place: the audited root identity, then a live
 * BROADCAST step-up grant, and only then the enqueue. The campaign's frozen
 * audience/content/revision check stays inside `enqueueBroadcastRecipients` /
 * `confirmBroadcast` — a stale preview is refused there, so BOTH a stale
 * confirmation and a stale signed callback fail.
 *
 * Exported because the integration suite drives this exact path; the Telegram route
 * reaches it through the admin surface in `bootstrap`.
 */
export type BroadcastSendOutcome =
  | { ok: true; queued: number }
  | { ok: false; stage: "IDENTITY"; code: SensitiveAuthorizationRefusal | "WRONG_CONTEXT" }
  | { ok: false; stage: "CAMPAIGN"; reason: BroadcastRefusal };

export async function enqueueBroadcastFromOwner(input: {
  db: Db;
  adminCallbacks: AdminCallbacks | null;
  sensitiveDeps: SensitiveActionDeps;
  telegramUserId: string;
  chatType: string;
  campaignId: string;
  correlationId: string;
  /** Large-audience cooldown knobs; the production defaults come from the env config. */
  largeAudienceThreshold: number;
  cooldownSeconds: number;
}): Promise<BroadcastSendOutcome> {
  const denied = await requireRootAdmin(
    input.adminCallbacks,
    input,
    input.campaignId,
    "Admin broadcast",
  );
  if (denied) return { ok: false, stage: "IDENTITY", code: denied };
  const authorization = await authorizeSensitiveAdminAction(input.sensitiveDeps, {
    actor: {
      numericUserId: Number(input.telegramUserId),
      // The caller checked the private context; any other type maps to a non-private one so an
      // unexpected chat type can never authorize.
      chatType: input.chatType === "private" ? "private" : "channel",
    },
    actionKey: "broadcast.confirm",
    resourceType: "NotificationCampaign",
    resourceId: input.campaignId,
    correlationId: input.correlationId,
    requestedData: { campaignId: input.campaignId },
    consumeGrant: true,
  });
  if (!authorization.ok) return { ok: false, stage: "IDENTITY", code: authorization.code };
  const confirmed = await confirmBroadcast(input.db, {
    campaignId: input.campaignId,
    createdBy: input.telegramUserId,
    rootTelegramUserId: String(input.sensitiveDeps.rootConfig.adminTelegramUserId),
    correlationId: input.correlationId,
    largeAudienceThreshold: input.largeAudienceThreshold,
    cooldownSeconds: input.cooldownSeconds,
  });
  return confirmed.ok
    ? { ok: true, queued: confirmed.queued }
    : { ok: false, stage: "CAMPAIGN", reason: confirmed.reason };
}

const ADMIN_PRODUCT_VIEWS: readonly AdminProductView[] = [
  "all",
  "featured",
  "inactive",
  "archived",
  "test",
];

function isAdminProductView(value: unknown): value is AdminProductView {
  return typeof value === "string" && (ADMIN_PRODUCT_VIEWS as readonly string[]).includes(value);
}

/** A warranty screen for a case we cannot serve; never a stack trace or an internal code. */
function safeWarrantyMessage(text: string): PresentedMessage {
  return {
    text,
    buttons: [
      [
        { text: "💬 Hỗ trợ", callbackData: "sup:open" },
        { text: "🏠 Trang chủ", callbackData: "shop:home" },
      ],
    ],
  };
}

/**
 * What the customer reads when the shop moves their ticket. Kept apart from the
 * owner's labels: the customer never sees an internal status code.
 */
const SUPPORT_TICKET_CUSTOMER_MESSAGE: Record<string, string> = {
  WAITING_SHOP: "Shop đang xử lý yêu cầu hỗ trợ của bạn.",
  WAITING_CUSTOMER: "Shop cần bạn bổ sung thông tin cho yêu cầu hỗ trợ.",
  RESOLVED: "Yêu cầu hỗ trợ của bạn đã được xử lý.",
  CLOSED: "Yêu cầu hỗ trợ đã đóng.",
  MANUAL_REVIEW: "Shop đang xem xét thêm yêu cầu của bạn.",
};

/** A support screen we could not serve; never a stack trace or an internal code. */
function adminSupportError(text: string): PresentedMessage {
  return {
    text,
    buttons: [
      [
        { text: "🧾 Yêu cầu hỗ trợ", callbackData: "admin:support:tickets" },
        { text: "🏠 Quản trị", callbackData: "admin:menu" },
      ],
    ],
  };
}

function isWarrantyIssueType(value: string): value is WarrantyIssueType {
  return Object.prototype.hasOwnProperty.call(ISSUE_TYPE_LABELS, value);
}

/**
 * The customer's fulfilled order for a variant, its delivered asset, and where the warranty window
 * stands right now. Ownership is part of the query, so a forged callback cannot reach another
 * customer's order.
 */
async function warrantyOrderContext(
  db: Db,
  customerId: string,
  variantId: string,
): Promise<
  | { kind: "none" }
  | { kind: "not_covered" }
  | { kind: "expired"; warrantyEnd: string }
  | {
      kind: "ok";
      orderId: string;
      orderNumber: string;
      assetId: string | null;
      warrantyEnd: string;
      productName: string;
    }
> {
  const rows = await sql<{
    id: string;
    order_number: string;
    completed_at: Date | string | null;
    warranty_days: number;
    warranty_enabled: boolean;
    asset_id: string | null;
    product_name: string;
  }>`
    select o.id, o.order_number, o.completed_at,
           coalesce(o.warranty_days, 0) as warranty_days,
           coalesce(v.warranty_enabled, false) as warranty_enabled,
           o.product_name_vi as product_name,
           (select a.id from digital_asset a
             where a.delivered_order_id = o.id
             order by a.updated_at asc, a.id asc limit 1) as asset_id
    from "order" o
    join product_variant v on v.id = o.variant_id
    where o.customer_id = ${customerId}
      and o.variant_id = ${variantId}
      and o.completed_at is not null
    order by o.completed_at desc
    limit 1
  `.execute(db);
  const row = rows.rows[0];
  if (!row) return { kind: "none" };
  if (!row.warranty_enabled || row.warranty_days <= 0) return { kind: "not_covered" };
  const start =
    row.completed_at instanceof Date ? row.completed_at : new Date(String(row.completed_at));
  const terms = { warrantyDays: row.warranty_days, warrantyStart: start };
  const warrantyEnd = warrantyEndOf(terms).toISOString();
  if (!isWithinWarranty(terms, new Date())) return { kind: "expired", warrantyEnd };
  return {
    kind: "ok",
    orderId: row.id,
    orderNumber: row.order_number,
    assetId: row.asset_id,
    warrantyEnd,
    productName: row.product_name,
  };
}

/** The report-time estimate for an order, using exactly the rule the claim will store. */
async function warrantyEstimate(
  db: Db,
  orderId: string,
): Promise<{ remainingDays: number; refundVnd: bigint } | null> {
  const rows = await sql<{
    price_vnd: string;
    warranty_days: number;
    completed_at: Date | string | null;
    warranty_proration_enabled: boolean;
    warranty_enabled: boolean;
  }>`
    select o.price_vnd::text as price_vnd, coalesce(o.warranty_days, 0) as warranty_days,
           o.completed_at, v.warranty_proration_enabled, v.warranty_enabled
    from "order" o
    join product_variant v on v.id = o.variant_id
    where o.id = ${orderId}
    limit 1
  `.execute(db);
  const row = rows.rows[0];
  if (!row || !row.warranty_enabled || !row.completed_at || row.warranty_days <= 0) return null;
  const start =
    row.completed_at instanceof Date ? row.completed_at : new Date(String(row.completed_at));
  const paid = BigInt(row.price_vnd);
  const snapshot = computeProratedRefund({
    warrantyDays: row.warranty_days,
    warrantyStart: start,
    paidAmountVnd: paid,
    reportedAt: new Date(),
  });
  return {
    remainingDays: snapshot.remainingDays,
    refundVnd: row.warranty_proration_enabled ? snapshot.refundVnd : paid,
  };
}

/** The customer's own claim, by its human reference. */
async function loadCustomerWarrantyClaim(
  db: Db,
  customerId: string,
  claimRef: string,
): Promise<{
  id: string;
  claim_number: string;
  status: string;
  remaining_days: number;
  calculated_refund_vnd: string;
  approved_refund_vnd: string | null;
  product_name: string;
} | null> {
  const ref = claimRef.trim().toUpperCase();
  const rows = await sql<{
    id: string;
    claim_number: string;
    status: string;
    remaining_days: number;
    calculated_refund_vnd: string;
    approved_refund_vnd: string | null;
    product_name: string;
  }>`
    select c.id, c.claim_number, c.status, c.remaining_days,
           c.calculated_refund_vnd::text as calculated_refund_vnd,
           c.approved_refund_vnd::text as approved_refund_vnd,
           p.name_vi as product_name
    from warranty_claim c
    join "order" o on o.id = c.order_id
    join product_variant v on v.id = o.variant_id
    join product p on p.id = v.product_id
    where c.customer_id = ${customerId} and c.claim_number = ${ref}
    limit 1
  `.execute(db);
  return rows.rows[0] ?? null;
}

/**
 * Resolve a stock item and its variant from the display ref alone. The ref is derived from the
 * asset id, which keeps every callback payload inside Telegram's 64-byte limit — carrying the
 * variant id as well overflowed it and the send failed with BUTTON_DATA_INVALID.
 */
async function lookupInventoryItemByRef(
  db: Db,
  ref: string,
): Promise<{
  id: string;
  variant_id: string;
  variant_name: string;
  status: string;
  version: number;
} | null> {
  const found = await sql<{
    id: string;
    variant_id: string;
    variant_name: string;
    status: string;
    version: number;
  }>`
    select a.id, a.variant_id, v.name_vi as variant_name, a.status, a.version
    from digital_asset a
    join product_variant v on v.id = a.variant_id
    where right(a.id, 8) = ${ref}
    limit 1
  `.execute(db);
  return found.rows[0] ?? null;
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

  const { loadConfig, SECRET_ENV_KEYS } = await import("./config/index.js");
  const config = loadConfig(process.env);

  const { createLogger } = await import("./infrastructure/observability/logger.js");
  const logger = createLogger(config);

  // Value-scanning redaction: path censoring only covers known keys, so the resolved
  // secret values are registered once here and scrubbed everywhere after.
  const { registerConfigSecrets } = await import("./infrastructure/observability/redact.js");
  registerConfigSecrets(config, SECRET_ENV_KEYS);

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
  const { applyPaymentEvidence, presentPreorderPayment } =
    await import("./modules/payments/service.js");
  const { classifyPaymentCode } = await import("./modules/payments/payment-code.js");
  const { createPostgresRateLimiter, DEFAULT_TELEGRAM_RATE_LIMIT_POLICIES } =
    await import("./modules/risk/service.js");
  const { createBuyNowCallbackCodec, createCallbackTokenCodec } =
    await import("./bot/callback-codec.js");
  const { createCatalogCallbacks } = await import("./bot/callbacks/catalog.js");
  const { createCheckoutCallbacks } = await import("./bot/callbacks/checkout.js");
  const { createHistoryCallbacks } = await import("./bot/callbacks/history.js");
  const { createSupportCallbacks } = await import("./bot/callbacks/support.js");
  const { presentPaymentScreen, presentPreorderPaymentScreen, presentWalletHistory } =
    await import("./bot/presenters/payment.js");
  const { createWalletLedgerService, listWalletLedgerEntries } =
    await import("./modules/wallet/ledger.js");
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
    saveWalletTopupAwaitingAmount,
    saveWalletTopupSelection,
  } = await import("./modules/wallet/topup.js");
  const { createWalletPurchaseService } = await import("./modules/wallet/purchase.js");
  const { createTelegramDomainDispatcher } = await import("./bot/callbacks/telegram-dispatch.js");
  const { createPostgresUiSurfaceRegistry } = await import("./bot/ui-surface.js");
  const { createGrammyDocumentSender, createGrammyResponder, ensureTelegramCommandMenu } =
    await import("./bot/grammy-responder.js");
  const { createSearchParser } = await import("./modules/catalog/search-parser-adapter.js");
  const { findOrderByIdForOwner, findOrderByNumberForOwner, findOrderByNumberInternal } =
    await import("./modules/commerce/repository.js");
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
  const {
    getStoreControl,
    getStoreMode,
    getStoreOpenReadiness,
    isStoreOpenReady,
    addTestCustomer,
    listTestCustomers,
  } = await import("./modules/commerce/store-mode.js");
  const { adjustQuantityStock, listVariantInventoryHistory } =
    await import("./modules/catalog/quantity-stock.js");
  const {
    selectVariantSupplierMapping,
    clearVariantSupplierMapping,
    markSupplierSkuManuallyVerified,
  } = await import("./modules/supplier/admin.js");
  const { approveReplacementCaseInTransaction } =
    await import("./modules/digital-goods/replacement.js");
  // Loaded on demand like every other worker dependency: the whole surface is
  // composed inside the worker entrypoint, where the module graph is built.
  const { listOpenTickets, getAdminTicket, setTicketStatus } =
    await import("./modules/support/service.js");
  const {
    presentAdminBroadcastAudience,
    presentAdminBroadcastPreview,
    presentAdminBroadcastPrompt,
    presentAdminBroadcastStatus,
    presentAdminDenied,
    presentAdminDashboard,
    presentAdminSystemHealth,
    presentAdminNotifications,
    presentAdminProductContentMenu,
    presentAdminProductContentPrompt,
    adminProductContentField,
    presentAdminInventory,
    presentAdminInventoryProduct,
    presentAdminInventoryVariant,
    presentAdminInventoryHistory,
    presentAdminInventoryItems,
    presentAdminInventoryItemActions,
    presentAdminInventoryItemConfirm,
    presentAdminInventoryItemDone,
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
    presentSensitiveRefusal,
    presentAdminBroadcastRefused,
    presentInventoryImportPreview,
    presentInventoryImportPrompt,
    presentInventoryImportTemplate,
    presentFileArtifactImportDone,
    presentFileArtifactImportPreview,
    presentProductDraftPreview,
    presentAdminVariantDraft,
    presentAdminVariantFieldPrompt,
    presentAdminPaymentOps,
    presentAdminDiscrepancyDetail,
    presentAdminOutboxOrphans,
    presentAdminOutboxDetail,
    presentAdminNotePrompt,
    presentAdminProductReadiness,
    presentAdminEvidencePrompt,
    presentAdminEvidenceRevokePrompt,
    presentAdminStoreOpenBlocked,
    presentAdminOperations,
    ADMIN_VARIANT_FIELDS,
    presentAdminVariantMutationDone,
    presentKillSwitchDone,
    presentAdminSupplierActionDone,
    presentAdminSupplierVariant,
    presentAdminSuppliersMenu,
    presentAdminSupportQueue,
    presentAdminSupportTickets,
    presentAdminSupportTicket,
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
    presentWizardDescriptionFields,
    presentWizardDescriptionFieldPrompt,
    wizardDescriptionField,
    wizardValidationMessage,
    presentWizardDescriptionCustomPrompt,
    presentWizardVariantStep,
    presentWizardDeliveryStep,
    presentWizardCustomFieldFlags,
    presentWizardCategoryCreatePrompt,
    presentWizardCustomFieldPrompt,
    presentWizardAdvancedPrompt,
    presentWizardVisibilityStep,
  } = await import("./bot/presenters/admin-wizard.js");
  const {
    loadPreorderVariantConfig,
    presentPreorderConsent,
    createPreorderReservation,
    preorderPayableLeg,
    listCustomerPreorders,
    releaseExpiredPreorderHolds,
  } = await import("./modules/commerce/preorder.js");
  const { shopCancelPreorder } = await import("./modules/commerce/shop-cancel.js");
  const { generateCustomerAlias, listTrustScreen } =
    await import("./modules/marketing/social-proof.js");
  const { formatSePayReconciliationAdminText, getSePayReconciliationStatus } =
    await import("./modules/payments/reconciliation-status.js");
  const {
    presentCustomerAccount,
    presentCustomerNotificationPreferences,
    presentCustomerPreorders,
    presentCustomerTrustScreen,
    presentCustomerWarrantyHome,
    presentPurchaseThankYou,
  } = await import("./bot/presenters/customer.js");
  const { presentDeliveryReveal } = await import("./bot/presenters/delivery.js");
  const { presentAdminManualTaskDetail, presentAdminManualTasks } =
    await import("./bot/presenters/manual-fulfillment.js");

  const dbHandle = createDb({
    connectionString: config.DATABASE_URL,
    onPoolError: (error) => logger.error({ err: error.message }, "database pool error"),
  });
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
  let googleSheetsApi: GoogleSheetsApi | null = null;
  let createGoogleSheetsApi: (() => Promise<GoogleSheetsApi>) | null = null;
  if (config.GOOGLE_SHEETS_ENABLED) {
    if (
      !config.GOOGLE_SHEETS_SPREADSHEET_ID ||
      !config.GOOGLE_SHEETS_CREDENTIAL_VAULT_REF.startsWith("vault:") ||
      !config.GOOGLE_SHEETS_OWNER_ID
    ) {
      throw new Error("Google Sheets is enabled but its safe configuration is incomplete");
    }
    const { createGoogleSheetsClient } = await import("./infrastructure/google-sheets/client.js");
    createGoogleSheetsApi = () =>
      createGoogleSheetsClient({
        credentialVaultRef: config.GOOGLE_SHEETS_CREDENTIAL_VAULT_REF,
        timeoutMs: config.GOOGLE_SHEETS_TIMEOUT_MS,
        maxAttempts: config.GOOGLE_SHEETS_MAX_ATTEMPTS,
        vault,
      });
  }
  const telemetry = createFulfillmentTelemetry();
  // Fixture supplier for local/dev; production swaps an HTTP adapter (T143).
  const supplier =
    config.SUPPLIER_DRIVER === "fixture" ? createSandboxSupplierAdapter({ mode: "fulfill" }) : null;
  const sePayRecoveryPort =
    config.SEPAY_API_TOKEN.length > 0
      ? createSePayApiPort({
          baseUrl: config.SEPAY_API_BASE_URL,
          token: config.SEPAY_API_TOKEN,
          allowSandbox: config.NODE_ENV !== "production",
        })
      : null;
  const telegramClient = { environment: config.TELEGRAM_API_ENVIRONMENT } as const;
  const telegramDocumentSender = createGrammyDocumentSender(
    config.TELEGRAM_BOT_TOKEN,
    undefined,
    config.NODE_ENV !== "production" ? logger : undefined,
    telegramClient,
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
    // Warranty (goal: warranty vertical). Every handler re-authorizes against the actor's own
    // order, so a forged callback can only ever reach the caller's own data.
    warranty: {
      async policy(input) {
        if (!resolveCustomerId) return safeWarrantyMessage("Bảo hành không khả dụng.");
        const rows = await sql<{
          product_name: string;
          product_id: string;
          warranty_days: number;
          warranty_enabled: boolean;
          warranty_coverage_vi: string | null;
          warranty_exclusions_vi: string | null;
          price_vnd: string;
        }>`
          select p.name_vi as product_name, v.product_id, v.warranty_days, v.warranty_enabled,
                 v.warranty_coverage_vi, v.warranty_exclusions_vi, v.price_vnd::text as price_vnd
          from product_variant v
          join product p on p.id = v.product_id
          where v.id = ${input.variantId}
          limit 1
        `.execute(dbHandle.db);
        const row = rows.rows[0];
        if (!row) return safeWarrantyMessage("Không tìm thấy sản phẩm.");
        if (!row.warranty_enabled || row.warranty_days <= 0) return presentWarrantyNotCovered();
        return presentWarrantyPolicy({
          productName: row.product_name,
          productId: row.product_id,
          warrantyDays: row.warranty_days,
          coverageVi: row.warranty_coverage_vi,
          exclusionsVi: row.warranty_exclusions_vi,
          examplePriceVnd: BigInt(row.price_vnd),
          variantId: input.variantId,
        });
      },
      async issueTypes(input) {
        const customerId = resolveCustomerId ? await resolveCustomerId(input.telegramUserId) : null;
        if (!customerId) return safeWarrantyMessage("Không xác minh được khách hàng.");
        const context = await warrantyOrderContext(dbHandle.db, customerId, input.variantId);
        if (context.kind === "none")
          return safeWarrantyMessage("Bạn chưa có đơn đã giao cho sản phẩm này.");
        if (context.kind === "expired")
          return presentWarrantyExpired({ warrantyEnd: context.warrantyEnd });
        if (context.kind === "not_covered") return presentWarrantyNotCovered();
        return presentWarrantyIssueTypes({
          orderNumber: context.orderNumber,
          variantId: input.variantId,
        });
      },
      /** Goal §41: confirm before submitting, with the estimate clearly conditional. */
      async preview(input) {
        const customerId = resolveCustomerId ? await resolveCustomerId(input.telegramUserId) : null;
        if (!customerId) return safeWarrantyMessage("Không xác minh được khách hàng.");
        if (!isWarrantyIssueType(input.issueType))
          return safeWarrantyMessage("Tình trạng bạn chọn không hợp lệ.");
        const context = await warrantyOrderContext(dbHandle.db, customerId, input.variantId);
        if (context.kind === "none")
          return safeWarrantyMessage("Bạn chưa có đơn đã giao cho sản phẩm này.");
        if (context.kind === "expired")
          return presentWarrantyExpired({ warrantyEnd: context.warrantyEnd });
        if (context.kind === "not_covered") return presentWarrantyNotCovered();
        const estimate = await warrantyEstimate(dbHandle.db, context.orderId);
        if (!estimate) return safeWarrantyMessage("Chưa xem được thông tin bảo hành của đơn này.");
        return presentWarrantyReportPreview({
          productName: context.productName,
          orderNumber: context.orderNumber,
          issueType: input.issueType,
          note: null,
          warrantyEnd: context.warrantyEnd,
          remainingDays: estimate.remainingDays,
          estimatedRefundVnd: estimate.refundVnd,
          variantId: input.variantId,
        });
      },
      async report(input) {
        const customerId = resolveCustomerId ? await resolveCustomerId(input.telegramUserId) : null;
        if (!customerId) return safeWarrantyMessage("Không xác minh được khách hàng.");
        const context = await warrantyOrderContext(dbHandle.db, customerId, input.variantId);
        if (context.kind === "none")
          return safeWarrantyMessage("Bạn chưa có đơn đã giao cho sản phẩm này.");
        if (context.kind === "expired")
          return presentWarrantyExpired({ warrantyEnd: context.warrantyEnd });
        if (context.kind === "not_covered") return presentWarrantyNotCovered();
        if (!isWarrantyIssueType(input.issueType))
          return safeWarrantyMessage("Tình trạng bạn chọn không hợp lệ.");
        const opened = await openWarrantyClaim({
          db: dbHandle.db,
          customerId,
          orderId: context.orderId,
          ...(context.assetId ? { assetId: context.assetId } : {}),
          issueType: input.issueType,
          correlationId: input.correlationId,
        });
        if (!opened.ok) {
          return safeWarrantyMessage(
            opened.code === "WARRANTY_EXPIRED"
              ? "⌛ Sản phẩm đã hết thời hạn bảo hành. Bạn vẫn có thể liên hệ hỗ trợ."
              : "Chưa mở được yêu cầu bảo hành. Vui lòng thử lại sau.",
          );
        }
        return presentWarrantyClaimSubmitted({
          claimNumber: opened.claimNumber,
          estimatedRefundVnd: opened.snapshot.refundVnd,
          remainingDays: opened.snapshot.remainingDays,
        });
      },
      async claim(input) {
        const customerId = resolveCustomerId ? await resolveCustomerId(input.telegramUserId) : null;
        if (!customerId) return safeWarrantyMessage("Không xác minh được khách hàng.");
        const claim = await loadCustomerWarrantyClaim(dbHandle.db, customerId, input.claimRef);
        if (!claim) return safeWarrantyMessage("Không tìm thấy yêu cầu bảo hành.");
        return presentWarrantyClaim({
          claimNumber: claim.claim_number,
          productName: claim.product_name,
          status: claim.status,
          estimatedRefundVnd: BigInt(claim.calculated_refund_vnd),
          approvedRefundVnd:
            claim.approved_refund_vnd === null ? null : BigInt(claim.approved_refund_vnd),
          remainingDays: claim.remaining_days,
          timeline: await listClaimTimeline(dbHandle.db, claim.id),
        });
      },
    },
    // Goal §28: one-shot permission so the search prompt can accept the product name it asks for.
    // Raw customer text stays dropped outside this window.
    searchPrompt: {
      async open(input) {
        await sql`
          insert into customer_search_prompt (chat_id, expires_at)
          values (${input.chatId}, now() + interval '10 minutes')
          on conflict (chat_id) do update set expires_at = excluded.expires_at, created_at = now()
        `.execute(dbHandle.db);
        // Mirror of the CRM prompt: opening the product search cancels the owner's CRM search, so the
        // two can never both be armed and a product query cannot be misread as a customer query.
        await sql`
          delete from admin_callback_state
          where admin_telegram_user_id = ${String(input.chatId)}
            and kind = 'CUSTOMER_SEARCH_PROMPT'
        `.execute(dbHandle.db);
      },
    },
    parser: createSearchParser({
      driver: config.SEARCH_PARSER_DRIVER,
      timeoutMs: config.SEARCH_PARSER_TIMEOUT_MS,
    }),
    callbackCodec: buyNowCodec,
    tokenCodec: callbackCodec,
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
    },
    callbackCodec: buyNowCodec,
    tokenCodec: callbackCodec,
    resolveCustomerId,
    adminTelegramUserId: config.ADMIN_TELEGRAM_USER_ID,
    resolveAudience: (input) =>
      resolveCatalogAudience(dbHandle.db, {
        telegramUserId: input.telegramUserId,
        isRootAdmin: input.isRootAdmin,
      }),
    walletBalanceVnd: async (customerId) => {
      const account = await walletLedger.ensureAccount(customerId);
      return account ? BigInt(account.balanceVnd) : null;
    },
    walletTopUpBounds: {
      minVnd: BigInt(config.WALLET_TOPUP_MIN_VND),
      maxVnd: BigInt(config.WALLET_TOPUP_MAX_VND),
    },
    payOrderWithWallet: async (input) => {
      const result = await walletPurchase.purchase({
        customerId: input.customerId,
        orderId: input.orderId,
        idempotencyKey: `telegram:${input.customerId}:${input.orderId}`,
        correlationId: input.correlationId,
      });
      return result.ok ? { ok: true, message: "" } : { ok: false, message: result.message };
    },
    // "Kiểm tra thanh toán": a bounded, cooldown-guarded, read-only provider check that can
    // only record evidence the normal matcher accepts. Omitted when SePay is not configured,
    // so the button degrades to the internal projection read instead of failing.
    ...(sePayRecoveryPort
      ? {
          reconcileForCheck: () =>
            reconcileForPaymentCheck(dbHandle.db, { port: sePayRecoveryPort }),
        }
      : {}),
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
  };
  const preorderHomeButtons: PresentedMessage["buttons"] = [
    [
      { text: "📌 Đặt cọc của tôi", callbackData: "cust:preorders" },
      { text: "🛒 Về trang chủ", callbackData: "shop:home" },
    ],
  ];
  /**
   * The QR for the leg a reservation currently owes: the deposit while the hold is
   * unpaid, the remaining balance once stock is allocated. Ownership is enforced by
   * the `customer_id` predicate — a reservation id alone never yields a payment code.
   *
   * Nothing here is a purchase confirmation: only SePay evidence moves the reservation
   * out of WAITING_DEPOSIT.
   */
  async function presentOwnedPreorderLeg(input: {
    customerId: string;
    reservationId: string;
    correlationId: string;
  }): Promise<PresentedMessage> {
    const rowRes = await sql<{
      status: PreorderStatus;
      deposit_amount_vnd: string;
      balance_amount_vnd: string;
    }>`
      select status, deposit_amount_vnd::text, balance_amount_vnd::text
      from preorder_reservation
      where id = ${input.reservationId} and customer_id = ${input.customerId}
      limit 1
    `.execute(dbHandle.db);
    const row = rowRes.rows[0];
    if (!row) return { text: "Không tìm thấy suất đặt cọc.", buttons: preorderHomeButtons };

    const leg = preorderPayableLeg(row.status);
    if (!leg) {
      return {
        text: "Suất đặt cọc này không còn khoản nào cần thanh toán.",
        buttons: preorderHomeButtons,
      };
    }

    const presented = await presentPreorderPayment(dbHandle.db, {
      reservationId: input.reservationId,
      customerId: input.customerId,
      leg,
      ...merchant,
      correlationId: input.correlationId,
    });
    if (!presented.ok) {
      return {
        text: "Chưa tạo được mã thanh toán cho suất đặt cọc này. Vui lòng mở “Đặt cọc của tôi” để thử lại.",
        buttons: preorderHomeButtons,
      };
    }

    return await presentPreorderPaymentScreen({
      productName: presented.productName,
      variantName: presented.variantName,
      leg,
      depositVnd: BigInt(row.deposit_amount_vnd),
      balanceVnd: BigInt(row.balance_amount_vnd),
      presentation: presented.presentation,
      reservationId: input.reservationId,
    });
  }
  /**
   * Best-effort live identity of the API process, for the admin health screen.
   *
   * Probes the API's own local bind first and the public base URL second: the local hop is a
   * same-host request that does not depend on the edge (DNS, TLS or an inbound rule), so a
   * partial or edge-broken deploy still reports the API's real commit instead of "unreachable".
   */
  async function readApiBuildCommit(): Promise<string> {
    const publicBase = new URL(config.APP_BASE_URL);
    const guardedFetch = createPinnedFetch({
      allowedHosts: [publicBase.hostname, "127.0.0.1"],
      allowedPorts: [
        config.HTTP_PORT,
        publicBase.port ? Number(publicBase.port) : publicBase.protocol === "https:" ? 443 : 80,
      ],
      allowInsecureLoopback: true,
      timeoutMs: 2_000,
    });
    const targets = [
      { url: `http://127.0.0.1:${config.HTTP_PORT}/health`, via: "local" },
      { url: `${config.APP_BASE_URL}/health`, via: "public" },
    ];
    for (const target of targets) {
      try {
        const response = await guardedFetch(target.url);
        if (!response.ok) continue;
        const body = (await response.json()) as { commit?: unknown };
        if (typeof body.commit === "string")
          return `${body.commit.slice(0, 12)} (live, ${target.via})`;
      } catch {
        // Try the next target; a failure here is a finding, not a crash.
      }
    }
    return "không truy cập được";
  }

  const walletTopupBounds = {
    minVnd: config.WALLET_TOPUP_MIN_VND,
    maxVnd: config.WALLET_TOPUP_MAX_VND,
  };
  /** Read the field key a per-field content prompt was opened for, if any. */
  function readDescriptionFieldKey(payload: unknown): string | null {
    if (!payload || typeof payload !== "object") return null;
    const value = (payload as { field?: unknown }).field;
    return typeof value === "string" && value.length > 0 ? value : null;
  }

  function walletTopupPickerMessage(account: WalletAccount): PresentedMessage {
    const presets = WALLET_TOPUP_PRESET_AMOUNTS.filter(
      (amount) => amount >= walletTopupBounds.minVnd && amount <= walletTopupBounds.maxVnd,
    ).slice(0, 4);
    const presetRows: PresentedMessage["buttons"] = [];
    for (let i = 0; i < presets.length; i += 2) {
      presetRows.push(
        presets.slice(i, i + 2).map((amount) => ({
          text: formatVnd(amount),
          callbackData: `wallet:topup:amount:${amount}`,
        })),
      );
    }
    return {
      text: [
        "💰 Ví TIER20",
        "",
        `Số dư: ${formatVnd(account.balanceVnd)}`,
        "Thanh toán tức thì 1 chạm, không cần quét mã mỗi lần mua.",
        `Chọn số tiền nạp (${formatVnd(walletTopupBounds.minVnd)} – ${formatVnd(walletTopupBounds.maxVnd)}).`,
      ].join("\n"),
      buttons: [
        ...presetRows,
        [{ text: "✏️ Số tiền khác", callbackData: "wallet:topup:custom" }],
        [
          { text: "📜 Lịch sử ví", callbackData: "wallet:history" },
          { text: "🏠 Trang chủ", callbackData: "shop:home" },
        ],
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
    const rest = message.buttons.filter(
      (row) =>
        !row.some(
          (button) =>
            (button.callbackData ?? "").startsWith("pay:refresh:") ||
            (button.callbackData ?? "").startsWith("pay:cancel:") ||
            (button.callbackData ?? "").startsWith("pay:reopen:"),
        ),
    );
    return {
      ...message,
      buttons: [
        [{ text: "Kiểm tra nạp ví", callbackData: "wallet:topup:status" }],
        [{ text: "Đổi số tiền", callbackData: "wallet:topup:change" }],
        [{ text: "Huỷ", callbackData: "wallet:topup:cancel" }],
        ...rest,
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
  const rootConfig = {
    adminTelegramUserId: config.ADMIN_TELEGRAM_USER_ID,
    expectedUsername: config.ADMIN_EXPECTED_USERNAME,
  };
  const stepUpOptions = {
    ttlSeconds: config.ADMIN_STEP_UP_TTL_SECONDS,
    lockoutMinutes: config.ADMIN_STEP_UP_LOCKOUT_MINUTES,
    maxAttempts: config.ADMIN_STEP_UP_MAX_ATTEMPTS,
  };
  const stepUp = createStepUpService(dbHandle.db, vault, stepUpOptions);
  // The worker's half of the sensitive surface (warranty refunds, the TOTP
  // enrolment/verification commands) asks the same one layer the admin callbacks
  // do, so neither path can drift from the policy table.
  const sensitiveDeps: SensitiveActionDeps = {
    db: dbHandle.db,
    rootConfig,
    vault,
    stepUpEnabled: config.ADMIN_STEP_UP_MODE === "required",
    stepUpOptions,
  };
  /**
   * The worker's call sites hold a dispatcher input (telegram id, chat type,
   * correlation id) rather than a RootActor, so this adapts the two shapes in one
   * place and every worker-side sensitive action then reads exactly like the
   * callbacks-side one.
   */
  /**
   * The money-bearing catalog and stock mutations refuse by THROWING (their signatures have
   * no room for a refusal code), so this turns that into the same step-up challenge screen
   * the warranty surfaces render. Without it a refused grant would dead-letter the inbox row
   * instead of telling the owner to verify. A non-refusal error is rethrown untouched.
   */
  const renderSensitiveRefusal = (
    error: unknown,
    action: string,
    category: string | null,
    challengeId: string,
  ): PresentedMessage | null =>
    error instanceof SensitiveAuthorizationRefusedError
      ? presentSensitiveRefusal({ code: error.code, action, category, challengeId })
      : null;
  const isSensitiveCallbackRefusal = (code: string): code is SensitiveAuthorizationRefusal =>
    code === "NOT_ROOT_ADMIN" ||
    code === "STEP_UP_REQUIRED" ||
    code === "STEP_UP_GRANT_MISSING" ||
    code === "STEP_UP_NOT_ENROLLED" ||
    code === "STEP_UP_LOCKED_OUT";
  const presentAdminHandleRefusal = (
    result: Extract<HandleResult, { ok: false }>,
    action: SensitiveActionKey,
    challengeId: string,
  ): PresentedMessage =>
    result.code === "WRONG_CONTEXT"
      ? presentAdminDenied("WRONG_CONTEXT")
      : isSensitiveCallbackRefusal(result.code)
        ? presentSensitiveRefusal({
            code: result.code,
            action,
            category: SENSITIVE_ACTION_POLICY[action],
            challengeId,
          })
        : presentAdminDenied("NOT_ROOT_ADMIN");

  const authorizeSensitiveFor = (
    input: { telegramUserId: string; chatType: string; correlationId: string },
    action: {
      actionKey: SensitiveActionKey;
      resourceType: string;
      resourceId: string;
      requestedData?: AuthorizationJsonValue;
      consumeGrant: boolean;
    },
  ) =>
    authorizeSensitiveAdminAction(sensitiveDeps, {
      actor: {
        numericUserId: Number(input.telegramUserId),
        // Every call site checks the private context first; any other context maps to a
        // non-private one so an unexpected chat type can never authorize.
        chatType: input.chatType === "private" ? "private" : "channel",
      },
      correlationId: input.correlationId,
      ...action,
      requestedData: action.requestedData ?? { targetId: action.resourceId },
    });
  const adminCallbacks = rootIdentity
    ? createAdminCallbacks({
        db: dbHandle.db,
        vault,
        rootConfig,
        rootChannelIdentityId: rootIdentity.channelIdentityId,
        confirmation: createAdminConfirmation(dbHandle.db),
        stepUpEnabled: config.ADMIN_STEP_UP_MODE === "required",
        stepUpOptions,
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
  /**
   * Wizard sub-flows (custom field / advanced fields / new category / custom description)
   * park a pending `admin_callback_state` row so the next text message is routed into the
   * sub-flow. Leaving that prompt must drop the row: otherwise the next ordinary wizard
   * answer is silently consumed as sub-flow input and the draft never advances.
   */
  const clearWizardSubFlowStates = async (telegramUserId: string): Promise<void> => {
    await sql`
      delete from admin_callback_state
      where admin_telegram_user_id = ${telegramUserId}
        and kind in (
          'WIZARD_CATEGORY_CREATE',
          'WIZARD_CUSTOM_FIELD',
          'WIZARD_ADVANCED',
          'WIZARD_DESC_CUSTOM'
        )
    `.execute(dbHandle.db);
  };
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
          select c.id, c.name_vi, c.parent_id
          from category c
          left join category p on p.id = c.parent_id
          where c.is_active
          order by coalesce(p.sort_order, c.sort_order), coalesce(c.parent_id, c.id),
                   (c.parent_id is not null), c.sort_order, c.id
          limit 40
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
    telegramClient,
  );
  try {
    await ensureTelegramCommandMenu({
      botToken: config.TELEGRAM_BOT_TOKEN,
      adminTelegramUserId: config.ADMIN_TELEGRAM_USER_ID,
      client: telegramClient,
    });
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.message : "unknown error" },
      "telegram command menu sync failed",
    );
  }
  const readStoreOpenCounts = () => getStoreOpenReadiness(dbHandle.db);
  const telegramDispatcher = createTelegramDomainDispatcher({
    codec: callbackCodec,
    resolveCustomerId,
    catalog,
    trust: {
      async page(customerId, page) {
        if (!config.SOCIAL_PROOF_HMAC_KEY)
          return { text: "Màn hình uy tín chưa được cấu hình.", buttons: [] };
        return presentCustomerTrustScreen(
          await listTrustScreen(dbHandle.db, {
            page,
            pageSize: 5,
            aliasKey: config.SOCIAL_PROOF_HMAC_KEY,
          }),
        );
      },
    },
    uiSurface: createPostgresUiSurfaceRegistry(dbHandle.db),
    checkout,
    history,
    support,
    resolveOrderByIdForOwner: (orderId, customerId) =>
      findOrderByIdForOwner(dbHandle.db, orderId, customerId),
    resolveOrderIdByNumber: async (orderNumber) =>
      (await findOrderByNumberInternal(dbHandle.db, orderNumber))?.id ?? null,
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
          // Isolates our own handler work: render_ms is taken after the reply is sent, so it also
          // carries both Telegram round trips and cannot answer a latency target on its own.
          server_render_ms: event.serverRenderMs,
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
          return { text: msg, buttons: preorderHomeButtons };
        }
        // Consent is not a purchase: the hold stays WAITING_DEPOSIT until SePay evidence
        // confirms the deposit, so the customer must be handed the deposit QR here — never
        // a "thành công" that money has not earned.
        return await presentOwnedPreorderLeg({
          customerId: input.customerId,
          reservationId: res.reservationId,
          correlationId: input.correlationId,
        });
      },
      async pay(input) {
        return await presentOwnedPreorderLeg(input);
      },
      async list(customerId) {
        return presentCustomerPreorders(await listCustomerPreorders(dbHandle.db, customerId));
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
          text: `Cài đặt thông báo: cập nhật ${p.shopUpdates ? "bật" : "tắt"}, hoạt động ${p.purchaseActivity ? "bật" : "tắt"}. Bấm “🛍 Cập nhật sản phẩm” hoặc “📣 Hoạt động mua hàng” để đổi trạng thái.`,
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
            [
              { text: "🧾 Đơn hàng", callbackData: "ord:list" },
              { text: "💬 Hỗ trợ", callbackData: "sup:open" },
            ],
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
      const profile = await sql<{ display_name: string | null; username: string | null }>`
        select display_name, username
        from customer_profile_snapshot
        where customer_id = ${customerId}
        limit 1
      `.execute(dbHandle.db);
      const completed = await sql<{ count: string }>`
        select count(*)::text as count
        from "order"
        where customer_id = ${customerId} and status = 'COMPLETED'
      `.execute(dbHandle.db);
      const preferences = await notificationService.getNotificationPreferences(
        dbHandle.db,
        customerId,
      );
      return presentCustomerAccount({
        displayName: profile.rows[0]?.display_name ?? profile.rows[0]?.username ?? "bạn",
        balanceVnd: account.balanceVnd,
        completedOrders: Number(completed.rows[0]?.count ?? "0"),
        shopUpdates: preferences.shopUpdates,
        purchaseActivity: preferences.purchaseActivity,
      });
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
          ? walletTopupPaymentScreen(
              await presentPaymentScreen(result.presentation, {
                status: "PENDING",
                profilePatch: {
                  showPaymentCheckButton: false,
                  showCancelButton: false,
                  showOrderCodeCopyButton: false,
                },
              }),
            )
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
      const orderId = (await findOrderByNumberForOwner(dbHandle.db, orderNumber, customerId))?.id;
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
              [
                { text: "Xem đơn", callbackData: `ord:view:${orderId}` },
                { text: "Menu chính", callbackData: "menu:main" },
              ],
            ],
          }
        : {
            text: result.message,
            buttons: [
              [
                { text: "Nạp ví", callbackData: "wallet:topup" },
                { text: "Đơn hàng", callbackData: "ord:list" },
              ],
            ],
          };
    },
    async walletHistory(ctx) {
      const customerId = await resolveCustomerId(ctx.telegramUserId);
      if (!customerId)
        return {
          text: "Không xác minh được khách hàng.",
          buttons: [[{ text: "Menu chính", callbackData: "menu:main" }]],
        };
      const account = await walletLedger.ensureAccount(customerId);
      return presentWalletHistory({
        balanceVnd: account ? BigInt(account.balanceVnd) : 0n,
        entries: await listWalletLedgerEntries(dbHandle.db, customerId),
      });
    },
    async warrantyHome(customerId) {
      const rows = await sql<{ order_number: string; product_name_vi: string }>`
        select order_number, product_name_vi
        from "order"
        where customer_id = ${customerId} and status = 'COMPLETED'
        order by created_at desc, id desc
        limit 20
      `.execute(dbHandle.db);
      return presentCustomerWarrantyHome(
        rows.rows.map((row) => ({
          orderNumber: row.order_number,
          productNameVi: row.product_name_vi,
        })),
      );
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
      async orderReconcile(input) {
        if (
          Number(input.telegramUserId) !== config.ADMIN_TELEGRAM_USER_ID ||
          input.chatType !== "private"
        )
          return presentAdminDenied("NOT_ROOT_ADMIN");
        if (!adminCallbacks) return presentAdminDenied("NOT_ROOT_ADMIN");
        const resolutionCode = input.resolutionCode ?? "PARK_REVIEW";
        const state = await resolveAdminOrderState(dbHandle.db, {
          adminTelegramUserId: input.telegramUserId,
          stateId: input.stateId,
        });
        if (!state?.orderId) {
          return {
            text: "Phiên đơn hàng đã hết hạn.",
            buttons: [[{ text: "Đơn hàng", callbackData: "admin:orders" }]],
          };
        }
        const current = await sql<{
          version: number;
          status: string;
          fulfillment_status: string | null;
        }>`
          select
            o.version,
            o.status,
            (
              select b.status
              from delivery_bundle b
              where b.order_id = o.id
              order by b.created_at desc, b.id desc
              limit 1
            ) as fulfillment_status
          from "order" o
          where o.id = ${state.orderId}
          limit 1
        `.execute(dbHandle.db);
        const row = current.rows[0];
        if (!row) {
          return {
            text: "Không tìm thấy đơn hàng.",
            buttons: [[{ text: "Đơn hàng", callbackData: "admin:orders" }]],
          };
        }
        const parkReview = row.status === "PROCESSING" && row.fulfillment_status === "EXPIRED";
        const resolveReview = row.status === "FULFILLMENT_NEEDS_REVIEW";
        if (resolutionCode === "PARK_REVIEW" ? !parkReview : !resolveReview) {
          return {
            text: "Trạng thái giao hàng đã thay đổi; mở lại đơn để kiểm tra.",
            buttons: [[{ text: "Đơn hàng", callbackData: `admin:orders:view:${input.stateId}` }]],
          };
        }
        const reason =
          resolutionCode === "RECONCILE_DELIVERED"
            ? "Xác nhận đã giao dựa trên bằng chứng Telegram đã lưu."
            : resolutionCode === "KEEP_UNCERTAIN"
              ? "Giữ đơn ở trạng thái chưa xác định vì bằng chứng giao hàng chưa đủ."
              : "Đưa sai lệch giao hàng đã thanh toán vào rà soát owner.";
        const result = await adminCallbacks.handle({
          command: "fulfillment.reconcile",
          actor: { numericUserId: Number(input.telegramUserId), chatType: input.chatType },
          targetId: state.orderId,
          expectedVersion: row.version,
          resolutionCode,
          reason,
          correlationId: input.correlationId,
        });
        if (!result.ok)
          return presentAdminHandleRefusal(result, "fulfillment.reconcile", input.correlationId);
        return result.needsConfirmation
          ? presentHighRiskChallenge({
              confirmationId: result.confirmationId,
              challenge: result.challenge,
              expiresAt: result.expiresAt,
              action: "fulfillment.reconcile",
            })
          : presentHighRiskDone("fulfillment.reconcile");
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
        const sent = await handleAdminCustomerFreeText(dbHandle.db, {
          adminTelegramUserId: ctx.telegramUserId,
          text: input.text,
          actorId: String(ctx.telegramUserId),
          correlationId: ctx.correlationId,
        });
        // This command carries its own content; without a pending draft there is nothing to send, and
        // the old fall-through showed the customer list, which is not an answer to `/message_customer`.
        return (
          sent ?? {
            text: "Chưa có phiên soạn tin nào đang mở. Mở hồ sơ khách rồi chọn «Gửi tin» để soạn.",
            buttons: [[{ text: "👥 Khách hàng", callbackData: "admin:customers" }]],
          }
        );
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
          return presentAdminHandleRefusal(
            result,
            "support.replacement.approve",
            input.correlationId,
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
      async supportTickets(input) {
        if (input.chatType !== "private") return presentAdminDenied("WRONG_CONTEXT");
        const denied = await requireRootAdmin(
          adminCallbacks,
          input,
          "admin-support",
          "Admin support",
        );
        if (denied) return presentAdminDenied(denied);
        return presentAdminSupportTickets(await listOpenTickets(dbHandle.db));
      },
      async supportTicket(input) {
        if (input.chatType !== "private") return presentAdminDenied("WRONG_CONTEXT");
        const denied = await requireRootAdmin(
          adminCallbacks,
          input,
          input.ticketId,
          "Admin support",
        );
        if (denied) return presentAdminDenied(denied);
        const ticket = await getAdminTicket(dbHandle.db, input.ticketId);
        if (!ticket) return adminSupportError("Không tìm thấy yêu cầu hỗ trợ.");
        return presentAdminSupportTicket(ticket);
      },
      async supportTicketStatus(input) {
        if (input.chatType !== "private") return presentAdminDenied("WRONG_CONTEXT");
        const denied = await requireRootAdmin(
          adminCallbacks,
          input,
          input.ticketId,
          "Admin support",
        );
        if (denied) return presentAdminDenied(denied);
        const result = await setTicketStatus({
          db: dbHandle.db,
          ticketId: input.ticketId,
          toStatus: input.toStatus,
          actorId: input.telegramUserId,
          correlationId: input.correlationId,
        });
        if (!result.ok)
          return adminSupportError(
            result.code === "NOT_FOUND"
              ? "Không tìm thấy yêu cầu hỗ trợ."
              : "Trạng thái này không còn phù hợp.",
          );
        // Stable per transition, so a replayed tap cannot message the customer twice.
        const notified = await queueAdminCustomerMessage(dbHandle.db, {
          customerId: result.customerId,
          content:
            SUPPORT_TICKET_CUSTOMER_MESSAGE[result.to] ??
            "Yêu cầu hỗ trợ của bạn vừa được cập nhật.",
          actorId: input.telegramUserId,
          correlationId: `admin-support-status:${input.ticketId}:${result.from}:${result.to}`,
        });
        const ticket = await getAdminTicket(dbHandle.db, input.ticketId);
        if (!ticket) return adminSupportError("Không tìm thấy yêu cầu hỗ trợ.");
        const screen = presentAdminSupportTicket(ticket);
        return {
          ...screen,
          text: `${screen.text}\n\n${
            notified ? "Đã thông báo cho khách." : "Khách chưa có kênh nhận thông báo."
          }`,
        };
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
          return presentAdminHandleRefusal(
            result,
            "manual_fulfillment.complete",
            input.correlationId,
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
          ? presentAdminMenu(await getStoreMode(dbHandle.db), await getAdminOverview(dbHandle.db))
          : presentAdminDenied(
              result.code === "WRONG_CONTEXT" ? "WRONG_CONTEXT" : "NOT_ROOT_ADMIN",
            );
      },
      async storeMode(input) {
        if (input.chatType !== "private") return presentAdminDenied("WRONG_CONTEXT");
        if (Number(input.telegramUserId) !== config.ADMIN_TELEGRAM_USER_ID)
          return presentAdminDenied("NOT_ROOT_ADMIN");
        return presentAdminStoreMode(await getStoreControl(dbHandle.db));
      },
      async storeTest(input) {
        if (input.chatType !== "private") return presentAdminDenied("WRONG_CONTEXT");
        if (!adminCallbacks) return presentAdminDenied("NOT_ROOT_ADMIN");
        const control = await getStoreControl(dbHandle.db);
        const result = await adminCallbacks.handle({
          command: "store.test",
          actor: { numericUserId: Number(input.telegramUserId), chatType: input.chatType },
          targetId: "main",
          expectedVersion: control.version,
          reason: "Bật chế độ TEST — chỉ khách test mua được sản phẩm test",
          correlationId: input.correlationId,
        });
        if (!result.ok) return presentAdminHandleRefusal(result, "store.test", input.correlationId);
        return result.needsConfirmation
          ? presentHighRiskChallenge({
              confirmationId: result.confirmationId,
              challenge: result.challenge,
              expiresAt: result.expiresAt,
              action: "store.test",
            })
          : presentAdminStoreMode(await getStoreControl(dbHandle.db));
      },
      async storeOpen(input) {
        if (input.chatType !== "private") return presentAdminDenied("WRONG_CONTEXT");
        if (Number(input.telegramUserId) !== config.ADMIN_TELEGRAM_USER_ID)
          return presentAdminDenied("NOT_ROOT_ADMIN");
        const control = await getStoreControl(dbHandle.db);
        if (control.status !== "CLOSED") return presentAdminStoreMode(control);
        const readiness = await readStoreOpenCounts();
        if (!isStoreOpenReady(readiness))
          return presentAdminStoreOpenBlocked({ readiness, control });
        return presentAdminStoreOpenConfirmation(readiness);
      },
      async storeOpenConfirm(input) {
        if (input.chatType !== "private") return presentAdminDenied("WRONG_CONTEXT");
        if (!adminCallbacks) return presentAdminDenied("NOT_ROOT_ADMIN");
        const control = await getStoreControl(dbHandle.db);
        if (control.status !== "CLOSED") return presentAdminStoreMode(control);
        const readiness = await readStoreOpenCounts();
        if (!isStoreOpenReady(readiness))
          return presentAdminStoreOpenBlocked({ readiness, control });
        const result = await adminCallbacks.handle({
          command: "store.open",
          actor: { numericUserId: Number(input.telegramUserId), chatType: input.chatType },
          targetId: "main",
          expectedVersion: control.version,
          reason: "Mở bán công khai (xác nhận qua nút)",
          correlationId: input.correlationId,
        });
        if (!result.ok) return presentAdminHandleRefusal(result, "store.open", input.correlationId);
        return result.needsConfirmation
          ? presentHighRiskChallenge({
              confirmationId: result.confirmationId,
              challenge: result.challenge,
              expiresAt: result.expiresAt,
              action: "store.open",
            })
          : presentAdminStoreMode(await getStoreControl(dbHandle.db));
      },
      async storeClose(input) {
        if (input.chatType !== "private") return presentAdminDenied("WRONG_CONTEXT");
        if (!adminCallbacks) return presentAdminDenied("NOT_ROOT_ADMIN");
        const control = await getStoreControl(dbHandle.db);
        const result = await adminCallbacks.handle({
          command: "store.close",
          actor: { numericUserId: Number(input.telegramUserId), chatType: input.chatType },
          targetId: "main",
          expectedVersion: control.version,
          reason: "Đóng cửa hàng tạm dừng bán",
          correlationId: input.correlationId,
        });
        if (!result.ok)
          return presentAdminHandleRefusal(result, "store.close", input.correlationId);
        return result.needsConfirmation
          ? presentHighRiskChallenge({
              confirmationId: result.confirmationId,
              challenge: result.challenge,
              expiresAt: result.expiresAt,
              action: "store.close",
            })
          : presentAdminStoreMode(await getStoreControl(dbHandle.db));
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
      async health(input) {
        if (input.chatType !== "private") return presentAdminDenied("WRONG_CONTEXT");
        if (Number(input.telegramUserId) !== config.ADMIN_TELEGRAM_USER_ID)
          return presentAdminDenied("NOT_ROOT_ADMIN");
        const facts = await getAdminHealthFacts(dbHandle.db);
        return presentAdminSystemHealth({
          // The worker can read its own identity, but a partial/stale deploy is exactly what this
          // screen diagnoses, so the API is asked for its own live identity too. A failure here is
          // itself the finding, so it degrades to an explicit string instead of hiding.
          workerCommit: loadBuildIdentity(import.meta.url)?.commit ?? "unknown",
          builtAt: loadBuildIdentity(import.meta.url)?.builtAt ?? "unknown",
          apiCommit: await readApiBuildCommit(),
          storeMode: await getStoreMode(dbHandle.db),
          database: facts.database,
          vaultDriver: config.VAULT_DRIVER,
          telegramWebhook: config.TELEGRAM_WEBHOOK_SECRET ? "CONFIGURED" : "MISSING",
          sepayReconciliation: formatSePayReconciliationAdminText(
            await getSePayReconciliationStatus(dbHandle.db),
          ),
          queues: facts.queues,
        });
      },
      async notifications(input) {
        if (input.chatType !== "private") return presentAdminDenied("WRONG_CONTEXT");
        if (Number(input.telegramUserId) !== config.ADMIN_TELEGRAM_USER_ID)
          return presentAdminDenied("NOT_ROOT_ADMIN");
        const [outbox, prefs] = await Promise.all([
          getAdminHealthFacts(dbHandle.db),
          sql<{ recipients: number; opt_outs: number }>`
            select count(*)::int as recipients,
                   count(*) filter (where marketing_opt_in = false)::int as opt_outs
            from customer_notification_preference
          `.execute(dbHandle.db),
        ]);
        return presentAdminNotifications({
          transactionalKinds: [
            "Thanh toán thành công",
            "Giao hàng",
            "Đặt cọc",
            "Hàng về (báo có hàng)",
            "Hoàn tiền",
            "Bảo hành",
            "Hỗ trợ",
          ],
          marketingRecipients: prefs.rows[0]?.recipients ?? 0,
          marketingOptOuts: prefs.rows[0]?.opt_outs ?? 0,
          outboxBacklog: outbox.queues.outboxBacklog,
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
        const view: AdminProductView = isAdminProductView(input.view) ? input.view : "all";
        const page = Number.isInteger(input.page) && (input.page ?? 0) > 0 ? input.page! : 1;
        const pageSize = 12;
        const filter =
          view === "featured"
            ? sql`where p.is_featured`
            : view === "inactive"
              ? sql`where not p.is_active and not p.is_archived`
              : view === "archived"
                ? sql`where p.is_archived`
                : view === "test"
                  ? sql`where p.is_test`
                  : sql``;
        // One row over the page tells us whether to offer "Xem thêm" without a count query.
        const result = await sql<{
          id: string;
          name: string;
          active: boolean;
          featured: boolean;
          test: boolean;
        }>`
          select p.id, p.name_vi as name, p.is_active as active, p.is_featured as featured,
                 p.is_test as test
          from product p
          ${filter}
          order by p.sort_order asc, p.id asc
          limit ${pageSize + 1} offset ${(page - 1) * pageSize}
        `.execute(dbHandle.db);
        const hasMore = result.rows.length > pageSize;
        return presentAdminProducts(result.rows.slice(0, pageSize), { view, page, hasMore });
      },
      /** Goal §11 — featured is a product flag the owner toggles, on an existing product too. */
      async operations(input) {
        if (input.chatType !== "private") return presentAdminDenied("WRONG_CONTEXT");
        if (!adminCallbacks) return presentAdminDenied("NOT_ROOT_ADMIN");
        const gate = await adminCallbacks.handle({
          command: "order.inspect",
          actor: { numericUserId: Number(input.telegramUserId), chatType: "private" },
          targetId: "admin-operations",
          reason: "Admin operations readiness access",
          correlationId: input.correlationId,
        });
        if (!gate.ok)
          return presentAdminDenied(
            gate.code === "WRONG_CONTEXT" ? "WRONG_CONTEXT" : "NOT_ROOT_ADMIN",
          );
        const publicationBlocked = await countAdminPublicationBlockers(dbHandle.db);
        // The operations and health screens use the same queue predicates, but they are separate reads
        // and may differ transiently while concurrent work commits.
        const [health, stock] = await Promise.all([
          getAdminHealthFacts(dbHandle.db),
          sql<{ stock_account_not_ready: number }>`
            select
              (select count(*)::int from product_variant v
                join product p on p.id = v.product_id
                where v.is_active and p.is_active and not p.is_test and not p.is_archived
                  and v.fulfillment_type = 'STOCK_ACCOUNT'
                  and not exists (select 1 from digital_asset a where a.variant_id = v.id and a.status = 'AVAILABLE')) as stock_account_not_ready
          `.execute(dbHandle.db),
        ]);
        return presentAdminOperations({
          control: await getStoreControl(dbHandle.db),
          database: health.database,
          publicationBlocked,
          openDiscrepancies: health.queues.openDiscrepancies,
          resolvedDiscrepancies: health.queues.resolvedDiscrepancies,
          terminalOutboxOrphans: health.queues.outboxDeadLettered,
          terminalOutboxOrphansDisposed: health.queues.outboxDeadLetteredDisposed,
          openSupportTickets: health.queues.openSupportTickets,
          criticalSupportTickets: health.queues.criticalSupportTickets,
          stockAccountNotReady: stock.rows[0]?.stock_account_not_ready ?? 0,
        });
      },
      async productFeature(input) {
        if (!adminCallbacks) return presentAdminDenied("NOT_ROOT_ADMIN");
        if (input.chatType !== "private") return presentAdminDenied("WRONG_CONTEXT");
        const gate = await adminCallbacks.handle({
          command: "order.inspect",
          actor: { numericUserId: Number(input.telegramUserId), chatType: input.chatType },
          targetId: input.productId,
          reason: "Admin product featured toggle",
          correlationId: input.correlationId,
        });
        if (!gate.ok)
          return presentAdminDenied(
            gate.code === "WRONG_CONTEXT" ? "WRONG_CONTEXT" : "NOT_ROOT_ADMIN",
          );
        const current = await sql<{ is_featured: boolean }>`
          select is_featured from product where id = ${input.productId} limit 1
        `.execute(dbHandle.db);
        if (!current.rows[0])
          return {
            text: "Sản phẩm không còn hợp lệ.",
            buttons: [[{ text: "🛍 Sản phẩm", callbackData: "admin:products" }]],
          };
        const { setProductFeatured } = await import("./modules/catalog/repository.js");
        const next = !current.rows[0].is_featured;
        await setProductFeatured(dbHandle.db, input.productId, next);
        await appendAuditEvent(dbHandle.db, {
          actorType: "ROOT_ADMIN",
          actorId: String(input.telegramUserId),
          action: next ? "product.featured" : "product.unfeatured",
          targetType: "Product",
          targetId: input.productId,
          reason: "Owner toggled featured",
          correlationId: input.correlationId,
          metadataRedacted: { isFeatured: next },
        });
        return {
          text: next
            ? "⭐ Đã ghim sản phẩm vào mục nổi bật."
            : "☆ Đã bỏ ghim sản phẩm khỏi mục nổi bật.",
          buttons: [
            [
              {
                text: "↩️ Chi tiết sản phẩm",
                callbackData: `admin:products:detail:${input.productId}`,
              },
            ],
            [
              { text: "🛍 Sản phẩm", callbackData: "admin:products" },
              { text: "⌂ Trang quản trị", callbackData: "admin:menu" },
            ],
          ],
        };
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
          is_featured: boolean;
        }>`
          select
            p.id,
            p.name_vi as name,
            p.slug,
            c.name_vi as category_name,
            p.short_description_vi as description,
            p.is_active as active,
            p.is_featured,
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
            buttons: [[{ text: "🛍 Sản phẩm", callbackData: "admin:products" }]],
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
          isFeatured: row.is_featured,
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
      async productReadiness(input) {
        if (input.chatType !== "private") return presentAdminDenied("WRONG_CONTEXT");
        if (!adminCallbacks) return presentAdminDenied("NOT_ROOT_ADMIN");
        const gate = await adminCallbacks.handle({
          command: "order.inspect",
          actor: { numericUserId: Number(input.telegramUserId), chatType: "private" },
          targetId: input.productId,
          reason: "Admin product publication readiness access",
          correlationId: input.correlationId,
        });
        if (!gate.ok)
          return presentAdminDenied(
            gate.code === "WRONG_CONTEXT" ? "WRONG_CONTEXT" : "NOT_ROOT_ADMIN",
          );
        const product = await sql<{ name: string }>`
          select name_vi as name from product where id = ${input.productId} limit 1
        `.execute(dbHandle.db);
        const readiness = await getProductPublicationReadiness(dbHandle.db, input.productId);
        if (!readiness || !product.rows[0])
          return {
            text: "Sản phẩm không còn hợp lệ.",
            buttons: [[{ text: "🛍 Sản phẩm", callbackData: "admin:products" }]],
          };
        return presentAdminProductReadiness({
          name: product.rows[0].name,
          readiness,
          canSubmit: readiness.publicationVersion.length <= 300,
        });
      },
      async productEvidence(input) {
        if (input.chatType !== "private") return presentAdminDenied("WRONG_CONTEXT");
        if (!adminCallbacks) return presentAdminDenied("NOT_ROOT_ADMIN");
        const gate = await adminCallbacks.handle({
          command: "order.inspect",
          actor: { numericUserId: Number(input.telegramUserId), chatType: "private" },
          targetId: input.variantId,
          reason: "Admin resale evidence registration access",
          correlationId: input.correlationId,
        });
        if (!gate.ok)
          return presentAdminDenied(
            gate.code === "WRONG_CONTEXT" ? "WRONG_CONTEXT" : "NOT_ROOT_ADMIN",
          );
        const variant = await sql<{ product_id: string; name: string }>`
          select product_id, name_vi as name from product_variant where id = ${input.variantId} limit 1
        `.execute(dbHandle.db);
        const row = variant.rows[0];
        if (!row)
          return {
            text: "Biến thể không còn hợp lệ.",
            buttons: [[{ text: "🛍 Sản phẩm", callbackData: "admin:products" }]],
          };
        await createAdminCallbackState(dbHandle.db, {
          adminTelegramUserId: input.telegramUserId,
          kind: "ADMIN_RESALE_EVIDENCE_PROMPT",
          payload: { productId: row.product_id, variantId: input.variantId },
        });
        return presentAdminEvidencePrompt({
          productId: row.product_id,
          variantId: input.variantId,
          variantName: row.name,
        });
      },
      /**
       * `admin:products:evrevoke:<evidenceId>:<variantVersion>` off the readiness screen. The
       * button carried the two opaque halves and nothing else, so this screen re-reads the
       * evidence before it promises anything — a stale version, an already-revoked row or an
       * unknown id answers with a screen rather than a prompt — and parks the reason prompt in
       * admin_callback_state, exactly as the registration prompt does.
       */
      async evidenceRevoke(input) {
        if (input.chatType !== "private") return presentAdminDenied("WRONG_CONTEXT");
        if (!adminCallbacks) return presentAdminDenied("NOT_ROOT_ADMIN");
        const gate = await adminCallbacks.handle({
          command: "order.inspect",
          actor: { numericUserId: Number(input.telegramUserId), chatType: "private" },
          targetId: input.evidenceId,
          reason: "Admin resale evidence revocation access",
          correlationId: input.correlationId,
        });
        if (!gate.ok)
          return presentAdminDenied(
            gate.code === "WRONG_CONTEXT" ? "WRONG_CONTEXT" : "NOT_ROOT_ADMIN",
          );
        const row = (
          await sql<{
            id: string;
            variant_id: string;
            product_id: string;
            variant_name: string;
            variant_version: number;
            source: string;
            status: string;
            recorded_at: string;
          }>`
            select re.id, re.variant_id, re.source, re.status,
                   to_char(re.created_at, 'YYYY-MM-DD HH24:MI') as recorded_at,
                   v.product_id, v.name_vi as variant_name, v.version as variant_version
              from resale_evidence re
              join product_variant v on v.id = re.variant_id
             where re.id = ${input.evidenceId}
             limit 1
          `.execute(dbHandle.db)
        ).rows[0];
        if (!row)
          return {
            text: "Bằng chứng không còn hợp lệ.",
            buttons: [[{ text: "🛍 Sản phẩm", callbackData: "admin:products" }]],
          };
        const back = [
          { text: "🚀 Readiness", callbackData: `admin:products:ready:${row.product_id}` },
        ];
        if (row.status !== "ACTIVE")
          return {
            text: "Bằng chứng không còn ở trạng thái ACTIVE nên không thể thu hồi.",
            buttons: [back],
          };
        if (row.variant_version !== input.expectedVersion)
          return {
            text: "Biến thể đã thay đổi từ lúc mở màn hình. Mở lại readiness rồi thu hồi lại.",
            buttons: [back],
          };
        if (!(RESALE_EVIDENCE_SOURCES as readonly string[]).includes(row.source))
          return { text: "Nguồn bằng chứng không hợp lệ.", buttons: [back] };
        await createAdminCallbackState(dbHandle.db, {
          adminTelegramUserId: input.telegramUserId,
          kind: "ADMIN_RESALE_EVIDENCE_PROMPT",
          payload: {
            // Same state kind as the registration prompt, discriminated by intent: the typed
            // line means a reason here and a SOURCE|REFERENCE|SUMMARY triple there.
            intent: "REVOKE",
            productId: row.product_id,
            variantId: row.variant_id,
            evidenceId: row.id,
            expectedVersion: input.expectedVersion,
          },
        });
        return presentAdminEvidenceRevokePrompt({
          productId: row.product_id,
          variantName: row.variant_name,
          evidenceId: row.id,
          source: row.source as ResaleEvidenceSource,
          recordedAt: row.recorded_at,
          variantVersion: input.expectedVersion,
        });
      },
      async productPublish(input) {
        if (input.chatType !== "private") return presentAdminDenied("WRONG_CONTEXT");
        if (!adminCallbacks) return presentAdminDenied("NOT_ROOT_ADMIN");
        const gate = await adminCallbacks.handle({
          command: "order.inspect",
          actor: { numericUserId: Number(input.telegramUserId), chatType: "private" },
          targetId: input.productId,
          reason: "Admin product publication access",
          correlationId: input.correlationId,
        });
        if (!gate.ok)
          return presentAdminDenied(
            gate.code === "WRONG_CONTEXT" ? "WRONG_CONTEXT" : "NOT_ROOT_ADMIN",
          );
        const [product, readiness] = await Promise.all([
          sql<{
            name: string;
          }>`select name_vi as name from product where id = ${input.productId} limit 1`.execute(
            dbHandle.db,
          ),
          getProductPublicationReadiness(dbHandle.db, input.productId),
        ]);
        if (!readiness || !product.rows[0])
          return {
            text: "Sản phẩm không còn hợp lệ.",
            buttons: [[{ text: "🛍 Sản phẩm", callbackData: "admin:products" }]],
          };
        if (!readiness.canPublish)
          return presentAdminProductReadiness({
            name: product.rows[0].name,
            readiness,
            canSubmit: readiness.publicationVersion.length <= 300,
          });
        const result = await adminCallbacks.handle({
          command: "catalog.publish",
          actor: { numericUserId: Number(input.telegramUserId), chatType: "private" },
          targetId: input.productId,
          expectedVersion: readiness.publicationVersion,
          reason: "Xuất bản sản phẩm sau khi kiểm tra readiness và bằng chứng",
          correlationId: input.correlationId,
        });
        if (!result.ok) {
          if (result.code === "WRONG_CONTEXT" || isSensitiveCallbackRefusal(result.code))
            return presentAdminHandleRefusal(result, "catalog.publish", input.correlationId);
          return {
            text: "Không thể tạo yêu cầu xuất bản; readiness hoặc phiên bản đã thay đổi. Mở lại để kiểm tra.",
            buttons: [
              [{ text: "🚀 Readiness", callbackData: `admin:products:ready:${input.productId}` }],
            ],
          };
        }
        return result.needsConfirmation
          ? presentHighRiskChallenge({
              confirmationId: result.confirmationId,
              challenge: result.challenge,
              expiresAt: result.expiresAt,
              action: "catalog.publish",
            })
          : presentAdminProductReadiness({
              name: product.rows[0].name,
              readiness:
                (await getProductPublicationReadiness(dbHandle.db, input.productId)) ?? readiness,
              canSubmit: true,
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
            compare_at_price_vnd: string | null;
            preorder_enabled: boolean;
            deposit_amount_vnd: string;
            is_active: boolean;
            version: number;
          }>`select id, product_id, name_vi as name, sku, price_vnd::text as price_vnd, duration_code, warranty_days, low_stock_threshold, compare_at_price_vnd::text as compare_at_price_vnd, preorder_enabled, deposit_amount_vnd::text as deposit_amount_vnd, is_active, version from product_variant where id=${input.variantId} limit 1`.execute(
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
        // The field buttons must not carry the variant id: Telegram caps callback data at 64 bytes,
        // and `admin:products:variant-field:<id>:<key>` overflowed for three of the five fields, which
        // the ingress drops silently. The id rides in this state instead, exactly as the product
        // content edit does it.
        // One editor at a time: clear older menu states for this admin so a click on an older message's
        // field cannot accidentally modify another variant.
        await sql`
          delete from admin_callback_state
           where admin_telegram_user_id = ${input.telegramUserId}
             and kind = 'ADMIN_VARIANT_UPDATE'
             and not (payload_redacted ? 'field')
        `.execute(dbHandle.db);
        await createAdminCallbackState(dbHandle.db, {
          adminTelegramUserId: input.telegramUserId,
          kind: "ADMIN_VARIANT_UPDATE",
          payload: { productId: row.product_id, variantId: row.id },
          ttlMinutes: 30,
        });
        return presentAdminVariantDraft({
          productId: row.product_id,
          sku: row.sku,
          current: {
            name: row.name,
            priceVnd: `${BigInt(row.price_vnd).toLocaleString("vi-VN")} ₫`,
            compareAtPriceVnd:
              row.compare_at_price_vnd === null
                ? "(không đặt)"
                : `${BigInt(row.compare_at_price_vnd).toLocaleString("vi-VN")} ₫`,
            durationCode: row.duration_code,
            active: row.is_active ? "Đang bán" : "Đang tắt",
            preorderEnabled: row.preorder_enabled ? "Có" : "Không",
            depositAmountVnd: `${BigInt(row.deposit_amount_vnd).toLocaleString("vi-VN")} ₫`,
            lowStockThreshold:
              row.low_stock_threshold === null ? "(không đặt)" : String(row.low_stock_threshold),
            warrantyDays: `${row.warranty_days} ngày`,
          },
        });
      },
      /**
       * Goal §78: a boolean field is answered with a button, so it never becomes something the owner
       * types. The pending field state decides which field and which version this applies to, so a
       * stale button cannot flip a field the owner is no longer looking at.
       */
      async variantEditToggle(input) {
        if (input.chatType !== "private") return presentAdminDenied("WRONG_CONTEXT");
        if (!adminCallbacks) return presentAdminDenied("NOT_ROOT_ADMIN");
        const rows = await sql<{ payload_redacted: Record<string, unknown> }>`
          select payload_redacted from admin_callback_state
           where admin_telegram_user_id = ${input.telegramUserId}
             and kind = 'ADMIN_VARIANT_UPDATE'
             and payload_redacted ? 'field'
             and expires_at > now()
           order by created_at desc
           limit 1
        `.execute(dbHandle.db);
        const payload = rows.rows[0]?.payload_redacted;
        const productId = typeof payload?.productId === "string" ? payload.productId : null;
        const variantId = typeof payload?.variantId === "string" ? payload.variantId : null;
        const field = typeof payload?.field === "string" ? payload.field : null;
        const expectedVersion =
          typeof payload?.expectedVersion === "number" ? payload.expectedVersion : null;
        const back = (text: string) => ({
          text,
          buttons: [
            ...(productId
              ? [
                  [
                    {
                      text: "🛍 Sản phẩm",
                      callbackData: `admin:products:detail:${productId}`,
                    },
                  ],
                ]
              : []),
          ],
        });
        if (!productId || !variantId || !field || !expectedVersion)
          return back("Phiên sửa biến thể đã hết hạn.");
        if (field !== input.fieldKey) return back("Mục này không còn là mục đang sửa.");
        const row = (
          await sql<{ deposit_amount_vnd: string }>`
            select deposit_amount_vnd::text as deposit_amount_vnd from product_variant where id = ${variantId} limit 1
          `.execute(dbHandle.db)
        ).rows[0];
        if (field === "preorderEnabled" && input.on && (row?.deposit_amount_vnd ?? "0") === "0")
          return back("Hãy đặt tiền cọc trước khi bật đặt cọc.");
        const patch =
          field === "active"
            ? { active: input.on }
            : field === "preorderEnabled"
              ? { preorderEnabled: input.on }
              : null;
        if (!patch) return back("Mục này không phải lựa chọn bật/tắt.");
        const gate = await adminCallbacks.handle({
          command: "order.inspect",
          actor: { numericUserId: Number(input.telegramUserId), chatType: "private" },
          targetId: productId,
          reason: "Admin variant toggle",
          correlationId: input.correlationId,
        });
        if (!gate.ok)
          return presentAdminDenied(
            gate.code === "WRONG_CONTEXT" ? "WRONG_CONTEXT" : "NOT_ROOT_ADMIN",
          );
        let ok: boolean;
        try {
          ok = await updateAdminVariant({
            actor: { numericUserId: Number(input.telegramUserId), chatType: "private" },
            config: {
              adminTelegramUserId: config.ADMIN_TELEGRAM_USER_ID,
              expectedUsername: config.ADMIN_EXPECTED_USERNAME,
            },
            db: dbHandle.db,
            // A toggle can flip `preorder_enabled`, which is a monetary rule, so the
            // money-field gate needs the step-up deps even on this path.
            sensitiveDeps,
            productId,
            variantId,
            expectedVersion,
            ...patch,
            reason: "Admin variant toggle",
            correlationId: input.correlationId,
          });
        } catch (error) {
          const refusal = renderSensitiveRefusal(
            error,
            "catalog.variant.price.change",
            "BULK_PRICE_CHANGE",
            input.correlationId,
          );
          if (refusal) return refusal;
          throw error;
        }
        if (!ok) return back("Biến thể đã thay đổi ở nơi khác, mở lại để sửa.");
        await sql`
          delete from admin_callback_state
           where admin_telegram_user_id = ${input.telegramUserId}
             and kind = 'ADMIN_VARIANT_UPDATE'
             and payload_redacted ? 'field'
        `.execute(dbHandle.db);
        const named = await sql<{ name: string }>`
          select name_vi as name from product_variant where id = ${variantId} limit 1
        `.execute(dbHandle.db);
        return presentAdminVariantMutationDone({
          productId,
          variantName: named.rows[0]?.name ?? "biến thể",
          action: "updated",
        });
      },
      /**
       * Goal §78/§172: the owner picked one field off the variant editor. The prompt asks for that
       * value alone, and the state it writes is what vouches for the reply — free text with no such
       * state open falls through to the rest of the text chain.
       */
      async ownerPromptText(input) {
        if (input.chatType !== "private") return presentAdminDenied("WRONG_CONTEXT");
        if (Number(input.telegramUserId) !== config.ADMIN_TELEGRAM_USER_ID)
          return presentAdminDenied("NOT_ROOT_ADMIN");
        const pending = await sql<{ id: string; kind: string; payload: Record<string, unknown> }>`
          select id, kind, payload_redacted as payload
            from admin_callback_state
           where admin_telegram_user_id = ${input.telegramUserId}
             and kind in ('ADMIN_RESALE_EVIDENCE_PROMPT','ADMIN_PAYMENT_DISPOSITION_PROMPT','ADMIN_OUTBOX_DISPOSITION_PROMPT')
             and expires_at > now()
           order by created_at desc, id desc
           limit 1
        `.execute(dbHandle.db);
        const state = pending.rows[0];
        if (!state || !adminCallbacks) return null;
        const payload = state.payload ?? {};
        const actor = { numericUserId: Number(input.telegramUserId), chatType: "private" as const };
        if (state.kind === "ADMIN_RESALE_EVIDENCE_PROMPT" && payload.intent !== "REVOKE") {
          const variantId = typeof payload.variantId === "string" ? payload.variantId : null;
          const productId = typeof payload.productId === "string" ? payload.productId : null;
          const fields = input.text.split("|").map((value) => value.trim());
          const source = fields[0];
          if (
            !variantId ||
            !productId ||
            fields.length !== 3 ||
            !source ||
            !(RESALE_EVIDENCE_SOURCES as readonly string[]).includes(source)
          ) {
            return {
              text: "Định dạng không hợp lệ. Gửi đúng: NGUỒN|MÃ THAM CHIẾU|TÓM TẮT AN TOÀN",
              buttons: [
                [{ text: "↩️ Readiness", callbackData: `admin:products:ready:${productId ?? ""}` }],
              ],
            };
          }
          const result = await adminCallbacks.handle({
            command: "catalog.evidence.register",
            actor,
            targetId: variantId,
            input: fields.join("|"),
            reason: "Đăng ký bằng chứng nguồn nhập hàng qua Telegram",
            correlationId: input.correlationId,
          });
          if (!result.ok)
            return {
              text: result.message,
              buttons: [
                [{ text: "🧾 Nhập lại", callbackData: `admin:products:evidence:${variantId}` }],
              ],
            };
          await sql`delete from admin_callback_state where id = ${state.id} and admin_telegram_user_id = ${input.telegramUserId}`.execute(
            dbHandle.db,
          );
          if (result.needsConfirmation)
            return presentHighRiskChallenge({
              confirmationId: result.confirmationId,
              challenge: result.challenge,
              expiresAt: result.expiresAt,
              action: "catalog.evidence.register",
            });
          return {
            text: "✅ Đã đăng ký yêu cầu bằng chứng. Mở lại readiness để kiểm tra.",
            buttons: [
              [{ text: "🚀 Readiness", callbackData: `admin:products:ready:${productId}` }],
            ],
          };
        }
        const note = input.text.trim();
        if (!note || note.length > 200) {
          return { text: "Ghi chú phải có 1–200 ký tự. Gửi lại một dòng ngắn.", buttons: [] };
        }
        if (state.kind === "ADMIN_RESALE_EVIDENCE_PROMPT" && payload.intent === "REVOKE") {
          const variantId = typeof payload.variantId === "string" ? payload.variantId : null;
          const productId = typeof payload.productId === "string" ? payload.productId : null;
          const evidenceId = typeof payload.evidenceId === "string" ? payload.evidenceId : null;
          const expectedVersion =
            typeof payload.expectedVersion === "number" ? payload.expectedVersion : null;
          if (!variantId || !productId || !evidenceId || expectedVersion === null) return null;
          const result = await adminCallbacks.handle({
            command: "catalog.evidence.revoke",
            actor,
            targetId: variantId,
            input: evidenceId,
            expectedVersion,
            reason: note,
            correlationId: input.correlationId,
          });
          if (!result.ok)
            return {
              text: result.message,
              buttons: [
                [
                  {
                    text: "🔁 Nhập lại lý do",
                    callbackData: `admin:products:evrevoke:${evidenceId}:${expectedVersion}`,
                  },
                ],
                [{ text: "🚀 Readiness", callbackData: `admin:products:ready:${productId}` }],
              ],
            };
          // The prompt state is dropped only now that a durable command exists: a refused
          // issue leaves it in place, so the owner can retry the same line exactly as the
          // registration and disposition prompts do.
          await sql`delete from admin_callback_state where id = ${state.id} and admin_telegram_user_id = ${input.telegramUserId}`.execute(
            dbHandle.db,
          );
          if (result.needsConfirmation)
            return presentHighRiskChallenge({
              confirmationId: result.confirmationId,
              challenge: result.challenge,
              expiresAt: result.expiresAt,
              action: "catalog.evidence.revoke",
            });
          return {
            text: "✅ Đã thu hồi bằng chứng. Hãy đăng ký bằng chứng mới rồi mở lại readiness và xuất bản lại.",
            buttons: [
              [{ text: "🚀 Readiness", callbackData: `admin:products:ready:${productId}` }],
            ],
          };
        }
        if (state.kind === "ADMIN_PAYMENT_DISPOSITION_PROMPT") {
          const discrepancyId =
            typeof payload.discrepancyId === "string" ? payload.discrepancyId : null;
          const expectedVersion =
            typeof payload.expectedVersion === "number" ? payload.expectedVersion : null;
          const resolutionCode =
            typeof payload.resolutionCode === "string" ? payload.resolutionCode : null;
          if (
            !discrepancyId ||
            expectedVersion === null ||
            !resolutionCode ||
            !isDiscrepancyResolutionCode(resolutionCode)
          )
            return null;
          const result = await adminCallbacks.handle({
            command: "discrepancy.resolve",
            actor,
            targetId: discrepancyId,
            expectedVersion,
            resolutionCode,
            reason: note,
            correlationId: input.correlationId,
          });
          if (!result.ok)
            return {
              text: result.message,
              buttons: [[{ text: "⬅️ Sai lệch", callbackData: "admin:payments:discrepancy" }]],
            };
          await sql`delete from admin_callback_state where id = ${state.id} and admin_telegram_user_id = ${input.telegramUserId}`.execute(
            dbHandle.db,
          );
          return result.needsConfirmation
            ? presentHighRiskChallenge({
                confirmationId: result.confirmationId,
                challenge: result.challenge,
                expiresAt: result.expiresAt,
                action: "discrepancy.resolve",
              })
            : {
                // Request recorded, not resolved: only a successful /confirm says completed.
                text: "⏳ Đã ghi nhận yêu cầu xử lý sai lệch. Chỉ xác nhận thành công mới coi là đã xử lý.",
                buttons: [[{ text: "⚠️ Sai lệch", callbackData: "admin:payments:discrepancy" }]],
              };
        }
        const eventId = typeof payload.eventId === "string" ? payload.eventId : null;
        const expectedVersion =
          typeof payload.expectedVersion === "number" ? payload.expectedVersion : null;
        const dispositionCode =
          typeof payload.resolutionCode === "string" ? payload.resolutionCode : null;
        if (
          !eventId ||
          expectedVersion === null ||
          !dispositionCode ||
          !isOutboxDispositionCode(dispositionCode)
        )
          return null;
        const result = await adminCallbacks.handle({
          command: "outbox.orphan.dispose",
          actor,
          targetId: eventId,
          expectedVersion,
          resolutionCode: dispositionCode,
          reason: note,
          correlationId: input.correlationId,
        });
        if (!result.ok)
          return {
            text: result.message,
            buttons: [[{ text: "⬅️ Outbox treo", callbackData: "admin:payments:outbox" }]],
          };
        await sql`delete from admin_callback_state where id = ${state.id} and admin_telegram_user_id = ${input.telegramUserId}`.execute(
          dbHandle.db,
        );
        return result.needsConfirmation
          ? presentHighRiskChallenge({
              confirmationId: result.confirmationId,
              challenge: result.challenge,
              expiresAt: result.expiresAt,
              action: "outbox.orphan.dispose",
            })
          : {
              // Request recorded, not resolved: only a successful /confirm says completed.
              text: "⏳ Đã ghi nhận yêu cầu xử lý outbox terminal. Chỉ xác nhận thành công mới coi là đã xử lý.",
              buttons: [[{ text: "🧯 Outbox treo", callbackData: "admin:payments:outbox" }]],
            };
      },
      /** Goal §95: the payment queues behind the admin payment screen. */
      async paymentsView(input) {
        if (input.chatType !== "private") return presentAdminDenied("WRONG_CONTEXT");
        if (!adminCallbacks) return presentAdminDenied("NOT_ROOT_ADMIN");
        const view = input.view;
        const gate = await adminCallbacks.handle({
          command: "order.inspect",
          actor: { numericUserId: Number(input.telegramUserId), chatType: "private" },
          targetId: `admin-payments-${view}`,
          reason: "Admin payment queue access",
          correlationId: input.correlationId,
        });
        if (!gate.ok)
          return presentAdminDenied(
            gate.code === "WRONG_CONTEXT" ? "WRONG_CONTEXT" : "NOT_ROOT_ADMIN",
          );

        if (view === "outbox") {
          const rows = await listTerminalOutboxOrphans(dbHandle.db);
          return presentAdminOutboxOrphans({
            rows: rows.map((row) => ({
              id: row.id,
              eventType: row.eventType,
              lastErrorCode: row.lastErrorCode,
              attemptCount: row.attemptCount,
              dispositionStatus: row.dispositionStatus,
            })),
          });
        }
        const [route, id, code] = view.split(":");
        if (route === "o" && id) {
          const detail = await getTerminalOutboxOrphan(dbHandle.db, id);
          return detail
            ? presentAdminOutboxDetail(detail)
            : {
                text: "Không tìm thấy outbox treo hoặc event đã không còn terminal.",
                buttons: [[{ text: "⬅️ Thanh toán", callbackData: "admin:payments" }]],
              };
        }
        if ((route === "d" || route === "r") && id) {
          const detail = await getAdminDiscrepancyDetail(dbHandle.db, id);
          if (!detail)
            return {
              text: "Không tìm thấy sai lệch hoặc dữ liệu đã thay đổi.",
              buttons: [[{ text: "⬅️ Sai lệch", callbackData: "admin:payments:discrepancy" }]],
            };
          if (route === "d") return presentAdminDiscrepancyDetail(detail);
          if (!code || !isDiscrepancyResolutionCode(code))
            return presentAdminDiscrepancyDetail(detail);
          await createAdminCallbackState(dbHandle.db, {
            adminTelegramUserId: input.telegramUserId,
            kind: "ADMIN_PAYMENT_DISPOSITION_PROMPT",
            payload: {
              discrepancyId: detail.id,
              expectedVersion: detail.version,
              resolutionCode: code,
            },
          });
          return presentAdminNotePrompt({
            title: "⚠️ GHI NHẬN XỬ LÝ SAI LỆCH",
            action: code,
            back: `admin:payments:d:${detail.id}`,
          });
        }
        if (route === "x" && id) {
          const detail = await getTerminalOutboxOrphan(dbHandle.db, id);
          if (!detail) {
            return {
              text: "Không tìm thấy outbox treo hoặc event đã không còn terminal.",
              buttons: [[{ text: "⬅️ Outbox treo", callbackData: "admin:payments:outbox" }]],
            };
          }
          if (!code || !isOutboxDispositionCode(code)) return presentAdminOutboxDetail(detail);
          await createAdminCallbackState(dbHandle.db, {
            adminTelegramUserId: input.telegramUserId,
            kind: "ADMIN_OUTBOX_DISPOSITION_PROMPT",
            payload: {
              eventId: detail.orphan.id,
              expectedVersion: detail.orphan.dispositionVersion,
              resolutionCode: code,
            },
          });
          return presentAdminNotePrompt({
            title: "🧯 ĐÓNG OUTBOX TERMINAL",
            action: code,
            back: `admin:payments:o:${detail.orphan.id}`,
          });
        }
        const standardView = ADMIN_PAYMENT_OPS_VIEWS.find((entry) => entry.view === view)?.view;
        if (!standardView)
          return {
            text: "Mục thanh toán không hợp lệ.",
            buttons: [[{ text: "💳 Thanh toán", callbackData: "admin:payments" }]],
          };
        const page = await listAdminPaymentOps(dbHandle.db, standardView, 20);
        return presentAdminPaymentOps({
          ...page,
          ...(standardView === "unmatched" || standardView === "discrepancy"
            ? { rowCallbackPrefix: "admin:payments:d:" }
            : {}),
        });
      },
      async variantEditField(input) {
        if (input.chatType !== "private") return presentAdminDenied("WRONG_CONTEXT");
        if (!adminCallbacks) return presentAdminDenied("NOT_ROOT_ADMIN");
        const field = ADMIN_VARIANT_FIELDS.find((entry) => entry.key === input.fieldKey);
        const pending = await sql<{ payload_redacted: Record<string, unknown> }>`
          select payload_redacted from admin_callback_state
           where admin_telegram_user_id = ${input.telegramUserId}
             and kind = 'ADMIN_VARIANT_UPDATE'
             and not (payload_redacted ? 'field')
             and expires_at > now()
           order by created_at desc
           limit 1
        `.execute(dbHandle.db);
        const pendingPayload = pending.rows[0]?.payload_redacted;
        const variantId =
          typeof pendingPayload?.variantId === "string" ? pendingPayload.variantId : null;
        const row = variantId
          ? (
              await sql<{
                id: string;
                product_id: string;
                name: string;
                price_vnd: string;
                duration_code: string;
                warranty_days: number;
                low_stock_threshold: number | null;
                compare_at_price_vnd: string | null;
                preorder_enabled: boolean;
                deposit_amount_vnd: string;
                is_active: boolean;
                version: number;
              }>`select id, product_id, name_vi as name, price_vnd::text as price_vnd, duration_code, warranty_days, low_stock_threshold, compare_at_price_vnd::text as compare_at_price_vnd, preorder_enabled, deposit_amount_vnd::text as deposit_amount_vnd, is_active, version from product_variant where id=${variantId} limit 1`.execute(
                dbHandle.db,
              )
            ).rows[0]
          : undefined;
        if (!field || !row)
          return {
            text: "Biến thể không còn hợp lệ.",
            buttons: [[{ text: "🛍 Sản phẩm", callbackData: "admin:products" }]],
          };
        const gate = await adminCallbacks.handle({
          command: "order.inspect",
          actor: { numericUserId: Number(input.telegramUserId), chatType: "private" },
          targetId: row.product_id,
          reason: "Admin variant field edit",
          correlationId: input.correlationId,
        });
        if (!gate.ok)
          return presentAdminDenied(
            gate.code === "WRONG_CONTEXT" ? "WRONG_CONTEXT" : "NOT_ROOT_ADMIN",
          );
        await createAdminCallbackState(dbHandle.db, {
          adminTelegramUserId: input.telegramUserId,
          kind: "ADMIN_VARIANT_UPDATE",
          payload: {
            productId: row.product_id,
            variantId: row.id,
            field: field.key,
            expectedVersion: row.version,
          },
          ttlMinutes: 10,
        });
        const current: Record<(typeof ADMIN_VARIANT_FIELDS)[number]["key"], string> = {
          name: row.name,
          priceVnd: `${BigInt(row.price_vnd).toLocaleString("vi-VN")} ₫`,
          compareAtPriceVnd:
            row.compare_at_price_vnd === null
              ? "(không đặt)"
              : `${BigInt(row.compare_at_price_vnd).toLocaleString("vi-VN")} ₫`,
          durationCode: row.duration_code,
          active: row.is_active ? "Đang bán" : "Đang tắt",
          preorderEnabled: row.preorder_enabled ? "Có" : "Không",
          depositAmountVnd: `${BigInt(row.deposit_amount_vnd).toLocaleString("vi-VN")} ₫`,
          lowStockThreshold:
            row.low_stock_threshold === null ? "(không đặt)" : String(row.low_stock_threshold),
          warrantyDays: `${row.warranty_days} ngày`,
        };
        const hints: Record<(typeof ADMIN_VARIANT_FIELDS)[number]["key"], string> = {
          name: "Gửi tên mới trong một tin nhắn.",
          priceVnd: "Gửi giá mới bằng số nguyên VND, ví dụ 280000.",
          compareAtPriceVnd:
            "Gửi giá gạch ngang bằng số nguyên VND, ví dụ 350000. Gửi - để bỏ giá gạch ngang.",
          durationCode: "Gửi mã thời hạn, ví dụ P1M hoặc P12M.",
          active: "Chọn bên dưới.",
          preorderEnabled:
            "Chọn bên dưới. Bật đặt cọc cần có tiền cọc — đặt tiền cọc trước nếu đang là 0 ₫.",
          depositAmountVnd: "Gửi số tiền cọc bằng số nguyên VND, ví dụ 50000.",
          lowStockThreshold: "Gửi ngưỡng cảnh báo sắp hết. Gửi - để xoá ngưỡng.",
          warrantyDays: "Gửi số ngày bảo hành, ví dụ 30. Gửi 0 nếu không bảo hành.",
        };
        return presentAdminVariantFieldPrompt({
          productId: row.product_id,
          variantId: row.id,
          fieldKey: field.key,
          label: field.label,
          current: current[field.key],
          hint: hints[field.key],
          ...(field.kind === "toggle"
            ? { toggleOn: field.key === "active" ? row.is_active : row.preorder_enabled }
            : {}),
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
        const authorization = await authorizeSensitiveFor(input, {
          actionKey: "supplier.mapping.select",
          resourceType: "SupplierSku",
          resourceId: input.supplierSkuId,
          requestedData: { variantId, supplierSkuId: input.supplierSkuId },
          consumeGrant: true,
        });
        if (!authorization.ok)
          return presentSensitiveRefusal({
            code: authorization.code,
            action: "supplier.mapping.select",
            category: "SUPPLIER_CONFIG",
            challengeId: input.correlationId,
          });
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
        const authorization = await authorizeSensitiveFor(input, {
          actionKey: "supplier.mapping.clear",
          resourceType: "ProductVariant",
          resourceId: input.variantId,
          requestedData: { variantId: input.variantId },
          consumeGrant: true,
        });
        if (!authorization.ok)
          return presentSensitiveRefusal({
            code: authorization.code,
            action: "supplier.mapping.clear",
            category: "SUPPLIER_CONFIG",
            challengeId: input.correlationId,
          });
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
        const authorization = await authorizeSensitiveFor(input, {
          actionKey: "supplier.mapping.verify",
          resourceType: "SupplierSku",
          resourceId: input.supplierSkuId,
          requestedData: { variantId, supplierSkuId: input.supplierSkuId },
          consumeGrant: true,
        });
        if (!authorization.ok)
          return presentSensitiveRefusal({
            code: authorization.code,
            action: "supplier.mapping.verify",
            category: "SUPPLIER_CONFIG",
            challengeId: input.correlationId,
          });
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
        if (!result.ok) {
          if (result.code === "WRONG_CONTEXT") return presentAdminDenied("WRONG_CONTEXT");
          if (isSensitiveActionKey(command))
            return presentAdminHandleRefusal(result, command, input.correlationId);
          return presentAdminDenied("NOT_ROOT_ADMIN");
        }
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
        if (result.ok) return presentHighRiskDone("admin.confirm");
        if (result.code === "NOT_READY" || result.code === "ACTION_REFUSED") {
          return {
            text: result.message,
            buttons: [[{ text: "⌂ Trang quản trị", callbackData: "admin:menu" }]],
          };
        }
        if (isSensitiveCallbackRefusal(result.code)) {
          // A root-gate denial carries no action; the presenter only needs one for a step-up.
          const refusedAction =
            result.action && isSensitiveActionKey(result.action) ? result.action : null;
          return presentSensitiveRefusal({
            code: result.code,
            action: refusedAction ?? "admin.confirm",
            category: refusedAction ? SENSITIVE_ACTION_POLICY[refusedAction] : null,
            challengeId: input.correlationId,
          });
        }
        return {
          text: "❌ Xác nhận thất bại hoặc đã hết hạn",
          buttons: [[{ text: "⌂ Trang quản trị", callbackData: "admin:menu" }]],
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
      /** Goal §17/§18/§19/§25/§26/§31–§33: the owner's warranty surface. */
      async warrantyQueue(input) {
        if (input.chatType !== "private") return presentAdminDenied("WRONG_CONTEXT");
        if (!adminCallbacks) return presentAdminDenied("NOT_ROOT_ADMIN");
        const gate = await adminCallbacks.handle({
          command: "order.inspect",
          actor: { numericUserId: Number(input.telegramUserId), chatType: input.chatType },
          targetId: "admin-warranty",
          reason: "Admin warranty queue",
          correlationId: input.correlationId,
        });
        if (!gate.ok)
          return presentAdminDenied(
            gate.code === "WRONG_CONTEXT" ? "WRONG_CONTEXT" : "NOT_ROOT_ADMIN",
          );
        const view = isWarrantyQueueView(input.view) ? input.view : "new";
        const counts = await warrantyQueueCounts(dbHandle.db);
        const rows = await warrantyQueueRows(dbHandle.db, view);
        return presentAdminWarrantyQueue({ view, counts, rows });
      },
      async warrantyClaim(input) {
        if (input.chatType !== "private") return presentAdminDenied("WRONG_CONTEXT");
        if (!adminCallbacks) return presentAdminDenied("NOT_ROOT_ADMIN");
        const gate = await adminCallbacks.handle({
          command: "order.inspect",
          actor: { numericUserId: Number(input.telegramUserId), chatType: input.chatType },
          targetId: input.claimId,
          reason: "Admin warranty claim access",
          correlationId: input.correlationId,
        });
        if (!gate.ok)
          return presentAdminDenied(
            gate.code === "WRONG_CONTEXT" ? "WRONG_CONTEXT" : "NOT_ROOT_ADMIN",
          );
        const claim = await loadAdminWarrantyClaim(dbHandle.db, input.claimId);
        if (!claim) return adminWarrantyError("Không tìm thấy yêu cầu bảo hành.");
        return presentAdminWarrantyClaim(claim);
      },
      async warrantyVerify(input) {
        if (input.chatType !== "private") return presentAdminDenied("WRONG_CONTEXT");
        const denied = await requireRootAdmin(
          adminCallbacks,
          input,
          input.claimId,
          "Admin warranty",
        );
        if (denied) return presentAdminDenied(denied);
        const result = await verifyClaimDefect({
          db: dbHandle.db,
          actor: { numericUserId: Number(input.telegramUserId), chatType: input.chatType },
          config: {
            adminTelegramUserId: config.ADMIN_TELEGRAM_USER_ID,
            expectedUsername: config.ADMIN_EXPECTED_USERNAME,
          },
          claimId: input.claimId,
          correlationId: input.correlationId,
        });
        if (!result.ok) return adminWarrantyError(adminClaimErrorText(result.code));
        const claim = await loadAdminWarrantyClaim(dbHandle.db, input.claimId);
        return presentAdminWarrantyActionDone({
          claimNumber: claim?.claimNumber ?? input.claimId,
          claimId: input.claimId,
          message: "Đã xác nhận lỗi thuộc phạm vi bảo hành.",
        });
      },
      async warrantyInfo(input) {
        if (input.chatType !== "private") return presentAdminDenied("WRONG_CONTEXT");
        const denied = await requireRootAdmin(
          adminCallbacks,
          input,
          input.claimId,
          "Admin warranty",
        );
        if (denied) return presentAdminDenied(denied);
        const result = await requestClaimInfo({
          db: dbHandle.db,
          actor: { numericUserId: Number(input.telegramUserId), chatType: input.chatType },
          config: {
            adminTelegramUserId: config.ADMIN_TELEGRAM_USER_ID,
            expectedUsername: config.ADMIN_EXPECTED_USERNAME,
          },
          claimId: input.claimId,
          note: "Shop cần bạn bổ sung mô tả hoặc ảnh chụp tình trạng tài khoản.",
          correlationId: input.correlationId,
        });
        if (!result.ok) return adminWarrantyError(adminClaimErrorText(result.code));
        const claim = await loadAdminWarrantyClaim(dbHandle.db, input.claimId);
        return presentAdminWarrantyActionDone({
          claimNumber: claim?.claimNumber ?? input.claimId,
          claimId: input.claimId,
          message: "Đã gửi yêu cầu bổ sung thông tin cho khách.",
        });
      },
      async warrantyRejectReason(input) {
        if (input.chatType !== "private") return presentAdminDenied("WRONG_CONTEXT");
        const denied = await requireRootAdmin(
          adminCallbacks,
          input,
          input.claimId,
          "Admin warranty",
        );
        if (denied) return presentAdminDenied(denied);
        const claim = await loadAdminWarrantyClaim(dbHandle.db, input.claimId);
        if (!claim) return adminWarrantyError("Không tìm thấy yêu cầu bảo hành.");
        return presentAdminWarrantyRejectReason({
          claimId: claim.id,
          claimNumber: claim.claimNumber,
        });
      },
      async warrantyReject(input) {
        if (input.chatType !== "private") return presentAdminDenied("WRONG_CONTEXT");
        const denied = await requireRootAdmin(
          adminCallbacks,
          input,
          input.claimId,
          "Admin warranty",
        );
        if (denied) return presentAdminDenied(denied);
        const reason = decodeURIComponent(input.reason);
        const result = await rejectClaim({
          db: dbHandle.db,
          actor: { numericUserId: Number(input.telegramUserId), chatType: input.chatType },
          config: {
            adminTelegramUserId: config.ADMIN_TELEGRAM_USER_ID,
            expectedUsername: config.ADMIN_EXPECTED_USERNAME,
          },
          claimId: input.claimId,
          reason,
          correlationId: input.correlationId,
        });
        if (!result.ok) return adminWarrantyError(adminClaimErrorText(result.code));
        const claim = await loadAdminWarrantyClaim(dbHandle.db, input.claimId);
        return presentAdminWarrantyActionDone({
          claimNumber: claim?.claimNumber ?? input.claimId,
          claimId: input.claimId,
          message: `Đã từ chối: ${reason}`,
        });
      },
      async warrantyReplace(input) {
        if (input.chatType !== "private") return presentAdminDenied("WRONG_CONTEXT");
        const denied = await requireRootAdmin(
          adminCallbacks,
          input,
          input.claimId,
          "Admin warranty",
        );
        if (denied) return presentAdminDenied(denied);
        const authorization = await authorizeSensitiveFor(input, {
          actionKey: "warranty.replacement.approve",
          resourceType: "WarrantyClaim",
          resourceId: input.claimId,
          consumeGrant: true,
        });
        if (!authorization.ok)
          return presentSensitiveRefusal({
            code: authorization.code,
            action: "warranty.replacement.approve",
            category: "DELIVERY_REISSUE",
            challengeId: input.correlationId,
          });
        const result = await approveClaimReplacement({
          db: dbHandle.db,
          actor: { numericUserId: Number(input.telegramUserId), chatType: input.chatType },
          config: {
            adminTelegramUserId: config.ADMIN_TELEGRAM_USER_ID,
            expectedUsername: config.ADMIN_EXPECTED_USERNAME,
          },
          claimId: input.claimId,
          deliveryBaseUrl: config.APP_BASE_URL,
          bundleTtlSeconds: config.DELIVERY_BUNDLE_TTL_SECONDS,
          correlationId: input.correlationId,
        });
        if (!result.ok) return adminWarrantyError(adminClaimErrorText(result.code));
        const claim = await loadAdminWarrantyClaim(dbHandle.db, input.claimId);
        return presentAdminWarrantyActionDone({
          claimNumber: claim?.claimNumber ?? input.claimId,
          claimId: input.claimId,
          message: "Đã duyệt đổi tài khoản và gửi thông tin nhận hàng mới cho khách.",
        });
      },
      /** Goal §25: the refund confirmation, with the calculation spelled out before approving. */
      async warrantyRefund(input) {
        if (input.chatType !== "private") return presentAdminDenied("WRONG_CONTEXT");
        const denied = await requireRootAdmin(
          adminCallbacks,
          input,
          input.claimId,
          "Admin warranty",
        );
        if (denied) return presentAdminDenied(denied);
        // The refund screen is where the owner learns a second factor is needed, so the grant is
        // only previewed here (consumeGrant: false) and spent by warrantyRefundConfirm.
        const authorization = await authorizeSensitiveFor(input, {
          actionKey: "warranty.refund.approve",
          resourceType: "WarrantyClaim",
          resourceId: input.claimId,
          consumeGrant: false,
        });
        if (!authorization.ok)
          return presentSensitiveRefusal({
            code: authorization.code,
            action: "warranty.refund.approve",
            category: "REFUND",
            challengeId: input.correlationId,
          });
        const claim = await loadAdminWarrantyClaim(dbHandle.db, input.claimId);
        if (!claim) return adminWarrantyError("Không tìm thấy yêu cầu bảo hành.");
        return presentAdminRefundConfirm({
          claimId: claim.id,
          claimNumber: claim.claimNumber,
          paidAmountVnd: claim.paidAmountVnd,
          warrantyDays: claim.usedDays + claim.remainingDays,
          usedDays: claim.usedDays,
          remainingDays: claim.remainingDays,
          recommendedVnd: claim.calculatedRefundVnd,
          accountNumber: claim.accountNumber,
        });
      },
      async warrantyRefundConfirm(input) {
        if (input.chatType !== "private") return presentAdminDenied("WRONG_CONTEXT");
        const denied = await requireRootAdmin(
          adminCallbacks,
          input,
          input.claimId,
          "Admin warranty",
        );
        if (denied) return presentAdminDenied(denied);
        const authorization = await authorizeSensitiveFor(input, {
          actionKey: "warranty.refund.approve",
          resourceType: "WarrantyClaim",
          resourceId: input.claimId,
          consumeGrant: true,
        });
        if (!authorization.ok)
          return presentSensitiveRefusal({
            code: authorization.code,
            action: "warranty.refund.approve",
            category: "REFUND",
            challengeId: input.correlationId,
          });
        const result = await approveClaimRefund({
          db: dbHandle.db,
          actor: { numericUserId: Number(input.telegramUserId), chatType: input.chatType },
          config: {
            adminTelegramUserId: config.ADMIN_TELEGRAM_USER_ID,
            expectedUsername: config.ADMIN_EXPECTED_USERNAME,
          },
          claimId: input.claimId,
          correlationId: input.correlationId,
        });
        if (!result.ok) return adminWarrantyError(adminClaimErrorText(result.code));
        const claim = await loadAdminWarrantyClaim(dbHandle.db, input.claimId);
        return presentAdminWarrantyActionDone({
          claimNumber: claim?.claimNumber ?? input.claimId,
          claimId: input.claimId,
          message:
            "Đã duyệt hoàn tiền. Shop chuyển khoản thủ công, sau đó xác nhận trong mục Chờ hoàn tiền.",
        });
      },
      async warrantyRefundAdjust(input) {
        if (input.chatType !== "private") return presentAdminDenied("WRONG_CONTEXT");
        const denied = await requireRootAdmin(
          adminCallbacks,
          input,
          input.claimId,
          "Admin warranty",
        );
        if (denied) return presentAdminDenied(denied);
        const claim = await loadAdminWarrantyClaim(dbHandle.db, input.claimId);
        if (!claim) return adminWarrantyError("Không tìm thấy yêu cầu bảo hành.");
        // One pending prompt at a time: an older unexpired row would otherwise claim the next
        // unrelated message the owner sends.
        await sql`
          delete from admin_callback_state
          where admin_telegram_user_id = ${input.telegramUserId}
            and kind = 'WARRANTY_REFUND_ADJUST_PROMPT'
        `.execute(dbHandle.db);
        await createAdminCallbackState(dbHandle.db, {
          adminTelegramUserId: input.telegramUserId,
          kind: "WARRANTY_REFUND_ADJUST_PROMPT",
          payload: { claimId: input.claimId, recommendedVnd: claim.calculatedRefundVnd.toString() },
        });
        return presentAdminRefundAdjustPrompt({
          claimId: input.claimId,
          recommendedVnd: claim.calculatedRefundVnd,
        });
      },
      async warrantyPayout(input) {
        if (input.chatType !== "private") return presentAdminDenied("WRONG_CONTEXT");
        const denied = await requireRootAdmin(
          adminCallbacks,
          input,
          input.claimId,
          "Admin warranty",
        );
        if (denied) return presentAdminDenied(denied);
        const claim = await loadAdminWarrantyClaim(dbHandle.db, input.claimId);
        if (!claim) return adminWarrantyError("Không tìm thấy yêu cầu bảo hành.");
        return presentAdminRefundPayout({
          claimId: claim.id,
          claimNumber: claim.claimNumber,
          customerLabel: claim.customerLabel,
          productName: claim.productName,
          amountVnd: claim.approvedRefundVnd ?? claim.calculatedRefundVnd,
          reason: `Bảo hành — ${claim.remainingDays} ngày chưa sử dụng`,
          bankName: claim.bankName,
          accountNumber: claim.accountNumber,
          accountHolder: claim.accountHolder,
        });
      },
      async warrantyPaid(input) {
        if (input.chatType !== "private") return presentAdminDenied("WRONG_CONTEXT");
        const denied = await requireRootAdmin(
          adminCallbacks,
          input,
          input.claimId,
          "Admin warranty",
        );
        if (denied) return presentAdminDenied(denied);
        const claim = await loadAdminWarrantyClaim(dbHandle.db, input.claimId);
        if (!claim) return adminWarrantyError("Không tìm thấy yêu cầu bảo hành.");
        return presentAdminRefundPaidConfirm({
          claimId: claim.id,
          claimNumber: claim.claimNumber,
          amountVnd: claim.approvedRefundVnd ?? claim.calculatedRefundVnd,
        });
      },
      async warrantyPaidConfirm(input) {
        if (input.chatType !== "private") return presentAdminDenied("WRONG_CONTEXT");
        const denied = await requireRootAdmin(
          adminCallbacks,
          input,
          input.claimId,
          "Admin warranty",
        );
        if (denied) return presentAdminDenied(denied);
        const result = await markRefundPaid({
          db: dbHandle.db,
          actor: { numericUserId: Number(input.telegramUserId), chatType: input.chatType },
          config: {
            adminTelegramUserId: config.ADMIN_TELEGRAM_USER_ID,
            expectedUsername: config.ADMIN_EXPECTED_USERNAME,
          },
          claimId: input.claimId,
          correlationId: input.correlationId,
        });
        if (!result.ok) return adminWarrantyError(adminClaimErrorText(result.code));
        const claim = await loadAdminWarrantyClaim(dbHandle.db, input.claimId);
        return presentAdminWarrantyActionDone({
          claimNumber: claim?.claimNumber ?? input.claimId,
          claimId: input.claimId,
          message: "Đã ghi nhận chuyển khoản. Khách đã được thông báo.",
        });
      },
      async warrantyRefundQueue(input) {
        if (input.chatType !== "private") return presentAdminDenied("WRONG_CONTEXT");
        const denied = await requireRootAdmin(
          adminCallbacks,
          input,
          "admin-warranty",
          "Admin warranty",
        );
        if (denied) return presentAdminDenied(denied);
        const rows = await warrantyQueueRows(dbHandle.db, "refund_due");
        return presentAdminRefundQueue(rows);
      },
      async inventoryItems(input) {
        if (input.chatType !== "private") return presentAdminDenied("WRONG_CONTEXT");
        if (!adminCallbacks) return presentAdminDenied("NOT_ROOT_ADMIN");
        const gate = await adminCallbacks.handle({
          command: "order.inspect",
          actor: { numericUserId: Number(input.telegramUserId), chatType: input.chatType },
          targetId: input.variantId,
          reason: "Admin inventory item access",
          correlationId: input.correlationId,
        });
        if (!gate.ok)
          return presentAdminDenied(
            gate.code === "WRONG_CONTEXT" ? "WRONG_CONTEXT" : "NOT_ROOT_ADMIN",
          );
        const variant = await sql<{ name_vi: string }>`
          select name_vi from product_variant where id = ${input.variantId} limit 1
        `.execute(dbHandle.db);
        if (!variant.rows[0]) {
          return {
            text: "Biến thể không còn hợp lệ.",
            buttons: [[{ text: "📦 Kho hàng", callbackData: "admin:inventory" }]],
          };
        }
        const { listInventoryItems } =
          await import("./modules/digital-goods/inventory-item-ops.js");
        const items = await listInventoryItems(dbHandle.db, { variantId: input.variantId });
        return presentAdminInventoryItems({
          variantId: input.variantId,
          variantName: variant.rows[0].name_vi,
          items,
        });
      },
      async inventoryItemActions(input) {
        if (input.chatType !== "private") return presentAdminDenied("WRONG_CONTEXT");
        if (!adminCallbacks) return presentAdminDenied("NOT_ROOT_ADMIN");
        const item = await lookupInventoryItemByRef(dbHandle.db, input.ref);
        const gate = await adminCallbacks.handle({
          command: "order.inspect",
          actor: { numericUserId: Number(input.telegramUserId), chatType: input.chatType },
          targetId: item?.variant_id ?? input.ref,
          reason: "Admin inventory item access",
          correlationId: input.correlationId,
        });
        if (!gate.ok)
          return presentAdminDenied(
            gate.code === "WRONG_CONTEXT" ? "WRONG_CONTEXT" : "NOT_ROOT_ADMIN",
          );
        if (!item) {
          return {
            text: "Mục kho không còn hợp lệ.",
            buttons: [[{ text: "📦 Kho hàng", callbackData: "admin:inventory" }]],
          };
        }
        const { listInventoryItems, ITEM_ACTION_LABELS } =
          await import("./modules/digital-goods/inventory-item-ops.js");
        const items = await listInventoryItems(dbHandle.db, { variantId: item.variant_id });
        const summary = items.find((row) => row.ref === input.ref);
        if (!summary) {
          return {
            text: "Mục kho không còn hợp lệ.",
            buttons: [[{ text: "📦 Kho hàng", callbackData: "admin:inventory" }]],
          };
        }
        return presentAdminInventoryItemActions({
          variantId: item.variant_id,
          variantName: item.variant_name,
          ref: summary.ref,
          statusLabel: summary.statusLabel,
          actions: summary.actions.map((action) => ({
            action,
            label: ITEM_ACTION_LABELS[action],
          })),
          readyRecovery:
            item.status === "READY" && Number.isInteger(item.version)
              ? { version: item.version }
              : undefined,
        });
      },
      async inventoryItemAction(input) {
        if (input.chatType !== "private") return presentAdminDenied("WRONG_CONTEXT");
        if (!adminCallbacks) return presentAdminDenied("NOT_ROOT_ADMIN");
        const item = await lookupInventoryItemByRef(dbHandle.db, input.ref);
        const gate = await adminCallbacks.handle({
          command: "order.inspect",
          actor: { numericUserId: Number(input.telegramUserId), chatType: input.chatType },
          targetId: item?.variant_id ?? input.ref,
          reason: "Admin inventory item action",
          correlationId: input.correlationId,
        });
        if (!gate.ok)
          return presentAdminDenied(
            gate.code === "WRONG_CONTEXT" ? "WRONG_CONTEXT" : "NOT_ROOT_ADMIN",
          );
        if (input.action === "READY_RELEASE") {
          if (!item || item.status !== "READY" || !Number.isInteger(item.version)) {
            return {
              text: "Mục READY không còn ở đúng phiên bản cần khôi phục.",
              buttons: [[{ text: "Dữ liệu kho", callbackData: "admin:inventory" }]],
            };
          }
          const result = await adminCallbacks.handle({
            command: "inventory.ready.release",
            actor: { numericUserId: Number(input.telegramUserId), chatType: input.chatType },
            targetId: item.id,
            expectedVersion: item.version,
            reason: "Owner confirmed READY asset recovery",
            correlationId: input.correlationId,
          });
          if (!result.ok)
            return presentAdminHandleRefusal(
              result,
              "inventory.ready.release",
              input.correlationId,
            );
          return result.needsConfirmation
            ? presentHighRiskChallenge({
                confirmationId: result.confirmationId,
                challenge: result.challenge,
                expiresAt: result.expiresAt,
                action: "inventory.ready.release",
              })
            : presentHighRiskDone("inventory.ready.release");
        }
        const { listInventoryItems, ITEM_ACTION_LABELS } =
          await import("./modules/digital-goods/inventory-item-ops.js");
        if (!(input.action in ITEM_ACTION_LABELS) || !item) {
          return {
            text: "Thao tác kho không hợp lệ.",
            buttons: [[{ text: "📦 Kho hàng", callbackData: "admin:inventory" }]],
          };
        }
        const action = input.action as keyof typeof ITEM_ACTION_LABELS;
        const items = await listInventoryItems(dbHandle.db, { variantId: item.variant_id });
        const summary = items.find((row) => row.ref === input.ref);
        if (!summary || !summary.actions.includes(action)) {
          return {
            text: "Thao tác này không áp dụng cho mục đang chọn.",
            buttons: [
              [{ text: "Dữ liệu kho", callbackData: `admin:inventory:items:${item.variant_id}` }],
            ],
          };
        }
        return presentAdminInventoryItemConfirm({
          variantId: item.variant_id,
          variantName: item.variant_name,
          ref: summary.ref,
          statusLabel: summary.statusLabel,
          action,
          actionLabel: ITEM_ACTION_LABELS[action],
        });
      },
      async inventoryItemConfirm(input) {
        if (input.chatType !== "private") return presentAdminDenied("WRONG_CONTEXT");
        if (!adminCallbacks) return presentAdminDenied("NOT_ROOT_ADMIN");
        const item = await lookupInventoryItemByRef(dbHandle.db, input.ref);
        const gate = await adminCallbacks.handle({
          command: "order.inspect",
          actor: { numericUserId: Number(input.telegramUserId), chatType: input.chatType },
          targetId: item?.variant_id ?? input.ref,
          reason: "Admin inventory item action",
          correlationId: input.correlationId,
        });
        if (!gate.ok)
          return presentAdminDenied(
            gate.code === "WRONG_CONTEXT" ? "WRONG_CONTEXT" : "NOT_ROOT_ADMIN",
          );
        const { applyInventoryItemAction, ITEM_ACTION_LABELS, ITEM_STATUS_LABELS } =
          await import("./modules/digital-goods/inventory-item-ops.js");
        if (!(input.action in ITEM_ACTION_LABELS) || !item) {
          return {
            text: "Thao tác kho không hợp lệ.",
            buttons: [[{ text: "📦 Kho hàng", callbackData: "admin:inventory" }]],
          };
        }
        const action = input.action as keyof typeof ITEM_ACTION_LABELS;
        const applied = await applyInventoryItemAction({
          db: dbHandle.db,
          actor: { numericUserId: Number(input.telegramUserId), chatType: input.chatType },
          config: {
            adminTelegramUserId: config.ADMIN_TELEGRAM_USER_ID,
            expectedUsername: config.ADMIN_EXPECTED_USERNAME,
          },
          variantId: item.variant_id,
          ref: input.ref,
          action,
          reason: input.reason,
          correlationId: input.correlationId,
        });
        if (!applied.ok) {
          const message =
            applied.code === "ILLEGAL_TRANSITION"
              ? "Mục này không còn ở trạng thái cho phép thao tác đó. Mở lại để xem trạng thái mới nhất."
              : applied.code === "NOT_FOUND"
                ? "Không tìm thấy mục kho."
                : "Không thể cập nhật mục kho.";
          return {
            text: message,
            buttons: [
              [{ text: "Dữ liệu kho", callbackData: `admin:inventory:items:${item.variant_id}` }],
            ],
          };
        }
        return presentAdminInventoryItemDone({
          variantId: item.variant_id,
          ref: applied.ref,
          actionLabel: ITEM_ACTION_LABELS[action],
          statusLabel: ITEM_STATUS_LABELS[applied.status] ?? applied.status.toLowerCase(),
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
        // Explicit actor gate. These text interceptors used to rely on the pending
        // `admin_callback_state` row being admin-scoped, which does work (only the owner can
        // create one) but makes the authorization implicit: a reader has to reason about who
        // could have written that row. Stating it here keeps the rule local and checkable.
        const textDenied = await requireRootAdmin(
          adminCallbacks,
          input,
          "admin-text",
          "Admin text input",
        );
        if (textDenied) return null;
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
        // Explicit actor gate. These text interceptors used to rely on the pending
        // `admin_callback_state` row being admin-scoped, which does work (only the owner can
        // create one) but makes the authorization implicit: a reader has to reason about who
        // could have written that row. Stating it here keeps the rule local and checkable.
        const textDenied = await requireRootAdmin(
          adminCallbacks,
          input,
          "admin-text",
          "Admin text input",
        );
        if (textDenied) return null;
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
        // The root gate, not just "is the feature configured". `adminCallbacks` is built once
        // from config, so a non-null value is true for EVERY caller - it proves the feature
        // exists, never that the actor is the owner. Without this call any Telegram user in a
        // private chat could send `admin:preorders:cancel:<id>` and cancel a reservation,
        // creating a real refund obligation. `requireRootAdmin` runs the numeric-id check and
        // audits the denial.
        const denied = await requireRootAdmin(
          adminCallbacks,
          input,
          route?.startsWith("preorders:cancel:")
            ? route.slice("preorders:cancel:".length)
            : "admin-preorders",
          "Admin preorders",
        );
        if (denied) return presentAdminDenied(denied);
        if (route?.startsWith("preorders:cancel:")) {
          const preorderId = route.slice("preorders:cancel:".length);
          if (isId(preorderId)) {
            // Cancelling releases a held asset and creates a refund obligation, so it takes
            // the second factor as well as the root gate above. Fail closed: a refused grant
            // returns the challenge before anything is cancelled.
            const authorization = await authorizeSensitiveFor(input, {
              actionKey: "preorder.cancel",
              resourceType: "PreorderReservation",
              resourceId: preorderId,
              consumeGrant: true,
            });
            if (!authorization.ok) {
              return presentSensitiveRefusal({
                code: authorization.code,
                action: "preorder.cancel",
                category: SENSITIVE_ACTION_POLICY["preorder.cancel"],
                challengeId: input.correlationId,
              });
            }
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
            customerName: config.SOCIAL_PROOF_HMAC_KEY
              ? generateCustomerAlias(r.customer_id, config.SOCIAL_PROOF_HMAC_KEY)
              : `Khách ${r.customer_id.slice(-4)}`,
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
        let adjusted: Awaited<ReturnType<typeof adjustQuantityStock>>;
        try {
          adjusted = await adjustQuantityStock({
            db: dbHandle.db,
            sensitiveDeps,
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
        } catch (error) {
          const refusal = renderSensitiveRefusal(
            error,
            "inventory.stock.adjust",
            "STOCK_ADJUSTMENT",
            input.correlationId,
          );
          if (refusal) return refusal;
          throw error;
        }
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
        // Explicit actor gate. These text interceptors used to rely on the pending
        // `admin_callback_state` row being admin-scoped, which does work (only the owner can
        // create one) but makes the authorization implicit: a reader has to reason about who
        // could have written that row. Stating it here keeps the rule local and checkable.
        const textDenied = await requireRootAdmin(
          adminCallbacks,
          input,
          "admin-text",
          "Admin text input",
        );
        if (textDenied) return null;
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
            downloader: createTelegramTextFileDownloader(config.TELEGRAM_BOT_TOKEN, {
              telegramEnvironment: config.TELEGRAM_API_ENVIRONMENT,
            }),
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
          downloader: createTelegramFileDownloader(config.TELEGRAM_BOT_TOKEN, {
            telegramEnvironment: config.TELEGRAM_API_ENVIRONMENT,
          }),
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
        }>`select id,audience from notification_campaign where created_by=${String(input.telegramUserId)} and status='DRAFT' and idempotency_key like ${`admin-broadcast:${input.telegramUserId}:%`}
            -- Bounded: an abandoned draft used to persist forever and capture the next unrelated
            -- thing the owner typed as the broadcast body, one mis-tap from messaging the audience.
            and created_at > now() - interval '30 minutes'
          order by created_at desc limit 1`.execute(dbHandle.db);
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
        if (input.chatType !== "private") return presentAdminDenied("WRONG_CONTEXT");
        // Sending to the whole audience is the highest-blast-radius owner action, so it takes the
        // same audited root gate as its siblings PLUS a live BROADCAST step-up grant.
        const sent = await enqueueBroadcastFromOwner({
          db: dbHandle.db,
          adminCallbacks,
          sensitiveDeps,
          telegramUserId: input.telegramUserId,
          chatType: input.chatType,
          campaignId: input.campaignId,
          correlationId: input.correlationId,
          largeAudienceThreshold: config.BROADCAST_LARGE_AUDIENCE_THRESHOLD,
          cooldownSeconds: config.BROADCAST_COOLDOWN_SECONDS,
        });
        if (!sent.ok) {
          if (sent.stage === "CAMPAIGN") return presentAdminBroadcastRefused(sent.reason);
          if (sent.code === "WRONG_CONTEXT") return presentAdminDenied("WRONG_CONTEXT");
          return presentSensitiveRefusal({
            code: sent.code,
            action: "broadcast.confirm",
            category: SENSITIVE_ACTION_POLICY["broadcast.confirm"],
            challengeId: input.correlationId,
          });
        }
        const status = await getBroadcastStatus(dbHandle.db, input.campaignId);
        return status
          ? presentAdminBroadcastStatus(status)
          : {
              text: "Không tìm thấy thông báo.",
              buttons: [[{ text: "📣 Tiếp thị", callbackData: "admin:marketing" }]],
            };
      },
      async broadcastCancel(input) {
        if (input.chatType !== "private") return presentAdminDenied("WRONG_CONTEXT");
        // Cancelling is not destructive, so identity alone is enough: it needs no second factor.
        const cancelDenied = await requireRootAdmin(
          adminCallbacks,
          input,
          input.campaignId ?? "admin-broadcast",
          "Admin broadcast",
        );
        if (cancelDenied) return presentAdminDenied(cancelDenied);
        const campaignId =
          input.campaignId ??
          (
            await sql<{
              id: string;
            }>`select id from notification_campaign where created_by=${String(input.telegramUserId)} and status='DRAFT' and idempotency_key like ${`admin-broadcast:${input.telegramUserId}:%`}
          order by created_at desc limit 1`.execute(dbHandle.db)
          ).rows[0]?.id;
        // No age bound here on purpose: cancelling is how an abandoned draft gets cleaned up, so it
        // must find one of any age. The composer's own lookup is the bounded one.
        if (!campaignId) {
          return {
            text: "Không còn thông báo nháp nào để huỷ.",
            buttons: [[{ text: "📣 Tiếp thị", callbackData: "admin:marketing" }]],
          };
        }
        await cancelBroadcast(dbHandle.db, campaignId);
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

          // Step-up factor commands (THREAT_MODEL SEC-002). Handled before every pending text state
          // so a live prompt cannot swallow the factor submission, and behind the same audited root
          // gate as every other owner entry point.
          if (input.text.startsWith("/verify") || input.text.startsWith("/enroll_2fa")) {
            if (input.text.startsWith("/enroll_2fa")) {
              return {
                buttons: [[{ text: "⚙️ Quản trị", callbackData: "admin:menu" }]],
                text: "Thiết lập MFA phải thực hiện trên operator host bằng `npm run admin:step-up enroll` để QR không đi qua Telegram.",
              };
            }
            const gated = await requireRootAdmin(
              adminCallbacks,
              input,
              "admin-step-up",
              "Admin step-up command",
            );
            if (gated) return presentAdminDenied(gated);
            const menu = { buttons: [[{ text: "⚙️ Quản trị", callbackData: "admin:menu" }]] };
            const parsedVerify = /^\/verify\s+(\d{6})\s+([A-Za-z0-9:_-]{1,80})$/u.exec(
              input.text.trim(),
            );
            if (!parsedVerify) {
              return {
                ...menu,
                text: "Gửi đúng định dạng: /verify <mã 6 số> <mã yêu cầu>.",
              };
            }
            const code = parsedVerify[1]!;
            const challengeId = parsedVerify[2]!;
            const requested = await sql<{
              action_key: string | null;
              category: string | null;
              resource_type: string | null;
              resource_id: string | null;
              resource_version: string | null;
              payload_hash: string | null;
            }>`
              select metadata_redacted->>'actionKey' as action_key,
                     metadata_redacted->>'category' as category,
                     metadata_redacted->>'resourceType' as resource_type,
                     metadata_redacted->>'resourceId' as resource_id,
                     metadata_redacted->>'resourceVersion' as resource_version,
                     metadata_redacted->>'payloadHash' as payload_hash
              from audit_event
              where actor_id = ${input.telegramUserId}
                and correlation_id = ${challengeId}
                and action = 'admin.sensitive.denied'
                and metadata_redacted->>'code' = 'STEP_UP_REQUIRED'
                and occurred_at > now() - (${config.ADMIN_STEP_UP_LOCKOUT_MINUTES} * interval '1 minute')
                and not exists (
                  select 1
                  from admin_step_up_grant as issued
                  where issued.admin_telegram_user_id = ${input.telegramUserId}
                    and issued.issued_at >= audit_event.occurred_at
                    and issued.action_key = audit_event.metadata_redacted->>'actionKey'
                    and issued.resource_type = audit_event.metadata_redacted->>'resourceType'
                    and issued.resource_id = audit_event.metadata_redacted->>'resourceId'
                    and issued.resource_version = audit_event.metadata_redacted->>'resourceVersion'
                    and issued.payload_hash = audit_event.metadata_redacted->>'payloadHash'
                )
              order by occurred_at desc, id desc
              limit 1
            `.execute(dbHandle.db);
            const requestedRow = requested.rows[0];
            const category = requestedRow?.category;
            if (
              !category ||
              !isStepUpActionCategory(category) ||
              !requestedRow?.action_key ||
              !isSensitiveActionKey(requestedRow.action_key) ||
              !requestedRow.resource_type ||
              !requestedRow.resource_id ||
              !requestedRow.resource_version ||
              !requestedRow.payload_hash
            ) {
              return {
                ...menu,
                text: "Chưa có thao tác nào đang chờ xác minh. Hãy mở lại hành động cần làm.",
              };
            }
            const verified = await stepUp.verify({
              adminTelegramUserId: input.telegramUserId,
              category,
              code,
              actionKey: requestedRow.action_key,
              resourceType: requestedRow.resource_type,
              resourceId: requestedRow.resource_id,
              resourceVersion: requestedRow.resource_version,
              payloadHash: requestedRow.payload_hash,
            });
            if (!verified.ok) {
              // Never echo the submitted code, and never say which digit was wrong.
              if (verified.code === "REPLAYED") {
                return {
                  ...menu,
                  text: "❌ Mã xác minh này đã được sử dụng. Hãy yêu cầu mã mới cho đúng thao tác.",
                };
              }
              if (verified.code === "LOCKED_OUT") {
                const oldest = await sql<{ oldest: Date | string | null }>`
                  select min(attempted_at) as oldest from admin_step_up_attempt
                  where admin_telegram_user_id = ${input.telegramUserId}
                    and succeeded = false
                    and attempted_at > now() - (${config.ADMIN_STEP_UP_LOCKOUT_MINUTES} * interval '1 minute')
                `.execute(dbHandle.db);
                const since = oldest.rows[0]?.oldest;
                const remainingMinutes =
                  since == null
                    ? config.ADMIN_STEP_UP_LOCKOUT_MINUTES
                    : Math.max(
                        0,
                        Math.ceil(
                          (new Date(since).getTime() +
                            config.ADMIN_STEP_UP_LOCKOUT_MINUTES * 60_000 -
                            Date.now()) /
                            60_000,
                        ),
                      );
                return {
                  ...menu,
                  text: `🔐 Xác minh bảo mật đang tạm khoá. Thử lại sau khoảng ${remainingMinutes} phút.`,
                };
              }
              if (verified.code === "NOT_ENROLLED") {
                return {
                  ...menu,
                  text: "Chưa thiết lập xác minh bảo mật. Chạy npm run admin:step-up enroll trên operator host.",
                };
              }
              return { ...menu, text: "❌ Mã xác minh không đúng. Vui lòng thử lại." };
            }
            return {
              ...menu,
              text: [
                `✅ Đã xác minh. Quyền có hiệu lực ${config.ADMIN_STEP_UP_TTL_SECONDS} giây.`,
                "",
                "Mở lại hành động vừa rồi và xác nhận để hoàn tất.",
              ].join("\n"),
            };
          }
          // Variant field edit (goal §78/§172). The prompt no longer carries a state id in the text
          // the owner types, so this is resolved by kind; only a state a real field prompt wrote has
          // `field`, and the menu's own state must not vouch for anything.
          const variantState = await sql<{ id: string }>`
            select id from admin_callback_state
             where admin_telegram_user_id = ${input.telegramUserId}
               and kind = 'ADMIN_VARIANT_UPDATE'
               and payload_redacted ? 'field'
               and expires_at > now()
             order by created_at desc
             limit 1
          `.execute(dbHandle.db);
          if (variantState.rows[0]) return this.variantText?.(input) ?? null;

          // In-place product content edit (goal §81). Resolved BEFORE the wizard sub-flows because
          // it is not part of a draft: the pending state carries the product, field and version.
          const contentState = await sql<{ id: string; payload: unknown }>`
            select id, payload_redacted as payload from admin_callback_state
            where admin_telegram_user_id = ${input.telegramUserId}
              and kind = 'ADMIN_PRODUCT_CONTENT_EDIT'
              and expires_at > now()
            order by created_at desc limit 1
          `.execute(dbHandle.db);
          const pendingContent = contentState.rows[0];
          if (pendingContent) {
            const payload = (pendingContent.payload ?? {}) as {
              productId?: unknown;
              field?: unknown;
              expectedVersion?: unknown;
            };
            const productId = typeof payload.productId === "string" ? payload.productId : null;
            const field = typeof payload.field === "string" ? payload.field : null;
            const expectedVersion =
              typeof payload.expectedVersion === "number" ? payload.expectedVersion : null;
            if (!productId || !field || expectedVersion === null) {
              // Claiming this text would swallow unrelated input, so drop the unusable state and
              // let the message fall through to its normal handler.
              await sql`delete from admin_callback_state where id = ${pendingContent.id}`.execute(
                dbHandle.db,
              );
              return null;
            }
            const value = input.text.trim() === "-" ? "" : input.text.trim();
            await sql`delete from admin_callback_state where id = ${pendingContent.id}`.execute(
              dbHandle.db,
            );
            try {
              const updated = await updateAdminProductContent({
                actor: { numericUserId: Number(input.telegramUserId), chatType: "private" },
                config: {
                  adminTelegramUserId: config.ADMIN_TELEGRAM_USER_ID,
                  expectedUsername: config.ADMIN_EXPECTED_USERNAME,
                },
                db: dbHandle.db,
                productId,
                expectedVersion,
                field,
                value,
                reason: `Sửa nội dung sản phẩm qua bot (${field})`,
                correlationId: input.correlationId,
              });
              return updated
                ? {
                    text: `✅ Đã cập nhật ${adminProductContentField(field)?.label ?? field}.`,
                    buttons: [
                      [
                        {
                          text: "⬅️ Danh sách mục",
                          callbackData: `admin:products:content:${productId}`,
                        },
                      ],
                      [{ text: "🛍 Sản phẩm", callbackData: "admin:products" }],
                    ],
                  }
                : {
                    text: "Sản phẩm vừa thay đổi ở nơi khác. Vui lòng mở lại để sửa tiếp.",
                    buttons: [[{ text: "🛍 Sản phẩm", callbackData: "admin:products" }]],
                  };
            } catch (error) {
              const code = error instanceof Error ? error.message : "UNKNOWN";
              return {
                text: `⚠️ Không lưu được: ${code === "INVALID_CONTENT_LENGTH" ? "nội dung quá dài (tối đa 2000 ký tự)." : code === "INVALID_NAME" ? "tên sản phẩm không được để trống." : code} `,
                buttons: [
                  [
                    {
                      text: "⬅️ Danh sách mục",
                      callbackData: `admin:products:content:${productId}`,
                    },
                  ],
                  [{ text: "🛍 Sản phẩm", callbackData: "admin:products" }],
                ],
              };
            }
          }

          // Refund adjustment (goal §26). The prompt is an explicit owner action, so claiming the
          // next message is intended; a reply we cannot read is answered with the format rather
          // than applied.
          const adjustState = await sql<{ id: string; payload: unknown }>`
            select id, payload_redacted as payload from admin_callback_state
            where admin_telegram_user_id = ${input.telegramUserId}
              and kind = 'WARRANTY_REFUND_ADJUST_PROMPT'
              and expires_at > now()
            order by created_at desc limit 1
          `.execute(dbHandle.db);
          const pendingAdjust = adjustState.rows[0];
          if (pendingAdjust) {
            const payload = (pendingAdjust.payload ?? {}) as { claimId?: unknown };
            const claimId = typeof payload.claimId === "string" ? payload.claimId : null;
            if (!claimId) {
              // Unusable state: drop it and let the message fall through rather than swallow it.
              await sql`
                delete from admin_callback_state
                where admin_telegram_user_id = ${input.telegramUserId}
                  and kind = 'WARRANTY_REFUND_ADJUST_PROMPT'
              `.execute(dbHandle.db);
              return null;
            }
            const adjusted = parseRefundAdjustment(input.text);
            if (!adjusted) {
              // The state stays pending: telling the owner to resend is only honest if the prompt
              // is still live to vouch for the retry.
              return {
                text: [
                  "Chưa đọc được số tiền.",
                  "",
                  "Gửi lại theo dạng: 40000 | Lý do điều chỉnh",
                ].join("\n"),
                buttons: [[{ text: "🛡 Danh sách bảo hành", callbackData: "admin:warranty" }]],
              };
            }
            const authorization = await authorizeSensitiveFor(input, {
              actionKey: "warranty.refund.adjust",
              resourceType: "WarrantyClaim",
              resourceId: claimId,
              requestedData: {
                amountVnd: adjusted.amountVnd.toString(),
                reason: adjusted.reason,
              },
              consumeGrant: true,
            });
            if (!authorization.ok)
              return presentSensitiveRefusal({
                code: authorization.code,
                action: "warranty.refund.adjust",
                category: "REFUND",
                challengeId: input.correlationId,
              });
            await sql`
              delete from admin_callback_state
              where admin_telegram_user_id = ${input.telegramUserId}
                and kind = 'WARRANTY_REFUND_ADJUST_PROMPT'
            `.execute(dbHandle.db);
            const result = await approveClaimRefund({
              db: dbHandle.db,
              actor: { numericUserId: Number(input.telegramUserId), chatType: "private" },
              config: {
                adminTelegramUserId: config.ADMIN_TELEGRAM_USER_ID,
                expectedUsername: config.ADMIN_EXPECTED_USERNAME,
              },
              claimId,
              amountVnd: adjusted.amountVnd,
              overrideReason: adjusted.reason,
              correlationId: input.correlationId,
            });
            if (!result.ok) return adminWarrantyError(adminClaimErrorText(result.code));
            const claim = await loadAdminWarrantyClaim(dbHandle.db, claimId);
            return presentAdminWarrantyActionDone({
              claimNumber: claim?.claimNumber ?? claimId,
              claimId,
              message: `Đã duyệt hoàn ${formatMoneyVnd(makeVnd(Number(adjusted.amountVnd)))} — lý do: ${adjusted.reason}. Shop chuyển khoản thủ công, sau đó xác nhận trong mục Chờ hoàn tiền.`,
            });
          }

          // Wizard sub-flow text states (category create / custom field / advanced / custom description).
          // The column is `payload_redacted` (the insert API calls it `payload`); selecting the
          // wrong name threw on every draft text message and left them all in RETRY.
          const subState = await sql<{ id: string; kind: string; payload: unknown }>`
            select id, kind, payload_redacted as payload from admin_callback_state
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
            // WIZARD_DESC_CUSTOM — with a payload field it fills ONE content field and returns to
            // the field menu; without one it is the original single free-text description.
            const fieldKey = readDescriptionFieldKey(pendingSub.payload);
            if (fieldKey) {
              const field = wizardDescriptionField(fieldKey);
              if (!field)
                return {
                  text: "Mục nội dung không hợp lệ.",
                  buttons: [[{ text: "❌ Huỷ", callbackData: "admin:products:cancel" }]],
                };
              // "-" clears the field: an owner who typed something wrong needs a way back to empty
              // without inventing placeholder text.
              const value = text === "-" ? undefined : text.slice(0, 2000);
              await sql`delete from admin_callback_state where id = ${pendingSub.id}`.execute(
                dbHandle.db,
              );
              const next = {
                ...draft,
                [field.key]: value,
                step: "description" as const,
                expiresAt: Date.now() + 15 * 60_000,
              };
              await repo.save(next);
              return presentWizardDescriptionFields(next);
            }
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
                  [{ text: "⬅️ Quay lại", callbackData: "admin:products:back" }],
                  [{ text: "❌ Huỷ", callbackData: "admin:products:cancel" }],
                ],
              };
            }
          }

          const result = await productDraftWorkflow.advance(input.telegramUserId, input.text);
          if (!result.ok) {
            // Goal §131: name the field. The step IS the field the owner is editing, so the
            // message is derived from it and every error code gets its own sentence.
            const errorMsg = wizardValidationMessage(result.error, current?.step ?? "unknown");
            return {
              text: `⚠️ ${errorMsg}`,
              buttons: [
                [{ text: "⬅️ Quay lại", callbackData: "admin:products:back" }],
                [{ text: "❌ Huỷ", callbackData: "admin:products:cancel" }],
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
                [{ text: "⬅️ Quay lại", callbackData: "admin:products:back" }],
                [{ text: "❌ Huỷ", callbackData: "admin:products:cancel" }],
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
          await clearWizardSubFlowStates(input.telegramUserId);
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
          // Resolved by kind, never by an id the owner would have to type (goal §172). Only a state
          // written by a real field prompt carries `field`, so anything else returns null and the
          // text chain below stays in charge of it.
          const rows = await sql<{ payload_redacted: Record<string, unknown> }>`
            select payload_redacted from admin_callback_state
             where admin_telegram_user_id = ${input.telegramUserId}
               and kind = 'ADMIN_VARIANT_UPDATE'
               and payload_redacted ? 'field'
               and expires_at > now()
             order by created_at desc
             limit 1
          `.execute(dbHandle.db);
          const payload = rows.rows[0]?.payload_redacted;
          const productId = typeof payload?.productId === "string" ? payload.productId : null;
          const variantId = typeof payload?.variantId === "string" ? payload.variantId : null;
          const field = typeof payload?.field === "string" ? payload.field : null;
          const expectedVersion =
            typeof payload?.expectedVersion === "number" ? payload.expectedVersion : null;
          if (!productId || !variantId || !field || !expectedVersion) return null;
          const back = (text: string) => ({
            text,
            buttons: [[{ text: "🛍 Sản phẩm", callbackData: `admin:products:detail:${productId}` }]],
          });
          const value = input.text.trim();
          const patch: {
            name?: string;
            priceVnd?: bigint;
            compareAtPriceVnd?: bigint | null;
            durationCode?: string;
            warrantyDays?: number;
            lowStockThreshold?: number | null;
            depositAmountVnd?: number;
          } = {};
          switch (field) {
            case "name":
              if (!value) return back("Tên biến thể không được để trống.");
              patch.name = value;
              break;
            case "priceVnd":
              if (!/^\d+$/.test(value)) return back("Giá chỉ gồm chữ số, ví dụ 280000.");
              if (BigInt(value) <= 0n) return back("Giá biến thể phải lớn hơn 0 ₫.");
              patch.priceVnd = BigInt(value);
              break;
            case "durationCode":
              if (!/^[A-Za-z0-9_-]{1,16}$/.test(value))
                return back("Mã thời hạn chỉ gồm chữ, số, dấu - và _, ví dụ P1M.");
              patch.durationCode = value.toUpperCase();
              break;
            case "compareAtPriceVnd":
              if (value !== "-" && !/^\d+$/.test(value))
                return back("Giá gạch ngang chỉ gồm chữ số, hoặc gửi - để bỏ.");
              patch.compareAtPriceVnd = value === "-" ? null : BigInt(value);
              break;
            case "depositAmountVnd": {
              if (!/^\d+$/.test(value)) return back("Tiền cọc chỉ gồm chữ số, ví dụ 50000.");
              const variantRow = (
                await sql<{ preorder_enabled: boolean }>`
                  select preorder_enabled from product_variant where id = ${variantId} limit 1
                `.execute(dbHandle.db)
              ).rows[0];
              if (variantRow?.preorder_enabled && Number(value) <= 0)
                return back("Tiền cọc phải lớn hơn 0 ₫ khi biến thể đang bật đặt cọc.");
              patch.depositAmountVnd = Number(value);
              break;
            }
            case "active":
            case "preorderEnabled":
              // These are answered with buttons; text here means the owner typed instead of tapping.
              return back("Mục này chọn bằng nút Bật hoặc Tắt bên dưới.");
            case "warrantyDays":
              if (!/^\d+$/.test(value)) return back("Số ngày bảo hành chỉ gồm chữ số, ví dụ 30.");
              patch.warrantyDays = Number(value);
              break;
            case "lowStockThreshold":
              if (value !== "-" && !/^\d+$/.test(value))
                return back("Ngưỡng sắp hết chỉ gồm chữ số, hoặc gửi - để xoá ngưỡng.");
              patch.lowStockThreshold = value === "-" ? null : Number(value);
              break;
            default:
              return null;
          }
          let ok: boolean;
          try {
            ok = await updateAdminVariant({
              actor: { numericUserId: Number(input.telegramUserId), chatType: "private" },
              config: {
                adminTelegramUserId: config.ADMIN_TELEGRAM_USER_ID,
                expectedUsername: config.ADMIN_EXPECTED_USERNAME,
              },
              db: dbHandle.db,
              sensitiveDeps,
              productId,
              variantId,
              expectedVersion,
              ...patch,
              reason: "Admin variant update",
              correlationId: input.correlationId,
            });
          } catch (error) {
            const refusal = renderSensitiveRefusal(
              error,
              "catalog.variant.price.change",
              "BULK_PRICE_CHANGE",
              input.correlationId,
            );
            if (refusal) return refusal;
            throw error;
          }
          if (!ok) return back("Biến thể đã thay đổi ở nơi khác, mở lại để sửa.");
          // One-shot consume: remove the field state so subsequent typed texts are not swallowed.
          await sql`
            delete from admin_callback_state
             where admin_telegram_user_id = ${input.telegramUserId}
               and kind = 'ADMIN_VARIANT_UPDATE'
               and payload_redacted ? 'field'
          `.execute(dbHandle.db);
          const named = await sql<{ name: string }>`
            select name_vi as name from product_variant where id = ${variantId} limit 1
          `.execute(dbHandle.db);
          return presentAdminVariantMutationDone({
            productId,
            variantName: named.rows[0]?.name ?? "biến thể",
            action: "updated",
          });
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
                [{ text: "⬅️ Quay lại", callbackData: "admin:products:back" }],
                [{ text: "❌ Huỷ", callbackData: "admin:products:cancel" }],
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
        async productContentMenu(input) {
          if (
            Number(input.telegramUserId) !== config.ADMIN_TELEGRAM_USER_ID ||
            input.chatType !== "private"
          )
            return presentAdminDenied("NOT_ROOT_ADMIN");
          const rows = await sql<{
            id: string;
            name_vi: string;
            version: number;
            short_description_vi: string | null;
            description_vi: string | null;
            what_customer_receives_vi: string | null;
            usage_instructions_vi: string | null;
            warranty_vi: string | null;
            delivery_eta_vi: string | null;
            terms_vi: string | null;
            support_vi: string | null;
            tags: string[] | null;
          }>`
            select id, name_vi, version, short_description_vi, description_vi,
              what_customer_receives_vi, usage_instructions_vi, warranty_vi,
              delivery_eta_vi, terms_vi, support_vi, tags
            from product where id = ${input.productId} limit 1
          `.execute(dbHandle.db);
          const row = rows.rows[0];
          if (!row)
            return {
              text: "Không tìm thấy sản phẩm.",
              buttons: [[{ text: "🛍 Sản phẩm", callbackData: "admin:products" }]],
            };
          // The field route carries only the field key, so the menu records which product (and
          // which version) is being edited. Without this the field prompt had nothing to resolve.
          await createAdminCallbackState(dbHandle.db, {
            adminTelegramUserId: input.telegramUserId,
            kind: "ADMIN_PRODUCT_CONTENT_EDIT",
            payload: { productId: row.id, expectedVersion: row.version },
          });
          return presentAdminProductContentMenu({
            productId: row.id,
            name: row.name_vi,
            values: {
              name: row.name_vi,
              shortDescription: row.short_description_vi,
              description: row.description_vi,
              whatCustomerReceives: row.what_customer_receives_vi,
              usageInstructions: row.usage_instructions_vi,
              warranty: row.warranty_vi,
              deliveryEta: row.delivery_eta_vi,
              terms: row.terms_vi,
              support: row.support_vi,
              tags: row.tags?.length ? row.tags.join(", ") : null,
            },
          });
        },
        async productContentEdit(input) {
          if (
            Number(input.telegramUserId) !== config.ADMIN_TELEGRAM_USER_ID ||
            input.chatType !== "private"
          )
            return presentAdminDenied("NOT_ROOT_ADMIN");
          const field = adminProductContentField(input.fieldKey);
          if (!field)
            return {
              text: "Mục nội dung không hợp lệ.",
              buttons: [[{ text: "🛍 Sản phẩm", callbackData: "admin:products" }]],
            };
          // The field route carries only the key, so the product it belongs to comes from the most
          // recent content menu the owner opened.
          const state = await sql<{ payload: unknown }>`
            select payload_redacted as payload from admin_callback_state
            where admin_telegram_user_id = ${input.telegramUserId}
              and kind = 'ADMIN_PRODUCT_CONTENT_EDIT'
              and expires_at > now()
            order by created_at desc limit 1
          `.execute(dbHandle.db);
          const pendingProductId = (state.rows[0]?.payload as { productId?: unknown } | undefined)
            ?.productId;
          const productId = typeof pendingProductId === "string" ? pendingProductId : null;
          if (!productId) {
            // No pending state: fall back to the product the owner just viewed, if any draft pointer
            // exists. Otherwise the menu must be opened fresh.
            return {
              text: "Hãy mở lại sản phẩm rồi chọn mục cần sửa.",
              buttons: [[{ text: "🛍 Sản phẩm", callbackData: "admin:products" }]],
            };
          }
          const rows =
            field.key === "tags"
              ? await sql<{ version: number; value: string | null }>`
                  select version, array_to_string(tags, ', ') as value
                  from product where id = ${productId} limit 1
                `.execute(dbHandle.db)
              : await sql<{ version: number; value: string | null }>`
                  select version, ${sql.ref(ADMIN_PRODUCT_CONTENT_FIELDS[field.key])} as value
                  from product where id = ${productId} limit 1
                `.execute(dbHandle.db);
          const row = rows.rows[0];
          if (!row)
            return {
              text: "Không tìm thấy sản phẩm.",
              buttons: [[{ text: "🛍 Sản phẩm", callbackData: "admin:products" }]],
            };
          await createAdminCallbackState(dbHandle.db, {
            adminTelegramUserId: input.telegramUserId,
            kind: "ADMIN_PRODUCT_CONTENT_EDIT",
            payload: { productId, field: field.key, expectedVersion: row.version },
          });
          return presentAdminProductContentPrompt({
            productId,
            label: field.label,
            current: row.value,
          });
        },
        async descriptionFields(input) {
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
          return presentWizardDescriptionFields(current);
        },
        async descriptionFieldEdit(input) {
          if (
            Number(input.telegramUserId) !== config.ADMIN_TELEGRAM_USER_ID ||
            input.chatType !== "private"
          )
            return presentAdminDenied("NOT_ROOT_ADMIN");
          const current = await productDraftWorkflow.get(input.telegramUserId);
          if (!current || current.step !== "description" || !wizardDescriptionField(input.fieldKey))
            return {
              text: "Mục nội dung không còn khả dụng.",
              buttons: [[{ text: "🛍 Sản phẩm", callbackData: "admin:products" }]],
            };
          await createAdminCallbackState(dbHandle.db, {
            adminTelegramUserId: input.telegramUserId,
            kind: "WIZARD_DESC_CUSTOM",
            payload: { field: input.fieldKey },
          });
          const field = wizardDescriptionField(input.fieldKey);
          const existing = field
            ? (current as unknown as Record<string, unknown>)[field.key]
            : undefined;
          return presentWizardDescriptionFieldPrompt(
            input.fieldKey,
            typeof existing === "string" ? existing : undefined,
          );
        },
        async descriptionFieldsDone(input) {
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
          const repo = createProductDraftRepository(dbHandle.db);
          const next = {
            ...current,
            step: "variant" as const,
            expiresAt: Date.now() + 15 * 60_000,
          };
          await repo.save(next);
          return renderWizardStep(next);
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
                // Warranty policy (goal §60). Advancing through this step must not drop it.
                warrantyEnabled: draft.warrantyEnabled ?? false,
                warrantyDays: draft.warrantyDays ?? 0,
                warrantyProrationEnabled: draft.warrantyProrationEnabled ?? true,
                warrantyReplacementAllowed: draft.warrantyReplacementAllowed ?? true,
                warrantyRefundAllowed: draft.warrantyRefundAllowed ?? true,
                warrantyReplacementBehavior:
                  draft.warrantyReplacementBehavior ?? "CONTINUE_ORIGINAL_END",
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
            // The route is already namespaced by `products:warranty:`, so these are the bare suffixes.
          } else if (input.action === "toggle") {
            draft.warrantyEnabled = !draft.warrantyEnabled;
            // Turning it on with no duration yet would promise a warranty nobody defined.
            if (draft.warrantyEnabled && !draft.warrantyDays) draft.warrantyDays = 30;
            draft.warrantyProrationEnabled ??= true;
            draft.warrantyReplacementAllowed ??= true;
            draft.warrantyRefundAllowed ??= true;
            draft.warrantyReplacementBehavior ??= "CONTINUE_ORIGINAL_END";
          } else if (input.action.startsWith("days:")) {
            const days = Number(input.action.slice("days:".length));
            if (Number.isInteger(days) && days > 0 && days <= 3650) draft.warrantyDays = days;
          } else if (input.action === "proration") {
            draft.warrantyProrationEnabled = draft.warrantyProrationEnabled === false;
          } else if (input.action === "replacement") {
            draft.warrantyReplacementAllowed = draft.warrantyReplacementAllowed === false;
          } else if (input.action === "refund") {
            draft.warrantyRefundAllowed = draft.warrantyRefundAllowed === false;
          } else if (input.action.startsWith("text:")) {
            // Coverage and exclusions are prose, so they ride the existing field-editor state rather
            // than inventing a second prompt mechanism (goal §60).
            const which = input.action.slice("text:".length);
            const fieldKey = which === "coverage" ? "warrantyCoverageVi" : "warrantyExclusionsVi";
            const field = wizardDescriptionField(fieldKey);
            if (!field) return renderWizardStep(draft);
            await createAdminCallbackState(dbHandle.db, {
              adminTelegramUserId: input.telegramUserId,
              kind: "WIZARD_DESC_CUSTOM",
              payload: { field: fieldKey },
            });
            return presentWizardDescriptionFieldPrompt(
              fieldKey,
              which === "coverage" ? draft.warrantyCoverageVi : draft.warrantyExclusionsVi,
            );
          } else if (input.action === "behavior") {
            draft.warrantyReplacementBehavior =
              draft.warrantyReplacementBehavior === "RESET_FROM_REPLACEMENT"
                ? "CONTINUE_ORIGINAL_END"
                : "RESET_FROM_REPLACEMENT";
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
                  ...(draft.shortDescriptionVi === undefined
                    ? {}
                    : { shortDescriptionVi: draft.shortDescriptionVi }),
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
                  // Warranty policy collected in step 8 (goal: warranty vertical).
                  warrantyEnabled: draft.warrantyEnabled ?? false,
                  warrantyDays: draft.warrantyDays ?? 0,
                  ...(draft.warrantyProrationEnabled === undefined
                    ? {}
                    : { warrantyProrationEnabled: draft.warrantyProrationEnabled }),
                  ...(draft.warrantyReplacementAllowed === undefined
                    ? {}
                    : { warrantyReplacementAllowed: draft.warrantyReplacementAllowed }),
                  ...(draft.warrantyRefundAllowed === undefined
                    ? {}
                    : { warrantyRefundAllowed: draft.warrantyRefundAllowed }),
                  ...(draft.warrantyReplacementBehavior === undefined
                    ? {}
                    : { warrantyReplacementBehavior: draft.warrantyReplacementBehavior }),
                  ...(draft.warrantyCoverageVi === undefined
                    ? {}
                    : { warrantyCoverageVi: draft.warrantyCoverageVi }),
                  ...(draft.warrantyExclusionsVi === undefined
                    ? {}
                    : { warrantyExclusionsVi: draft.warrantyExclusionsVi }),
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
              text: `✅ Đã tạo sản phẩm\n\n${product.name}\nBiến thể: ${draft.variantName}\nSKU: ${product.sku}\nGiá: ${product.priceVnd.toLocaleString("vi-VN")} ₫\nTrạng thái: ${product.active ? "Đang mở bán" : "Nháp / Chưa mở bán"}`,
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
            // Postgres reports a unique violation through the error's `code`/`constraint` fields,
            // not through `message`, so a message-text match misses it and the failure escapes to
            // the inbox retry loop — the owner taps Create and simply sees nothing happen.
            const pg = (error ?? {}) as { code?: unknown; constraint?: unknown };
            if (pg.code === "23505") {
              // Both collisions are fixable without leaving Telegram, and the draft is kept on
              // purpose so the wizard reopens at the step that owns the clashing value (§130/§131).
              const clash = String(pg.constraint ?? "");
              const lines = clash.includes("slug")
                ? [
                    "Tên sản phẩm này đã được dùng cho một sản phẩm khác đang bán.",
                    "👉 Quay lại bước 📝 Tên sản phẩm và đổi tên, hoặc mở sản phẩm cũ để chỉnh sửa.",
                  ]
                : [
                    "SKU này đã tồn tại cho một sản phẩm khác.",
                    "👉 Quay lại bước 🏷 SKU và chọn SKU khác.",
                  ];
              return {
                text: `⚠️ ${lines.join("\n")}`,
                buttons: [
                  [{ text: "⬅️ Quay lại bước trước", callbackData: "admin:products:back" }],
                  [{ text: "🛍 Sản phẩm", callbackData: "admin:products" }],
                ],
              };
            }
            throw error;
          }
        },
        async cancel(input) {
          if (
            Number(input.telegramUserId) !== config.ADMIN_TELEGRAM_USER_ID ||
            input.chatType !== "private"
          )
            return presentAdminDenied("NOT_ROOT_ADMIN");
          await clearWizardSubFlowStates(input.telegramUserId);
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
          (await findOrderByNumberInternal(dbHandle.db, orderNumber))?.id ?? null,
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
            const sent = await telegramResponder.send({
              chatId: input.chatId,
              messageId: null,
              message: presentDeliveryReveal({
                secret: input.secret,
                productName: input.product?.name ?? "Đơn hàng của bạn",
                orderNumber: input.orderNumber,
                amountVnd: input.amountVnd,
                usageInstructionsVi: input.product?.usageInstructionsVi ?? null,
                warrantyVi: input.product?.warrantyVi ?? null,
              }),
            });
            if (!sent || sent.chatId !== input.chatId || sent.messageId.length === 0) {
              throw new Error("Telegram provider message identity missing");
            }
            // Keep the separate commercial thank-you best-effort; a failure here
            // must not make the credential handoff retry and duplicate the secret.
            try {
              await telegramResponder.send({
                chatId: input.chatId,
                messageId: null,
                message: presentPurchaseThankYou({
                  orderNumber: input.orderNumber,
                  productName: input.product?.name ?? "Đơn hàng của bạn",
                }),
              });
            } catch (error) {
              logger.warn(
                { err: error, handoffId: input.handoffId },
                "purchase thank-you send failed",
              );
            }
            return { ...sent, succeededAt: new Date().toISOString() };
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
      handler: async (event) => {
        const notificationEvent =
          event.eventType === "StockDelta" ||
          event.eventType === "WarrantyClaimOpened" ||
          event.eventType === "TicketOpened" ||
          event.eventType === "PaymentSettled" ||
          event.eventType === "PaymentNeedsReview" ||
          event.eventType === "DigitalAssetDelivered" ||
          event.eventType === "ManualFulfillmentTaskCompleted" ||
          event.eventType === "FulfillmentCompleted";
        const completionEvent =
          event.eventType === "DigitalAssetDelivered" ||
          event.eventType === "ManualFulfillmentTaskCompleted" ||
          event.eventType === "FulfillmentCompleted";
        if (completionEvent) {
          const fulfillmentResult = await handler(event);
          if (fulfillmentResult.kind !== "PUBLISHED") return fulfillmentResult;
        }
        if (notificationEvent) {
          return handleNotificationOutboxEvent(dbHandle.db, event, {
            rootTelegramUserId: config.ADMIN_TELEGRAM_USER_ID,
            adminAlertMode: config.ADMIN_PAYMENT_ALERT_MODE,
          });
        }
        return handler(event);
      },
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
        // Private-chat commerce only. A group/supergroup/channel update (or an inline query) is
        // acknowledged and dropped here so it produces no identity, profile or commerce side
        // effect at all.
        if (envelope.chatType !== "private") return;
        if (envelope.inlineQuery || envelope.chosenInlineResult) return;
        try {
          const observedUsername = await consumeTelegramUsernameObservation(
            dbHandle.db,
            envelope.actorUserId,
          );
          const identity = await ensureTelegramIdentity(dbHandle.db, {
            telegramUserId: envelope.actorUserId,
            ...(observedUsername ? { observedUsername } : {}),
          });
          // The profile snapshot models the customer's PRIVATE chat (its chat_id column is
          // constrained to a private chat id). Group traffic still resolves identity, but must
          // never write the snapshot with a group chat id.
          if (envelope.chatType === "private") {
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
          }
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
      inboxRetention: {
        processedRetentionDays: config.TELEGRAM_INBOX_PROCESSED_RETENTION_DAYS,
        deadRetentionDays: config.TELEGRAM_INBOX_DEAD_RETENTION_DAYS,
        staleRetryRetentionDays: config.TELEGRAM_INBOX_STALE_RETRY_RETENTION_DAYS,
        failedPayloadGraceSeconds: config.TELEGRAM_INBOX_FAILED_PAYLOAD_GRACE_MINUTES * 60,
        batchSize: config.TELEGRAM_INBOX_PRUNE_BATCH_SIZE,
      },
    });
    const { expireGoogleSheetsInventoryChallenges } =
      await import("./modules/google-sheets/inventory-intake.js");
    const expiredSheetChallenges = config.GOOGLE_SHEETS_INVENTORY_INTAKE_ENABLED
      ? await expireGoogleSheetsInventoryChallenges({
          db: dbHandle.db,
          vault,
          rootConfig: {
            adminTelegramUserId: config.ADMIN_TELEGRAM_USER_ID,
            expectedUsername: config.ADMIN_EXPECTED_USERNAME,
          },
        })
      : 0;
    // Deposit holds are a bounded promise: a reservation whose balance deadline passed
    // forfeits the deposit (per the terms the customer accepted) and its held unit goes
    // back to the next waiter in the queue. Same lane, same cadence as the other recovery.
    const preorderHolds = await releaseExpiredPreorderHolds(dbHandle.db);
    logger.info(
      {
        recovery,
        expiredSheetChallenges,
        preorderHolds,
        sePayRecoveryConfigured: sePayRecoveryPort !== null,
        supplierRecoveryConfigured: supplier !== null,
      },
      "bounded recovery cycle",
    );
  };
  const sheetsLane = createGoogleSheetsApi
    ? async (): Promise<void> => {
        const { reconcileRequestsAndProjection, recordSheetsSyncFailure } =
          await import("./modules/google-sheets/requests.js");
        try {
          const api = googleSheetsApi ?? (googleSheetsApi = await createGoogleSheetsApi());
          const result = await reconcileRequestsAndProjection({
            db: dbHandle.db,
            api,
            config: {
              spreadsheetId: config.GOOGLE_SHEETS_SPREADSHEET_ID,
              ownerId: config.GOOGLE_SHEETS_OWNER_ID,
              appBaseUrl: config.APP_BASE_URL,
              ...(api.principalEmail ? { serviceAccountEmail: api.principalEmail } : {}),
            },
          });
          logger.info(result, "Google Sheets reconciliation cycle");
        } catch (error) {
          const code =
            error !== null &&
            typeof error === "object" &&
            "code" in error &&
            typeof error.code === "string"
              ? error.code
              : "UNKNOWN";
          try {
            await recordSheetsSyncFailure(dbHandle.db, code);
          } catch {
            // The sync-status write is best-effort; Sheets must never stop commerce lanes.
          }
          logger.error({ code }, "Google Sheets unavailable; PostgreSQL commerce lanes continue");
        }
      }
    : null;
  let sheetsLaneInFlight: Promise<void> | null = null;
  const runSheetsLane = async (): Promise<void> => {
    if (!sheetsLane) return;
    if (sheetsLaneInFlight) return sheetsLaneInFlight;
    const run = sheetsLane();
    sheetsLaneInFlight = run;
    try {
      await run;
    } finally {
      if (sheetsLaneInFlight === run) sheetsLaneInFlight = null;
    }
  };
  /**
   * Group publication detection. Runs on the recovery cadence and only ever enqueues
   * durable work: the actual Telegram send happens in the outbox lane under the limiter.
   */
  const { createDbWakeListener, DB_WAKE_CHANNELS } = await import("./infrastructure/db/client.js");
  const wakeListener = createDbWakeListener(dbHandle.pool, {
    callbacks: {
      [DB_WAKE_CHANNELS.outbox]: async () => {
        await outboxLane();
        await runSheetsLane();
      },
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
      ...(sheetsLane ? { sheets: runSheetsLane } : {}),
    },
    pollIntervalMs: config.OUTBOX_POLL_INTERVAL_MS,
    recoveryIntervalMs: 60_000,
    laneIntervals: { sheets: config.GOOGLE_SHEETS_SYNC_INTERVAL_MS },
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
