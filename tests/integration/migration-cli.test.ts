import { afterEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { readFileSync } from "node:fs";
import { createDb } from "../../src/infrastructure/db/client.js";
import { runMigrationsOnPinnedConnection } from "../../src/infrastructure/db/migrate.js";
import { dockerAvailable, startPostgres } from "../helpers/pg-container.js";

/**
 * T117 — Migration CLI + two-concurrent-run advisory-lock tests.
 *
 * 1. `npm run migrate` must actually run a CLI (not a no-op module export).
 * 2. Two concurrent migrations against the same DB must serialize on a pinned
 *    PostgreSQL session advisory lock; both must succeed and each file must be
 *    applied exactly once.
 *
 * The Docker suite is skipped with an explicit reason when no container runtime
 * is available, so a missing runtime is never a silent pass. The structural
 * test below runs everywhere and fails if migrate.ts is not a real CLI.
 */

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");
const hasDocker = await dockerAvailable();

describe.skipIf(!hasDocker)("migration CLI against a real database (T117/T120)", () => {
  let stop: (() => Promise<void>) | undefined;

  afterEach(async () => {
    if (stop) {
      await stop();
      stop = undefined;
    }
  });

  it("CLI exits 0 on a fresh database and reports applied migrations", async () => {
    const started = await startPostgres();
    stop = started.stop;
    const { sql } = await import("kysely");
    await sql`drop schema public cascade`.execute(started.handle.db);
    await sql`create schema public`.execute(started.handle.db);
    await started.handle.close();

    const result = await runMigrateCli(started.connectionString);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout + result.stderr).toMatch(/applied|already|migration/i);
  }, 180_000);

  it("two concurrent migrate CLIs serialize and apply each file once", async () => {
    const started = await startPostgres();
    stop = started.stop;
    const { sql } = await import("kysely");
    await sql`drop schema public cascade`.execute(started.handle.db);
    await sql`create schema public`.execute(started.handle.db);
    await started.handle.close();

    const [a, b] = await Promise.all([
      runMigrateCli(started.connectionString),
      runMigrateCli(started.connectionString),
    ]);
    expect(a.code, a.stderr).toBe(0);
    expect(b.code, b.stderr).toBe(0);

    const check = createDb({ connectionString: started.connectionString });
    try {
      const rows = await sql<{ filename: string; n: string }>`
        select filename, count(*)::text as n
        from schema_migrations
        group by filename
      `.execute(check.db);
      expect(rows.rows.length).toBeGreaterThan(0);
      for (const r of rows.rows) {
        expect(Number(r.n), `migration ${r.filename} applied more than once`).toBe(1);
      }
    } finally {
      await check.close();
    }
  }, 180_000);
  it("keeps unpreviewed internal campaigns out of confirmed broadcast migration", async () => {
    const started = await startPostgres();
    stop = started.stop;
    const { sql } = await import("kysely");
    const before065 = await copyMigrationTree(64);
    const allMigrations = await copyMigrationTree();

    try {
      await runMigrationsOnPinnedConnection(started.connectionString, before065);
      await sql`
        insert into notification_campaign
          (id, class, content, status, idempotency_key, created_by, audience)
        values
          ('legacy-internal', 'SHOP_UPDATE', 'internal', 'QUEUED', 'legacy-internal', 'system', 'all')
      `.execute(started.handle.db);
      await started.handle.close();

      await runMigrationsOnPinnedConnection(started.connectionString, allMigrations);

      const check = createDb({ connectionString: started.connectionString });
      try {
        const rows = await sql<{ id: string; confirmed: boolean }>`
          select id, confirmed_at is not null as confirmed
          from notification_campaign
          where id = 'legacy-internal'
        `.execute(check.db);
        expect(rows.rows).toEqual([{ id: "legacy-internal", confirmed: false }]);
      } finally {
        await check.close();
      }
    } finally {
      await rm(before065, { recursive: true, force: true });
      await rm(allMigrations, { recursive: true, force: true });
    }
  }, 180_000);
});

describe("migration CLI bootstrap is present (no Docker required)", () => {
  it("src/infrastructure/db/migrate.ts is a runnable CLI entrypoint", () => {
    const src = readFileSync(
      resolve(repoRoot, "src", "infrastructure", "db", "migrate.ts"),
      "utf8",
    );
    // Must self-run when invoked as the process entrypoint (same pattern as main/worker).
    expect(src).toMatch(/import\.meta\.url/);
    expect(src).toMatch(/pathToFileURL|fileURLToPath/);
    // Must load a connection string and call runMigrations; not a pure export module.
    expect(src).toMatch(/runMigrations/);
    expect(src).toMatch(/DATABASE_URL|loadConfig|process\.env/);
    // Must pin the advisory lock to a single session-scoped connection.
    expect(src).toMatch(/advisory/i);
    expect(src).toMatch(/connect\(|Client|getConnection|withPinnedConnection|connection\(\)/);
  });
});

async function runMigrateCli(
  databaseUrl: string,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolvePromise) => {
    const child: ChildProcessWithoutNullStreams = spawn(
      process.execPath,
      ["--import", "tsx", resolve(repoRoot, "src", "infrastructure", "db", "migrate.ts")],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          DATABASE_URL: databaseUrl,
          NODE_ENV: "test",
        },
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += String(d);
    });
    child.stderr.on("data", (d) => {
      stderr += String(d);
    });
    child.on("close", (code) => resolvePromise({ code, stdout, stderr }));
  });
}
async function copyMigrationTree(maxNumber?: number): Promise<string> {
  const source = resolve(repoRoot, "src", "infrastructure", "db", "migrations");
  const target = await mkdtemp(join(tmpdir(), "bot-tele-migrations-"));
  const files = (await readdir(source))
    .filter((file) => file.endsWith(".sql"))
    .filter((file) => maxNumber === undefined || Number(file.slice(0, 3)) <= maxNumber);

  await Promise.all(files.map((file) => copyFile(resolve(source, file), resolve(target, file))));
  return target;
}
