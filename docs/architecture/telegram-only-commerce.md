# TIER20 SHOP is Telegram-bot-only

**Status:** Accepted (owner architectural decision, 2026-09-10)
**Product:** TIER20 SHOP (`@tier20ai_bot`)
**Payment rail:** VietQR + SePay
**Store:** remains CLOSED/TEST until the owner names OPEN

## Decision

TIER20 SHOP intentionally does **not** use Telegram Mini Apps.

The canonical customer interface is the Telegram Bot API:

- Telegram chat
- persistent Reply Keyboard
- Inline Keyboard
- commands
- bot deep links (`https://t.me/tier20ai_bot?start=<safe-token>`)

There is no Mini App, no WebApp, no `initData` auth, no `startapp`, no Main Mini App, and no `shop.tier20.click`.

Mini App may return **only** if the owner explicitly requests it in a future task. Agents must not propose, implement, deploy, or test Mini App work in the meantime.

## Why

- Owner prefers Telegram-native interaction.
- Customers are expected to use the bot chat.
- Avoid maintaining a second frontend.
- Avoid duplicated catalog / checkout / admin UX.
- Reduce infrastructure and security surface (no WebApp origin, no initData verifier, no Mini App HTTP routes).
- Prioritize one excellent Telegram experience.

## Canonical interface

| Surface                    | Role                                                                                                    |
| -------------------------- | ------------------------------------------------------------------------------------------------------- |
| `@tier20ai_bot`            | Only customer and admin UX                                                                              |
| `https://api.tier20.click` | HTTP API: `/health`, `/ready`, Telegram webhook, SePay webhook, operational delivery reveal if required |
| VietQR + SePay             | Payment                                                                                                 |
| `https://t.me/aicodexvn`   | Community                                                                                               |
| `https://t.me/Quyenvjp`    | Admin contact                                                                                           |

Not in product scope:

- Telegram Mini Apps / Web Apps
- `Telegram.WebApp`
- `initData` / `X-Telegram-Init-Data`
- `?startapp=`
- MenuButtonWebApp
- HTTP `/shop` storefront
- `shop.tier20.click`
- Mini App admin / checkout / inventory pages

## Public commands

- `/start` — Mở TIER20 SHOP
- `/shop` — Xem sản phẩm
- `/orders` — Đơn hàng của tôi
- `/wallet` — Ví của tôi
- `/warranty` — Bảo hành
- `/support` — Hỗ trợ
- `/settings` — Cài đặt
- `/help` — Hướng dẫn

Owner private (backend authorization still required):

- `/admin` `/products` `/inventory` `/customers` `/broadcast` `/health`

No `/miniapp`, `/app`, or `/webapp`.

## BotFather

- Mini App: DISABLED
- Main Mini App: DISABLED
- Menu button: COMMANDS / default (`MenuButtonCommands`), never `MenuButtonWebApp`
- Do not configure a Mini App URL

## READY_TO_OPEN

Must **not** require Mini App, WebApp, `shop.tier20.click`, `initData`, Main Mini App, or Mini App Playwright.

Cancelled Mini App work is **not** a release blocker.

`MINI APP: NOT IN PRODUCT SCOPE — OWNER DECISION`
