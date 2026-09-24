import { google } from "googleapis";

export type GoogleSheetsOwnerVerification =
  | { ok: true; subject: string; email: string }
  | { ok: false; code: "UNAUTHORIZED" | "WORKBOOK_MISMATCH" };

export interface GoogleSheetsOwnerVerifier {
  verify(input: {
    authorization: string | undefined;
    spreadsheetId: string | undefined;
  }): Promise<GoogleSheetsOwnerVerification>;
}

export interface GoogleSheetsOwnerVerifierOptions {
  ownerEmail: string;
  audience: string;
  spreadsheetId: string;
  verifyIdToken?: (token: string, audience: string) => Promise<GoogleOidcClaims | null>;
}

export interface GoogleOidcClaims {
  sub?: string;
  email?: string;
  email_verified?: boolean;
  iss?: string;
  aud?: string | string[];
}

const ISSUERS = new Set(["https://accounts.google.com", "accounts.google.com"]);

function bearerToken(authorization: string | undefined): string | null {
  if (!authorization) return null;
  const match = /^Bearer\s+([^\s]+)$/iu.exec(authorization.trim());
  if (!match || match[1]!.length > 4096) return null;
  return match[1]!;
}

function normalizedEmail(value: string): string {
  return value.trim().toLowerCase();
}

function audienceMatches(aud: string | string[] | undefined, expected: string): boolean {
  return Array.isArray(aud) ? aud.includes(expected) : aud === expected;
}

export function createGoogleSheetsOwnerVerifier(
  options: GoogleSheetsOwnerVerifierOptions,
): GoogleSheetsOwnerVerifier {
  const expectedOwner = normalizedEmail(options.ownerEmail);
  const expectedAudience = options.audience.trim();
  const expectedSpreadsheetId = options.spreadsheetId.trim();
  const verifyIdToken =
    options.verifyIdToken ??
    (async (token: string, audience: string): Promise<GoogleOidcClaims | null> => {
      const client = new google.auth.OAuth2();
      const ticket = await client.verifyIdToken({ idToken: token, audience });
      const payload = ticket.getPayload();
      if (!payload) return null;
      return {
        ...(payload.sub ? { sub: payload.sub } : {}),
        ...(payload.email ? { email: payload.email } : {}),
        ...(payload.email_verified !== undefined ? { email_verified: payload.email_verified } : {}),
        ...(payload.iss ? { iss: payload.iss } : {}),
        ...(payload.aud ? { aud: payload.aud } : {}),
      };
    });

  return {
    async verify(input) {
      if (input.spreadsheetId !== expectedSpreadsheetId) {
        return { ok: false, code: "WORKBOOK_MISMATCH" };
      }
      const token = bearerToken(input.authorization);
      if (!token || !expectedAudience || !expectedOwner || !expectedSpreadsheetId) {
        return { ok: false, code: "UNAUTHORIZED" };
      }
      try {
        const claims = await verifyIdToken(token, expectedAudience);
        if (
          !claims?.sub ||
          !claims.email ||
          claims.email_verified !== true ||
          !ISSUERS.has(claims.iss ?? "") ||
          !audienceMatches(claims.aud, expectedAudience) ||
          normalizedEmail(claims.email) !== expectedOwner
        ) {
          return { ok: false, code: "UNAUTHORIZED" };
        }
        return { ok: true, subject: claims.sub, email: normalizedEmail(claims.email) };
      } catch {
        return { ok: false, code: "UNAUTHORIZED" };
      }
    },
  };
}
