# Security Requirements Checklist: Telegram Shop Digital MVP

**Purpose**: Validate the completeness, clarity, consistency, and measurability of security requirements before implementation
**Created**: 2026-07-16
**Feature**: [spec.md](../spec.md)

## Identity and Authorization

- [x] CHK001 Is the sole root administrator defined by immutable numeric Telegram identity rather than username? [Completeness, Spec §FR-021]
- [x] CHK002 Are private-context and explicit-confirmation requirements defined for high-risk owner actions? [Coverage, Spec §FR-023]
- [x] CHK003 Is creation of additional root administrators explicitly prohibited? [Clarity, Spec §FR-022]
- [x] CHK004 Are object-ownership requirements explicit for Orders, tickets, and Delivery Bundles? [Coverage, Spec §SR-003]
- [x] CHK005 Are denial and audit outcomes specified for username impersonation and wrong-context attempts? [Scenario Coverage, User Story 5]

## Payment Integrity and Replay

- [x] CHK006 Are all facts required for automatic payment settlement explicitly enumerated? [Completeness, Spec §SR-002]
- [x] CHK007 Is the non-evidence status of screenshots, chat, return URLs, and refresh actions unambiguous? [Clarity, User Story 2]
- [x] CHK008 Are duplicate, reordered, late, partial, overpaid, wrong-reference, and unmatched cases addressed? [Coverage, Spec §FR-010–FR-012]
- [x] CHK009 Is exactly-once behavior measurable across payment, supplier purchase, asset allocation, and delivery? [Measurability, Spec §SC-005]
- [x] CHK010 Are missing-webhook recovery and reconciliation requirements defined without bypassing verification? [Recovery, Spec §FR-012]

## Credential and Secret Protection

- [x] CHK011 Are all prohibited secret-storage and telemetry surfaces listed? [Completeness, Spec §SR-001]
- [x] CHK012 Are Delivery Bundle ownership, expiry, view-once, replay, and reissue scenarios covered? [Coverage, Spec §FR-017 and User Story 3]
- [x] CHK013 Is the zero-secret-leak success criterion objectively measurable? [Measurability, Spec §SC-007]
- [x] CHK014 Are supplier responses and external payloads treated as untrusted with bounded contracts? [Completeness, Spec §SR-004]

## Abuse, Availability, and Recovery

- [x] CHK015 Are abuse controls required without removing paid-order/support recovery? [Consistency, Spec §FR-024]
- [x] CHK016 Are crash/restart requirements explicit for every non-repeatable business effect? [Recovery, Spec §SR-006]
- [x] CHK017 Are concurrent last-asset purchase and concurrent reveal edge cases documented? [Coverage, Spec §Edge Cases]
- [x] CHK018 Are audit requirements attributable and immutable for financial, supplier, delivery, and manual actions? [Clarity, Spec §SR-005]

## Policy and Supply Chain

- [x] CHK019 Is resale/transfer authorization an explicit SKU activation requirement? [Policy, Spec §SR-007]
- [x] CHK020 Are production policy/security sign-offs listed as launch gates rather than implied compliance? [Completeness, Spec §SR-008]

## Follow-up Review Remediation (2026-07-16)

- [x] CHK021 Is settlement evidence required to be a branded/verified value that cannot be forged by constructing a raw `PaymentEvidence` object? [Spec §FR-009]
- [x] CHK022 Is Delivery Bundle access forbidden from trusting a client-supplied customer identity header? [Spec §FR-027, SR-003]
- [x] CHK023 Is high-risk admin confirmation required to be durable across restart rather than process-local memory? [Spec §FR-023]
- [x] CHK024 Is outbox ack/fail required to be owner-fenced so a stale worker cannot clear a reclaimed event? [Spec §FR-025]
- [x] CHK025 Is pre-payment inventory reservation required so two customers cannot both receive a chargeable QR for the final unit? [Spec §FR-006a]
- [x] CHK026 Does Payment presentation fail closed for `SUPPLIER_ONLY`, `PAUSED`, null, and unknown policy snapshots, including hand-inserted Orders? [Spec §FR-006e]
- [x] CHK027 Does replacement preserve the original delivered credential history and prevent fulfillment re-entry from re-delivering it? [Spec §FR-014, FR-020]

## Notes

- All requirements-quality checks pass at the requirements level. Implementation evidence for the
  follow-up remediation items is tracked by Phase 9 reopened tasks and Phase 10 (`T154`+) — these
  checklist boxes do not claim code is green.

## Gate 0 Correction (2026-07-17)

- [x] CHK028 Is SePay persisted evidence immutable and hash-bound before a worker can restore its verified trust brand? [Spec §FR-009a, SR-002]
- [x] CHK029 Does mutation alerting avoid duplicate security records during replay floods? [Spec §FR-009a, SR-005]
- [x] CHK030 Does delivery authentication prohibit caller-supplied identity and bind audience, nonce, expiry, key version, Telegram ID, and bundle? [Spec §FR-017, SR-003]
- [x] CHK031 Are external vault/supplier/Telegram responses bounded and redacted, with unknown/retry behavior explicit? [Spec §FR-015, FR-028, SR-004]

## Gate 0 Delivery/Privacy Correction (2026-07-17)

- [x] CHK032 Is delivery signing explicitly separated from Buy Now, Telegram, SePay, vault, and supplier keys? [Spec §FR-017, SR-001]
- [x] CHK033 Are previous-key grace, unknown-version rejection, expiry refresh, and one-usable-capability invariants defined? [Spec §FR-017]
- [x] CHK034 Are pre-send Bundle/Customer/chat claims and Mini App initData ownership binding required before reveal? [Spec §FR-017a, FR-027, SR-003]
- [x] CHK035 Is a redeemable vault orphan prohibited after database rollback, with bounded compensation and cleanup? [Spec §FR-017a, SR-006]
- [x] CHK036 Is username retention excluded from durable inbox and limited to verified Telegram observations with pruning? [Spec §FR-021, FR-024a]
