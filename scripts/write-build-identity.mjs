/**
 * Write dist/build-identity.json after tsc so GET /health can prove which
 * git commit the running dist belongs to. Never embeds secrets.
 */
import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const distDir = join(root, "dist");

if (!existsSync(distDir)) {
  process.stderr.write("write-build-identity: dist/ is missing; run tsc first\n");
  process.exit(1);
}

function git(args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

let commit;
try {
  commit = git(["rev-parse", "HEAD"]);
} catch {
  process.stderr.write("write-build-identity: git HEAD is unavailable\n");
  process.exit(1);
}

if (!/^[0-9a-f]{40}$/.test(commit)) {
  process.stderr.write("write-build-identity: unexpected git HEAD\n");
  process.exit(1);
}

const dirty = git(["status", "--porcelain"]).length > 0;
const payload = {
  commit,
  builtAt: new Date().toISOString(),
  dirty,
};
writeFileSync(join(distDir, "build-identity.json"), `${JSON.stringify(payload)}\n`);
process.stdout.write(`write-build-identity: ${commit} dirty=${dirty}\n`);
