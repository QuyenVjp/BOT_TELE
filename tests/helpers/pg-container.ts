import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { createDb, type DbHandle } from "../../src/infrastructure/db/client.js";
import { runMigrations } from "../../src/infrastructure/db/migrate.js";

/**
 * Shared PostgreSQL test harness (integration tests).
 *
 * Spins up a disposable PostgreSQL container via Testcontainers, applies the
 * real migrations, and hands back a typed DbHandle. Each test file owns its own
 * container so suites stay isolated and can run in parallel forks.
 *
 * Requires a running Docker engine; skip the calling suite when unavailable.
 */

const PG_IMAGE = "postgres:16-alpine";
const PG_USER = "shop_test";
const PG_PASSWORD = "shop_test_pw";
const PG_DB = "shop_test";

export interface StartedPg {
  handle: DbHandle;
  connectionString: string;
  stop(): Promise<void>;
}

export async function startPostgres(): Promise<StartedPg> {
  const container: StartedTestContainer = await new GenericContainer(PG_IMAGE)
    .withEnvironment({
      POSTGRES_USER: PG_USER,
      POSTGRES_PASSWORD: PG_PASSWORD,
      POSTGRES_DB: PG_DB,
    })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .withStartupTimeout(120_000)
    .start();

  const host = container.getHost();
  const port = container.getMappedPort(5432);
  const connectionString = `postgres://${PG_USER}:${PG_PASSWORD}@${host}:${port}/${PG_DB}`;

  const handle = createDb({ connectionString });
  try {
    await runMigrations(handle.db);
  } catch (error) {
    // A container that started but failed its readiness/migration contract is
    // a real test failure. Clean up the started resources, then rethrow rather
    // than converting the failure into a skip.
    await handle.close().catch(() => undefined);
    await container.stop().catch(() => undefined);
    throw error;
  }

  return {
    handle,
    connectionString,
    async stop() {
      await handle.close();
      await container.stop();
    },
  };
}

/**
 * Probe whether a Docker engine is reachable. Integration suites call this in
 * `beforeAll` and skip themselves (rather than fail) when Docker is absent, so
 * unit lanes stay green on machines without Docker.
 */
export async function dockerAvailable(): Promise<boolean> {
  try {
    const { getContainerRuntimeClient } = await import("testcontainers");
    // `getContainerRuntimeClient` performs a live Docker info probe. Keep this
    // probe read-only; startup failures after a container is created are not
    // caught here and therefore remain failing test errors.
    await getContainerRuntimeClient();
    return true;
  } catch {
    return false;
  }
}

/**
 * Ergonomic wrapper around {@link startPostgres} that exposes the Kysely handle
 * directly plus a `teardown()`. Suites that always run under Docker (CI) use
 * this; suites that must skip gracefully call `startPostgres` + `dockerAvailable`.
 */
export interface PgTestContext {
  readonly db: DbHandle["db"];
  readonly handle: DbHandle;
  readonly connectionString: string;
  teardown(): Promise<void>;
}

export async function startPostgresContainer(): Promise<PgTestContext> {
  const started = await startPostgres();
  return {
    db: started.handle.db,
    handle: started.handle,
    connectionString: started.connectionString,
    teardown: () => started.stop(),
  };
}
