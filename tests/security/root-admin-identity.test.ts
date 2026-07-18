import { describe, expect, it } from "vitest";
import {
  authorizeRootAction,
  detectUsernameDrift,
  isConfiguredRootId,
  isPrivateContext,
  type RootAdminConfig,
} from "../../src/modules/identity/root-admin.js";

/**
 * T090 — Root-admin identity authorization (FR-021, SC-009).
 *
 * Authorization is granted ONLY to the configured numeric Telegram id in a
 * private context. A username — including the expected `@Quyenvjp` handle — is
 * never an authorization key: any other numeric identity presenting that
 * username is denied. A group/supergroup/channel context is denied even for the
 * configured id. Username drift is surfaced as an alert signal, never as a grant
 * or (by itself) a denial.
 */

const config: RootAdminConfig = {
  adminTelegramUserId: 123456789,
  expectedUsername: "Quyenvjp",
};

describe("root-admin identity (FR-021 / SC-009)", () => {
  it("authorizes the configured numeric id in a private chat", () => {
    const res = authorizeRootAction(
      { numericUserId: 123456789, chatType: "private", observedUsername: "Quyenvjp" },
      config,
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.usernameDrift).toBe(false);
  });

  it("denies a different numeric id even when it presents the expected username", () => {
    const res = authorizeRootAction(
      { numericUserId: 999000111, chatType: "private", observedUsername: "Quyenvjp" },
      config,
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("NOT_ROOT_ADMIN");
  });

  it("denies the configured id outside a private context (group/supergroup/channel)", () => {
    for (const chatType of ["group", "supergroup", "channel"] as const) {
      const res = authorizeRootAction(
        { numericUserId: 123456789, chatType, observedUsername: "Quyenvjp" },
        config,
      );
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.reason).toBe("WRONG_CONTEXT");
    }
  });

  it("never authorizes when the configured id is unset (fail closed)", () => {
    const res = authorizeRootAction(
      { numericUserId: 0, chatType: "private" },
      { adminTelegramUserId: 0, expectedUsername: "Quyenvjp" },
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("NOT_ROOT_ADMIN");
  });

  it("authorizes the configured id but flags username drift for alerting", () => {
    const res = authorizeRootAction(
      { numericUserId: 123456789, chatType: "private", observedUsername: "SomeoneElse" },
      config,
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.usernameDrift).toBe(true);
  });

  it("isConfiguredRootId matches only the exact configured id (not zero)", () => {
    expect(isConfiguredRootId(123456789, config)).toBe(true);
    expect(isConfiguredRootId(123456788, config)).toBe(false);
    expect(isConfiguredRootId(0, { adminTelegramUserId: 0, expectedUsername: "x" })).toBe(false);
  });

  it("isPrivateContext accepts only private", () => {
    expect(isPrivateContext("private")).toBe(true);
    expect(isPrivateContext("group")).toBe(false);
  });

  it("detectUsernameDrift compares case-insensitively and ignores a leading @", () => {
    expect(detectUsernameDrift("Quyenvjp", config)).toBe(false);
    expect(detectUsernameDrift("@Quyenvjp", config)).toBe(false);
    expect(detectUsernameDrift("quyenvjp", config)).toBe(false);
    expect(detectUsernameDrift("impostor", config)).toBe(true);
    // An absent username is not, by itself, drift (Telegram may omit it).
    expect(detectUsernameDrift(null, config)).toBe(false);
    expect(detectUsernameDrift(undefined, config)).toBe(false);
  });
});
