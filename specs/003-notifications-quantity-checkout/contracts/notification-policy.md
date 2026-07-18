# Contract: Notification Policy and Preferences

| Class | Recipient | Can disable? | Quiet hours/digest | Allowed content |
|---|---|---|---|---|
| `TRANSACTIONAL` | Owning Customer | No | Immediate | Own Order/payment/fulfillment/support only |
| `CRITICAL_SERVICE` | Affected/all eligible | No | Immediate | Rare security/outage/service action; no marketing |
| `SHOP_UPDATE` | Opted-in Customers | Yes | Delay/digest | New product/restock/public price/stock |
| `PURCHASE_ACTIVITY` | Opted-in Customers | Yes | Aggregate/frequency cap | Privacy-safe product/quantity activity only |

Preference evaluation occurs immediately before send, not only at campaign creation, so an opt-out
suppresses queued unsent deliveries. Preference callbacks are authenticated, opaque, versioned, and idempotent.

Purchase activity must aggregate bursts. The event may represent every completed purchase internally,
but recipients receive no more than the configured cap and get a digest summarizing the window.

