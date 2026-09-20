# Contract: Telegram Customer and Owner UX

> **HISTORICAL CONTRACT.** Current customer copy is Telegram-only `TIER20 SHOP`; use `docs/03-architecture/architecture-contract.md` and current presenters as the source of truth.

## Ingress

- Accept updates only through the configured webhook path and verified Telegram secret token.
- Dedupe by Telegram `update_id`; callbacks have an opaque signed/expiring token and are answered promptly.
- Numeric Telegram `user_id` is the channel identity. Username is never authorization evidence.
- Normalize Unicode and bound message/callback/file length before search or persistence.
- The webhook secret gate precedes both durable inbox insertion and username observation. A rejected
  request writes neither path; only a verified request may create a bounded username observation.

## Retail main menu

```text
TIER20 SHOP

[ 🛍 Danh sách sản phẩm ]
[ 🔍 Tìm sản phẩm ] [ 📦 Đơn hàng ]
[ 💬 Hỗ trợ ]
```

Retail customers never receive wallet, top-up, reseller, API-key, supplier, ledger, or infrastructure controls.

## Presentation rules

- Prefer editing one owned bot message; send a new message only for durable receipts, delivery, or support events.
- Every non-terminal screen has `Quay lại` or `Menu chính`.
- Product detail shows authoritative price, duration, availability, delivery, expected time, warranty, and conditions before `Mua ngay`.
- Payment shows exact amount/content/expiry and explicitly says no receipt screenshot is required.
- Status refresh reads the internal projection and never polls SePay once per click or marks paid.
- User-facing errors are Vietnamese, stable, actionable, and include a safe correlation/reference when support is needed.

## Search parser

Allowed output fields: `query`, `categoryId`, `duration`, `minPriceVnd`, `maxPriceVnd`,
`stockStatus=AVAILABLE`, `deliveryType`, and `sort`. Unknown fields/enums, negative/out-of-range
prices, and oversized strings are rejected. The parser has no domain tools and its free text is never
rendered as product facts.

## Owner authorization

Root actions require configured numeric ID, private chat, allowed command, and action-specific rate
limit. High-risk actions additionally require an expiring confirmation bound to the action fingerprint.
There is no add-admin command and no username fallback.
