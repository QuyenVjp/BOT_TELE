# Security Review: Telegram Shop Digital MVP (T102)

**Date**: 2026-07-16
**Method**: STRIDE per trust boundary + OWASP ASVS 5.0 L2 / API Top 10 lenses, mapped to the
implemented code and its test seams. Baseline threat catalogue: `docs/04-security/THREAT_MODEL.md`.

## Summary

No unresolved Critical or High finding remains in the implemented scope. Every priority threat has a
mandatory control that is present in code AND exercised by a test lane. Production-only items
(container scan, real supplier authorization, SePay production keys, Telegram policy acceptance) are
tracked as explicit launch gates in `launch-gates.md`, not silently closed.

## STRIDE / OWASP findings and disposition

| ID | STRIDE / OWASP | Threat | Control in code | Test seam | Status |
|---|---|---|---|---|---|
| SEC-001 | Tampering | Fake evidence marks Order paid | Signature + amount/account/direction/content match; settle only on exact match, else Discrepancy | `sepay-webhook`, `payment-discrepancy`, `payment-idempotency` | Resolved |
| SEC-004 | EoP/BOLA | Read another customer's Order/ticket/bundle | Customer-scoped queries return null for foreign ids; ownership checked before mutation | `order-history`, `delivery-bundle`, `support-ticket` | Resolved |
| SEC-005 | Replay | Webhook/callback retry double-credits or double-fulfils | Inbox dedupe, outbox exactly-once, unique asset claim, version guards | `payment-idempotency`, `asset-claim`, `outbox-recovery` | Resolved |
| SEC-007 | Repudiation | Insider changes refund/ledger without trace | Append-only audit; owner high-risk requires confirmation + reason | `admin-confirmation`, owner acceptance | Resolved |
| SEC-008 | Disclosure | Secret/PII in logs/errors/exports | Pino redaction, allowlisted telemetry, safe-summary, generic error envelope | `telemetry-redaction`, `credential-leak`, `config-redaction` | Resolved |
| SEC-010 | Prompt injection | LLM induced to call a financial action | Search parser is strict-Zod, no domain tools, deterministic fallback | `search-parser` | Resolved |
| SEC-011 | Spoofing/EoP | Username `@Quyenvjp` used to become admin | Authorize only configured numeric id; username is never a key; no add-admin | `root-admin-identity`, `no-add-admin` | Resolved |
| SEC-012 | Disclosure | Supplier/account credential in DB/log/chat | Vault refs only, one-time reveal, strict supplier schema rejects smuggled keys | `credential-leak`, `supplier-port`, `delivery-bundle` | Resolved |
| SEC-013 | Tampering | Supplier timeout/retry duplicates account | Supplier idempotency key, query-before-retry, unique asset allocation | `supplier-port`, `supplier-service`, `fulfillment-recovery` | Resolved |
| SEC-016 | Repudiation | Sole admin changes state without review trail | Private context + expiring confirmation + append-only audit + deny-audit | `admin-confirmation`, owner acceptance | Resolved |
| SEC-009 | DoS | QR/status spam exhausts DB/provider | Per-action rate policy on ingress; bounded reconciliation backoff | `telegram-ingress`, `payment-reconciliation` | Mitigated (pilot budget); revisit under production load |
| SEC-002 | Tampering/DoS | Concurrent claim double-spends final asset | `FOR UPDATE SKIP LOCKED` + unique active fingerprint + version guard | `asset-claim` (20-buyer property) | Resolved |
| SEC-003 | Spoofing | Stolen reseller credential | Out of MVP scope (no reseller surface) | n/a | N/A for MVP |
| SEC-006 | SSRF | Reseller webhook to internal metadata | Out of MVP scope (no outbound reseller webhook) | n/a | N/A for MVP |
| SEC-014 | Supply chain | Revoked/unauthorized upstream account | Asset validation + quarantine + replacement/refund | `supplier-port`, `replacement` | In-app resolved; per-SKU authorization is a launch gate |
| SEC-015 | Insecure design | VietQR flow vs Telegram policy | Explicit, undisguised policy-risk doc | `docs/04-security/TELEGRAM_POLICY_RISK.md` | Launch gate (not concealed) |

## ASVS / API Top 10 spot checks

- **Access control (API1/API5 BOLA/BFLA)**: every customer path is server-derived customer-scoped;
  owner path is numeric-id + private-context gated. Verified by BOLA and root-admin lanes.
- **Cryptographic storage (ASVS V6)**: secrets only as vault refs; delivery tokens stored as SHA-256
  hashes; confirmation challenges stored hashed; HMAC compare is constant-time.
- **Error handling / logging (ASVS V7)**: generic error envelope, redacted structured logs, immutable
  audit for financial/authorization/supplier/delivery transitions.
- **Input validation (ASVS V5)**: strict Zod at every untrusted boundary (Telegram, SePay, supplier,
  search parser); NFC normalization + length bounds on free text.

## Actions

No Critical/High remediation is open in implemented scope. Launch-gate items are enumerated in
`launch-gates.md` and must have dated owner sign-off before production.
