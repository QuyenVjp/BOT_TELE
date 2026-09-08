import { randomBytes } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { request as httpsRequest } from "node:https";
import { homedir } from "node:os";
import { join } from "node:path";

const NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const configDir = join(homedir(), ".config", "bot-tele-external-vault");
const stateDir = join(homedir(), ".local", "state", "bot-tele-external-vault");
const endpoint = new URL(process.env.BT_VAULT_ENDPOINT?.trim() || "https://127.0.0.1:8443");
const namespace = process.env.BT_VAULT_NAMESPACE?.trim() || "telegram-shop";
const tokenFile = process.env.BT_VAULT_TOKEN_FILE?.trim() || join(configDir, "token");
const caFile = process.env.BT_VAULT_CA_FILE?.trim() || join(configDir, "ca.crt");
const dataFile = process.env.BT_VAULT_DATA_FILE?.trim() || join(stateDir, "store.json");

if (
  endpoint.protocol !== "https:" ||
  !["127.0.0.1", "localhost"].includes(endpoint.hostname) ||
  endpoint.username ||
  endpoint.password ||
  endpoint.search ||
  endpoint.hash ||
  !NAME.test(namespace)
) {
  throw new Error("Invalid local external Vault acceptance configuration");
}

const tokenInfo = await stat(tokenFile);
if (!tokenInfo.isFile() || (tokenInfo.mode & 0o077) !== 0) {
  throw new Error("Local Vault token must be a private file");
}
const token = (await readFile(tokenFile, "utf8")).trim();
if (token.length < 32) throw new Error("Invalid local Vault token");
const ca = await readFile(caFile);

const basePath = endpoint.pathname === "/" ? "" : endpoint.pathname.replace(/\/$/, "");
const key = `accept-${randomBytes(8).toString("hex")}`;
const material = randomBytes(48).toString("base64url");
const expectedRef = `vault:${namespace}:asset:${key}`;
const secretPath = `${basePath}/v1/secrets/${encodeURIComponent(namespace)}/asset/${key}`;

function strictObject(body, keys) {
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const actual = Object.keys(parsed).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((value, index) => value !== expected[index])
  ) {
    return null;
  }
  return parsed;
}

function request(method, path, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), "utf8");
    const headers = {
      authorization: `Bearer ${token}`,
      accept: "application/json",
      ...(payload
        ? { "content-type": "application/json", "content-length": String(payload.length) }
        : {}),
    };
    const req = httpsRequest(
      {
        hostname: endpoint.hostname,
        port: endpoint.port || 443,
        method,
        path,
        headers,
        ca,
        timeout: 5_000,
      },
      (response) => {
        const chunks = [];
        let bytes = 0;
        response.on("data", (chunk) => {
          bytes += chunk.length;
          if (bytes > 70_000) {
            response.destroy(new Error("response-too-large"));
            return;
          }
          chunks.push(Buffer.from(chunk));
        });
        response.on("end", () => {
          resolve({
            status: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

let wrote = false;
try {
  const health = await request("GET", `${basePath}/healthz`);
  const healthBody = strictObject(health.body, ["status"]);
  if (health.status !== 200 || healthBody?.status !== "ok") throw new Error("health");

  const write = await request("PUT", secretPath, { material });
  const writeBody = strictObject(write.body, ["ref"]);
  if (![200, 201].includes(write.status) || writeBody?.ref !== expectedRef)
    throw new Error("write");
  wrote = true;

  const stored = await readFile(dataFile, "utf8");
  if (stored.includes(material)) throw new Error("plaintext-at-rest");

  const reveal = await request("GET", secretPath);
  const revealBody = strictObject(reveal.body, ["material"]);
  if (reveal.status !== 200 || revealBody?.material !== material) throw new Error("reveal");

  const deleted = await request("DELETE", secretPath);
  if (deleted.status !== 204 || deleted.body !== "") throw new Error("delete");
  wrote = false;

  const missing = await request("GET", secretPath);
  const missingBody = strictObject(missing.body, ["error"]);
  if (missing.status !== 404 || typeof missingBody?.error !== "string")
    throw new Error("post-delete");

  const persisted = JSON.parse(await readFile(dataFile, "utf8"));
  if (Object.keys(persisted.entries ?? {}).length !== 0) throw new Error("cleanup");

  console.log(
    "health=PASS write=PASS reveal=PASS at_rest_plaintext_absent=PASS delete=PASS post_delete=PASS cleanup=PASS",
  );
} catch {
  if (wrote) await request("DELETE", secretPath).catch(() => undefined);
  console.error("external_vault_acceptance=FAIL");
  process.exitCode = 1;
}
