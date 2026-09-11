import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";

/**
 * Outbound HTTP security policy (SSRF defence).
 *
 * Every outbound request in this codebase resolves its hostname and classifies
 * *each* resolved address before any socket is opened. A hostname that resolves
 * to loopback, RFC1918, link-local, multicast, unspecified, cloud metadata, or
 * any other non-public range is refused — a validated base URL string is never
 * sufficient, because DNS can point anywhere (rebinding).
 *
 * The two escape hatches exist for tests and for explicitly allowlisted
 * operator egress (`allowedCidrs`); they are opt-in and default-closed.
 */

export type AddressClass =
  | "public"
  | "loopback"
  | "private"
  | "link-local"
  | "multicast"
  | "unspecified"
  | "reserved"
  | "metadata";

export interface OutboundPolicyOptions {
  /** Test-only escape hatch: allow http:// to 127.0.0.1/localhost. */
  allowInsecureLoopback?: boolean;
  /** Extra ports allowed on top of https(443)/http(80). Default 443 (+80 when loopback test mode). */
  allowedPorts?: readonly number[];
  /** If non-empty, hostname must match one of these exactly (case-insensitive, no wildcards). */
  allowedHosts?: readonly string[];
  /** If non-empty, every resolved address must fall inside one of these CIDRs. */
  allowedCidrs?: readonly string[];
}

export type OutboundPolicyCode =
  | "MALFORMED_URL"
  | "SCHEME_NOT_ALLOWED"
  | "CREDENTIALS_IN_URL"
  | "QUERY_OR_HASH_NOT_ALLOWED"
  | "PORT_NOT_ALLOWED"
  | "HOST_NOT_ALLOWED"
  | "ADDRESS_NOT_ALLOWED"
  | "DNS_RESOLUTION_FAILED"
  | "CIDR_NOT_ALLOWED";

export class OutboundPolicyError extends Error {
  readonly code: OutboundPolicyCode;

  constructor(code: OutboundPolicyCode, message: string) {
    super(message);
    this.name = "OutboundPolicyError";
    this.code = code;
  }
}

const V4_LOOPBACK = 0x7f000000; // 127.0.0.0/8
const V4_PRIVATE_10 = 0x0a000000; // 10.0.0.0/8
const V4_PRIVATE_172 = 0xac100000; // 172.16.0.0/12
const V4_PRIVATE_192 = 0xc0a80000; // 192.168.0.0/16
const V4_METADATA = 0xa9fea9fe; // 169.254.169.254
const V4_LINK_LOCAL = 0xa9fe0000; // 169.254.0.0/16
const V4_MULTICAST = 0xe0000000; // 224.0.0.0/4
const V4_RESERVED: ReadonlyArray<readonly [number, number]> = [
  [0x00000000, 8], // 0.0.0.0/8 "this network"
  [0x64400000, 10], // 100.64.0.0/10 CGNAT
  [0xc0000000, 24], // 192.0.0.0/24
  [0xc0000200, 24], // 192.0.2.0/24 TEST-NET-1
  [0xc0586300, 24], // 192.88.99.0/24 6to4 relay anycast
  [0xc6120000, 15], // 198.18.0.0/15 benchmarking
  [0xc6336400, 24], // 198.51.100.0/24 TEST-NET-2
  [0xcb007100, 24], // 203.0.113.0/24 TEST-NET-3
  [0xf0000000, 4], // 240.0.0.0/4 (includes 255.255.255.255)
];

const V6_LOOPBACK = 1n; // ::1
const V6_METADATA = (0xfd00n << 112n) | (0x0ec2n << 96n) | 0x254n; // fd00:ec2::254
const V6_PRIVATE = 0xfc00n << 112n; // fc00::/7
const V6_LINK_LOCAL = 0xfe80n << 112n; // fe80::/10
const V6_MULTICAST = 0xff00n << 112n; // ff00::/8
const V6_NAT64 = 0x64ff9bn << 96n; // 64:ff9b::/96
const V6_DOCUMENTATION = 0x20010db8n << 96n; // 2001:db8::/32
const V6_GLOBAL_UNICAST = 0x2000n << 112n; // 2000::/3
const V6_IPV4_MAPPED_TOP = 0xffffn; // ::ffff:0:0/96 top 96 bits

function ipv4ToNumber(address: string): number | null {
  const parts = address.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const byte = Number(part);
    if (byte > 255) return null;
    value = ((value << 8) | byte) >>> 0;
  }
  return value;
}

function ipv6ToBigInt(address: string): bigint | null {
  if (address.includes("%")) return null;
  let normalized = address.toLowerCase();
  const embedded = normalized.match(/(?:^|:)(\d+\.\d+\.\d+\.\d+)$/);
  if (embedded?.[1]) {
    const ipv4 = ipv4ToNumber(embedded[1]);
    if (ipv4 === null) return null;
    const high = ((ipv4 >>> 16) & 0xffff).toString(16);
    const low = (ipv4 & 0xffff).toString(16);
    normalized = `${normalized.slice(0, -embedded[1].length)}${high}:${low}`;
  }
  const halves = normalized.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves[1] ? halves[1].split(":") : [];
  const missing = halves.length === 2 ? 8 - left.length - right.length : 0;
  if (missing < 0 || (halves.length === 1 && left.length !== 8)) return null;
  const groups = [...left, ...Array<string>(missing).fill("0"), ...right];
  if (groups.length !== 8) return null;
  let value = 0n;
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
    value = (value << 16n) | BigInt(`0x${group}`);
  }
  return value;
}

interface ParsedAddress {
  family: 4 | 6;
  value: bigint;
}

function parseAddress(address: string): ParsedAddress | null {
  const family = isIP(address);
  if (family === 4) {
    const value = ipv4ToNumber(address);
    return value === null ? null : { family: 4, value: BigInt(value) };
  }
  if (family === 6) {
    const value = ipv6ToBigInt(address);
    return value === null ? null : { family: 6, value };
  }
  return null;
}

function ipv4InRange(value: number, network: number, prefix: number): boolean {
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (value & mask) >>> 0 === network;
}

function ipv6InRange(value: bigint, network: bigint, prefix: number): boolean {
  const shift = BigInt(128 - prefix);
  return value >> shift === network >> shift;
}

function classifyIpv4(value: number): AddressClass {
  if (value === 0) return "unspecified";
  if (value === V4_METADATA) return "metadata";
  if (ipv4InRange(value, V4_LOOPBACK, 8)) return "loopback";
  if (
    ipv4InRange(value, V4_PRIVATE_10, 8) ||
    ipv4InRange(value, V4_PRIVATE_172, 12) ||
    ipv4InRange(value, V4_PRIVATE_192, 16)
  ) {
    return "private";
  }
  if (ipv4InRange(value, V4_LINK_LOCAL, 16)) return "link-local";
  if (ipv4InRange(value, V4_MULTICAST, 4)) return "multicast";
  if (V4_RESERVED.some(([network, prefix]) => ipv4InRange(value, network, prefix))) {
    return "reserved";
  }
  return "public";
}

function classifyIpv6(value: bigint): AddressClass {
  if (value === 0n) return "unspecified";
  if (value === V6_LOOPBACK) return "loopback";
  if (value >> 32n === V6_IPV4_MAPPED_TOP) return classifyIpv4(Number(value & 0xffffffffn));
  if (value === V6_METADATA) return "metadata";
  if (ipv6InRange(value, V6_PRIVATE, 7)) return "private";
  if (ipv6InRange(value, V6_LINK_LOCAL, 10)) return "link-local";
  if (ipv6InRange(value, V6_MULTICAST, 8)) return "multicast";
  if (ipv6InRange(value, V6_NAT64, 96)) return "reserved";
  if (ipv6InRange(value, V6_DOCUMENTATION, 32)) return "reserved";
  if (ipv6InRange(value, V6_GLOBAL_UNICAST, 3)) return "public";
  return "reserved";
}

/** Classify one IP literal (v4 or v6). Returns "reserved" for anything unclassifiable-but-not-public. */
export function classifyAddress(address: string): AddressClass {
  const parsed = parseAddress(address);
  if (!parsed) return "reserved";
  return parsed.family === 4 ? classifyIpv4(Number(parsed.value)) : classifyIpv6(parsed.value);
}

interface ParsedCidr {
  family: 4 | 6;
  bits: number;
  prefix: number;
  network: bigint;
}

function parseCidr(spec: string): ParsedCidr | null {
  const [address, prefixText, ...extra] = spec.trim().split("/");
  if (!address || !prefixText || extra.length > 0 || !/^\d{1,3}$/.test(prefixText)) return null;
  const parsed = parseAddress(address);
  if (!parsed) return null;
  const bits = parsed.family === 4 ? 32 : 128;
  const prefix = Number(prefixText);
  if (prefix > bits) return null;
  const shift = BigInt(bits - prefix);
  return { family: parsed.family, bits, prefix, network: (parsed.value >> shift) << shift };
}

function cidrContains(cidr: ParsedCidr, address: string): boolean {
  const parsed = parseAddress(address);
  if (!parsed || parsed.family !== cidr.family) return false;
  const shift = BigInt(cidr.bits - cidr.prefix);
  return (parsed.value >> shift) << shift === cidr.network;
}

function normalizeHostname(hostname: string): string {
  const bare =
    hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  return bare.toLowerCase();
}

function isLoopbackHostname(hostname: string): boolean {
  const host = normalizeHostname(hostname);
  if (host === "localhost") return true;
  const parsed = parseAddress(host);
  if (!parsed) return false;
  return parsed.family === 4 ? parsed.value >> 24n === 127n : parsed.value === V6_LOOPBACK;
}

/** Normalize + statically validate the URL (no DNS). Throws OutboundPolicyError. */
export function parseOutboundUrl(rawUrl: string, options: OutboundPolicyOptions = {}): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new OutboundPolicyError("MALFORMED_URL", "outbound URL is malformed");
  }
  if (url.username || url.password) {
    throw new OutboundPolicyError("CREDENTIALS_IN_URL", "outbound URL must not embed credentials");
  }
  if (url.search || url.hash) {
    throw new OutboundPolicyError(
      "QUERY_OR_HASH_NOT_ALLOWED",
      "outbound URL must not carry a query or fragment",
    );
  }
  const loopback = options.allowInsecureLoopback === true && isLoopbackHostname(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new OutboundPolicyError("SCHEME_NOT_ALLOWED", "outbound scheme is not allowed");
  }
  const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
  const allowedPorts = new Set<number>([
    443,
    ...(options.allowInsecureLoopback === true ? [80] : []),
    ...(options.allowedPorts ?? []),
  ]);
  if (!Number.isInteger(port) || !allowedPorts.has(port)) {
    throw new OutboundPolicyError("PORT_NOT_ALLOWED", "outbound port is not allowed");
  }
  if (options.allowedHosts && options.allowedHosts.length > 0) {
    const host = normalizeHostname(url.hostname);
    const allowed = new Set(options.allowedHosts.map(normalizeHostname));
    if (!allowed.has(host)) {
      throw new OutboundPolicyError("HOST_NOT_ALLOWED", "outbound host is not allowed");
    }
  }
  return url;
}

async function defaultResolve(hostname: string): Promise<readonly string[]> {
  const rows = await dnsLookup(hostname, { all: true });
  return rows.map((row) => row.address);
}

/** Static checks + DNS resolution + per-address classification. Throws OutboundPolicyError. */
export async function assertOutboundTargetAllowed(
  rawUrl: string,
  options: OutboundPolicyOptions = {},
  deps: { resolve?: (hostname: string) => Promise<readonly string[]> } = {},
): Promise<{ url: URL; addresses: readonly string[] }> {
  const url = parseOutboundUrl(rawUrl, options);
  const hostname = normalizeHostname(url.hostname);
  const literal = isIP(hostname) !== 0 ? hostname : null;
  let addresses: readonly string[];
  if (literal) {
    addresses = [literal];
  } else {
    const resolve = deps.resolve ?? defaultResolve;
    try {
      addresses = await resolve(hostname);
    } catch {
      throw new OutboundPolicyError(
        "DNS_RESOLUTION_FAILED",
        "outbound hostname could not be resolved",
      );
    }
    if (!addresses || addresses.length === 0) {
      throw new OutboundPolicyError(
        "DNS_RESOLUTION_FAILED",
        "outbound hostname did not resolve to any address",
      );
    }
  }
  const cidrSpecs = options.allowedCidrs ?? [];
  const cidrs = cidrSpecs.map(parseCidr);
  if (cidrs.some((cidr) => cidr === null)) {
    throw new OutboundPolicyError("CIDR_NOT_ALLOWED", "outbound CIDR allowlist is invalid");
  }
  const parsedCidrs = cidrs as ParsedCidr[];
  for (const address of addresses) {
    const classified = classifyAddress(address);
    const loopbackEscape = classified === "loopback" && options.allowInsecureLoopback === true;
    const allowed =
      (parsedCidrs.length > 0 && parsedCidrs.some((cidr) => cidrContains(cidr, address))) ||
      loopbackEscape ||
      (parsedCidrs.length === 0 && classified === "public");
    if (!allowed) {
      throw new OutboundPolicyError(
        parsedCidrs.length > 0 ? "CIDR_NOT_ALLOWED" : "ADDRESS_NOT_ALLOWED",
        "outbound address is not allowed",
      );
    }
  }
  return { url, addresses };
}

/**
 * A `fetch` wrapper that re-validates the target, resolves DNS, verifies EVERY
 * resolved address, then delegates to the supplied/global fetch. Redirects must
 * stay disabled (`redirect: "error"`) — this wrapper forces it.
 */
export function createGuardedFetch(
  options: OutboundPolicyOptions & {
    fetchImpl?: typeof fetch;
    resolve?: (hostname: string) => Promise<readonly string[]>;
  },
): typeof fetch {
  const { fetchImpl, resolve, ...policy } = options;
  const delegate = fetchImpl ?? fetch;
  const guarded = async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ): Promise<Response> => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    await assertOutboundTargetAllowed(raw, policy, resolve ? { resolve } : undefined);
    return delegate(input, { ...init, redirect: "error" });
  };
  return guarded as typeof fetch;
}
