import { describe, expect, it } from "vitest";
import { newId } from "../../src/shared/ids/index.js";
import {
  issueProductLinkToken,
  verifyProductLinkToken,
} from "../../src/modules/catalog/product-link-token.js";

const SECRET = "test-hmac-key";

describe("opaque product link tokens", () => {
  it("round-trips a product id without embedding the raw ULID", () => {
    const productId = newId();
    const token = issueProductLinkToken(productId, { secret: SECRET, ttlSeconds: 3600 });
    expect(token.startsWith("product_")).toBe(true);
    expect(token).not.toContain(productId);
    expect(Buffer.from(token.slice("product_".length), "base64url").toString("utf8")).not.toContain(
      productId,
    );
    expect(verifyProductLinkToken(token, { secret: SECRET })).toBe(productId);
  });

  it("rejects expired or tampered tokens", () => {
    const productId = newId();
    const now = () => 1_700_000_000;
    const token = issueProductLinkToken(productId, { secret: SECRET, ttlSeconds: 10, now });
    expect(verifyProductLinkToken(token, { secret: SECRET, now: () => 1_700_000_020 })).toBeNull();
    expect(verifyProductLinkToken(`${token}x`, { secret: SECRET, now })).toBeNull();
  });
});
