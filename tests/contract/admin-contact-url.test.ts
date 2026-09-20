import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ADMIN_CONTACT_URL,
  ADMIN_DISPLAY,
  COMMUNITY_URL,
  DEFAULT_SHOP_PROFILE,
  SHOP_NAME,
} from "../../src/modules/catalog/shop-profile.js";

const ROOT = join(import.meta.dirname, "../..");
const CANONICAL_ADMIN_CONTACT_URL = "https://t.me/Quyenvjp";
const FORBIDDEN_ADMIN_HANDLE = ["Quyen", "vvp"].join("");
const FORBIDDEN_ADMIN_CONTACT_TYPO = `https://t.me/${FORBIDDEN_ADMIN_HANDLE}`;

const URL_LITERAL_ALLOWLIST = new Set([
  "src/modules/catalog/shop-profile.ts",
  "tests/contract/admin-contact-url.test.ts",
  "src/infrastructure/db/migrations/049_catalog_taxonomy.sql",
  "tests/contract/shop-profile.test.ts",
]);

const SCAN_ROOTS = ["src", "tests", "scripts"] as const;
const SKIPPED_DIRECTORIES = new Set(["node_modules", "dist", "coverage", ".git"]);
/** Above this a file is not hand-written source worth scanning; skips the odd binary too. */
const MAX_SCANNED_BYTES = 2_000_000;

/**
 * Minimal in-repo text search, in Node.
 *
 * This used to shell out to `rg`, which made the suite depend on a binary that is not
 * guaranteed on a CI runner: the GitHub job failed with `spawnSync rg ENOENT` and took
 * every other assertion in the run down with it. The scan is small and bounded, so it
 * walks the tree directly — the same approach `scripts/secret-scan.mjs` already uses.
 *
 * Output mirrors `rg -n`: one `<path>:<line>:<text>` record per match, empty when none.
 * Paths are repository-relative so the allowlist above stays portable.
 */
function searchText(pattern: string, roots: readonly string[] = SCAN_ROOTS): string {
  const matcher = new RegExp(pattern);
  const records: string[] = [];

  const visit = (absolutePath: string): void => {
    const stats = statSync(absolutePath);
    if (stats.isDirectory()) {
      if (SKIPPED_DIRECTORIES.has(basename(absolutePath))) return;
      for (const entry of readdirSync(absolutePath)) visit(join(absolutePath, entry));
      return;
    }
    if (!stats.isFile() || stats.size > MAX_SCANNED_BYTES) return;
    const text = readFileSync(absolutePath, "utf8");
    if (text.includes("\u0000")) return;
    const relativePath = relative(ROOT, absolutePath);
    text.split("\n").forEach((line, index) => {
      if (matcher.test(line)) records.push(`${relativePath}:${index + 1}:${line}`);
    });
  };

  for (const root of roots) {
    const absolutePath = join(ROOT, root);
    if (existsSync(absolutePath)) visit(absolutePath);
  }
  return records.join("\n");
}

describe("canonical admin contact URL", () => {
  it("exports the exact public Telegram URL and handle", () => {
    expect(ADMIN_CONTACT_URL).toBe(CANONICAL_ADMIN_CONTACT_URL);
    expect(ADMIN_DISPLAY).toBe("@Quyenvjp");
    expect(SHOP_NAME).toBe("TIER20 SHOP");
    expect(COMMUNITY_URL).toBe("https://t.me/aicodexvn");
    expect(DEFAULT_SHOP_PROFILE.adminContactUrl).toBe(CANONICAL_ADMIN_CONTACT_URL);
    expect(ADMIN_CONTACT_URL).not.toBe(FORBIDDEN_ADMIN_CONTACT_TYPO);
  });

  it("rejects the forbidden admin-handle typo anywhere in runtime or tests", () => {
    expect(searchText(FORBIDDEN_ADMIN_HANDLE)).toBe("");
  });

  it("keeps the URL single-sourced outside the allowlist", () => {
    const hits = searchText(CANONICAL_ADMIN_CONTACT_URL)
      .split("\n")
      .filter(Boolean)
      .map((line) => line.split(":")[0] ?? line);
    const leaked = [...new Set(hits)].filter((file) => !URL_LITERAL_ALLOWLIST.has(file));
    expect(leaked).toEqual([]);
  });

  it("matches migration 049 default when that file exists", () => {
    const migration = join(ROOT, "src/infrastructure/db/migrations/049_catalog_taxonomy.sql");
    if (!existsSync(migration)) return;
    const sql = readFileSync(migration, "utf8");
    expect(sql).toContain(CANONICAL_ADMIN_CONTACT_URL);
    expect(sql).not.toContain(FORBIDDEN_ADMIN_CONTACT_TYPO);
    expect(sql).toContain("@Quyenvjp");
  });
});
