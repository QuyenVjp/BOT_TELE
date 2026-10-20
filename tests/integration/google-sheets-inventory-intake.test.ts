import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import Fastify from "fastify";
import { sql } from "kysely";
import { createInMemoryVault } from "../../src/infrastructure/vault/testing-adapter.js";
import type { Vault } from "../../src/infrastructure/vault/port.js";
import { createGoogleSheetsOwnerVerifier } from "../../src/infrastructure/google-sheets/owner-verifier.js";
import {
  expireGoogleSheetsInventoryChallenges,
  registerGoogleSheetsInventoryIntake,
} from "../../src/modules/google-sheets/inventory-intake.js";
import {
  stageInventoryImportInput,
  startInventoryImportSession,
} from "../../src/modules/digital-goods/inventory-import-session.js";
import { newId } from "../../src/shared/ids/index.js";
import {
  dockerAvailable,
  startPostgresContainer,
  type PgTestContext,
} from "../helpers/pg-container.js";

let ctx: PgTestContext;
const ROOT_ID = 987654321;
const SPREADSHEET_ID = "sheet-intake-test";
const rootConfig = { adminTelegramUserId: ROOT_ID, expectedUsername: "Quyenvjp" };
const hasDocker = await dockerAvailable();

beforeAll(async () => {
  ctx = await startPostgresContainer();
}, 180_000);

afterAll(async () => {
  await ctx?.teardown();
});

beforeEach(async () => {
  await sql`
    truncate table google_sheets_inventory_intake_challenge, admin_inventory_import,
      audit_event, google_sheets_asset_metadata, digital_asset, product_variant, product, category cascade
  `.execute(ctx.db);
});

async function createIntakeApp(vault: Vault = createInMemoryVault()) {
  const app = Fastify({ logger: false, bodyLimit: 70_000 });
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_request, body, done) => {
    done(null, body);
  });
  const verifier = createGoogleSheetsOwnerVerifier({
    ownerEmail: "owner@example.test",
    audience: "apps-script-client",
    spreadsheetId: SPREADSHEET_ID,
    verifyIdToken: async (token) =>
      token === "owner-token"
        ? {
            sub: "owner-subject",
            email: "owner@example.test",
            email_verified: true,
            iss: "https://accounts.google.com",
            aud: "apps-script-client",
          }
        : null,
  });
  await registerGoogleSheetsInventoryIntake(app, {
    db: ctx.db,
    vault,
    rootConfig,
    spreadsheetId: SPREADSHEET_ID,
    ownerVerifier: verifier,
  });
  await app.ready();
  return app;
}

function createControlledVault(): {
  vault: Vault;
  failOnWrite(writeNumber: number): void;
  blockOnWrite(writeNumber: number): Promise<void>;
  releaseWrite(): void;
} {
  const backing = createInMemoryVault();
  let writeCount = 0;
  let failAt: number | null = null;
  let blockAt: number | null = null;
  let writeStartedResolve: (() => void) | null = null;
  let release: (() => void) | null = null;
  let blocked: Promise<void> | null = null;
  const vault: Vault = {
    async write(material, options) {
      writeCount += 1;
      if (writeCount === blockAt && blocked) {
        writeStartedResolve?.();
        await blocked;
      }
      if (writeCount === failAt) throw new Error("synthetic interruption");
      return backing.write(material, options);
    },
    reveal: (ref) => backing.reveal(ref),
    delete: (ref) => backing.delete(ref),
  };
  return {
    vault,
    failOnWrite(writeNumber) {
      failAt = writeNumber;
    },
    blockOnWrite(writeNumber) {
      blockAt = writeNumber;
      blocked = new Promise<void>((resolve) => {
        release = resolve;
      });
      return new Promise<void>((resolve) => {
        writeStartedResolve = resolve;
      });
    },
    releaseWrite() {
      release?.();
      release = null;
      blockAt = null;
      blocked = null;
    },
  };
}

async function seedVariant() {
  const categoryId = newId();
  const productId = newId();
  const variantId = newId();
  await sql`
    insert into category (id, name_vi, slug, is_active, sort_order)
    values (${categoryId}, 'Test', ${`test-${categoryId}`}, true, 1)
  `.execute(ctx.db);
  await sql`
    insert into product (id, category_id, name_vi, slug, is_active, sort_order)
    values (${productId}, ${categoryId}, 'Test product', ${`test-${productId}`}, true, 1)
  `.execute(ctx.db);
  await sql`
    insert into product_variant
      (id, product_id, sku, name_vi, price_vnd, duration_code, delivery_type,
       stock_policy, fulfillment_type, inventory_fields, is_active, sort_order)
    values
      (${variantId}, ${productId}, 'SHEET-TEST', 'Test account', 100000, 'P1M', 'CREDENTIAL',
       'LOCAL_ONLY', 'STOCK_ACCOUNT',
       ${JSON.stringify([
         { name: "email", label: "Email", required: true, secret: false, customerVisible: true },
         {
           name: "password",
           label: "Password",
           required: true,
           secret: true,
           customerVisible: false,
         },
       ])}::jsonb,
       true, 1)
  `.execute(ctx.db);
  return variantId;
}

describe.skipIf(!hasDocker)("Google Sheets inventory intake", () => {
  it("rejects a secret-shaped safe note before any challenge persistence", async () => {
    const variantId = await seedVariant();
    const app = await createIntakeApp();
    try {
      const response = await app.inject({
        method: "POST",
        url: "/ops/google-sheets/inventory-intake/preview",
        headers: {
          authorization: "Bearer owner-token",
          "content-type": "application/json",
        },
        payload: JSON.stringify({
          spreadsheetId: SPREADSHEET_ID,
          variantId,
          input: `sheet-fixture-${variantId}@example.invalid:${["fixture", "safe-note", variantId].join("-")}`,
          safeNote: [["pass", "word"].join(""), ["fixture", "note"].join("-")].join("="),
        }),
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ ok: false, code: "INVALID_INPUT" });
      const persisted = await sql<{ challenges: string; sessions: string; metadata: string }>`
        select
          (select count(*)::text from google_sheets_inventory_intake_challenge) as challenges,
          (select count(*)::text from admin_inventory_import) as sessions,
          (select count(*)::text from google_sheets_asset_metadata) as metadata
      `.execute(ctx.db);
      expect(persisted.rows[0]).toEqual({ challenges: "0", sessions: "0", metadata: "0" });
    } finally {
      await app.close();
    }
  });
  it("previews, commits once, and replays confirm without a second asset", async () => {
    const variantId = await seedVariant();
    const app = await createIntakeApp();
    try {
      const headers = {
        authorization: "Bearer owner-token",
        "content-type": "application/json",
      };
      const catalog = await app.inject({
        method: "POST",
        url: "/ops/google-sheets/inventory-intake/catalog",
        headers,
        payload: JSON.stringify({ spreadsheetId: SPREADSHEET_ID }),
      });
      expect(catalog.statusCode).toBe(200);
      expect(catalog.json().variants).toEqual(
        expect.arrayContaining([expect.objectContaining({ variantId, sku: "SHEET-TEST" })]),
      );

      const fixtureInput = `sheet-fixture-${variantId}@example.invalid:${["fixture", "credential", variantId].join("-")}`;
      const preview = await app.inject({
        method: "POST",
        url: "/ops/google-sheets/inventory-intake/preview",
        headers,
        payload: JSON.stringify({
          spreadsheetId: SPREADSHEET_ID,
          variantId,
          input: fixtureInput,
        }),
      });
      expect(preview.statusCode).toBe(200);
      const previewBody = preview.json();
      expect(previewBody.preview).toMatchObject({ ready: 1, invalid: 0, duplicates: 0 });
      expect(previewBody.challenge).toMatch(/^[A-Za-z0-9_-]{32,}$/);

      const challengeRow = await sql<{ input_vault_ref: string | null; raw_match: boolean }>`
        select input_vault_ref,
          (${fixtureInput} = coalesce(input_vault_ref, '')) as raw_match
        from google_sheets_inventory_intake_challenge
        limit 1
      `.execute(ctx.db);
      expect(challengeRow.rows[0]?.input_vault_ref).toMatch(/^vault:/);
      expect(challengeRow.rows[0]?.raw_match).toBe(false);

      const confirm = await app.inject({
        method: "POST",
        url: "/ops/google-sheets/inventory-intake/confirm",
        headers,
        payload: JSON.stringify({
          spreadsheetId: SPREADSHEET_ID,
          challenge: previewBody.challenge,
        }),
      });
      expect(confirm.statusCode).toBe(200);
      expect(confirm.json()).toMatchObject({ ok: true, summary: { imported: 1 } });

      const replay = await app.inject({
        method: "POST",
        url: "/ops/google-sheets/inventory-intake/confirm",
        headers,
        payload: JSON.stringify({
          spreadsheetId: SPREADSHEET_ID,
          challenge: previewBody.challenge,
        }),
      });
      expect(replay.statusCode).toBe(200);
      expect(replay.json()).toMatchObject({ ok: true, reused: true });

      const stock = await sql<{ count: string }>`
        select count(*)::text from digital_asset where variant_id = ${variantId} and status = 'AVAILABLE'
      `.execute(ctx.db);
      expect(stock.rows[0]?.count).toBe("1");
      const stored = await sql<{ challenge_status: string; input_vault_ref: string | null }>`
        select status as challenge_status, input_vault_ref
        from google_sheets_inventory_intake_challenge
        limit 1
      `.execute(ctx.db);
      expect(stored.rows[0]).toEqual({ challenge_status: "CONSUMED", input_vault_ref: null });
    } finally {
      await app.close();
    }
  });

  it("binds each superseding preview challenge to its own staged Vault input", async () => {
    const variantId = await seedVariant();
    const vault = createInMemoryVault();
    const app = await createIntakeApp(vault);
    const headers = {
      authorization: "Bearer owner-token",
      "content-type": "application/json",
    };
    try {
      const firstInput = `first-${variantId}@example.invalid:${["fixture", "first", variantId].join("-")}`;
      const first = await app.inject({
        method: "POST",
        url: "/ops/google-sheets/inventory-intake/preview",
        headers,
        payload: JSON.stringify({ spreadsheetId: SPREADSHEET_ID, variantId, input: firstInput }),
      });
      expect(first.statusCode).toBe(200);
      const firstRow = await sql<{ input_vault_ref: string | null }>`
        select input_vault_ref
        from google_sheets_inventory_intake_challenge
        order by created_at desc, id desc
        limit 1
      `.execute(ctx.db);
      const firstRef = firstRow.rows[0]?.input_vault_ref;
      expect(firstRef).toMatch(/^vault:/);
      await expect(vault.reveal(firstRef!)).resolves.toContain(`${variantId},first-${variantId}`);

      const secondInput = `second-${variantId}@example.invalid:${["fixture", "second", variantId].join("-")}`;
      const second = await app.inject({
        method: "POST",
        url: "/ops/google-sheets/inventory-intake/preview",
        headers,
        payload: JSON.stringify({ spreadsheetId: SPREADSHEET_ID, variantId, input: secondInput }),
      });
      expect(second.statusCode).toBe(200);
      const secondRow = await sql<{
        status: string;
        input_vault_ref: string | null;
      }>`
        select status, input_vault_ref
        from google_sheets_inventory_intake_challenge
        order by created_at desc, id desc
        limit 1
      `.execute(ctx.db);
      const secondRef = secondRow.rows[0]?.input_vault_ref;
      expect(secondRef).toMatch(/^vault:/);
      expect(secondRef).not.toBe(firstRef);
      await expect(vault.reveal(secondRef!)).resolves.toContain(`${variantId},second-${variantId}`);
      const superseded = await sql<{ status: string; input_vault_ref: string | null }>`
        select status, input_vault_ref
        from google_sheets_inventory_intake_challenge
        order by created_at asc, id asc
        limit 1
      `.execute(ctx.db);
      expect(superseded.rows[0]).toEqual({ status: "EXPIRED", input_vault_ref: null });
    } finally {
      await app.close();
    }
  });

  it("fails closed when a superseding preview wins while the first is staging", async () => {
    const variantId = await seedVariant();
    const controlled = createControlledVault();
    const app = await createIntakeApp(controlled.vault);
    const headers = {
      authorization: "Bearer owner-token",
      "content-type": "application/json",
    };
    try {
      const firstInput = `first-race-${variantId}@example.invalid:${["fixture", "race", "first", variantId].join("-")}`;
      const secondInput = `second-race-${variantId}@example.invalid:${["fixture", "race", "second", variantId].join("-")}`;
      const firstWriteStarted = controlled.blockOnWrite(1);
      const firstPreview = app.inject({
        method: "POST",
        url: "/ops/google-sheets/inventory-intake/preview",
        headers,
        payload: JSON.stringify({ spreadsheetId: SPREADSHEET_ID, variantId, input: firstInput }),
      });
      await firstWriteStarted;

      const secondPreview = await app.inject({
        method: "POST",
        url: "/ops/google-sheets/inventory-intake/preview",
        headers,
        payload: JSON.stringify({ spreadsheetId: SPREADSHEET_ID, variantId, input: secondInput }),
      });
      expect(secondPreview.statusCode).toBe(200);

      controlled.releaseWrite();
      const first = await firstPreview;
      expect(first.statusCode).toBe(404);

      const challenge = await sql<{ input_vault_ref: string }>`
        select input_vault_ref
        from google_sheets_inventory_intake_challenge
        where status = 'PREVIEWED'
        limit 1
      `.execute(ctx.db);
      expect(challenge.rows).toHaveLength(1);
      await expect(controlled.vault.reveal(challenge.rows[0]!.input_vault_ref)).resolves.toContain(
        `${variantId},second-race-${variantId}`,
      );
      const session = await sql<{ input_vault_ref: string | null }>`
        select input_vault_ref
        from admin_inventory_import
        where admin_telegram_user_id = ${String(ROOT_ID)}
      `.execute(ctx.db);
      expect(session.rows[0]?.input_vault_ref).toBe(challenge.rows[0]!.input_vault_ref);
    } finally {
      controlled.releaseWrite();
      await app.close();
    }
  });

  it("rejects a second import of the same credential during preview", async () => {
    const variantId = await seedVariant();
    const app = await createIntakeApp();
    try {
      const headers = {
        authorization: "Bearer owner-token",
        "content-type": "application/json",
      };
      const fixtureInput = `sheet-fixture-${variantId}@example.invalid:${["fixture", "duplicate", variantId].join("-")}`;
      const first = await app.inject({
        method: "POST",
        url: "/ops/google-sheets/inventory-intake/preview",
        headers,
        payload: JSON.stringify({
          spreadsheetId: SPREADSHEET_ID,
          variantId,
          input: fixtureInput,
        }),
      });
      expect(first.statusCode).toBe(200);
      const firstBody = first.json();
      await app.inject({
        method: "POST",
        url: "/ops/google-sheets/inventory-intake/confirm",
        headers,
        payload: JSON.stringify({ spreadsheetId: SPREADSHEET_ID, challenge: firstBody.challenge }),
      });
      const duplicate = await app.inject({
        method: "POST",
        url: "/ops/google-sheets/inventory-intake/preview",
        headers,
        payload: JSON.stringify({
          spreadsheetId: SPREADSHEET_ID,
          variantId,
          input: fixtureInput,
        }),
      });
      expect(duplicate.statusCode).toBe(422);
      expect(duplicate.json()).toMatchObject({ ok: false, code: "NO_NEW_STOCK" });
    } finally {
      await app.close();
    }
  });

  it("resumes a partially committed batch after a simulated process restart", async () => {
    const variantId = await seedVariant();
    const controlled = createControlledVault();
    const app = await createIntakeApp(controlled.vault);
    const headers = {
      authorization: "Bearer owner-token",
      "content-type": "application/json",
    };
    const input = [
      `first-${variantId}@example.invalid:${["fixture", "recovery", "first", variantId].join("-")}`,
      `second-${variantId}@example.invalid:${["fixture", "recovery", "second", variantId].join("-")}`,
    ].join("\n");
    let preservedSecret = "";
    let challenge = "";
    try {
      const preview = await app.inject({
        method: "POST",
        url: "/ops/google-sheets/inventory-intake/preview",
        headers,
        payload: JSON.stringify({ spreadsheetId: SPREADSHEET_ID, variantId, input }),
      });
      expect(preview.statusCode).toBe(200);
      challenge = preview.json().challenge;
      controlled.failOnWrite(3);
      const interrupted = await app.inject({
        method: "POST",
        url: "/ops/google-sheets/inventory-intake/confirm",
        headers,
        payload: JSON.stringify({ spreadsheetId: SPREADSHEET_ID, challenge }),
      });
      expect(interrupted.statusCode).toBe(500);
      const partial = await sql<{
        assets: string;
        session_status: string;
        challenge_status: string;
      }>`
        select
          (select count(*)::text from digital_asset where variant_id = ${variantId}) as assets,
          (select status from admin_inventory_import where admin_telegram_user_id = ${String(ROOT_ID)}) as session_status,
          (select status from google_sheets_inventory_intake_challenge) as challenge_status
      `.execute(ctx.db);
      expect(partial.rows[0]).toEqual({
        assets: "1",
        session_status: "PROCESSING",
        challenge_status: "PROCESSING",
      });
      const partialAsset = await sql<{ vault_ref: string }>`
        select vault_ref
        from digital_asset
        where variant_id = ${variantId}
        order by masked_login, vault_ref
        limit 1
      `.execute(ctx.db);
      preservedSecret = await controlled.vault.reveal(partialAsset.rows[0]!.vault_ref);
      controlled.failOnWrite(Number.MAX_SAFE_INTEGER);
      await app.close();
    } catch (error) {
      await app.close();
      throw error;
    }

    const restarted = await createIntakeApp(controlled.vault);
    try {
      const retry = await restarted.inject({
        method: "POST",
        url: "/ops/google-sheets/inventory-intake/confirm",
        headers,
        payload: JSON.stringify({ spreadsheetId: SPREADSHEET_ID, challenge }),
      });
      expect(retry.statusCode).toBe(200);
      expect(retry.json()).toMatchObject({
        ok: true,
        summary: { imported: 1, duplicates: 1, invalid: 0 },
      });
      const final = await sql<{
        assets: string;
        audits: string;
        challenge_status: string;
        session_status: string;
      }>`
        select
          (select count(*)::text from digital_asset where variant_id = ${variantId}) as assets,
          (select count(*)::text from audit_event where action = 'inventory.import') as audits,
          (select status from google_sheets_inventory_intake_challenge) as challenge_status,
          (select status from admin_inventory_import where admin_telegram_user_id = ${String(ROOT_ID)}) as session_status
      `.execute(ctx.db);
      expect(final.rows[0]).toEqual({
        assets: "2",
        audits: "1",
        challenge_status: "CONSUMED",
        session_status: "COMMITTED",
      });
      const assets = await sql<{ vault_ref: string; masked_login: string }>`
        select vault_ref, masked_login
        from digital_asset
        where variant_id = ${variantId}
        order by masked_login, vault_ref
      `.execute(ctx.db);
      expect(assets.rows).toHaveLength(2);
      await expect(controlled.vault.reveal(assets.rows[0]!.vault_ref)).resolves.toBe(
        preservedSecret,
      );
    } finally {
      await restarted.close();
    }
  });

  it("returns BUSY for a concurrent confirm without resetting the processing challenge", async () => {
    const variantId = await seedVariant();
    const controlled = createControlledVault();
    const app = await createIntakeApp(controlled.vault);
    const headers = {
      authorization: "Bearer owner-token",
      "content-type": "application/json",
    };
    try {
      const preview = await app.inject({
        method: "POST",
        url: "/ops/google-sheets/inventory-intake/preview",
        headers,
        payload: JSON.stringify({
          spreadsheetId: SPREADSHEET_ID,
          variantId,
          input: `concurrent-${variantId}@example.invalid:${["fixture", "concurrent", variantId].join("-")}`,
        }),
      });
      expect(preview.statusCode).toBe(200);
      const challenge = preview.json().challenge;
      const writeStarted = controlled.blockOnWrite(2);
      const firstConfirm = app.inject({
        method: "POST",
        url: "/ops/google-sheets/inventory-intake/confirm",
        headers,
        payload: JSON.stringify({ spreadsheetId: SPREADSHEET_ID, challenge }),
      });
      await writeStarted;
      const concurrent = await app.inject({
        method: "POST",
        url: "/ops/google-sheets/inventory-intake/confirm",
        headers,
        payload: JSON.stringify({ spreadsheetId: SPREADSHEET_ID, challenge }),
      });
      expect(concurrent.statusCode).toBe(409);
      expect(concurrent.json()).toEqual({ ok: false, code: "BUSY" });
      const processing = await sql<{ status: string }>`
        select status from google_sheets_inventory_intake_challenge
      `.execute(ctx.db);
      expect(processing.rows[0]?.status).toBe("PROCESSING");
      controlled.releaseWrite();
      const completed = await firstConfirm;
      expect(completed.statusCode).toBe(200);
      const result = await sql<{ assets: string; audits: string }>`
        select
          (select count(*)::text from digital_asset where variant_id = ${variantId}) as assets,
          (select count(*)::text from audit_event where action = 'inventory.import') as audits
      `.execute(ctx.db);
      expect(result.rows[0]).toEqual({ assets: "1", audits: "1" });
    } finally {
      controlled.releaseWrite();
      await app.close();
    }
  });

  it("reconciles a committed session after challenge processing was interrupted", async () => {
    const variantId = await seedVariant();
    const app = await createIntakeApp();
    try {
      const headers = {
        authorization: "Bearer owner-token",
        "content-type": "application/json",
      };
      const preview = await app.inject({
        method: "POST",
        url: "/ops/google-sheets/inventory-intake/preview",
        headers,
        payload: JSON.stringify({
          spreadsheetId: SPREADSHEET_ID,
          variantId,
          input: `sheet-fixture-${variantId}@example.invalid:fixture-recovery-${variantId}`,
        }),
      });
      expect(preview.statusCode).toBe(200);
      const body = preview.json();
      await sql`
        update admin_inventory_import
        set status = 'COMMITTED'
        where admin_telegram_user_id = ${String(ROOT_ID)}
      `.execute(ctx.db);
      await sql`
        update google_sheets_inventory_intake_challenge
        set status = 'PROCESSING'
        where spreadsheet_id = ${SPREADSHEET_ID}
      `.execute(ctx.db);

      const confirm = await app.inject({
        method: "POST",
        url: "/ops/google-sheets/inventory-intake/confirm",
        headers,
        payload: JSON.stringify({ spreadsheetId: SPREADSHEET_ID, challenge: body.challenge }),
      });
      expect(confirm.statusCode).toBe(200);
      expect(confirm.json()).toMatchObject({ ok: true, reused: true });
      const challenge = await sql<{ status: string; input_vault_ref: string | null }>`
        select status, input_vault_ref
        from google_sheets_inventory_intake_challenge
        limit 1
      `.execute(ctx.db);
      expect(challenge.rows[0]).toEqual({ status: "CONSUMED", input_vault_ref: null });
    } finally {
      await app.close();
    }
  });

  it("expires the challenge before commit and leaves no AVAILABLE asset", async () => {
    const variantId = await seedVariant();
    const app = await createIntakeApp();
    try {
      const headers = {
        authorization: "Bearer owner-token",
        "content-type": "application/json",
      };
      const fixtureInput = `sheet-fixture-${variantId}@example.invalid:${["fixture", "expiry", variantId].join("-")}`;
      const preview = await app.inject({
        method: "POST",
        url: "/ops/google-sheets/inventory-intake/preview",
        headers,
        payload: JSON.stringify({
          spreadsheetId: SPREADSHEET_ID,
          variantId,
          input: fixtureInput,
        }),
      });
      expect(preview.statusCode).toBe(200);
      const body = preview.json();
      await sql`
        update google_sheets_inventory_intake_challenge
        set expires_at = now() - interval '1 second'
      `.execute(ctx.db);

      const confirm = await app.inject({
        method: "POST",
        url: "/ops/google-sheets/inventory-intake/confirm",
        headers,
        payload: JSON.stringify({ spreadsheetId: SPREADSHEET_ID, challenge: body.challenge }),
      });
      expect(confirm.statusCode).toBe(409);
      expect(confirm.json()).toMatchObject({ ok: false, code: "EXPIRED" });
      const stock = await sql<{ count: string }>`
        select count(*)::text from digital_asset where variant_id = ${variantId}
      `.execute(ctx.db);
      expect(stock.rows[0]?.count).toBe("0");
    } finally {
      await app.close();
    }
  });
  it("discards malformed inventory rows without creating assets or retaining staged Vault material", async () => {
    const variantId = await seedVariant();
    const backing = createInMemoryVault();
    let stagedRef: string | null = null;
    const vault: Vault = {
      async write(material, options) {
        const ref = await backing.write(material, options);
        stagedRef = ref;
        return ref;
      },
      reveal: (ref) => backing.reveal(ref),
      delete: (ref) => backing.delete(ref),
    };
    const app = await createIntakeApp(vault);
    try {
      const response = await app.inject({
        method: "POST",
        url: "/ops/google-sheets/inventory-intake/preview",
        headers: {
          authorization: "Bearer owner-token",
          "content-type": "application/json",
        },
        payload: JSON.stringify({
          spreadsheetId: SPREADSHEET_ID,
          variantId,
          input: "not-a-valid-row",
        }),
      });
      expect(response.statusCode).toBe(422);
      expect(response.json()).toMatchObject({
        ok: false,
        code: "NO_NEW_STOCK",
        preview: { ready: 0, invalid: 1, duplicates: 0 },
      });

      const persisted = await sql<{
        assets: string;
        metadata: string;
        challenges: string;
        staged: string;
        session_status: string;
      }>`
        select
          (select count(*)::text from digital_asset where variant_id = ${variantId}) as assets,
          (select count(*)::text from google_sheets_asset_metadata) as metadata,
          (select count(*)::text from google_sheets_inventory_intake_challenge) as challenges,
          (select count(*)::text from admin_inventory_import where input_vault_ref is not null) as staged,
          (select status from admin_inventory_import where admin_telegram_user_id = ${String(ROOT_ID)}) as session_status
      `.execute(ctx.db);
      expect(persisted.rows[0]).toEqual({
        assets: "0",
        metadata: "0",
        challenges: "0",
        staged: "0",
        session_status: "CANCELLED",
      });
      expect(stagedRef).toMatch(/^vault:/);
      await expect(vault.reveal(stagedRef!)).rejects.toThrow();
    } finally {
      await app.close();
    }
  });

  it("scopes identical staged content to a fresh session generation", async () => {
    const variantId = await seedVariant();
    const vault = createInMemoryVault();
    const app = await createIntakeApp(vault);
    const headers = {
      authorization: "Bearer owner-token",
      "content-type": "application/json",
    };
    const input = `same-generation-${variantId}@example.invalid:${["fixture", "same", variantId].join("-")}`;
    try {
      const first = await app.inject({
        method: "POST",
        url: "/ops/google-sheets/inventory-intake/preview",
        headers,
        payload: JSON.stringify({ spreadsheetId: SPREADSHEET_ID, variantId, input }),
      });
      expect(first.statusCode).toBe(200);
      const firstRow = await sql<{
        generation: string;
        input_vault_ref: string;
      }>`
        select generation, input_vault_ref
        from admin_inventory_import
        where admin_telegram_user_id = ${String(ROOT_ID)}
      `.execute(ctx.db);
      const firstRef = firstRow.rows[0]!.input_vault_ref;

      const second = await app.inject({
        method: "POST",
        url: "/ops/google-sheets/inventory-intake/preview",
        headers,
        payload: JSON.stringify({ spreadsheetId: SPREADSHEET_ID, variantId, input }),
      });
      expect(second.statusCode).toBe(200);
      const secondRow = await sql<{ generation: string; input_vault_ref: string }>`
        select generation, input_vault_ref
        from admin_inventory_import
        where admin_telegram_user_id = ${String(ROOT_ID)}
      `.execute(ctx.db);
      expect(secondRow.rows[0]!.generation).not.toBe(firstRow.rows[0]!.generation);
      expect(secondRow.rows[0]!.input_vault_ref).not.toBe(firstRef);
      await expect(vault.reveal(secondRow.rows[0]!.input_vault_ref)).resolves.toContain(
        `${variantId},same-generation-${variantId}`,
      );
    } finally {
      await app.close();
    }
  });

  it("does not orphan a winning ref during concurrent same-generation staging", async () => {
    const variantId = await seedVariant();
    const controlled = createControlledVault();
    const actor = { numericUserId: ROOT_ID, chatType: "private" as const };
    const input = `concurrent-same-generation-${variantId}@example.invalid:${["fixture", "same", variantId].join("-")}`;
    const started = await startInventoryImportSession(ctx.db, {
      actor,
      config: rootConfig,
      correlationId: "google-sheets-generation:concurrent-start",
      variantId,
    });
    expect(started).toMatchObject({ ok: true });
    const writeStarted = controlled.blockOnWrite(1);
    const firstStage = stageInventoryImportInput(ctx.db, controlled.vault, {
      actor,
      config: rootConfig,
      correlationId: "google-sheets-generation:concurrent-first",
      rawInput: input,
    });
    try {
      await writeStarted;
      const second = await stageInventoryImportInput(ctx.db, controlled.vault, {
        actor,
        config: rootConfig,
        correlationId: "google-sheets-generation:concurrent-second",
        rawInput: input,
      });
      if (!second.ok) throw new Error(`expected concurrent winner, got ${second.code}`);
      controlled.releaseWrite();
      await expect(firstStage).resolves.toMatchObject({ ok: false, code: "NOT_FOUND" });
      const current = await sql<{ input_vault_ref: string | null }>`
        select input_vault_ref
        from admin_inventory_import
        where admin_telegram_user_id = ${String(ROOT_ID)}
      `.execute(ctx.db);
      expect(current.rows[0]?.input_vault_ref).toBe(second.inputVaultRef);
      await expect(controlled.vault.reveal(second.inputVaultRef)).resolves.toContain(
        `${variantId},concurrent-same-generation-${variantId}`,
      );
      const orphan = await sql<{ count: string }>`
        select count(*)::text as count
        from inventory_vault_orphan
        where vault_ref = ${second.inputVaultRef}
      `.execute(ctx.db);
      expect(orphan.rows[0]?.count).toBe("0");
    } finally {
      controlled.releaseWrite();
    }
  });

  it("does not bind a slow stage from an older generation to a replacement session", async () => {
    const variantId = await seedVariant();
    const controlled = createControlledVault();
    const actor = { numericUserId: ROOT_ID, chatType: "private" as const };
    const first = await startInventoryImportSession(ctx.db, {
      actor,
      config: rootConfig,
      correlationId: "google-sheets-generation:old-start",
      variantId,
    });
    expect(first).toMatchObject({ ok: true });
    const writeStarted = controlled.blockOnWrite(1);
    const staleStage = stageInventoryImportInput(ctx.db, controlled.vault, {
      actor,
      config: rootConfig,
      correlationId: "google-sheets-generation:old-stage",
      rawInput: `slow-generation-${variantId}@example.invalid:${["fixture", "slow", variantId].join("-")}`,
    });
    try {
      await writeStarted;
      const replacement = await startInventoryImportSession(ctx.db, {
        actor,
        config: rootConfig,
        correlationId: "google-sheets-generation:new-start",
        variantId,
      });
      expect(replacement).toMatchObject({ ok: true });
      controlled.releaseWrite();
      await expect(staleStage).resolves.toMatchObject({ ok: false, code: "NOT_FOUND" });
      const current = await sql<{
        generation: string;
        status: string;
        input_vault_ref: string | null;
      }>`
        select generation, status, input_vault_ref
        from admin_inventory_import
        where admin_telegram_user_id = ${String(ROOT_ID)}
      `.execute(ctx.db);
      expect(current.rows[0]).toEqual({
        generation: replacement.ok ? replacement.session.generation : "",
        status: "WAITING_INPUT",
        input_vault_ref: null,
      });
    } finally {
      controlled.releaseWrite();
    }
  });

  it("does not let stale challenge cleanup cancel a newer same-content preview", async () => {
    const variantId = await seedVariant();
    const vault = createInMemoryVault();
    const app = await createIntakeApp(vault);
    const headers = {
      authorization: "Bearer owner-token",
      "content-type": "application/json",
    };
    const input = `cleanup-generation-${variantId}@example.invalid:${["fixture", "cleanup", variantId].join("-")}`;
    try {
      await app.inject({
        method: "POST",
        url: "/ops/google-sheets/inventory-intake/preview",
        headers,
        payload: JSON.stringify({ spreadsheetId: SPREADSHEET_ID, variantId, input }),
      });
      const secondPreview = await app.inject({
        method: "POST",
        url: "/ops/google-sheets/inventory-intake/preview",
        headers,
        payload: JSON.stringify({ spreadsheetId: SPREADSHEET_ID, variantId, input }),
      });
      expect(secondPreview.statusCode).toBe(200);
      const challenges = await sql<{
        id: string;
        generation: string;
        input_vault_ref: string | null;
      }>`
        select id, generation, input_vault_ref
        from google_sheets_inventory_intake_challenge
        order by created_at, id
      `.execute(ctx.db);
      expect(challenges.rows).toHaveLength(2);
      const old = challenges.rows[0]!;
      const currentRef = challenges.rows[1]!.input_vault_ref;
      await sql`
        update google_sheets_inventory_intake_challenge
        set status = 'EXPIRED', input_vault_ref = ${currentRef}
        where id = ${old.id}
      `.execute(ctx.db);
      await expireGoogleSheetsInventoryChallenges({
        db: ctx.db,
        vault,
        rootConfig,
      });
      const session = await sql<{
        generation: string;
        status: string;
        input_vault_ref: string | null;
      }>`
        select generation, status, input_vault_ref
        from admin_inventory_import
        where admin_telegram_user_id = ${String(ROOT_ID)}
      `.execute(ctx.db);
      expect(session.rows[0]).toMatchObject({
        generation: challenges.rows[1]!.generation,
        status: "READY",
        input_vault_ref: currentRef,
      });
      await expect(vault.reveal(currentRef!)).resolves.toContain(
        `${variantId},cleanup-generation-${variantId}`,
      );
    } finally {
      await app.close();
    }
  });

  it("resumes an expired PROCESSING challenge with an expired READY session", async () => {
    const variantId = await seedVariant();
    const vault = createInMemoryVault();
    const app = await createIntakeApp(vault);
    const headers = {
      authorization: "Bearer owner-token",
      "content-type": "application/json",
    };
    try {
      const preview = await app.inject({
        method: "POST",
        url: "/ops/google-sheets/inventory-intake/preview",
        headers,
        payload: JSON.stringify({
          spreadsheetId: SPREADSHEET_ID,
          variantId,
          input: `expired-ready-${variantId}@example.invalid:${["fixture", "expired", variantId].join("-")}`,
        }),
      });
      expect(preview.statusCode).toBe(200);
      const body = preview.json();
      await sql`
        update google_sheets_inventory_intake_challenge
        set status = 'PROCESSING', expires_at = now() - interval '1 second'
      `.execute(ctx.db);
      await sql`
        update admin_inventory_import
        set status = 'READY', expires_at = now() - interval '1 second'
        where admin_telegram_user_id = ${String(ROOT_ID)}
      `.execute(ctx.db);
      await app.close();
      const restarted = await createIntakeApp(vault);
      try {
        const confirm = await restarted.inject({
          method: "POST",
          url: "/ops/google-sheets/inventory-intake/confirm",
          headers,
          payload: JSON.stringify({ spreadsheetId: SPREADSHEET_ID, challenge: body.challenge }),
        });
        expect(confirm.statusCode).toBe(200);
        expect(confirm.json()).toMatchObject({ ok: true, summary: { imported: 1 } });
      } finally {
        await restarted.close();
      }
    } catch (error) {
      await app.close();
      throw error;
    }
  });

  it("reconciles a committed audit for a processing challenge after the session advances", async () => {
    const variantId = await seedVariant();
    const vault = createInMemoryVault();
    const app = await createIntakeApp(vault);
    const headers = {
      authorization: "Bearer owner-token",
      "content-type": "application/json",
    };
    try {
      const preview = await app.inject({
        method: "POST",
        url: "/ops/google-sheets/inventory-intake/preview",
        headers,
        payload: JSON.stringify({
          spreadsheetId: SPREADSHEET_ID,
          variantId,
          input: `audit-recovery-${variantId}@example.invalid:${["fixture", "audit", variantId].join("-")}`,
        }),
      });
      expect(preview.statusCode).toBe(200);
      const body = preview.json();
      const challenge = await sql<{ id: string; input_vault_ref: string | null }>`
        select id, input_vault_ref
        from google_sheets_inventory_intake_challenge
        limit 1
      `.execute(ctx.db);
      const challengeId = challenge.rows[0]!.id;
      await sql`
        update google_sheets_inventory_intake_challenge
        set status = 'PROCESSING', expires_at = now() - interval '1 second'
      `.execute(ctx.db);
      await sql`
        update admin_inventory_import
        set generation = ${newId()}, status = 'WAITING_INPUT', input_vault_ref = null,
            preview_ready = 0, preview_invalid = 0, preview_duplicates = 0,
            preview_variants = '[]'::jsonb, selected_variant_id = ${variantId},
            expires_at = now() + interval '15 minutes'
        where admin_telegram_user_id = ${String(ROOT_ID)}
      `.execute(ctx.db);
      await sql`
        insert into audit_event
          (id, actor_type, actor_id, action, target_type, target_id, reason,
           correlation_id, metadata_redacted)
        values
          (${newId()}, 'ROOT_ADMIN', ${String(ROOT_ID)}, 'inventory.import',
           'DigitalAsset', ${variantId}, 'test recovery',
           ${`google-sheets-inventory-confirm:${challengeId}`},
           '{"imported":1,"duplicates":0,"invalid":0}'::jsonb)
      `.execute(ctx.db);
      const confirm = await app.inject({
        method: "POST",
        url: "/ops/google-sheets/inventory-intake/confirm",
        headers,
        payload: JSON.stringify({ spreadsheetId: SPREADSHEET_ID, challenge: body.challenge }),
      });
      expect(confirm.statusCode).toBe(200);
      expect(confirm.json()).toMatchObject({
        ok: true,
        reused: true,
        summary: { imported: 1, duplicates: 0, invalid: 0 },
      });
      const state = await sql<{ challenge_status: string; session_status: string }>`
        select
          (select status from google_sheets_inventory_intake_challenge where id = ${challengeId}) as challenge_status,
          (select status from admin_inventory_import where admin_telegram_user_id = ${String(ROOT_ID)}) as session_status
      `.execute(ctx.db);
      expect(state.rows[0]).toEqual({
        challenge_status: "CONSUMED",
        session_status: "WAITING_INPUT",
      });
    } finally {
      await app.close();
    }
  });

  it("rejects a challenge whose bound Telegram actor no longer matches the configured owner", async () => {
    const variantId = await seedVariant();
    const app = await createIntakeApp();
    const headers = {
      authorization: "Bearer owner-token",
      "content-type": "application/json",
    };
    try {
      const preview = await app.inject({
        method: "POST",
        url: "/ops/google-sheets/inventory-intake/preview",
        headers,
        payload: JSON.stringify({
          spreadsheetId: SPREADSHEET_ID,
          variantId,
          input: `actor-binding-${variantId}@example.invalid:${["fixture", "actor", variantId].join("-")}`,
        }),
      });
      expect(preview.statusCode).toBe(200);
      const body = preview.json();
      await sql`
        update google_sheets_inventory_intake_challenge
        set admin_telegram_user_id = ${String(ROOT_ID + 1)}
      `.execute(ctx.db);
      const confirm = await app.inject({
        method: "POST",
        url: "/ops/google-sheets/inventory-intake/confirm",
        headers,
        payload: JSON.stringify({ spreadsheetId: SPREADSHEET_ID, challenge: body.challenge }),
      });
      expect(confirm.statusCode).toBe(401);
      expect(confirm.json()).toEqual({ ok: false, code: "UNAUTHORIZED" });
      const state = await sql<{ challenge_status: string; session_status: string }>`
        select
          (select status from google_sheets_inventory_intake_challenge) as challenge_status,
          (select status from admin_inventory_import where admin_telegram_user_id = ${String(ROOT_ID)}) as session_status
      `.execute(ctx.db);
      expect(state.rows[0]).toEqual({ challenge_status: "PREVIEWED", session_status: "READY" });
    } finally {
      await app.close();
    }
  });
});
