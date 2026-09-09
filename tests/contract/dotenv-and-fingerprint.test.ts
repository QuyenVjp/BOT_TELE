import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  formatDatabaseFingerprint,
  parseDatabaseUrl,
  parseDotenvFile,
  parseRedisUrl,
  secretStatus,
} from "../../src/config/safe-fingerprint.js";
import { operationalChildEnv } from "../../src/config/operational-child-env.js";

const exec = promisify(execFile);

describe("safe fingerprint and Node dotenv contracts", () => {
  it("parses quoted spaces, escaped quotes, comments, and empty values", () => {
    const slash = String.fromCharCode(92);
    const text = `NAME="hello world"\nQUOTE="say ${slash}"hi${slash}"" # comment\nEMPTY=\nRAW=value # comment`;
    const parsed = parseDotenvFile(text);
    expect(parsed).toEqual({ NAME: "hello world", QUOTE: 'say "hi"', EMPTY: "", RAW: "value" });
  });

  it("keeps database fingerprints password-free", () => {
    const fingerprint = parseDatabaseUrl(
      "postgres://" + "shop" + ":" + "x" + "@localhost:5432/shop",
    );
    expect(fingerprint).toEqual({
      host: "localhost",
      port: "5432",
      database: "shop",
      user: "shop",
    });
    expect(formatDatabaseFingerprint(fingerprint)).toBe("localhost:5432/shop");
    expect(JSON.stringify(fingerprint)).not.toContain("x");
  });

  it("parses redis hosts without credentials", () => {
    expect(parseRedisUrl("redis://:secret@127.0.0.1:6379/0")).toEqual({
      host: "127.0.0.1",
      port: "6379",
    });
    expect(JSON.stringify(parseRedisUrl("redis://:secret@127.0.0.1:6379/0"))).not.toContain(
      "secret",
    );
    expect(parseRedisUrl("")).toBeNull();
    expect(parseRedisUrl("http://127.0.0.1:6379")).toBeNull();
    expect(parseRedisUrl("redis://")).toBeNull();
    expect(secretStatus(" token ")).toBe("CONFIGURED");
    expect(secretStatus("")).toBe("MISSING");
  });

  it("proves Node env-file preserves quoted spaces", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bot-tele-env-"));
    const file = join(dir, "test.env");
    try {
      await writeFile(file, 'X="hello world"\n');
      const { stdout } = await exec(process.execPath, [
        `--env-file=${file}`,
        "-e",
        "process.stdout.write(process.env.X ?? '')",
      ]);
      expect(stdout).toBe("hello world");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("does not let a parent DATABASE_URL override --env-file after sanitizing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bot-tele-env-"));
    const file = join(dir, "test.env");
    try {
      await writeFile(file, "DATABASE_URL=postgres://file@localhost:5432/shop\n");
      const dirty = {
        ...process.env,
        DATABASE_URL: "postgres://parent@localhost:5433/shop",
      };
      const { stdout: overridden } = await exec(
        process.execPath,
        [`--env-file=${file}`, "-e", "process.stdout.write(process.env.DATABASE_URL ?? '')"],
        { env: dirty },
      );
      expect(overridden).toBe("postgres://parent@localhost:5433/shop");

      const { stdout: sanitized } = await exec(
        process.execPath,
        [`--env-file=${file}`, "-e", "process.stdout.write(process.env.DATABASE_URL ?? '')"],
        { env: operationalChildEnv(dirty) },
      );
      expect(sanitized).toBe("postgres://file@localhost:5432/shop");
      expect(operationalChildEnv(dirty).DATABASE_URL).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
