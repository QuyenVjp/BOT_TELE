import { sql } from "kysely";
import { z } from "zod";
import { newId } from "../../shared/ids/index.js";
import {
  brandVerifiedSePayIngressEvidence,
  type VerifiedSePayEvidence,
} from "../../modules/payments/sepay-ingress.js";
import type { Db } from "../db/transaction.js";

export interface SePayInboxEnvelope {
  evidence: {
    provider: "sepay";
    providerTransactionId: string;
    direction: "IN" | "OUT";
    merchantAccountId: string;
    amountVnd: number;
    structuredCode: string | null;
    content: string | null;
    reference: string | null;
    transactedAt: string;
    rawHash: string;
    correlationId: string;
  };
  payload: {
    id: number;
    gateway: string;
    transactionDate: string;
    accountNumber: string;
    subAccount: string | null;
    code: string | null;
    content: string | null;
    transferType: "in" | "out";
    description: string | null;
    transferAmount: number;
    accumulated: number | null;
    referenceCode: string | null;
  };
  auth: {
    timestamp: string;
    signatureHash: string;
    sourceIp: string;
  };
}

export type SePayInboxAcceptResult =
  | { kind: "ACCEPTED"; id: string }
  | { kind: "DUPLICATE"; id: string }
  | { kind: "MUTATION"; id: string; alertId: string };

export interface SePayInboxClaim {
  id: string;
  sourceEventId: string;
  rawHash: string;
  envelope: SePayInboxEnvelope;
  owner: string;
  generation: number;
  attemptCount: number;
}

export interface SePayInbox {
  accept(input: {
    sourceEventId: string;
    rawHash: string;
    envelope: SePayInboxEnvelope;
  }): Promise<SePayInboxAcceptResult>;
  claimDue(options: {
    owner: string;
    batchSize: number;
    leaseSeconds: number;
  }): Promise<SePayInboxClaim[]>;
  markProcessed(claim: SePayInboxClaim): Promise<boolean>;
  markFailed(
    claim: SePayInboxClaim,
    options: { errorCode: string; maxAttempts: number; retryAfterSeconds: number },
  ): Promise<"RETRY" | "DEAD" | "STALE">;
}

interface StoredRow {
  id: string;
  source_event_id: string;
  raw_hash: string;
  envelope: SePayInboxEnvelope;
  claimed_by: string;
  claim_generation: string;
  attempt_count: number;
}

const SePayInboxEnvelopeSchema = z
  .object({
    evidence: z
      .object({
        provider: z.literal("sepay"),
        providerTransactionId: z.string().min(1).max(128),
        direction: z.enum(["IN", "OUT"]),
        merchantAccountId: z.string().min(1).max(64),
        amountVnd: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
        structuredCode: z.string().max(256).nullable(),
        content: z.string().max(1000).nullable(),
        reference: z.string().max(256).nullable(),
        transactedAt: z.string().datetime({ offset: true }),
        rawHash: z.string().regex(/^[a-f0-9]{64}$/),
        correlationId: z.string().min(1).max(256),
      })
      .strict(),
    payload: z
      .object({
        id: z.number().int().positive(),
        gateway: z.string().min(1).max(128),
        transactionDate: z.string().regex(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/),
        accountNumber: z.string().min(1).max(64),
        subAccount: z.string().max(128).nullable(),
        code: z.string().max(256).nullable(),
        content: z.string().max(1000).nullable(),
        transferType: z.enum(["in", "out"]),
        description: z.string().max(1000).nullable(),
        transferAmount: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
        accumulated: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable(),
        referenceCode: z.string().max(256).nullable(),
      })
      .strict(),
    auth: z
      .object({
        timestamp: z
          .string()
          .regex(/^\d+$/)
          .refine((value) => Number.isSafeInteger(Number(value)) && Number(value) > 0),
        signatureHash: z.string().regex(/^[a-f0-9]{64}$/),
        sourceIp: z.string().min(1).max(64),
      })
      .strict(),
  })
  .strict();

function validateClaimEnvelope(claim: SePayInboxClaim): VerifiedSePayEvidence {
  const parsed = SePayInboxEnvelopeSchema.safeParse(claim.envelope);
  if (!parsed.success) throw new Error("SEPAY_ENVELOPE_INVALID");
  const { evidence, payload } = parsed.data;
  if (
    claim.sourceEventId !== evidence.providerTransactionId ||
    claim.rawHash !== evidence.rawHash ||
    String(payload.id) !== evidence.providerTransactionId ||
    payload.accountNumber !== evidence.merchantAccountId ||
    payload.transferAmount !== evidence.amountVnd ||
    (payload.transferType === "in" ? "IN" : "OUT") !== evidence.direction ||
    payload.code !== evidence.structuredCode ||
    payload.content !== evidence.content ||
    payload.referenceCode !== evidence.reference
  ) {
    throw new Error("SEPAY_ENVELOPE_INCONSISTENT");
  }
  const transactionDate = parseProviderDateStrict(payload.transactionDate);
  if (transactionDate.toISOString() !== evidence.transactedAt) {
    throw new Error("SEPAY_TIMESTAMP_INCONSISTENT");
  }
  return brandVerifiedSePayIngressEvidence({
    ...evidence,
    transactedAt: transactionDate,
  });
}

function parseProviderDateStrict(value: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(value);
  if (!match) throw new Error("SEPAY_TIMESTAMP_INVALID");
  const [, yearText, monthText, dayText, hourText, minuteText, secondText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const parsed = new Date(Date.UTC(year, month - 1, day, hour - 7, minute, second));
  const roundTrip = new Date(parsed.getTime() + 7 * 60 * 60 * 1000);
  if (
    !Number.isFinite(parsed.getTime()) ||
    roundTrip.getUTCFullYear() !== year ||
    roundTrip.getUTCMonth() + 1 !== month ||
    roundTrip.getUTCDate() !== day ||
    roundTrip.getUTCHours() !== hour ||
    roundTrip.getUTCMinutes() !== minute ||
    roundTrip.getUTCSeconds() !== second
  )
    throw new Error("SEPAY_TIMESTAMP_INVALID");
  return parsed;
}

export function createPostgresSePayInbox(db: Db): SePayInbox {
  return {
    async accept(input) {
      if (!/^\d+$/.test(input.sourceEventId) || !/^[a-f0-9]{64}$/.test(input.rawHash)) {
        throw new Error("Invalid SePay inbox identity");
      }
      return db.transaction().execute(async (trx) => {
        const id = newId();
        const inserted = await sql<{ id: string }>`
        insert into webhook_inbox
          (id, source, source_event_id, raw_hash, signature_status, processing_status, envelope, next_attempt_at)
        values
          (${id}, 'sepay', ${input.sourceEventId}, ${input.rawHash}, 'VERIFIED', 'RETRY',
           ${JSON.stringify(input.envelope)}::jsonb, now())
        on conflict (source, source_event_id) do nothing
        returning id
        `.execute(trx);
        if (inserted.rows[0]) return { kind: "ACCEPTED", id: inserted.rows[0].id };

        const winner = await sql<{ id: string; raw_hash: string }>`
        select id, raw_hash from webhook_inbox
        where source = 'sepay' and source_event_id = ${input.sourceEventId}
        `.execute(trx);
        const row = winner.rows[0];
        if (!row) throw new Error("SePay inbox conflict winner was not found");
        if (row.raw_hash === input.rawHash) return { kind: "DUPLICATE", id: row.id };

        const alertId = newId();
        await sql`
        update webhook_inbox
        set mutation_count = mutation_count + 1,
            last_mutation_at = now(),
            last_error_code = 'DUPLICATE_MUTATION'
        where id = ${row.id}
        `.execute(trx);
        await sql`
        insert into discrepancy
          (id, type, status, reason, owner, source, source_event_id, incoming_raw_hash)
        values
          (${alertId}, 'REFERENCE_COLLISION', 'OPEN',
           ${`SePay provider event ${input.sourceEventId} replayed with a different raw hash`}, 'payments-security',
           'sepay', ${input.sourceEventId}, ${input.rawHash})
        on conflict (source, source_event_id, incoming_raw_hash)
          where source = 'sepay' and owner = 'payments-security'
            and type = 'REFERENCE_COLLISION'
          do nothing
        returning id
        `.execute(trx);
        const alert = await sql<{ id: string }>`
          select id from discrepancy
          where source = 'sepay' and source_event_id = ${input.sourceEventId}
            and incoming_raw_hash = ${input.rawHash}
          limit 1
        `.execute(trx);
        return { kind: "MUTATION", id: row.id, alertId: alert.rows[0]?.id ?? alertId };
      });
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
      const rows = await sql<StoredRow>`
        with candidates as (
          select id from webhook_inbox
          where source = 'sepay' and (
            (processing_status = 'RETRY' and coalesce(next_attempt_at, received_at) <= now())
            or (processing_status = 'PROCESSING' and claim_expires_at <= now())
          )
          order by coalesce(next_attempt_at, claim_expires_at, received_at), received_at, id
          for update skip locked limit ${options.batchSize}
        )
        update webhook_inbox w
        set processing_status = 'PROCESSING', claimed_by = ${options.owner},
            claim_generation = w.claim_generation + 1,
            claim_expires_at = now() + make_interval(secs => ${options.leaseSeconds}),
            attempt_count = w.attempt_count + 1, last_error_code = null
        from candidates c where w.id = c.id
        returning w.id, w.source_event_id, w.raw_hash, w.envelope, w.claimed_by,
                  w.claim_generation::text, w.attempt_count
      `.execute(db);
      return rows.rows.map((row) => ({
        id: row.id,
        sourceEventId: row.source_event_id,
        rawHash: row.raw_hash,
        envelope: row.envelope,
        owner: row.claimed_by,
        generation: Number(row.claim_generation),
        attemptCount: row.attempt_count,
      }));
    },

    async markProcessed(claim) {
      const result = await sql`
        update webhook_inbox set processing_status = 'PROCESSED', processed_at = now(),
          claimed_by = null, claim_expires_at = null, next_attempt_at = null, last_error_code = null
        where source = 'sepay' and id = ${claim.id} and processing_status = 'PROCESSING'
          and claimed_by = ${claim.owner} and claim_generation = ${claim.generation}
        returning id
      `.execute(db);
      return result.rows.length === 1;
    },

    async markFailed(claim, options) {
      if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(options.errorCode)) throw new Error("Invalid error code");
      if (!Number.isInteger(options.maxAttempts) || options.maxAttempts < 1)
        throw new Error("Invalid max attempts");
      const terminal = claim.attemptCount >= options.maxAttempts;
      const result = await sql<{ processing_status: "RETRY" | "DEAD" }>`
        update webhook_inbox set processing_status = ${terminal ? "DEAD" : "RETRY"},
          next_attempt_at = ${terminal ? null : sql`now() + make_interval(secs => ${options.retryAfterSeconds})`},
          dead_lettered_at = ${terminal ? sql`now()` : null}, last_error_code = ${options.errorCode},
          claimed_by = null, claim_expires_at = null
        where source = 'sepay' and id = ${claim.id} and processing_status = 'PROCESSING'
          and claimed_by = ${claim.owner} and claim_generation = ${claim.generation}
        returning processing_status
      `.execute(db);
      return result.rows[0]?.processing_status ?? "STALE";
    },
  };
}

export async function processSePayInboxBatch(input: {
  inbox: SePayInbox;
  handler: (evidence: VerifiedSePayEvidence) => Promise<{ ok: boolean }>;
  owner: string;
  batchSize: number;
  maxAttempts?: number;
}): Promise<{ claimed: number; processed: number; failed: number; stale: number }> {
  const claims = await input.inbox.claimDue({
    owner: input.owner,
    batchSize: input.batchSize,
    leaseSeconds: 30,
  });
  const result = { claimed: claims.length, processed: 0, failed: 0, stale: 0 };
  for (const claim of claims) {
    try {
      const trustedEvidence = validateClaimEnvelope(claim);
      const applied = await input.handler(trustedEvidence);
      if (!applied.ok) throw new Error("EVIDENCE_REJECTED");
      if (await input.inbox.markProcessed(claim)) result.processed += 1;
      else result.stale += 1;
    } catch {
      const state = await input.inbox.markFailed(claim, {
        errorCode: "HANDLER_FAILED",
        maxAttempts: input.maxAttempts ?? 8,
        retryAfterSeconds: Math.min(300, 2 ** Math.min(8, Math.max(0, claim.attemptCount - 1))),
      });
      if (state === "STALE") result.stale += 1;
      else result.failed += 1;
    }
  }
  return result;
}
