import { scrubSecrets } from "../observability/redact.js";

/**
 * The inbox retried a message and gave up without ever recording why. `HANDLER_FAILED` is not a
 * cause: it cannot distinguish a bug from a missing row from a constraint violation, and the one
 * time this mattered in practice the answer ("column reference status is ambiguous", SQLSTATE
 * 42702) was sitting in a log line while the queue row said nothing.
 *
 * Kept bounded and credential-free: an error message can carry a connection string or a token, and
 * this lands in a table the operator reads.
 */
const MAX_DETAIL_CHARS = 500;

/** Shapes worth keeping beyond `Error`: Postgres puts the SQLSTATE on the object, not in the message. */
function codeOf(error: unknown): string | null {
  if (typeof error !== "object" || error === null) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && /^[A-Za-z0-9_]{1,32}$/u.test(code) ? code : null;
}

/**
 * Collapse an unknown throw into one bounded, redacted line: `Name [code]: message`.
 * Returns null when there is nothing safe to say, so the column stays null rather than storing "{}".
 */
export function describeHandlerError(error: unknown): string | null {
  const name =
    typeof error === "object" &&
    error !== null &&
    typeof (error as { name?: unknown }).name === "string"
      ? (error as { name: string }).name
      : typeof error === "string"
        ? "Error"
        : "UnknownError";
  const rawMessage =
    error instanceof Error ? error.message : typeof error === "string" ? error : "";
  const code = codeOf(error);

  // Anything credential-shaped never reaches the column: `scheme://user:pass@host` and long
  // high-entropy runs are the two shapes that show up in connection and transport errors.
  const redacted = rawMessage
    .replace(/\/\/[^\s:@/]+:[^\s@/]+@/gu, "//[redacted]@")
    .replace(/\b[A-Za-z0-9_-]{24,}\b/gu, "[redacted]")
    .replace(/\s+/gu, " ")
    .trim();

  // A bare "Error" with no message tells the operator nothing, so the column stays null instead.
  // A named error still does: a TypeError with an empty message is a different bug from a plain one.
  const informativeName = name !== "Error" && name !== "UnknownError";
  if (!redacted && !informativeName && !code) return null;

  const line = [name + (code ? ` [${code}]` : ""), redacted].filter(Boolean).join(": ");
  if (!line) return null;
  // The ad-hoc passes above catch credential *shapes*; registered config secrets
  // are exact values, so they are scrubbed value-wise before the length bound.
  const scrubbed = scrubSecrets(line);
  return scrubbed.length <= MAX_DETAIL_CHARS
    ? scrubbed
    : `${scrubbed.slice(0, MAX_DETAIL_CHARS - 1)}…`;
}
