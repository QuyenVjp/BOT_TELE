import { describe, expect, it, vi } from "vitest";
import { createGoogleSheetsOwnerVerifier } from "../../src/infrastructure/google-sheets/owner-verifier.js";

const base = {
  ownerEmail: "owner@example.test",
  audience: "apps-script-client",
  spreadsheetId: "spreadsheet-123",
};

function verifierFor(claims: Record<string, unknown> | null) {
  const verifyIdToken = vi.fn(async () => claims);
  return {
    verifier: createGoogleSheetsOwnerVerifier({ ...base, verifyIdToken }),
    verifyIdToken,
  };
}

describe("Google Sheets owner verifier", () => {
  it("accepts only a verified owner token for the exact workbook and audience", async () => {
    const { verifier, verifyIdToken } = verifierFor({
      sub: "owner-subject",
      email: "OWNER@example.test",
      email_verified: true,
      iss: "https://accounts.google.com",
      aud: "apps-script-client",
    });

    await expect(
      verifier.verify({
        authorization: "Bearer opaque-test-token",
        spreadsheetId: "spreadsheet-123",
      }),
    ).resolves.toEqual({ ok: true, subject: "owner-subject", email: "owner@example.test" });
    expect(verifyIdToken).toHaveBeenCalledWith("opaque-test-token", "apps-script-client");
  });

  it("rejects workbook mismatch before token verification", async () => {
    const { verifier, verifyIdToken } = verifierFor(null);

    await expect(
      verifier.verify({
        authorization: "Bearer opaque-test-token",
        spreadsheetId: "another-workbook",
      }),
    ).resolves.toEqual({ ok: false, code: "WORKBOOK_MISMATCH" });
    expect(verifyIdToken).not.toHaveBeenCalled();
  });

  it.each([
    { email_verified: false, iss: "https://accounts.google.com", aud: "apps-script-client" },
    { email_verified: true, iss: "https://evil.example", aud: "apps-script-client" },
    { email_verified: true, iss: "https://accounts.google.com", aud: "other-client" },
    {
      email_verified: true,
      iss: "https://accounts.google.com",
      aud: "apps-script-client",
      email: "other@example.test",
    },
  ])("rejects invalid owner claims", async (claims) => {
    const { verifier } = verifierFor({
      sub: "owner-subject",
      email: "owner@example.test",
      ...claims,
    });

    await expect(
      verifier.verify({
        authorization: "Bearer opaque-test-token",
        spreadsheetId: "spreadsheet-123",
      }),
    ).resolves.toEqual({ ok: false, code: "UNAUTHORIZED" });
  });

  it("fails closed when the authorization header is absent", async () => {
    const { verifier, verifyIdToken } = verifierFor(null);
    await expect(
      verifier.verify({ spreadsheetId: "spreadsheet-123", authorization: undefined }),
    ).resolves.toEqual({
      ok: false,
      code: "UNAUTHORIZED",
    });
    expect(verifyIdToken).not.toHaveBeenCalled();
  });
});
