import { afterEach, describe, expect, it, vi } from "vitest";
import type { Vault } from "../../src/infrastructure/vault/port.js";
import type { Db } from "../../src/infrastructure/db/transaction.js";
import { createInMemoryUpdateInbox } from "../../src/bot/webhook.js";

/**
 * T116 — App composition (no Docker required).
 *
 * These tests prove `createApp` wires a real Fastify instance with:
 *   - GET /health (liveness) that never touches the database,
 *   - GET /ready (readiness) that pings the database and fails closed,
 *   - the Telegram webhook route (secret-gated),
 *   - the SePay webhook route with RAW body preserved for HMAC verification,
 *   - the authenticated Delivery Bundle route,
 *   - graceful close.
 *
 * All external dependencies are injected fakes, so the composition is exercised
 * with `app.inject()` and no network or container.
 */

// Loaded dynamically so a compile/import error surfaces as a red test, not a
// collection error, while `src/app.ts` does not yet exist.
async function loadCreateApp() {
  const mod = await import("../../src/app.js");
  return mod.createApp;
}

interface DbSpy {
  db: Db;
  executeQuery: ReturnType<typeof vi.fn>;
}

function fakeDb(opts: { pingOk: boolean }): DbSpy {
  // Readiness pings via sql`select 1`.execute(db), which resolves to
  // db.getExecutor().executeQuery(compiledQuery). A rejecting executor models an
  // unreachable database. Liveness (/health) must never call this.
  const executeQuery = opts.pingOk
    ? vi.fn().mockResolvedValue({ rows: [{ ok: 1 }] })
    : vi.fn().mockRejectedValue(new Error("db down"));
  const executor = {
    transformQuery: (node: unknown) => node,
    compileQuery: (node: unknown) => ({ query: node, sql: "select 1", parameters: [] }),
    executeQuery,
  };
  const db = {
    getExecutor: () => executor,
  } as unknown as Db;
  return { db, executeQuery };
}

function fakeVault(healthOk = true): Vault {
  return {
    write: vi.fn().mockResolvedValue("vault:test-ref"),
    reveal: vi.fn().mockResolvedValue("SECRET"),
    delete: vi.fn().mockResolvedValue(undefined),
    health: healthOk
      ? vi.fn().mockResolvedValue(undefined)
      : vi.fn().mockRejectedValue(new Error("vault down")),
  } as unknown as Vault;
}

const BASE_DEPS = () => {
  const dbSpy = fakeDb({ pingOk: true });
  return {
    db: dbSpy.db,
    dbSpy,
    vault: fakeVault(),
    telegram: {
      path: "/telegram/webhook",
      secretToken: "webhook-secret-abcdefgh",
      inbox: createInMemoryUpdateInbox(),
    },
    sepay: {
      path: "/webhooks/sepay",
      handler: vi.fn().mockResolvedValue({ status: 200, body: { ok: true } }),
    },
    delivery: {
      session: {
        key: "test-only-app-delivery-session-key-material-123456",
        keyVersion: 1,
        audience: "delivery-reveal",
      },
    },
    bodyLimitBytes: 65536,
    logger: { level: "silent" as const },
  };
};

let closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of closers) await c();
  closers = [];
});

describe("createApp composition", () => {
  it("serves GET /health without touching the database", async () => {
    const createApp = await loadCreateApp();
    const deps = BASE_DEPS();
    const app = await createApp(deps);
    closers.push(() => app.close());

    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "ok" });
    // Liveness must not depend on the DB.
    expect(deps.dbSpy.executeQuery).not.toHaveBeenCalled();
  });
  it("rate-limits the protected Google Sheets inventory routes", async () => {
    const createApp = await loadCreateApp();
    const deps = BASE_DEPS();
    const app = await createApp({
      ...deps,
      googleSheetsInventoryIntake: {
        db: deps.db,
        vault: deps.vault,
        rootConfig: { adminTelegramUserId: 123, expectedUsername: "owner" },
        spreadsheetId: "sheet-test",
        ownerVerifier: {
          verify: vi.fn().mockResolvedValue({ ok: false, code: "UNAUTHORIZED" }),
        },
      },
    });
    closers.push(() => app.close());

    const statuses: number[] = [];
    for (let attempt = 0; attempt < 31; attempt += 1) {
      const response = await app.inject({
        method: "POST",
        url: "/ops/google-sheets/inventory-intake/catalog",
        payload: JSON.stringify({ spreadsheetId: "sheet-test" }),
      });
      statuses.push(response.statusCode);
    }

    expect(statuses.slice(0, 30).every((status) => status === 401)).toBe(true);
    expect(statuses[30]).toBe(429);
  });

  it("GET /ready returns 503 when the database ping fails", async () => {
    const createApp = await loadCreateApp();
    const down = fakeDb({ pingOk: false });
    const deps = { ...BASE_DEPS(), db: down.db, dbSpy: down };
    const app = await createApp(deps);
    closers.push(() => app.close());

    const res = await app.inject({ method: "GET", url: "/ready" });
    expect(res.statusCode).toBe(503);
  });

  it("GET /ready returns 200 only after database and vault probes pass", async () => {
    const createApp = await loadCreateApp();
    const deps = BASE_DEPS();
    const app = await createApp(deps);
    closers.push(() => app.close());

    const res = await app.inject({ method: "GET", url: "/ready" });
    expect(res.statusCode).toBe(200);
    expect(deps.dbSpy.executeQuery).toHaveBeenCalledOnce();
    expect(deps.vault.health).toHaveBeenCalledOnce();
  });

  it("GET /ready fails closed when the external vault health probe fails", async () => {
    const createApp = await loadCreateApp();
    const deps = { ...BASE_DEPS(), vault: fakeVault(false) };
    const app = await createApp(deps);
    closers.push(() => app.close());

    const res = await app.inject({ method: "GET", url: "/ready" });
    expect(res.statusCode).toBe(503);
  });

  it("rejects a Telegram webhook with a wrong secret token (401) before dispatch", async () => {
    const createApp = await loadCreateApp();
    const deps = BASE_DEPS();
    const accept = vi.fn().mockResolvedValue({ kind: "ACCEPTED", id: "should-not-run" });
    deps.telegram.inbox = { accept };
    const app = await createApp(deps);
    closers.push(() => app.close());

    const res = await app.inject({
      method: "POST",
      url: "/telegram/webhook",
      headers: { "x-telegram-bot-api-secret-token": "wrong" },
      payload: { update_id: 1 },
    });
    expect(res.statusCode).toBe(401);
    expect(accept).not.toHaveBeenCalled();
  });

  it("forwards username observation metadata only after the Telegram secret gate passes", async () => {
    const createApp = await loadCreateApp();
    const deps = BASE_DEPS();
    const accept = vi.fn().mockResolvedValue({ kind: "ACCEPTED", id: "verified-update" });
    deps.telegram.inbox = { accept };
    const app = await createApp(deps);
    closers.push(() => app.close());

    const res = await app.inject({
      method: "POST",
      url: "/telegram/webhook",
      headers: { "x-telegram-bot-api-secret-token": "webhook-secret-abcdefgh" },
      payload: {
        update_id: 2,
        message: {
          message_id: 1,
          from: { id: 123456789, username: "verified_customer" },
          chat: { id: 123456789, type: "private" },
          text: "/start",
        },
      },
    });

    expect(res.statusCode).toBe(200);
    expect(accept).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceEventId: "2",
        envelope: expect.objectContaining({
          actorUserId: "123456789",
          actorUsername: "verified_customer",
        }),
      }),
    );
  });

  it("preserves the SePay raw body bytes for the handler", async () => {
    const createApp = await loadCreateApp();
    const deps = BASE_DEPS();
    const app = await createApp(deps);
    closers.push(() => app.close());

    const raw = '{"id":42,"amount":100000,"note":"un—icode"}';
    const res = await app.inject({
      method: "POST",
      url: "/webhooks/sepay",
      headers: { "content-type": "application/json" },
      payload: raw,
    });
    expect(res.statusCode).toBe(200);
    expect(deps.sepay.handler).toHaveBeenCalledTimes(1);
    const call = deps.sepay.handler.mock.calls[0]![0] as { rawBody: string };
    // The handler must receive the exact bytes we sent (byte-preserving), not a
    // re-serialized JSON that would break HMAC verification.
    expect(call.rawBody).toBe(raw);
  });

  it("rejects an oversized SePay body before the verifier is invoked", async () => {
    const createApp = await loadCreateApp();
    const deps = { ...BASE_DEPS(), bodyLimitBytes: 128 };
    const app = await createApp(deps);
    closers.push(() => app.close());

    const res = await app.inject({
      method: "POST",
      url: "/webhooks/sepay",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ content: "x".repeat(512) }),
    });

    expect(res.statusCode).toBe(413);
    expect(deps.sepay.handler).not.toHaveBeenCalled();
  });

  it("exposes the delivery route path", async () => {
    const createApp = await loadCreateApp();
    const deps = BASE_DEPS();
    const app = await createApp(deps);
    closers.push(() => app.close());

    // Short reveal token is rejected by the delivery route (proves it is wired).
    const res = await app.inject({ method: "GET", url: "/d/short" });
    expect([400, 401]).toContain(res.statusCode);
  });
});
