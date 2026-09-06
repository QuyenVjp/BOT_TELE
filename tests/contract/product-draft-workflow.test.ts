import { describe, expect, it } from "vitest";
import { createProductDraftWorkflow } from "../../src/modules/catalog/product-draft.js";

describe("product draft workflow", () => {
  it("keeps independent admin drafts and supports cancellation", () => {
    const workflow = createProductDraftWorkflow();
    workflow.start("100");
    workflow.start("200");
    expect(workflow.get("100")?.step).toBe("name");
    workflow.cancel("100");
    expect(workflow.get("100")).toBeNull();
    expect(workflow.get("200")?.step).toBe("name");
  });

  it("expires drafts instead of retaining stale input", () => {
    const workflow = createProductDraftWorkflow();
    workflow.start("100", 1_000);
    expect(workflow.get("100", 1_000 + 15 * 60_000)).toBeNull();
  });
});
