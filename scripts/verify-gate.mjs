#!/usr/bin/env node
/**
 * Project verification gate.
 *
 * The authoritative gate for THIS repository is its own npm scripts. The generic
 * `~/.omp/agent/scripts/verify-gate.py` cannot express that: it hard-codes a
 * per-profile allowlist and deliberately never executes repo-declared commands,
 * and its profile detection checks `tests/` before `tsconfig.json`, so a
 * TypeScript project with a test directory is mis-detected as Python and reported
 * green by a `python -m compileall`. That is a misleading PASS, so this repo owns
 * its gate instead.
 *
 * Default run: the fast gates (typecheck, lint, format, build, secret scan,
 * dependency audit). `--full` adds every test lane. `--json` prints machine
 * output. A failing command is reported with the error signatures it produced.
 *
 * Writes `gate.json` (gitignored, local scratch) so a later `--compare` can tell
 * pre-existing breakage from new breakage.
 */
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const GATE_FILE = join(ROOT, "gate.json");

/** Fast gates: seconds, no Docker, no network beyond the audit endpoint. */
export const GATE_COMMANDS = ["typecheck", "lint", "format:check", "build", "secret-scan", "audit"];

/** Everything, including the container-backed lanes. */
export const FULL_GATE_COMMANDS = [
  ...GATE_COMMANDS,
  "test:unit",
  "test:security",
  "test:integration",
  "test:acceptance",
  "test:performance",
];

const SIGNATURE_RE = /(error|Error|ERROR|FAILED?|Traceback|TS\d+)/;

function signaturesOf(output) {
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && SIGNATURE_RE.test(line))
    .slice(0, 40);
}

function runScript(script) {
  const started = Date.now();
  const result = spawnSync("npm", ["run", "--silent", script], {
    cwd: ROOT,
    encoding: "utf8",
    // No shell pipeline, no interpolation of anything from the environment.
    shell: false,
  });
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  return {
    name: script,
    exit: result.status ?? 1,
    duration_s: Number(((Date.now() - started) / 1000).toFixed(3)),
    signatures: result.status === 0 ? [] : signaturesOf(output),
    output_tail: output.slice(-2000),
  };
}

/** Scripts that exist in package.json, so a typo cannot silently pass. */
function declaredScripts() {
  let raw;
  try {
    raw = readFileSync(join(ROOT, "package.json"), "utf8");
  } catch (error) {
    process.stderr.write(`verify-gate: cannot read package.json (${String(error)})\n`);
    process.exit(2);
  }
  let pkg;
  try {
    pkg = JSON.parse(raw);
  } catch (error) {
    process.stderr.write(`verify-gate: package.json is not valid JSON (${String(error)})\n`);
    process.exit(2);
  }
  return new Set(Object.keys(pkg.scripts ?? {}));
}

function main() {
  const args = new Set(process.argv.slice(2));
  const full = args.has("--full");
  const json = args.has("--json");
  const compare = args.has("--compare");

  const commands = full ? FULL_GATE_COMMANDS : GATE_COMMANDS;
  const declared = declaredScripts();
  const unknown = commands.filter((name) => !declared.has(name));
  if (unknown.length > 0) {
    process.stderr.write(`verify-gate: unknown package.json script(s): ${unknown.join(", ")}\n`);
    process.exit(2);
  }

  const results = commands.map(runScript);
  const previous = compare ? readBaseline() : null;
  const newSignatures = previous === null ? [] : diffSignatures(results, previous);

  const failed = results.filter((r) => r.exit !== 0);
  const verdict =
    failed.length === 0 || (previous !== null && newSignatures.length === 0) ? "PASS" : "FAIL";

  writeFileSync(
    GATE_FILE,
    `${JSON.stringify(
      Object.fromEntries(
        results.map((r) => [
          `npm run ${r.name}`,
          {
            cmd: ["npm", "run", r.name],
            exit: r.exit,
            signatures: r.signatures,
            duration_s: r.duration_s,
          },
        ]),
      ),
      null,
      2,
    )}\n`,
  );

  if (json) {
    process.stdout.write(
      `${JSON.stringify({
        verdict,
        exit: verdict === "PASS" ? 0 : 1,
        new_errors: newSignatures,
        commands: results.map((r) => ({
          cmd: `npm run ${r.name}`,
          exit: r.exit,
          duration_s: r.duration_s,
          signatures: r.signatures,
        })),
      })}\n`,
    );
  } else {
    process.stdout.write(`GATE: ${full ? "full" : "fast"} (${commands.length} commands)\n`);
    for (const r of results) {
      process.stdout.write(`- npm run ${r.name}: exit ${r.exit} (${r.duration_s}s)\n`);
      if (r.exit !== 0 && r.signatures.length > 0) {
        for (const s of r.signatures.slice(0, 10)) process.stdout.write(`    ${s}\n`);
      }
    }
    if (newSignatures.length > 0) {
      process.stdout.write(`NEW ERROR SIGNATURES (${newSignatures.length}):\n`);
      for (const s of newSignatures) process.stdout.write(`  ${s}\n`);
    }
    process.stdout.write(`VERDICT: ${verdict}\n`);
  }

  process.exit(verdict === "PASS" ? 0 : 1);
}

function readBaseline() {
  try {
    return JSON.parse(readFileSync(GATE_FILE, "utf8"));
  } catch {
    return {};
  }
}

function diffSignatures(results, baseline) {
  const out = [];
  for (const r of results) {
    const before = baseline[`npm run ${r.name}`];
    const known = new Set(Array.isArray(before?.signatures) ? before.signatures : []);
    for (const s of r.signatures) if (!known.has(s)) out.push(s);
  }
  return [...new Set(out)].sort();
}

main();
