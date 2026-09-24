import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import Fastify from "fastify";
import { sql } from "kysely";
import { createInMemoryVault } from "../../src/infrastructure/vault/testing-adapter.js";
import { createGoogleSheetsOwnerVerifier } from "../../src/infrastructure/google-sheets/owner-verifier.js";
import { registerGoogleSheetsInventoryIntake } from "../../src/modules/google-sheets/inventory-intake.js";
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

async function createIntakeApp() {
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
    vault: createInMemoryVault(),
    rootConfig,
    spreadsheetId: SPREADSHEET_ID,
    ownerVerifier: verifier,
  });
  await app.ready();
  return app;
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
        set status = 'COMMITTED', input_vault_ref = null
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
});
