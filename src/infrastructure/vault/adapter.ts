import { createInMemoryVault } from "./testing-adapter.js";
import type { Vault } from "./port.js";
import { AppError } from "../../shared/errors/index.js";
import {
  createExternalVault,
  ExternalVaultError,
  type ExternalVaultEgressPolicy,
} from "./external-adapter.js";

/**
 * Production vault adapter boundary (T072, SR-001).
 *
 * Selects a concrete {@link Vault} implementation from configuration. The
 * `memory` driver is the in-process store used by tests and single-node dev.
 * The `external` driver is the production seam: it refuses to boot without an
 * endpoint/token, and a future KMS/secret-manager SDK plugs in behind the same
 * port without changing domain code.
 *
 * Secrets never leave the vault as anything other than a `vault:` ref; the
 * adapter itself never logs material or the token.
 */

export interface VaultConfig {
  driver: "memory" | "external";
  endpoint?: string;
  token?: string;
  namespace?: string;
  timeoutMs?: number;
  maxAttempts?: number;
  egressPolicy?: ExternalVaultEgressPolicy;
}

export { ExternalVaultError };

export class VaultConfigError extends AppError {
  constructor(message: string) {
    super("VALIDATION", message);
    this.name = "VaultConfigError";
  }
}

/**
 * Build a Vault from process configuration. Fail-closed for the external
 * driver: missing endpoint/token is a hard error so production never silently
 * falls back to an in-memory store that loses secrets on restart.
 */
export function createVault(config: VaultConfig): Vault {
  if (config.driver === "memory") {
    return createInMemoryVault();
  }

  const endpoint = config.endpoint?.trim() ?? "";
  const token = config.token?.trim() ?? "";
  if (!endpoint || !token) {
    throw new VaultConfigError("VAULT_DRIVER=external requires VAULT_ENDPOINT and VAULT_TOKEN");
  }

  return createExternalVault({
    endpoint,
    token,
    ...(config.namespace === undefined ? {} : { namespace: config.namespace }),
    ...(config.timeoutMs === undefined ? {} : { timeoutMs: config.timeoutMs }),
    ...(config.maxAttempts === undefined ? {} : { maxAttempts: config.maxAttempts }),
    ...(config.egressPolicy === undefined ? {} : { egressPolicy: config.egressPolicy }),
  });
}
