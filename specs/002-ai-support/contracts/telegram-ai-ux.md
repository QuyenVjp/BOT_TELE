# Contract: Telegram AI Support UX

## Entry points

- Main menu `🔍 Tìm sản phẩm` opens deterministic search first and accepts natural language.
- `💬 Hỗ trợ` opens FAQ shortcuts and a free-text support question.
- Product/Order detail may offer `Hỏi về sản phẩm` or `Hỏi hỗ trợ` deep links.

## Response rules

- Vietnamese, concise, source-grounded, and no hidden provider terminology.
- Product facts appear as existing catalog cards with existing `Mua ngay` buttons.
- Payment answers link to existing VietQR/payment status screens and state that SePay verification is authoritative.
- Unknown/conflicting/sensitive questions show a safe explanation and `Mở ticket`/human handoff.
- AI never replaces `Kiểm tra trạng thái`, `Mua ngay`, `Nhận sản phẩm`, or support authorization flows.
- Use edit-in-place where practical; show loading/fallback state when provider exceeds one second.

## Rate and abuse UX

On limit or provider failure, show a short deterministic fallback/cooldown and preserve access to
Order history and support recovery. Do not reveal whether another customer's query/order exists.
