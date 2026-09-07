import { createHmac, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyTelegramMiniAppInitData } from "../../src/modules/digital-goods/delivery-route.js";

const botToken = randomBytes(32).toString("hex");
function signed(extra: Record<string, string> = {}): string {
  const values = new URLSearchParams({
    auth_date: String(Math.floor(Date.now() / 1000)),
    query_id: "q-1",
    user: JSON.stringify({ id: 12345 }),
    signature: "ed25519-signature-field",
    ...extra,
  });
  const check = [...values.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
  const secret = createHmac("sha256", "WebAppData").update(botToken).digest();
  values.set("hash", createHmac("sha256", secret).update(check).digest("hex"));
  return values.toString();
}

describe("Telegram Mini App initData contract", () => {
  it("authenticates all fields, including signature, in the data-check string", () => {
    const tampered = signed().replace("signature=ed25519-signature-field", "signature=different");
    expect(verifyTelegramMiniAppInitData(tampered, { botToken, maxAgeSeconds: 300 })).toBeNull();
  });

  it("rejects duplicate parameters instead of silently accepting URLSearchParams first values", () => {
    expect(
      verifyTelegramMiniAppInitData(`${signed()}&auth_date=1`, { botToken, maxAgeSeconds: 300 }),
    ).toBeNull();
  });
  it("rejects stale auth dates even when the HMAC is valid", () => {
    const stale = signed({ auth_date: String(Math.floor(Date.now() / 1000) - 301) });
    expect(verifyTelegramMiniAppInitData(stale, { botToken, maxAgeSeconds: 300 })).toBeNull();
  });

  it("rejects malformed init data without throwing", () => {
    expect(
      verifyTelegramMiniAppInitData("not-urlencoded", { botToken, maxAgeSeconds: 300 }),
    ).toBeNull();
    expect(verifyTelegramMiniAppInitData("hash=bad", { botToken, maxAgeSeconds: 300 })).toBeNull();
  });
});
