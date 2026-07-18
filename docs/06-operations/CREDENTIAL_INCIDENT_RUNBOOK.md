# Credential Leak / Delivery Bundle Revoke / Replacement Runbook

## Trigger

- Credential-leak scan finding (CI `secret-scan` or runtime redaction tripwire).
- Customer reports a delivered account is already in use / compromised.
- Suspected disclosure of a vault ref or plaintext secret via log, chat, ticket, or export.
- Owner-initiated revoke of an active Delivery Bundle.

## Severity

| Severity | Example | Immediate action |
|---|---|---|
| Critical | Raw credential in a production log, ticket, or chat | Revoke + rotate + freeze related fulfillment; open incident |
| High | Delivery Bundle token leaked, concurrent non-owner reveal | Revoke bundle; reissue only to the owning customer |
| Medium | Customer reports non-working account within warranty | Open replacement case; preserve original asset |

## Procedure

### 1. Contain

1. Identify the affected `digital_asset`, `delivery_bundle`, and Order by id (never by guessing a
   token — tokens are hashed; a guessed token returns a generic 410 with no existence oracle).
2. Revoke the active Delivery Bundle (status → `REVOKED`). A revoked token never reveals.
3. If the vault material itself is compromised, delete the vault ref (vault `delete`) and mark the
   asset `COMPROMISED` / `REVOKED`. Do not re-use the same vault material.

### 2. Preserve evidence

1. Append an audit event with actor, reason, target, correlation id. Reason is mandatory.
2. Capture the redacted log slice around the disclosure (no re-emission of the secret).
3. Link a support ticket (safe summary only — `toSafeSummary` redacts credential-shaped tokens).

### 3. Remediate

1. Open a replacement case via `openReplacementCase` (preserves original asset + Order history).
2. If a refund is required, transition the Order to `REFUND_PENDING` and follow the refund runbook.
3. Reissue a Delivery Bundle only to the owning customer, after a new asset is ready.

### 4. Communicate

- Customer: safe status only (`Tài khoản đã được thu hồi`, `Chúng tôi sẽ cấp tài khoản thay thế`).
- Never ask the customer to paste a password back into chat.
- Never forward a vault ref or plaintext secret to support, logs, or another channel.

## Safety rules

- SR-001: raw secrets never enter storage, logs, events, telemetry, or tickets.
- SR-003: reveal and reissue are ownership-scoped; foreign ids return a generic failure.
- FR-017: first view is atomic (AVAILABLE → CONSUMED); concurrent views cannot double-reveal.
- FR-020: replacement preserves the original asset and Order history.
