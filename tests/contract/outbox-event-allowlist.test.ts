import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  KNOWN_OUTBOX_EVENT_TYPES,
  isKnownOutboxEventType,
} from "../../src/infrastructure/outbox/dispatch-policy.js";

/**
 * The drain dead-letters any event type it does not recognise, so a type that the app emits but the
 * allowlist omits is silent money: the customer who was charged, or whose deposit was kept, never
 * hears anything. Three of these were found by hand in one session (PreorderHoldForfeited,
 * PreorderShopCancelled, PreorderStockAllocated) plus two more (TicketOpened, PaymentIntentPresented)
 * — each one a live dead-letter path. This test reads the emitters so the next one cannot ship.
 */

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(path));
    else if (entry.name.endsWith(".ts") || entry.name.endsWith(".sql")) out.push(path);
  }
  return out;
}

/**
 * Event types this codebase emits. Emitters are TS helpers (`eventType: "X"`), raw SQL inserts in
 * the worker modules, and SQL triggers in the migrations — so the scan covers .ts and .sql. Both SQL
 * forms spell the type as a bare literal immediately before the payload builder, which is the only
 * position that distinguishes it from the aggregate type earlier in the same statement.
 */
function emittedEventTypes(): Map<string, string> {
  const found = new Map<string, string>();
  for (const path of sourceFiles("src")) {
    const source = readFileSync(path, "utf8");
    for (const match of source.matchAll(/eventType:\s*["']([A-Z][A-Za-z]+)["']/gu)) {
      const [, type] = match;
      if (type) found.set(type, path);
    }
    for (const match of source.matchAll(/'([A-Z][A-Za-z]{3,})',\s*jsonb_build_object/gu)) {
      const [, type] = match;
      if (type) found.set(type, path);
    }
  }
  return found;
}

describe("outbox event allowlist", () => {
  it("knows every event type the app emits", () => {
    const unknown = [...emittedEventTypes().entries()]
      .filter(([type]) => !isKnownOutboxEventType(type))
      .map(([type, path]) => `${type} (emitted in ${path})`);

    expect(unknown).toEqual([]);
  });

  it("still detects the emitters that a naive scan misses", () => {
    const detected = emittedEventTypes();
    // Raw-SQL emits: invisible to an `eventType: "X"` scan, which is how three of this session's
    // gaps hid. If the extraction breaks, this fails loudly instead of the guard passing empty.
    for (const type of [
      "PreorderStockAllocated",
      "PreorderHoldForfeited",
      "PreorderShopCancelled",
      "TicketOpened",
    ]) {
      expect(detected.has(type), `${type} was not detected by the scan`).toBe(true);
    }
  });

  it("keeps the allowlist free of duplicates", () => {
    expect(new Set(KNOWN_OUTBOX_EVENT_TYPES).size).toBe(KNOWN_OUTBOX_EVENT_TYPES.length);
  });
});
