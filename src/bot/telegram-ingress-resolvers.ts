import { sql } from "kysely";
import type { Db } from "../infrastructure/db/transaction.js";
import {
  isRootProductDraftTextStep,
  type AdminOwnerPromptTextIngress,
  type RootProductDraftTextIngress,
  type SupportDescriptionTextIngress,
} from "./webhook.js";

/** The remediation prompts that own the root admin's next private text. */
export const REMEDIATION_PROMPT_KINDS_SQL = sql`
  'ADMIN_RESALE_EVIDENCE_PROMPT',
  'ADMIN_PAYMENT_DISPOSITION_PROMPT',
  'ADMIN_OUTBOX_DISPOSITION_PROMPT'
`;

type ResolverLogger = {
  error(bindings: Record<string, unknown>, message: string): void;
};

export function createRootProductDraftTextIngress(input: {
  db: Db;
  adminTelegramUserId: number;
}): RootProductDraftTextIngress {
  const adminTelegramUserId = String(input.adminTelegramUserId);
  return {
    adminTelegramUserId: input.adminTelegramUserId,
    async activeStep(telegramUserId: string) {
      if (telegramUserId !== adminTelegramUserId) return null;
      const row = (
        await sql<{ step: string }>`
          select step
          from admin_workflow
          where admin_telegram_user_id = ${telegramUserId}
            and expires_at > now()
            and step in (
              'name','sku','description','variant','deliveryConfig',
              'variantName','price','inventoryFields','threshold','initialQuantity',
              'serviceInstructions'
            )
            and not exists (
              select 1
              from admin_callback_state prompt
              where prompt.admin_telegram_user_id = ${telegramUserId}
                and prompt.kind in (${REMEDIATION_PROMPT_KINDS_SQL})
                and prompt.expires_at > now()
            )
          limit 1
        `.execute(input.db)
      ).rows[0];
      return row && isRootProductDraftTextStep(row.step) ? row.step : null;
    },
  };
}

export function createOwnerPromptTextIngress(input: {
  db: Db;
  adminTelegramUserId: number;
}): AdminOwnerPromptTextIngress {
  const adminTelegramUserId = String(input.adminTelegramUserId);
  return {
    adminTelegramUserId: input.adminTelegramUserId,
    async isActive(telegramUserId: string) {
      if (telegramUserId !== adminTelegramUserId) return false;
      const row = (
        await sql<{ id: string }>`
          select id
          from admin_callback_state
          where admin_telegram_user_id = ${telegramUserId}
            and kind in (${REMEDIATION_PROMPT_KINDS_SQL})
            and expires_at > now()
          limit 1
        `.execute(input.db)
      ).rows[0];
      return Boolean(row);
    },
  };
}

export function createSupportDescriptionTextIngress(input: {
  db: Db;
  logger: ResolverLogger;
}): SupportDescriptionTextIngress {
  return {
    async resolveTicketId(telegramUserId: string) {
      try {
        const row = (
          await sql<{ pending_count: number; ticket_id: string | null }>`
            select count(*)::int as pending_count, min(ticket.id) as ticket_id
            from channel_identity ci
            join support_ticket ticket on ticket.customer_id = ci.customer_id
            where ci.channel = 'TELEGRAM'
              and ci.channel_user_id = ${telegramUserId}
              and ticket.status = 'WAITING_CUSTOMER'
          `.execute(input.db)
        ).rows[0];
        return row?.pending_count === 1 ? row.ticket_id : null;
      } catch (error) {
        const errorType =
          error instanceof Error && /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/u.test(error.name)
            ? error.name
            : "UnknownError";
        const rawCode =
          typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
        const errorCode =
          typeof rawCode === "string" && /^[A-Za-z0-9_]{1,32}$/u.test(rawCode)
            ? rawCode
            : undefined;
        input.logger.error(
          {
            event: "support_description_ticket_lookup_failed",
            errorType,
            ...(errorCode ? { errorCode } : {}),
          },
          "support description ticket lookup failed",
        );
        throw error;
      }
    },
  };
}
