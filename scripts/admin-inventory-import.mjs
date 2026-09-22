import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import { createDb } from "../dist/infrastructure/db/client.js";
import { createVault } from "../dist/infrastructure/vault/adapter.js";
import { loadConfig } from "../dist/config/index.js";
import { INVENTORY_FIELDS_SCHEMA } from "../dist/modules/catalog/fulfillment-type.js";
import {
  cancelInventoryImportSession,
  stageInventoryImportInput,
  startInventoryImportSession,
} from "../dist/modules/digital-goods/inventory-import-session.js";

const SAFE_PREVIEW = "SAFE INVENTORY PREVIEW";
const SECRET_INPUT_REQUIRED = "REAL INVENTORY SECRET INPUT REQUIRED IN LOCAL TERMINAL";

function readHidden(prompt) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("operator inventory import requires an interactive local TTY");
  }
  process.stdout.write(prompt);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");

  return new Promise((resolve, reject) => {
    let value = "";
    let settled = false;
    const cleanup = () => {
      if (settled) return;
      settled = true;
      process.stdin.off("data", onData);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write("\n");
    };
    const onData = (chunk) => {
      for (const char of chunk) {
        if (char === "\u0003" || char === "\u0004") {
          cleanup();
          reject(new Error("operator cancelled"));
          return;
        }
        if (char === "\r" || char === "\n") {
          cleanup();
          resolve(value);
          return;
        }
        if (char === "\u007f") {
          if (value.length > 0) value = value.slice(0, -1);
          continue;
        }
        if (char >= " " && char !== "\u007f") value += char;
      }
    };
    process.stdin.on("data", onData);
  });
}

async function main() {
  if (process.argv.length !== 2) throw new Error("local inventory import accepts no arguments");
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("operator inventory import requires an interactive local TTY");
  }

  const config = loadConfig(process.env);
  if (config.NODE_ENV !== "production" || config.VAULT_DRIVER !== "external") {
    throw new Error("local inventory import requires production with external Vault");
  }

  const actor = { numericUserId: config.ADMIN_TELEGRAM_USER_ID, chatType: "private" };
  const rootConfig = {
    adminTelegramUserId: config.ADMIN_TELEGRAM_USER_ID,
    expectedUsername: config.ADMIN_EXPECTED_USERNAME,
  };
  const correlationId = `local-inventory-import:${randomUUID()}`;
  const dbHandle = createDb({ connectionString: config.DATABASE_URL, maxConnections: 1 });
  const vault = createVault({
    driver: config.VAULT_DRIVER,
    endpoint: config.VAULT_ENDPOINT,
    token: config.VAULT_TOKEN,
    namespace: config.VAULT_NAMESPACE,
    timeoutMs: config.VAULT_TIMEOUT_MS,
    maxAttempts: config.VAULT_MAX_ATTEMPTS,
    egressPolicy: {
      allowedHosts: config.VAULT_EGRESS_HOST_ALLOWLIST,
      allowedPorts: config.VAULT_EGRESS_PORT_ALLOWLIST,
      allowedCidrs: config.VAULT_EGRESS_CIDR_ALLOWLIST,
    },
  });

  let enteredValues = [];
  let rawInput = "";
  try {
    await vault.health?.();
    const sessionRow = (
      await sql`
        select status, input_vault_ref, selected_variant_id, expires_at
        from admin_inventory_import
        where admin_telegram_user_id = ${String(actor.numericUserId)}
        limit 1
      `.execute(dbHandle.db)
    ).rows[0];
    if (!sessionRow || sessionRow.status !== "WAITING_INPUT") {
      throw new Error("the existing WAITING_INPUT import session is not available");
    }
    if (sessionRow.input_vault_ref !== null || typeof sessionRow.selected_variant_id !== "string") {
      throw new Error("the existing import session is not an empty WAITING_INPUT session");
    }

    const variantRow = (
      await sql`
        select id, name_vi, sku, fulfillment_type, inventory_fields
        from product_variant
        where id = ${sessionRow.selected_variant_id}
          and fulfillment_type in ('STOCK_ACCOUNT', 'STOCK_CODE')
        limit 1
      `.execute(dbHandle.db)
    ).rows[0];
    if (!variantRow) throw new Error("the existing import session variant is unavailable");
    const parsedFields = INVENTORY_FIELDS_SCHEMA.safeParse(variantRow.inventory_fields);
    if (!parsedFields.success) throw new Error("the existing variant inventory schema is invalid");
    const requiredFields = parsedFields.data.filter((field) => field.required);
    if (requiredFields.length === 0)
      throw new Error("the existing variant has no required inventory fields");

    if (new Date(sessionRow.expires_at).getTime() <= Date.now()) {
      const resumed = await startInventoryImportSession(dbHandle.db, {
        actor,
        config: rootConfig,
        correlationId,
        variantId: variantRow.id,
      });
      if (!resumed.ok) throw new Error("could not resume the existing import session");
      process.stdout.write("Existing WAITING_INPUT import session resumed safely.\n");
    } else {
      process.stdout.write("Existing WAITING_INPUT import session verified.\n");
    }

    process.stdout.write(`Product: ${variantRow.name_vi}\nVariant SKU: ${variantRow.sku}\n`);
    process.stdout.write(
      `Required fields: ${requiredFields.map((field) => field.name).join(", ")}\n`,
    );
    process.stdout.write(`${SECRET_INPUT_REQUIRED}\n`);
    for (const field of requiredFields) {
      const value = await readHidden(`${field.name}: `);
      if (!value.trim()) throw new Error("a required inventory field was empty");
      enteredValues.push(value);
    }

    rawInput = requiredFields
      .map((field, index) => `${field.name}: ${enteredValues[index] ?? ""}`)
      .join("\n");
    const staged = await stageInventoryImportInput(dbHandle.db, vault, {
      actor,
      config: rootConfig,
      correlationId,
      rawInput,
    });
    rawInput = "";
    enteredValues.fill("");
    enteredValues = [];
    if (!staged.ok) {
      throw new Error("the local inventory input could not be staged");
    }

    const preview = staged.preview;
    process.stdout.write(
      `${SAFE_PREVIEW}: ready=${preview.ready} invalid=${preview.invalid} duplicates=${preview.duplicates}\n`,
    );
    const exactlyOneNewAsset =
      preview.ready === 1 &&
      preview.invalid === 0 &&
      preview.duplicates === 0 &&
      preview.lines.length === 1 &&
      preview.lines[0]?.classification === "READY";
    if (!exactlyOneNewAsset) {
      await cancelInventoryImportSession(dbHandle.db, vault, {
        actor,
        config: rootConfig,
        correlationId: `${correlationId}:reject-preview`,
        variantId: variantRow.id,
      }).catch(() => undefined);
      process.stdout.write("REAL_NEW_INVENTORY_REQUIRED\n");
      process.exitCode = 2;
      return;
    }

    process.stdout.write("INVENTORY_IMPORT_READY_FOR_PROTECTED_CONFIRMATION\n");
  } finally {
    rawInput = "";
    enteredValues.fill("");
    await dbHandle.close().catch(() => undefined);
  }
}

try {
  await main();
} catch {
  process.stderr.write("NO_GO — secure local inventory import did not complete\n");
  process.exitCode = 1;
}
