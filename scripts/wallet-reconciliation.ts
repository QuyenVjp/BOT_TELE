import { createHash } from "node:crypto";
import { createDb } from "../src/infrastructure/db/client.js";
import { withTransaction, type Executor } from "../src/infrastructure/db/transaction.js";
import { appendAuditEvent } from "../src/modules/identity/audit.js";
import { registerConfigSecrets, scrubError } from "../src/infrastructure/observability/redact.js";
import { SECRET_ENV_KEYS } from "../src/config/index.js";
import { sql } from "kysely";

export type Mode = "DRY-RUN" | "APPLY";
export type CorrectionStrategy = "CACHE_REPAIR";

const APPLY_CONFIRMATION = "APPLY ACCOUNTING RECONCILIATION";

export interface ReconcileInput {
  mode: Mode;
  walletId: string | null;
  strategy: CorrectionStrategy | null;
  amountVnd: bigint | null;
  expectedCacheVnd: bigint | null;
  expectedLedgerVnd: bigint | null;
  expectedVersion: number | null;
  expectedChainBreaks: number | null;
  actorId: string | null;
  reason: string | null;
  correlationId: string | null;
  idempotencyKey: string | null;
  confirmation: string | null;
  json: boolean;
}

export interface WalletSnapshot {
  id: string;
  balanceVnd: bigint;
  ledgerVnd: bigint;
  version: number;
  entries: number;
  chainBreaks: number;
  migrationHead: string | null;
  doubleEntryReady: boolean;
}

export interface ReconciliationPlan {
  action: CorrectionStrategy;
  walletId: string;
  amountVnd: bigint;
  beforeCacheVnd: bigint;
  beforeLedgerVnd: bigint;
  afterCacheVnd: bigint;
  afterLedgerVnd: bigint;
  beforeVersion: number;
  expectedChainBreaks: number;
  actorId: string;
  reason: string;
  correlationId: string;
  idempotencyKey: string;
  migrationHead: string | null;
  doubleEntryReady: boolean;
}

export interface WalletReconciliationSummary {
  walletCount: number;
  mismatchWalletCount: number;
  mismatchLedgerEntryCount: number;
  chainBreakWalletCount: number;
  chainBreakCount: number;
}

function hashOpaque(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 16);
}

function flag(args: string[], name: string): string | null {
  const index = args.indexOf(name);
  if (index < 0) return null;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

function optionalBigintFlag(args: string[], name: string): bigint | null {
  const value = flag(args, name);
  if (value === null) return null;
  if (!/^\d+$/.test(value)) throw new Error(`${name} must be a non-negative integer`);
  return BigInt(value);
}

function optionalIntegerFlag(args: string[], name: string): number | null {
  const value = flag(args, name);
  if (value === null) return null;
  if (!/^\d+$/.test(value)) throw new Error(`${name} must be a non-negative integer`);
  return Number(value);
}

function parseArgs(args: string[]): ReconcileInput {
  if (args.includes("--help")) {
    printUsage();
    process.exit(0);
  }
  if (args.includes("--dry-run") && args.includes("--mode"))
    throw new Error("use either --dry-run or --mode, not both");
  const mode = args.includes("--dry-run")
    ? "DRY-RUN"
    : (flag(args, "--mode") ?? "DRY-RUN").toUpperCase();
  if (mode !== "DRY-RUN" && mode !== "APPLY") throw new Error("--mode must be DRY-RUN or APPLY");

  const idempotencyKey = flag(args, "--idempotency-key");
  if (idempotencyKey !== null && !/^reconciliation:[A-Za-z0-9._:-]+$/.test(idempotencyKey)) {
    throw new Error("--idempotency-key must use the reconciliation:<opaque-key> format");
  }

  const input: ReconcileInput = {
    mode,
    walletId: flag(args, "--wallet-id"),
    strategy: (flag(args, "--strategy") as CorrectionStrategy | null) ?? null,
    amountVnd: optionalBigintFlag(args, "--amount-vnd"),
    expectedCacheVnd: optionalBigintFlag(args, "--expected-cache-vnd"),
    expectedLedgerVnd: optionalBigintFlag(args, "--expected-ledger-vnd"),
    expectedVersion: optionalIntegerFlag(args, "--expected-version"),
    expectedChainBreaks: optionalIntegerFlag(args, "--expected-chain-breaks"),
    actorId: flag(args, "--actor"),
    reason: flag(args, "--reason")?.trim() ?? null,
    correlationId: flag(args, "--correlation-id"),
    idempotencyKey,
    confirmation: flag(args, "--confirm-apply"),
    json: args.includes("--json"),
  };
  if (input.mode === "APPLY") validateApplyInput(input);
  return input;
}

function validateApplyInput(input: ReconcileInput): void {
  if (!input.walletId) throw new Error("APPLY requires exactly one --wallet-id");
  if (input.strategy !== "CACHE_REPAIR")
    throw new Error(
      "APPLY requires --strategy CACHE_REPAIR; no correction is chosen automatically",
    );
  if (input.amountVnd === null) throw new Error("APPLY requires --amount-vnd");
  if (input.amountVnd <= 0n) throw new Error("amount must be positive");
  if (input.expectedCacheVnd === null) throw new Error("APPLY requires --expected-cache-vnd");
  if (input.expectedLedgerVnd === null) throw new Error("APPLY requires --expected-ledger-vnd");
  if (input.expectedVersion === null) throw new Error("APPLY requires --expected-version");
  if (input.expectedChainBreaks === null) throw new Error("APPLY requires --expected-chain-breaks");
  if (!input.actorId) throw new Error("APPLY requires --actor");
  if (!input.reason) throw new Error("APPLY requires --reason");
  if (!input.correlationId) throw new Error("APPLY requires --correlation-id");
  if (!input.idempotencyKey) throw new Error("APPLY requires --idempotency-key");
  if (input.confirmation !== APPLY_CONFIRMATION)
    throw new Error(`APPLY requires --confirm-apply "${APPLY_CONFIRMATION}"`);
  if (input.reason.length > 500) throw new Error("--reason must be at most 500 characters");
}

export function summarizeWallets(
  snapshots: readonly WalletSnapshot[],
): WalletReconciliationSummary {
  const mismatches = snapshots.filter((snapshot) => snapshot.balanceVnd !== snapshot.ledgerVnd);
  return {
    walletCount: snapshots.length,
    mismatchWalletCount: mismatches.length,
    mismatchLedgerEntryCount: mismatches.reduce((total, snapshot) => total + snapshot.entries, 0),
    chainBreakWalletCount: snapshots.filter((snapshot) => snapshot.chainBreaks > 0).length,
    chainBreakCount: snapshots.reduce((total, snapshot) => total + snapshot.chainBreaks, 0),
  };
}

export function buildReconciliationPlan(
  snapshot: WalletSnapshot,
  input: ReconcileInput,
): ReconciliationPlan {
  validateApplyInput(input);
  if (snapshot.id !== input.walletId) throw new Error("wallet id changed during reconciliation");
  if (snapshot.ledgerVnd < 0n)
    throw new Error("historical wallet ledger is negative; manual accounting review required");
  if (snapshot.version !== input.expectedVersion)
    throw new Error(
      `wallet version changed: expected ${input.expectedVersion}, found ${snapshot.version}`,
    );
  if (snapshot.chainBreaks !== input.expectedChainBreaks) {
    throw new Error(
      `wallet chain-break count changed: expected ${input.expectedChainBreaks}, found ${snapshot.chainBreaks}`,
    );
  }
  if (snapshot.balanceVnd !== input.expectedCacheVnd) {
    throw new Error(
      `wallet cache changed: expected ${input.expectedCacheVnd}, found ${snapshot.balanceVnd}`,
    );
  }
  if (snapshot.ledgerVnd !== input.expectedLedgerVnd) {
    throw new Error(
      `wallet ledger changed: expected ${input.expectedLedgerVnd}, found ${snapshot.ledgerVnd}`,
    );
  }
  if (input.expectedCacheVnd - input.expectedLedgerVnd !== input.amountVnd) {
    throw new Error("amount must equal the unexplained positive cache-minus-ledger difference");
  }
  return {
    action: "CACHE_REPAIR",
    walletId: snapshot.id,
    amountVnd: input.amountVnd!,
    beforeCacheVnd: snapshot.balanceVnd,
    beforeLedgerVnd: snapshot.ledgerVnd,
    afterCacheVnd: snapshot.ledgerVnd,
    afterLedgerVnd: snapshot.ledgerVnd,
    beforeVersion: snapshot.version,
    expectedChainBreaks: snapshot.chainBreaks,
    actorId: input.actorId!,
    reason: input.reason!,
    correlationId: input.correlationId!,
    idempotencyKey: input.idempotencyKey!,
    migrationHead: snapshot.migrationHead,
    doubleEntryReady: snapshot.doubleEntryReady,
  };
}

async function readSnapshots(exec: Executor, walletId: string | null): Promise<WalletSnapshot[]> {
  const filter = walletId ? sql`where wa.id = ${walletId}` : sql``;
  const rows = await sql<{
    id: string;
    balance_vnd: string;
    ledger_vnd: string;
    version: number;
    entries: number;
    chain_breaks: number;
    migration_head: string | null;
    double_entry_ready: boolean;
  }>`
    with ordered as (
      select
        wallet_account_id,
        balance_before_vnd,
        lag(balance_after_vnd) over (
          partition by wallet_account_id order by created_at, id
        ) as previous_after_vnd
      from wallet_ledger
    ),
    chain as (
      select
        wallet_account_id,
        count(*) filter (
          where previous_after_vnd is not null and balance_before_vnd <> previous_after_vnd
        )::int as chain_breaks
      from ordered
      group by wallet_account_id
    )
    select
      wa.id,
      wa.balance_vnd::text,
      coalesce(sum(case when wl.entry_type = 'CREDIT' then wl.amount_vnd else -wl.amount_vnd end), 0)::text as ledger_vnd,
      wa.version,
      count(wl.id)::int as entries,
      coalesce(chain.chain_breaks, 0)::int as chain_breaks,
      (select max(filename) from schema_migrations) as migration_head,
      to_regclass('public.ledger_account') is not null
        and to_regclass('public.ledger_transaction') is not null
        and to_regclass('public.ledger_posting') is not null as double_entry_ready
    from wallet_account wa
    left join wallet_ledger wl on wl.wallet_account_id = wa.id
    left join chain on chain.wallet_account_id = wa.id
    ${filter}
    group by wa.id, wa.balance_vnd, wa.version, chain.chain_breaks
    order by wa.id
  `.execute(exec);
  return rows.rows.map((row) => ({
    id: row.id,
    balanceVnd: BigInt(row.balance_vnd),
    ledgerVnd: BigInt(row.ledger_vnd),
    version: row.version,
    entries: row.entries,
    chainBreaks: row.chain_breaks,
    migrationHead: row.migration_head,
    doubleEntryReady: row.double_entry_ready,
  }));
}

async function applyPlan(
  exec: Executor,
  plan: ReconciliationPlan,
  snapshot: WalletSnapshot,
): Promise<void> {
  if (plan.doubleEntryReady) {
    throw new Error(
      "CACHE_REPAIR APPLY is only allowed before double-entry migration; use a reviewed append-only ledger correction",
    );
  }
  const updated = await sql`
    update wallet_account
    set balance_vnd = ${plan.afterCacheVnd.toString()}, version = version + 1, updated_at = now()
    where id = ${plan.walletId}
      and version = ${snapshot.version}
      and balance_vnd = ${plan.beforeCacheVnd.toString()}
  `.execute(exec);
  if (Number(updated.numAffectedRows ?? 0) !== 1) throw new Error("wallet changed during APPLY");
}

function assertProductionApplyTarget(connectionString: string, input: ReconcileInput): void {
  if (input.mode !== "APPLY" || process.env.NODE_ENV !== "production") return;
  if (process.env.CI === "true") throw new Error("production APPLY is disabled in CI");
  if (process.env.BOT_TELE_CONFIRM_PRODUCTION !== "1")
    throw new Error("production APPLY requires BOT_TELE_CONFIRM_PRODUCTION=1");
  if (process.env.BOT_TELE_FINANCIAL_APPLY !== "1")
    throw new Error("production APPLY requires BOT_TELE_FINANCIAL_APPLY=1");
  const expected = process.env.BOT_TELE_EXPECTED_DB?.trim();
  if (!expected) throw new Error("production APPLY requires BOT_TELE_EXPECTED_DB");
  try {
    const parsed = new URL(connectionString);
    const actual = `${parsed.hostname}:${parsed.port || "5432"}${decodeURIComponent(parsed.pathname)}`;
    if (actual !== expected)
      throw new Error(`database target mismatch: expected ${expected}, actual ${actual}`);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("database target mismatch:"))
      throw error;
    throw new Error("DATABASE_URL is invalid");
  }
}

function redactedSnapshot(snapshot: WalletSnapshot) {
  return {
    walletIdHash: hashOpaque(snapshot.id),
    cacheVnd: snapshot.balanceVnd.toString(),
    ledgerVnd: snapshot.ledgerVnd.toString(),
    deltaVnd: (snapshot.balanceVnd - snapshot.ledgerVnd).toString(),
    version: snapshot.version,
    entries: snapshot.entries,
    chainBreaks: snapshot.chainBreaks,
    migrationHead: snapshot.migrationHead,
    doubleEntryReady: snapshot.doubleEntryReady,
  };
}

function redactedPlan(plan: ReconciliationPlan) {
  return {
    action: plan.action,
    walletIdHash: hashOpaque(plan.walletId),
    amountVnd: plan.amountVnd.toString(),
    beforeCacheVnd: plan.beforeCacheVnd.toString(),
    beforeLedgerVnd: plan.beforeLedgerVnd.toString(),
    afterCacheVnd: plan.afterCacheVnd.toString(),
    afterLedgerVnd: plan.afterLedgerVnd.toString(),
    beforeVersion: plan.beforeVersion,
    expectedChainBreaks: plan.expectedChainBreaks,
    migrationHead: plan.migrationHead,
    doubleEntryReady: plan.doubleEntryReady,
  };
}

function printReport(input: ReconcileInput, snapshots: readonly WalletSnapshot[]): void {
  const summary = summarizeWallets(snapshots);
  const report = {
    scope: input.walletId ? "wallet" : "all-wallets",
    summary,
    correction: "UNDECIDED",
    wallets: snapshots.map(redactedSnapshot),
  };
  if (input.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  console.log(
    `scope=${report.scope} wallets=${summary.walletCount} mismatched_wallets=${summary.mismatchWalletCount} ` +
      `mismatched_ledger_entries=${summary.mismatchLedgerEntryCount} chain_breaks=${summary.chainBreakCount}`,
  );
  for (const wallet of report.wallets) console.log(JSON.stringify(wallet));
  console.log("correction=UNDECIDED");
}

async function findExistingApply(exec: Executor, plan: ReconciliationPlan) {
  const rows = await sql<{
    id: string;
    target_id: string;
    amount_vnd: string | null;
    strategy: string | null;
  }>`
    select
      id,
      target_id,
      metadata_redacted->>'amountVnd' as amount_vnd,
      metadata_redacted->>'strategy' as strategy
    from audit_event
    where action = 'wallet.reconciliation.apply'
      and metadata_redacted->>'idempotencyKey' = ${plan.idempotencyKey}
    limit 1
  `.execute(exec);
  return rows.rows[0] ?? null;
}

async function run(input: ReconcileInput): Promise<number> {
  const connectionString = process.env.DATABASE_URL?.trim();
  if (!connectionString)
    throw new Error("DATABASE_URL is required; this script does not load .env");
  assertProductionApplyTarget(connectionString, input);
  const db = createDb({ connectionString, maxConnections: 1, statementTimeoutMs: 10_000 });
  try {
    const result = await withTransaction(db.db, async (trx) => {
      if (input.mode === "DRY-RUN") {
        const snapshots = await readSnapshots(trx, input.walletId);
        printReport(input, snapshots);
        return { exitCode: summarizeWallets(snapshots).mismatchWalletCount > 0 ? 1 : 0 };
      }

      const snapshot = (await readSnapshots(trx, input.walletId))[0];
      if (!snapshot) throw new Error("wallet not found");
      const plan = buildReconciliationPlan(snapshot, input);
      const existing = await findExistingApply(trx, plan);
      if (existing) {
        if (
          existing.target_id !== plan.walletId ||
          existing.amount_vnd !== plan.amountVnd.toString() ||
          existing.strategy !== plan.action
        ) {
          throw new Error("idempotency key already identifies a different correction");
        }
        const output = {
          scope: "wallet",
          applied: false,
          idempotent: true,
          plan: redactedPlan(plan),
        };
        console.log(input.json ? JSON.stringify(output, null, 2) : JSON.stringify(output));
        return { exitCode: 0 };
      }
      await applyPlan(trx, plan, snapshot);
      const auditId = await appendAuditEvent(trx, {
        actorType: "ROOT_ADMIN",
        actorId: plan.actorId,
        action: "wallet.reconciliation.apply",
        targetType: "WalletAccount",
        targetId: plan.walletId,
        reason: plan.reason,
        correlationId: plan.correlationId,
        metadataRedacted: {
          strategy: plan.action,
          amountVnd: plan.amountVnd.toString(),
          beforeCacheVnd: plan.beforeCacheVnd.toString(),
          afterCacheVnd: plan.afterCacheVnd.toString(),
          ledgerVnd: plan.afterLedgerVnd.toString(),
          expectedVersion: plan.beforeVersion,
          expectedChainBreaks: plan.expectedChainBreaks,
          idempotencyKey: plan.idempotencyKey,
        },
      });
      const output = {
        scope: "wallet",
        applied: true,
        idempotent: false,
        plan: redactedPlan(plan),
        auditIdHash: hashOpaque(auditId),
      };
      console.log(input.json ? JSON.stringify(output, null, 2) : JSON.stringify(output));
      return { exitCode: 0 };
    });
    return result.exitCode;
  } finally {
    await db.close();
  }
}

function printUsage(): void {
  console.log(
    [
      "Usage:",
      "  npm run wallet:reconcile -- --dry-run [--wallet-id <id>] [--json]",
      "  npm run wallet:reconcile -- --mode APPLY --strategy CACHE_REPAIR --wallet-id <id>",
      "    --amount-vnd <n> --expected-cache-vnd <n> --expected-ledger-vnd <n>",
      "    --expected-version <n> --expected-chain-breaks <n> --actor <root-id>",
      "    --reason <reason> --correlation-id <id> --idempotency-key reconciliation:<key>",
      `    --confirm-apply "${APPLY_CONFIRMATION}"`,
      "",
      "Dry-run scans all wallets when --wallet-id is omitted and never mutates data.",
      "APPLY only performs an explicitly selected CACHE_REPAIR with CAS and audit.",
      "Identifiers are hashed in ordinary output; historical ledger rows are never edited.",
    ].join("\n"),
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  registerConfigSecrets(process.env, SECRET_ENV_KEYS);
  run(parseArgs(process.argv.slice(2)))
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch((error: unknown) => {
      console.error(scrubError(error).message);
      process.exitCode = 1;
    });
}
