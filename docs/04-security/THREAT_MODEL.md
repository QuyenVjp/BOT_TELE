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

| ID      | Severity | STRIDE/OWASP     | Threat                                                                        | Mandatory control                                                                                                 |
| ------- | -------: | ---------------- | ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| SEC-001 | Critical | Tampering        | Fake evidence credits wallet/marks order paid                                 | Provider signature + amount/account/reference match + reconciliation                                              |
| SEC-002 | Critical | Tampering/DoS    | Concurrent debit double-spends balance                                        | Double-entry ledger, hold, DB transaction/lock, invariant tests                                                   |
| SEC-003 |     High | Spoofing         | Stolen reseller credential creates orders                                     | Hash secret, scope, rotation, IP/mTLS option, anomaly detection                                                   |
| SEC-004 |     High | EoP/BOLA         | Tenant reads another tenant's object                                          | Server-derived tenant, object authorization on every path                                                         |
| SEC-005 |     High | Replay           | Webhook/API retry duplicates credit/fulfillment                               | Unique event/transaction, idempotency key, compare-and-swap                                                       |
| SEC-006 |     High | SSRF             | Reseller webhook targets internal/cloud metadata                              | HTTPS challenge, DNS/IP/port checks, egress allowlist, re-resolution                                              |
| SEC-007 |     High | Repudiation      | Insider changes refund/ledger without trace                                   | MFA/step-up, RBAC, explicit confirmation/cooldown, append-only audit                                              |
| SEC-008 |     High | Disclosure       | Secret/PII leaked in logs/exports/errors                                      | Redaction, minimization, export permission/cap, encryption                                                        |
| SEC-009 |   Medium | DoS              | QR/status/API spam exhausts provider/DB                                       | Per-action quotas, queue, circuit breaker, 429 Retry-After                                                        |
| SEC-010 |     High | Prompt injection | LLM is induced to call financial action                                       | No direct write tools, typed allowlist, deterministic policy/human approval                                       |
| SEC-011 | Critical | Spoofing/EoP     | Attacker uses or takes `@Quyenvjp` username to become admin                   | Authorize only configured numeric Telegram user ID; no username fallback/add-admin                                |
| SEC-012 | Critical | Disclosure       | Supplier/account credential appears in DB/log/chat/webhook                    | Vault reference, one-time delivery, secret redaction tests, least privilege                                       |
| SEC-013 |     High | Tampering        | Supplier timeout/retry buys or delivers duplicate account                     | Supplier idempotency key, unknown-state reconciliation, unique asset allocation                                   |
| SEC-014 |     High | Supply chain     | Upstream shop provides revoked/stolen/unauthorized account                    | Supplier authorization evidence, asset validation, quarantine, replacement/refund policy                          |
| SEC-015 |     High | Insecure design  | Requested VietQR digital-account flow conflicts with Telegram/provider policy | Keep explicit launch risk note, obtain approval or move payment/channel before production; never conceal the risk |
| SEC-016 |     High | Repudiation      | Sole admin changes supplier/price/delivery without review trail               | Private context, step-up, explicit confirmation, append-only audit and cooldown                                   |

## Verification baseline

- OWASP ASVS 5.0 Level 2 baseline; stronger controls for payment/admin/API.
- OWASP API Top 10 tenant/BOLA/resource-consumption tests.
- Secret, SAST, dependency, SBOM and container scans.
- Red-team lenses: unauthenticated attacker, supply chain, insider and infrastructure attacker.
- Backup restore, key rotation, provider outage and reconciliation drills.

## Where each control is implemented

Paths are relative to the repository root. Test columns name files; where a
control spans several, the named ones are the load-bearing evidence.

| ID      | Implementation                                                                                                      | Test evidence                                                                                                                                                                                             |
| ------- | ------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SEC-001 | `src/modules/payments/sepay-ingress.ts`, `src/modules/payments/sepay-webhook.ts`, `src/modules/payments/matcher.ts` | `tests/integration/payment-evidence-hardening.test.ts`, `tests/integration/sepay-inbox-durable.test.ts`                                                                                                   |
| SEC-002 | `src/infrastructure/db/migrations/063_double_entry_ledger.sql`, `src/modules/wallet/ledger.ts`                      | `tests/integration/wallet-double-entry.test.ts` (11)                                                                                                                                                      |
| SEC-003 | `src/modules/risk/service.ts`                                                                                       | `tests/security/rate-limit-coverage.test.ts` (6)                                                                                                                                                          |
| SEC-004 | `…ForOwner` reads in `src/modules/{commerce,payments,digital-goods}/repository.ts`                                  | `tests/security/bola-ownership.test.ts` (14)                                                                                                                                                              |
| SEC-005 | `src/infrastructure/inbox/sepay.ts`, `src/infrastructure/outbox/`                                                   | `tests/integration/sepay-missed-webhook-reconciliation.test.ts`, `tests/property/payment-idempotency.test.ts`                                                                                             |
| SEC-006 | `src/infrastructure/net/outbound-policy.ts`                                                                         | `tests/security/outbound-ssrf.test.ts` (86)                                                                                                                                                               |
| SEC-007 | `src/modules/identity/step-up.ts`, `src/bot/callback-codec.ts`, `src/modules/notification/service.ts`               | `tests/security/admin-step-up.test.ts` (11), `tests/integration/admin-step-up.test.ts` (9), `tests/security/sensitive-action-authorization.test.ts` (6), `tests/integration/admin-step-up-gating.test.ts` (14), `tests/security/privileged-verb-gating.test.ts` (8), `tests/integration/broadcast-confirmation.test.ts` (12) |
| SEC-008 | `src/infrastructure/observability/redact.ts`, `src/infrastructure/observability/logger.ts`                          | `tests/security/secret-redaction.test.ts` (20)                                                                                                                                                            |
| SEC-009 | `src/modules/risk/service.ts`, `src/modules/notification/rate-limit.ts`                                             | `tests/security/rate-limit-coverage.test.ts` (6)                                                                                                                                                          |
| SEC-010 | `src/modules/catalog/search-parser-port.ts`                                                                         | `tests/contract/search-parser-adapter.test.ts`                                                                                                                                                            |
| SEC-011 | `src/modules/identity/root-admin.ts`                                                                                | `tests/security/root-admin-identity.test.ts`, `tests/security/no-add-admin.test.ts`                                                                                                                       |
| SEC-012 | `src/infrastructure/vault/`, `src/modules/digital-goods/`                                                           | `tests/security/delivery-bundle.test.ts`, `tests/security/credential-leak.test.ts`                                                                                                                        |
| SEC-013 | `src/modules/supplier/`, `src/modules/digital-goods/recovery.ts`                                                    | `tests/integration/supplier-service.test.ts`, `tests/integration/supplier-fulfillment.test.ts`                                                                                                            |
| SEC-014 | `src/modules/digital-goods/asset-validation.ts`                                                                     | `tests/contract/asset-validation.test.ts`, `.github/workflows/security.yml`                                                                                                                               |
| SEC-015 | `docs/04-security/TELEGRAM_POLICY_RISK.md`                                                                          | Launch gate (operational, not automated)                                                                                                                                                                  |
| SEC-016 | `src/modules/identity/step-up.ts`, `src/modules/notification/service.ts`                                            | `tests/integration/broadcast-confirmation.test.ts` (12)                                                                                                                                                   |

All three rows above are enforced on the live path, not merely present:

- **SEC-007 / SEC-016**: `authorizeSensitiveAdminAction` is called by `handle()`
  (it proves a usable grant before a confirmation is minted) and by `confirm()`
  (it spends the grant inside the confirmation transaction, immediately before
  the mutation, so a refused step-up can never reach the business change).
  Broadcast confirmation runs the same gate with a `BROADCAST` grant, and
  production refuses to start when an admin id is configured with step-up
  disabled.
- **SEC-004**: every customer-facing entry point (checkout refresh / cancel /
  reopen, order detail, support, replacement, warranty, preorder payment)
  resolves ownership inside the query, so a foreign object and a missing one are
  the same refusal.
- A redundant `adm:` signed-callback codec was **removed** after an audit showed
  it had no production caller: Telegram already guarantees
  `callback_query.from.id` is authentic and the actor id is never read from the
  payload, so the live callbacks are gated by root identity, the durable
  confirmation and step-up instead.

Implemented controls, trust assumptions, remaining risk and operational
procedures: [`SECURITY_HARDENING.md`](./SECURITY_HARDENING.md).
CI trigger matrix, SHA pinning and scanner policy:
[`CI_SUPPLY_CHAIN.md`](./CI_SUPPLY_CHAIN.md).
