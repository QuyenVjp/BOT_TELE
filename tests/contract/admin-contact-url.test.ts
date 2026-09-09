import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
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
]);

function rg(pattern: string, paths: string[], extraArgs: string[] = []): string {
  try {
    return execFileSync(
      "rg",
      ["-n", "--glob", "!node_modules/**", "--glob", "!dist/**", ...extraArgs, pattern, ...paths],
      {
        cwd: ROOT,
        encoding: "utf8",
      },
    );
  } catch (error) {
    const err = error as { status?: number; stdout?: string };
    if (err.status === 1) return "";
    throw error;
  }
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
    const hits = rg(FORBIDDEN_ADMIN_HANDLE, ["src", "tests", "scripts"]);
    expect(hits).toBe("");
  });

  it("keeps the URL single-sourced outside the allowlist", () => {
    const hits = rg(CANONICAL_ADMIN_CONTACT_URL, ["src", "tests", "scripts"])
      .trim()
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
