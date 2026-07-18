# Operations Requirements Checklist: Telegram Shop Digital MVP

**Purpose**: Validate reliability, reconciliation, support, performance, and launch-readiness requirements before implementation
**Created**: 2026-07-16
**Feature**: [spec.md](../spec.md)

## State and Recovery Coverage

- [x] CHK001 Are distinct Order, payment, supplier, asset, delivery, discrepancy, and ticket outcomes represented in requirements? [Completeness, Spec §Key Entities]
- [x] CHK002 Are process/worker/provider restart and safe-resume outcomes specified? [Recovery, Spec §SR-006]
- [x] CHK003 Is supplier timeout uncertainty explicitly separated from rejection and success? [Clarity, Spec §FR-015]
- [x] CHK004 Are unavailable-stock-after-payment and invalid-supplier-asset outcomes covered? [Exception Flow, User Story 3]
- [x] CHK005 Are expired/late payment and expired/unviewed delivery recovery paths addressed? [Coverage, Spec §Edge Cases]

## Reconciliation and Support

- [x] CHK006 Does the specification require every payment discrepancy to retain traceable evidence, owner, and resolution status? [Completeness, Spec §FR-011–FR-012]
- [x] CHK007 Is it explicit that support cannot mutate payment truth or reveal credentials? [Consistency, User Story 4]
- [x] CHK008 Are replacement/refund reviews required to preserve original Order and delivery history? [Auditability, Spec §FR-020]
- [x] CHK009 Is the no-silent-loss/no-silent-fulfillment outcome measurable across seeded discrepancy types? [Measurability, Spec §SC-008]

## Performance and Capacity

- [x] CHK010 Is product discovery time quantified from a customer perspective? [Clarity, Spec §SC-001]
- [x] CHK011 Is the maximum number of actions before QR explicitly measurable? [Clarity, Spec §SC-002]
- [x] CHK012 Are response and paid-to-delivery targets quantified with percentiles and dependency condition? [Measurability, Spec §SC-003–SC-004]
- [x] CHK013 Is the initial scale assumption explicitly bounded in the implementation plan? [Assumption, Plan §Technical Context]

## Observability and Launch Gates

- [x] CHK014 Are financial, authorization, supplier, delivery, and manual-review audit requirements specified? [Coverage, Spec §SR-005]
- [x] CHK015 Are production dependencies and sign-offs explicitly listed? [Completeness, Spec §Dependencies & Launch Gates]
- [x] CHK016 Are required outage, reconciliation, credential-leak, replacement/refund, backup, and restore runbooks named? [Coverage, Spec §Dependencies & Launch Gates]
- [x] CHK017 Does readiness require zero unresolved Critical/High findings rather than vague “secure enough” language? [Clarity, Spec §SR-008]
- [x] CHK018 Is requirement-to-task-and-test traceability measurable before coding? [Traceability, Spec §SC-010]
- [x] CHK019 Is checkout load evidence required to record p95, peak pool occupancy, timeout outcomes, and zero orphan Orders/Payment Intents? [Spec §SC-011]
- [x] CHK020 Is durable restock subscription retained as explicit future work rather than represented by a dead callback? [Spec §FR-006b]
- [x] CHK021 Is supplier capacity hold/reconciliation/refund retained as mandatory future work while Feature 001 fails closed? [Spec §FR-006e]

## Gate 0 Upgrade/Recovery Operations (2026-07-17)

- [x] CHK022 Are compiled existing-DB upgrades required for both SePay-only and prior-expanded migration 008 histories? [Spec §FR-029]
- [x] CHK023 Is a fail-closed `telegram`/`TELEGRAM` collision runbook required before migration retry? [Spec §FR-029]
- [x] CHK024 Are PREPARED/STORED/READY recovery, source-ack ordering, and SENT/DEAD/expired capability cleanup bounded and observable? [Spec §FR-017a, FR-026]
- [x] CHK025 Are Mini App redemption, Telegram 429/ambiguous-send reconciliation, and worker liveness included in staging evidence? [Spec §FR-027, FR-029]

## Notes

- All requirements-quality checks pass. Operational commands and evidence will be bound to actual scripts during implementation tasks.
