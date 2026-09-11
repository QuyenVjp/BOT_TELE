import { sql } from "kysely";
import type { Db } from "../../src/infrastructure/db/transaction.js";
import type { Vault } from "../../src/infrastructure/vault/port.js";
import { generateTotp } from "../../src/modules/identity/step-up.js";

/**
 * Mint a currently-valid TOTP code for an enrolled admin.
 *
 * A step-up integration test has to present a code only the authenticator app would
 * know, which means reading the seed back out of the vault and running the real
 * RFC 6238 generator — the same code `verify` will check. The seed is read through
 * the vault port (exactly what the delivery boundary does) and never logged.
 *
 * Only test code may call this: production never reveals an enrolled seed.
 */
export async function createTotpCode(
  vault: Vault,
  adminTelegramUserId: string,
  db: Db,
): Promise<string> {
  const ref = await sql<{ vault_ref: string }>`
    select vault_ref from admin_step_up_secret
    where admin_telegram_user_id = ${adminTelegramUserId}
    limit 1
  `.execute(db);
  const vaultRef = ref.rows[0]?.vault_ref;
  if (!vaultRef) throw new Error(`no TOTP secret enrolled for ${adminTelegramUserId}`);
  const seed = await vault.reveal(vaultRef);
  const code = generateTotp(seed, Math.floor(Date.now() / 1000));
  if (code.length !== 6) throw new Error("generated TOTP code was malformed");
  return code;
}

/** A deliberately wrong code of the right shape, for negative cases. */
export function wrongTotpCode(): string {
  return "000000";
}
