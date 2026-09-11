/**
 * Value-scanning secret redaction.
 *
 * `REDACT_PATHS` in the logger censors secrets that arrive at a *known key*.
 * That leaves the other half of the leak surface open: a token inside a
 * free-form error message, a provider response body echoed into an error, a
 * string built with a template literal, or a secret nested at an unknown depth.
 * This module scrubs by VALUE: every occurrence of a registered secret is
 * replaced with {@link REDACTION_MARKER} wherever it appears.
 *
 * Invariants:
 *  - the registry never serialises its own contents (only `size()` is visible);
 *  - a registered value is never re-registered, so scrubbing terminates even
 *    when the marker is a substring of some secret;
 *  - values shorter than {@link MIN_SECRET_LENGTH} are ignored, because masking
 *    them would eat ordinary words out of every log line.
 */

/** Replacement text for anything redacted: values, sensitive keys, whole headers. */
export const REDACTION_MARKER = "«redacted»";

/** Shorter values are not secrets worth scrubbing — they would match ordinary prose. */
const MIN_SECRET_LENGTH = 8;

/** Default nesting bound for {@link scrubValue}; deeper values become the marker. */
const DEFAULT_MAX_DEPTH = 8;

/**
 * Normalised key fragments (case-folded, `_`/`-` stripped) that always indicate
 * a secret: `botToken`, `bot_token` and `BOT-TOKEN` all normalise to a string
 * containing `token`.
 */
const SENSITIVE_KEY_FRAGMENTS: Record<string, true> = {
  token: true,
  secret: true,
  password: true,
  passwd: true,
  credential: true,
  authorization: true,
  cookie: true,
  apikey: true,
  vaultref: true,
  initdata: true,
  otp: true,
  totp: true,
  seed: true,
  privatekey: true,
  signature: true,
  hmac: true,
  bearer: true,
};

/** Matched in full only: `sessionid` is a common innocuous suffix in ids. */
const SENSITIVE_KEY_NAMES: Record<string, true> = { sessionid: true };

/** A bare `key` is too common to redact; these qualifiers make it a credential. */
const KEY_QUALIFIERS = ["api", "private", "signing", "hmac", "otp", "totp", "seed"] as const;

/** Key names that always redact, matched case-insensitively and ignoring `_`/`-`. */
function isSensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[_-]/gu, "");
  if (SENSITIVE_KEY_NAMES[normalized]) return true;
  for (const fragment in SENSITIVE_KEY_FRAGMENTS) {
    if (normalized.includes(fragment)) return true;
  }
  if (!normalized.includes("key")) return false;
  return KEY_QUALIFIERS.some((qualifier) => normalized.includes(qualifier));
}

/**
 * Known secret VALUES to scrub from any string. Registered at boot from the
 * resolved config; the registry never serialises its own contents.
 */
export interface SecretRegistry {
  /** Register a secret value. Ignores undefined/empty and values shorter than 8 chars. */
  add(value: string | undefined | null): void;
  addAll(values: Iterable<string | undefined | null>): void;
  /** Replace every occurrence of every registered secret with the marker. */
  scrub(text: string): string;
  /** Number of registered values — for tests and diagnostics, never the values. */
  size(): number;
  /** Drop all registered values (test reset hook). */
  clear(): void;
}

export function createSecretRegistry(): SecretRegistry {
  const values = new Set<string>();
  // Longest first: scrubbing a shorter value that prefixes a longer one would
  // leave the longer value's tail in the output.
  const ordered: string[] = [];

  function add(value: string | undefined | null): void {
    if (typeof value !== "string" || value.length < MIN_SECRET_LENGTH) return;
    // A value containing the marker would be re-matched by its own replacement.
    if (value.includes(REDACTION_MARKER) || values.has(value)) return;
    values.add(value);
    const at = ordered.findIndex((existing) => existing.length < value.length);
    if (at < 0) ordered.push(value);
    else ordered.splice(at, 0, value);
  }

  function scrub(text: string): string {
    if (ordered.length === 0 || text.length === 0) return text;
    let out = text;
    for (const secret of ordered) {
      if (out.includes(secret)) out = out.split(secret).join(REDACTION_MARKER);
    }
    return out;
  }

  return {
    add,
    addAll(secrets) {
      for (const value of secrets) add(value);
    },
    scrub,
    size() {
      return values.size;
    },
    clear() {
      values.clear();
      ordered.length = 0;
    },
  };
}

let shared: SecretRegistry | undefined;

/** Process-wide registry, primed by `registerConfigSecrets`. */
export function sharedSecretRegistry(): SecretRegistry {
  if (!shared) shared = createSecretRegistry();
  return shared;
}

/** Register every secret supplied by a resolved config. Returns how many were usable. */
export function registerConfigSecrets(
  config: Record<string, unknown>,
  keys: readonly string[],
): number {
  if (!config || typeof config !== "object") return 0;
  const registry = sharedSecretRegistry();
  let usable = 0;
  for (const key of keys) {
    const value = config[key];
    if (typeof value !== "string") continue;
    if (value.length < MIN_SECRET_LENGTH || value.includes(REDACTION_MARKER)) continue;
    usable++;
    registry.add(value);
  }
  return usable;
}

/** Scrub a string. Safe on undefined. */
export function scrubSecrets(text: string): string {
  if (typeof text !== "string") return "";
  return sharedSecretRegistry().scrub(text);
}

function safeDescribe(value: unknown): string {
  try {
    const json = JSON.stringify(scrubValue(value, { maxDepth: 3 }));
    if (typeof json === "string") return json;
  } catch {
    // A throwing `toJSON` must not turn error reporting into a second error.
  }
  return "[unserializable]";
}

/**
 * Deep-scrub a value for logging: replaces registered secrets inside strings,
 * walks plain objects and arrays, and redacts values under sensitive key names.
 * Never mutates its input; cycles and depth overrun become the marker instead
 * of throwing.
 */
export function scrubValue<T>(value: T, options?: { maxDepth?: number }): unknown {
  const maxDepth = options?.maxDepth ?? DEFAULT_MAX_DEPTH;
  const seen = new WeakSet<object>();

  function walk(current: unknown, depth: number): unknown {
    if (typeof current === "string") return scrubSecrets(current);
    if (current === null || typeof current !== "object") return current;
    // Errors are logged for their name/message/stack, never their key list.
    if (current instanceof Error) return scrubError(current);
    // Binary/opaque objects carry no keyed secrets and would be mangled by a walk.
    if (
      current instanceof Date ||
      current instanceof RegExp ||
      current instanceof Map ||
      current instanceof Set ||
      ArrayBuffer.isView(current) ||
      current instanceof ArrayBuffer
    ) {
      return current;
    }
    if (depth >= maxDepth) return REDACTION_MARKER;
    // A cycle cannot be inlined: its first visit already emitted a scrubbed copy.
    if (seen.has(current)) return REDACTION_MARKER;
    seen.add(current);

    if (Array.isArray(current)) return current.map((item) => walk(item, depth + 1));

    const out: Record<string, unknown> = {};
    for (const key of Object.keys(current)) {
      const item = (current as Record<string, unknown>)[key];
      out[key] = isSensitiveKey(key) ? REDACTION_MARKER : walk(item, depth + 1);
    }
    return out;
  }

  return walk(value, 0);
}

/** Redact Authorization/Cookie-style header maps without dumping them. */
export function scrubHeaders(headers: Record<string, unknown>): Record<string, unknown> {
  if (!headers || typeof headers !== "object") return {};
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(headers)) {
    // Whole-value redaction: a `Bearer eyJ…` prefix is already the credential.
    out[key] = isSensitiveKey(key) ? REDACTION_MARKER : scrubValue(headers[key]);
  }
  return out;
}

/** Errors carry stacks and provider messages: produce a log-safe shape. */
export function scrubError(error: unknown): { name: string; message: string; stack?: string } {
  if (!(error instanceof Error)) {
    const message = typeof error === "string" ? error : safeDescribe(error);
    return {
      name: typeof error === "string" ? "Error" : "UnknownError",
      message: scrubSecrets(message),
    };
  }

  const shape: { name: string; message: string; stack?: string } = {
    name: typeof error.name === "string" && error.name ? error.name : "Error",
    message: scrubSecrets(typeof error.message === "string" ? error.message : ""),
  };
  // No `cause` chain: it is unbounded, usually a provider payload, and unused here.
  if (typeof error.stack === "string" && error.stack) shape.stack = scrubSecrets(error.stack);
  return shape;
}
