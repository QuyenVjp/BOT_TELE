<!--
Sync Impact Report
- Version change: template -> 1.0.0
- Added principles: Customer-first retail scope; Verified payment truth; Secrets and sole-admin identity;
  Contract-first state machines; Test-first recovery and observability
- Added sections: Product and security constraints; Spec-driven delivery gates
- Templates: plan-template.md (updated), spec-template.md (updated),
  tasks-template.md (updated)
- Deferred decisions: numeric Telegram user_id, production SePay account/credentials,
  supplier authorization per SKU, warranty/refund SLA, Telegram policy launch sign-off
-->
# VietQR Telegram Shop Constitution

## Core Principles

### I. Customer-First Retail Scope

The product MUST remain a simple automated Telegram shop for Vietnamese customers. The retail
MVP journey is `browse/search -> product detail -> Buy Now -> VietQR -> SePay verification ->
secure delivery -> order history/support`. Customer wallet, top-up, multi-item cart, loyalty,
campaigns, autonomous sales AI, Reseller API controls, and supplier internals MUST NOT appear in
the retail MVP. Any scope addition requires a separate specification and proof that it does not
increase the happy-path checkout beyond four customer actions before the QR.

### II. Verified Payment Truth and Exactly-Once Effects

VietQR MUST be treated only as payment initiation. An Order may become paid only from SePay
evidence whose raw-body integrity, timestamp/replay window, transaction uniqueness, inbound
direction, merchant account, exact amount, and order content/reference have been verified.
Screenshots, chat messages, return URLs, and status-refresh buttons MUST never create payment
evidence. Duplicate, reordered, delayed, and reconciled events MUST converge to one payment,
one supplier purchase, one asset allocation, and one Delivery Bundle.

### III. Secrets, Identity, and Least Privilege

The sole root administrator MUST be the configured immutable Telegram numeric `user_id` mapped
to `@Quyenvjp`; username is display/alert metadata only. There MUST be no `/add-admin` or
username fallback. Raw credentials and provider secrets MUST exist only in an approved vault or
secret manager and MUST NOT enter domain tables, logs, traces, events, analytics, support
transcripts, reseller webhooks, or long-lived Telegram messages. Every external input and
third-party response is untrusted and MUST be validated at its boundary.

### IV. Contract-First Domains and Explicit State Machines

Order, Payment Intent, Inventory Reservation, Supplier Order, Digital Asset, Delivery Bundle,
Refund, and Support Ticket MUST have separate owners and explicit allowed transitions. Channel
handlers, AI parsing, support tools, and provider adapters MUST submit typed commands rather than
mutating owned data. External interfaces MUST define typed input/output, stable error semantics,
idempotency, timeout/unknown behavior, pagination where lists can grow, and versioning before
implementation. AI may only return bounded catalog filters and MUST have no payment, order,
inventory, supplier, delivery, refund, or admin capability.

### V. Test-First Recovery and Observable Operations

Every meaningful behavior MUST begin with an executable acceptance, contract, property, or
integration test at the highest useful seam. Payment replay, concurrency, provider timeout,
supplier `Unknown`, worker crash, secret redaction, authorization, and reconciliation scenarios
are mandatory release tests. PostgreSQL and a transactional outbox are authoritative; caches and
queues MUST be reconstructible. Structured logs, audit events, correlation IDs, alerts, backup
restore evidence, and reconciliation runbooks MUST make every financial or delivery outcome
explainable without exposing secrets.

## Product and Security Constraints

- Only digital account/access SKUs with recorded supplier/provider resale or transfer permission
  may become active. Invite, license, seat, or activation key is preferred over shared credentials.
- The customer locale is `vi-VN`, currency is integer VND, business timezone is
  `Asia/Ho_Chi_Minh`, and data collection MUST be minimized for digital delivery.
- The implementation baseline is Node.js LTS + TypeScript, Fastify, grammY, Zod, PostgreSQL,
  Kysely, transactional outbox, Vitest, Testcontainers, fast-check, Pino, and OpenTelemetry.
  Redis/BullMQ may support ephemeral rate limits/cache/jobs but MUST NOT become the source of
  truth for payment, Order, stock, or delivery.
- Telegram/provider policy risk is a launch gate. The system MUST NOT conceal, rename, or bypass
  platform rules. The requested implementation remains VietQR + SePay; policy acceptance is a
  separate production decision.
- Supplier integration is backend-only in the retail MVP. Timeout with uncertain upstream result
  MUST enter `Unknown` and be queried/reconciled before another create request.
- Security review follows STRIDE plus relevant OWASP ASVS/API Security controls. Critical and
  High findings block implementation or release until remediated or explicitly accepted by the
  owner with a dated rationale.

## Spec-Driven Delivery Gates

1. Feature work MUST follow the project-local Spec Kit sequence:
   `$speckit-constitution -> $speckit-specify -> optional $speckit-clarify -> $speckit-plan ->
   $speckit-checklist -> $speckit-tasks -> $speckit-analyze -> $speckit-implement`.
2. `spec.md` is the authority for user value, scope, requirements, success criteria, assumptions,
   and edge cases. It MUST remain technology-agnostic.
3. `plan.md`, `research.md`, `data-model.md`, `contracts/`, and `quickstart.md` are the authority
   for implementation approach. All Constitution Check gates MUST pass before task generation.
4. Requirements-quality checklists for product, payment, security, supplier/delivery, operations,
   and API boundaries MUST be completed before implementation.
5. `tasks.md` MUST trace every buildable requirement to one or more tasks, include exact file
   paths, place tests before implementation, and preserve independently testable user-story slices.
6. `$speckit-analyze` MUST report no unresolved Critical or High constitution, ambiguity,
   inconsistency, or coverage finding before `$speckit-implement` begins.
7. Harness may orchestrate execution/review/release after Spec Kit artifacts are authoritative;
   Harness MUST NOT create a competing feature specification.

## Governance

This constitution supersedes conflicting feature plans, tasks, generated code, and informal chat
decisions. Amendments require an owner-approved rationale, a semantic version change, a Sync
Impact Report, and propagation to dependent templates and active feature artifacts. MAJOR changes
remove or redefine a non-negotiable principle; MINOR changes add or materially expand a principle
or gate; PATCH changes clarify wording without changing obligations.

Every planning review, implementation review, and release review MUST cite the constitution gates
that were checked. Deviations require a dated entry in the feature plan's Complexity Tracking
table with the rejected simpler alternative. Unresolved launch decisions may remain explicitly
documented, but they MUST block production activation of the affected capability.

**Version**: 1.0.0 | **Ratified**: 2026-07-16 | **Last Amended**: 2026-07-16
