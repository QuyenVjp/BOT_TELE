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
const script = resolve(repoRoot, "dist/scripts/production-preflight.js");

for (const file of [envFile, script]) {
  try {
    await access(file, constants.R_OK);
  } catch {
    process.stderr.write(`production preflight: missing required file ${file}\n`);
    process.exit(1);
  }
}

const child = spawn(process.execPath, [`--env-file=${envFile}`, script], {
  cwd: repoRoot,
  stdio: "inherit",
  env: operationalChildEnv(),
});
child.on("error", (error) => {
  process.stderr.write(`production preflight failed: ${error.message}\n`);
  process.exitCode = 1;
});
child.on("exit", (code, signal) => {
  process.exitCode = code ?? (signal ? 1 : 0);
});
