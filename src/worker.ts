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
import { recoverSupplierOrdersBatch } from "./modules/supplier/recovery.js";

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
  const { createTelegramDomainDispatcher } = await import("./bot/callbacks/telegram-dispatch.js");
  const { createGrammyResponder } = await import("./bot/grammy-responder.js");
  const { createSearchParser } = await import("./modules/catalog/search-parser-adapter.js");
  const { findOrderById, findOrderByNumber } = await import("./modules/commerce/repository.js");
  const { createAdminConfirmation } = await import("./modules/identity/admin-confirmation.js");
  const { bootstrapRootTelegramIdentity, ensureTelegramIdentity, resolveTelegramCustomerId } =
    await import("./modules/identity/channel-identity.js");
  const { createAdminCallbacks, OWNER_COMMANDS } = await import("./bot/callbacks/admin.js");
  const { presentAdminDenied, presentHighRiskChallenge, presentKillSwitchDone } =
    await import("./bot/presenters/admin.js");

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
        rootConfig: {
          adminTelegramUserId: config.ADMIN_TELEGRAM_USER_ID,
          expectedUsername: config.ADMIN_EXPECTED_USERNAME,
        },
        rootChannelIdentityId: rootIdentity.channelIdentityId,
        confirmation: createAdminConfirmation(dbHandle.db),
      })
    : null;
  const telegramInbox = createPostgresTelegramInbox(dbHandle.db);
  const sepayInbox = createPostgresSePayInbox(dbHandle.db);
  const telegramLimiter = createPostgresRateLimiter(
    dbHandle.db,
    DEFAULT_TELEGRAM_RATE_LIMIT_POLICIES,
  );
  const telegramDispatcher = createTelegramDomainDispatcher({
    codec: callbackCodec,
    resolveCustomerId,
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
    catalog,
    checkout,
    history,
    support,
    admin: {
      async handleToken(input) {
        const command = OWNER_COMMANDS[input.option];
        if (!command || !adminCallbacks) {
          return presentAdminDenied("NOT_ROOT_ADMIN");
        }
        const result = await adminCallbacks.handle({
          command,
          actor: {
            numericUserId: Number(input.telegramUserId),
            chatType: "private",
          },
          targetId: input.targetId,
          reason: "Signed Telegram owner callback",
          correlationId: input.correlationId,
        });
        if (!result.ok) {
          return result.code === "WRONG_CONTEXT"
            ? presentAdminDenied("WRONG_CONTEXT")
            : presentAdminDenied("NOT_ROOT_ADMIN");
        }
        if (result.needsConfirmation) {
          return presentHighRiskChallenge({
            confirmationId: result.confirmationId,
            challenge: result.challenge,
            expiresAt: result.expiresAt,
            action: command,
          });
        }
        if (command === "catalog.activate" || command === "catalog.deactivate") {
          return presentKillSwitchDone({ command, targetId: input.targetId });
        }
        return {
          text: "✅ Đã ghi nhận lệnh quản trị.",
          buttons: [[{ text: "Menu chính", callbackData: "menu:main" }]],
        };
      },
    },
    responder: createGrammyResponder(config.TELEGRAM_BOT_TOKEN),
  });

  // Stable owner id for the durable outbox lease for this process lifetime.
  const ownerId = `worker-${newId().slice(-12)}`;
  const telegramOwnerId = `telegram-${newId().slice(-12)}`;
  const sepayOwnerId = `sepay-${newId().slice(-12)}`;

  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let inFlight: Promise<void> | null = null;
  let shuttingDown = false;
  let nextRecoveryAt = 0;

  const poll = async (): Promise<void> => {
    // Single-flight: if a previous cycle is still running, skip this tick.
    // The previous implementation used `void poll()` from setInterval which
    // allowed overlapping cycles to claim and dispatch the same event (T134).
    if (inFlight !== null || shuttingDown) return;
    inFlight = (async () => {
      try {
        const result = await drainOutboxOnce(dbHandle.db, {
          batchSize: 20,
          maxAttempts: config.OUTBOX_MAX_ATTEMPTS,
          handler,
          ownerId,
        });
        if (result.claimed > 0) {
          logger.info(
            {
              claimed: result.claimed,
              published: result.published,
              failed: result.failed,
              terminal: result.terminal,
              unknown: result.unknown,
              stale: result.stale,
              ownerId,
            },
            "outbox drain cycle",
          );
        }
        const telegramResult = await processTelegramInboxBatch({
          inbox: telegramInbox,
          limiter: telegramLimiter,
          handler: async (envelope) => {
            const observedUsername = await consumeTelegramUsernameObservation(
              dbHandle.db,
              envelope.actorUserId,
            );
            await ensureTelegramIdentity(dbHandle.db, {
              telegramUserId: envelope.actorUserId,
              ...(observedUsername ? { observedUsername } : {}),
            });
            await telegramDispatcher.handle(envelope);
          },
          owner: telegramOwnerId,
          batchSize: 20,
          maxAttempts: config.OUTBOX_MAX_ATTEMPTS,
        });
        if (telegramResult.claimed > 0) {
          logger.info(
            { ...telegramResult, ownerId: telegramOwnerId },
            "telegram inbox dispatch cycle",
          );
        }
        const sepayResult = await processSePayInboxBatch({
          inbox: sepayInbox,
          handler: (evidence) => applyPaymentEvidence(dbHandle.db, evidence),
          owner: sepayOwnerId,
          batchSize: 20,
          maxAttempts: config.OUTBOX_MAX_ATTEMPTS,
        });
        if (sepayResult.claimed > 0) {
          logger.info({ ...sepayResult, ownerId: sepayOwnerId }, "sepay inbox dispatch cycle");
        }
        if (Date.now() >= nextRecoveryAt) {
          nextRecoveryAt = Date.now() + 60_000;
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
        }
      } catch (err) {
        logger.error(
          { err: err instanceof Error ? err.message : "unknown error" },
          "outbox drain failed",
        );
      }
    })();
    try {
      await inFlight;
    } finally {
      inFlight = null;
    }
  };

  pollTimer = setInterval(() => {
    void poll();
  }, config.OUTBOX_POLL_INTERVAL_MS);
  // Kick once immediately so a restart recovers promptly.
  void poll();

  const started: Stoppable[] = [
    {
      async stop() {
        if (pollTimer) clearInterval(pollTimer);
        pollTimer = null;
        // Drain the in-flight cycle with a bound so SIGTERM does not hang forever
        // but also does not close the pool under an active handler (T134).
        if (inFlight) {
          const timeout = new Promise<void>((resolve) => {
            setTimeout(resolve, 10_000);
          });
          await Promise.race([inFlight, timeout]);
        }
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
