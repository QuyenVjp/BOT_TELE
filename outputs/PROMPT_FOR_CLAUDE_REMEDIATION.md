# Prompt cho Claude — tiếp tục Feature 001 theo Spec Kit và sửa toàn bộ REQUEST_CHANGES

Làm việc trong:

`C:\Users\ADMIN\Documents\Codex\2026-07-16\nghi`

Đây là handoff sau follow-up multi-agent review ngày 2026-07-16. Verdict hiện tại là `REQUEST_CHANGES`. Không được dùng lại tuyên bố “114/114”, “253 passed”, “pilot-ready”, hoặc “container suites skip cleanly” nếu chưa có evidence mới gắn với commit SHA và CI run.

## Đọc bắt buộc trước khi chạm code

1. `C:\Users\ADMIN\.codex\AGENTS.md`
2. `.specify/memory/constitution.md`
3. Toàn bộ `specs/001-telegram-shop-mvp/`
4. `specs/001-telegram-shop-mvp/remediation-review.md`
5. Phase 9 `T115–T153` trong `specs/001-telegram-shop-mvp/tasks.md`
6. `specs/003-notifications-quantity-checkout/`
7. `specs/002-ai-support/`
8. Các file nguồn/test được nêu trong review, đặc biệt `src/main.ts`, `src/worker.ts`, `buy-now.ts`, `fulfillment.ts`, `outbox/repository.ts`, `outbox/worker.ts`, `payments/service.ts`, `payments/domain.ts`, `payments/sepay-webhook.ts`, `delivery.ts`, `delivery-route.ts`, `callbacks/checkout.ts`, `callbacks/admin.ts`, và `tests/helpers/pg-container.ts`.

## Gate 0 — cập nhật Spec Kit trước implementation

Không sửa code để hợp thức hóa task cũ. Trước tiên cập nhật source of truth bằng chuỗi Spec Kit:

`constitution → specify → clarify (nếu còn mơ hồ) → plan → checklist → tasks → analyze`

- Không hạ thấp constitution và không xóa requirement chỉ vì skeleton hiện tại chưa làm được.
- Giữ `spec.md` ở mức what/why; giữ `plan.md` ở mức how; `tasks.md` phải có dependency, file path, test trước implementation và acceptance evidence.
- Thêm một Phase 10 review-remediation group (đánh số tiếp sau task hiện có, không tự ý đánh dấu task xanh) cho tối thiểu:
  1. atomic pre-payment inventory reservation + last-stock loser UX;
  2. same-order/unit concurrent idempotency và stable signed Buy Now nonce;
  3. outbox fencing token + lease renewal/stale-owner tests;
  4. durable high-risk admin command execution across restart/crash;
  5. fulfillment claim/state/outbox atomicity;
  6. bounded recovery jobs/index/query-plan evidence;
  7. runtime migration path và honest Docker skip/CI behavior;
  8. payment beneficiary config split, strict SePay evidence, delivery auth, QR image/Telegram media;
  9. presenter/callback deduplication và emoji budget.
- Reopen hoặc tách các task đang checked nhưng evidence không đúng nghĩa: T115 (chỉ load module với config invalid), T118 (Telegram no-op/SePay 503), T124 (thiếu file mutation test), T130/T133/T134 nếu chưa có stale-owner fencing/renewal. Không đánh dấu lại cho tới khi test thực sự chứng minh.
- Chạy Spec Kit cross-artifact analysis. Nếu còn Critical/High hoặc coverage gap thì dừng implementation và sửa artifacts trước.

## Business invariant không được thương lượng — tồn kho cuối

Đây là quy tắc chính thức:

> Người thắng là transaction đầu tiên commit thành công một reservation nguyên tử trong PostgreSQL. Không dùng thời điểm người dùng click để quyết định vì Telegram/network latency không đo được công bằng.

Flow bắt buộc:

```text
Hai khách cùng bấm Mua ngay
  → server nhận request
  → một transaction lock/re-read variant và reserve một asset AVAILABLE
     ├─ transaction commit trước: tạo Order + reservation + Payment Intent/VietQR
     └─ transaction không reserve được: OUT_OF_STOCK, không Order thanh toán,
        không Payment Intent, không QR, không bị trừ tiền
```

Điều kiện:

- Reservation phải xảy ra trước khi cho phép tạo Payment Intent/QR, và phải giữ đúng TTL.
- Winner có đúng một active reservation và một active Payment Intent.
- Loser nhận copy rõ ràng: sản phẩm cuối vừa được khách khác đặt trước; chưa bị trừ tiền và chưa có phiên thanh toán; có nút nhận thông báo khi có hàng/xem sản phẩm khác/quay lại danh mục. Không báo “thanh toán thành công”.
- Cancel/expiry phải release reservation và void intent trong cùng state protocol; payment đến trong race phải đi qua policy `transactedAt` và discrepancy/review có chủ sở hữu, không generic silent mismatch.
- Double-click cùng khách/order/unit chỉ tạo một reservation/effect. Không bắt unique violation rồi query trên transaction PostgreSQL đã aborted: dùng `INSERT ... ON CONFLICT DO NOTHING RETURNING` hoặc savepoint.
- Asset claim deterministic (`created_at, id`), có retry/recheck nếu `SKIP LOCKED` nhìn thấy tạm thời zero do transaction winner rollback.

Test bắt buộc: 20 concurrent buyers với một asset; concurrent same-order claims; cancel/expiry release race; price change trước reservation; payment/cancel two-connection race; losers không có Payment Intent/QR.

## Thứ tự implementation bắt buộc (TDD đỏ → xanh → refactor nhỏ)

1. **Inventory + idempotency trước payment:** pre-payment reservation, stable callback nonce, `ON CONFLICT` paths, no-QR loser behavior, release/recovery.
2. **T121/T126 — Telegram ingress production:** async durable PostgreSQL inbox với `processing/processed/retry`; handler failure/429 không làm mất update; Redis hoặc PostgreSQL atomic quota theo `user + action` cho Buy Now, refresh/check, cancel, support, admin. Không để `Map`/`Set` in-memory authoritative.
3. **T122/T127 — SePay runtime verifier:** raw bytes, body limit, TLS/edge assumptions, `sha256=` normalization, constant-time compare, timestamp replay window, strict transaction date/future skew, trusted proxy/IP allowlist, schema validation, durable dedupe, mapping sang opaque/branded `VerifiedSePayEvidence`. `applyPaymentEvidence` không được nhận evidence thô hoặc tự gán `VERIFIED`.
4. **T123/T124/T128 — money races:** lock/re-read Order + Payment Intent, typed `ALREADY_PAID`, verified `transactedAt` wins policy, invalid/future dates rejected, terminal-order money becomes discrepancy/review, append-only audit/outbox cho void/cancel/settlement. T124 phải có test duplicate provider ID với raw hash/amount/account/content mutation.
5. **T125/T129 — callback codec:** opaque, signed, expiring, customer/action-bound, replay/tamper rejection; typed action builders thay toàn bộ raw callback literals. Callback Buy Now phải mang nonce ổn định, không tự sinh idempotency key mới trong handler.
6. **T130/T131/T133/T134 — outbox/worker:** atomic claim; ack/fail `WHERE id + owner + fencing generation/lease token`; stale worker update ảnh hưởng 0 row; lease renewal hoặc bounded one-event claim; unknown event fail-visible; retry/terminal/dead-letter rõ; single-flight; bounded shutdown drain; telemetry. Thêm scheduler cho Order expiry, SePay reconciliation, supplier UNKNOWN, reservation release, bundle expiry/reissue và backlog age.
7. **T136/T142 — vault:** external adapter thật, startup health fail-closed, namespaced/provenance refs, timeout/retry semantics, secret redaction.
8. **T137/T143/T138/T144 — supplier:** authenticated HTTP SupplierPort availability/create/query/cancel/refund/reconcile; timeout = UNKNOWN; stable idempotency; schema validation; no duplicate supplier unit/asset; paid/no-local-stock gọi supplier hoặc durable retry/review, không ack bỏ đơn.
9. **T139/T145/T146/T147 — delivery:** notifier dùng `customerId/chatId` thật; retry-safe capability handoff không lưu raw credential; signed Telegram-bound delivery session (không tin `x-customer-id`); vault reveal two-phase; asset owner/status/version guard; nếu `markAssetDelivered` false thì rollback/không consume; first reveal atomically `COMPLETED`; expiry/reissue/replay/fingerprint guards.
10. **T149/T150 — VietQR/Telegram UX:** strict BIN/account/content bounds; merchant SePay identity tách khỏi VietQR beneficiary account number; validated bank display name truyền end-to-end; official external golden payload fixtures (không build rồi parse chính implementation); QR image thật; `sendPhoto`/edit-media/caption fallback; check/cancel buttons; giờ `Asia/Ho_Chi_Minh`; quantity/đơn giá/tổng tiền chính xác; pre-payment không dùng copy đã thanh toán.
11. **T151/T152/T153 + Phase 10:** CI type/lint/format/secret/audit/build/start/worker/migrate/unit/integration/acceptance/performance; production `migrate:prod` chạy artifact `dist`, không phụ thuộc `tsx` devDependency; Docker probe phải skip sạch khi daemon unavailable và CI phải chạy thật với Docker; evidence bound to valid commit SHA/CI artifact; independent multi-agent review zero Critical/High.

## Quy tắc tối ưu code và UX

- Không tạo một `constants.ts` khổng lồ và không dồn mọi `const` lên đầu file. Chỉ đưa immutable policy/copy/action map dùng lặp lại lên module scope; giữ request-specific value gần nơi dùng.
- Emoji chỉ ở Telegram presenter/copy. Giảm icon trang trí, không để emoji trong domain logic, repository, error code, audit, log, telemetry hay protocol. Centralize Vietnamese labels/templates theo presenter domain.
- Không lặp raw callback protocol; dùng typed signed codec/action builder. Không generic hóa abstraction chỉ dùng một lần. Extract shared navigation/error presenter/cursor helper khi có duplication thật.
- Không dùng in-memory Map cho payment, stock, inbox, admin confirmation hoặc notification delivery. Map/Set chỉ được dùng cho immutable lookup, test adapter hoặc cache không-authoritative.
- Không network call trong DB transaction nếu không có lease/two-phase protocol rõ ràng. Mọi retry phải idempotent, có timeout, correlation id, audit/telemetry.
- Tránh N+1/duplicate DB reads; thêm composite indexes đúng hot path và chứng minh bằng `EXPLAIN ANALYZE` trên pilot-sized dataset. Không gọi mock latency là runtime performance.
- Mọi handler phải fail closed: unknown/out-of-stock/review/invalid evidence không được ack success hoặc giao hàng.

## Quy tắc security/secret

- Không hardcode hoặc in bot token, SePay secret/token, supplier/vault credential, AI/QRouter key. `.env` local không được đưa vào diff/evidence.
- Bot token đã từng xuất hiện trong chat; trước production phải rotate/revoke token đó và nạp token mới qua secret manager. Không copy token cũ vào prompt, log, test hoặc file.
- Root admin chỉ numeric Telegram user ID. Username `@Quyenvjp` chỉ là nhãn hiển thị, không phải authorization key; không có `/add-admin`.

## Checkpoint/report contract cho mỗi slice

Báo đúng:

- task IDs thực sự hoàn thành và task nào mở lại;
- file/line đã sửa;
- test đỏ trước và xanh sau, exact command + result;
- migration/CI/evidence artifact;
- blocker môi trường (Docker/CI/provider) và không biến blocker thành pass;
- remaining Critical/High/Medium.

Không được báo “done” chỉ vì typecheck/build pass. Chỉ khi toàn bộ Phase 9 + Phase 10 pass, runtime flow thật hoạt động, Docker/CI evidence có SHA, và independent review zero Critical/High mới được gọi là pilot-ready.
