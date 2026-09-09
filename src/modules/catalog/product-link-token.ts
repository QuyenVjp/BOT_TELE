import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const START_PREFIX = "product_";
const PURPOSE_KS = "tier20:product-link:v1:ks";
const PURPOSE_MAC = "tier20:product-link:v1:mac";
const ULID_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const NONCE_BYTES = 8;
const EXP_BYTES = 4;
const ID_BYTES = 16;
const MAC_BYTES = 8;
const BODY_BYTES = NONCE_BYTES + EXP_BYTES + ID_BYTES + MAC_BYTES;

export type ProductLinkTokenOptions = { secret: string; ttlSeconds?: number; now?: () => number };

function encodeUlid(value: string): Buffer {
  let numeric = 0n;
  for (const character of value) {
    const digit = ULID_ALPHABET.indexOf(character);
    if (digit < 0) throw new Error("INVALID_PRODUCT_ID");
    numeric = numeric * 32n + BigInt(digit);
  }
  const bytes = Buffer.alloc(ID_BYTES);
  for (let index = ID_BYTES - 1; index >= 0; index--) {
    bytes[index] = Number(numeric & 0xffn);
    numeric >>= 8n;
  }
  return bytes;
}

function decodeUlid(bytes: Buffer): string {
  let numeric = 0n;
  for (const byte of bytes) numeric = (numeric << 8n) | BigInt(byte);
  let value = "";
  for (let index = 0; index < 26; index++) {
    value = ULID_ALPHABET[Number(numeric & 31n)]! + value;
    numeric >>= 5n;
  }
  return value;
}

function keystream(secret: string, nonce: Buffer, exp: Buffer): Buffer {
  return createHmac("sha256", secret)
    .update(PURPOSE_KS)
    .update(nonce)
    .update(exp)
    .digest()
    .subarray(0, ID_BYTES);
}

function mac(secret: string, body: Buffer): Buffer {
  return createHmac("sha256", secret)
    .update(PURPOSE_MAC)
    .update(body)
    .digest()
    .subarray(0, MAC_BYTES);
}

function xor(a: Buffer, b: Buffer): Buffer {
  const out = Buffer.alloc(a.length);
  for (let i = 0; i < a.length; i++) out[i] = (a[i] ?? 0) ^ (b[i] ?? 0);
  return out;
}

/** Issue a short-lived opaque token; the product id is never present in the token. */
export function issueProductLinkToken(productId: string, options: ProductLinkTokenOptions): string {
  if (!productId || !options.secret) throw new Error("INVALID_PRODUCT_LINK_TOKEN_INPUT");
  const now = Math.floor((options.now ?? (() => Date.now() / 1000))());
  const exp = now + Math.max(1, Math.min(options.ttlSeconds ?? 30 * 24 * 3600, 365 * 24 * 3600));
  const nonce = randomBytes(NONCE_BYTES);
  const expBuf = Buffer.alloc(EXP_BYTES);
  expBuf.writeUInt32BE(exp);
  const cipher = xor(encodeUlid(productId), keystream(options.secret, nonce, expBuf));
  const unsigned = Buffer.concat([nonce, expBuf, cipher]);
  const token = Buffer.concat([unsigned, mac(options.secret, unsigned)]).toString("base64url");
  return `${START_PREFIX}${token}`;
}

export function verifyProductLinkToken(
  token: string,
  options: ProductLinkTokenOptions,
): string | null {
  try {
    if (!options.secret) return null;
    const raw = token.startsWith(START_PREFIX) ? token.slice(START_PREFIX.length) : token;
    const buf = Buffer.from(raw, "base64url");
    if (buf.length !== BODY_BYTES) return null;
    if (buf.toString("base64url") !== raw) return null;
    const unsigned = buf.subarray(0, BODY_BYTES - MAC_BYTES);
    const givenMac = buf.subarray(BODY_BYTES - MAC_BYTES);
    const expectedMac = mac(options.secret, unsigned);
    if (givenMac.length !== expectedMac.length || !timingSafeEqual(givenMac, expectedMac))
      return null;
    const nonce = unsigned.subarray(0, NONCE_BYTES);
    const expBuf = unsigned.subarray(NONCE_BYTES, NONCE_BYTES + EXP_BYTES);
    const cipher = unsigned.subarray(NONCE_BYTES + EXP_BYTES);
    const exp = expBuf.readUInt32BE(0);
    const now = Math.floor((options.now ?? (() => Date.now() / 1000))());
    if (exp <= now) return null;
    return decodeUlid(xor(cipher, keystream(options.secret, nonce, expBuf)));
  } catch {
    return null;
  }
}

export const createProductLinkToken = issueProductLinkToken;
export const decodeProductLinkToken = verifyProductLinkToken;
