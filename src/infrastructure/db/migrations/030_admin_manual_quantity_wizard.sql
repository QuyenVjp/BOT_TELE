alter table admin_workflow
  add column if not exists service_instructions text,
  add column if not exists initial_quantity integer,
  add column if not exists file_artifact jsonb,
  add column if not exists supplier_config jsonb;

alter table admin_workflow
  drop constraint if exists admin_workflow_step_check;

alter table admin_workflow
  add constraint admin_workflow_step_check
  check (step in ('name','sku','variantName','price','category','fulfillmentType','serviceInstructions','initialQuantity','fileArtifact','supplierConfig','inventoryFields','threshold','confirm'));

alter table admin_workflow
  drop constraint if exists admin_workflow_initial_quantity_check;

alter table admin_workflow
  add constraint admin_workflow_initial_quantity_check
  check (initial_quantity is null or initial_quantity >= 0);
