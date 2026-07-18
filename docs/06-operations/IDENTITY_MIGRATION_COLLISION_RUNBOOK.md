# Telegram identity migration collision runbook

Migration `009_identity_delivery_security.sql` fails closed with
`TELEGRAM_CHANNEL_COLLISION` when both `telegram` and `TELEGRAM` rows exist for the same numeric
Telegram user ID. Do not delete either row until ownership is verified.

## Diagnose

Run this read-only query against the affected database:

```sql
select channel_user_id,
       array_agg(id order by id) as identity_ids,
       array_agg(customer_id order by id) as customer_ids,
       array_agg(channel order by id) as channels
from channel_identity
where lower(channel) = 'telegram'
group by channel_user_id
having count(distinct channel) > 1;
```

For each result, compare the customers' Orders, Support Tickets, Delivery Bundles, audit records,
and verified Telegram webhook history. Username is display metadata and must not decide ownership.

## Resolve

1. Stop main and worker processes so no new identity is created during repair.
2. Take and verify a database backup.
3. Select the canonical customer using numeric Telegram ID plus authoritative business/audit rows.
4. Reassign dependent rows from the losing customer only through a reviewed, transaction-scoped
   repair script. Preserve an immutable audit entry with the operator, reason, and affected IDs.
5. Delete only the duplicate `channel_identity` and now-unreferenced losing customer after all
   foreign-key and business-history checks pass.
6. Rerun the diagnostic query; it must return zero rows.
7. Run compiled `migrate:prod`, then verify `009_identity_delivery_security.sql` appears once in
   `schema_migrations`, `channel_identity.channel = 'TELEGRAM'`, and the delivery tables exist.
8. Restart services and verify `/ready`, root-admin numeric-ID resolution, and a fresh `/start`.

Never merge identities by username, silently choose the newest row, disable the migration guard,
or mark migration 009 as applied manually.
