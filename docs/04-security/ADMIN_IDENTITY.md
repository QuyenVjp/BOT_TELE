# Root Admin Identity

## Authority

The only root admin is the Telegram account currently represented by `@Quyenvjp`. The username is a display/alert label; the actual authority is an immutable Telegram numeric `user_id` captured from a verified Telegram update and stored in secret configuration.

Required configuration:

```text
ADMIN_TELEGRAM_USER_ID=<numeric id of @Quyenvjp>
ADMIN_EXPECTED_USERNAME=Quyenvjp
```

`ADMIN_TELEGRAM_USER_ID` is mandatory before any admin command is enabled. If the username changes, the system must fail closed for admin actions and alert the owner rather than silently trusting a new username.

## Rules

- There is exactly one root-admin identity; no `/add-admin`, admin invitation or username-only fallback.
- Every admin command checks Telegram `from.id`, private-chat context, bot update authenticity, command scope and audit correlation.
- `@Quyenvjp` in a group is not enough; high-risk actions require the private admin chat or hardened web admin with step-up authentication.
- Admin may manage products, suppliers, credentials, inventory, orders, payment review, refunds and support, but still cannot bypass domain invariants through a direct DB edit.
- Supplier API secrets are write-only/configure-through-vault; the bot never echoes them.
- High-risk actions (`credit wallet`, `refund`, `deliver credential`, `change supplier`, `change price`) require explicit confirmation, idempotency and audit.
- Telegram account 2FA is outside the bot; use server-side step-up authentication for actions whose compromise would cause financial/credential damage.

## Bootstrap

1. Capture the numeric `from.id` from a verified private update initiated by `@Quyenvjp`.
2. Store it in secret configuration outside the database and deployment logs.
3. Verify username as a consistency check, not as the access key.
4. Run an admin self-test: identity, audit write, vault access, provider health and notification channel.
5. Keep a break-glass recovery procedure that does not create a second root admin.

