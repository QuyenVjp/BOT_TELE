import { describe, expect, it } from "vitest";
import * as rootAdmin from "../../src/modules/identity/root-admin.js";
import * as adminConfirmation from "../../src/modules/identity/admin-confirmation.js";
import * as adminCallbacks from "../../src/bot/callbacks/admin.js";
import { OWNER_COMMANDS, isOwnerCommand } from "../../src/bot/callbacks/admin.js";

/**
 * T091 — No add-admin capability (FR-022, spec scenario 3).
 *
 * The system must expose NO command, callback, or function that promotes a
 * second root administrator. This is proven structurally: no exported symbol in
 * the identity/admin surface matches an add-admin shape, the owner-command
 * allowlist contains no grant/add-admin verb, and the allowlist gate rejects any
 * such command string.
 */

const ADD_ADMIN_SHAPE =
  /add.?admin|grant.?admin|promote|make.?admin|new.?admin|set.?owner|add.?owner/i;

describe("no add-admin capability (FR-022)", () => {
  it("exposes no add-admin-shaped export across the admin/identity surface", () => {
    const surfaces: Record<string, unknown>[] = [rootAdmin, adminConfirmation, adminCallbacks];
    const leaks: string[] = [];
    for (const mod of surfaces) {
      for (const name of Object.keys(mod)) {
        if (ADD_ADMIN_SHAPE.test(name)) leaks.push(name);
      }
    }
    expect(leaks).toEqual([]);
  });

  it("the owner-command allowlist contains no admin-granting verb", () => {
    const grantish = OWNER_COMMANDS.filter((c) => ADD_ADMIN_SHAPE.test(c));
    expect(grantish).toEqual([]);
  });

  it("rejects an add-admin command string through the allowlist gate", () => {
    for (const attempt of [
      "add-admin",
      "add_admin",
      "grantAdmin",
      "promote",
      "make-admin",
      "set-owner",
    ]) {
      expect(isOwnerCommand(attempt)).toBe(false);
    }
  });

  it("only recognizes the fixed operational command allowlist", () => {
    // Every recognized command is a known operational verb, never an identity grant.
    for (const cmd of OWNER_COMMANDS) {
      expect(isOwnerCommand(cmd)).toBe(true);
      expect(ADD_ADMIN_SHAPE.test(cmd)).toBe(false);
    }
  });
});
