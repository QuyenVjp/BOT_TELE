# US5 Sole Owner Operations Evidence (T100)

**Date**: 2026-07-16
**Scope**: User Story 5 — Sole Owner Operations (FR-021, FR-022, FR-023, SR-005, SC-009)

## Acceptance lane

Command:

```bash
npx vitest run tests/acceptance/owner-operations.test.ts
```

Result:

```
✓ tests/acceptance/owner-operations.test.ts (1 test)
  ✓ owner deactivates a variant (kill-switch) and resolves a discrepancy with confirmation
```

The journey drives:

1. Configured numeric owner in private chat deactivates a sellable variant (kill-switch) — audited.
2. Same owner requests a high-risk discrepancy resolve → receives an expiring challenge → confirms → effect applied + audited.
3. Impostor numeric id presenting `@Quyenvjp` is denied as `NOT_ROOT_ADMIN` and counted as impersonation.
4. Real root in a group chat is denied as `WRONG_CONTEXT`.
5. `/add-admin` (and any grant-shaped command) is rejected as `UNKNOWN_COMMAND`; no second admin is created.

## Historical supporting lanes (superseded as final-source evidence)

```
✓ tests/security/root-admin-identity.test.ts  (8)   FR-021 / SC-009 numeric ID, username non-key, private context, drift
✓ tests/security/no-add-admin.test.ts         (4)   FR-022 structural absence of add-admin capability
✓ tests/integration/admin-confirmation.test.ts (6)  FR-023 / SR-005 fingerprint, expiry, replay, reason, append-only audit
```

Combined US5 suite: **19 tests / 4 files passed**. Typecheck and lint clean.

## Requirement coverage

| FR / SR | How proven |
|---|---|
| FR-021 Sole numeric root | `authorizeRootAction` grants only the configured id in private chat; username is never an authorization key |
| FR-021 Impersonation | Different numeric id presenting `@Quyenvjp` → `NOT_ROOT_ADMIN`; deny-audit + impersonation telemetry |
| FR-021 Private context | group/supergroup/channel → `WRONG_CONTEXT` even for the configured id |
| FR-022 No add-admin | `OWNER_COMMANDS` allowlist has no grant verb; structural export scan across identity/admin modules; `isOwnerCommand("add-admin")` is false |
| FR-023 Confirmation | High-risk `discrepancy.resolve` issues an expiring challenge bound to action fingerprint; wrong fingerprint / expired / consumed challenge all refuse |
| FR-023 Reason | `appendAuditEvent` rejects empty/whitespace reason; every owner action requires a non-empty reason |
| SR-005 Immutable audit | Audit repository exposes only append + list; second append leaves the original row intact |
| SC-009 Unauthorized denial | Acceptance covers configured id success, username-impersonation denial, group denial |

## Boundary design notes

- **Numeric id is the only key**: `isConfiguredRootId` never trusts a username; drift is an alert, not a grant or (by itself) a denial.
- **Fail closed on unset config**: `adminTelegramUserId === 0` never authorizes.
- **Challenge storage**: only the SHA-256 hash of the challenge is stored; plaintext is returned once at issue.
- **Consume-before-apply**: high-risk confirmation is consumed before the domain write so a crash cannot leave a reusable challenge.
- **No second root**: the identity model is a single configured id; there is no promote/grant/add-admin path anywhere in the surface.

## Independence

US5 reads catalog (`product_variant.is_active`) and payments (`discrepancy`) only to apply allowlisted operational effects. It grants no customer, payment-settlement, or vault privilege. Support and customer paths remain unaffected.
