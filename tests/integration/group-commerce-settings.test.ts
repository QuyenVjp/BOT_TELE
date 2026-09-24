import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { withTransaction } from "../../src/infrastructure/db/transaction.js";
import { disableGroupPublicationInTransaction } from "../../src/modules/marketing/group-commerce-settings.js";
import { startPostgresContainer, type PgTestContext } from "../helpers/pg-container.js";

let ctx: PgTestContext;

beforeAll(async () => {
  ctx = await startPostgresContainer();
}, 180_000);

afterAll(async () => {
  await ctx?.teardown();
});

beforeEach(async () => {
  await sql`truncate table group_commerce_settings, audit_event cascade`.execute(ctx.db);
  await sql`
    insert into group_commerce_settings (id)
    values ('main')
  `.execute(ctx.db);
});

async function updatedAt(): Promise<string> {
  const result = await sql<{ updated_at: string }>`
    select updated_at::text
    from group_commerce_settings
    where id = 'main'
  `.execute(ctx.db);
  return result.rows[0]!.updated_at;
}

describe("group publication owner control", () => {
  it("turns every group publication switch off and records a redacted audit", async () => {
    const result = await withTransaction(ctx.db, async (trx) =>
      disableGroupPublicationInTransaction(trx, {
        expectedUpdatedAt: await updatedAt(),
        actorId: "123456789",
        reason: "Owner policy: group posting stays off.",
        correlationId: "group-publication-test",
      }),
    );
    expect(result).toEqual({ ok: true, alreadyApplied: false });
    const state = await sql<{
      shop_panel_enabled: boolean;
      welcome_enabled: boolean;
      restock_publishing_enabled: boolean;
      social_proof_mode: string;
      updated_by: string;
    }>`
      select shop_panel_enabled, welcome_enabled, restock_publishing_enabled,
        social_proof_mode, updated_by
      from group_commerce_settings
      where id = 'main'
    `.execute(ctx.db);
    expect(state.rows[0]).toEqual({
      shop_panel_enabled: false,
      welcome_enabled: false,
      restock_publishing_enabled: false,
      social_proof_mode: "OFF",
      updated_by: "123456789",
    });

    const audit = await sql<{ action: string; metadata_redacted: Record<string, unknown> }>`
      select action, metadata_redacted
      from audit_event
      where action = 'group.publication.disabled'
    `.execute(ctx.db);
    expect(audit.rows[0]?.action).toBe("group.publication.disabled");
    expect(audit.rows[0]?.metadata_redacted).toMatchObject({
      shopPanelEnabled: false,
      welcomeEnabled: false,
      restockPublishingEnabled: false,
      socialProofMode: "OFF",
      alreadyApplied: false,
    });
  });

  it("refuses a stale owner confirmation without changing settings", async () => {
    const stale = await updatedAt();
    await sql`
      update group_commerce_settings
      set updated_at = updated_at + interval '1 second'
      where id = 'main'
    `.execute(ctx.db);

    const result = await withTransaction(ctx.db, (trx) =>
      disableGroupPublicationInTransaction(trx, {
        expectedUpdatedAt: stale,
        actorId: "123456789",
        reason: "Owner policy: group posting stays off.",
        correlationId: "group-publication-stale-test",
      }),
    );

    expect(result).toMatchObject({ ok: false, code: "STALE" });
    const state = await sql<{
      shop_panel_enabled: boolean;
      welcome_enabled: boolean;
      restock_publishing_enabled: boolean;
      social_proof_mode: string;
    }>`
      select shop_panel_enabled, welcome_enabled, restock_publishing_enabled,
        social_proof_mode
      from group_commerce_settings
      where id = 'main'
    `.execute(ctx.db);
    expect(state.rows[0]).toEqual({
      shop_panel_enabled: true,
      welcome_enabled: true,
      restock_publishing_enabled: true,
      social_proof_mode: "INDIVIDUAL",
    });
  });
});
