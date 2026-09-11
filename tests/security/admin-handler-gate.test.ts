import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Every admin handler reachable from Telegram must pass a real root gate.
 *
 * `adminCallbacks` is constructed once from config, so `if (!adminCallbacks) return denied`
 * is true for the owner AND for every other caller — it proves the FEATURE is configured,
 * never that the ACTOR is the owner. That exact placeholder was the whole authorization on
 * `preorders`, so any Telegram user in a private chat could send
 * `admin:preorders:cancel:<id>` and cancel a reservation plus create a real refund
 * obligation. The handler's own doc comment (on `requireRootAdmin`) warned about this trap;
 * nothing enforced it.
 *
 * This test enforces it mechanically: a handler may not rely on the placeholder alone, and
 * any handler that legitimately delegates its gate to a module must say so in the list
 * below. Adding a new admin handler without a gate fails here rather than in production.
 */

const ROOT = resolve(import.meta.dirname, "../..");

/** A call that actually decides whether THIS actor is the configured owner. */
const REAL_GATES = [
  "requireRootAdmin(",
  "adminCallbacks.handle(",
  "adminCallbacks.confirm(",
  "authorizeSensitiveAdminAction(",
  "authorizeRootAction(",
  "guardRootAction(",
] as const;

/**
 * Handlers that contain the `!adminCallbacks` placeholder and no gate call in their own
 * body, because the gate lives inside the module they call. Each entry names where the
 * real check is, so the exemption is a reviewed decision rather than a silent hole.
 *
 * Verified by reading the named module:
 *  - `confirmInventoryImportSession` calls `authorizeRootAction` (inventory-import-session.ts)
 *  - `confirmFileArtifactImportSession` calls `authorizeRootAction` (file-artifact-import-session.ts)
 *  - `stageInventoryImportBatch` calls `authorizeRootAction` (inventory-import-session.ts)
 *  - `startInventoryImportSession` calls `authorizeRootAction` (inventory-import-session.ts)
 *  - `cancelInventoryImportSession` calls `authorizeRootAction` (inventory-import-session.ts)
 *  - `createInventoryImportTemplate` calls `authorizeRootAction` (inventory-import-session.ts)
 *  - `createFileArtifactImportSession` calls `authorizeRootAction` (file-artifact-import-session.ts)
 */
const GATE_DELEGATED_TO_MODULE = new Set([
  "testLab",
  "inventoryAdd",
  "inventoryTemplateSelect",
  "inventoryPasteSelect",
  "inventoryPickProduct",
  "importTemplate",
  "importText",
  "importDocument",
  "importFileConfirm",
  "importConfirm",
]);

interface Handler {
  name: string;
  body: string;
}

/** Every `async <name>(input…` at the indentation the admin surface object uses. */
function adminSurfaceHandlers(): Handler[] {
  const lines = readFileSync(resolve(ROOT, "src/worker.ts"), "utf8").split("\n");
  const starts: Array<{ line: number; name: string }> = [];
  const pattern = /^ {6}async ([A-Za-z][A-Za-z0-9]*)\(input/;
  lines.forEach((line, index) => {
    const match = pattern.exec(line);
    if (match) starts.push({ line: index, name: match[1]! });
  });

  return starts.map((start, index) => {
    const end = starts[index + 1]?.line ?? lines.length;
    return { name: start.name, body: lines.slice(start.line, end).join("\n") };
  });
}

describe("admin handlers pass a real root gate", () => {
  const handlers = adminSurfaceHandlers();

  it("finds the admin surface at all (guards the guard)", () => {
    // If the indentation or the call shape changes, this test must fail loudly rather than
    // silently scan nothing and report success.
    expect(handlers.length).toBeGreaterThan(80);
    expect(handlers.map((h) => h.name)).toContain("preorders");
    expect(handlers.map((h) => h.name)).toContain("confirm");
  });

  it("never authorises on the `!adminCallbacks` placeholder alone", () => {
    const ungated = handlers
      .filter((h) => h.body.includes("!adminCallbacks"))
      .filter((h) => !REAL_GATES.some((gate) => h.body.includes(gate)))
      .map((h) => h.name)
      .filter((name) => !GATE_DELEGATED_TO_MODULE.has(name))
      .sort();

    expect(
      ungated,
      "these handlers trust `!adminCallbacks` (true for EVERY caller) and never check the actor; " +
        "add a real gate or record the module that performs it in GATE_DELEGATED_TO_MODULE",
    ).toEqual([]);
  });

  it("gates preorder cancellation, the handler that was missing one", () => {
    const preorders = handlers.find((h) => h.name === "preorders");
    expect(preorders, "preorders handler missing").toBeDefined();
    expect(preorders!.body).toContain("requireRootAdmin(");
    // The gate must run BEFORE the mutation, not after it.
    const gate = preorders!.body.indexOf("requireRootAdmin(");
    const mutation = preorders!.body.indexOf("shopCancelPreorder(");
    expect(gate).toBeGreaterThan(-1);
    expect(mutation).toBeGreaterThan(-1);
    expect(gate, "authorisation must precede the cancellation").toBeLessThan(mutation);
  });

  it("keeps `shopCancelPreorder` free of a hidden second gate that callers cannot see", () => {
    // The module takes `actorTelegramUserId` as a plain string and only stamps `created_by`
    // with it, so the CALLER owns the authorization. That is why the test above matters:
    // if this ever becomes self-authorising, the handler test should be revisited rather
    // than kept as a false assurance.
    const module = readFileSync(resolve(ROOT, "src/modules/commerce/shop-cancel.ts"), "utf8");
    expect(module).not.toContain("authorizeRootAction");
    expect(module).not.toContain("guardRootAction");
    expect(module).toContain("actorTelegramUserId");
  });

  it("runs the preorders gate through the shared helper rather than a local compare", () => {
    // A hand-rolled `Number(input.telegramUserId) !== config.ADMIN_TELEGRAM_USER_ID` check
    // works but skips the audit trail and the private-context rule that `requireRootAdmin`
    // applies, which is the inconsistency that let this bug exist.
    const preorders = handlers.find((h) => h.name === "preorders")!;
    expect(preorders.body).not.toContain("ADMIN_TELEGRAM_USER_ID");
  });
});
