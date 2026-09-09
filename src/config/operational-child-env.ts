const OPERATIONAL_KEYS = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "LC_MESSAGES",
  "TZ",
  "TERM",
  "COLORTERM",
  "NODE_EXTRA_CA_CERTS",
] as const;

/**
 * Node `--env-file` does not override pre-existing variables. Spawn production
 * children with operational keys only so the env file is the config source.
 */
export function operationalChildEnv(
  source: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of OPERATIONAL_KEYS) {
    const value = source[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}
