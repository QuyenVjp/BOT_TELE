import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const code = readFileSync(
  new URL("../../scripts/google-sheets-inventory-intake/Code.gs", import.meta.url),
  "utf8",
);
const sidebar = readFileSync(
  new URL("../../scripts/google-sheets-inventory-intake/Sidebar.html", import.meta.url),
  "utf8",
);
const manifest = JSON.parse(
  readFileSync(
    new URL("../../scripts/google-sheets-inventory-intake/appsscript.json", import.meta.url),
    "utf8",
  ),
) as { oauthScopes?: string[] };

describe("Google Sheets inventory intake boundary", () => {
  it("uses OIDC and never writes the submitted credential to the workbook or script storage", () => {
    expect(code).toContain("ScriptApp.getIdentityToken()");
    expect(code).toContain("UrlFetchApp.fetch");
    expect(code).not.toContain("PropertiesService");
    expect(code).not.toContain("CacheService");
    expect(code).not.toContain("setValue");
    expect(code).not.toContain("appendRow");
    expect(code).not.toContain("Logger.log");
    expect(sidebar).toContain('id="input"');
    expect(sidebar).not.toContain("setValue");
  });

  it("declares only the scopes required for the protected bridge", () => {
    expect(manifest.oauthScopes).toEqual(
      expect.arrayContaining([
        "openid",
        "https://www.googleapis.com/auth/script.external_request",
        "https://www.googleapis.com/auth/spreadsheets.currentonly",
      ]),
    );
  });
});
