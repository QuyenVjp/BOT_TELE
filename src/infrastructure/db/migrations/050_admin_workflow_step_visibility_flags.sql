-- Expand durable product-draft steps for Step 8 (visibility/featured/preorder/low-stock).
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
    'visibilityFlags',
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
