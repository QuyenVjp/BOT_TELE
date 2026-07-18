---
status: proposed
---

# One payment tender per order in V1

An order is paid with one VietQR payment intent in V1; SePay checks/reconciles the bank transaction before supplier fulfillment. Split tender is deferred because it introduces partial allocation, capture, late-payment and refund states unrelated to proving the simple customer flow.
