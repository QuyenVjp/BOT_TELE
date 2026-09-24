# Google Sheets inventory intake

Normal inventory intake is owner-only and starts in the container-bound Google Sheet:

`BOT_TELE → ➕ Nhập tài khoản → preview → confirm → Vault → AVAILABLE`.

The Sheet is not an inventory database. PostgreSQL remains authoritative for the asset,
and Vault remains authoritative for the credential material. Telegram inventory import and
the local Terminal command remain fallback/break-glass paths.

## One-time setup

1. Bind the Apps Script project in `scripts/google-sheets-inventory-intake/` to the
   production workbook. Do not add a Web App deployment and do not use a public `doGet`.
2. Set the backend HTTPS base URL in `Code.gs` to the approved production API origin.
3. Configure the backend with:
   - `GOOGLE_SHEETS_ENABLED=true`
   - `GOOGLE_SHEETS_INVENTORY_INTAKE_ENABLED=true` only after migration and live owner acceptance
   - exact `GOOGLE_SHEETS_SPREADSHEET_ID`
   - `GOOGLE_SHEETS_OWNER_ID` as the owner Google account email
   - `GOOGLE_SHEETS_OIDC_AUDIENCE` as the Apps Script OAuth audience/client id
   - `GOOGLE_SHEETS_CREDENTIAL_VAULT_REF` for the projection service account
4. Deploy `appsscript.json` with the explicit `openid`, external-request and
   `spreadsheets.currentonly` scopes. Authorize the script as the owner account.
5. Protect projection tabs and Requests system columns. The sidebar must be the only
   normal credential entry surface in the workbook.

The backend validates the Google ID token, verified email, issuer, configured audience and
exact workbook id on every catalog, preview and confirm request. A short-lived random
challenge is returned only after Vault staging and safe preview. PostgreSQL stores only the
challenge hash, safe counts/metadata and the opaque Vault reference in the existing import
session. Confirm consumes the challenge once and calls the same inventory domain import used
by Telegram; duplicate credentials remain duplicates and never create a second asset.

## Secret boundary

Never place credentials in cells, hidden sheets, formulas, Requests, Apps Script properties,
URLs, query strings, logs, audit metadata, Telegram messages or Terminal arguments. The raw
input exists only transiently in the sidebar server call, protected HTTPS request and backend
memory until the Vault write. The response contains counts and classifications only.

If a Vault write succeeds but the database bind/commit fails, the existing opaque orphan
compensation record is written to `inventory_vault_orphan`; do not retry by pasting the same
credential blindly until the owner checks the reconciliation path.

## Acceptance checklist

- Open the workbook as the configured owner and reload it; `BOT_TELE` appears in the menu.
- Open `➕ Nhập tài khoản`, select a stock variant, submit one disposable test account, and
  inspect the safe preview. The workbook remains unchanged.
- Confirm once. Verify PostgreSQL has one `AVAILABLE` asset and the Sheet projection later
  shows only masked login, fingerprint and status. Verify no raw credential appears in
  `Requests`, `Audit`, logs or database text fields.
- Repeat the confirm click. It must replay the terminal safe summary without creating a
  second asset.
- Try a different workbook or non-owner Google account. The backend must reject before
  staging.
- Keep the store `CLOSED` during this acceptance. Delete/rotate the disposable test account
  through the normal owner inventory path before any sale.
