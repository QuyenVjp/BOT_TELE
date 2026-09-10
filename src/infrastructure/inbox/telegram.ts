import { sql, type RawBuilder } from "kysely";
import { newId } from "../../shared/ids/index.js";
import type {
  DistributedRateLimiter,
  TelegramRateLimitAction,
} from "../../modules/risk/service.js";
import type { Db } from "../db/transaction.js";

export type TelegramChatType = "private" | "group" | "supergroup";
export type TelegramInboxAction = TelegramRateLimitAction;

export interface TelegramCommandEnvelope {
  actorUserId: string;
  actorUsername?: string;
  chatId: string;
  chatType: TelegramChatType;
  messageId: string | null;
  callbackQueryId?: string;
  action: TelegramInboxAction;
  callbackData?: string;
  command?: string;
  messageText?: string;
  rootProductDraftText?: true;
  inventoryImportText?: true;
  productContentEditText?: true;
  warrantyRefundAdjustText?: true;
  searchQuery?: string;
  firstName?: string;
  lastName?: string;
  languageCode?: string;
  contactPhoneNumber?: string;
  contactSharedAt?: string;
  document?: {
    fileId: string;
    fileUniqueId?: string | null;
    filename: string;
    mimeType: string;
    fileSize?: number;
  };
  messageThreadId?: number | null;
  replyToMessageId?: string | null;
  replyToText?: string | null;
  replyToBot?: boolean;
  newChatMembers?: Array<{ id: number; firstName: string; isBot: boolean }>;
  inlineQuery?: {
    id: string;
    query: string;
    offset?: string;
    chatType?: string;
  };
  chosenInlineResult?: {
    resultId: string;
    query: string;
    inlineMessageId?: string;
  };
  /**
   * Set when the durable payload has been stripped of every non-retained field.
   * Present means nothing credential-bearing remains in this inbox row.
   */
  redactedAt?: string;
  /**
   * Inbox `received_at` of the update, stamped at claim time. This is the ordering key the
   * UI supersession guard uses: a retried event keeps its original timestamp, so a render
   * that would land on top of a newer screen is dropped.
   */
  receivedAt?: string;
}

export interface AcceptTelegramInput {
  sourceEventId: string;
  rawHash: string;
  envelope: TelegramCommandEnvelope;
}

export type AcceptTelegramResult =
  | { kind: "ACCEPTED"; id: string }
  | { kind: "DUPLICATE"; id: string }
  | { kind: "MUTATION"; id: string };

export interface ClaimTelegramOptions {
  owner: string;
  batchSize: number;
  leaseSeconds: number;
}

export interface TelegramInboxClaim {
  id: string;
  sourceEventId: string;
  envelope: TelegramCommandEnvelope;
  owner: string;
  generation: number;
  attemptCount: number;
}

export interface TelegramInboxStats {
  due: number;
  processing: number;
  dead: number;
  oldestDueSeconds: number | null;
}

export interface TelegramInboxTelemetry {
  claimed: number;
  processed: number;
  throttled: number;
  failed: number;
  stale: number;
  durationMs: number;
  backlog: TelegramInboxStats;
}

export interface TelegramInbox {
  accept(input: AcceptTelegramInput): Promise<AcceptTelegramResult>;
  claimDue(options: ClaimTelegramOptions): Promise<TelegramInboxClaim[]>;
  markProcessed(claim: TelegramInboxClaim): Promise<boolean>;
  markFailed(
    claim: TelegramInboxClaim,
    options: {
      errorCode: string;
      maxAttempts: number;
      retryAfterSeconds: number;
      /**
       * Whether this failure consumes the retry budget. Defaults to true.
       * Rate limiting is transient backpressure, not an application failure: passing
       * false refunds the attempt and never dead-letters, so a burst drains instead of
       * being dropped after `maxAttempts` tight-loop attempts.
       */
      countsTowardBudget?: boolean;
    },
  ): Promise<"RETRY" | "DEAD" | "STALE">;
  stats(): Promise<TelegramInboxStats>;
  /**
   * Strip credential-bearing payload from rows that no longer need it: terminal rows
   * immediately, in-flight rows only once they have aged past the retry grace window.
   * Idempotent and batch-bounded; safe to run on every scheduler tick.
   */
  sanitizePayloads(options: { batchSize: number; retryGraceSeconds: number }): Promise<number>;
  prune(options: {
    processedRetentionDays: number;
    deadRetentionDays: number;
    staleRetryRetentionDays?: number;
    batchSize: number;
  }): Promise<number>;
}

interface StoredInboxRow {
  id: string;
  source_event_id: string;
  raw_hash: string;
  envelope: TelegramCommandEnvelope;
  claimed_by: string;
  claim_generation: string;
  attempt_count: number;
  received_at: Date;
}

const HASH_PATTERN = /^[a-f0-9]{64}$/;
const ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;

/**
 * Envelope keys allowed to survive redaction.
 *
 * Everything else is dropped the moment the update no longer needs to be replayed:
 * `messageText` carries admin inventory pastes (`email|password`), `searchQuery` /
 * `replyToText` carry user prose, `contactPhoneNumber` is direct PII and `document`
 * holds an uploaded credential CSV. Those belong in the vault, never in an inbox row.
 * What remains is delivery identity, routing and dedup/audit metadata.
 */
export const RETAINED_ENVELOPE_KEYS = [
  "actorUserId",
  "chatId",
  "chatType",
  "messageId",
  "callbackQueryId",
  "action",
  "command",
  "rootProductDraftText",
  "inventoryImportText",
  "productContentEditText",
  "warrantyRefundAdjustText",
  "firstName",
  "lastName",
  "languageCode",
  "messageThreadId",
  "replyToMessageId",
  "replyToBot",
  "newChatMembers",
  "contactSharedAt",
] as const;

/** Keep only {@link RETAINED_ENVELOPE_KEYS} and stamp the redaction marker. */
export function sanitizeTelegramEnvelope(
  envelope: TelegramCommandEnvelope,
): TelegramCommandEnvelope {
  const retained: Record<string, unknown> = {};
  for (const key of RETAINED_ENVELOPE_KEYS) {
    const value = envelope[key];
    if (value !== undefined) retained[key] = value;
  }
  return { ...retained, redactedAt: new Date().toISOString() } as TelegramCommandEnvelope;
}

/**
 * jsonb expression that reduces `payload` to the retained keys and marks it redacted.
 * Already-redacted values pass through untouched so repeated runs are stable.
 */
function redactEnvelopeSql(payload: RawBuilder<unknown>): RawBuilder<unknown> {
  return sql`case
    when ${payload} ? 'redactedAt' then ${payload}
    else (
      select coalesce(jsonb_object_agg(e.key, e.value), '{}'::jsonb)
      from jsonb_each(${payload}) as e
      where e.key = any(${[...RETAINED_ENVELOPE_KEYS]}::text[])
    ) || jsonb_build_object('redactedAt', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
  end`;
}

export function createPostgresTelegramInbox(db: Db): TelegramInbox {
  return {
    async accept(input) {
      validateAcceptInput(input);
      // Username is untrusted display metadata. It may be observed by the
      // authenticated webhook path, but it must not enter the durable inbox
      // envelope (numeric Telegram ID is the only authorization principal).
      const { actorUsername: _discardedUsername, ...durableEnvelope } = input.envelope;
      const id = newId();
      const inserted = await sql<{ id: string }>`
        insert into webhook_inbox
          (id, source, source_event_id, raw_hash, signature_status, processing_status, envelope,
           next_attempt_at)
        values
          (${id}, 'telegram', ${input.sourceEventId}, ${input.rawHash}, 'VERIFIED', 'RETRY',
           ${JSON.stringify(durableEnvelope)}::jsonb, now())
        on conflict (source, source_event_id) do nothing
        returning id
      `.execute(db);
      if (inserted.rows[0]) {
        if (_discardedUsername) {
          await recordTelegramUsernameObservation(
            db,
            input.envelope.actorUserId,
            _discardedUsername,
          );
        }
        return { kind: "ACCEPTED", id: inserted.rows[0].id };
      }

      const winner = await sql<{ id: string; raw_hash: string }>`
        select id, raw_hash
        from webhook_inbox
        where source = 'telegram' and source_event_id = ${input.sourceEventId}
      `.execute(db);
      const row = winner.rows[0];
      if (!row) throw new Error("Telegram inbox conflict winner was not found");
      if (row.raw_hash === input.rawHash) return { kind: "DUPLICATE", id: row.id };
      await sql`
        update webhook_inbox
        set mutation_count = mutation_count + 1,
            last_mutation_at = now()
        where id = ${row.id}
      `.execute(db);
      return { kind: "MUTATION", id: row.id };
    },

    async claimDue(options) {
      if (!options.owner || options.owner.length > 128) throw new Error("Invalid inbox owner");
      if (
        !Number.isInteger(options.batchSize) ||
        options.batchSize < 1 ||
        options.batchSize > 100
      ) {
        throw new Error("Invalid inbox batch size");
      }
      if (
        !Number.isInteger(options.leaseSeconds) ||
        options.leaseSeconds < 1 ||
        options.leaseSeconds > 300
      ) {
        throw new Error("Invalid inbox lease");
      }
      const rows = await sql<StoredInboxRow>`
        with candidates as (
          select id
          from webhook_inbox
          where (
            (processing_status = 'RETRY' and coalesce(next_attempt_at, received_at) <= now())
            or
            (processing_status = 'PROCESSING' and claim_expires_at <= now())
          )
          order by coalesce(next_attempt_at, claim_expires_at, received_at), received_at, id
          for update skip locked
          limit ${options.batchSize}
        )
        update webhook_inbox w
        set processing_status = 'PROCESSING',
            claimed_by = ${options.owner},
            claim_generation = w.claim_generation + 1,
            claim_expires_at = now() + make_interval(secs => ${options.leaseSeconds}),
            attempt_count = w.attempt_count + 1,
            last_error_code = null
        from candidates c
        where w.id = c.id
        returning w.id, w.source_event_id, w.raw_hash, w.envelope, w.claimed_by,
                  w.claim_generation::text, w.attempt_count, w.received_at
      `.execute(db);
      return rows.rows.map(mapClaim);
    },

    async markProcessed(claim) {
      const result = await sql<{ id: string }>`
        update webhook_inbox
        set processing_status = 'PROCESSED', processed_at = now(), claimed_by = null,
            claim_expires_at = null, next_attempt_at = null, last_error_code = null,
            envelope = ${redactEnvelopeSql(sql`envelope`)}
        where id = ${claim.id}
          and processing_status = 'PROCESSING'
          and claimed_by = ${claim.owner}
          and claim_generation = ${claim.generation}
        returning id
      `.execute(db);
      return result.rows.length === 1;
    },

    async markFailed(claim, options) {
      if (!ERROR_CODE_PATTERN.test(options.errorCode)) throw new Error("Invalid inbox error code");
      if (!Number.isInteger(options.maxAttempts) || options.maxAttempts < 1) {
        throw new Error("Invalid inbox max attempts");
      }
      if (
        !Number.isFinite(options.retryAfterSeconds) ||
        options.retryAfterSeconds < 0 ||
        options.retryAfterSeconds > 3600
      ) {
        throw new Error("Invalid inbox retry delay");
      }
      if (options.countsTowardBudget === false) {
        // Throttled: keep the failure budget intact and reschedule exactly when the
        // bucket refills. Never terminal — the bound is the inbox retention window.
        const retrySeconds = Math.max(1, Math.ceil(options.retryAfterSeconds));
        const throttled = await sql<{ processing_status: "RETRY" }>`
          update webhook_inbox
          set processing_status = 'RETRY',
              next_attempt_at = now() + make_interval(secs => ${retrySeconds}),
              dead_lettered_at = null,
              last_error_code = ${options.errorCode},
              attempt_count = greatest(attempt_count - 1, 0),
              claimed_by = null,
              claim_expires_at = null,
              envelope = envelope
          where id = ${claim.id}
            and processing_status = 'PROCESSING'
            and claimed_by = ${claim.owner}
            and claim_generation = ${claim.generation}
          returning processing_status
        `.execute(db);
        return throttled.rows[0]?.processing_status ?? "STALE";
      }
      const terminal = claim.attemptCount >= options.maxAttempts;
      const result = await sql<{ processing_status: "RETRY" | "DEAD" }>`
        update webhook_inbox
        set processing_status = ${terminal ? "DEAD" : "RETRY"},
            next_attempt_at = ${terminal ? null : sql`now() + make_interval(secs => ${options.retryAfterSeconds})`},
            dead_lettered_at = ${terminal ? sql`now()` : null},
            last_error_code = ${options.errorCode},
            claimed_by = null,
            claim_expires_at = null,
            envelope = ${terminal ? redactEnvelopeSql(sql`envelope`) : sql`envelope`}
        where id = ${claim.id}
          and processing_status = 'PROCESSING'
          and claimed_by = ${claim.owner}
          and claim_generation = ${claim.generation}
        returning processing_status
      `.execute(db);
      return result.rows[0]?.processing_status ?? "STALE";
    },

    async stats() {
      const result = await sql<{
        due: number;
        processing: number;
        dead: number;
        oldest_due_seconds: string | null;
      }>`
        select
          count(*) filter (where processing_status = 'RETRY' and next_attempt_at <= now())::int as due,
          count(*) filter (where processing_status = 'PROCESSING')::int as processing,
          count(*) filter (where processing_status = 'DEAD')::int as dead,
          extract(epoch from now() - min(received_at) filter
            (where processing_status = 'RETRY' and next_attempt_at <= now()))::text as oldest_due_seconds
        from webhook_inbox
        where source = 'telegram'
      `.execute(db);
      const row = result.rows[0]!;
      return {
        due: row.due,
        processing: row.processing,
        dead: row.dead,
        oldestDueSeconds: row.oldest_due_seconds === null ? null : Number(row.oldest_due_seconds),
      };
    },

    async sanitizePayloads(options) {
      if (
        !Number.isInteger(options.batchSize) ||
        options.batchSize < 1 ||
        options.batchSize > 1000
      ) {
        throw new Error("Invalid Telegram inbox sanitize batch size");
      }
      if (
        !Number.isInteger(options.retryGraceSeconds) ||
        options.retryGraceSeconds < 1 ||
        options.retryGraceSeconds > 30 * 86_400
      ) {
        throw new Error("Invalid Telegram inbox retry grace");
      }
      const result = await sql<{ id: string }>`
        with candidates as (
          select id
          from webhook_inbox
          where source = 'telegram'
            and not (envelope ? 'redactedAt')
            and (
              processing_status in ('PROCESSED', 'DEAD')
              or received_at < now() - make_interval(secs => ${options.retryGraceSeconds})
            )
          order by received_at, id
          for update skip locked
          limit ${options.batchSize}
        )
        update webhook_inbox w
        set envelope = ${redactEnvelopeSql(sql`w.envelope`)}
        from candidates c
        where w.id = c.id
        returning w.id
      `.execute(db);
      return result.rows.length;
    },

    async prune(options) {
      const staleRetryRetentionDays = options.staleRetryRetentionDays ?? 7;
      if (
        !Number.isInteger(options.processedRetentionDays) ||
        options.processedRetentionDays < 1 ||
        !Number.isInteger(options.deadRetentionDays) ||
        options.deadRetentionDays < options.processedRetentionDays ||
        !Number.isInteger(staleRetryRetentionDays) ||
        staleRetryRetentionDays < 1 ||
        !Number.isInteger(options.batchSize) ||
        options.batchSize < 1 ||
        options.batchSize > 1000
      ) {
        throw new Error("Invalid Telegram inbox retention policy");
      }
      // Source-scoped to `telegram` on purpose: SePay reconciliation evidence lives in
      // the same table and is never pruned from here.
      const deleted = await sql<{ id: string }>`
        with expired as (
          select id
          from webhook_inbox
          where source = 'telegram'
            and (
              (processing_status = 'PROCESSED' and processed_at <
                now() - make_interval(days => ${options.processedRetentionDays}))
              or
              (processing_status = 'DEAD' and dead_lettered_at <
                now() - make_interval(days => ${options.deadRetentionDays}))
              or
              (processing_status = 'RETRY' and received_at <
                now() - make_interval(days => ${staleRetryRetentionDays}))
            )
          order by coalesce(processed_at, dead_lettered_at, received_at), id
          for update skip locked
          limit ${options.batchSize}
        )
        delete from webhook_inbox w
        using expired e
        where w.id = e.id
        returning w.id
      `.execute(db);
      return deleted.rows.length;
    },
  };
}

async function recordTelegramUsernameObservation(
  db: Db,
  telegramUserId: string,
  observedUsername: string,
): Promise<void> {
  await sql`
    insert into telegram_username_observation
      (telegram_user_id, observed_username, observed_at, expires_at)
    values (${telegramUserId}, ${observedUsername}, now(), now() + interval '30 days')
    on conflict (telegram_user_id) do update
    set observed_username = excluded.observed_username,
        observed_at = excluded.observed_at,
        expires_at = excluded.expires_at
  `.execute(db);
}

export async function consumeTelegramUsernameObservation(
  db: Db,
  telegramUserId: string,
): Promise<string | undefined> {
  const result = await sql<{ observed_username: string }>`
    delete from telegram_username_observation
    where telegram_user_id = ${telegramUserId} and expires_at > now()
    returning observed_username
  `.execute(db);
  return result.rows[0]?.observed_username;
}

export async function pruneTelegramUsernameData(
  db: Db,
  options: { batchSize: number; retentionDays: number; now?: Date },
): Promise<{ observationsDeleted: number; identitiesCleared: number }> {
  if (!Number.isInteger(options.batchSize) || options.batchSize < 1 || options.batchSize > 1000) {
    throw new Error("Invalid username prune batch size");
  }
  if (
    !Number.isInteger(options.retentionDays) ||
    options.retentionDays < 1 ||
    options.retentionDays > 365
  ) {
    throw new Error("Invalid username retention");
  }
  const now = options.now ?? new Date();
  const cutoff = new Date(now.getTime() - options.retentionDays * 86_400_000);
  const observations = await sql`
    with expired as (
      select telegram_user_id from telegram_username_observation
      where expires_at <= ${now.toISOString()}
      order by expires_at, telegram_user_id
      limit ${options.batchSize}
      for update skip locked
    )
    delete from telegram_username_observation o
    using expired e where o.telegram_user_id = e.telegram_user_id
    returning o.telegram_user_id
  `.execute(db);
  const identities = await sql`
    with stale as (
      select id from channel_identity
      where observed_username is not null and username_observed_at <= ${cutoff.toISOString()}
      order by username_observed_at, id
      limit ${options.batchSize}
      for update skip locked
    )
    update channel_identity i
    set observed_username = null, username_observed_at = null
    from stale s where i.id = s.id
    returning i.id
  `.execute(db);
  return {
    observationsDeleted: observations.rows.length,
    identitiesCleared: identities.rows.length,
  };
}

export async function processTelegramInboxBatch(input: {
  inbox: TelegramInbox;
  limiter: DistributedRateLimiter;
  handler: (envelope: TelegramCommandEnvelope) => Promise<void>;
  owner: string;
  batchSize: number;
  maxAttempts?: number;
  onTelemetry?: (event: TelegramInboxTelemetry) => void;
}): Promise<{
  claimed: number;
  processed: number;
  throttled: number;
  failed: number;
  stale: number;
}> {
  const startedAt = Date.now();
  const claims = await input.inbox.claimDue({
    owner: input.owner,
    batchSize: input.batchSize,
    leaseSeconds: 30,
  });
  const result = { claimed: claims.length, processed: 0, throttled: 0, failed: 0, stale: 0 };
  for (const claim of claims) {
    try {
      const budget = await input.limiter.tryConsume({
        principal: `user:${claim.envelope.actorUserId}`,
        action: claim.envelope.action,
      });
      if (!budget.allowed) {
        const state = await input.inbox.markFailed(claim, {
          errorCode: "RATE_LIMITED",
          maxAttempts: input.maxAttempts ?? 10,
          retryAfterSeconds: budget.retryAfterSeconds,
          countsTowardBudget: false,
        });
        if (state === "STALE") result.stale += 1;
        else result.throttled += 1;
        continue;
      }
      await input.handler(claim.envelope);
      if (await input.inbox.markProcessed(claim)) result.processed += 1;
      else result.stale += 1;
    } catch {
      const delay = boundedBackoffSeconds(claim.attemptCount);
      const state = await input.inbox.markFailed(claim, {
        errorCode: "HANDLER_FAILED",
        maxAttempts: input.maxAttempts ?? 10,
        retryAfterSeconds: delay,
      });
      if (state === "STALE") result.stale += 1;
      else result.failed += 1;
    }
  }
  if (input.onTelemetry) {
    input.onTelemetry({
      ...result,
      durationMs: Date.now() - startedAt,
      backlog: await input.inbox.stats(),
    });
  }
  return result;
}

function validateAcceptInput(input: AcceptTelegramInput): void {
  if (!/^[0-9]{1,20}$/.test(input.sourceEventId)) throw new Error("Invalid Telegram update id");
  if (!HASH_PATTERN.test(input.rawHash)) throw new Error("Invalid Telegram raw hash");
  if (!/^[1-9][0-9]{0,19}$/.test(input.envelope.actorUserId)) {
    throw new Error("Invalid Telegram actor id");
  }
  if (
    input.envelope.actorUsername !== undefined &&
    !/^[A-Za-z0-9_]{1,64}$/.test(input.envelope.actorUsername)
  ) {
    throw new Error("Invalid Telegram username metadata");
  }
  if (!/^-?[1-9][0-9]{0,19}$/.test(input.envelope.chatId)) {
    throw new Error("Invalid Telegram chat id");
  }
  if (input.envelope.callbackData && Buffer.byteLength(input.envelope.callbackData, "utf8") > 64) {
    throw new Error("Telegram callback data exceeds 64 bytes");
  }
  if (
    input.envelope.callbackQueryId &&
    Buffer.byteLength(input.envelope.callbackQueryId, "utf8") > 128
  ) {
    throw new Error("Invalid Telegram callback query id");
  }
  if (
    input.envelope.searchQuery &&
    (input.envelope.searchQuery.length > 80 ||
      /[^\p{L}\p{N}\s._-]/u.test(input.envelope.searchQuery))
  ) {
    throw new Error("Invalid Telegram search query");
  }
  if (input.envelope.document) {
    const document = input.envelope.document;
    if (!/^[A-Za-z0-9_-]{20,512}$/.test(document.fileId))
      throw new Error("Invalid Telegram document file id");
    if (
      document.fileUniqueId !== undefined &&
      document.fileUniqueId !== null &&
      !/^[A-Za-z0-9_-]{4,256}$/.test(document.fileUniqueId)
    )
      throw new Error("Invalid Telegram document unique id");
    if (
      document.filename.length === 0 ||
      document.filename.length > 255 ||
      document.filename.includes("\0")
    )
      throw new Error("Invalid Telegram document filename");
    if (
      document.mimeType.length === 0 ||
      document.mimeType.length > 127 ||
      !document.mimeType.includes("/") ||
      document.mimeType.includes("\0")
    )
      throw new Error("Invalid Telegram document mime type");
    if (
      document.fileSize !== undefined &&
      (!Number.isSafeInteger(document.fileSize) || document.fileSize < 1)
    )
      throw new Error("Invalid Telegram document size");
  }
}

function mapClaim(row: StoredInboxRow): TelegramInboxClaim {
  return {
    id: row.id,
    sourceEventId: row.source_event_id,
    envelope: { ...row.envelope, receivedAt: new Date(row.received_at).toISOString() },
    owner: row.claimed_by,
    generation: Number(row.claim_generation),
    attemptCount: row.attempt_count,
  };
}

function boundedBackoffSeconds(attempt: number): number {
  return Math.min(300, 2 ** Math.min(8, Math.max(0, attempt - 1)));
}
