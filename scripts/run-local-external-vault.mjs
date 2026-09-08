import { spawn } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const role = process.argv[2];
if (role !== "api" && role !== "worker") {
  throw new Error("Usage: node scripts/run-local-external-vault.mjs <api|worker>");
}

const configDir = join(homedir(), ".config", "bot-tele-external-vault");
const tokenFile = process.env.BT_VAULT_TOKEN_FILE?.trim() || join(configDir, "token");
const caFile = process.env.BT_VAULT_CA_FILE?.trim() || join(configDir, "ca.crt");

const tokenInfo = await stat(tokenFile);
if (!tokenInfo.isFile() || (tokenInfo.mode & 0o077) !== 0) {
  throw new Error("Local Vault token must be a private file");
}
const token = (await readFile(tokenFile, "utf8")).trim();
if (token.length < 32) throw new Error("Invalid local Vault token");
const caInfo = await stat(caFile);
if (!caInfo.isFile()) throw new Error("Invalid local Vault CA file");

const entry = fileURLToPath(
  new URL(role === "api" ? "../dist/main.js" : "../dist/worker.js", import.meta.url),
);
const env = {
  ...process.env,
  NODE_EXTRA_CA_CERTS: caFile,
  VAULT_DRIVER: "external",
  VAULT_ENDPOINT: process.env.BT_VAULT_ENDPOINT?.trim() || "https://127.0.0.1:8443",
  VAULT_TOKEN: token,
  VAULT_NAMESPACE: process.env.BT_VAULT_NAMESPACE?.trim() || "telegram-shop",
  VAULT_TIMEOUT_MS: process.env.BT_VAULT_TIMEOUT_MS?.trim() || "3000",
  VAULT_MAX_ATTEMPTS: process.env.BT_VAULT_MAX_ATTEMPTS?.trim() || "2",
  VAULT_EGRESS_HOST_ALLOWLIST: process.env.BT_VAULT_EGRESS_HOST_ALLOWLIST?.trim() || "127.0.0.1",
  VAULT_EGRESS_PORT_ALLOWLIST: process.env.BT_VAULT_EGRESS_PORT_ALLOWLIST?.trim() || "8443",
  VAULT_EGRESS_CIDR_ALLOWLIST: process.env.BT_VAULT_EGRESS_CIDR_ALLOWLIST?.trim() || "127.0.0.1/32",
};

const child = spawn(process.execPath, [entry], { env, stdio: "inherit" });
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    if (child.exitCode === null && child.signalCode === null) child.kill(signal);
  });
}

const exit = await new Promise((resolve, reject) => {
  child.once("error", () => reject(new Error(`Failed to launch local external Vault ${role}`)));
  child.once("exit", (code, signal) => resolve({ code, signal }));
});
process.exitCode = exit.code ?? (exit.signal ? 1 : 0);
