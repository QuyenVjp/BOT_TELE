# Feature 003 — Notifications, Quantity Checkout, and Payment UX

This Spec Kit feature extends the active retail MVP without adding a multi-item cart. One Order
still contains one Product Variant, but may request multiple units of that Variant.

Implementation priority:

1. Quantity and payment-session rules must be folded into the current Feature 001 payment phase.
2. Transactional customer notifications follow payment/fulfillment events.
3. Admin broadcasts, product/restock announcements, purchase-activity social proof, preferences,
   fanout, and anti-spam follow after authoritative events exist.

