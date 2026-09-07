import assert from "node:assert/strict";
import { sql } from "kysely";
import { createDb, type DbHandle } from "../src/infrastructure/db/client.js";
import { loadConfig } from "../src/config/index.js";
import {
  recoverCriticalJob,
  type CriticalRecoveryFamily,
} from "../src/modules/recovery/critical-durable-recovery.js";
import { startPostgresContainer, type PgTestContext } from "../tests/helpers/pg-container.js";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const FAMILIES = new Set<CriticalRecoveryFamily>([
  "outbox",
  "notification_delivery",
  "delivery_notification_handoff",
  "telegram_inbox",
  "sepay_inbox",
  "supplier_order",
]);

interface DeadLetterRow {
  id: string;
  aggregate_type: string;
  aggregate_id: string;
  aggregate_version: number;
  event_type: string;
  occurred_at: Date | string;
  attempt_count: number;
  next_attempt_at: Date | string | null;
  dead_lettered_at: Date | string;
  claimed_by: string | null;
  claim_expires_at: Date | string | null;
}

interface InspectRow extends DeadLetterRow {
  published_at: Date | string | null;
  claim_generation: string;
}

interface ListItem {
  id: string;
  aggregateType: string;
  aggregateId: string;
  aggregateVersion: number;
  eventType: string;
  attempts: number;
  occurredAt: string;
  deadLetteredAt: string;
  nextAttemptAt: string | null;
  lease: "none" | "active_or_expired";
  guidance: string;
}

interface InspectItem extends ListItem {
  publishedAt: string | null;
  claimGeneration: number;
  safeMetadata: {
    payloadStored: boolean;
    errorStored: boolean;
  };
}

function iso(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function limitFrom(raw: string | undefined): number {
  const limit = raw === undefined ? DEFAULT_LIMIT : Number(raw);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new Error(`--limit must be an integer from 1 to ${MAX_LIMIT}`);
  }
  return limit;
}

function toListItem(row: DeadLetterRow): ListItem {
  return {
    id: row.id,
    aggregateType: row.aggregate_type,
    aggregateId: row.aggregate_id,
    aggregateVersion: row.aggregate_version,
    eventType: row.event_type,
    attempts: row.attempt_count,
    occurredAt: iso(row.occurred_at)!,
    deadLetteredAt: iso(row.dead_lettered_at)!,
    nextAttemptAt: iso(row.next_attempt_at),
    lease: row.claimed_by || row.claim_expires_at ? "active_or_expired" : "none",
    guidance:
      "Use recover with explicit --family/--id/--actor/--reason after business-state review.",
  };
}

async function listDeadLetters(db: DbHandle["db"], limit: number): Promise<ListItem[]> {
  const rows = await sql<DeadLetterRow>`
    select id, aggregate_type, aggregate_id, aggregate_version, event_type, occurred_at,
           attempt_count, next_attempt_at, dead_lettered_at, claimed_by, claim_expires_at
    from outbox_event
    where published_at is null and dead_lettered_at is not null
    order by dead_lettered_at desc, occurred_at desc, id desc
    limit ${limit}
  `.execute(db);
  return rows.rows.map(toListItem);
}

async function inspectDeadLetter(db: DbHandle["db"], id: string): Promise<InspectItem | null> {
  const rows = await sql<InspectRow & { has_error: boolean; has_payload: boolean }>`
    select id, aggregate_type, aggregate_id, aggregate_version, event_type, occurred_at,
           published_at, attempt_count, next_attempt_at, dead_lettered_at, claimed_by,
           claim_expires_at, claim_generation::text,
           last_error_code is not null as has_error,
           payload_redacted <> '{}'::jsonb as has_payload
    from outbox_event
    where id = ${id} and published_at is null and dead_lettered_at is not null
    limit 1
  `.execute(db);
  const row = rows.rows[0];
  if (!row) return null;
  return {
    ...toListItem(row),
    publishedAt: iso(row.published_at),
    claimGeneration: Number(row.claim_generation),
    safeMetadata: {
      payloadStored: row.has_payload,
      errorStored: row.has_error,
    },
  };
}

async function withDb<T>(run: (db: DbHandle["db"]) => Promise<T>): Promise<T> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString || connectionString.trim().length === 0) {
    throw new Error("DATABASE_URL is required; this script does not load .env");
  }
  const handle = createDb({ connectionString, maxConnections: 2, statementTimeoutMs: 10_000 });
  try {
    return await run(handle.db);
  } finally {
    await handle.close();
  }
}

function valueAfter(args: string[], flag: string): string | null {
  const index = args.indexOf(flag);
  if (index === -1) return null;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

function parseRecover(args: string[]): {
  family: CriticalRecoveryFamily;
  id: string;
  rootAdminTelegramUserId: string;
  reason: string;
  correlationId: string;
} {
  if (args.length !== 10)
    throw new Error("recover requires explicit --family --id --actor --reason --correlation-id");
  const family = valueAfter(args, "--family");
  if (!family || !FAMILIES.has(family as CriticalRecoveryFamily))
    throw new Error("invalid --family");
  const id = valueAfter(args, "--id");
  const actor = valueAfter(args, "--actor");
  const reason = valueAfter(args, "--reason");
  const correlationId = valueAfter(args, "--correlation-id");
  if (!id || !actor || !reason || !correlationId) {
    throw new Error("recover requires explicit --family --id --actor --reason --correlation-id");
  }
  return {
    family: family as CriticalRecoveryFamily,
    id,
    rootAdminTelegramUserId: actor,
    reason,
    correlationId,
  };
}

async function seedSelfCheck(ctx: PgTestContext): Promise<{ deadId: string; liveId: string }> {
  const deadId = "self-check-dead";
  const liveId = "self-check-live";
  await sql`
    insert into outbox_event
      (id, aggregate_type, aggregate_id, aggregate_version, event_type, payload_redacted,
       attempt_count, last_error_code, dead_lettered_at)
    values
      (${deadId}, 'Order', 'order-safe-id', 1, 'StockDelta',
       ${JSON.stringify({ customer: "fixture-customer", credential: ["not", "printed"].join("-") })}::jsonb,
       10, 'FixtureError', now()),
      (${liveId}, 'Order', 'order-live-id', 1, 'StockDelta',
       ${JSON.stringify({ customer: "live-fixture", credential: ["still", "hidden"].join("-") })}::jsonb,
       0, null, null)
  `.execute(ctx.db);
  return { deadId, liveId };
}

async function selfCheck(): Promise<void> {
  const ctx = await startPostgresContainer();
  try {
    const ids = await seedSelfCheck(ctx);
    const before = await sql<{ row: unknown }>`
      select to_jsonb(outbox_event.*) as row from outbox_event order by id
    `.execute(ctx.db);
    const listed = await listDeadLetters(ctx.db, 10);
    const inspected = await inspectDeadLetter(ctx.db, ids.deadId);
    const missing = await inspectDeadLetter(ctx.db, ids.liveId);
    const recovered = await recoverCriticalJob(ctx.db, {
      family: "outbox",
      id: ids.deadId,
      rootAdminTelegramUserId: "111222333",
      reason: "self check recovery",
      correlationId: "outbox-operations-self-check",
      configuredRootAdminTelegramUserId: "111222333",
    });
    const after = await sql<{ dead_lettered_at: Date | null; claim_generation: string }>`
      select dead_lettered_at, claim_generation::text from outbox_event where id=${ids.deadId}
    `.execute(ctx.db);
    const rendered = JSON.stringify({ listed, inspected, missing, recovered });

    assert.equal(listed.length, 1);
    assert.equal(listed[0]?.id, ids.deadId);
    assert.equal(inspected?.id, ids.deadId);
    assert.equal(inspected?.safeMetadata.payloadStored, true);
    assert.equal(missing, null);
    assert.equal(recovered.ok, true);
    assert.equal(after.rows[0]?.dead_lettered_at, null);
    assert.equal(after.rows[0]?.claim_generation, "1");
    assert.equal(before.rows.length, 2);
    assert.equal(rendered.includes("not-printed"), false);
    assert.equal(rendered.includes("still-hidden"), false);
    assert.equal(rendered.includes("FixtureError"), false);
    console.log(JSON.stringify({ ok: true, checked: "outbox inspect/recover redaction" }));
  } finally {
    await ctx.teardown();
  }
}

function printUsage(): void {
  console.log(
    [
      "Usage:",
      "  npm exec tsx -- scripts/outbox-operations.ts list [--limit N]",
      "  npm exec tsx -- scripts/outbox-operations.ts inspect <outbox_id>",
      "  npm exec tsx -- scripts/outbox-operations.ts recover --family <family> --id <job_id> --actor <root_telegram_id> --reason <reason> --correlation-id <id>",
      "  npm exec tsx -- scripts/outbox-operations.ts --self-check",
      "",
      `Families: ${Array.from(FAMILIES).join(", ")}`,
      "Recover is explicit and type-aware; no generic payload dispatch is exposed.",
    ].join("\n"),
  );
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];
  if (command === "--self-check" && args.length === 1) {
    await selfCheck();
    return;
  }
  if (command === "list") {
    const limit =
      args.length === 1
        ? DEFAULT_LIMIT
        : args[1] === "--limit" && args.length === 3
          ? limitFrom(args[2])
          : null;
    if (limit === null) throw new Error("invalid list arguments");
    const items = await withDb((db) => listDeadLetters(db, limit));
    console.log(JSON.stringify({ deadLetters: items }, null, 2));
    return;
  }
  if (command === "inspect") {
    if (args.length !== 2 || !args[1] || args[1].startsWith("--")) {
      throw new Error("inspect requires exactly one outbox id");
    }
    const item = await withDb((db) => inspectDeadLetter(db, args[1]!));
    console.log(
      JSON.stringify(
        item ? { found: true, deadLetter: item } : { found: false, id: args[1] },
        null,
        2,
      ),
    );
    return;
  }
  if (command === "recover") {
    const config = loadConfig();
    const input = {
      ...parseRecover(args.slice(1)),
      configuredRootAdminTelegramUserId: String(config.ADMIN_TELEGRAM_USER_ID),
    };
    const result = await withDb((db) => recoverCriticalJob(db, input));
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 2;
    return;
  }
  printUsage();
  if (command) process.exitCode = 1;
}

try {
  await main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : "outbox operation failed"}\n`);
  process.exitCode = 1;
}
