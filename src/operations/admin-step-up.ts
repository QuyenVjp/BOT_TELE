import { mkdtemp, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import QRCode from "qrcode";
import { sql } from "kysely";
import { createDb } from "../infrastructure/db/client.js";
import { createVault } from "../infrastructure/vault/adapter.js";
import { loadConfig } from "../config/index.js";
import { createStepUpService } from "../modules/identity/step-up.js";
import {
  isSensitiveActionKey,
  isStepUpActionCategory,
  SENSITIVE_ACTION_POLICY,
} from "../modules/identity/sensitive-action.js";

const execFileAsync = promisify(execFile);

async function readInput(prompt: string, echo: boolean): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("operator MFA input requires a TTY");
  }
  process.stdout.write(prompt);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  let value = "";
  const cleanup = () => {
    process.stdin.off("data", onData);
    process.stdin.setRawMode(false);
    process.stdin.pause();
  };
  const onData = (chunk: string) => {
    for (const char of chunk) {
      if (char === "\u0003") {
        cleanup();
        reject(new Error("operator cancelled"));
        return;
      }
      if (char === "\r" || char === "\n") {
        cleanup();
        process.stdout.write("\n");
        resolve(value);
        return;
      }
      if (char === "\u007f") {
        if (value.length > 0) {
          value = value.slice(0, -1);
          if (echo) process.stdout.write("\b \b");
        }
      } else if (char >= " " && char !== "\u007f") {
        value += char;
        if (echo) process.stdout.write(char);
      }
    }
  };
  process.stdin.on("data", onData);
  return promise;
}

async function readHidden(prompt: string): Promise<string> {
  return readInput(prompt, false);
}

async function openLocalQr(otpauthUri: string): Promise<() => Promise<void>> {
  if (process.platform !== "darwin") {
    throw new Error("local MFA QR display requires macOS Preview");
  }
  const directory = await mkdtemp(join(tmpdir(), "bot-tele-mfa-recovery-"));
  const imagePath = join(directory, "new-factor.png");
  try {
    await QRCode.toFile(imagePath, otpauthUri, {
      type: "png",
      errorCorrectionLevel: "M",
      margin: 4,
    });
    await execFileAsync("open", [imagePath], { windowsHide: true });
  } catch (error) {
    await rm(directory, { recursive: true, force: true }).catch(() => {});
    throw new Error(
      `could not open the local MFA QR image: ${error instanceof Error ? error.message : "unknown error"}`,
    );
  }
  return async () => {
    await rm(directory, { recursive: true, force: true });
  };
}

async function latestChallenge(
  db: ReturnType<typeof createDb>["db"],
  adminId: string,
  lockoutMinutes: number,
) {
  const result = await sql<{
    action_key: string | null;
    category: string | null;
    resource_type: string | null;
    resource_id: string | null;
    resource_version: string | null;
    payload_hash: string | null;
  }>`
    select metadata_redacted->>'actionKey' as action_key,
           metadata_redacted->>'category' as category,
           metadata_redacted->>'resourceType' as resource_type,
           metadata_redacted->>'resourceId' as resource_id,
           metadata_redacted->>'resourceVersion' as resource_version,
           metadata_redacted->>'payloadHash' as payload_hash
    from audit_event
    where actor_id = ${adminId}
      and action = 'admin.sensitive.denied'
      and metadata_redacted->>'code' = 'STEP_UP_REQUIRED'
      and occurred_at > now() - (${lockoutMinutes} * interval '1 minute')
    order by occurred_at desc, id desc
    limit 1
  `.execute(db);
  const row = result.rows[0];
  if (
    !row?.action_key ||
    !isSensitiveActionKey(row.action_key) ||
    !row.category ||
    !isStepUpActionCategory(row.category) ||
    SENSITIVE_ACTION_POLICY[row.action_key] !== row.category ||
    !row.resource_type ||
    !row.resource_id ||
    !row.resource_version ||
    !row.payload_hash ||
    !/^[0-9a-f]{64}$/u.test(row.payload_hash)
  ) {
    throw new Error("no valid pending sensitive-action challenge");
  }
  return {
    actionKey: row.action_key,
    category: row.category,
    resourceType: row.resource_type,
    resourceId: row.resource_id,
    resourceVersion: row.resource_version,
    payloadHash: row.payload_hash,
  };
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const command = argv[0];
  if (
    command !== "enroll" &&
    command !== "replace" &&
    command !== "verify" &&
    command !== "recover"
  ) {
    throw new Error("usage: admin-step-up <enroll|replace|verify|recover>");
  }
  if (command === "recover" && (!process.stdin.isTTY || !process.stdout.isTTY)) {
    throw new Error("MFA recovery requires an interactive local TTY");
  }
  const config = loadConfig(process.env);
  if (config.NODE_ENV === "production" && config.ADMIN_STEP_UP_MODE === "disabled") {
    throw new Error("admin step-up mode is disabled in production");
  }
  const adminId = String(config.ADMIN_TELEGRAM_USER_ID);
  const dbHandle = createDb({ connectionString: config.DATABASE_URL });
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
  try {
    const service = createStepUpService(dbHandle.db, vault, {
      ttlSeconds: config.ADMIN_STEP_UP_TTL_SECONDS,
      lockoutMinutes: config.ADMIN_STEP_UP_LOCKOUT_MINUTES,
      maxAttempts: config.ADMIN_STEP_UP_MAX_ATTEMPTS,
    });
    if (command === "enroll") {
      if (await service.isEnrolled(adminId))
        throw new Error("factor already enrolled; use replace");
      const result = await service.enroll({
        adminTelegramUserId: adminId,
        issuer: "TIER20 SHOP",
        accountLabel: adminId,
      });
      process.stdout.write(`${result.otpauthUri}\n`);
      return;
    }
    if (command === "replace") {
      const currentCode = await readHidden("Current TOTP code: ");
      const result = await service.replace({
        adminTelegramUserId: adminId,
        issuer: "TIER20 SHOP",
        accountLabel: adminId,
        currentCode,
      });
      process.stdout.write(`${result.otpauthUri}\n`);
      return;
    }
    if (command === "recover") {
      if (
        config.NODE_ENV !== "production" ||
        config.ADMIN_STEP_UP_MODE !== "required" ||
        config.VAULT_DRIVER !== "external"
      ) {
        throw new Error("MFA recovery requires production with external Vault and required mode");
      }
      const confirmationPhrase = `RECOVER TIER20 SHOP MFA ${adminId.slice(-4)}`;
      process.stdout.write(
        `This rotates the lost root-admin factor only after a new factor verifies.\nType ${confirmationPhrase} to continue: `,
      );
      if ((await readInput("", true)) !== confirmationPhrase) {
        throw new Error("recovery confirmation did not match");
      }
      const initiated = await service.initiateRecovery({
        adminTelegramUserId: adminId,
        issuer: "TIER20 SHOP",
        accountLabel: adminId,
      });
      const cleanupQr = await openLocalQr(initiated.otpauthUri);
      try {
        process.stdout.write("SCAN NEW MFA QR NOW\n");
        await readInput("Press Enter after scanning: ", true);
        for (;;) {
          const code = await readHidden("New TOTP code: ");
          const result = await service.confirmRecovery({
            adminTelegramUserId: adminId,
            code,
          });
          if (result.ok) {
            process.stdout.write(
              `MFA recovery verified; active factor rotated and ${result.revokedGrantCount} grant(s) revoked.\n`,
            );
            break;
          }
          if (result.code === "INVALID_CODE") {
            process.stdout.write("Invalid new TOTP code; retry while the QR remains open.\n");
            continue;
          }
          throw new Error(`MFA recovery failed: ${result.code}`);
        }
      } finally {
        await cleanupQr();
      }
      return;
    }
    const challenge = await latestChallenge(
      dbHandle.db,
      adminId,
      config.ADMIN_STEP_UP_LOCKOUT_MINUTES,
    );
    const code = await readHidden("TOTP code: ");
    const result = await service.verify({ ...challenge, adminTelegramUserId: adminId, code });
    process.stdout.write(result.ok ? "verified\n" : "verification failed\n");
  } finally {
    await dbHandle.close();
  }
}
