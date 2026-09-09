import { describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import { dockerAvailable, startPostgres } from "../helpers/pg-container.js";

const repoRoot = resolve(import.meta.dirname, "..", "..");
const tsxCli = resolve(repoRoot, "node_modules/tsx/dist/cli.mjs");
const source = resolve(repoRoot, "src/infrastructure/db/migrate.ts");
const artifact = resolve(repoRoot, "dist/infrastructure/db/migrate.js");
const wrapper = resolve(repoRoot, "scripts/run-production-migrate.mjs");
const hasDocker = await dockerAvailable();

describe("production migration environment safety", () => {
  it("requires explicit confirmation and does not apply without it", async () => {
    const result = await runSource({
      DATABASE_URL: "postgresql://user@localhost:5432/shop",
      NODE_ENV: "production",
      BOT_TELE_EXPECTED_DB: "localhost:5432/shop",
    });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("confirm-production");
  });

  it("does not load a decoy cwd .env in production mode", async () => {
    const cwd = await mkdtemp(resolve(tmpdir(), "migrate-env-"));
    try {
      await writeFile(
        resolve(cwd, ".env"),
        "DATABASE_URL=postgresql://decoy@localhost:5432/decoy\n",
      );
      const result = await runSource({}, cwd);
      expect(result.code).not.toBe(0);
      expect(`${result.stdout}\n${result.stderr}`).not.toContain("decoy");
      expect(result.stderr).toContain("DATABASE_URL is required");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("refuses an expected database fingerprint mismatch", async () => {
    const result = await runSource(
      {
        DATABASE_URL: "postgresql://user@localhost:5432/shop",
        NODE_ENV: "production",
        BOT_TELE_EXPECTED_DB: "localhost:5433/shop",
      },
      undefined,
      ["--confirm-production"],
    );
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("database target mismatch");
    expect(result.stderr).not.toContain("user@");
  });

  it("applies with matching fingerprint and prints a secret-free receipt", async () => {
    if (!hasDocker) return;
    const started = await startPostgres();
    try {
      const url = new URL(started.connectionString);
      const result = await runSource(
        {
          DATABASE_URL: started.connectionString,
          NODE_ENV: "production",
          BOT_TELE_EXPECTED_DB: `${url.hostname}:${url.port || "5432"}/${url.pathname.slice(1)}`,
        },
        undefined,
        ["--confirm-production"],
      );
      expect(result.code, result.stderr).toBe(0);
      expect(result.stdout).toContain("migrate: target host=");
      expect(result.stdout).toContain("migrate: head_before=");
      expect(result.stdout).toContain("migrate: head_after=");
      expect(result.stdout).toContain("migrate: applied=");
      expect(result.stdout).not.toContain(url.password);
    } finally {
      await started.stop();
    }
  }, 180_000);

  it("production wrapper ignores parent DATABASE_URL in favor of --env-file", async () => {
    if (!existsSync(artifact)) return;
    const compiled = await readFile(artifact, "utf8");
    if (!compiled.includes("BOT_TELE_EXPECTED_DB")) return;
    const dir = await mkdtemp(resolve(tmpdir(), "migrate-wrap-"));
    const envFile = resolve(dir, "production.env");
    try {
      await writeFile(
        envFile,
        [
          "NODE_ENV=production",
          "DATABASE_URL=postgresql://fileuser:file-pass@127.0.0.1:1/filedb",
          "BOT_TELE_EXPECTED_DB=127.0.0.1:1/filedb",
          "",
        ].join("\n"),
      );
      const result = await runWrapper(envFile, {
        DATABASE_URL: "postgresql://decoy:decoy-pass@localhost:5433/decoy",
        NODE_ENV: "development",
        BOT_TELE_EXPECTED_DB: "localhost:5433/decoy",
      });
      const blob = `${result.stdout}\n${result.stderr}`;
      expect(blob).not.toContain("decoy");
      expect(blob).not.toContain("decoy-pass");
      expect(blob).not.toContain("file-pass");
      expect(blob).toMatch(/127\.0\.0\.1|filedb/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

async function runSource(
  extraEnv: Record<string, string>,
  cwd = repoRoot,
  args: string[] = [],
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return runProcess(process.execPath, [tsxCli, source, "--production", ...args], extraEnv, cwd);
}

async function runWrapper(
  envFile: string,
  extraEnv: Record<string, string>,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return runProcess(
    process.execPath,
    [wrapper],
    { ...extraEnv, BOT_TELE_PRODUCTION_ENV_FILE: envFile },
    repoRoot,
  );
}

async function runProcess(
  command: string,
  args: string[],
  extraEnv: Record<string, string>,
  cwd: string,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const env = { ...process.env };
  for (const key of [
    "DATABASE_URL",
    "BOT_TELE_CONFIRM_PRODUCTION",
    "BOT_TELE_EXPECTED_DB",
    "BOT_TELE_PRODUCTION_MIGRATE",
    "BOT_TELE_PRODUCTION_ENV_FILE",
  ])
    delete env[key];
  Object.assign(env, extraEnv);
  return new Promise((resolveResult) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (data) => {
      stdout += String(data);
    });
    child.stderr.on("data", (data) => {
      stderr += String(data);
    });
    child.once("exit", (code) => resolveResult({ code, stdout, stderr }));
  });
}
