# Threat Model

## Assets

- Provider/API/webhook/channel secrets.
- Customer and reseller identity/PII.
- Orders, inventory and fulfillment entitlements.
- Payment evidence, bank references and refunds.
- Wallet/reseller credit ledger.
- Admin actions, audit and reconciliation history.
- Supplier credentials, digital account secrets, one-time delivery bundles and SePay transaction evidence.

## Trust boundaries

```text
Customer/Reseller -> Edge/WAF -> Channel/Public API -> Application commands
Payment Provider  -> Signed webhook -> Webhook inbox -> Payment domain
Admin/Support     -> Hardened admin -> Authorized domain commands
Supplier API      -> Supplier adapter -> Vault/Digital Goods domain
Domain transaction -> Outbox -> Worker -> Notifications/Reseller webhook
```

## Priority threats

| ID | Severity | STRIDE/OWASP | Threat | Mandatory control |
|---|---:|---|---|---|
| SEC-001 | Critical | Tampering | Fake evidence credits wallet/marks order paid | Provider signature + amount/account/reference match + reconciliation |
| SEC-002 | Critical | Tampering/DoS | Concurrent debit double-spends balance | Double-entry ledger, hold, DB transaction/lock, invariant tests |
| SEC-003 | High | Spoofing | Stolen reseller credential creates orders | Hash secret, scope, rotation, IP/mTLS option, anomaly detection |
| SEC-004 | High | EoP/BOLA | Tenant reads another tenant's object | Server-derived tenant, object authorization on every path |
| SEC-005 | High | Replay | Webhook/API retry duplicates credit/fulfillment | Unique event/transaction, idempotency key, compare-and-swap |
| SEC-006 | High | SSRF | Reseller webhook targets internal/cloud metadata | HTTPS challenge, DNS/IP/port checks, egress allowlist, re-resolution |
| SEC-007 | High | Repudiation | Insider changes refund/ledger without trace | MFA/step-up, RBAC, explicit confirmation/cooldown, append-only audit |
| SEC-008 | High | Disclosure | Secret/PII leaked in logs/exports/errors | Redaction, minimization, export permission/cap, encryption |
| SEC-009 | Medium | DoS | QR/status/API spam exhausts provider/DB | Per-action quotas, queue, circuit breaker, 429 Retry-After |
| SEC-010 | High | Prompt injection | LLM is induced to call financial action | No direct write tools, typed allowlist, deterministic policy/human approval |
| SEC-011 | Critical | Spoofing/EoP | Attacker uses or takes `@Quyenvjp` username to become admin | Authorize only configured numeric Telegram user ID; no username fallback/add-admin |
| SEC-012 | Critical | Disclosure | Supplier/account credential appears in DB/log/chat/webhook | Vault reference, one-time delivery, secret redaction tests, least privilege |
| SEC-013 | High | Tampering | Supplier timeout/retry buys or delivers duplicate account | Supplier idempotency key, unknown-state reconciliation, unique asset allocation |
| SEC-014 | High | Supply chain | Upstream shop provides revoked/stolen/unauthorized account | Supplier authorization evidence, asset validation, quarantine, replacement/refund policy |
| SEC-015 | High | Insecure design | Requested VietQR digital-account flow conflicts with Telegram/provider policy | Keep explicit launch risk note, obtain approval or move payment/channel before production; never conceal the risk |
| SEC-016 | High | Repudiation | Sole admin changes supplier/price/delivery without review trail | Private context, step-up, explicit confirmation, append-only audit and cooldown |

## Verification baseline

- OWASP ASVS 5.0 Level 2 baseline; stronger controls for payment/admin/API.
- OWASP API Top 10 tenant/BOLA/resource-consumption tests.
- Secret, SAST, dependency, SBOM and container scans.
- Red-team lenses: unauthenticated attacker, supply chain, insider and infrastructure attacker.
- Backup restore, key rotation, provider outage and reconciliation drills.
