---
status: accepted
---

# VietQR + SePay is the owner-selected payment path

The owner-approved implementation uses VietQR dynamic QR for order payment and SePay for signed transaction checking/reconciliation before digital-account delivery. Telegram Stars is intentionally not implemented. This decision documents an accepted external platform/upstream policy risk; it does not claim Telegram approval or upstream account-transfer authorization, and that risk is not an internal technical deployment gate.

The architecture contract intentionally has **no Telegram Stars payment path**. Do not add `sendInvoice`, XTR, Stars callbacks, Stars refunds, or a second currency ledger to this VietQR/SePay product.

Inventory publication remains subject to the existing provenance and version-bound publication gates. `OWNER_ATTESTATION` records owner-held inventory provenance only; it must never be presented as upstream authorization, an official reseller agreement, or proof of platform compliance.
