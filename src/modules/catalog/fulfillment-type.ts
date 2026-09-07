import { z } from "zod";
import type { DeliveryType, StockPolicy } from "./domain.js";

export const FULFILLMENT_TYPES = [
  "STOCK_ACCOUNT",
  "STOCK_CODE",
  "DIGITAL_FILE",
  "SUPPLIER_API",
  "MANUAL_FULFILLMENT",
  "QUANTITY_STOCK",
  "UNLIMITED_SERVICE",
] as const;

export type FulfillmentType = (typeof FULFILLMENT_TYPES)[number];

export const FulfillmentTypeSchema = z.enum(FULFILLMENT_TYPES);

export const FULFILLMENT_TYPE_LABELS = {
  STOCK_ACCOUNT: "Tài khoản kho",
  STOCK_CODE: "Mã kho",
  DIGITAL_FILE: "Tệp số",
  SUPPLIER_API: "Kết nối nhà cung cấp",
  MANUAL_FULFILLMENT: "Xử lý thủ công",
  QUANTITY_STOCK: "Tồn kho số lượng",
  UNLIMITED_SERVICE: "Dịch vụ không giới hạn",
} satisfies Record<FulfillmentType, string>;

export const INVENTORY_FIELD_SCHEMA = z
  .object({
    name: z.string().trim().min(1).max(64),
    label: z.string().trim().min(1).max(120),
    required: z.boolean().default(false),
    secret: z.boolean().default(false),
    customerVisible: z.boolean().default(false),
  })
  .strict();

export type InventoryField = z.infer<typeof INVENTORY_FIELD_SCHEMA>;

export const INVENTORY_FIELDS_SCHEMA = z
  .array(INVENTORY_FIELD_SCHEMA)
  .superRefine((fields, ctx) => {
    const seen = new Set<string>();
    for (const [index, field] of fields.entries()) {
      if (seen.has(field.name)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `duplicate inventory field name: ${field.name}`,
          path: [index, "name"],
        });
        continue;
      }
      seen.add(field.name);
    }
  });

export type InventoryFields = z.infer<typeof INVENTORY_FIELDS_SCHEMA>;

export const VARIANT_FULFILLMENT_CONFIG_SCHEMA = z
  .object({
    fulfillmentType: FulfillmentTypeSchema.default("STOCK_ACCOUNT"),
    inventoryFields: INVENTORY_FIELDS_SCHEMA.default([]),
    lowStockThreshold: z.number().int().nonnegative().nullable().default(null),
  })
  .strict();

export type VariantFulfillmentConfig = z.infer<typeof VARIANT_FULFILLMENT_CONFIG_SCHEMA>;

export const DEFAULT_VARIANT_FULFILLMENT_CONFIG: VariantFulfillmentConfig = {
  fulfillmentType: "STOCK_ACCOUNT",
  inventoryFields: [],
  lowStockThreshold: null,
};

export interface LegacyFulfillmentRoutingInput {
  deliveryType: DeliveryType;
  stockPolicy: StockPolicy;
}

export function mapLegacyFulfillmentType(input: LegacyFulfillmentRoutingInput): FulfillmentType {
  if (input.stockPolicy === "SUPPLIER_ONLY") return "SUPPLIER_API";
  switch (input.deliveryType) {
    case "CREDENTIAL":
      return "STOCK_ACCOUNT";
    case "LICENSE":
    case "ACTIVATION_KEY":
      return "STOCK_CODE";
    case "MANUAL_REVIEW":
      return "MANUAL_FULFILLMENT";
    case "INVITE":
      return "MANUAL_FULFILLMENT";
  }
}
