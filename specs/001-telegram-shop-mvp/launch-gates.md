# Production Launch Gates (T111)

**Purpose**: SR-008 — production launch remains blocked until each gate has explicit, dated owner
sign-off. These are business/operational facts the engineering work cannot self-certify. Sandbox and
test adapters are used until each is signed off.

## Gates

| # | Gate | Requirement | Evidence needed | Owner | Status | Sign-off date |
|---|---|---|---|---|---|---|
| G1 | Numeric owner identity | FR-021 | Verified numeric Telegram `user_id` for `@Quyenvjp`, stored in secret config (`ADMIN_TELEGRAM_USER_ID`), self-test passed | Owner | ⛔ Pending | — |
| G2 | Supplier authorization per active SKU | SR-007, SEC-014 | Written authorization/resale evidence for each active SKU; `resale_evidence_id` populated | Owner | ⛔ Pending | — |
| G3 | SePay production setup | FR-009, SR-002 | Production HMAC secret, merchant account id, IP allowlist, verified canary event | Owner | ⛔ Pending | — |
| G4 | Warranty / refund SLA | FR-020 | Documented warranty window + refund SLA + manual bank refund procedure | Owner | ⛔ Pending | — |
| G5 | Telegram platform policy | SR-008, SEC-015 | Explicit decision: obtain approval, move payment channel, or change product/channel; risk accepted in writing | Owner | ⛔ Pending | — |
| G6 | Vault production driver | SR-001 | External vault endpoint + token wired; `VAULT_DRIVER=external` reachable; memory driver rejected in prod | Owner | ⛔ Pending | — |
| G7 | Container image scan | SC-007 | Deployment image built from pinned base; Trivy/Grype scan with no High/Critical; image digest recorded | Owner | ⛔ Pending | — |
| G8 | Production restore drill | SR-006 | Backup/restore/projection-rebuild executed against production-sized snapshot with managed PITR; RPO/RTO confirmed | Owner | ⛔ Pending | — |
| G9 | Operational runbooks reviewed | SR-008 | Reconciliation, supplier-outage, credential-incident, refund/replacement, deployment runbooks reviewed and adopted | Owner | ⛔ Pending | — |

## Fail-closed enforcement in code

`loadConfig` (src/config/index.ts) already refuses to boot in `NODE_ENV=production` when:

- `VAULT_DRIVER=memory` (forces G6),
- `SUPPLIER_DRIVER=fixture` (forces real supplier wiring),
- `ADMIN_TELEGRAM_USER_ID=0` (forces G1),
- `APP_BASE_URL` is not https.

These are hard boot blockers, not advisory. The remaining gates (G2, G3 canary, G4, G5, G7, G8, G9)
are process gates that require dated human sign-off recorded in this table before the pilot opens to
real customers.

## Rule

Do not disguise a digital-goods sale, evade platform rules, or sell provider-prohibited shared
accounts. If a gate cannot be met, the corresponding capability stays disabled rather than shipped
with the risk concealed (see `docs/04-security/TELEGRAM_POLICY_RISK.md`).
