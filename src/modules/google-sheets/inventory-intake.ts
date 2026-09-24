import { createHash, randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { sql } from "kysely";
import { z } from "zod";
import type { Db } from "../../infrastructure/db/transaction.js";
import type { Vault } from "../../infrastructure/vault/port.js";
import type { GoogleSheetsOwnerVerifier } from "../../infrastructure/google-sheets/owner-verifier.js";
import type { RootAdminConfig, RootActor } from "../identity/root-admin.js";
import {
  cancelInventoryImportSession,
  confirmInventoryImportSession,
  getInventoryImportSession,
  stageInventoryImportInput,
  startInventoryImportSession,
} from "../digital-goods/inventory-import-session.js";
import type { InventoryPreviewResult } from "../digital-goods/inventory-import.js";
import { deleteAssetVaultRef } from "../digital-goods/vault-orphan.js";
import { INVENTORY_FIELDS_SCHEMA } from "../catalog/fulfillment-type.js";
import { newId } from "../../shared/ids/index.js";

export const GOOGLE_SHEETS_INVENTORY_INTAKE_PATH = "/ops/google-sheets/inventory-intake";
const CHALLENGE_TTL_MS = 15 * 60 * 1000;

export interface GoogleSheetsInventoryIntakeDeps {
  db: Db;
  vault: Vault;
  rootConfig: RootAdminConfig;
  spreadsheetId: string;
  ownerVerifier: GoogleSheetsOwnerVerifier;
  path?: string;
}

const spreadsheetSchema = z.object({
  spreadsheetId: z.string().trim().min(1).max(256),
});
const previewSchema = spreadsheetSchema.extend({
  variantId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  input: z
    .string()
    .min(1)
    .max(64 * 1024),
  costPriceVnd: z.number().int().nonnegative().max(1_000_000_000).optional(),
  safeNote: z.string().trim().max(240).optional(),
});
const confirmSchema = spreadsheetSchema.extend({
  challenge: z.string().regex(/^[A-Za-z0-9_-]{32,256}$/),
});

interface ChallengeRow {
  id: string;
  challenge_hash: string;
  spreadsheet_id: string;
  owner_email: string;
  owner_subject: string;
  admin_telegram_user_id: string;
  variant_id: string;
  input_vault_ref: string | null;
  preview_ready: number;
  preview_invalid: number;
  preview_duplicates: number;
  cost_price_vnd: string | null;
  safe_note: string | null;
  status: "PREVIEWED" | "PROCESSING" | "CONSUMED" | "EXPIRED";
  expires_at: Date | string;
  consumed_at: Date | string | null;
}

type SafePreview = Pick<InventoryPreviewResult, "lines" | "ready" | "invalid" | "duplicates">;

function parseJsonBody(body: unknown): unknown {
  if (typeof body !== "string") return null;
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

function hashChallenge(challenge: string): string {
  return createHash("sha256").update(challenge, "utf8").digest("hex");
}

function actorFor(config: RootAdminConfig): RootActor {
  return {
    numericUserId: config.adminTelegramUserId,
    chatType: "private",
    observedUsername: config.expectedUsername,
  };
}

function correlation(prefix: string): string {
  return `${prefix}:${newId()}`;
}

function safePreview(preview: InventoryPreviewResult): SafePreview {
  return preview;
}

function errorStatus(code: string): number {
  if (code === "UNAUTHORIZED" || code === "WORKBOOK_MISMATCH") return 401;
  if (code === "NOT_FOUND") return 404;
  if (code === "EXPIRED" || code === "BUSY" || code === "NOT_READY") return 409;
  return 422;
}

async function verifyRequest(
  request: { headers: Record<string, string | string[] | undefined> },
  deps: GoogleSheetsInventoryIntakeDeps,
  spreadsheetId: string,
): Promise<
  | { ok: true; subject: string; email: string }
  | { ok: false; code: "UNAUTHORIZED" | "WORKBOOK_MISMATCH" }
> {
  const authorization = request.headers.authorization;
  return deps.ownerVerifier.verify({
    authorization: Array.isArray(authorization) ? authorization[0] : authorization,
    spreadsheetId,
  });
}

async function activeVariantCatalog(db: Db): Promise<
  readonly {
    variantId: string;
    sku: string;
    name: string;
    fields: readonly { name: string; label: string; required: boolean }[];
  }[]
> {
  const rows = await sql<{
    variant_id: string;
    sku: string;
    name: string;
    inventory_fields: unknown;
  }>`
    select v.id as variant_id, v.sku, v.name_vi as name, v.inventory_fields
    from product_variant v
    join product p on p.id = v.product_id
    where v.is_active
      and p.is_active
      and not p.is_archived
      and v.fulfillment_type in ('STOCK_ACCOUNT', 'STOCK_CODE')
    order by p.sort_order, v.sort_order, v.name_vi
  `.execute(db);
  return rows.rows.map((row) => {
    const parsed = INVENTORY_FIELDS_SCHEMA.safeParse(row.inventory_fields);
    const fields = parsed.success
      ? parsed.data.map((field) => ({
          name: field.name,
          label: field.label,
          required: field.required,
        }))
      : [];
    return { variantId: row.variant_id, sku: row.sku, name: row.name, fields };
  });
}

async function cancelActiveSession(
  deps: GoogleSheetsInventoryIntakeDeps,
  actor: RootActor,
  correlationId: string,
): Promise<"READY" | "BUSY"> {
  const existing = await sql<{ status: string }>`
    select status
    from admin_inventory_import
    where admin_telegram_user_id = ${String(actor.numericUserId)}
      and status in ('WAITING_INPUT', 'READY', 'PROCESSING')
    limit 1
  `.execute(deps.db);
  if (existing.rows[0]?.status === "PROCESSING") return "BUSY";

  const openChallenges = await sql<{ id: string; input_vault_ref: string | null }>`
    select id, input_vault_ref
    from google_sheets_inventory_intake_challenge
    where admin_telegram_user_id = ${String(actor.numericUserId)}
      and status = 'PREVIEWED'
    for update
  `.execute(deps.db);
  for (const challenge of openChallenges.rows) {
    // Invalidate before attempting Vault cleanup so a crash cannot replay an old
    // challenge against a newly staged session. The opaque ref remains recoverable
    // through the orphan path if the provider delete fails.
    await sql`
      update google_sheets_inventory_intake_challenge
      set status = 'EXPIRED'
      where id = ${challenge.id} and status = 'PREVIEWED'
    `.execute(deps.db);
    if (challenge.input_vault_ref) {
      await deleteAssetVaultRef(deps.db, deps.vault, challenge.input_vault_ref, {
        correlationId,
        reason: "Google Sheets inventory preview superseded",
      });
      await sql`
        update google_sheets_inventory_intake_challenge
        set input_vault_ref = null
        where id = ${challenge.id} and status = 'EXPIRED'
      `.execute(deps.db);
    }
  }

  if (existing.rows[0]) {
    await cancelInventoryImportSession(deps.db, deps.vault, {
      actor,
      config: deps.rootConfig,
      correlationId,
    });
  }
  return "READY";
}

export async function expireGoogleSheetsInventoryChallenges(input: {
  db: Db;
  vault: Vault;
  rootConfig: RootAdminConfig;
}): Promise<number> {
  const expired = await input.db.transaction().execute(async (trx) => {
    const result = await sql<{ id: string; input_vault_ref: string | null }>`
      select id, input_vault_ref
      from google_sheets_inventory_intake_challenge
      where (status = 'PREVIEWED' and expires_at <= now())
         or (status = 'EXPIRED' and input_vault_ref is not null)
      for update skip locked
    `.execute(trx);
    for (const row of result.rows) {
      await sql`
        update google_sheets_inventory_intake_challenge
        set status = 'EXPIRED'
        where id = ${row.id} and status = 'PREVIEWED'
      `.execute(trx);
    }
    return result.rows;
  });

  for (const row of expired) {
    if (!row.input_vault_ref) continue;
    const actor = actorFor(input.rootConfig);
    const session = await getInventoryImportSession(input.db, String(actor.numericUserId));
    if (session?.inputVaultRef === row.input_vault_ref) {
      await cancelInventoryImportSession(input.db, input.vault, {
        actor,
        config: input.rootConfig,
        correlationId: `google-sheets-inventory-expired:${row.id}`,
      });
    }
    await deleteAssetVaultRef(input.db, input.vault, row.input_vault_ref, {
      correlationId: `google-sheets-inventory-expired:${row.id}`,
      reason: "Google Sheets inventory challenge cleanup",
    });
    await sql`
      update google_sheets_inventory_intake_challenge
      set input_vault_ref = null
      where id = ${row.id} and status = 'EXPIRED'
    `.execute(input.db);
  }
  return expired.length;
}

export async function registerGoogleSheetsInventoryIntake(
  app: FastifyInstance,
  deps: GoogleSheetsInventoryIntakeDeps,
): Promise<void> {
  const basePath = deps.path ?? GOOGLE_SHEETS_INVENTORY_INTAKE_PATH;
  const rateLimitedRouteOptions = {
    config: {
      rateLimit: {
        max: 30,
        timeWindow: "1 minute",
      },
    },
  } as const;

  app.post(`${basePath}/catalog`, rateLimitedRouteOptions, async (request, reply) => {
    const parsed = spreadsheetSchema.safeParse(parseJsonBody(request.body));
    if (!parsed.success) return reply.code(400).send({ ok: false, code: "INVALID_INPUT" });
    const owner = await verifyRequest(request, deps, parsed.data.spreadsheetId);
    if (!owner.ok) return reply.code(errorStatus(owner.code)).send(owner);
    try {
      return reply.send({ ok: true, variants: await activeVariantCatalog(deps.db) });
    } catch {
      return reply.code(500).send({ ok: false, code: "INTAKE_UNAVAILABLE" });
    }
  });

  app.post(`${basePath}/preview`, rateLimitedRouteOptions, async (request, reply) => {
    const parsed = previewSchema.safeParse(parseJsonBody(request.body));
    if (!parsed.success) return reply.code(400).send({ ok: false, code: "INVALID_INPUT" });
    const owner = await verifyRequest(request, deps, parsed.data.spreadsheetId);
    if (!owner.ok) return reply.code(errorStatus(owner.code)).send(owner);

    const actor = actorFor(deps.rootConfig);
    const correlationId = correlation("google-sheets-inventory-preview");
    try {
      // One active import session is shared with the Telegram fallback. Remove its opaque
      // staged ref before replacing it; plaintext never enters this process's durable state.
      if ((await cancelActiveSession(deps, actor, correlationId)) === "BUSY") {
        return reply.code(409).send({ ok: false, code: "BUSY" });
      }
      const started = await startInventoryImportSession(deps.db, {
        actor,
        config: deps.rootConfig,
        correlationId,
        variantId: parsed.data.variantId,
      });
      if (!started.ok) return reply.code(errorStatus(started.code)).send(started);
      const staged = await stageInventoryImportInput(deps.db, deps.vault, {
        actor,
        config: deps.rootConfig,
        correlationId,
        variantId: parsed.data.variantId,
        rawInput: parsed.data.input,
      });
      if (!staged.ok) {
        await cancelInventoryImportSession(deps.db, deps.vault, {
          actor,
          config: deps.rootConfig,
          correlationId,
        });
        return reply.code(errorStatus(staged.code)).send(staged);
      }
      if (staged.preview.ready === 0 || staged.preview.invalid > 0) {
        await cancelInventoryImportSession(deps.db, deps.vault, {
          actor,
          config: deps.rootConfig,
          correlationId,
        });
        return reply.code(422).send({
          ok: false,
          code: staged.preview.ready === 0 ? "NO_NEW_STOCK" : "INVALID_PREVIEW",
          preview: safePreview(staged.preview),
        });
      }
      const session = await getInventoryImportSession(deps.db, String(actor.numericUserId));
      if (!session?.inputVaultRef) throw new Error("inventory preview did not bind a Vault ref");
      const challenge = randomBytes(32).toString("base64url");
      const challengeId = newId();
      await sql`
        insert into google_sheets_inventory_intake_challenge
          (id, challenge_hash, spreadsheet_id, owner_email, owner_subject,
           admin_telegram_user_id, variant_id, input_vault_ref, preview_ready, preview_invalid,
           preview_duplicates, cost_price_vnd, safe_note, status, expires_at)
        values
          (${challengeId}, ${hashChallenge(challenge)}, ${deps.spreadsheetId}, ${owner.email},
           ${owner.subject}, ${String(actor.numericUserId)}, ${parsed.data.variantId},
           ${session.inputVaultRef}, ${staged.preview.ready}, ${staged.preview.invalid}, ${staged.preview.duplicates},
           ${parsed.data.costPriceVnd ?? null}, ${parsed.data.safeNote ?? null}, 'PREVIEWED',
           ${new Date(Date.now() + CHALLENGE_TTL_MS).toISOString()})
      `.execute(deps.db);
      return reply.send({ ok: true, challenge, preview: safePreview(staged.preview) });
    } catch {
      try {
        await cancelInventoryImportSession(deps.db, deps.vault, {
          actor,
          config: deps.rootConfig,
          correlationId,
        });
      } catch {
        // The session/orphan path records opaque compensation state; keep the HTTP error generic.
      }
      return reply.code(500).send({ ok: false, code: "INTAKE_UNAVAILABLE" });
    }
  });

  app.post(`${basePath}/confirm`, rateLimitedRouteOptions, async (request, reply) => {
    const parsed = confirmSchema.safeParse(parseJsonBody(request.body));
    if (!parsed.success) return reply.code(400).send({ ok: false, code: "INVALID_INPUT" });
    const owner = await verifyRequest(request, deps, parsed.data.spreadsheetId);
    if (!owner.ok) return reply.code(errorStatus(owner.code)).send(owner);

    const challengeHash = hashChallenge(parsed.data.challenge);
    const transition = await deps.db.transaction().execute(async (trx) => {
      const result = await sql<ChallengeRow>`
        select id, challenge_hash, spreadsheet_id, owner_email, owner_subject,
          admin_telegram_user_id, variant_id, input_vault_ref, preview_ready, preview_invalid,
          preview_duplicates, cost_price_vnd, safe_note, status, expires_at, consumed_at
        from google_sheets_inventory_intake_challenge
        where challenge_hash = ${challengeHash}
        for update
      `.execute(trx);
      const row = result.rows[0];
      if (!row) return { kind: "NOT_FOUND" as const };
      if (
        row.spreadsheet_id !== parsed.data.spreadsheetId ||
        row.owner_email !== owner.email ||
        row.owner_subject !== owner.subject
      ) {
        return { kind: "UNAUTHORIZED" as const };
      }
      if (row.status === "CONSUMED") return { kind: "CONSUMED" as const, row };
      if (row.status === "EXPIRED") return { kind: "EXPIRED" as const, row };
      if (row.status === "PROCESSING") return { kind: "PROCESSING" as const, row };
      if (new Date(row.expires_at).getTime() <= Date.now()) {
        await sql`
          update google_sheets_inventory_intake_challenge
          set status = 'EXPIRED'
          where id = ${row.id} and status = 'PREVIEWED'
        `.execute(trx);
        return { kind: "EXPIRED" as const, row };
      }
      await sql`
        update google_sheets_inventory_intake_challenge
        set status = 'PROCESSING'
        where id = ${row.id} and status = 'PREVIEWED'
      `.execute(trx);
      return { kind: "PROCESSING" as const, row };
    });

    if (transition.kind === "NOT_FOUND" || transition.kind === "UNAUTHORIZED") {
      return reply.code(401).send({ ok: false, code: "UNAUTHORIZED" });
    }
    const actor = actorFor(deps.rootConfig);
    if (transition.kind === "EXPIRED") {
      if (transition.row.input_vault_ref) {
        const currentSession = await getInventoryImportSession(
          deps.db,
          String(actor.numericUserId),
        );
        if (currentSession?.inputVaultRef === transition.row.input_vault_ref) {
          await cancelInventoryImportSession(deps.db, deps.vault, {
            actor,
            config: deps.rootConfig,
            correlationId: `google-sheets-inventory-expired:${transition.row.id}`,
          });
        }
        await deleteAssetVaultRef(deps.db, deps.vault, transition.row.input_vault_ref, {
          correlationId: `google-sheets-inventory-expired:${transition.row.id}`,
          reason: "Google Sheets intake challenge expired",
        });
        await sql`
          update google_sheets_inventory_intake_challenge
          set input_vault_ref = null
          where id = ${transition.row.id}
        `.execute(deps.db);
      }
      return reply.code(409).send({ ok: false, code: "EXPIRED" });
    }
    if (transition.kind === "PROCESSING") {
      const processingSession = await getInventoryImportSession(
        deps.db,
        String(actor.numericUserId),
      );
      if (
        processingSession?.status === "COMMITTED" &&
        processingSession.selectedVariantId === transition.row.variant_id
      ) {
        if (transition.row.input_vault_ref) {
          await deleteAssetVaultRef(deps.db, deps.vault, transition.row.input_vault_ref, {
            correlationId: `google-sheets-inventory-reconcile:${transition.row.id}`,
            reason: "Google Sheets inventory commit reconciliation",
          });
        }
        await sql`
          update google_sheets_inventory_intake_challenge
          set status = 'CONSUMED', input_vault_ref = null, consumed_at = now()
          where id = ${transition.row.id} and status = 'PROCESSING'
        `.execute(deps.db);
        return reply.send({
          ok: true,
          reused: true,
          summary: {
            imported: 0,
            duplicates: transition.row.preview_duplicates,
            invalid: transition.row.preview_invalid,
          },
        });
      }
      if (
        processingSession?.status !== "READY" ||
        processingSession.inputVaultRef !== transition.row.input_vault_ref
      ) {
        return reply.code(409).send({ ok: false, code: "BUSY" });
      }
      await sql`
        update google_sheets_inventory_intake_challenge
        set status = 'PREVIEWED'
        where id = ${transition.row.id} and status = 'PROCESSING'
      `.execute(deps.db);
    }
    if (transition.kind === "CONSUMED") {
      return reply.send({
        ok: true,
        reused: true,
        summary: {
          imported: 0,
          duplicates: transition.row.preview_duplicates,
          invalid: transition.row.preview_invalid,
        },
      });
    }

    const { row } = transition;
    const currentSession = await getInventoryImportSession(deps.db, String(actor.numericUserId));
    if (!currentSession || currentSession.inputVaultRef !== row.input_vault_ref) {
      await sql`
        update google_sheets_inventory_intake_challenge
        set status = 'EXPIRED'
        where id = ${row.id} and status = 'PROCESSING'
      `.execute(deps.db);
      if (row.input_vault_ref) {
        await deleteAssetVaultRef(deps.db, deps.vault, row.input_vault_ref, {
          correlationId: `google-sheets-inventory-mismatch:${row.id}`,
          reason: "Google Sheets inventory session changed before confirmation",
        });
      }
      await sql`
        update google_sheets_inventory_intake_challenge
        set input_vault_ref = null
        where id = ${row.id} and status = 'EXPIRED'
      `.execute(deps.db);
      return reply.code(409).send({ ok: false, code: "EXPIRED" });
    }
    const correlationId = `google-sheets-inventory-confirm:${row.id}`;
    try {
      const confirmed = await confirmInventoryImportSession(deps.db, deps.vault, {
        actor,
        config: deps.rootConfig,
        correlationId,
        ...(row.input_vault_ref ? { expectedInputVaultRef: row.input_vault_ref } : {}),
        assetMetadata: {
          sourceType: "GOOGLE_SHEETS",
          ...(row.cost_price_vnd !== null ? { costPriceVnd: Number(row.cost_price_vnd) } : {}),
          ...(row.safe_note ? { safeNote: row.safe_note } : {}),
        },
      });
      if (!confirmed.ok) {
        await sql`
          update google_sheets_inventory_intake_challenge
          set status = 'PREVIEWED'
          where id = ${row.id} and status = 'PROCESSING'
        `.execute(deps.db);
        return reply.code(errorStatus(confirmed.code)).send(confirmed);
      }
      await sql`
        update google_sheets_inventory_intake_challenge
        set status = 'CONSUMED', input_vault_ref = null, consumed_at = now()
        where id = ${row.id} and status = 'PROCESSING'
      `.execute(deps.db);
      return reply.send({ ok: true, reused: confirmed.reused, summary: confirmed.summary });
    } catch {
      await sql`
        update google_sheets_inventory_intake_challenge
        set status = 'PREVIEWED'
        where id = ${row.id} and status = 'PROCESSING'
      `.execute(deps.db);
      return reply.code(500).send({ ok: false, code: "INTAKE_UNAVAILABLE" });
    }
  });
}
