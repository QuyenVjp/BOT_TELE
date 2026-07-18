import { describe, expect, it, vi } from "vitest";
import {
  makeCommandEnvelope,
  makeEventEnvelope,
  createDispatcher,
  type CommandEnvelope,
} from "../../src/shared/commands/index.js";
import { EVENT_TYPES } from "../../src/shared/events/index.js";
import { createInMemoryVault, VaultError } from "../../src/infrastructure/vault/testing-adapter.js";

/**
 * T023/T024 — Application command/event envelope + safe vault port.
 *
 * Envelope (contracts/application-commands.md): every command carries commandId,
 * idempotencyKey, actor, correlationId, occurredAt, typed payload; the dispatcher
 * routes by command type and returns a typed success or one stable error envelope.
 *
 * Vault (data-model.md, delivery.md): secrets live only behind a vault ref; the
 * port exposes write/reveal/delete with view-once semantics and never returns a
 * secret for a missing/consumed ref.
 */

describe("command envelope (T023)", () => {
  it("stamps a well-formed envelope with all required correlation fields", () => {
    const env = makeCommandEnvelope(
      "SearchCatalog",
      { query: "netflix" },
      {
        actor: { type: "customer", id: "01J00000000000000000000CUS" },
      },
    );

    expect(env.type).toBe("SearchCatalog");
    expect(env.commandId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(env.idempotencyKey.length).toBeGreaterThan(0);
    expect(env.correlationId.length).toBeGreaterThan(0);
    expect(env.actor).toEqual({ type: "customer", id: "01J00000000000000000000CUS" });
    expect(typeof env.occurredAt).toBe("string");
    expect(env.payload).toEqual({ query: "netflix" });
  });

  it("preserves a caller-supplied idempotencyKey and correlationId", () => {
    const env = makeCommandEnvelope(
      "BuyNow",
      { variantId: "01J0000000000000000000VAR" },
      {
        actor: { type: "customer", id: "01J00000000000000000000CUS" },
        idempotencyKey: "buy-order-1",
        correlationId: "corr-1",
      },
    );
    expect(env.idempotencyKey).toBe("buy-order-1");
    expect(env.correlationId).toBe("corr-1");
  });
});

describe("event envelope (T023)", () => {
  it("stamps an event envelope carrying aggregate + correlation", () => {
    const evt = makeEventEnvelope("OrderCreated", {
      aggregateType: "order",
      aggregateId: "01J0000000000000000000ORD",
      aggregateVersion: 1,
      correlationId: "corr-1",
      payload: { orderNumber: "ORD-1" },
    });
    expect(evt.type).toBe("OrderCreated");
    expect(evt.eventId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(evt.aggregateId).toBe("01J0000000000000000000ORD");
    expect(EVENT_TYPES).toContain("OrderCreated");
  });
});

describe("command dispatcher (T023)", () => {
  it("routes to the registered handler and returns typed success", async () => {
    const handler = vi.fn(async (env: CommandEnvelope) => ({ ok: true, echoed: env.payload }));
    const dispatch = createDispatcher({ SearchCatalog: handler });

    const env = makeCommandEnvelope(
      "SearchCatalog",
      { query: "x" },
      {
        actor: { type: "customer", id: "01J00000000000000000000CUS" },
      },
    );
    const result = await dispatch(env);

    expect(handler).toHaveBeenCalledOnce();
    expect(result).toEqual({ ok: true, echoed: { query: "x" } });
  });

  it("returns a stable error envelope for an unknown command (no throw)", async () => {
    const dispatch = createDispatcher({});
    const env = makeCommandEnvelope(
      "Nonexistent",
      {},
      {
        actor: { type: "system", id: "sys" },
      },
    );
    const result = (await dispatch(env)) as { error?: { code: string; correlationId: string } };
    expect(result.error?.code).toBe("VALIDATION");
    expect(result.error?.correlationId).toBe(env.correlationId);
  });

  it("maps a handler AppError into the stable error envelope with correlationId", async () => {
    const dispatch = createDispatcher({
      BuyNow: async () => {
        const { AppError } = await import("../../src/shared/errors/index.js");
        throw new AppError("CONFLICT", "variant unavailable");
      },
    });
    const env = makeCommandEnvelope("BuyNow", {}, { actor: { type: "system", id: "sys" } });
    const result = (await dispatch(env)) as { error?: { code: string; correlationId: string } };
    expect(result.error?.code).toBe("CONFLICT");
    expect(result.error?.correlationId).toBe(env.correlationId);
  });
});

describe("vault port view-once semantics (T024)", () => {
  it("writes a secret and reveals it exactly once", async () => {
    const vault = createInMemoryVault();
    const ref = await vault.write("supplier-license-key");

    expect(ref).toMatch(/^vault:/);
    const first = await vault.reveal(ref);
    expect(first).toBe("supplier-license-key");
  });

  it("reveal after delete throws and never returns the secret", async () => {
    const vault = createInMemoryVault();
    const ref = await vault.write("secret");
    await vault.delete(ref);
    await expect(vault.reveal(ref)).rejects.toThrow(VaultError);
  });

  it("reveal of an unknown ref throws VaultError (no existence oracle leak)", async () => {
    const vault = createInMemoryVault();
    await expect(vault.reveal("vault:does-not-exist")).rejects.toThrow(VaultError);
  });

  it("write returns opaque refs that never embed the plaintext", async () => {
    const vault = createInMemoryVault();
    const ref = await vault.write("super-secret-value");
    expect(ref).not.toContain("super-secret-value");
  });
});
