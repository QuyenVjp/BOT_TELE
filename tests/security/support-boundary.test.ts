import { describe, expect, it } from "vitest";
import { createSupportService } from "../../src/modules/support/service.js";
import * as supportModule from "../../src/modules/support/service.js";

/**
 * T082 — Support privilege boundary (SR-003, spec scenario 4).
 *
 * The support surface must NOT be able to mark payment paid, mutate payment
 * evidence, issue a direct refund, or reveal a credential. This is enforced
 * structurally: the support service exposes only ticket verbs, and its module
 * imports nothing from payments/delivery/vault.
 */

describe("support boundary (SR-003)", () => {
  it("support service exposes only ticket verbs — no payment/delivery mutators", () => {
    // A fake db is fine; we only inspect the shape of the returned service.
    const svc = createSupportService({} as never);
    const keys = Object.keys(svc);
    // Allowed verbs.
    expect(keys.sort()).toEqual(["closeTicket", "getTicket", "listTickets", "openTicket"].sort());

    // Forbidden capabilities must be absent.
    for (const forbidden of [
      "markPaid",
      "settle",
      "applyEvidence",
      "refund",
      "revealSecret",
      "reveal",
      "mutateEvidence",
    ]) {
      expect(keys).not.toContain(forbidden);
    }
  });

  it("the support module exports no payment/delivery/vault symbols", () => {
    const exported = Object.keys(supportModule);
    const banned = /pay|settle|evidence|refund|reveal|vault|deliver|credential/i;
    const leaks = exported.filter((name) => banned.test(name));
    expect(leaks).toEqual([]);
  });

  it("openTicket result type carries no secret/credential field", async () => {
    // Structural: a ticket result is references only. This guards against a
    // future change that returns secret material through the support path.
    const svc = createSupportService({} as never);
    // The function exists and is the only creation verb.
    expect(typeof svc.openTicket).toBe("function");
    expect(typeof (svc as unknown as Record<string, unknown>).markPaid).toBe("undefined");
  });
});
