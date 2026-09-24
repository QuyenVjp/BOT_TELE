import { sql } from "kysely";
import type { Executor } from "../../infrastructure/db/transaction.js";
import { appendAuditEvent } from "../identity/audit.js";

export type GroupPublicationDisableResult =
  | { ok: true; alreadyApplied: boolean }
  | { ok: false; code: "NOT_FOUND" | "STALE" | "NOT_SAFE"; message?: string };

export async function disableGroupPublicationInTransaction(
  exec: Executor,
  input: {
    expectedUpdatedAt: string;
    actorId: string;
    reason: string;
    correlationId: string;
  },
): Promise<GroupPublicationDisableResult> {
  if (
    input.expectedUpdatedAt.length === 0 ||
    input.expectedUpdatedAt.length > 64 ||
    !/^\d{1,20}$/u.test(input.actorId) ||
    input.reason.trim().length === 0 ||
    input.reason.length > 500 ||
    input.correlationId.length === 0 ||
    input.correlationId.length > 128
  ) {
    return { ok: false, code: "NOT_SAFE" };
  }

  const current = await sql<{
    updated_at: string;
    shop_panel_enabled: boolean;
    welcome_enabled: boolean;
    restock_publishing_enabled: boolean;
    social_proof_mode: string;
  }>`
    select updated_at::text, shop_panel_enabled, welcome_enabled,
      restock_publishing_enabled, social_proof_mode
    from group_commerce_settings
    where id = 'main'
    for update
  `.execute(exec);
  const row = current.rows[0];
  if (!row) return { ok: false, code: "NOT_FOUND" };
  if (row.updated_at !== input.expectedUpdatedAt) {
    return { ok: false, code: "STALE", message: "Thiết lập nhóm đã thay đổi." };
  }

  const alreadyApplied =
    !row.shop_panel_enabled &&
    !row.welcome_enabled &&
    !row.restock_publishing_enabled &&
    row.social_proof_mode === "OFF";

  if (!alreadyApplied) {
    await sql`
      update group_commerce_settings
      set shop_panel_enabled = false,
          welcome_enabled = false,
          restock_publishing_enabled = false,
          social_proof_mode = 'OFF',
          updated_at = now(),
          updated_by = ${input.actorId}
      where id = 'main' and updated_at::text = ${input.expectedUpdatedAt}
    `.execute(exec);
  }

  await appendAuditEvent(exec, {
    actorType: "ROOT_ADMIN",
    actorId: input.actorId,
    action: "group.publication.disabled",
    targetType: "GroupCommerceSettings",
    targetId: "main",
    reason: input.reason,
    correlationId: input.correlationId,
    metadataRedacted: {
      previousShopPanelEnabled: row.shop_panel_enabled,
      previousWelcomeEnabled: row.welcome_enabled,
      previousRestockPublishingEnabled: row.restock_publishing_enabled,
      previousSocialProofMode: row.social_proof_mode,
      shopPanelEnabled: false,
      welcomeEnabled: false,
      restockPublishingEnabled: false,
      socialProofMode: "OFF",
      alreadyApplied,
    },
  });
  return { ok: true, alreadyApplied };
}
