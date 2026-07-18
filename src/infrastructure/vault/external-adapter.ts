import { lookup as dnsLookup } from "node:dns/promises";
import {
  request as httpRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type RequestOptions,
} from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { AppError } from "../../shared/errors/index.js";
import { newId } from "../../shared/ids/index.js";
import type { Vault, VaultRef, VaultWriteOptions } from "./port.js";

const NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
export const MAX_MATERIAL_BYTES = 65_536;
export const MAX_JSON_ENVELOPE_BYTES = MAX_MATERIAL_BYTES * 6 + 1_024;
const TRANSIENT_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

export interface ResolvedVaultAddress {
  address: string;
  family: 4 | 6;
}

export interface ExternalVaultEgressPolicy {
  allowedHosts: string[];
  allowedPorts: number[];
  allowedCidrs: string[];
}

export interface ExternalVaultTestTransport {
  allowInsecureLoopback?: boolean;
  resolveHost?: (hostname: string) => Promise<ResolvedVaultAddress[]>;
}

export interface ExternalVaultConfig {
  endpoint: string;
  token: string;
  namespace?: string;
  timeoutMs?: number;
  maxAttempts?: number;
  egressPolicy?: ExternalVaultEgressPolicy;
  testTransport?: ExternalVaultTestTransport;
}

interface ValidatedExternalVaultConfig {
  endpoint: URL;
  token: string;
  namespace: string;
  timeoutMs: number;
  maxAttempts: number;
  allowedHosts: ReadonlySet<string>;
  allowedPorts: ReadonlySet<number>;
  allowedCidrs: readonly ParsedCidr[];
  resolveHost: (hostname: string) => Promise<ResolvedVaultAddress[]>;
}

interface ParsedCidr {
  family: 4 | 6;
  bits: number;
  prefix: number;
  network: bigint;
}

interface VaultHttpResponse {
  status: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

export class ExternalVaultError extends AppError {
  constructor(code: "VALIDATION" | "NOT_FOUND" | "INTERNAL" = "INTERNAL") {
    super(code, code === "NOT_FOUND" ? "Secret is not available" : "External vault request failed");
    this.name = "ExternalVaultError";
  }
}

class TerminalExternalVaultError extends ExternalVaultError {}

function stripIpv6Brackets(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

function parseIpv4(address: string): bigint | null {
  const parts = address.split(".");
  if (parts.length !== 4) return null;
  let value = 0n;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const byte = Number(part);
    if (byte < 0 || byte > 255) return null;
    value = (value << 8n) | BigInt(byte);
  }
  return value;
}

function parseIpv6(address: string): bigint | null {
  if (address.includes("%")) return null;
  let normalized = address.toLowerCase();
  const ipv4Match = normalized.match(/(?:^|:)(\d+\.\d+\.\d+\.\d+)$/);
  if (ipv4Match?.[1]) {
    const ipv4 = parseIpv4(ipv4Match[1]);
    if (ipv4 === null) return null;
    normalized = `${normalized.slice(0, -ipv4Match[1].length)}${Number((ipv4 >> 16n) & 0xffffn).toString(16)}:${Number(ipv4 & 0xffffn).toString(16)}`;
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

function parseIp(address: string): { family: 4 | 6; bits: number; value: bigint } | null {
  const family = isIP(address);
  if (family === 4) {
    const value = parseIpv4(address);
    return value === null ? null : { family: 4, bits: 32, value };
  }
  if (family === 6) {
    const value = parseIpv6(address);
    return value === null ? null : { family: 6, bits: 128, value };
  }
  return null;
}

function parseCidr(value: string): ParsedCidr | null {
  const [address, prefixText, ...extra] = value.trim().split("/");
  if (!address || !prefixText || extra.length > 0 || !/^\d{1,3}$/.test(prefixText)) return null;
  const parsed = parseIp(address);
  const prefix = Number(prefixText);
  if (!parsed || prefix < 0 || prefix > parsed.bits) return null;
  const shift = BigInt(parsed.bits - prefix);
  return {
    family: parsed.family,
    bits: parsed.bits,
    prefix,
    network: shift === 0n ? parsed.value : (parsed.value >> shift) << shift,
  };
}

function addressAllowed(address: string, cidrs: readonly ParsedCidr[]): boolean {
  const parsed = parseIp(address);
  if (!parsed) return false;
  return cidrs.some((cidr) => {
    if (cidr.family !== parsed.family || cidr.bits !== parsed.bits) return false;
    const shift = BigInt(parsed.bits - cidr.prefix);
    const network = shift === 0n ? parsed.value : (parsed.value >> shift) << shift;
    return network === cidr.network;
  });
}

async function defaultResolveHost(hostname: string): Promise<ResolvedVaultAddress[]> {
  const literal = stripIpv6Brackets(hostname);
  const family = isIP(literal);
  if (family === 4 || family === 6) return [{ address: literal, family }];
  const rows = await dnsLookup(literal, { all: true, verbatim: true });
  return rows
    .filter(
      (row): row is { address: string; family: 4 | 6 } => row.family === 4 || row.family === 6,
    )
    .map((row) => ({ address: row.address, family: row.family }));
}

function isLoopbackHost(hostname: string): boolean {
  const host = stripIpv6Brackets(hostname).toLowerCase();
  if (host === "localhost" || host === "::1") return true;
  const ipv4 = parseIpv4(host);
  return ipv4 !== null && ipv4 >> 24n === 127n;
}

function effectivePort(url: URL): number {
  if (url.port) return Number(url.port);
  return url.protocol === "https:" ? 443 : 80;
}

function validateConfig(config: ExternalVaultConfig): ValidatedExternalVaultConfig {
  const token = config.token.trim();
  const namespace = config.namespace?.trim() || "telegram-shop";
  const timeoutMs = config.timeoutMs ?? 5_000;
  const maxAttempts = config.maxAttempts ?? 3;
  let endpoint: URL;
  try {
    endpoint = new URL(config.endpoint.trim());
  } catch {
    throw new ExternalVaultError("VALIDATION");
  }
  const hostname = stripIpv6Brackets(endpoint.hostname).toLowerCase();
  const port = effectivePort(endpoint);
  const policy = config.egressPolicy;
  const allowedHosts = new Set(
    (policy?.allowedHosts ?? []).map((host) => host.trim().toLowerCase()),
  );
  const allowedPorts = new Set(policy?.allowedPorts ?? []);
  const allowedCidrs = (policy?.allowedCidrs ?? []).map(parseCidr);
  const loopbackTest =
    config.testTransport?.allowInsecureLoopback === true && isLoopbackHost(hostname);

  if (
    !token ||
    !NAME.test(namespace) ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 10 ||
    timeoutMs > 30_000 ||
    !Number.isInteger(maxAttempts) ||
    maxAttempts < 1 ||
    maxAttempts > 5 ||
    endpoint.username.length > 0 ||
    endpoint.password.length > 0 ||
    endpoint.search.length > 0 ||
    endpoint.hash.length > 0 ||
    (endpoint.protocol !== "https:" && !(endpoint.protocol === "http:" && loopbackTest)) ||
    !policy ||
    allowedHosts.size === 0 ||
    !allowedHosts.has(hostname) ||
    allowedPorts.size === 0 ||
    !allowedPorts.has(port) ||
    allowedCidrs.length === 0 ||
    allowedCidrs.some((cidr) => cidr === null)
  ) {
    throw new ExternalVaultError("VALIDATION");
  }

  endpoint.pathname = endpoint.pathname.replace(/\/+$/, "");
  return {
    endpoint,
    token,
    namespace,
    timeoutMs,
    maxAttempts,
    allowedHosts,
    allowedPorts,
    allowedCidrs: allowedCidrs as ParsedCidr[],
    resolveHost: config.testTransport?.resolveHost ?? defaultResolveHost,
  };
}

function pathFor(namespace: string, kind: string, key: string): string {
  return `/v1/secrets/${encodeURIComponent(namespace)}/${encodeURIComponent(kind)}/${encodeURIComponent(key)}`;
}

function parseOwnedRef(
  ref: VaultRef,
  namespace: string,
): { kind: string; key: string; path: string } {
  const parts = ref.split(":");
  if (
    parts.length !== 4 ||
    parts[0] !== "vault" ||
    parts[1] !== namespace ||
    (parts[2] !== "asset" && parts[2] !== "capability") ||
    !parts[3] ||
    !NAME.test(parts[3])
  ) {
    throw new ExternalVaultError("VALIDATION");
  }
  return { kind: parts[2], key: parts[3], path: pathFor(namespace, parts[2], parts[3]) };
}

function contentType(headers: IncomingHttpHeaders): string | null {
  const raw = headers["content-type"];
  if (Array.isArray(raw) || typeof raw !== "string") return null;
  return raw.split(";", 1)[0]?.trim().toLowerCase() ?? null;
}

function parseStrictJson(response: VaultHttpResponse): unknown {
  if (contentType(response.headers) !== "application/json" || response.body.length === 0) {
    throw new ExternalVaultError();
  }
  try {
    return JSON.parse(response.body.toString("utf8")) as unknown;
  } catch {
    throw new ExternalVaultError();
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateProviderError(response: VaultHttpResponse): void {
  const body = parseStrictJson(response);
  if (
    !isObject(body) ||
    typeof body.error !== "string" ||
    body.error.length < 1 ||
    body.error.length > 128 ||
    Object.keys(body).some((field) => field !== "error")
  ) {
    throw new ExternalVaultError();
  }
}

async function withDeadline<T>(promise: Promise<T>, deadlineAt: number): Promise<T> {
  const remaining = deadlineAt - Date.now();
  if (remaining <= 0) throw new ExternalVaultError();
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new ExternalVaultError()), remaining);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function resolveApprovedAddresses(
  config: ValidatedExternalVaultConfig,
  deadlineAt: number,
): Promise<ResolvedVaultAddress[]> {
  const hostname = stripIpv6Brackets(config.endpoint.hostname).toLowerCase();
  if (
    !config.allowedHosts.has(hostname) ||
    !config.allowedPorts.has(effectivePort(config.endpoint))
  ) {
    throw new ExternalVaultError("VALIDATION");
  }
  const addresses = await withDeadline(config.resolveHost(hostname), deadlineAt);
  if (
    addresses.length === 0 ||
    addresses.some(
      (row) =>
        (row.family !== 4 && row.family !== 6) ||
        isIP(row.address) !== row.family ||
        !addressAllowed(row.address, config.allowedCidrs),
    )
  ) {
    throw new ExternalVaultError("VALIDATION");
  }
  return addresses;
}

async function readBoundedBody(response: IncomingMessage): Promise<Buffer> {
  const declared = response.headers["content-length"];
  if (Array.isArray(declared)) {
    response.destroy();
    throw new ExternalVaultError();
  }
  if (typeof declared === "string") {
    const parsed = Number(declared);
    if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > MAX_JSON_ENVELOPE_BYTES) {
      response.destroy();
      throw new ExternalVaultError();
    }
  }
  const chunks: Buffer[] = [];
  let bytes = 0;
  try {
    for await (const chunk of response) {
      const buffer = Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > MAX_JSON_ENVELOPE_BYTES) {
        response.destroy();
        throw new ExternalVaultError();
      }
      chunks.push(buffer);
    }
  } catch (error) {
    response.destroy();
    if (error instanceof ExternalVaultError) throw error;
    throw new ExternalVaultError();
  }
  return Buffer.concat(chunks, bytes);
}

async function executeRequest<T>(
  config: ValidatedExternalVaultConfig,
  path: string,
  method: "GET" | "PUT" | "DELETE",
  body: Buffer | undefined,
  consume: (response: VaultHttpResponse) => T,
): Promise<T> {
  const deadlineAt = Date.now() + config.timeoutMs;
  const addresses = await resolveApprovedAddresses(config, deadlineAt);
  const selected = addresses[0];
  if (!selected) throw new ExternalVaultError();
  const target = new URL(config.endpoint);
  const basePath = target.pathname === "/" ? "" : target.pathname.replace(/\/+$/, "");
  target.pathname = `${basePath}${path}`;
  target.search = "";
  target.hash = "";

  type LookupOneCallback = (
    error: NodeJS.ErrnoException | null,
    address: string,
    family: 4 | 6,
  ) => void;
  type LookupAllCallback = (
    error: NodeJS.ErrnoException | null,
    addresses: ResolvedVaultAddress[],
  ) => void;
  const pinnedLookup = ((
    _hostname: string,
    options: unknown,
    callback: LookupOneCallback | LookupAllCallback,
  ) => {
    const wantsAll =
      typeof options === "object" && options !== null && "all" in options && options.all === true;
    if (wantsAll) {
      (callback as LookupAllCallback)(null, addresses);
    } else {
      (callback as LookupOneCallback)(null, selected.address, selected.family);
    }
  }) as unknown as LookupFunction;

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = { current: undefined as NodeJS.Timeout | undefined };
    const finish = (error: ExternalVaultError | null, result?: T): void => {
      if (settled) return;
      settled = true;
      if (timer.current) clearTimeout(timer.current);
      if (error) reject(error);
      else resolve(result as T);
    };
    const options: RequestOptions = {
      method,
      agent: false,
      lookup: pinnedLookup,
      headers: {
        accept: "application/json",
        authorization: `Bearer ${config.token}`,
        ...(body
          ? { "content-type": "application/json", "content-length": String(body.length) }
          : {}),
      },
    };
    const transport = target.protocol === "https:" ? httpsRequest : httpRequest;
    const request = transport(target, options, (response) => {
      void readBoundedBody(response)
        .then((responseBody) => {
          if (settled) return;
          try {
            const result = consume({
              status: response.statusCode ?? 0,
              headers: response.headers,
              body: responseBody,
            });
            if (Date.now() > deadlineAt) throw new ExternalVaultError();
            finish(null, result);
          } catch (error) {
            response.destroy();
            finish(error instanceof ExternalVaultError ? error : new ExternalVaultError());
          }
        })
        .catch((error: unknown) => {
          response.destroy();
          finish(error instanceof ExternalVaultError ? error : new ExternalVaultError());
        });
    });
    request.on("error", () => finish(new ExternalVaultError()));
    const remaining = deadlineAt - Date.now();
    if (remaining <= 0) {
      request.destroy();
      finish(new ExternalVaultError());
      return;
    }
    timer.current = setTimeout(() => {
      request.destroy();
      finish(new ExternalVaultError());
    }, remaining);
    request.end(body);
  });
}

export function createExternalVault(input: ExternalVaultConfig): Vault {
  const config = validateConfig(input);

  const request = async <T>(
    path: string,
    method: "GET" | "PUT" | "DELETE",
    body: Buffer | undefined,
    accepted: ReadonlySet<number>,
    decodeSuccess: (response: VaultHttpResponse) => T,
  ): Promise<T> => {
    for (let attempt = 1; attempt <= config.maxAttempts; attempt += 1) {
      try {
        return await executeRequest(config, path, method, body, (response) => {
          if (accepted.has(response.status)) {
            try {
              return decodeSuccess(response);
            } catch {
              throw new TerminalExternalVaultError();
            }
          }
          try {
            validateProviderError(response);
          } catch {
            throw new TerminalExternalVaultError();
          }
          if (response.status === 404) throw new ExternalVaultError("NOT_FOUND");
          if (!TRANSIENT_STATUSES.has(response.status)) throw new TerminalExternalVaultError();
          throw new ExternalVaultError();
        });
      } catch (error) {
        if (error instanceof ExternalVaultError && error.code === "VALIDATION") throw error;
        if (error instanceof ExternalVaultError && error.code === "NOT_FOUND") throw error;
        if (error instanceof TerminalExternalVaultError) throw new ExternalVaultError();
        if (attempt === config.maxAttempts) throw new ExternalVaultError();
      }
      await new Promise((resolve) => setTimeout(resolve, Math.min(25 * 2 ** (attempt - 1), 100)));
    }
    throw new ExternalVaultError();
  };

  return {
    async health(): Promise<void> {
      await request("/healthz", "GET", undefined, new Set([200]), (response) => {
        const payload = parseStrictJson(response);
        if (
          !isObject(payload) ||
          payload.status !== "ok" ||
          Object.keys(payload).some((key) => key !== "status")
        ) {
          throw new ExternalVaultError();
        }
      });
    },

    async write(material: string, options?: VaultWriteOptions): Promise<VaultRef> {
      if (
        typeof material !== "string" ||
        material.length === 0 ||
        Buffer.byteLength(material, "utf8") > MAX_MATERIAL_BYTES
      ) {
        throw new ExternalVaultError("VALIDATION");
      }
      const kind = options?.namespace ?? "asset";
      const key = options?.idempotencyKey ?? newId();
      if (!NAME.test(key)) throw new ExternalVaultError("VALIDATION");
      const expectedRef = `vault:${config.namespace}:${kind}:${key}`;
      const serialized = Buffer.from(JSON.stringify({ material }), "utf8");
      if (serialized.length > MAX_JSON_ENVELOPE_BYTES) {
        throw new ExternalVaultError("VALIDATION");
      }
      return request(
        pathFor(config.namespace, kind, key),
        "PUT",
        serialized,
        new Set([200, 201]),
        (response): VaultRef => {
          const payload = parseStrictJson(response);
          if (
            !isObject(payload) ||
            payload.ref !== expectedRef ||
            Object.keys(payload).some((field) => field !== "ref")
          ) {
            throw new ExternalVaultError();
          }
          return expectedRef;
        },
      );
    },

    async reveal(ref: VaultRef): Promise<string> {
      const owned = parseOwnedRef(ref, config.namespace);
      return request(owned.path, "GET", undefined, new Set([200]), (response) => {
        const payload = parseStrictJson(response);
        if (
          !isObject(payload) ||
          typeof payload.material !== "string" ||
          Buffer.byteLength(payload.material, "utf8") > MAX_MATERIAL_BYTES ||
          Object.keys(payload).some((field) => field !== "material")
        ) {
          throw new ExternalVaultError();
        }
        return payload.material;
      });
    },

    async delete(ref: VaultRef): Promise<void> {
      const owned = parseOwnedRef(ref, config.namespace);
      await request(owned.path, "DELETE", undefined, new Set([204, 404]), (response) => {
        if (response.status === 204) {
          if (response.body.length !== 0) throw new ExternalVaultError();
          return;
        }
        validateProviderError(response);
      });
    },
  };
}
