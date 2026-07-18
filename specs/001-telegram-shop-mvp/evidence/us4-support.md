# US4 Support Evidence (T089)

**Date**: 2026-07-16
**Scope**: User Story 4 — Order History and Support (FR-018, FR-019, SR-003)

## Acceptance lane

Command:

```bash
npx vitest run tests/acceptance/support-journey.test.ts
```

Result:

```
✓ tests/acceptance/support-journey.test.ts (1 test)
  ✓ Alice sees only her orders and opens a structured ticket without a secret
```

The journey drives history list → detail → structured ticket open against a real
PostgreSQL container. Alice sees only her orders; Bob's never surface; the ticket
stores a safe summary without the pasted secret.

## Historical supporting lanes (superseded as final-source evidence)

```
✓ tests/security/order-history.test.ts      (4)   FR-018/SR-003 BOLA + keyset pagination + status projection
✓ tests/integration/support-ticket.test.ts  (5)   FR-019 structured reason, safe summary, SLA, ownership
✓ tests/security/support-boundary.test.ts   (3)   support surface exposes only ticket verbs
```

Combined suite at US4 close: **232 tests / 39 files passed**.

## Requirement coverage

| FR / SR | How proven |
|---|---|
| FR-018 Own paginated history | `listOrderHistory` is hard-scoped by `customer_id`; keyset cursor on `(created_at desc, id desc)` — no overlap, no gap across pages |
| FR-018 Status projection | History items carry the order status; `presentOrderHistory` maps each to a stable Vietnamese label |
| FR-019 Structured ticket linked to Order | `openTicket` validates reason code, sets SLA `due_at`, links the customer's own Order; general (order-less) tickets allowed |
| FR-019 No secret resubmission | `toSafeSummary` redacts credential-shaped tokens; the safe-summary test asserts the pasted secret never lands in storage or the confirmation message |
| SR-003 Ownership / BOLA | `getOrderDetailForCustomer` returns null for a foreign order id (no existence oracle); ticket open refuses a foreign Order with `ORDER_NOT_OWNED`; history detail callback re-checks ownership |
| Scenario 4: support has no privilege | `support-boundary` asserts the service exposes only `openTicket`/`listTickets`/`getTicket`/`closeTicket`; the module imports nothing from payments/delivery/vault and exports no pay/settle/refund/reveal symbol |
| Reopen without duplicate Order | History detail renders a `pay:reopen:<order>` affordance for PENDING_PAYMENT that delegates to the existing checkout reopen (no new Order) |

## Boundary design notes

- **BOLA everywhere**: history list/detail and ticket link/list are all `customer_id`-scoped; a forged callback surfaces nothing.
- **No cross-domain mutation**: `createSupportService` returns only ticket verbs; a structural test guards against a future pay/refund/reveal method or export.
- **Secret hygiene**: `toSafeSummary` strips `user:pass` pairs and long high-entropy runs before persistence (SR-001 defense-in-depth on the support path).
- **Outbox**: ticket open emits `TicketOpened` (references only) for downstream operator notification.

## Independence

US4 reads the commerce/order projection and writes only `support_ticket`. It grants no payment, supplier, or secret privilege; reopen reuses the US2 checkout path rather than minting a new Order.
