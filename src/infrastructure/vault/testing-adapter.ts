import { AppError } from "../../shared/errors/index.js";
import { newId } from "../../shared/ids/index.js";
import type { Vault, VaultRef, VaultWriteOptions } from "./port.js";

/**
 * In-memory vault adapter for tests and single-process dev.
 *
 * Stores material in a Map keyed by an opaque ref. The ref is a fresh ULID with
 * a `vault:` prefix, so it never embeds the plaintext. A missing (or deleted)
 * ref raises {@link VaultError} rather than returning undefined, giving callers
 * no existence oracle. Production swaps a real KMS/secret-manager adapter behind
 * the same {@link Vault} port.
 */

export class VaultError extends AppError {
  constructor() {
    // Deliberately generic: no ref, no reason — avoids leaking whether a ref
    // ever existed vs was consumed.
    super("NOT_FOUND", "Secret is not available");
    this.name = "VaultError";
  }
}

export function createInMemoryVault(): Vault {
  const store = new Map<string, string>();

  return {
    async write(material: string, options?: VaultWriteOptions): Promise<VaultRef> {
      const ref = options?.idempotencyKey
        ? `vault:memory:${options.namespace ?? "asset"}:${options.idempotencyKey}`
        : `vault:${newId()}`;
      store.set(ref, material);
      return ref;
    },

    async reveal(ref: VaultRef): Promise<string> {
      const material = store.get(ref);
      if (material === undefined) {
        throw new VaultError();
      }
      return material;
    },

    async delete(ref: VaultRef): Promise<void> {
      store.delete(ref);
    },

    async health(): Promise<void> {},
  };
}
