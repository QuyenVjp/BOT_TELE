# AI Support — Spec Kit Feature 002

AI support đã được chốt thành một feature riêng, không làm thay đổi payment/order truth của
`001-telegram-shop-mvp` và chưa triển khai source code.

## Canonical artifacts

- [Feature specification](../specs/002-ai-support/spec.md)
- [Implementation plan](../specs/002-ai-support/plan.md)
- [Research decisions](../specs/002-ai-support/research.md)
- [Data model](../specs/002-ai-support/data-model.md)
- [AI/provider/safety/Telegram contracts](../specs/002-ai-support/contracts/)
- [Tasks T201–T244](../specs/002-ai-support/tasks.md)
- [Traceability](../specs/002-ai-support/traceability.md)
- [Cross-artifact analysis](../specs/002-ai-support/analysis.md)
- [Quickstart and test matrix](../specs/002-ai-support/quickstart.md)

## Provider verification

- Provider: `9router`
- Base URL: `https://qrouter.online/v1`
- Wire API: `responses`
- Primary model: `cx/gpt-5.6-terra`
- Approved lower-cost alternative: `cx/gpt-5.6-luna`
- Reasoning/verbosity: `low` / `low`
- Output cap: 600 tokens
- `/v1/models`: HTTP 200
- Selected model: available
- Key: loaded only from local ignored `.env`; never copied into this document or source control.

## Authority boundary

Deterministic filter/search chạy trước; model chỉ xử lý câu tự nhiên hoặc support chưa đủ rõ. AI chỉ được hỗ trợ tìm sản phẩm, giải thích giá/FAQ/usage/payment/order status và phân loại support.
AI không được mark paid, bypass SePay, đổi giá/stock, gọi supplier, giao/reveal credential, refund,
sửa ledger hoặc thao tác admin. CI dùng fake provider; qrouter live smoke chỉ opt-in staging.
