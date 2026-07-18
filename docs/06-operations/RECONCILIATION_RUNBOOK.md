# SePay Reconciliation and Discrepancy Runbook

## Trigger

- Scheduled reconciliation lag alert (`payments/telemetry`: reconciliation lag).
- Missing-webhook recovery (customer paid, Order still `PENDING_PAYMENT` past TTL window).
- Signature-failure, reference-collision, or unmatched-transfer alert.
- Manual owner request with a correlation ID.

## Procedure

1. **Scope the window.** Identify the affected Order / Payment Intent / bank transaction by
   order number, transfer content, or provider transaction id. Never use a customer screenshot as
   settlement evidence.
2. **Confirm transport integrity.** Verify the SePay HMAC signature and timestamp window for any
   inbound event under review. Invalid signatures are rejected and audited; they never settle.
3. **Load internal state.** Read Payment Intent, Bank Transaction, Payment Allocation, Order,
   Discrepancy, and audit_event rows for the correlation.
4. **Pull provider evidence.** Call the SePay list API with a bounded time/account cursor and the
   configured backoff. Never scrape; never invent a transfer.
5. **Classify** using the domain decision (`decideMatch`):
   - `SETTLED` — exact amount + inbound + matching account + unique live content.
   - `UNDERPAYMENT` / `OVERPAYMENT` / `LATE_PAYMENT` / `WRONG_CONTENT` / `WRONG_ACCOUNT` /
     `UNMATCHED` / `REFERENCE_COLLISION` / `REFUND_MISMATCH` — open a Discrepancy.
6. **Apply via domain commands only.** Re-run reconciliation (idempotent) or, for high-risk manual
   resolution, use the owner `discrepancy.resolve` path (private context + confirmation + reason +
   append-only audit). Do not edit rows by hand.
7. **Verify side effects.** Confirm the Order status, any Delivery Bundle issuance (via outbox),
   and the audit trail. A re-run of the same evidence must produce no new financial effect.
8. **Customer communication.** Tell the customer a safe status (`Đang xác minh`, `Đã nhận`,
   `Cần bổ sung`) — never the raw SePay payload, never a credential.

## Safety rules

- Settlement is fail-closed: only exact match settles; every deviation is a typed Discrepancy.
- Replaying the same provider transaction id is a no-op (inbox + bank_transaction unique key).
- Under/overpayment never silently rewrites the Order price.
- Support can open a ticket but cannot mark paid, mutate evidence, refund, or reveal a secret.
- High-risk discrepancy resolution requires the sole numeric owner in private chat with confirmation.

## Provider outage

- Open the reconciliation circuit (bounded backoff already in the adapter).
- Keep accepting safe local reads; do not mark Orders failed solely because SePay is down.
- After recovery, drain the reconciliation cursor before resuming full-rate fulfillment.
- Surface `Đang xác minh` rather than `Thất bại` unless evidence is terminal.
