# Research: Telegram Shop Digital MVP

## Decision 1: Use GitHub Spec Kit as the feature source-of-truth workflow

**Decision**: Use project-local Codex skills and artifacts in the order constitution, specify,
plan, checklist, tasks, analyze, implement.

**Rationale**: Spec Kit 0.12.16 officially supports Codex skills under `.agents/skills` and separates
what/why requirements from implementation planning and task traceability.

**Alternatives considered**: Keep only the existing free-form docs; rejected because they do not
provide a repeatable artifact gate or requirement-to-task analysis.

**Source**: https://github.com/github/spec-kit/tree/v0.12.16

## Decision 2: Node.js 24 LTS and current major libraries

**Decision**: Target Node.js 24 LTS, TypeScript strict mode, Fastify 5, grammY 1, Zod 4, Kysely
0.29, Vitest 4, Testcontainers 12, fast-check 4, Pino 10, and OpenTelemetry API 1.

**Rationale**: Node 24 is the current LTS line as of the research date. The selected libraries keep
the application type-safe and adapter-oriented without imposing an enterprise framework or ORM
runtime. Pin exact versions in the lockfile at implementation start; major upgrades require
contract/test verification.

**Alternatives considered**: NestJS (more framework surface than the small MVP needs), Prisma
(larger generated/runtime abstraction than necessary), microservices (unjustified consistency and
operations cost).

**Sources**:

- https://nodejs.org/en/about/previous-releases
- https://fastify.dev/docs/latest/
- https://grammy.dev/
- https://zod.dev/
- https://kysely.dev/
- https://vitest.dev/
- https://node.testcontainers.org/
- https://fast-check.dev/
- https://getpino.io/
- https://opentelemetry.io/docs/languages/js/

## Decision 3: VietQR initiates; SePay proves and reconciles payment

**Decision**: Generate exact-amount VietQR data with a unique Order content. Accept payment truth
only from a SePay transaction whose signed raw request and business fields are verified, then use
periodic reconciliation to recover missing webhooks.

**Rationale**: VietQR is QR/payment initiation, not settlement evidence. SePay documents raw-body
HMAC/timestamp authentication, webhook security/retry, and transaction reconciliation.

**Alternatives considered**: Screenshot/OCR, status button, redirect URL, unofficial bank login,
or QR alone; rejected because none provides trustworthy automated settlement evidence.

**Sources**:

- https://www.vietqr.io/danh-sach-api/link-tao-ma-nhanh/
- https://www.vietqr.io/danh-sach-api/link-tao-ma-nhanh/api-tao-ma-qr
- https://developer.sepay.vn/vi/sepay-webhooks/xac-thuc
- https://developer.sepay.vn/vi/sepay-webhooks/bao-mat
- https://developer.sepay.vn/vi/sepay-webhooks/xu-ly-loi
- https://developer.sepay.vn/vi/sepay-webhooks/doi-soat-giao-dich

## Decision 4: PostgreSQL transactional outbox is authoritative

**Decision**: Commit domain state plus outbox record in one PostgreSQL transaction. Workers process
at-least-once and consumers deduplicate by event/resource/business-effect keys.

**Rationale**: Payment, asset allocation, supplier purchase, and delivery cannot depend on an
ephemeral queue. An outbox provides crash recovery without distributed transactions.

**Alternatives considered**: Redis/BullMQ as sole authority (data-loss/rebuild risk), synchronous
provider calls inside domain transactions (long locks and uncertain outcomes), microservices
(premature distributed consistency).

## Decision 5: Bound AI to catalog filter parsing

**Decision**: Run deterministic catalog search first. A language model, if configured, returns only
schema-validated filters and has no domain tools. The database supplies every displayed fact.

**Rationale**: This preserves the user convenience of natural-language search without allowing
hallucinated offers or prompt-driven financial actions.

**Alternatives considered**: Autonomous sales agent, direct tool calling, internet product search;
rejected as unnecessary and unsafe for the MVP.

## Decision 6: Supplier timeout uncertainty is a domain state

**Decision**: Supplier create calls carry stable idempotency keys. A transport timeout after request
submission moves the Supplier Order to `Unknown`; query/reconciliation precedes another create.

**Rationale**: Blind retry can purchase two upstream assets. HTTP success also requires response
schema and asset validation before fulfillment truth.

**Alternatives considered**: Retry create immediately, treat HTTP 200 as valid asset, silently swap
supplier/SKU; rejected because each can violate customer promise and exactly-once fulfillment.

## Decision 7: Vault-backed view-once delivery

**Decision**: Keep raw secret material in a vault and issue a customer-and-Order-bound Delivery
Bundle with TTL and atomic first-view consumption.

**Rationale**: Telegram chat history, logs, events, support data, and domain tables are unsuitable
long-lived secret stores. Atomic consumption prevents concurrent/replayed reveal.

**Alternatives considered**: Send username/password directly in chat or store encrypted blobs in
ordinary domain rows; rejected due to exposure, access, and retention risk.

## Decision 8: Telegram is an adapter and a policy launch gate

**Decision**: Use Telegram webhook secret verification, update dedupe, opaque callback tokens,
edit-in-place messages, and numeric user IDs. Keep the official digital-goods payment policy risk
as an explicit production gate rather than claiming or disguising compliance.

**Sources**:

- https://core.telegram.org/bots/api#setwebhook
- https://core.telegram.org/bots/features#payments
- https://core.telegram.org/bots/payments-stars
## Gate 0 correction research (2026-07-17)

### Decision: reserve a new Feature 001 migration for identity/delivery security

- **Decision**: Freeze `008_sepay_inbox_security.sql` as the SePay-only migration and create
  `009_identity_delivery_security.sql`. Feature 003 becomes `010_notifications_quantity.sql` and
  Feature 002 becomes `011_ai_support.sql`.
- **Rationale**: Migration files are append-only. Existing databases may record 008 before identity
  and delivery objects exist, while a prior local snapshot may have expanded 008 already. Migration
  009 must detect both shapes, preserve data, normalize canonical `TELEGRAM`, and fail closed on
  case collisions rather than silently merging identities.
- **Alternatives rejected**: Editing 008 would invalidate applied migration provenance; silently
  merging collisions would violate the identity least-privilege principle.

### Decision: recoverable handoff state, vault outside long transactions

- **Decision**: Persist deterministic PREPARED handoff intent before source acknowledgement, perform
  vault I/O outside long PostgreSQL transactions, and use STORED/READY or compensation state with
  bounded cleanup. Recovery reconstructs the same capability key idempotently.
- **Rationale**: A crash after Bundle commit or a DB rollback after vault write must not strand the
  paid customer or leave a redeemable orphan.
- **Alternatives rejected**: Keeping plaintext in the call stack and performing network I/O inside a
  DB transaction are not recoverable under process failure or timeout.

### Decision: dedicated delivery key ring and Mini App transport

- **Decision**: Add dedicated delivery-session key/current-previous grace/TTL configuration and use
  a Telegram Mini App that verifies bounded `initData` and performs one-time audience-bound
  redemption. Refresh an expired session only while the Bundle remains live and only idempotently.
- **Rationale**: Telegram URL buttons do not guarantee an Authorization header; reusing Buy Now or
  provider keys would violate key separation and complicate rotation.

### Decision: username privacy

- **Decision**: Exclude `actorUsername` from durable Telegram inbox envelopes. Root bootstrap uses
  numeric ID only. A real username observation may update metadata only from a secret-verified
  webhook and is bounded by explicit retention/pruning.
- **Rationale**: Usernames are mutable metadata, not identity, and durable inbox retention is not a
  justified privacy boundary for them.
