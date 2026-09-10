> **MINI APP: NOT IN PRODUCT SCOPE — OWNER DECISION.** Do not implement Mini App validation, WebApp, or `shop.tier20.click`. Canonical UX is Telegram-bot-only: `docs/architecture/telegram-only-commerce.md`.

# Telegram Platform Policy Risk

This is a deployment/compliance warning, not the payment implementation. The requested payment core is **VietQR + SePay**. Before production, the owner must confirm that the chosen Telegram flow and product are allowed by Telegram and by the upstream account provider.

Telegram's official documentation currently says digital goods/services sold inside a bot or Mini App use Telegram Stars. The design intentionally does not hide this fact, but it also does not implement Stars in the requested VietQR/SePay flow. That creates a launch gate:

- obtain platform/provider approval;
- move the payment interaction to a channel/flow where VietQR is allowed;
- or change the product/channel/payment policy before production.

Do not treat this document as permission to bypass Telegram policy. No code should be written that disguises a digital-goods sale, evades app-store rules, or sells provider-prohibited shared accounts.

References:

- [Telegram Bot Features — Payments](https://core.telegram.org/bots/features#payments)
- [Telegram payments for digital goods](https://core.telegram.org/bots/payments-stars)
- [Telegram Mini App validation](https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app)

