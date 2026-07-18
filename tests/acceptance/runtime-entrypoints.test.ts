import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * T115 — Built entrypoint smoke (no Docker required).
 *
 * The prior defect: `package.json` start scripts pointed at `dist/main.js`
 * while the build emitted `dist/src/main.js`, so `npm start` failed with
 * MODULE_NOT_FOUND before any config error. These tests assert the START PATHS
 * RESOLVE by launching the exact built artifact `package.json` runs.
 *
 * We do not require a database: we launch with an intentionally invalid config
 * so the process exits non-zero with a *config* error. The pass condition is
 * that Node can LOAD the module (no MODULE_NOT_FOUND / Cannot find module), and
 * that the error text is our controlled startup message, never a raw secret.
 *
 * Requires `npm run build` to have produced `dist/` first (CI ordering).
 */

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");

/**
 * Resolve the exact path that `package.json` scripts `start` / `start:worker`
 * launch. The historical bug pointed them at `dist/main.js` while the build
 * emitted `dist/src/main.js`. The test must read the package, not invent the
 * path, so a wrong start script fails this suite.
 */
function startTarget(pkgScript: "start" | "start:worker"): string {
  const pkg = JSON.parse(readFileSync(resolve(repoRoot, "package.json"), "utf8")) as {
    scripts: Record<string, string>;
  };
  const script = pkg.scripts[pkgScript];
  if (!script) throw new Error(`package.json is missing scripts.${pkgScript}`);
  // Expected form: `node <path>` (optionally with flags). Take the last token
  // that looks like a .js entry so flags do not confuse the parse.
  const tokens = script.trim().split(/\s+/);
  const js = [...tokens].reverse().find((t) => t.endsWith(".js"));
  if (!js) throw new Error(`scripts.${pkgScript} does not launch a .js entry: ${script}`);
  return resolve(repoRoot, js);
}

function runBuiltEntry(entryPath: string): { code: number | null; stderr: string; stdout: string } {
  const res = spawnSync(process.execPath, [entryPath], {
    cwd: repoRoot,
    env: {
      ...process.env,
      // Force a fail-closed config error quickly rather than a hung listen.
      NODE_ENV: "production",
      DATABASE_URL: "", // invalid → ConfigError, not MODULE_NOT_FOUND
      TELEGRAM_BOT_TOKEN: "",
      TELEGRAM_WEBHOOK_SECRET: "",
      SEPAY_WEBHOOK_HMAC_SECRET: "",
      SEPAY_MERCHANT_ACCOUNT_ID: "",
      VIETQR_BANK_BIN: "",
      VIETQR_ACCOUNT_NUMBER: "",
      VIETQR_ACCOUNT_NAME: "",
    },
    encoding: "utf8",
    timeout: 20_000,
  });
  return { code: res.status, stderr: res.stderr ?? "", stdout: res.stdout ?? "" };
}

describe("built entrypoints resolve and fail closed (no MODULE_NOT_FOUND)", () => {
  it("the built main.js path that `npm start` runs exists", () => {
    const target = startTarget("start");
    expect(existsSync(target), `expected built artifact at ${target}. Run: npm run build`).toBe(
      true,
    );
  });

  it("the built worker.js path that `npm run start:worker` runs exists", () => {
    const target = startTarget("start:worker");
    expect(existsSync(target), `expected built artifact at ${target}. Run: npm run build`).toBe(
      true,
    );
  });

  it("launching built main.js loads the module (no module-resolution failure)", () => {
    const target = startTarget("start");
    if (!existsSync(target)) {
      throw new Error(`build missing at ${target}; run npm run build before this suite`);
    }
    const out = runBuiltEntry(target);
    const combined = `${out.stdout}\n${out.stderr}`;
    expect(combined).not.toMatch(/Cannot find module|MODULE_NOT_FOUND|ERR_MODULE_NOT_FOUND/);
    // It should exit non-zero due to the invalid production config.
    expect(out.code).not.toBe(0);
    // And it must surface a controlled startup message, never a raw secret value.
    expect(combined).toMatch(/failed to start|Invalid configuration/i);
  });

  it("launching built worker.js loads the module (no module-resolution failure)", () => {
    const target = startTarget("start:worker");
    if (!existsSync(target)) {
      throw new Error(`build missing at ${target}; run npm run build before this suite`);
    }
    const out = runBuiltEntry(target);
    const combined = `${out.stdout}\n${out.stderr}`;
    expect(combined).not.toMatch(/Cannot find module|MODULE_NOT_FOUND|ERR_MODULE_NOT_FOUND/);
    expect(out.code).not.toBe(0);
    expect(combined).toMatch(/failed to start|Invalid configuration/i);
  });
});
