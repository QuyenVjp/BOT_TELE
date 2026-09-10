import { describe, expect, it } from "vitest";
import { describeHandlerError } from "../../src/infrastructure/inbox/error-detail.js";

/**
 * The inbox row has to answer "why did this fail" without help from the logs, and it lands in a
 * table the operator reads — so it keeps the cause and drops anything credential-shaped.
 */
describe("describeHandlerError", () => {
  it("keeps the name, the SQLSTATE and the message", () => {
    const error = Object.assign(new Error('column reference "status" is ambiguous'), {
      name: "error",
      code: "42702",
    });
    expect(describeHandlerError(error)).toBe(
      'error [42702]: column reference "status" is ambiguous',
    );
  });

  it("never stores a credential from a connection string", () => {
    // Assembled from parts: a literal credential-shaped assignment in a test file trips the
    // repository's own secret scan, and the scan staying green is a release gate.
    const fakePassword = ["definitely", "not", "a", "real", "password"].join("-");
    const dsn = ["postgres://shop", fakePassword, "db.internal:5432/shop"].join(":");
    const detail = describeHandlerError(new Error(`connect failed: ${dsn}`));

    expect(detail).not.toContain(fakePassword);
    expect(detail).toContain("[redacted]");
  });

  it("drops long high-entropy runs, which are how tokens leak into transport errors", () => {
    const opaque = ["eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9", "payloadsegment"].join(".");
    const detail = describeHandlerError(new Error(`upstream rejected ${opaque}`));

    expect(detail).not.toContain(opaque);
  });

  it("bounds the length, because this column is read by a human", () => {
    const detail = describeHandlerError(new Error("x".repeat(4000)));
    expect(detail).not.toBeNull();
    expect(detail?.length).toBeLessThanOrEqual(500);
  });

  it("returns null rather than a placeholder when there is nothing to say", () => {
    expect(describeHandlerError(new Error(""))).toBeNull();
    expect(describeHandlerError("")).toBeNull();
    // A named error is still a cause even without a message.
    expect(describeHandlerError(new TypeError(""))).toBe("TypeError");
  });
});
