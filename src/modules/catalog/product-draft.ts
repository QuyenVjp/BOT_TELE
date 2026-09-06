import { sql, type Kysely } from "kysely";
import type { Database } from "../../infrastructure/db/client.js";

export type ProductDraftStep =
  "name" | "sku" | "category" | "price" | "description" | "threshold" | "confirm";

export interface ProductDraft {
  adminTelegramUserId: string;
  step: ProductDraftStep;
  name?: string;
  slug?: string;
  sku?: string;
  categoryId?: string;
  priceVnd?: bigint;
  description?: string;
  lowStockThreshold?: number;
  expiresAt: number;
}

const TTL_MS = 15 * 60_000;
const SKU = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const SLUG = /^[a-z0-9][a-z0-9-]{1,127}$/;

export type DraftResult =
  { ok: true; draft: ProductDraft } | { ok: false; error: string; draft: ProductDraft };

export function startProductDraft(adminTelegramUserId: string, now = Date.now()): ProductDraft {
  return { adminTelegramUserId, step: "name", expiresAt: now + TTL_MS };
}

export function advanceProductDraft(
  draft: ProductDraft,
  value: string,
  now = Date.now(),
): DraftResult {
  if (draft.expiresAt <= now) return { ok: false, error: "DRAFT_EXPIRED", draft };
  const text = value.trim();
  if (!text || text.length > 2_000) return { ok: false, error: "INVALID_VALUE", draft };
  const next = { ...draft, expiresAt: now + TTL_MS };
  switch (draft.step) {
    case "name":
      next.name = text;
      next.step = "sku";
      break;
    case "sku":
      if (!SKU.test(text)) return { ok: false, error: "INVALID_SKU", draft };
      next.sku = text.toUpperCase();
      next.slug = text.toLowerCase().replace(/_/g, "-");
      if (!SLUG.test(next.slug)) return { ok: false, error: "INVALID_SLUG", draft };
      next.step = "category";
      break;
    case "category":
      next.categoryId = text;
      next.step = "price";
      break;
    case "price": {
      const normalized = text.replace(/[.,]/g, "");
      if (!/^\d+$/.test(normalized)) return { ok: false, error: "INVALID_PRICE", draft };
      next.priceVnd = BigInt(normalized);
      next.step = "description";
      break;
    }
    case "description":
      next.description = text;
      next.step = "threshold";
      break;
    case "threshold":
      if (!/^\d+$/.test(text)) return { ok: false, error: "INVALID_THRESHOLD", draft };
      next.lowStockThreshold = Number(text);
      next.step = "confirm";
      break;
    case "confirm":
      return { ok: false, error: "DRAFT_READY", draft };
  }
  return { ok: true, draft: next };
}

export interface ProductDraftWorkflow {
  start(adminTelegramUserId: string, now?: number): ProductDraft;
  advance(adminTelegramUserId: string, value: string, now?: number): DraftResult;
  get(adminTelegramUserId: string, now?: number): ProductDraft | null;
  cancel(adminTelegramUserId: string): void;
}

export interface ProductDraftRepository {
  save(draft: ProductDraft): Promise<void>;
  load(adminTelegramUserId: string): Promise<ProductDraft | null>;
  remove(adminTelegramUserId: string): Promise<void>;
}

type DraftRow = {
  admin_telegram_user_id: string;
  step: ProductDraftStep;
  name: string | null;
  slug: string | null;
  sku: string | null;
  category_id: string | null;
  price_vnd: string | null;
  description: string | null;
  low_stock_threshold: number | null;
  expires_at: Date;
};

export function createProductDraftRepository(db: Kysely<Database>): ProductDraftRepository {
  return {
    async save(draft) {
      await sql`
        insert into admin_workflow
          (admin_telegram_user_id, step, name, slug, sku, category_id, price_vnd,
           description, low_stock_threshold, expires_at)
        values (${draft.adminTelegramUserId}, ${draft.step}, ${draft.name ?? null},
          ${draft.slug ?? null}, ${draft.sku ?? null}, ${draft.categoryId ?? null},
          ${draft.priceVnd?.toString() ?? null}, ${draft.description ?? null},
          ${draft.lowStockThreshold ?? null}, to_timestamp(${draft.expiresAt} / 1000.0))
        on conflict (admin_telegram_user_id) do update set
          step = excluded.step, name = excluded.name, slug = excluded.slug,
          sku = excluded.sku, category_id = excluded.category_id,
          price_vnd = excluded.price_vnd, description = excluded.description,
          low_stock_threshold = excluded.low_stock_threshold,
          expires_at = excluded.expires_at, updated_at = now()
      `.execute(db);
    },
    async load(adminTelegramUserId) {
      const result = await sql<DraftRow>`select * from admin_workflow
        where admin_telegram_user_id = ${adminTelegramUserId}`.execute(db);
      const row = result.rows[0];
      if (!row) return null;
      return {
        adminTelegramUserId: row.admin_telegram_user_id,
        step: row.step,
        ...(row.name == null ? {} : { name: row.name }),
        ...(row.slug == null ? {} : { slug: row.slug }),
        ...(row.sku == null ? {} : { sku: row.sku }),
        ...(row.category_id == null ? {} : { categoryId: row.category_id }),
        ...(row.price_vnd == null ? {} : { priceVnd: BigInt(row.price_vnd) }),
        ...(row.description == null ? {} : { description: row.description }),
        ...(row.low_stock_threshold == null ? {} : { lowStockThreshold: row.low_stock_threshold }),
        expiresAt: row.expires_at.getTime(),
      };
    },
    async remove(adminTelegramUserId) {
      await sql`delete from admin_workflow where admin_telegram_user_id = ${adminTelegramUserId}`.execute(db);
    },
  };
}

export interface DurableProductDraftWorkflow {
  start(adminTelegramUserId: string, now?: number): Promise<ProductDraft>;
  advance(adminTelegramUserId: string, value: string, now?: number): Promise<DraftResult>;
  get(adminTelegramUserId: string, now?: number): Promise<ProductDraft | null>;
  cancel(adminTelegramUserId: string): Promise<void>;
}

export function createDurableProductDraftWorkflow(repository: ProductDraftRepository): DurableProductDraftWorkflow {
  return {
    async start(adminTelegramUserId, now) {
      const draft = startProductDraft(adminTelegramUserId, now);
      await repository.save(draft);
      return draft;
    },
    async advance(adminTelegramUserId, value, now) {
      const draft = await repository.load(adminTelegramUserId);
      if (!draft) return { ok: false, error: "NO_DRAFT", draft: startProductDraft(adminTelegramUserId, now) };
      const result = advanceProductDraft(draft, value, now);
      if (result.ok) await repository.save(result.draft);
      return result;
    },
    async get(adminTelegramUserId, now = Date.now()) {
      const draft = await repository.load(adminTelegramUserId);
      if (!draft || draft.expiresAt <= now) {
        if (draft) await repository.remove(adminTelegramUserId);
        return null;
      }
      return draft;
    },
    cancel: (adminTelegramUserId) => repository.remove(adminTelegramUserId),
  };
}

export function createProductDraftWorkflow(): ProductDraftWorkflow {
  const drafts = new Map<string, ProductDraft>();
  return {
    start(adminTelegramUserId, now) { const draft = startProductDraft(adminTelegramUserId, now); drafts.set(adminTelegramUserId, draft); return draft; },
    advance(adminTelegramUserId, value, now) {
      const draft = drafts.get(adminTelegramUserId);
      if (!draft) return { ok: false, error: "NO_DRAFT", draft: startProductDraft(adminTelegramUserId, now) };
      const result = advanceProductDraft(draft, value, now); if (result.ok) drafts.set(adminTelegramUserId, result.draft); return result;
    },
    get(adminTelegramUserId, now = Date.now()) { const draft = drafts.get(adminTelegramUserId); if (!draft || draft.expiresAt <= now) { drafts.delete(adminTelegramUserId); return null; } return draft; },
    cancel(adminTelegramUserId) { drafts.delete(adminTelegramUserId); },
  };
}
