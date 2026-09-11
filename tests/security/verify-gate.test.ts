import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The project gate must reflect THIS repository's real commands.
 *
 * The generic `~/.omp/agent/scripts/verify-gate.py` detached profile commands are
 * per-language and it never runs repo-declared scripts; worse, its profile
 * detection checks `tests/` before `tsconfig.json`, so a TypeScript repo with a
 * test directory is classified `python` and reports green from
 * `python -m compileall`. A gate that passes without compiling, linting or
 * testing anything is worse than no gate, so this repo owns `verify:gate`.
 *
 * These assertions are read as text on purpose: the script is ESM JavaScript and
 * importing it would execute the gate.
 */
const ROOT = resolve(import.meta.dirname, "../..");

function readText(relativePath: string): string {
  return readFileSync(resolve(ROOT, relativePath), "utf8");
}

describe("project verification gate", () => {
  const script = readText("scripts/verify-gate.mjs");

  it("is registered as a package script so it is discoverable", () => {
    const pkg = JSON.parse(readText("package.json")) as { scripts?: Record<string, string> };
    expect(pkg.scripts?.["verify:gate"]).toBe("node scripts/verify-gate.mjs");
  });

  it.each(["typecheck", "lint", "format:check", "build", "secret-scan", "audit"])(
    "gates on the real %s command",
    (command) => {
      expect(script).toContain(`"${command}"`);
    },
  );

  it.each([
    "test:unit",
    "test:security",
    "test:integration",
    "test:acceptance",
    "test:performance",
  ])("covers %s in the full gate", (command) => {
    expect(script).toContain(`"${command}"`);
  });

  it("declares no gate command that package.json does not define", () => {
    const pkg = JSON.parse(readText("package.json")) as { scripts?: Record<string, string> };
    const declared = new Set(Object.keys(pkg.scripts ?? {}));
    const listed = [...script.matchAll(/^\s{2}"([a-z][a-z0-9:-]*)",$/gm)].map((m) => m[1]!);
    expect(listed.length).toBeGreaterThan(0);
    for (const name of listed) {
      expect(declared.has(name), `gate lists "${name}" but package.json has no such script`).toBe(
        true,
      );
    }
  });

  it("runs npm scripts, never a Python compileall profile", () => {
    expect(script).toContain("gate.json");
    expect(script).toContain("npm run ");
    // Strip the doc comment first: the false-green signal being replaced is described there.
    const code = script.replace(/\/\*\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(code).not.toContain("compileall");
    expect(code).not.toMatch(/\bpython/i);
    expect(code).not.toMatch(/-m\s+pytest/);
  });

  it("never shells out through a pipeline or an interpolated string", () => {
    expect(script).not.toMatch(/\|\s*(?:sh|bash)\b/);
    expect(script).not.toContain("shell: true");
    expect(script).toContain("shell: false");
    expect(script).not.toContain("exec(");
    expect(script).not.toContain("execSync");
  });
});
