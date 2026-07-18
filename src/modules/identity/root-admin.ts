/**
 * Root-admin identity guard (T094, FR-021, FR-022, SC-009).
 *
 * The sole root administrator is defined by a single configured numeric Telegram
 * user id in an allowed (private) context. A username — including the expected
 * `@Quyenvjp` handle — is NEVER an authorization key: it is only observed for
 * drift alerting. This module is pure (no I/O) so the authorization rule has one
 * declarative home and can be unit-tested exhaustively.
 *
 * There is deliberately no "add admin" concept here or anywhere else (FR-022):
 * the configured id is the whole identity model.
 */

export type ChatContext = "private" | "group" | "supergroup" | "channel";

export interface RootAdminConfig {
  /** The single numeric Telegram user id that may act as root. 0 = unset (fail closed). */
  adminTelegramUserId: number;
  /** Username expected for the owner — used ONLY to detect drift, never to authorize. */
  expectedUsername: string;
}

export interface RootActor {
  numericUserId: number;
  chatType: ChatContext;
  observedUsername?: string | null;
}

export type RootAuthResult =
  | { ok: true; usernameDrift: boolean }
  | { ok: false; reason: "NOT_ROOT_ADMIN" | "WRONG_CONTEXT"; usernameDrift: boolean };

/** True only for the exact configured id; a zero/unset config never matches. */
export function isConfiguredRootId(numericUserId: number, config: RootAdminConfig): boolean {
  return config.adminTelegramUserId > 0 && numericUserId === config.adminTelegramUserId;
}

/** Root actions are permitted only in a private chat context. */
export function isPrivateContext(chatType: ChatContext): boolean {
  return chatType === "private";
}

/** Normalize a username for comparison: drop a leading @ and lowercase. */
function normalizeUsername(username: string): string {
  return username.replace(/^@/, "").toLowerCase();
}

/**
 * Drift = an observed username that is present but does NOT match the expected
 * handle. An absent username is not drift (Telegram may omit it); this signal is
 * for alerting only and never gates authorization.
 */
export function detectUsernameDrift(
  observedUsername: string | null | undefined,
  config: RootAdminConfig,
): boolean {
  if (observedUsername == null || observedUsername.length === 0) return false;
  return normalizeUsername(observedUsername) !== normalizeUsername(config.expectedUsername);
}

/**
 * Authorize a root action. Order matters: identity first (so a non-root actor
 * presenting the owner username is rejected as NOT_ROOT_ADMIN, never leaking a
 * context hint), then context. Username drift is computed for the configured id
 * so callers can alert without denying.
 */
export function authorizeRootAction(actor: RootActor, config: RootAdminConfig): RootAuthResult {
  if (!isConfiguredRootId(actor.numericUserId, config)) {
    return { ok: false, reason: "NOT_ROOT_ADMIN", usernameDrift: false };
  }
  const usernameDrift = detectUsernameDrift(actor.observedUsername, config);
  if (!isPrivateContext(actor.chatType)) {
    return { ok: false, reason: "WRONG_CONTEXT", usernameDrift };
  }
  return { ok: true, usernameDrift };
}
