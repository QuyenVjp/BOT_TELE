# Refund / Replacement / Manual-Review Runbook

## Trigger

- Customer opens a structured support ticket with reason `REFUND_REQUEST` or `ASSET_NOT_WORKING`.
- Fulfillment path returns `OUT_OF_STOCK` / `NEEDS_REVIEW` after payment settled.
- Owner marks a Discrepancy for refund after an unmatched or overpayment case.
- Warranty window still open on a completed Order.

## Evidence required before action

| Case | Minimum evidence |
|---|---|
| Replacement (asset not working) | Order id + customer id match; warranty not expired; original asset preserved |
| Refund (payment issue) | Bank transaction + Payment Intent + Order; provider evidence of transfer |
| Manual review | Correlation id; reason code; owner confirmation for high-risk resolution |

Screenshots alone are never settlement evidence. Provider evidence is authoritative for money;
domain state is authoritative for delivery.

## Procedure — replacement

1. Confirm ownership: the requesting customer owns the Order (BOLA).
2. Confirm warranty window (`warranty_days` from the Order snapshot).
3. Call `openReplacementCase` — this preserves the original asset and Order history and transitions
   the Order toward `REFUND_PENDING` only when a refund is also required.
4. Provision a new asset (local claim or supplier) and issue a new Delivery Bundle to the same
   customer. The original bundle remains revoked / consumed.
5. Append audit with reason and correlation id.

## Procedure — refund

1. Confirm the payment was actually settled (Bank Transaction + Allocation). A never-paid Order is
   cancelled, not refunded.
2. Transition the Order to `REFUND_PENDING` via the domain command; do not edit the status by hand.
3. Execute the bank refund as a controlled manual operation in the pilot (out-of-band). Record the
   provider refund reference in the Discrepancy / audit metadata (redacted).
4. On provider confirmation, mark the refund settled; never claim "refunded" without provider
   evidence.
5. Communicate a safe status to the customer; never the bank payload.

## Procedure — manual review

1. Owner opens the discrepancy or review case in private chat.
2. High-risk resolution (`discrepancy.resolve`) requires an expiring AdminConfirmation bound to the
   action fingerprint, a non-empty reason, and produces an append-only audit event.
3. Low-risk catalog kill-switch (activate/deactivate) is audited but does not require step-up.
4. Support staff (if any) never become root admins and never gain pay/settle/refund/reveal verbs
   (structural boundary on the support service).

## Safety rules

- FR-020: replacement preserves original asset + Order history.
- FR-013: fulfillment never runs without verified payment.
- FR-022 / FR-023: no second root admin; high-risk owner actions need confirmation + reason + audit.
- Support surface cannot mark paid, mutate evidence, refund, or reveal a secret.
