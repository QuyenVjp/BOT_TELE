import Fastify, { type FastifyInstance } from "fastify";
import type { Db } from "./infrastructure/db/transaction.js";
import { pingDb } from "./infrastructure/db/client.js";
import type { Vault } from "./infrastructure/vault/port.js";
import {
  registerTelegramWebhook,
  type RootProductDraftTextIngress,
  type AdminInventoryImportTextIngress,
  type AdminProductContentEditIngress,
  type AdminWarrantyAdjustTextIngress,
  type CustomerSearchQueryIngress,
  type UpdateInbox,
} from "./bot/webhook.js";
import { registerDeliveryRoute } from "./modules/digital-goods/delivery-route.js";
import type { DeliverySessionCodecConfig } from "./modules/digital-goods/delivery-session.js";
import { healthPayload, loadBuildIdentity } from "./shared/build-identity.js";

/**
 * HTTP application composition (T118, FR-024, SR-004).
 *
 * `createApp` wires a real Fastify instance with every ingress the pilot needs:
 *   - GET  /health  — liveness; never touches the database.
 *   - GET  /ready   — readiness; pings the DB and fails closed (503).
 *   - POST <telegram webhook> — secret-gated, deduped, rate-limited dispatch.
 *   - POST <sepay webhook>    — RAW body preserved for HMAC verification.
 *   - GET  /d/:token          — authenticated one-time delivery reveal.
 *
 * All dependencies are injected so the composition is unit-testable with
 * `app.inject()` and swappable for production adapters at the entrypoint.
 */

export interface SePayRouteRequest {
  /** Exact request body bytes as received (never re-serialized). */
  rawBody: string;
  headers: Record<string, string | undefined>;
  /** Direct TCP peer. Forwarded headers are interpreted only by the verifier. */
  remoteAddress: string;
}

export interface SePayRouteResult {
  status: number;
  body: unknown;
}

export interface CreateAppDeps {
  db: Db;
  vault: Vault;
  telegram: {
    path: string;
    secretToken: string;
    /** Required: callers must choose a durable or explicit test inbox. */
    inbox: UpdateInbox;
    rootProductDraftText?: RootProductDraftTextIngress;
    inventoryImportText?: AdminInventoryImportTextIngress;
    productContentEditText?: AdminProductContentEditIngress;
    warrantyRefundAdjustText?: AdminWarrantyAdjustTextIngress;
    customerSearchQuery?: CustomerSearchQueryIngress;
  };
  sepay: {
    path: string;
    handler: (req: SePayRouteRequest) => Promise<SePayRouteResult>;
  };
  delivery?: {
    /** Optional path override (defaults to /d/:token). */
    path?: string;
    session: DeliverySessionCodecConfig;
  };
  bodyLimitBytes: number;
  /**
   * `false` in production: the entrypoint logs structured events through the redacted
   * logger itself, so Fastify's own request logger (which prints headers verbatim) stays off.
   */
  logger?: { level: "silent" | "info" | "error" } | false;
}

export async function createApp(deps: CreateAppDeps): Promise<FastifyInstance> {
  const app = Fastify({
    bodyLimit: deps.bodyLimitBytes,
    logger: deps.logger === false ? false : (deps.logger ?? { level: "info" }),
  });

  // A content-type parser that preserves the exact bytes so downstream HMAC
  // verification signs what the provider actually sent. Applies to all JSON;
  // routes that want a parsed object can JSON.parse the rawBody themselves.
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => {
    // Do NOT JSON.parse here: keep raw. Attach the string as-is.
    done(null, body);
  });
  // Fallback for providers that post with an odd content-type.
  app.addContentTypeParser("*", { parseAs: "string" }, (_req, body, done) => {
    done(null, body);
  });

  // --- Health / readiness -------------------------------------------------
  app.get("/health", async () => healthPayload(loadBuildIdentity(import.meta.url)));

  app.get("/ready", async (_req, reply) => {
    try {
      await pingDb(deps.db);
      await deps.vault.health?.();
      return reply.code(200).send({ status: "ready" });
    } catch {
      // Fail closed; never leak the underlying error.
      return reply.code(503).send({ status: "unavailable" });
    }
  });

  // --- Telegram webhook ---------------------------------------------------
  await registerTelegramWebhook(app, {
    path: deps.telegram.path,
    secretToken: deps.telegram.secretToken,
    inbox: deps.telegram.inbox,
    ...(deps.telegram.rootProductDraftText === undefined
      ? {}
      : { rootProductDraftText: deps.telegram.rootProductDraftText }),
    ...(deps.telegram.inventoryImportText === undefined
      ? {}
      : { inventoryImportText: deps.telegram.inventoryImportText }),
    ...(deps.telegram.productContentEditText === undefined
      ? {}
      : { productContentEditText: deps.telegram.productContentEditText }),
    ...(deps.telegram.warrantyRefundAdjustText === undefined
      ? {}
      : { warrantyRefundAdjustText: deps.telegram.warrantyRefundAdjustText }),
    ...(deps.telegram.customerSearchQuery === undefined
      ? {}
      : { customerSearchQuery: deps.telegram.customerSearchQuery }),
  });

  // --- SePay webhook (raw body preserved) ---------------------------------
  app.post(deps.sepay.path, async (request, reply) => {
    const rawBody = typeof request.body === "string" ? request.body : "";
    const headers: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(request.headers)) {
      headers[k] = Array.isArray(v) ? v[0] : v;
    }
    const result = await deps.sepay.handler({
      rawBody,
      headers,
      remoteAddress: request.socket.remoteAddress ?? "",
    });
    process.stdout.write(
      `${JSON.stringify({
        tag: "SEPAY_INGRESS",
        time: new Date().toISOString(),
        remoteAddress: request.socket.remoteAddress,
        cfIp: request.headers["cf-connecting-ip"],
        status: result.status,
      })}\n`,
    );
    return reply.code(result.status).send(result.body);
  });

  // --- Delivery reveal ----------------------------------------------------
  if (deps.delivery) {
    await registerDeliveryRoute(app, {
      db: deps.db,
      vault: deps.vault,
      session: deps.delivery.session,
      ...(deps.delivery.path !== undefined ? { path: deps.delivery.path } : {}),
    });
  }

  await app.ready();
  return app;
}
