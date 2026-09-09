import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface BuildIdentity {
  commit: string;
  builtAt: string;
  dirty: boolean;
}

export function loadBuildIdentity(fromUrl: string): BuildIdentity | null {
  try {
    const raw = readFileSync(join(dirname(fileURLToPath(fromUrl)), "build-identity.json"), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    const record = parsed as {
      commit?: unknown;
      builtAt?: unknown;
      dirty?: unknown;
    };
    if (typeof record.commit !== "string" || !/^[0-9a-f]{40}$/.test(record.commit)) return null;
    if (typeof record.builtAt !== "string" || !/^\d{4}-\d{2}-\d{2}T/.test(record.builtAt))
      return null;
    if (typeof record.dirty !== "boolean") return null;
    return { commit: record.commit, builtAt: record.builtAt, dirty: record.dirty };
  } catch {
    return null;
  }
}

export function healthPayload(identity: BuildIdentity | null): {
  status: "ok";
  commit?: string;
  builtAt?: string;
  dirty?: boolean;
} {
  if (!identity) return { status: "ok" };
  return {
    status: "ok",
    commit: identity.commit,
    builtAt: identity.builtAt,
    dirty: identity.dirty,
  };
}
