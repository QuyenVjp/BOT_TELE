# Payment Policy by Product Type

Payment is a product/channel policy, not one global provider switch.

| Product/channel | Default policy | Notes |
|---|---|---|
| Digital account/access | VietQR dynamic QR + SePay webhook/check | Owner-requested implementation: SePay verifies/reconciles the bank transaction before delivery. Telegram deployment remains a policy gate; see [risk note](../04-security/TELEGRAM_POLICY_RISK.md). |
| Retail wallet/top-up | Out of MVP | Chỉ thiết kế sau khi retail Order flow ổn định và accounting/compliance được chốt. |
| Reseller B2B prepaid credit | Post-MVP lane | Keep B2B funding separate from retail order payment. |
| Unknown/unauthorized/terms-prohibited SKU | Blocked | Never route around platform/provider restrictions. |

## Account-sales consequence

Selling ChatGPT Plus, Super Grok or similar account access is a digital-service/credential use case. Before listing a SKU, record `supplier_authorized`, `transferability`, `region`, `expiry`, `support_policy` and `payment_policy`. If the upstream provider does not authorize resale or account transfer, do not sell that SKU.

## Official implementation references

- [VietQR Quick Link](https://www.vietqr.io/danh-sach-api/link-tao-ma-nhanh/)
- [VietQR Generate API](https://www.vietqr.io/danh-sach-api/link-tao-ma-nhanh/api-tao-ma-qr)
- [SePay webhook authentication](https://developer.sepay.vn/vi/sepay-webhooks/xac-thuc)
- [SePay webhook security](https://developer.sepay.vn/vi/sepay-webhooks/bao-mat)
- [SePay retry/error handling](https://developer.sepay.vn/vi/sepay-webhooks/xu-ly-loi)
- [SePay reconciliation](https://developer.sepay.vn/vi/sepay-webhooks/doi-soat-giao-dich)
