#!/usr/bin/env node
/**
 * Lightweight secret scan for CI (T008).
 * Scans tracked source for high-confidence secret patterns.
 * Fails closed on match. Does not replace a full commercial scanner.
 */
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";

const ROOT = process.cwd();
const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "coverage",
  "work",
  "outputs",
  ".git",
  ".agents",
  ".specify",
]);

const PATTERNS = [
  { name: "private-key", re: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { name: "aws-access-key", re: /AKIA[0-9A-Z]{16}/ },
  { name: "github-pat", re: /ghp_[A-Za-z0-9]{36}/ },
  { name: "telegram-bot-token", re: /\b\d{8,10}:[A-Za-z0-9_-]{35}\b/ },
  {
    name: "generic-secret-assignment",
    re: /(?:api[_-]?key|secret|token|password)\s*[:=]\s*['"][^'"]{16,}['"]/i,
  },
];

// Explicit allowlist for known placeholders used by fixtures / .env.example
// and intentionally-fake secrets embedded in security/acceptance tests that
// prove redaction (SR-001 / SC-007). These strings must never appear outside
// tests/, fixtures/, or .env.example.
const ALLOWLIST = [
  /000000000:TEST_PLACEHOLDER_TOKEN_DO_NOT_USE/,
  /local-dev-/,
  /test-sepay-hmac-secret-do-not-use-in-prod/,
  /webhook-secret-abcdefgh/,
  /sepay-hmac-secret-abcdefgh/,
  /123456:AA-(?:SECRET|REAL)-BOT-TOKEN(?:-value)?/,
  /FAKE-KEY-/,
  /shop_local_only/,
  // Fixture secrets used only to assert that redaction/leak scans work.
  /NETFLIX-USER:pass-/,
  /super-secret-hmac-key/,
  /SuperSecretPass(?:-42|123)/,
  /totally-bogus-token-value-/,
  /user@example\.com:SuperSecretPass/,
];

async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(full);
    } else if (entry.isFile()) {
      yield full;
    }
  }
}

const findings = [];

for await (const file of walk(ROOT)) {
  const rel = relative(ROOT, file).replaceAll("\\", "/");
  // Local runtime secrets are intentionally outside version control. Scan the
  // committed template, but never read or echo developer `.env` files.
  if (rel === ".env" || rel === ".env.local" || /^\.env\..+\.local$/i.test(rel)) continue;
  // Skip binary-ish and lockfiles.
  if (/\.(png|jpg|jpeg|gif|webp|ico|lock|pack|idx|woff2?)$/i.test(rel)) continue;
  if (rel === "package-lock.json") continue;

  let text;
  try {
    const s = await stat(file);
    if (s.size > 1_000_000) continue;
    text = await readFile(file, "utf8");
  } catch {
    continue;
  }

  for (const { name, re } of PATTERNS) {
    re.lastIndex = 0;
    const match = text.match(re);
    if (!match) continue;
    if (ALLOWLIST.some((a) => a.test(match[0]))) continue;
    const line = text.slice(0, match.index ?? 0).split(/\r?\n/).length;
    findings.push({ file: rel, rule: name, line });
  }
}

if (findings.length > 0) {
  console.error("secret-scan FAILED:");
  for (const f of findings) {
    console.error(`  [${f.rule}] ${f.file}:${f.line}`);
  }
  process.exit(1);
}

console.log("secret-scan OK (no high-confidence secrets found)");
