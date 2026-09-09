-- Expand durable product-draft steps for the 8-step wizard.
-- Keep prior 030 steps so in-flight drafts remain valid, and add the 8-step wizard names.
alter table admin_workflow drop constraint if exists admin_workflow_step_check;
alter table admin_workflow
  add constraint admin_workflow_step_check check (step in (
    'name',
    'sku',
    'category',
    'productType',
    'description',
    'variant',
    'deliveryConfig',
    'confirm',
    'variantName',
    'price',
    'fulfillmentType',
    'inventoryFields',
    'threshold',
    'serviceInstructions',
    'initialQuantity',
    'fileArtifact',
    'supplierConfig'
  ));
