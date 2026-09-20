# Payment Policy by Product Type

Payment is a product/channel policy, not one global provider switch.
Current retail MVP implementation uses one VND tender per order: VietQR + SePay. The closed-loop wallet remains a separate backend/post-MVP lane and is not exposed by the retail keyboard or checkout. Telegram Stars is intentionally not implemented. This is the owner-selected payment architecture, not a claim of Telegram/provider approval; the external platform-policy risk is documented and explicitly accepted by the owner, so it is not an internal technical deployment gate.

| Product/channel                           | Default policy                          | Notes                                                                                                                                                                                     |
| ----------------------------------------- | --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Digital account/access                    | VietQR dynamic QR + SePay webhook/check | Owner-selected implementation: SePay verifies/reconciles the bank transaction before delivery. The Telegram/upstream policy risk remains documented and does not claim platform approval. |
| Retail wallet/top-up                      | Out of MVP                              | Chỉ thiết kế sau khi retail Order flow ổn định và accounting/compliance được chốt.                                                                                                        |
| Reseller B2B prepaid credit               | Post-MVP lane                           | Keep B2B funding separate from retail order payment.                                                                                                                                      |
| Unknown/unauthorized/terms-prohibited SKU | Blocked                                 | Never route around platform/provider restrictions.                                                                                                                                        |

## Account-sales consequence

Selling ChatGPT Plus, Super Grok or similar account access is a digital-service/credential use case. Before listing a SKU, record `supplier_authorized`, `transferability`, `region`, `expiry`, `support_policy` and `payment_policy`. `OWNER_ATTESTATION` records owner-held provenance only; it does not prove upstream authorization or official reseller status. Keep the product-policy decision and external risk explicit.
For an owner-held account SKU, the selected business model may be a one-time handoff of a personally acquired account that is no longer needed. Customer copy must not call it shared, multi-user, or rental unless the inventory facts support that description.

## Official implementation references

- [VietQR Quick Link](https://www.vietqr.io/danh-sach-api/link-tao-ma-nhanh/)
- [VietQR Generate API](https://www.vietqr.io/danh-sach-api/link-tao-ma-nhanh/api-tao-ma-qr)
- [SePay webhook authentication](https://developer.sepay.vn/vi/sepay-webhooks/xac-thuc)
- [SePay webhook security](https://developer.sepay.vn/vi/sepay-webhooks/bao-mat)
- [SePay retry/error handling](https://developer.sepay.vn/vi/sepay-webhooks/xu-ly-loi)
- [SePay reconciliation](https://developer.sepay.vn/vi/sepay-webhooks/doi-soat-giao-dich)
