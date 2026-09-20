> **MINI APP: NOT IN PRODUCT SCOPE — OWNER DECISION.** Do not implement Mini App validation, WebApp, or `shop.tier20.click`. Canonical UX is Telegram-bot-only: `docs/architecture/telegram-only-commerce.md`.

This is a deployment/compliance warning, not the payment implementation. The owner-selected payment architecture is **VietQR + SePay only**. The owner explicitly accepts the external Telegram/upstream policy risk of that architecture. This acceptance does not claim Telegram approval, platform compliance, or upstream account-transfer authorization.

Technical readiness is evaluated by the code, data, operational, and closed-state gates in this repository. The accepted external-policy risk is **not an internal technical deployment gate** and must not be used to block technical completion.

Telegram's official documentation currently says digital goods/services sold inside a bot or Mini App use Telegram Stars. The design intentionally records that fact while implementing the owner-selected VietQR/SePay flow. Keep the risk visible and keep every product provenance, transferability, and support claim truthful.

Do not treat owner acceptance as permission to disguise a digital-goods sale, evade app-store rules, fabricate supplier authorization, or sell provider-prohibited shared accounts. `OWNER_ATTESTATION` records owner-held inventory provenance only; it does not mean that an upstream provider authorizes resale or transfer.

References:

- [Telegram Bot Features — Payments](https://core.telegram.org/bots/features#payments)
- [Telegram payments for digital goods](https://core.telegram.org/bots/payments-stars)
- [Telegram Mini App validation](https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app)
