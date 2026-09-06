# VietQR Sales Bot

Telegram digital-goods shop implemented as a TypeScript modular monolith. The HTTP process durably accepts Telegram and SePay webhooks into PostgreSQL; the worker processes independent Telegram, payment, delivery/outbox, and recovery lanes.

## Runtime status

- Source code and tests are present under `src/` and `tests/`.
- PostgreSQL is the authoritative store for orders, payments, inventory, inboxes, outbox, and audit records.
- Telegram callback updates return `answerCallbackQuery` in the webhook response after durable enqueue; business dispatch remains asynchronous.
- Payment screens render the canonical VietQR payload locally to PNG and deliver it as Telegram photo media.
- Navigation edits the bot-owned message when Telegram permits; only expected edit failures fall back to a new message.
- Worker lanes retain bounded polling fallback and durable lease/generation fencing. LISTEN/NOTIFY is not required by the current implementation.

## Local setup

```sh
npm ci
cp .env.example .env
docker compose up -d postgres
# compose maps PostgreSQL to localhost:5433; set DATABASE_URL accordingly.
npm run migrate
npm run dev                 # terminal 1
npm run dev:worker          # terminal 2
```

Use a valid-format Telegram bot token for worker startup. Local defaults use the memory vault, fixture supplier, deterministic search, and disabled AI. Redis is optional.

Production requires HTTPS, real Telegram/SePay credentials and webhook configuration, an approved external vault and supplier, allowlists, backups/restore drills, and completion of `docs/06-operations/DEPLOYMENT_RUNBOOK.md` launch gates.

## Checks

```sh
npm run lint
npm run typecheck
npm test
npm run build
```

Database-backed tests require a working Docker/Testcontainers runtime.

## Design documents

The canonical product and security documents remain in `docs/` and `specs/001-telegram-shop-mvp/`.

## Spec-driven workflow

```text
$speckit-constitution
→ $speckit-specify
→ $speckit-plan
→ $speckit-checklist
→ $speckit-tasks
→ $speckit-analyze
→ $speckit-implement (chỉ khi owner yêu cầu bắt đầu code)
```

- Project constitution: `.specify/memory/constitution.md`.
- Feature spec/plan/contracts/tasks/analysis: `specs/001-telegram-shop-mvp/`.
- Không code khi còn Critical/High gate hoặc requirement chưa map sang task + test.

## Đọc theo thứ tự

1. [Product overview](./docs/00-overview/README.md)
2. [MVP customer flow](./docs/00-overview/MVP_CUSTOMER_FLOW.md)
3. [Spec Kit feature specification](./specs/001-telegram-shop-mvp/spec.md)
4. [Spec Kit implementation plan](./specs/001-telegram-shop-mvp/plan.md)
5. [Spec Kit tasks and analysis](./specs/001-telegram-shop-mvp/tasks.md)
6. [Functional specification](./docs/02-domain/FUNCTIONAL_SPEC.md)
7. [Payment policy by product](./docs/00-overview/PAYMENT_POLICY_BY_PRODUCT.md)
8. [VietQR + SePay check flow](./docs/01-research/VIETQR_SEPAY_CHECK_FLOW.md)
9. [Repository research](./docs/01-research/RESEARCH_REPOSITORIES.md)
10. [Context map](./CONTEXT-MAP.md)
11. [Architecture blueprint](./docs/03-architecture/BLUEPRINT.md)
12. [Module contracts](./docs/03-architecture/MODULE_CONTRACTS.md)
13. [Threat model](./docs/04-security/THREAT_MODEL.md)
14. [Telegram policy risk gate](./docs/04-security/TELEGRAM_POLICY_RISK.md)
15. [Supplier API contract](./docs/05-api/SUPPLIER_API.md)
16. [Reseller API contract — post-MVP lane](./docs/05-api/RESELLER_API.md)
17. [Growth features — post-MVP](./docs/00-overview/GROWTH_FEATURES.md)
18. [Reconciliation runbook](./docs/06-operations/RECONCILIATION_RUNBOOK.md)
19. [Architecture decisions](./docs/adr/)

## Cấu trúc

```text
.
├── README.md
├── CONTEXT-MAP.md
├── docs/
│   ├── 00-overview/
│   ├── 01-research/
│   ├── 02-domain/
│   │   └── contexts/
│   ├── 03-architecture/
│   ├── 04-security/
│   ├── 05-api/
│   ├── 06-operations/
│   └── adr/
├── outputs/                 # Published snapshots/index
└── work/                    # Scratch/research inputs, not canonical
```

## Quy tắc không thương lượng

- Payment core theo owner request: VietQR dynamic QR + SePay check/reconciliation; ảnh biên lai/redirect không phải bằng chứng đã thanh toán.
- Retail MVP là `catalog → buy now → VietQR → SePay → secure delivery`; không có customer wallet, top-up, cart nhiều món hoặc reseller controls trên menu khách.
- Chỉ bán digital account/access khi supplier/platform cho phép resale/transfer.
- Root admin duy nhất là numeric Telegram ID mapped to `@Quyenvjp`; username không phải credential.
- Chỉ SePay evidence đã verify và match mới được confirm payment/order.
- SePay transaction evidence với HMAC/timestamp/account/amount/content/reference/unique transaction ID là payment evidence.
- AI chỉ parse câu tìm kiếm thành bộ lọc allowlist; product facts luôn lấy từ database.
- Supplier API là backend-only; Reseller API và wallet là lane sau MVP.
- Bot/LLM/channel handler không được bypass commerce/payment/digital-delivery domain rules.
