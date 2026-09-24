# Google Sheets inventory projection and optional intake

## Release status

Google Sheets is a secret-free projection and operator view. PostgreSQL remains
authoritative for inventory and Vault remains authoritative for credential
material.

The current product decision rejects Apps Script as the production intake
architecture. Keep `GOOGLE_SHEETS_INVENTORY_INTAKE_ENABLED=false`; missing Apps
Script, OIDC or workbook setup is not a release blocker and must not block
Telegram commerce, PostgreSQL reconciliation or the worker.

## Supported owner intake

Inventory credentials enter through one of the supported owner-only paths:

1. Telegram root-admin inventory import:
   `BOT_TELE → 📥 Kho hàng → nhập tài khoản → preview → confirm → Vault → AVAILABLE`.
2. The local interactive `scripts/admin-inventory-import.mjs` break-glass flow,
   using the existing `WAITING_INPUT` session and external Vault. It accepts no
   command-line arguments and keeps secret input in the local TTY only.

Both paths use the same inventory domain/session engine. The resulting
PostgreSQL asset appears later through the safe Sheets projection.

## Projection setup

1. Configure only the secret-free projection lane:
   - `GOOGLE_SHEETS_ENABLED=true`
   - exact `GOOGLE_SHEETS_SPREADSHEET_ID`
   - `GOOGLE_SHEETS_CREDENTIAL_VAULT_REF` for the projection service account
2. Protect projection tabs and Requests system columns. Requests remains a
   safe metadata/control surface, never a credential transport.
3. Reconciliation may create tabs additively and updates rows by immutable
   source keys. It never treats row numbers as production identity.

## Optional dormant Apps Script adapter

The code under `scripts/google-sheets-inventory-intake/` remains a fail-closed,
non-commissioned adapter for a future separately approved decision. Do not bind
it to production, deploy a Web App or public `doGet`, configure an OIDC
audience, or enable `GOOGLE_SHEETS_INVENTORY_INTAKE_ENABLED` as part of release
acceptance. If the owner later reopens this adapter, require a separate
security review and live acceptance while the store remains `CLOSED`.

When that separate gate exists, the backend validates the Google ID token,
verified owner email, issuer, configured audience and exact workbook id. The
challenge is short-lived and one-time; Vault staging and the existing import
session remain the only credential-bearing domain boundary.

## Secret boundary

Never place credentials in cells, hidden sheets, formulas, Requests, Apps
Script properties, URLs, query strings, logs, audit metadata, Telegram
messages or Terminal arguments. Raw input exists only transiently in the
protected owner path and backend memory until the Vault write. Responses
contain counts and classifications only.

If a Vault write succeeds but the database bind/commit fails, the existing
opaque orphan compensation record is written to `inventory_vault_orphan`; do
not retry by pasting the same credential blindly until the owner checks the
reconciliation path.

## Acceptance checklist

- Keep the store `CLOSED` during inventory/projection acceptance.
- Verify the supported Telegram owner flow produces a safe preview and one
  `AVAILABLE` asset without exposing raw credentials.
- Verify the local Terminal flow refuses non-interactive execution and accepts
  no arguments.
- Verify Sheets projection shows only masked login, fingerprint, opaque Vault
  reference and status.
- Repeat the import confirmation; it must replay the terminal safe summary
  without creating a second asset.
- Verify no raw credential appears in Requests, Audit, logs, Sheets or ordinary
  database text fields.
