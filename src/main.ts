/**
 * HTTP entrypoint: Telegram webhook, SePay webhook, Delivery Bundle route,
 * and health/readiness. Side effects (fulfillment, notifications) are owned by
 * the worker process via the transactional outbox — this process never dispatches
 * them directly.
 *
 * See plan.md "Delivery Phases" and contracts/application-commands.md.
 */
import { pathToFileURL } from "node:url";
import { sql } from "kysely";

async function main(): Promise<void> {
  // Local `.env` only. Production is loaded by `node --env-file=` before this
  // process starts; dotenv would fill gaps from a repo `.env` and must not mix in.
  if (process.env.NODE_ENV !== "production") {
    await import("dotenv/config");
  }

  const { loadConfig, redactedConfig } = await import("./config/index.js");
  const config = loadConfig(process.env);

  const { createLogger } = await import("./infrastructure/observability/logger.js");
  const logger = createLogger(config);

  const { createDb } = await import("./infrastructure/db/client.js");
  const { createVault } = await import("./infrastructure/vault/adapter.js");
  const { createApp } = await import("./app.js");
  const { createPostgresTelegramInbox } = await import("./infrastructure/inbox/telegram.js");
  const { createPostgresSePayInbox } = await import("./infrastructure/inbox/sepay.js");
  const { createSePayIngressHandler } = await import("./modules/payments/sepay-ingress.js");

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

  // HTTP acknowledges only after this PostgreSQL inbox commits. Business
  // dispatch and per-action budgets run asynchronously in the inbox worker.
  const inbox = createPostgresTelegramInbox(dbHandle.db);
  const sepayInbox = createPostgresSePayInbox(dbHandle.db);

  const sepayHandler = createSePayIngressHandler({
    hmacSecret: config.SEPAY_WEBHOOK_HMAC_SECRET,
    replayWindowSeconds: config.SEPAY_REPLAY_WINDOW_SECONDS,
    ipAllowlist: config.SEPAY_IP_ALLOWLIST,
    trustedProxyIps: config.SEPAY_TRUSTED_PROXY_IPS,
    inbox: sepayInbox,
  });

  const app = await createApp({
    db: dbHandle.db,
    vault,
    telegram: {
      path: config.TELEGRAM_WEBHOOK_PATH,
      secretToken: config.TELEGRAM_WEBHOOK_SECRET,
      inbox,
      rootProductDraftText: {
        adminTelegramUserId: config.ADMIN_TELEGRAM_USER_ID,
        async activeStep(telegramUserId: string) {
          if (telegramUserId !== String(config.ADMIN_TELEGRAM_USER_ID)) return null;
          const { isRootProductDraftTextStep } = await import("./bot/webhook.js");
          const row = (
            await sql<{ step: string }>`
              select step
              from admin_workflow
              where admin_telegram_user_id = ${telegramUserId}
                and expires_at > now()
                and step in (
                  'name','sku','description','variant','deliveryConfig',
                  'variantName','price','inventoryFields','threshold','initialQuantity',
                  'serviceInstructions'
                )
              limit 1
            `.execute(dbHandle.db)
          ).rows[0];
          return row && isRootProductDraftTextStep(row.step) ? row.step : null;
        },
      },
      customerSearchQuery: {
        // One-shot: the prompt writes the row, the next acceptable text consumes and deletes it, so
        // a typed query is admitted exactly once and raw text stays dropped the rest of the time.
        async consume(chatId: string) {
          const row = await sql<{ chat_id: string }>`
            delete from customer_search_prompt
            where chat_id = ${chatId} and expires_at > now()
            returning chat_id
          `.execute(dbHandle.db);
          return row.rows.length === 1;
        },
      },
      productContentEditText: {
        adminTelegramUserId: config.ADMIN_TELEGRAM_USER_ID,
        // Only a REAL field prompt vouches for free text. The menu itself also writes a state
        // (to carry the product id), and vouching on that alone would swallow every text the
        // owner sends after merely opening the menu — including reply-keyboard keys.
        async isActive(telegramUserId: string) {
          if (telegramUserId !== String(config.ADMIN_TELEGRAM_USER_ID)) return false;
          const row = (
            await sql<{ id: string }>`
              select id from admin_callback_state
              where admin_telegram_user_id = ${telegramUserId}
                and kind = 'ADMIN_PRODUCT_CONTENT_EDIT'
                and payload_redacted ? 'field'
                and expires_at > now()
              limit 1
            `.execute(dbHandle.db)
          ).rows[0];
          return Boolean(row);
        },
      },
      warrantyRefundAdjustText: {
        adminTelegramUserId: config.ADMIN_TELEGRAM_USER_ID,
        // Only the prompt's own pending state vouches for free text (goal §26), so an unrelated
        // message after the prompt expires is never read as a refund amount.
        async isActive(telegramUserId: string) {
          if (telegramUserId !== String(config.ADMIN_TELEGRAM_USER_ID)) return false;
          const row = (
            await sql<{ id: string }>`
              select id from admin_callback_state
              where admin_telegram_user_id = ${telegramUserId}
                and kind = 'WARRANTY_REFUND_ADJUST_PROMPT'
                and expires_at > now()
              limit 1
            `.execute(dbHandle.db)
          ).rows[0];
          return Boolean(row);
        },
      },
      inventoryImportText: {
        adminTelegramUserId: config.ADMIN_TELEGRAM_USER_ID,
        async isActive(telegramUserId: string) {
          if (telegramUserId !== String(config.ADMIN_TELEGRAM_USER_ID)) return false;
          const row = (
            await sql<{ status: string }>`
              select status
              from admin_inventory_import
              where admin_telegram_user_id = ${telegramUserId}
                and expires_at > now()
                and status in ('WAITING_INPUT', 'READY')
              limit 1
            `.execute(dbHandle.db)
          ).rows[0];
          return Boolean(row);
        },
      },
    },
    sepay: {
      path: "/webhooks/sepay",
      handler: sepayHandler,
    },
    delivery: {
      session: {
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
    },
    bodyLimitBytes: config.HTTP_BODY_LIMIT_BYTES,
    logger: false,
  });

  await app.listen({ host: config.HTTP_HOST, port: config.HTTP_PORT });
  logger.info(
    {
      httpHost: config.HTTP_HOST,
      httpPort: config.HTTP_PORT,
      // Redacted view only — never dump the raw config object.
      config: redactedConfig(config),
    },
    "main process listening",
  );

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, "main process shutting down");
    try {
      await app.close();
    } catch (err) {
      logger.error(
        { err: err instanceof Error ? err.message : "unknown error" },
        "error closing http server",
      );
    }
    try {
      await dbHandle.close();
    } catch (err) {
      logger.error(
        { err: err instanceof Error ? err.message : "unknown error" },
        "error closing database",
      );
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
  main().catch((err: unknown) => {
    // Never print the raw error object; it may carry config values.
    process.stderr.write(
      `main failed to start: ${err instanceof Error ? err.message : "unknown error"}\n`,
    );
    process.exit(1);
  });
}

export { main };
