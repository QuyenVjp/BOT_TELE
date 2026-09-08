import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { chmod, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:https";
import { dirname, resolve } from "node:path";

const NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const MAX_MATERIAL_BYTES = 65_536;
const MAX_BODY_BYTES = MAX_MATERIAL_BYTES * 6 + 1_024;

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

function optional(name, fallback) {
  const value = process.env[name]?.trim();
  return value || fallback;
}

const bind = optional("BT_VAULT_BIND", "127.0.0.1");
const port = Number(optional("BT_VAULT_PORT", "8443"));
const namespace = optional("BT_VAULT_NAMESPACE", "telegram-shop");
const dataFile = resolve(required("BT_VAULT_DATA_FILE"));
const tokenFile = resolve(required("BT_VAULT_TOKEN_FILE"));
const masterKeyFile = resolve(required("BT_VAULT_MASTER_KEY_FILE"));
const tlsKeyFile = resolve(required("BT_VAULT_TLS_KEY_FILE"));
const tlsCertFile = resolve(required("BT_VAULT_TLS_CERT_FILE"));

if (
  !["127.0.0.1", "::1"].includes(bind) ||
  !Number.isInteger(port) ||
  port < 1 ||
  port > 65_535 ||
  !NAME.test(namespace)
) {
  throw new Error("Invalid local Vault configuration");
}

async function readPrivateFile(path, label) {
  const info = await stat(path);
  if (!info.isFile() || (info.mode & 0o077) !== 0) {
    throw new Error(`${label} must be a private file`);
  }
  return readFile(path);
}

const [tokenRaw, masterKeyRaw, tlsKey, tlsCert] = await Promise.all([
  readPrivateFile(tokenFile, "Vault token"),
  readPrivateFile(masterKeyFile, "Vault master key"),
  readPrivateFile(tlsKeyFile, "Vault TLS private key"),
  readFile(tlsCertFile),
]);

const token = tokenRaw.toString("utf8").trim();
const masterKey = Buffer.from(masterKeyRaw.toString("utf8").trim(), "base64");
if (token.length < 32 || masterKey.length !== 32)
  throw new Error("Invalid local Vault credentials");

function authOk(header) {
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return false;
  const supplied = Buffer.from(header.slice(7), "utf8");
  const expected = Buffer.from(token, "utf8");
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function sendJson(response, status, body) {
  const encoded = Buffer.from(JSON.stringify(body), "utf8");
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": String(encoded.length),
    "cache-control": "no-store",
  });
  response.end(encoded);
}

function sendError(response, status, message) {
  sendJson(response, status, { error: message });
}

async function readBody(request) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > MAX_BODY_BYTES) throw new Error("body-too-large");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, bytes);
}

function parseWriteBody(buffer) {
  let parsed;
  try {
    parsed = JSON.parse(buffer.toString("utf8"));
  } catch {
    return null;
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed) ||
    Object.keys(parsed).length !== 1 ||
    typeof parsed.material !== "string" ||
    parsed.material.length === 0 ||
    Buffer.byteLength(parsed.material, "utf8") > MAX_MATERIAL_BYTES
  ) {
    return null;
  }
  return parsed.material;
}

function encrypt(material) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", masterKey, iv);
  const ciphertext = Buffer.concat([cipher.update(material, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    v: 1,
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
}

function decrypt(entry) {
  if (
    typeof entry !== "object" ||
    entry === null ||
    entry.v !== 1 ||
    typeof entry.iv !== "string" ||
    typeof entry.tag !== "string" ||
    typeof entry.ciphertext !== "string"
  ) {
    throw new Error("invalid-store-entry");
  }
  const decipher = createDecipheriv("aes-256-gcm", masterKey, Buffer.from(entry.iv, "base64"));
  decipher.setAuthTag(Buffer.from(entry.tag, "base64"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(entry.ciphertext, "base64")),
    decipher.final(),
  ]);
  if (plaintext.length > MAX_MATERIAL_BYTES) throw new Error("invalid-store-entry");
  return plaintext.toString("utf8");
}

async function loadStore({ allowMissing = false } = {}) {
  try {
    const info = await stat(dataFile);
    if (!info.isFile() || (info.mode & 0o077) !== 0) throw new Error("unsafe-store-permissions");
    const raw = await readFile(dataFile, "utf8");
    const parsed = JSON.parse(raw);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      parsed.version !== 1 ||
      typeof parsed.entries !== "object" ||
      parsed.entries === null ||
      Array.isArray(parsed.entries)
    ) {
      throw new Error("invalid-store");
    }
    return parsed;
  } catch (error) {
    if (
      allowMissing &&
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return null;
    }
    throw error;
  }
}

async function persistStore(store) {
  const dataDir = dirname(dataFile);
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  await chmod(dataDir, 0o700);
  const temp = `${dataFile}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  await writeFile(temp, `${JSON.stringify(store)}\n`, { mode: 0o600 });
  await rename(temp, dataFile);
}

let store = await loadStore({ allowMissing: true });
if (store === null) {
  store = { version: 1, entries: {} };
  await persistStore(store);
}
for (const entry of Object.values(store.entries)) decrypt(entry);
let mutationQueue = Promise.resolve();

async function mutate(mutator) {
  let result;
  const operation = mutationQueue.then(async () => {
    const next = { version: store.version, entries: { ...store.entries } };
    result = mutator(next);
    await persistStore(next);
    store = next;
  });
  mutationQueue = operation.catch(() => undefined);
  await operation;
  return result;
}

function parseSecretPath(pathname) {
  const parts = pathname.split("/");
  if (parts.length !== 6 || parts[1] !== "v1" || parts[2] !== "secrets") return null;
  let requestedNamespace;
  let kind;
  let key;
  try {
    requestedNamespace = decodeURIComponent(parts[3]);
    kind = decodeURIComponent(parts[4]);
    key = decodeURIComponent(parts[5]);
  } catch {
    return null;
  }
  if (
    requestedNamespace !== namespace ||
    (kind !== "asset" && kind !== "capability") ||
    !NAME.test(key)
  ) {
    return null;
  }
  return { kind, key, id: `${requestedNamespace}:${kind}:${key}` };
}

const server = createServer({ key: tlsKey, cert: tlsCert }, async (request, response) => {
  response.setHeader("x-content-type-options", "nosniff");
  if (!authOk(request.headers.authorization)) {
    sendError(response, 401, "unauthorized");
    return;
  }

  const url = new URL(request.url ?? "/", "https://localhost");
  if (url.search || url.hash) {
    sendError(response, 400, "invalid request");
    return;
  }

  if (request.method === "GET" && url.pathname === "/healthz") {
    try {
      const durable = await loadStore();
      for (const entry of Object.values(durable.entries)) decrypt(entry);
      if (JSON.stringify(durable) !== JSON.stringify(store)) throw new Error("store-drift");
      sendJson(response, 200, { status: "ok" });
    } catch {
      sendError(response, 503, "unavailable");
    }
    return;
  }

  const parsedPath = parseSecretPath(url.pathname);
  if (!parsedPath) {
    sendError(response, 404, "not found");
    return;
  }

  try {
    if (request.method === "PUT") {
      if ((request.headers["content-type"] ?? "").split(";", 1)[0]?.trim() !== "application/json") {
        sendError(response, 415, "invalid content type");
        return;
      }
      const material = parseWriteBody(await readBody(request));
      if (material === null) {
        sendError(response, 400, "invalid request");
        return;
      }
      const existed = Object.hasOwn(store.entries, parsedPath.id);
      await mutate((draft) => {
        draft.entries[parsedPath.id] = encrypt(material);
      });
      sendJson(response, existed ? 200 : 201, {
        ref: `vault:${namespace}:${parsedPath.kind}:${parsedPath.key}`,
      });
      return;
    }

    if (request.method === "GET") {
      const entry = store.entries[parsedPath.id];
      if (!entry) {
        sendError(response, 404, "not found");
        return;
      }
      sendJson(response, 200, { material: decrypt(entry) });
      return;
    }

    if (request.method === "DELETE") {
      if (!Object.hasOwn(store.entries, parsedPath.id)) {
        sendError(response, 404, "not found");
        return;
      }
      await mutate((draft) => {
        delete draft.entries[parsedPath.id];
      });
      response.writeHead(204, { "cache-control": "no-store" });
      response.end();
      return;
    }
  } catch {
    sendError(response, 500, "unavailable");
    return;
  }

  sendError(response, 405, "method not allowed");
});

server.requestTimeout = 10_000;
server.headersTimeout = 5_000;
server.keepAliveTimeout = 2_000;
server.listen(port, bind, () => {
  const fingerprint = createHash("sha256").update(tlsCert).digest("hex").slice(0, 12);
  console.error(
    `external-vault acceptance server listening on ${bind}:${port} cert=${fingerprint}`,
  );
});
