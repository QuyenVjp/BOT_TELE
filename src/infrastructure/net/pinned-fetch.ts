import { request as httpsRequest, type RequestOptions } from "node:https";
import { request as httpRequest } from "node:http";
import type { LookupFunction } from "node:net";
import { Readable } from "node:stream";
import {
  assertOutboundTargetAllowed,
  OutboundPolicyError,
  type OutboundPolicyOptions,
} from "./outbound-policy.js";

/**
 * A `fetch`-shaped client whose SOCKET is pinned to an address that passed the
 * outbound policy.
 *
 * `assertOutboundTargetAllowed` alone is not enough. It resolves the hostname and
 * classifies every answer, but a plain `fetch` then resolves the hostname a SECOND
 * time when it opens the socket — so a DNS answer that changes between the two
 * lookups (rebinding) reaches a private address that was never validated. This
 * module closes that window by handing Node's transport a `lookup` that can only
 * ever return the addresses policy already approved for THIS attempt.
 *
 * TLS is untouched and still keyed to the original hostname: the request URL keeps
 * the hostname, so SNI and certificate verification use it, and only the address
 * the socket dials is pinned. `rejectUnauthorized` is never relaxed.
 *
 * Redirects are never followed: a 3xx is returned to the caller, which must treat
 * it as a refusal. Following a redirect would move the request to a host the policy
 * never saw.
 *
 * Only `https:` is dialled in production. `http:` is permitted solely when the
 * policy's loopback test escape hatch is on, which is how the existing loopback
 * tests keep working.
 */

export interface PinnedFetchOptions extends OutboundPolicyOptions {
  /**
   * Test seam. When present the REQUEST is delegated to it instead of opening a
   * socket, so unit tests never touch the network. Policy validation still runs
   * first, so a test cannot use this to reach a forbidden address. Production never
   * sets it.
   */
  fetchImpl?: typeof fetch;
  /** Injectable DNS for tests. */
  resolve?: (hostname: string) => Promise<readonly string[]>;
  /** Overall deadline for the whole exchange; defaults to 30s. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * A Node `LookupFunction` that answers only with pre-approved addresses.
 *
 * This is the anti-rebinding primitive: by the time the transport asks for the
 * address, the answer is already decided and cannot change.
 */
export function createPinnedLookup(addresses: readonly string[]): LookupFunction {
  const resolved = addresses.map((address) => ({
    address,
    family: (address.includes(":") ? 6 : 4) as 4 | 6,
  }));
  const first = resolved[0]!;
  return ((_hostname: string, options: unknown, callback: (...args: unknown[]) => void) => {
    const wantsAll =
      typeof options === "object" && options !== null && "all" in options && options.all === true;
    if (wantsAll) callback(null, resolved);
    else callback(null, first.address, first.family);
  }) as unknown as LookupFunction;
}

function toRequestOptions(init: RequestInit | undefined, lookup: LookupFunction): RequestOptions {
  const headers: Record<string, string> = {};
  if (init?.headers) {
    for (const [key, value] of new Headers(init.headers)) headers[key] = value;
  }
  const body = typeof init?.body === "string" ? init.body : undefined;
  return {
    method: init?.method ?? "GET",
    headers,
    // `lookup` is the whole point: the socket can only dial an approved address.
    lookup,
    // No keep-alive pool: a pooled socket could have been opened under an earlier
    // decision, and this client is low-volume.
    agent: false,
    ...(body === undefined ? {} : { body, headers: { ...headers } }),
  };
}

/** One pinned exchange, returning a real `Response` whose body streams. */
async function pinnedExchange(
  url: URL,
  init: RequestInit | undefined,
  lookup: LookupFunction,
  timeoutMs: number,
): Promise<Response> {
  const options = toRequestOptions(init, lookup);
  const send = url.protocol === "https:" ? httpsRequest : httpRequest;

  return await new Promise<Response>((resolve, reject) => {
    let settled = false;
    // Declared before `finish` so the cleanup cannot reference a binding that is
    // still in its temporal dead zone.
    let deadline: NodeJS.Timeout | undefined;
    let onAbort: (() => void) | undefined;
    const finish = (error: Error | null, value?: Response): void => {
      if (settled) return;
      settled = true;
      if (deadline) clearTimeout(deadline);
      if (onAbort && init?.signal) init.signal.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve(value!);
    };

    const req = send(url, options, (res) => {
      const headers = new Headers();
      for (const [key, value] of Object.entries(res.headers)) {
        if (Array.isArray(value)) for (const item of value) headers.append(key, item);
        else if (value !== undefined) headers.set(key, String(value));
      }
      finish(
        null,
        new Response(Readable.toWeb(res) as ReadableStream, {
          status: res.statusCode ?? 0,
          statusText: res.statusMessage ?? "",
          headers,
        }),
      );
    });

    // An overall deadline, not just `req.setTimeout`. A socket timeout only starts
    // once a socket exists, so a CONNECT that never completes — a blackholed address,
    // which is exactly what a pinned non-listening address looks like — would hang
    // forever. The timer below fires regardless of transport progress.
    deadline = setTimeout(() => {
      req.destroy(new Error("OUTBOUND_TIMEOUT"));
      finish(new Error("OUTBOUND_TIMEOUT"));
    }, timeoutMs);
    deadline.unref?.();

    onAbort = (): void => {
      req.destroy(new Error("OUTBOUND_ABORTED"));
      finish(new Error("OUTBOUND_ABORTED"));
    };

    req.on("error", (error) => finish(error));
    if (init?.signal) {
      if (init.signal.aborted) onAbort();
      else init.signal.addEventListener("abort", onAbort, { once: true });
    }
    const body = init?.body;
    if (typeof body === "string") req.write(body);
    req.end();
  });
}

/**
 * `fetch`, but the resolved address is chosen by the policy and then pinned to the
 * socket for exactly this attempt. Every call re-resolves and re-validates, so a
 * retry cannot reuse a stale approval.
 */
export function createPinnedFetch(options: PinnedFetchOptions = {}): typeof fetch {
  const { fetchImpl, resolve, timeoutMs = DEFAULT_TIMEOUT_MS, ...policy } = options;

  const pinnedFetch = async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ): Promise<Response> => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    let parsed: URL;
    try {
      parsed = new URL(raw);
    } catch {
      throw new OutboundPolicyError("MALFORMED_URL", "outbound URL is malformed");
    }
    // Credentials are checked on the FULL URL: `new URL(...).origin` drops userinfo, so
    // deriving the origin first would silently erase this check.
    if (parsed.username || parsed.password) {
      throw new OutboundPolicyError(
        "CREDENTIALS_IN_URL",
        "outbound URL must not embed credentials",
      );
    }
    // The ORIGIN is what the policy is for: scheme, host, port and the resolved
    // address. The path and query belong to the request being made — a normal request
    // carries a query string, and rejecting that here would make this client unusable
    // for anything but a bare origin. Nothing about the path can redirect the socket.
    const approved = await assertOutboundTargetAllowed(
      parsed.origin,
      policy,
      resolve ? { resolve } : undefined,
    );
    // Keep the caller's path and query, but pin the ORIGIN the policy approved.
    const target = new URL(parsed.pathname + parsed.search, approved.url.origin);

    // A redirect would carry the request to a host the policy never classified, and
    // a `Location` is attacker-influenced. Refuse before reading the body.
    const guardedInit: RequestInit = { ...init, redirect: "error" };

    if (fetchImpl) {
      // Test seam: validation has already run, and no real socket is opened.
      return fetchImpl(target, guardedInit);
    }
    return pinnedExchange(target, guardedInit, createPinnedLookup(approved.addresses), timeoutMs);
  };

  return pinnedFetch as typeof fetch;
}
