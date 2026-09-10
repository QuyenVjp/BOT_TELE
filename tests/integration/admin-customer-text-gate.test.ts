import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { newId } from "../../src/shared/ids/index.js";
import { handleAdminCustomerFreeText, presentAdminCustomerSearchPrompt } from "../../src/worker.js";
import { startPostgresContainer, type PgTestContext } from "../helpers/pg-container.js";

/**
 * The owner's free text used to reach the customer list unconditionally. That made the product search
 * and the broadcast compose unreachable for the owner, because this handler is consulted before
 * either of them in the dispatcher's text chain. It is now gated on the one-shot search prompt.
 */

const ADMIN_ID = "6659186592";

let ctx: PgTestContext;

beforeAll(async () => {
  ctx = await startPostgresContainer();
}, 180_000);

afterAll(async () => {
  await ctx?.teardown();
});

beforeEach(async () => {
  await sql`delete from admin_callback_state`.execute(ctx.db);
  await sql`delete from admin_customer_message_draft`.execute(ctx.db);
  await sql`delete from customer_search_prompt`.execute(ctx.db);
});

const call = (text: string) =>
  handleAdminCustomerFreeText(ctx.db, {
    adminTelegramUserId: ADMIN_ID,
    text,
    actorId: ADMIN_ID,
    correlationId: "test-correlation",
  });

describe("handleAdminCustomerFreeText", () => {
  it("returns null without a pending prompt, so the rest of the chain can run", async () => {
    // This is the fix: the dispatcher tries the catalog search and the broadcast/import handlers
    // after this one, and they only ever saw text because this returned a screen for everything.
    await expect(call("claude")).resolves.toBeNull();
  });

  it("serves the customer list while the search prompt is live, and consumes it", async () => {
    await sql`
      insert into admin_callback_state (id, admin_telegram_user_id, kind, payload_redacted, expires_at)
      values (${newId()}, ${ADMIN_ID}, 'CUSTOMER_SEARCH_PROMPT', '{}'::jsonb, now() + interval '10 minutes')
    `.execute(ctx.db);

    const message = await call("ORD-TEST");
    expect(message).not.toBeNull();

    const left = await sql<{ n: string }>`
      select count(*)::text as n from admin_callback_state
      where admin_telegram_user_id = ${ADMIN_ID} and kind = 'CUSTOMER_SEARCH_PROMPT'
    `.execute(ctx.db);
    expect(left.rows[0]?.n).toBe("0");

    // One-shot: the next line is no longer a query.
    await expect(call("claude")).resolves.toBeNull();
  });

  it("drives the CRM prompt end to end: admission row, live state, and the list", async () => {
    // The prompt once wrote only the callback state, so a typed query was dropped before dispatch and
    // this handler was never reached; a later version deleted the state it had just created, which made
    // the search fall through to the catalog. This walks the whole path so neither can return.
    await presentAdminCustomerSearchPrompt(ctx.db, ADMIN_ID);

    const armed = await sql<{ n: string }>`
      select count(*)::text as n from customer_search_prompt
      where chat_id = ${ADMIN_ID} and expires_at > now()
    `.execute(ctx.db);
    expect(armed.rows[0]?.n).toBe("1");

    await expect(call("Chính")).resolves.not.toBeNull();
  });

  it("shows the prompt itself with an instruction, never the raw state id", async () => {
    const prompt = await presentAdminCustomerSearchPrompt(ctx.db, ADMIN_ID);

    expect(prompt.text).toContain("Nhập");
    expect(prompt.text).not.toMatch(/[0-9A-HJKMNP-TV-Z]{26}/u);
  });

  it("ignores an expired prompt", async () => {
    await sql`
      insert into admin_callback_state (id, admin_telegram_user_id, kind, payload_redacted, expires_at)
      values (${newId()}, ${ADMIN_ID}, 'CUSTOMER_SEARCH_PROMPT', '{}'::jsonb, now() - interval '1 minute')
    `.execute(ctx.db);

    await expect(call("claude")).resolves.toBeNull();
  });
});
