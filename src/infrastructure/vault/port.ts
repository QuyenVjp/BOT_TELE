/**
 * Vault port (data-model.md Conventions; delivery.md; SR-001).
 *
 * Raw secret material — supplier credentials, activation keys, delivered
 * license bodies — lives ONLY behind a vault reference. Domain tables, logs,
 * events, and support transcripts persist the opaque `ref`, never the plaintext.
 *
 * The port is deliberately tiny:
 *  - `write` stores material and returns an opaque `vault:` ref;
 *  - `reveal` returns the plaintext for a live ref (used at the delivery/vault
 *    boundary only);
 *  - `delete` removes it (revocation / post-delivery cleanup).
 *
 * Implementations must never encode the plaintext into the ref, and must raise a
 * stable error (not return undefined) for a missing/consumed ref so callers get
 * no existence oracle.
 */

/** Opaque handle to stored secret material. Always begins with `vault:`. */
export type VaultRef = string;

export interface VaultWriteOptions {
  /** Provider namespace for provenance and bounded cleanup. */
  namespace?: "asset" | "capability";
  /** Stable retry key. It must not contain credential material. */
  idempotencyKey?: string;
}

export interface Vault {
  /** Store secret material; returns an opaque ref. */
  write(material: string, options?: VaultWriteOptions): Promise<VaultRef>;
  /** Reveal plaintext for a live ref; throws if missing/consumed. */
  reveal(ref: VaultRef): Promise<string>;
  /** Remove material for a ref (idempotent: deleting an unknown ref is a no-op). */
  delete(ref: VaultRef): Promise<void>;
  /** Fail-closed dependency health probe used by readiness/startup composition. */
  health?(): Promise<void>;
}
