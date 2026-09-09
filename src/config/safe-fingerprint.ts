export type DatabaseFingerprint = { host: string; port: string; database: string; user: string };

/** Parse a PostgreSQL URL without ever returning its password. */
export function parseDatabaseUrl(url: string): DatabaseFingerprint {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("DATABASE_URL must be a valid URL");
  }
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new Error("DATABASE_URL must use postgres://");
  }
  const database = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  if (!parsed.hostname || !database) throw new Error("DATABASE_URL must include host and database");
  return {
    host: parsed.hostname,
    port: parsed.port || "5432",
    database,
    user: decodeURIComponent(parsed.username),
  };
}

export function formatDatabaseFingerprint(fp: DatabaseFingerprint): string {
  return `${fp.host}:${fp.port}/${fp.database}`;
}

export function parseRedisUrl(url: string): { host: string; port: string } | null {
  if (!url?.trim()) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "redis:" && parsed.protocol !== "rediss:") return null;
  if (!parsed.hostname) return null;
  return { host: parsed.hostname, port: parsed.port || "6379" };
}

export function parseEndpointHost(url: string): string | null {
  if (!url?.trim()) return null;
  try {
    return new URL(url).hostname || null;
  } catch {
    return null;
  }
}

export function secretStatus(value: string | undefined | null): "CONFIGURED" | "MISSING" {
  return value?.trim() ? "CONFIGURED" : "MISSING";
}

/** Small Node dotenv-compatible parser for the values needed by operational tooling. */
export function parseDotenvFile(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!match) continue;
    const key = match[1]!;
    let value = match[2]!;
    if (value.startsWith('"')) {
      let out = "";
      let escaped = false;
      let closed = false;
      for (let i = 1; i < value.length; i++) {
        const char = value[i]!;
        if (escaped) {
          out += char === "n" ? "\n" : char === "r" ? "\r" : char === "t" ? "\t" : char;
          escaped = false;
        } else if (char === "\\") escaped = true;
        else if (char === '"') {
          closed = true;
          break;
        } else out += char;
      }
      result[key] = out;
      if (!closed) result[key] = out;
      continue;
    }
    if (value.startsWith("'")) {
      const end = value.indexOf("'", 1);
      result[key] = end < 0 ? value.slice(1) : value.slice(1, end);
      continue;
    }
    const comment = value.search(/\s+#/);
    if (comment >= 0) value = value.slice(0, comment);
    result[key] = value.trim();
  }
  return result;
}
