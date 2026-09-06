import { afterEach, describe, expect, it } from "vitest";
import { sql } from "kysely";
import {
  createDbWakeListener,
  DB_WAKE_CHANNELS,
  type DbWakeListener,
} from "../../src/infrastructure/db/client.js";
import { dockerAvailable, startPostgres } from "../helpers/pg-container.js";

/** T221 — prove queue wakeup migrations and LISTEN lifecycle against PostgreSQL. */
const hasDocker = await dockerAvailable();

describe.skipIf(!hasDocker)("PostgreSQL queue wakeups", () => {
  let stop: (() => Promise<void>) | undefined;
  let listener: DbWakeListener | undefined;

  afterEach(async () => {
    await listener?.stop();
    listener = undefined;
    await stop?.();
    stop = undefined;
  });

  it("installs queue triggers and delivers commit notifications for inbox and outbox inserts", async () => {
    const started = await startPostgres();
    stop = started.stop;

    const metadata = await sql<{ trigger_name: string; function_source: string }>`
      select t.tgname as trigger_name, p.prosrc as function_source
      from pg_trigger t
      join pg_proc p on p.oid = t.tgfoid
      join pg_class c on c.oid = t.tgrelid
      where not t.tgisinternal
        and c.relname in ('webhook_inbox', 'outbox_event')
        and t.tgname in ('webhook_inbox_queue_wakeup', 'outbox_event_queue_wakeup')
      order by t.tgname
    `.execute(started.handle.db);
    expect(metadata.rows.map((row) => row.trigger_name)).toEqual([
      "outbox_event_queue_wakeup",
      "webhook_inbox_queue_wakeup",
    ]);
    expect(metadata.rows.every((row) => row.function_source.includes("pg_notify"))).toBe(true);

    let telegramNotifications = 0;
    let outboxNotifications = 0;
    listener = createDbWakeListener(started.handle.pool, {
      callbacks: {
        [DB_WAKE_CHANNELS.telegram]: () => {
          telegramNotifications += 1;
        },
        [DB_WAKE_CHANNELS.outbox]: () => {
          outboxNotifications += 1;
        },
      },
      random: () => 0.5,
    });
    await listener.start();
    const initialTelegram = telegramNotifications;
    const initialOutbox = outboxNotifications;

    await sql`
      insert into webhook_inbox
        (id, source, source_event_id, raw_hash, signature_status, envelope)
      values
        ('listener-test-inbox', 'telegram', 'listener-test-event', 'hash', 'valid', '{}'::jsonb)
    `.execute(started.handle.db);
    await waitFor(() => telegramNotifications > initialTelegram);

    await sql`
      insert into outbox_event
        (id, aggregate_type, aggregate_id, aggregate_version, event_type, payload_redacted)
      values
        ('listener-test-outbox', 'Test', 'listener-test', 1, 'TestEvent', '{}'::jsonb)
    `.execute(started.handle.db);
    await waitFor(() => outboxNotifications > initialOutbox);
  }, 180_000);

  it("stops LISTEN subscriptions and can be restarted", async () => {
    const started = await startPostgres();
    stop = started.stop;
    let notifications = 0;
    listener = createDbWakeListener(started.handle.pool, {
      callbacks: { [DB_WAKE_CHANNELS.outbox]: () => void (notifications += 1) },
    });

    await listener.start();
    await listener.stop();
    const afterStop = notifications;
    await sql`
      insert into outbox_event
        (id, aggregate_type, aggregate_id, aggregate_version, event_type, payload_redacted)
      values
        ('listener-stop-outbox', 'Test', 'listener-stop', 1, 'TestEvent', '{}'::jsonb)
    `.execute(started.handle.db);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(notifications).toBe(afterStop);

    await listener.start();
    const afterRestart = notifications;
    await sql`
      insert into outbox_event
        (id, aggregate_type, aggregate_id, aggregate_version, event_type, payload_redacted)
      values
        ('listener-restart-outbox', 'Test', 'listener-restart', 1, 'TestEvent', '{}'::jsonb)
    `.execute(started.handle.db);
    await waitFor(() => notifications > afterRestart);
  }, 180_000);
});

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for PostgreSQL notification");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
