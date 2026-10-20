-- Close only the untouched bootstrap row; preserve explicit owner state.
update store_control
set status = 'CLOSED',
    updated_at = now(),
    version = version + 1
where id = 'main'
  and status = 'OPEN'
  and updated_by = 'system';
