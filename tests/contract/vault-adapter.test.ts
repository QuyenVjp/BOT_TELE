import { describe, expect, it } from "vitest";
import { createVault, VaultConfigError } from "../../src/infrastructure/vault/adapter.js";
import { VaultError } from "../../src/infrastructure/vault/testing-adapter.js";

/**
 * T072 — Production vault adapter boundary (SR-001).
 *
 * The memory driver is the test/dev store; the external driver fails closed
 * without endpoint/token so production never silently drops secrets into RAM.
 * Refs are opaque `vault:` handles and never embed the plaintext.
 */

describe("vault adapter (T072)", () => {
  it("memory driver writes and reveals material behind an opaque vault: ref", async () => {
    const vault = createVault({ driver: "memory" });
    const ref = await vault.write("USER:secret-42");
    expect(ref.startsWith("vault:")).toBe(true);
    expect(ref).not.toContain("secret-42");
    expect(await vault.reveal(ref)).toBe("USER:secret-42");
  });

  it("memory driver raises a stable error for a missing ref (no existence oracle)", async () => {
    const vault = createVault({ driver: "memory" });
    await expect(vault.reveal("vault:does-not-exist")).rejects.toBeInstanceOf(VaultError);
  });

  it("external driver refuses to boot without endpoint/token", () => {
    expect(() => createVault({ driver: "external" })).toThrow(VaultConfigError);
    expect(() =>
      createVault({ driver: "external", endpoint: "https://vault.example", token: "" }),
    ).toThrow(VaultConfigError);
  });

  it("external driver refuses to boot without a fail-closed egress policy", () => {
    expect(() =>
      createVault({
        driver: "external",
        endpoint: "https://vault.example",
        token: "vault-token",
      }),
    ).toThrow();
  });

  it("external driver with endpoint, token, and egress policy creates a health-checkable adapter", () => {
    const vault = createVault({
      driver: "external",
      endpoint: "https://vault.example",
      token: "vault-token",
      egressPolicy: {
        allowedHosts: ["vault.example"],
        allowedPorts: [443],
        allowedCidrs: ["203.0.113.0/24"],
      },
    });
    expect(vault.health).toBeTypeOf("function");
  });
});
