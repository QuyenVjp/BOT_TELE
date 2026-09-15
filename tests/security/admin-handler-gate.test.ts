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
 * Handlers whose actor check is INLINE, not the shared helper.
 *
 * `Number(input.telegramUserId) !== config.ADMIN_TELEGRAM_USER_ID` plus a private-chat test is
 * a real numeric-id check, so these are not authorization holes. They are listed rather than
 * silently accepted because they skip the audit trail `requireRootAdmin` writes on a denial,
 * and pinning them here means a NEW handler cannot quietly join this weaker group: it has to
 * be added deliberately, in this list, in this file.
 */
const INLINE_NUMERIC_CHECK: ReadonlySet<string> = new Set([
  "broadcastAudience",
  "broadcastStatus",
  "broadcastText",
  "categories",
  "categoryAction",
  "categoryCreatePrompt",
  "customerMessagePrompt",
  "customerSearch",
  "customerState",
  "customerText",
  "customers",
  "health",
  "importConfirm",
  "importDocument",
  "importFileConfirm",
  "importTemplate",
  "importText",
  "notifications",
  "orderMessagePrompt",
  "orderSearch",
  "orderState",
  "orderText",
  "orders",
  "presentAdminCustomerDetail",
  "quantityAdjustConfirm",
  "sendAdminCustomerMessage",
  "storeMode",
  "storeOpen",
  "supplierClear",
  "supplierSelect",
  "supplierVerify",
  "testCustomerAddPrompt",
  "testCustomerDelete",
  "testCustomers",
]);

/**
 * Handlers that delegate their actor check to the module they call.
 *
 * Each entry names the callee, so a reviewer can verify the claim instead of trusting it.
 * `broadcastConfirm` is the load-bearing example: it calls `enqueueBroadcastFromOwner`, which
 * runs `requireRootAdmin` before anything else.
 */
const GATE_DELEGATED_TO_MODULE: ReadonlyMap<string, string> = new Map([
  ["broadcastConfirm", "enqueueBroadcastFromOwner (src/worker.ts) calls requireRootAdmin"],
  ["testLab", "inventory template reads are gated by the caller's requireRootAdmin"],
  ["inventoryAdd", "createInventoryImportTemplate calls authorizeRootAction"],
  ["inventoryTemplateSelect", "createInventoryImportTemplate calls authorizeRootAction"],
  ["inventoryPasteSelect", "createInventoryImportTemplate calls authorizeRootAction"],
  ["inventoryPickProduct", "startInventoryImportSession calls authorizeRootAction"],
  ["importTemplate", "createInventoryImportTemplate calls authorizeRootAction"],
  ["importText", "stageInventoryImportBatch calls authorizeRootAction"],
  ["importDocument", "createFileArtifactImportSession calls authorizeRootAction"],
  ["importFileConfirm", "confirmFileArtifactImportSession calls authorizeRootAction"],
  ["importConfirm", "confirmInventoryImportSession calls authorizeRootAction"],
]);

interface Handler {
  name: string;
  body: string;
}

/**
 * Every admin handler, found regardless of how it is spelled, INSIDE the admin surface.
 *
 * Two earlier versions were unsound in opposite directions, and both holes mattered:
 *
 *  - The first keyed on `^ {6}async <name>(input` and then only examined bodies containing
 *    `!adminCallbacks`. A handler written as a property arrow, or one that simply omitted the
 *    placeholder, was never examined at all.
 *  - Widening the pattern to every method-like line made the scan cover unrelated surfaces:
 *    `catalog` callbacks and plain inner helpers (`back`, `cancel`) live in the same file, and
 *    demanding a root gate from them is noise that would train a reader to add exemptions.
 *
 * So the region is bounded first — the `admin: {` object literal inside the dispatcher deps —
 * and every method-like member inside that region is checked, in any spelling. Comments are
 * stripped before the gate is looked for, because a gate named in prose is not a gate.
 */
function adminSurfaceRegion(source: string): string {
  const anchor = source.indexOf("\n    admin: {");
  if (anchor === -1) throw new Error("admin surface object not found in src/worker.ts");
  const open = source.indexOf("{", anchor);
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    const char = source[index];
    if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, index);
    }
  }
  throw new Error("admin surface object is not brace-balanced");
}

function stripComments(body: string): string {
  return body.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/[^\n]*/g, "$1");
}

/** Every method-like member of the admin surface, with comments removed. */
function adminSurfaceHandlers(): Handler[] {
  const region = adminSurfaceRegion(readFileSync(resolve(ROOT, "src/worker.ts"), "utf8"));
  const lines = region.split("\n");
  const starts: Array<{ line: number; name: string }> = [];
  // The region's members sit at one exact indentation (`admin: {` is at 4, its members at
  // 6). Pinning it is what separates a member from a closure declared INSIDE a handler:
  // `back` and `applySku` are helpers, not entry points, and demanding a root gate from them
  // would only teach a reader to widen the exemption list.
  const patterns = [
    /^ {6}async ([A-Za-z][A-Za-z0-9]*)\(/,
    /^ {6}([A-Za-z][A-Za-z0-9]*):\s*async\s*\(/,
    /^ {6}([A-Za-z][A-Za-z0-9]*):\s*async\s+function\s*\(/,
  ];
  lines.forEach((line, index) => {
    for (const pattern of patterns) {
      const match = pattern.exec(line);
      if (match) {
        starts.push({ line: index, name: match[1]! });
        return;
      }
    }
  });

  return starts.map((entry, index) => {
    const end = starts[index + 1]?.line ?? lines.length;
    return {
      name: entry.name,
      body: stripComments(lines.slice(entry.line, end).join("\n")),
    };
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

  it("gives every handler an actor check — shared helper, inline id, or documented delegation", () => {
    // The property that matters is "this handler decides whether the ACTOR is the owner".
    // An earlier version only examined handlers containing `!adminCallbacks`, which let a
    // handler escape by not mentioning it — the two text interceptors that were fixed
    // alongside this test were found exactly that way.
    const unchecked = handlers
      .filter((h) => !REAL_GATES.some((gate) => h.body.includes(gate)))
      .filter((h) => !INLINE_NUMERIC_CHECK.has(h.name))
      .filter((h) => !GATE_DELEGATED_TO_MODULE.has(h.name))
      .map((h) => h.name)
      .sort();

    expect(
      unchecked,
      "these handlers never decide whether the actor is the owner; add a gate, or list the " +
        "inline check / the module that performs it",
    ).toEqual([]);
  });

  it("keeps every inline-check exemption honest", () => {
    // An entry in INLINE_NUMERIC_CHECK must actually contain the inline compare, so the list
    // cannot be used as a place to park an ungated handler.
    for (const name of INLINE_NUMERIC_CHECK) {
      const handler = handlers.find((h) => h.name === name);
      expect(handler, `${name} is exempted but no longer exists`).toBeDefined();
      expect(handler!.body, `${name} is exempted but has no inline id check`).toContain(
        "ADMIN_TELEGRAM_USER_ID",
      );
    }
  });

  it("strips comments before looking for a gate", () => {
    // Tested directly, so the property is exact rather than inferred from the scan output.
    expect(stripComments("// requireRootAdmin(\nx();")).not.toContain("requireRootAdmin(");
    expect(stripComments("/* requireRootAdmin( */\nx();")).not.toContain("requireRootAdmin(");
    // Real code survives, and a URL's `//` is not mistaken for a comment.
    expect(stripComments('x();\nconst u = "https://example.com/a";')).toContain(
      "https://example.com/a",
    );
    expect(stripComments("requireRootAdmin(x);")).toContain("requireRootAdmin(");
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
