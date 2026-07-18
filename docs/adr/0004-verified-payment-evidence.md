---
status: proposed
---

# Verified provider evidence is the only payment truth

QR images, return URLs, chat messages and receipt screenshots never mark an order paid or credit a wallet. Only SePay data with verified raw-body HMAC/timestamp, inbound merchant account, amount, direction, content/reference, currency and unique transaction ID may create Payment Evidence. Reconciliation handles missing or late events.
