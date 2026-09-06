import type { FastifyInstance } from "fastify";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { sql } from "kysely";
import type { Db } from "../../infrastructure/db/transaction.js";
import type { Vault } from "../../infrastructure/vault/port.js";
import { newId } from "../../shared/ids/index.js";
import { loadDeliveryNotificationCapability } from "./delivery-notification.js";
import { revealDeliveryBundle } from "./delivery.js";
import { verifyDeliverySessionToken, type DeliverySessionCodecConfig } from "./delivery-session.js";

/**
 * Authenticated delivery HTTP route (T074, FR-017, contracts/delivery.md).
 *
 * GET /d/:token — no-cache, no-referrer, owner-bound reveal. The plaintext
 * token is the path segment; authorization is a signed Telegram-bound session.
 * Concurrent/replayed reveals return a stable 410 without an existence oracle.
 *
 * Security headers deliberately kill caching and referrer leakage so a secret
 * cannot stick in a shared browser cache or leak via Referer to a third party.
 */

export const DELIVERY_ROUTE_PATH = "/d/:token";

export interface DeliveryRouteOptions {
  db: Db;
  vault: Vault;
  session: DeliverySessionCodecConfig;
  /** Optional path override (defaults to /d/:token). */
  path?: string;
  miniApp?: {
    botToken: string;
    path: string;
    maxAgeSeconds: number;
  };
}

const NO_CACHE_HEADERS = {
  "Cache-Control": "no-store, no-cache, must-revalidate, private",
  Pragma: "no-cache",
  Expires: "0",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Content-Security-Policy": "default-src 'none'; base-uri 'none'; form-action 'none'",
} as const;

export async function registerDeliveryRoute(
  app: FastifyInstance,
  options: DeliveryRouteOptions,
): Promise<void> {
  const path = options.path ?? DELIVERY_ROUTE_PATH;

  app.get(path, async (request, reply) => {
    // Apply anti-cache / anti-referrer headers on every response, including errors.
    for (const [k, v] of Object.entries(NO_CACHE_HEADERS)) {
      void reply.header(k, v);
    }

    const params = request.params as { token?: string };
    const token = params.token?.trim() ?? "";
    if (!token || token.length < 16) {
      return reply.code(400).send({ ok: false, error: "invalid_token" });
    }

    const authorization = request.headers.authorization;
    const bearer =
      typeof authorization === "string" && authorization.startsWith("Bearer ")
        ? authorization.slice(7)
        : "";
    const session = verifyDeliverySessionToken(bearer, options.session);
    if (!session) {
      return reply.code(401).send({ ok: false, error: "unauthorized" });
    }

    const result = await revealDeliveryBundle(options.db, {
      token,
      session,
      correlationId: `http-reveal-${token.slice(0, 8)}`,
      vault: options.vault,
    });

    if (!result.ok) {
      // Stable safe error — no existence oracle, no secret.
      return reply.code(410).send({ ok: false, error: "unavailable" });
    }

    // Minimum secret body over TLS. Never put the secret in a URL/query or a
    // cacheable content type that a browser might revalidate.
    return reply.code(200).header("Content-Type", "text/plain; charset=utf-8").send(result.secret);
  });

  const miniApp = options.miniApp;
  if (miniApp) {
    app.post(miniApp.path, async (request, reply) => {
      for (const [key, value] of Object.entries(NO_CACHE_HEADERS)) void reply.header(key, value);
      const body = parseJsonObject(request.body);
      const initData = typeof body?.initData === "string" ? body.initData : "";
      const handoffId = typeof body?.handoffId === "string" ? body.handoffId : "";
      const audience = typeof body?.audience === "string" ? body.audience : "";
      if (
        !initData ||
        Buffer.byteLength(initData, "utf8") > 4096 ||
        !/^[A-Za-z0-9_-]{1,128}$/.test(handoffId) ||
        audience !== options.session.audience
      ) {
        return reply.code(400).send({ ok: false, error: "invalid_request" });
      }
      const verified = verifyTelegramMiniAppInitData(initData, {
        botToken: miniApp.botToken,
        maxAgeSeconds: miniApp.maxAgeSeconds,
      });
      if (!verified) return reply.code(401).send({ ok: false, error: "unauthorized" });

      const handoff = await sql<{
        id: string;
        bundle_id: string;
        customer_id: string;
        telegram_chat_id: string;
        capability_ref: string;
      }>`
        select h.id, h.bundle_id, h.customer_id, h.telegram_chat_id, h.capability_ref
        from delivery_notification_handoff h
        join delivery_bundle b on b.id = h.bundle_id
        where h.id = ${handoffId} and h.telegram_chat_id = ${verified.telegramUserId}
          and h.capability_ref is not null
          and h.status in ('READY','RETRY','PROCESSING','SENT')
          and b.status in ('CREATED','AVAILABLE','VIEWED') and b.expires_at > now()
        limit 1
      `.execute(options.db);
      const row = handoff.rows[0];
      if (!row) return reply.code(404).send({ ok: false, error: "unavailable" });

      const inserted = await sql`
        insert into delivery_miniapp_redemption
          (id, init_data_hash, handoff_id, telegram_user_id, audience)
        values (${newId()}, ${verified.initDataHash}, ${row.id}, ${verified.telegramUserId}, ${audience})
        on conflict (init_data_hash) do nothing
        returning id
      `.execute(options.db);
      if (!inserted.rows[0]) return reply.code(409).send({ ok: false, error: "replayed" });

      try {
        const capability = await loadDeliveryNotificationCapability(options.vault, {
          id: row.id,
          bundleId: row.bundle_id,
          customerId: row.customer_id,
          telegramChatId: row.telegram_chat_id,
          capabilityRef: row.capability_ref,
          owner: "mini-app-redemption",
          generation: 0,
          attemptCount: 0,
        });
        const claims = verifyDeliverySessionToken(capability.sessionToken, options.session);
        if (
          !claims ||
          claims.bundleId !== row.bundle_id ||
          claims.customerId !== row.customer_id ||
          claims.telegramUserId !== row.telegram_chat_id ||
          claims.audience !== audience
        ) {
          throw new Error("invalid delivery capability");
        }
        return reply.code(200).send(capability);
      } catch {
        await sql`
          delete from delivery_miniapp_redemption
          where init_data_hash = ${verified.initDataHash} and handoff_id = ${row.id}
        `.execute(options.db);
        return reply.code(503).send({ ok: false, error: "temporarily_unavailable" });
      }
    });
  }
}

function parseJsonObject(value: unknown): Record<string, unknown> | null {
  try {
    const parsed: unknown = typeof value === "string" ? JSON.parse(value) : value;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export function verifyTelegramMiniAppInitData(
  initData: string,
  options: { botToken: string; maxAgeSeconds: number; now?: Date },
): { telegramUserId: string; initDataHash: string } | null {
  try {
    if (
      Buffer.byteLength(initData, "utf8") > 4096 ||
      Buffer.byteLength(options.botToken, "utf8") < 16 ||
      !Number.isInteger(options.maxAgeSeconds) ||
      options.maxAgeSeconds < 1 ||
      options.maxAgeSeconds > 3600
    ) {
      return null;
    }
    const params = new URLSearchParams(initData);
    const entries = [...params.entries()];
    if (new Set(entries.map(([key]) => key)).size !== entries.length) return null;
    const hash = params.get("hash") ?? "";
    if (!/^[a-f0-9]{64}$/.test(hash)) return null;
    const check = entries
      .filter(([key]) => key !== "hash")
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => `${key}=${value}`)
      .join("\n");
    const secret = createHmac("sha256", "WebAppData").update(options.botToken, "utf8").digest();
    const expected = Buffer.from(createHmac("sha256", secret).update(check, "utf8").digest("hex"));
    const presented = Buffer.from(hash);
    if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) return null;
    const authDate = Number(params.get("auth_date"));
    const nowSeconds = Math.floor((options.now ?? new Date()).getTime() / 1000);
    if (
      !Number.isSafeInteger(authDate) ||
      authDate > nowSeconds + 30 ||
      nowSeconds - authDate > options.maxAgeSeconds
    ) {
      return null;
    }
    const user: unknown = JSON.parse(params.get("user") ?? "null");
    if (!user || typeof user !== "object" || Array.isArray(user)) return null;
    const id = (user as Record<string, unknown>).id;
    if (!Number.isSafeInteger(id) || Number(id) <= 0) return null;
    return {
      telegramUserId: String(id),
      initDataHash: createHash("sha256").update(initData, "utf8").digest("hex"),
    };
  } catch {
    return null;
  }
}
