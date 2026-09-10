import type { FastifyInstance } from "fastify";
import type { Db } from "../../infrastructure/db/transaction.js";
import type { Vault } from "../../infrastructure/vault/port.js";
import { revealDeliveryBundle } from "./delivery.js";
import { verifyDeliverySessionToken, type DeliverySessionCodecConfig } from "./delivery-session.js";

/**
 * Authenticated delivery HTTP route (T074, FR-017).
 *
 * GET /d/:token — no-cache, no-referrer, owner-bound reveal. Authorization is a
 * signed Telegram-bound session Bearer token. Mini App initData redeem is
 * cancelled; customers receive credentials in Telegram chat.
 */

export const DELIVERY_ROUTE_PATH = "/d/:token";

export interface DeliveryRouteOptions {
  db: Db;
  vault: Vault;
  session: DeliverySessionCodecConfig;
  /** Optional path override (defaults to /d/:token). */
  path?: string;
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
    for (const [k, v] of Object.entries(NO_CACHE_HEADERS)) {
      void reply.header(k, v);
    }

    const params = request.params as { token?: string };
    const token = params.token ?? "";
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
      return reply.code(410).send({ ok: false, error: "unavailable" });
    }

    return reply.code(200).header("Content-Type", "text/plain; charset=utf-8").send(result.secret);
  });
}
