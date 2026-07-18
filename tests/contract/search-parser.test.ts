import { describe, expect, it, vi } from "vitest";
import {
  SearchFilterSchema,
  parseModelFilterOutput,
  type SearchFilter,
} from "../../src/modules/catalog/search-parser-port.js";
import { createSearchParser } from "../../src/modules/catalog/search-parser-adapter.js";

/**
 * T027 — Search parser contract/property (FR-004, FR-005).
 *
 * The parser may only emit an ALLOWLISTED filter set — never product facts,
 * free-form instructions, or domain actions. Guards:
 *  - unknown fields are stripped/rejected;
 *  - invalid enums and out-of-range/negative prices are rejected;
 *  - prompt-injection text yields at most a bounded `query`, never tool calls or
 *    fabricated products;
 *  - a model timeout/error falls back to deterministic query-only parsing.
 */

const ALLOWED_KEYS = [
  "query",
  "categoryId",
  "duration",
  "minPriceVnd",
  "maxPriceVnd",
  "stockStatus",
  "deliveryType",
  "sort",
];

describe("allowlisted filter schema (FR-004)", () => {
  it("accepts a valid allowlisted filter", () => {
    const parsed = SearchFilterSchema.parse({
      query: "netflix",
      minPriceVnd: 50000,
      maxPriceVnd: 200000,
      deliveryType: "LICENSE",
      stockStatus: "AVAILABLE",
      sort: "price_asc",
    });
    expect(parsed.query).toBe("netflix");
    expect(parsed.deliveryType).toBe("LICENSE");
  });

  it("strips unknown/injected fields", () => {
    const parsed = parseModelFilterOutput({
      query: "spotify",
      // Attempted smuggle of non-allowlisted keys:
      isAdmin: true,
      price_vnd_override: 1,
      __proto__: { polluted: true },
      tool: "createOrder",
    }) as Record<string, unknown>;
    for (const key of Object.keys(parsed)) {
      expect(ALLOWED_KEYS).toContain(key);
    }
    expect(parsed.isAdmin).toBeUndefined();
    expect(parsed.tool).toBeUndefined();
  });

  it("rejects an invalid deliveryType enum", () => {
    expect(() => SearchFilterSchema.parse({ deliveryType: "FREE_MONEY" })).toThrow();
  });

  it("rejects negative and out-of-range prices", () => {
    expect(() => SearchFilterSchema.parse({ minPriceVnd: -1 })).toThrow();
    expect(() => SearchFilterSchema.parse({ maxPriceVnd: 10 ** 15 })).toThrow();
  });

  it("rejects a stockStatus other than AVAILABLE", () => {
    expect(() => SearchFilterSchema.parse({ stockStatus: "OUT" })).toThrow();
  });

  it("bounds an oversized query string", () => {
    const huge = "x".repeat(5000);
    const parsed = parseModelFilterOutput({ query: huge }) as SearchFilter;
    expect((parsed.query ?? "").length).toBeLessThanOrEqual(256);
  });
});

describe("parser adapter fallback (FR-004/FR-005)", () => {
  it("uses the model output when it returns valid allowlisted filters", async () => {
    const model = vi.fn(async () => ({ query: "netflix", deliveryType: "LICENSE" }));
    const parser = createSearchParser({ driver: "model", model, timeoutMs: 100 });
    const result = await parser.parse("cho tôi netflix bản quyền");
    expect(result.deliveryType).toBe("LICENSE");
    expect(result.query).toContain("netflix");
  });

  it("falls back to deterministic query-only parsing on model timeout", async () => {
    const model = vi.fn(
      () =>
        new Promise<Record<string, unknown>>((resolve) =>
          setTimeout(() => resolve({ query: "late" }), 1000),
        ),
    );
    const parser = createSearchParser({ driver: "model", model, timeoutMs: 50 });
    const raw = "tìm tài khoản netflix";
    const result = await parser.parse(raw);
    // Fallback keeps the (bounded, folded) raw query and adds no other fields.
    expect(result.query).toBeTruthy();
    expect(result.deliveryType).toBeUndefined();
  });

  it("falls back when the model throws", async () => {
    const model = vi.fn(async () => {
      throw new Error("model unavailable");
    });
    const parser = createSearchParser({ driver: "model", model, timeoutMs: 100 });
    const result = await parser.parse("spotify");
    expect(result.query).toBe("spotify");
  });

  it("never emits product facts or tool calls even if the model tries", async () => {
    const model = vi.fn(async () => ({
      query: "netflix",
      // Model attempts to fabricate a product fact / action:
      productName: "Netflix Ultra 999k",
      priceVnd: 999000,
      action: "createOrder",
    }));
    const parser = createSearchParser({ driver: "model", model, timeoutMs: 100 });
    const result = (await parser.parse("netflix")) as Record<string, unknown>;
    expect(result.productName).toBeUndefined();
    expect(result.action).toBeUndefined();
    expect(result.priceVnd).toBeUndefined();
  });

  it("deterministic driver ignores any model and only folds the query", async () => {
    const parser = createSearchParser({ driver: "deterministic", timeoutMs: 100 });
    const result = await parser.parse("  Netflix   Premium  ");
    expect(result.query).toBe("netflix premium");
  });
});
