import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createPinnedFetch,
  createPinnedLookup,
} from "../../src/infrastructure/net/pinned-fetch.js";
import { OutboundPolicyError } from "../../src/infrastructure/net/outbound-policy.js";

/**
 * The socket must dial the address the policy approved, not a second resolution.
 *
 * `assertOutboundTargetAllowed` resolves and classifies the hostname. A plain `fetch`
 * then resolves it AGAIN when it opens the socket, so an answer that changes between
 * the two lookups (DNS rebinding) reaches an address nobody validated. These tests
 * exercise the REAL transport.
 *
 * Proving it needs a hostname Node would actually resolve, and two addresses that are
 * distinguishable. `localhost` is the hostname (the policy accepts it as loopback for
 * the http test hatch); `127.0.0.1` is where the server listens; `127.0.0.2` is a
 * second loopback address the policy also approves, where NOTHING is listening.
 *
 * So the two outcomes are opposite, and the assertion names which one must happen:
 *  - pinned   → dials 127.0.0.2 → the connect fails, and the server records no hit;
 *  - NOT pinned → re-resolves `localhost` → 127.0.0.1 → the server records a hit.
 *
 * A test that merely called the validator twice would pass with the hole open, so
 * every assertion here is about what the socket actually did.
 */

let server: Server;
let serverHits = 0;
let serverPort = 0;

const LOOPBACK_SERVER = "127.0.0.1";
/** Nothing is bound here, so reaching it is observable as a failed connect. */
const LOOPBACK_ELSEWHERE = "127.0.0.2";

beforeAll(async () => {
  server = createServer((_req, res) => {
    serverHits += 1;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ reached: "server" }));
  });
  await new Promise<void>((resolve) => server.listen(0, LOOPBACK_SERVER, resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  serverPort = address.port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("pinned outbound transport", () => {
  it("reaches the server when the approved address is the one it listens on", async () => {
    serverHits = 0;
    const guarded = createPinnedFetch({
      resolve: async () => [LOOPBACK_SERVER],
      allowInsecureLoopback: true,
      allowedPorts: [serverPort],
    });

    const response = await guarded(`http://localhost:${serverPort}/probe`);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ reached: "server" });
    expect(serverHits).toBe(1);
  });

  it("dials the APPROVED address, not whatever the hostname resolves to on its own", async () => {
    serverHits = 0;
    // The policy approves 127.0.0.2 (loopback, and the test hatch is on). `localhost`
    // would resolve to 127.0.0.1 by itself — where the server IS listening.
    const guarded = createPinnedFetch({
      resolve: async () => [LOOPBACK_ELSEWHERE],
      allowInsecureLoopback: true,
      allowedPorts: [serverPort],
      timeoutMs: 2_000,
    });

    // If the transport pinned the socket, this cannot reach the server.
    await expect(guarded(`http://localhost:${serverPort}/probe`)).rejects.toThrow();
    // The load-bearing assertion: a second resolution would have hit the server.
    expect(serverHits).toBe(0);
  });

  it("never opens a socket when the policy refuses the resolved address", async () => {
    serverHits = 0;
    // A public-looking hostname answered with link-local (the metadata shape).
    const guarded = createPinnedFetch({
      resolve: async () => ["169.254.169.254"],
      allowInsecureLoopback: false,
    });

    await expect(guarded(`http://attacker.example:${serverPort}/steal`)).rejects.toBeInstanceOf(
      OutboundPolicyError,
    );
    expect(serverHits).toBe(0);
  });

  it("refuses a mixed answer rather than racing to whichever address it likes", async () => {
    serverHits = 0;
    const guarded = createPinnedFetch({
      // One acceptable, one not: every answer must be acceptable, so this is refused
      // instead of dialling whichever the resolver happened to put first.
      resolve: async () => ["93.184.216.34", "169.254.169.254"],
      allowInsecureLoopback: true,
    });

    await expect(guarded(`http://localhost:${serverPort}/rebind`)).rejects.toBeInstanceOf(
      OutboundPolicyError,
    );
    expect(serverHits).toBe(0);
  });

  it("cannot be redirected to a destination the policy never classified", async () => {
    serverHits = 0;
    const redirector = createServer((_req, res) => {
      res.writeHead(302, { location: `http://${LOOPBACK_SERVER}:${serverPort}/steal` });
      res.end();
    });
    await new Promise<void>((resolve) => redirector.listen(0, LOOPBACK_SERVER, resolve));
    const address = redirector.address();
    if (address === null || typeof address === "string") throw new Error("no port");

    const guarded = createPinnedFetch({
      resolve: async () => [LOOPBACK_SERVER],
      allowInsecureLoopback: true,
      allowedPorts: [address.port],
    });

    // The 3xx is returned, never followed: following it would send the request to a
    // destination the policy never saw.
    const response = await guarded(`http://localhost:${address.port}/start`);
    expect(response.status).toBe(302);
    expect(serverHits).toBe(0);

    await new Promise<void>((resolve) => redirector.close(() => resolve()));
  });

  it("offers the approved addresses to both `all` and single lookups", () => {
    const lookup = createPinnedLookup(["93.184.216.34", "93.184.216.35"]);
    const single: unknown[] = [];
    const all: unknown[] = [];
    (lookup as unknown as (h: string, o: unknown, cb: (...a: unknown[]) => void) => void)(
      "example.com",
      {},
      (...args: unknown[]) => single.push(...args),
    );
    (lookup as unknown as (h: string, o: unknown, cb: (...a: unknown[]) => void) => void)(
      "example.com",
      { all: true },
      (...args: unknown[]) => all.push(...args),
    );

    expect(single[1]).toBe("93.184.216.34");
    expect(single[2]).toBe(4);
    expect(all[1]).toEqual([
      { address: "93.184.216.34", family: 4 },
      { address: "93.184.216.35", family: 4 },
    ]);
  });

  it("classifies IPv6 in the pinned lookup", () => {
    const lookup = createPinnedLookup(["2606:2800:220:1:248:1893:25c8:1946"]);
    const single: unknown[] = [];
    (lookup as unknown as (h: string, o: unknown, cb: (...a: unknown[]) => void) => void)(
      "example.com",
      {},
      (...args: unknown[]) => single.push(...args),
    );
    expect(single[2]).toBe(6);
  });

  it("surfaces a transport failure as a rejection, never a silent empty success", async () => {
    const guarded = createPinnedFetch({
      resolve: async () => [LOOPBACK_ELSEWHERE],
      allowInsecureLoopback: true,
      allowedPorts: [serverPort],
      timeoutMs: 1_000,
    });

    await expect(guarded(`http://localhost:${serverPort}/nothing`)).rejects.toThrow();
  });
});
