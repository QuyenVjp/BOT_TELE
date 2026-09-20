---
status: accepted
---

# One selected payment tender per order in V1

An order in the retail MVP uses exactly one selected tender: the existing VietQR payment intent settled by SePay. The closed-loop TIER20 wallet ledger remains an isolated backend/post-MVP lane and is not exposed by the retail keyboard or checkout. Split tender is deferred because partial allocation, capture, late-payment, and refund states are unrelated to proving the simple customer flow. Wallet credit remains integer VND ledger state; it never bypasses stock, authorization, or fulfillment gates.
