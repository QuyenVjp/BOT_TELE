import { sql } from "kysely";
import type { Db } from "../../infrastructure/db/transaction.js";
import type { Vault, VaultRef } from "../../infrastructure/vault/port.js";
import { newId } from "../../shared/ids/index.js";

/**
 * Delete an opaque asset ref when possible. If the provider refuses the delete,
 * retain only the ref and redacted reason for bounded operational retry.
 */
export async function deleteAssetVaultRef(
  db: Db,
  vault: Vault,
  ref: VaultRef,
  input: { correlationId: string; reason: string },
): Promise<void> {
  try {
    await vault.delete(ref);
    return;
  } catch {
    await sql`
      insert into inventory_vault_orphan
        (id, vault_ref, namespace, correlation_id, reason)
      values
        (${newId()}, ${ref}, 'asset', ${input.correlationId}, ${input.reason.slice(0, 200)})
      on conflict (vault_ref) do update set
        correlation_id = excluded.correlation_id,
        reason = excluded.reason,
        resolved_at = null
    `.execute(db);
  }
}

export async function recordAssetVaultOrphan(
  db: Db,
  ref: VaultRef,
  input: { correlationId: string; reason: string },
): Promise<void> {
  await sql`
    insert into inventory_vault_orphan
      (id, vault_ref, namespace, correlation_id, reason)
    values
      (${newId()}, ${ref}, 'asset', ${input.correlationId}, ${input.reason.slice(0, 200)})
    on conflict (vault_ref) do update set
      correlation_id = excluded.correlation_id,
      reason = excluded.reason,
      resolved_at = null
  `.execute(db);
}
