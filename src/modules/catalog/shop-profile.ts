import { sql } from "kysely";
import type { Executor } from "../../infrastructure/db/transaction.js";

/** Official customer-facing shop name. Never "SHOP DIGITAL". */
export const SHOP_NAME = "TIER20 SHOP";

export const SHOP_TAGLINE = "AI • Coding • VPN • Phần mềm số";

export const COMMUNITY_URL = "https://t.me/aicodexvn";

export const COMMUNITY_BUTTON_LABEL = "📢 AI Codex Việt Nam";

/**
 * Public admin/support contact. Exact spelling is load-bearing (`Quyenvjp`).
 * Import this constant — do not retype the URL in presenters or tests.
 */
export const ADMIN_CONTACT_URL = "https://t.me/Quyenvjp";

export const ADMIN_DISPLAY = "@Quyenvjp";

export interface ShopProfile {
  shopName: string;
  tagline: string;
  communityUrl: string;
  communityButton: string;
  adminContactUrl: string;
  adminDisplay: string;
}

export const DEFAULT_SHOP_PROFILE: ShopProfile = {
  shopName: SHOP_NAME,
  tagline: SHOP_TAGLINE,
  communityUrl: COMMUNITY_URL,
  communityButton: COMMUNITY_BUTTON_LABEL,
  adminContactUrl: ADMIN_CONTACT_URL,
  adminDisplay: ADMIN_DISPLAY,
};

function coerceShopName(value: string | null | undefined): string {
  if (!value || /digital/i.test(value)) return SHOP_NAME;
  return value;
}

function coerceTagline(value: string | null | undefined): string {
  if (!value || /kho sản phẩm số/i.test(value)) return SHOP_TAGLINE;
  return value;
}

function coerceAdminContactUrl(value: string | null | undefined): string {
  if (!value || /aicodexvn/i.test(value)) return ADMIN_CONTACT_URL;
  return value;
}

/**
 * Runtime shop profile. CatalogDomain may read shop_settings here; fallbacks
 * MUST stay these canonical constants so a mistyped URL cannot ship.
 */
export async function getShopProfile(exec?: Executor): Promise<ShopProfile> {
  if (!exec) return { ...DEFAULT_SHOP_PROFILE };
  try {
    const result = await sql<{
      shop_name: string | null;
      shop_tagline: string | null;
      community_url: string | null;
      admin_contact_url: string | null;
      admin_display: string | null;
    }>`
      select shop_name, shop_tagline, community_url, admin_contact_url, admin_display
      from shop_settings
      where id = 'main'
      limit 1
    `.execute(exec);
    const row = result.rows[0];
    if (!row) return { ...DEFAULT_SHOP_PROFILE };
    return {
      shopName: coerceShopName(row.shop_name),
      tagline: coerceTagline(row.shop_tagline),
      communityUrl: row.community_url || COMMUNITY_URL,
      communityButton: COMMUNITY_BUTTON_LABEL,
      adminContactUrl: coerceAdminContactUrl(row.admin_contact_url),
      adminDisplay: row.admin_display || ADMIN_DISPLAY,
    };
  } catch {
    return { ...DEFAULT_SHOP_PROFILE };
  }
}
