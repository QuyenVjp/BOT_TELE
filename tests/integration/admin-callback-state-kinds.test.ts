import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "kysely";
import {
  createAdminCallbackState,
  type AdminStateKind,
} from "../../src/modules/admin/customer-operations.js";
import { startPostgresContainer, type PgTestContext } from "../helpers/pg-container.js";

/**
 * Regression guard for admin callback-state kind drift.
 *
 * `AdminStateKind` is the set of kinds the code is allowed to persist. The database
 * CHECK constraint is a second, hand-maintained copy of that set. When the two drift,
 * the affected admin flows die at runtime with SQLSTATE 23514 and the operator only
 * sees a silent no-op. This test drives the real insert path for every kind the type
 * system permits, so drift fails the suite instead of production.
 */

// `satisfies Record<AdminStateKind, true>` makes this object exhaustive: adding a new
// kind to the union without listing it here is a compile error.
const ALL_KINDS = Object.keys({
  CUSTOMER_DETAIL: true,
  CUSTOMER_MESSAGE_PROMPT: true,
  CUSTOMER_SEARCH_PROMPT: true,
  CUSTOMER_PAGE: true,
  ORDER_DETAIL: true,
  ORDER_PAGE: true,
  ORDER_MESSAGE_PROMPT: true,
  MANUAL_TASK_COMPLETE: true,
  FILE_ARTIFACT_IMPORT_CONFIRM: true,
  QUANTITY_STOCK_ADJUST_CONFIRM: true,
  ADMIN_VARIANT_UPDATE: true,
  TEST_CUSTOMER_ADD: true,
  CATEGORY_CREATE: true,
  CATEGORY_RENAME: true,
  WIZARD_CATEGORY_CREATE: true,
  WIZARD_CUSTOM_FIELD: true,
  WIZARD_ADVANCED: true,
  WIZARD_DESC_CUSTOM: true,
} satisfies Record<AdminStateKind, true>) as AdminStateKind[];

let ctx: PgTestContext;

beforeAll(async () => {
  ctx = await startPostgresContainer();
}, 180_000);

afterAll(async () => {
  await ctx?.teardown();
});

describe("admin callback state kinds are persisted by the schema", () => {

  it("round-trips the payload the wizard sub-flow resolvers read back", async () => {
    // The resolver selects `payload_redacted as payload`; a wrong column name there throws on
    // EVERY draft text message and strands them all in RETRY instead of advancing the wizard.
    await createAdminCallbackState(ctx.db, {
      adminTelegramUserId: "6659186592",
      kind: "WIZARD_DESC_CUSTOM",
      payload: { field: "warrantyVi" },
    });

    const result = await sql<{ payload: unknown; kind: string }>`
      select kind, payload_redacted as payload
      from admin_callback_state
      where admin_telegram_user_id = ${"6659186592"}
        and kind = 'WIZARD_DESC_CUSTOM'
      order by created_at desc
      limit 1
    `.execute(ctx.db);

    expect(result.rows[0]?.kind).toBe("WIZARD_DESC_CUSTOM");
    expect(result.rows[0]?.payload).toEqual({ field: "warrantyVi" });
  });

  it("accepts every kind declared by AdminStateKind", async () => {
    const failures: string[] = [];
    for (const kind of ALL_KINDS) {
      try {
        await createAdminCallbackState(ctx.db, {
          adminTelegramUserId: "6659186592",
          kind,
          payload: { probe: true },
        });
      } catch (error) {
        failures.push(`${kind}: ${(error as Error).message}`);
      }
    }
    expect(failures).toEqual([]);
  });
});
