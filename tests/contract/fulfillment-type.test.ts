import { describe, expect, it } from "vitest";
import {
  DEFAULT_VARIANT_FULFILLMENT_CONFIG,
  FULFILLMENT_TYPE_LABELS,
  INVENTORY_FIELDS_SCHEMA,
  VARIANT_FULFILLMENT_CONFIG_SCHEMA,
  mapLegacyFulfillmentType,
} from "../../src/modules/catalog/fulfillment-type.js";

describe("catalog fulfillment-type contract", () => {
  it("maps legacy product_variant fields to the new fulfillment type", () => {
    expect(
      mapLegacyFulfillmentType({ deliveryType: "CREDENTIAL", stockPolicy: "LOCAL_ONLY" }),
    ).toBe("STOCK_ACCOUNT");
    expect(mapLegacyFulfillmentType({ deliveryType: "LICENSE", stockPolicy: "LOCAL_ONLY" })).toBe(
      "STOCK_CODE",
    );
    expect(
      mapLegacyFulfillmentType({ deliveryType: "ACTIVATION_KEY", stockPolicy: "LOCAL_ONLY" }),
    ).toBe("STOCK_CODE");
    expect(
      mapLegacyFulfillmentType({ deliveryType: "MANUAL_REVIEW", stockPolicy: "LOCAL_ONLY" }),
    ).toBe("MANUAL_FULFILLMENT");
    expect(mapLegacyFulfillmentType({ deliveryType: "INVITE", stockPolicy: "LOCAL_ONLY" })).toBe(
      "MANUAL_FULFILLMENT",
    );
    expect(
      mapLegacyFulfillmentType({ deliveryType: "CREDENTIAL", stockPolicy: "SUPPLIER_ONLY" }),
    ).toBe("SUPPLIER_API");
  });

  it("accepts config with unique inventory field names and nonnegative thresholds", () => {
    const config = VARIANT_FULFILLMENT_CONFIG_SCHEMA.parse({
      fulfillmentType: "STOCK_CODE",
      inventoryFields: [
        {
          name: "account",
          label: "Tài khoản",
          required: true,
          secret: true,
          customerVisible: false,
        },
        { name: "pin", label: "Mã PIN", required: false, secret: false, customerVisible: true },
      ],
      lowStockThreshold: 0,
    });

    expect(config.inventoryFields).toHaveLength(2);
    expect(config.lowStockThreshold).toBe(0);
    expect(INVENTORY_FIELDS_SCHEMA.parse(config.inventoryFields)).toEqual(config.inventoryFields);
  });

  it("rejects duplicate inventory field names and negative low stock thresholds", () => {
    expect(() =>
      VARIANT_FULFILLMENT_CONFIG_SCHEMA.parse({
        inventoryFields: [
          { name: "serial", label: "Số serial" },
          { name: "serial", label: "Serial lặp" },
        ],
      }),
    ).toThrow(/duplicate inventory field name/i);

    expect(() => VARIANT_FULFILLMENT_CONFIG_SCHEMA.parse({ lowStockThreshold: -1 })).toThrow();
  });

  it("exposes stable labels and defaults", () => {
    expect(FULFILLMENT_TYPE_LABELS).toMatchObject({
      STOCK_ACCOUNT: "Tài khoản kho",
      STOCK_CODE: "Mã kho",
      DIGITAL_FILE: "Tệp số",
      SUPPLIER_API: "Kết nối nhà cung cấp",
      MANUAL_FULFILLMENT: "Xử lý thủ công",
      QUANTITY_STOCK: "Tồn kho số lượng",
      UNLIMITED_SERVICE: "Dịch vụ không giới hạn",
    });
    expect(DEFAULT_VARIANT_FULFILLMENT_CONFIG).toEqual({
      fulfillmentType: "STOCK_ACCOUNT",
      inventoryFields: [],
      lowStockThreshold: null,
    });
  });
});
