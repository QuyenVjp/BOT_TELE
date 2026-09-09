-- Durable product-draft extras: commercial fields + delivery-config state.
-- The wizard collects structured commercial data (description template fields,
-- warranty, delivery config toggles) that must survive a worker restart.

alter table admin_workflow
  add column if not exists extra jsonb;
