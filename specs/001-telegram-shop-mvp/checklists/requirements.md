# Specification Quality Checklist: Telegram Shop Digital MVP

**Purpose**: Validate specification completeness and quality before technical planning
**Created**: 2026-07-16
**Feature**: [spec.md](../spec.md)

## Content Quality

- [x] No language/framework/database implementation choices are embedded in the feature requirements.
- [x] The specification focuses on customer value, owner risk, and business outcomes.
- [x] The document is readable by non-technical stakeholders while retaining testable rules.
- [x] All mandatory sections are complete.

## Requirement Completeness

- [x] No `[NEEDS CLARIFICATION]` markers remain.
- [x] Functional and security requirements use stable IDs and testable MUST statements.
- [x] Success criteria are measurable and technology-agnostic.
- [x] Primary, alternate, exception, recovery, concurrency, and abuse scenarios are covered.
- [x] Scope, assumptions, dependencies, and production launch gates are explicit.

## Feature Readiness

- [x] User stories cover discovery, payment, fulfillment, support, and sole-owner operation.
- [x] Every story has an independent test and Given/When/Then acceptance scenarios.
- [x] Edge cases include payment timing/mismatch, provider loss, supplier uncertainty, concurrency, and secure-delivery replay.
- [x] Customer wallet, reseller controls, growth features, and autonomous AI are explicitly outside the MVP.
- [x] The feature is ready for technical planning with unresolved production inputs represented as launch gates rather than ambiguous requirements.

## Follow-up Review Remediation (2026-07-16)

Added after `remediation-review.md` reopened Feature 001 at `REQUEST_CHANGES`.

- [x] CHK101 Is atomic pre-payment inventory reservation required, with the reservation committing in the same transaction as the Order and before any Payment Intent? [Spec §FR-006a]
- [x] CHK102 Is the stock-loser experience defined with one typed truthful message, no Order/intent/QR/charge, only working actions, and no fake restock callback? [Spec §FR-006a–b]
- [x] CHK103 Is reservation release on cancel/expiry atomic and crash-recoverable via a bounded job? [Spec §FR-006c, FR-026]
- [x] CHK104 Is same-customer double-tap collapsed to one Order/reservation/intent via a stable signed nonce and `ON CONFLICT` winner-read (no query on aborted transaction)? [Spec §FR-006d]
- [x] CHK105 Is settlement evidence required to be a branded/verified value, with forgeable raw payloads rejected and never stored `VERIFIED`? [Spec §FR-009]
- [x] CHK106 Is money for a cancelled/expired/already-paid Order required to become an owned discrepancy rather than a silent drop or second OrderPaid? [Spec §FR-011]
- [x] CHK107 Is fulfillment claim state + outbox event required in one transaction? [Spec §FR-013]
- [x] CHK108 Is outbox owner fencing (owner + generation/lease token) required on every ack/fail so a stale worker changes zero rows? [Spec §FR-025]
- [x] CHK109 Are recovery jobs required to use bounded `SKIP LOCKED` batches with backlog/age telemetry rather than unbounded stale lists? [Spec §FR-026]
- [x] CHK110 Is durable AdminConfirmation across restart with atomic consume+mutation+audit required? [Spec §FR-023]
- [x] CHK111 Is crash-safe two-phase delivery reveal with signed Telegram-bound session (no trusted client header) required? [Spec §FR-027, SR-003]
- [x] CHK112 Are the SePay merchant identity and VietQR beneficiary account number separate typed keys while equal pilot values and distinct VA/sub-account values are both valid? [Spec §FR-008]
- [x] CHK113 Is invalid/future `transactedAt` rejection and `transactedAt`-based late classification required? [Spec §SR-002]
- [x] CHK114 Are `NO_STOCK`, `CONTENTION_TIMEOUT`, and `RESERVATION_LOST` the only new BuyNow stock outcomes, with `OUT_OF_STOCK` restricted to deprecated internal compatibility? [Spec §FR-006a]
- [x] CHK115 Is `SUPPLIER_ONLY` explicitly fail-closed and excluded from purchasable surfaces without deleting supplier fulfillment from the roadmap? [Spec §FR-002, FR-006e]
- [x] CHK116 Are active fulfillment holds and delivered history separate deterministic lookups, with replacement linked to the original delivered asset? [Spec §FR-014, FR-020]
- [x] CHK117 Are mutually compatible buyer locks, admin serialization, bounded transaction-level retry, p95/pool occupancy, and orphan-free evidence required? [Spec §SC-011]

## Gate 0 Correction (2026-07-17)

- [x] CHK118 Does the SePay contract require durable PostgreSQL acceptance before exact HTTP 200 success and asynchronous worker settlement? [Spec §FR-009a]
- [x] CHK119 Does the claimed SePay envelope carry rawHash and require source/provider/payload/account/amount/code/content/reference/timestamp consistency before restoring trust? [Spec §FR-009a]
- [x] CHK120 Is mutated replay alerting atomic and idempotent by source event plus incoming raw hash? [Spec §FR-009a]
- [x] CHK121 Is independent QR image/media proof required instead of a text-only self-round-trip? [Spec §FR-008a]
- [x] CHK122 Is fresh Telegram customer/channel bootstrap atomic, canonicalized, username-independent, and root-resolvable? [Spec §FR-021]
- [x] CHK123 Are signed delivery sessions, durable notification capability handoff, external adapters, and compiled fresh-DB boot explicit launch requirements? [Spec §FR-017, FR-017a, FR-028, FR-029]

## Gate 0 Crash/Upgrade/Transport Correction (2026-07-17)

- [x] CHK124 Is crash-after-Bundle-commit/before-handoff recovery explicitly specified without call-stack plaintext dependency? [Spec §FR-017a]
- [x] CHK125 Is vault-write-success/DB-rollback compensation and bounded orphan cleanup specified without long database-held network I/O? [Spec §FR-017a, SR-006]
- [x] CHK126 Are expired-session refresh, dedicated current/previous delivery keys, grace window, and no-expired-SENT behavior objectively specified? [Spec §FR-017]
- [x] CHK127 Is the customer-usable Telegram Mini App transport specified without assuming URL buttons send Authorization headers? [Spec §FR-027]
- [x] CHK128 Are SePay-only/prior-expanded 008 upgrade paths, migration 009 ownership, preserved rows, and case-collision fail-closed behavior explicit? [Spec §FR-029]
- [x] CHK129 Is durable inbox username exclusion, numeric-only root bootstrap, verified observation, retention, and pruning specified? [Spec §FR-021, FR-024a]
- [x] CHK130 Does the complete traceability matrix enumerate all 57 FR/SR/SC identifiers with tasks and evidence seams? [Spec §SC-010]

## Gate 0 External Boundary and Refresh Correction (2026-07-18)

- [x] CHK131 Does the vault requirement define one deadline across headers, streamed body, size accounting, decode, and parse rather than only connection/header receipt? [Completeness, Spec §FR-028, SR-004]
- [x] CHK132 Are distinct material and serialized-envelope limits, exact-maximum round-trip behavior, and pre-network max-plus-one rejection unambiguous? [Clarity, Spec §FR-028, SR-004]
- [x] CHK133 Are redirect refusal, endpoint component restrictions, production HTTPS, and deployment-controlled host/port/CIDR egress rules specified without forbidding an explicitly approved private vault? [Consistency, Spec §FR-028]
- [x] CHK134 Are strict status/content-type/schema/body-finalization requirements defined for every health/write/reveal/delete success and failure path? [Completeness, Spec §FR-028, SR-004]
- [x] CHK135 Does delivery compensation retain a durable orphan reference when both database swap and vault delete fail, with bounded cleanup that cannot erase the recovery pointer early? [Recovery Coverage, Spec §FR-017a, SR-006]
- [x] CHK136 Are refresh operation identity, crash windows, lease transfer, and one-usable-capability convergence objectively specified? [Concurrency Coverage, Spec §FR-017a, SC-005]
- [x] CHK137 Is previous-key acceptance bounded by an explicit deadline independent of token expiry, with mandatory production session verification and cross-domain anti-reuse? [Security Clarity, Spec §FR-017, SR-001]
- [x] CHK138 Is the Telegram secret gate explicitly required to precede both durable inbox and username-observation persistence? [Security Coverage, Spec §FR-021, FR-024a]

## Notes

- The specification deliberately names VietQR and SePay because the owner selected them as product constraints; implementation details remain in the plan and contracts.
- The Follow-up Review Remediation items above are requirements-quality checks; their implementation
  evidence is tracked by Phase 10 tasks (`T154`+) in `tasks.md`, not by these checkboxes.
