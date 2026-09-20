import { describe, expect, it } from "vitest";
import {
  ADMIN_CONTACT_URL,
  COMMUNITY_URL,
  coerceAdminContactUrl,
  coerceCommunityUrl,
  isValidTelegramUsernameUrl,
} from "../../src/modules/catalog/shop-profile.js";

describe("shop profile Telegram URL policy", () => {
  it("accepts only canonical public Telegram username URLs", () => {
    expect(isValidTelegramUsernameUrl("https://t.me/Quyenvjp")).toBe(true);
    expect(isValidTelegramUsernameUrl("https://t.me/example_channel_1")).toBe(true);
    expect(isValidTelegramUsernameUrl("http://t.me/example")).toBe(false);
    expect(isValidTelegramUsernameUrl("https://t.me/example?start=unsafe")).toBe(false);
  });

  it("falls back to canonical contacts for invalid or legacy values", () => {
    expect(coerceCommunityUrl("https://evil.example/support")).toBe(COMMUNITY_URL);
    expect(coerceAdminContactUrl("https://t.me/aicodexvn")).toBe(ADMIN_CONTACT_URL);
    expect(coerceAdminContactUrl("not-a-url")).toBe(ADMIN_CONTACT_URL);
  });
});
