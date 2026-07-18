# Security Requirements Quality Checklist — Quantity, Payment, and Fanout

**Purpose:** Validate that security requirements are complete, explicit, and release-gated.
**Audience:** Security/release reviewer before implementation.

## Identity and authorization

- [x] CHK001 — Is the sole root administrator identified by immutable numeric Telegram user ID, with username used only as drift metadata? [Completeness, Constitution §III]
- [x] CHK002 — Are private-chat context, ownership checks, opaque callback scope, and denial auditing required for every customer/admin action? [Coverage, Spec §FR-322]
- [x] CHK003 — Are admin broadcast draft, preview, confirm, schedule, send, and cancel actions bound to an expiring step-up and action fingerprint? [Clarity, Contract `admin-broadcast.md`]
- [x] CHK004 — Does the requirement explicitly prohibit username fallback, `/add-admin`, arbitrary admin HTML/files/URLs, and marketing in critical-service messages? [Completeness, Constitution §III, Spec §Out of Scope]

## Payment and financial integrity

- [x] CHK005 — Are QR, check, and cancel callbacks described as non-authoritative commands that cannot create payment evidence or mark an Order paid? [Clarity, Spec §FR-311–FR-312]
- [x] CHK006 — Are SePay integrity, replay window, transaction uniqueness, inbound direction, merchant account, exact amount, and transfer-content checks preserved? [Completeness, Constitution §II]
- [x] CHK007 — Are duplicate, reordered, delayed, wrong, partial, over, late, and unmatched transactions assigned safe outcomes without silent fulfillment? [Coverage, Spec §FR-313]
- [x] CHK008 — Is the manual reconciliation fee an exact snapshotted integer VND policy rather than a hardcoded or dynamically converted USD amount? [Clarity, Spec §FR-313]
- [x] CHK009 — Are cancellation/settlement race semantics explicit so a verified payment cannot be reverted or released incorrectly? [Recovery, Contract `payment-session.md`]

## Secrets, privacy, and redaction

- [x] CHK010 — Does the requirement forbid raw credentials, provider secrets, bank secrets, transfer references, and private totals from logs, events, analytics, support transcripts, and long-lived Telegram messages? [Completeness, Constitution §III]
- [x] CHK011 — Is the Delivery Bundle boundary and one-time/controlled-reveal policy stated for every quantity, including reissue and failure paths? [Coverage, Spec §FR-308]
- [x] CHK012 — Does purchase activity explicitly forbid buyer name/username/ID, Order code, payment reference, bank/account details, credentials, and private total? [Clarity, Spec §FR-318]
- [x] CHK013 — Are product/restock and admin announcement fields restricted to authoritative, allowlisted display data? [Completeness, Contracts `notification-templates.md`, `admin-broadcast.md`]
- [x] CHK014 — Are secret-scan, credential-leak, telemetry-redaction, and privacy fixtures named as release evidence rather than informal best effort? [Acceptance, Spec §SC-307]

## Abuse resistance and availability

- [x] CHK015 — Are Buy Now/payment creation limits, check-payment cooldown/hourly limits, callback dedupe, and body/input bounds quantified? [Clarity, Spec §Anti-Spam]
- [x] CHK016 — Is synchronous SePay polling per customer click explicitly prohibited, with local projection/queued reconciliation as the safe alternative? [Consistency, Spec §FR-311]
- [x] CHK017 — Are global/per-chat Telegram limits, `retry_after`, exponential backoff, bounded retries, blocked-chat suppression, and cancellation of unsent batches specified? [Completeness, Spec §FR-323]
- [x] CHK018 — Are preference changes evaluated immediately before send so queued marketing/social messages cannot bypass an opt-out? [Clarity, Spec §FR-324]
- [x] CHK019 — Is purchase-activity aggregation required to prevent an all-customers-per-sale message storm while retaining an auditable event count? [Acceptance, Spec §FR-319]
- [x] CHK020 — Are idempotency keys and uniqueness scopes defined for Order creation, payment callbacks, notification events, campaign deliveries, and supplier units? [Completeness, Spec §FR-306, FR-322–FR-324]

## Threat, audit, and recovery gates

- [x] CHK021 — Is every external input and third-party response treated as untrusted and validated at a boundary? [Completeness, Constitution §III]
- [x] CHK022 — Are impersonation, unauthorized broadcast, failed step-up, replay, duplicate settlement, secret leakage, and rate-limit abuse auditable with correlation IDs? [Coverage, Spec §SC-304, SC-310]
- [x] CHK023 — Are partial supplier fulfillment, worker crash, queue restart, Telegram timeout, and dead-letter handling required to converge without duplicate delivery or purchase? [Recovery, Constitution §V]
- [x] CHK024 — Are cache/queue reconstruction and PostgreSQL/outbox authority explicit for payment, Order, stock, delivery, and notification outcomes? [Consistency, Plan §Technical Context]
- [x] CHK025 — Are STRIDE/OWASP Critical and High findings release blockers with owner-approved dated exceptions only? [Governance, Constitution §Product and Security Constraints]
- [x] CHK026 — Are load/abuse tests required to demonstrate frequency caps and bounded fanout without exposing customer or payment data? [Non-Functional, Spec §SC-308–SC-309]
