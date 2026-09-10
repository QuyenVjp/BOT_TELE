# Agent instructions — TIER20 SHOP / BOT_TELE

## Permanent architecture

TIER20 SHOP is a **Telegram-bot-only** commerce system. Mini App is **cancelled permanently** by owner decision.

Do **not**:

- build, deploy, configure, test, or suggest a Mini App / WebApp
- add `shop.tier20.click`, Cloudflare Mini App routes, `startapp`, `initData`, WebApp buttons, or Main Mini App
- leave Mini App TODOs
- keep the product "not ready" because Mini App was never deployed

Canonical UX: Telegram chat + Reply Keyboard + Inline Keyboard + commands + `https://t.me/tier20ai_bot?start=<safe-token>`.

Payment: VietQR + SePay. Store stays CLOSED/TEST unless the owner names OPEN.

See `docs/architecture/telegram-only-commerce.md`.

## HTTP that may exist

Keep: `/health`, `/ready`, Telegram webhook, SePay webhook, operational `/d/:token` delivery reveal if Telegram-native fulfillment still uses it.

Do not add Mini-App-only `/shop` HTML/API routes.
