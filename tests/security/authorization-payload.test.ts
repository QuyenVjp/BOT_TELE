import { describe, expect, it } from "vitest";
import {
  canonicalAuthorizationPayload,
  hashAuthorizationPayload,
} from "../../src/modules/identity/authorization-payload.js";

describe("authorization payload binding", () => {
  it("canonicalizes object key order", () => {
    const left = hashAuthorizationPayload({
      actionKey: "catalog.variant.price.change",
      resourceType: "ProductVariant",
      resourceId: "variant-1",
      resourceVersion: "7",
      data: {
        requested: { priceVnd: "100000", compareAtPriceVnd: null },
        current: { priceVnd: "90000" },
      },
    });
    const right = hashAuthorizationPayload({
      actionKey: "catalog.variant.price.change",
      resourceType: "ProductVariant",
      resourceId: "variant-1",
      resourceVersion: "7",
      data: {
        current: { priceVnd: "90000" },
        requested: { compareAtPriceVnd: null, priceVnd: "100000" },
      },
    });
    expect(left).toBe(right);
  });

  it("changes when a requested significant value changes", () => {
    const base = {
      actionKey: "inventory.stock.adjust",
      resourceType: "ProductVariant",
      resourceId: "variant-1",
      resourceVersion: "3",
      data: { current: { availableQuantity: 10 }, requested: { delta: 2 } },
    } as const;
    expect(hashAuthorizationPayload(base)).not.toBe(
      hashAuthorizationPayload({ ...base, data: { ...base.data, requested: { delta: 3 } } }),
    );
  });

  it("includes action, resource, version, and data in the canonical payload", () => {
    const payload = canonicalAuthorizationPayload({
      actionKey: "broadcast.confirm",
      resourceType: "NotificationCampaign",
      resourceId: "campaign-1",
      resourceVersion: "4",
      data: { current: { contentHash: "hash" }, requested: { campaignId: "campaign-1" } },
    });
    expect(payload).toContain('"actionKey":"broadcast.confirm"');
    expect(payload).toContain('"resourceVersion":"4"');
    expect(payload).toContain('"contentHash":"hash"');
  });
});
