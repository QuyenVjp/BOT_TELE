import { expect } from "vitest";
import type { SupplierProvider } from "../../src/modules/supplier/port.js";

export async function expectUnsupportedSupplierOperations(
  provider: SupplierProvider,
): Promise<void> {
  await expect(provider.getAvailability({ supplierSku: "fixture" })).rejects.toMatchObject({
    supplierCode: "UNSUPPORTED",
  });
  await expect(
    provider.createOrder({
      idempotencyKey: "fixture-order",
      supplierSku: "fixture",
      costCeilingVnd: 1,
      orderId: "fixture-order",
    }),
  ).rejects.toMatchObject({ supplierCode: "UNSUPPORTED" });
  await expect(provider.queryOrder({ externalOrderId: "fixture-order" })).rejects.toMatchObject({
    supplierCode: "UNSUPPORTED",
  });
  await expect(
    provider.cancelOrder({
      externalOrderId: "fixture-order",
      idempotencyKey: "fixture-cancel",
      reason: "contract",
    }),
  ).rejects.toMatchObject({ supplierCode: "UNSUPPORTED" });
  await expect(
    provider.requestRefund({
      externalOrderId: "fixture-order",
      idempotencyKey: "fixture-refund",
      reason: "contract",
    }),
  ).rejects.toMatchObject({ supplierCode: "UNSUPPORTED" });
  await expect(provider.reconcile({ limit: 1 })).rejects.toMatchObject({
    supplierCode: "UNSUPPORTED",
  });
}
