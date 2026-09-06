-- T163/T164: persist the allowlisted high-risk command and its redacted payload.
-- The callback can therefore reconstruct a pending action after restart, while
-- confirmation consume + domain mutation + audit execute in one transaction.

alter table admin_confirmation
  add column if not exists allowlisted_command_ref text,
  add column if not exists payload_redacted jsonb not null default '{}'::jsonb;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'admin_confirmation_command_ref_ck'
      and conrelid = 'admin_confirmation'::regclass
  ) then
    alter table admin_confirmation
      add constraint admin_confirmation_command_ref_ck
      check (
        allowlisted_command_ref is null
        or allowlisted_command_ref in ('discrepancy.resolve', 'wallet.refund')
      );
  end if;
end
$$;
