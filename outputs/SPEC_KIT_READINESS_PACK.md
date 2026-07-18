# GitHub Spec Kit Readiness Pack — Telegram Shop Digital MVP

## Installation and integration

- GitHub Spec Kit CLI: `specify 0.12.16`, installed globally through `uv tool` from the official `github/spec-kit` v0.12.16 tag.
- Codex integration: project-local skills under `.agents/skills/speckit-*`.
- Project infrastructure: `.specify/` with PowerShell scripts, templates, workflow, and Constitution 1.0.0.
- Global routing: `C:\Users\ADMIN\.codex\AGENTS.md` now requires Spec Kit for meaningful pre-code feature truth and preserves Harness for execution/review/release orchestration.

Official source: https://github.com/github/spec-kit/tree/v0.12.16

## Published artifacts

1. [Project Constitution](./SPEC_KIT_CONSTITUTION.md)
2. [Customer-first feature specification](./SPEC_KIT_FEATURE_SPEC.md)
3. [Technical implementation plan](./SPEC_KIT_IMPLEMENTATION_PLAN.md)
4. [Requirement traceability matrix](./SPEC_KIT_TRACEABILITY.md)
5. [114 dependency-ordered tasks](./SPEC_KIT_TASKS.md)
6. [Cross-artifact analysis](./SPEC_KIT_ANALYSIS.md)
7. [Existing MVP customer flow](./MVP_CUSTOMER_FLOW.md)
8. [VietQR + SePay research/check flow](./VIETQR_SEPAY_CHECK_FLOW.md)
9. [AI Support feature specification](../specs/002-ai-support/spec.md)
10. [AI Support implementation plan](../specs/002-ai-support/plan.md)
11. [AI Support tasks](../specs/002-ai-support/tasks.md)
12. [AI Support analysis](../specs/002-ai-support/analysis.md)

The canonical feature folder also contains research, data model, quickstart, five interface contracts,
and requirements/security/operations checklists under `specs/001-telegram-shop-mvp/`.

## Pre-code result

- 24 functional requirements, 8 security/policy requirements, and 10 measurable outcomes.
- 42/42 buildable requirements/outcomes mapped to tasks and test/evidence seams (100%).
- 114 tasks, all sequentially numbered with exact future file paths and test-first ordering.
- Five independently testable user-story phases: catalog/search, VietQR/SePay payment, secure
  fulfillment, Order/support recovery, and sole-owner operations.
- Zero unresolved Critical, High, or Medium cross-artifact finding.
- Production remains correctly blocked on numeric root-admin ID, supplier/SKU authorization, SePay
  production setup, warranty/refund policy, operational drills, and Telegram policy-risk sign-off.
- AI support is specified as a read-only, source-grounded assistant using the configured qrouter
  Responses provider; it cannot mutate payment/order/inventory/delivery/admin state.

No application source code has been started. The next authorized action is implementation through
`$speckit-implement`, with Harness used later for execution review and release evidence.
