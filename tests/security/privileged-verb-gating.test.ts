import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { OWNER_COMMANDS } from "../../src/bot/callbacks/admin.js";
import {
  SENSITIVE_ACTION_POLICY,
  isSensitiveActionKey,
} from "../../src/modules/identity/sensitive-action.js";

/**
 * A privileged owner verb must not be able to exist without a declared gate.
 *
 * The failure mode this guards against is not a bug in a handler; it is the NEXT
 * handler. Adding a verb to `OWNER_COMMANDS` is a one-line change, and if the verb
 * is missing from the step-up policy it would silently execute on identity alone.
 * So the rule is: every owner verb is either in the policy table (gated) or in the
 * explicit low-risk allowlist below (read-only or trivially reversible), and there
 * is no third category.
 *
 * For the gated ones the test also pins WHERE the gate runs: `handle()` proves a
 * usable grant before a confirmation is minted, and `confirm()` spends it inside the
 * mutating path, so the mutation can never precede authorisation.
 */

/** Verbs that deliberately need no second factor: inspection and reversible toggles. */
const LOW_RISK_OWNER_COMMANDS = new Set([
  "catalog.activate",
  "catalog.deactivate",
  "discrepancy.list",
  "order.inspect",
  "inventory.import",
  "supplier.mapping.select",
  "supplier.mapping.clear",
  "supplier.mapping.verify",
  "store.close",
]);

const ROOT = resolve(import.meta.dirname, "../..");

function readSource(relativePath: string): string {
  return readFileSync(resolve(ROOT, relativePath), "utf8");
}

describe("privileged owner verbs are gated or explicitly low-risk", () => {
  it("has no third category: every owner verb is classified", () => {
    const unclassified = OWNER_COMMANDS.filter(
      (command) =>
        !isSensitiveActionKey(command) && !LOW_RISK_OWNER_COMMANDS.has(command as string),
    );
    expect(unclassified, "add these to SENSITIVE_ACTION_POLICY or the low-risk allowlist").toEqual(
      [],
    );
  });

  it("keeps the money- and audience-moving verbs in the step-up policy", () => {
    for (const command of [
      "wallet.refund",
      "manual_fulfillment.complete",
      "support.replacement.approve",
      "discrepancy.resolve",
      "store.open",
    ] as const) {
      expect(isSensitiveActionKey(command), `${command} must be step-up gated`).toBe(true);
      expect(SENSITIVE_ACTION_POLICY[command]).not.toBeNull();
    }
  });

  it("never maps a gated verb to a null category", () => {
    for (const [action, category] of Object.entries(SENSITIVE_ACTION_POLICY)) {
      expect(category, `${action} is in the policy table but requires no category`).not.toBeNull();
    }
  });

  it("enforces the catalogue kill-switch and supplier routing through the same layer", () => {
    // These are reversible, but they still change what customers can buy, so they are
    // gated through the layer as PERMISSION_CHANGE / SUPPLIER_CONFIG rather than left bare.
    expect(SENSITIVE_ACTION_POLICY["catalog.activate"]).toBe("PERMISSION_CHANGE");
    expect(SENSITIVE_ACTION_POLICY["catalog.deactivate"]).toBe("PERMISSION_CHANGE");
    expect(SENSITIVE_ACTION_POLICY["supplier.mapping.select"]).toBe("SUPPLIER_CONFIG");
    expect(SENSITIVE_ACTION_POLICY["supplier.mapping.clear"]).toBe("SUPPLIER_CONFIG");
  });
});

describe("the gate runs before the mutation, in one place", () => {
  const adminCallbacks = readSource("src/bot/callbacks/admin.ts");

  it("authorizes from the single layer, never inline", () => {
    expect(adminCallbacks).toContain("authorizeSensitiveAdminAction");
  });

  it("proves a grant in handle() before any confirmation is issued", () => {
    const handleIndex = adminCallbacks.indexOf("async handle(input)");
    const confirmIndex = adminCallbacks.indexOf("async confirm(input)");
    expect(handleIndex).toBeGreaterThan(-1);
    expect(confirmIndex).toBeGreaterThan(handleIndex);

    const handleBody = adminCallbacks.slice(handleIndex, confirmIndex);
    const gate = handleBody.indexOf("authorizeSensitiveAdminAction");
    const issue = handleBody.indexOf("confirmation.issue");
    expect(gate, "handle() must authorize").toBeGreaterThan(-1);
    expect(issue, "handle() must still mint a confirmation for high-risk verbs").toBeGreaterThan(
      -1,
    );
    expect(gate, "authorisation must precede confirmation issuance").toBeLessThan(issue);
  });

  it("spends the grant inside confirm()'s transaction, before the mutation", () => {
    const confirmBody = adminCallbacks.slice(adminCallbacks.indexOf("async confirm(input)"));
    // The gate lives INSIDE the `execute` callback, so the spend and the mutation share one
    // transaction: a refusal throws before `executeHighRisk`, and a rollback cannot leave a
    // mutation with an unspent grant.
    const executeCallback = confirmBody.indexOf("execute: async (trx, durableAction) =>");
    const gate = confirmBody.indexOf("authorizeSensitiveAdminAction");
    const mutation = confirmBody.indexOf("executeHighRisk(trx");
    expect(
      executeCallback,
      "confirm() executes the durable action in a transaction",
    ).toBeGreaterThan(-1);
    expect(gate, "confirm() must authorize").toBeGreaterThan(-1);
    expect(mutation, "confirm() must still run the mutation").toBeGreaterThan(-1);
    expect(gate, "the spend happens inside the execute callback").toBeGreaterThan(executeCallback);
    expect(gate, "the grant is spent before the mutation runs").toBeLessThan(mutation);

    // A refusal must not fall through to the mutation.
    const refusal = confirmBody.indexOf("if (!authorization.ok)");
    expect(refusal).toBeGreaterThan(gate);
    expect(refusal).toBeLessThan(mutation);
    expect(confirmBody.slice(refusal, mutation)).toContain("throw");
  });

  it("does not reintroduce a second signing scheme for admin callbacks", () => {
    // The `adm:` codec was a redundant mechanism and was removed rather than left dead.
    // If a future change adds signed admin callbacks, the gating above must be revisited
    // deliberately instead of arriving beside it.
    const codec = readSource("src/bot/callback-codec.ts");
    expect(codec).not.toContain("createAdminCallbackCodec");
    expect(codec).not.toContain("ADMIN_CALLBACK_ACTION_CODES");
  });
});
