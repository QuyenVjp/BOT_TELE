# Production Launch Gates (T111)

**Purpose**: Track production technical and owner-operable gates without claiming platform or
upstream approval. The owner-selected VietQR + SePay architecture carries an explicitly accepted
external policy risk; that risk is documented separately and is not an internal technical gate.
Sandbox and test adapters are used until each remaining operational/product gate is satisfied.

## Gates

| #   | Gate                                | Requirement     | Evidence needed                                                                                                                                             | Owner | Status                                 | Sign-off date |
| --- | ----------------------------------- | --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | -------------------------------------- | ------------- |
| G1  | Numeric owner identity              | FR-021          | Verified numeric Telegram `user_id` for `@Quyenvjp`, stored in secret config (`ADMIN_TELEGRAM_USER_ID`), self-test passed                                   | Owner | ⛔ Pending                             | —             |
| G2  | Inventory provenance per active SKU | SR-007, SEC-014 | Active `resale_evidence_id` bound to the intended variant/version; `OWNER_ATTESTATION` records owner-held provenance only and is not upstream authorization | Owner | ⛔ Pending                             | —             |
| G3  | SePay production setup              | FR-009, SR-002  | Production HMAC secret, merchant account id, IP allowlist, verified canary event                                                                            | Owner | ⛔ Pending                             | —             |
| G4  | Warranty / refund SLA               | FR-020          | Documented warranty window + refund SLA + manual bank refund procedure                                                                                      | Owner | ⛔ Pending                             | —             |
| G5  | External Telegram policy risk       | SR-008, SEC-015 | Factual risk note plus explicit owner acceptance; no claim of Telegram approval or platform compliance                                                      | Owner | ✅ Accepted risk; not a technical gate | —             |
| G6  | Vault production driver             | SR-001          | External vault endpoint + token wired; `VAULT_DRIVER=external` reachable; memory driver rejected in prod                                                    | Owner | ⛔ Pending                             | —             |
| G7  | Container image scan                | SC-007          | Deployment image built from pinned base; Trivy/Grype scan with no High/Critical; image digest recorded                                                      | Owner | ⛔ Pending                             | —             |
| G8  | Production restore drill            | SR-006          | Backup/restore/projection-rebuild executed against production-sized snapshot with managed PITR; RPO/RTO confirmed                                           | Owner | ⛔ Pending                             | —             |
| G9  | Operational runbooks reviewed       | SR-008          | Reconciliation, supplier-outage, credential-incident, refund/replacement, deployment runbooks reviewed and adopted                                          | Owner | ⛔ Pending                             | —             |

## Fail-closed enforcement in code

`loadConfig` (src/config/index.ts) already refuses to boot in `NODE_ENV=production` when:

- `VAULT_DRIVER=memory` (forces G6),
- `SUPPLIER_DRIVER=fixture` (forces real supplier wiring),
- `ADMIN_TELEGRAM_USER_ID=0` (forces G1),
- `APP_BASE_URL` is not https.

These are hard boot blockers, not advisory. The remaining gates (G2, G3, G4, G6, G7, G8, G9)
are process gates requiring the relevant dated owner/operator evidence before the pilot opens to
real customers. G5 is intentionally excluded from this technical list because the owner accepted
that external risk separately.

## Rule

Do not disguise a digital-goods sale, evade platform rules, or sell provider-prohibited shared
accounts. Owner acceptance of the external policy risk does not authorize false claims; preserve
truthful inventory provenance, transferability, support, and product-policy metadata.
