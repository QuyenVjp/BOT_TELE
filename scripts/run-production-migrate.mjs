import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import { operationalChildEnv } from "../dist/config/operational-child-env.js";

const repoRoot = resolve(new URL("..", import.meta.url).pathname);
const envFile =
  process.env.BOT_TELE_PRODUCTION_ENV_FILE ??
  resolve(homedir(), ".config/bot-tele-production/production.env");
const migrateScript = resolve(repoRoot, "dist/infrastructure/db/migrate.js");

await access(envFile, constants.R_OK).catch(() => {
  throw new Error(`production env file not found: ${envFile}`);
});
await access(migrateScript, constants.R_OK).catch(() => {
  throw new Error(`compiled migration not found: ${migrateScript}`);
});

const child = spawn(
  process.execPath,
  [
    `--env-file=${envFile}`,
    migrateScript,
    "--production",
    "--confirm-production",
    ...process.argv.slice(2),
  ],
  { cwd: repoRoot, stdio: "inherit", env: operationalChildEnv() },
);
child.on("error", (error) => {
  throw error;
});
const exitCode = await new Promise((resolveCode) => {
  child.once("exit", (code, signal) => resolveCode(code ?? (signal ? 1 : 0)));
});
process.exitCode = exitCode;
