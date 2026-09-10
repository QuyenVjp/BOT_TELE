-- 062_inbox_last_error_detail.sql
-- Why an inbox message failed, not just that it did.
--
-- `last_error_code` carries a classification (HANDLER_FAILED, RATE_LIMITED, ...), which cannot tell
-- a bug from a missing row from a constraint violation. The one time this mattered, the answer was a
-- single log line ("column reference status is ambiguous", SQLSTATE 42702) while the queue row said
-- nothing, and the diagnosis had to be reconstructed from logs. The column stores one bounded,
-- redacted line; the retention and redaction rules live in src/infrastructure/inbox/error-detail.ts.

alter table webhook_inbox add column if not exists last_error_detail text;
