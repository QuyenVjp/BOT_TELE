-- Prevent one accepted RFC 6238 time-step from minting multiple grants.
-- The factor version keeps a rotated factor's counters independent from its predecessor.

alter table admin_step_up_attempt
  add column if not exists factor_version integer,
  add column if not exists totp_time_step bigint;

create unique index if not exists admin_step_up_attempt_totp_replay_idx
  on admin_step_up_attempt (admin_telegram_user_id, purpose, factor_version, totp_time_step)
  where succeeded = true
    and purpose = 'STEP_UP'
    and factor_version is not null
    and totp_time_step is not null;
