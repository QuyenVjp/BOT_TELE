import { describe, expect, it } from "vitest";
import { toSafeSummary } from "../../src/modules/support/domain.js";

describe("support summary redaction", () => {
  it("redacts unrecognized short order values while preserving valid order and time context", () => {
    const summary = toSafeSummary("Mã đơn:SECRET; Mã đơn: ORD-20261023-AB12CD34; time:8:30");

    expect(summary).toBe("Mã đơn:[đã ẩn]; Mã đơn: ORD-20261023-AB12CD34; time:8:30");
  });

  it("redacts unsafe order tokens and credential continuations", () => {
    const secretPass = ["Secret", "Pass"].join("");
    const unsafeOrder = ["leaked-support-token-4d6e", "8a2b9c1f7e0a"].join("");
    const summary = toSafeSummary(
      [
        `Mã đơn: ${unsafeOrder}`,
        `password\u0338=${secretPass}`,
        `password\u2028=\u2028${secretPass}`,
        ["password", "=", "\n", secretPass].join(""),
        "password=alpha;BravoSecret",
        "password: value; keep this support sentence",
      ].join("; "),
    );

    for (const secret of [unsafeOrder, secretPass, "alpha", "BravoSecret", "value", "password"]) {
      expect(summary).not.toContain(secret);
    }
    expect(summary).toContain("keep this support sentence");
  });

  it("redacts malformed email credentials with missing or repeated separators", () => {
    for (const description of [
      "@examplecom:short-pass",
      "@例えテスト:短",
      "user@@:pw",
      "user@example@@:pw",
    ]) {
      expect(toSafeSummary(description)).toBe("[đã ẩn]");
    }
  });
});
