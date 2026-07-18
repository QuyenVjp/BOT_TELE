import {
  parseModelFilterOutput,
  type SearchFilter,
  type SearchParser,
} from "./search-parser-port.js";
import { foldText } from "./search.js";

/**
 * Search-parser adapter (FR-004 / FR-005).
 *
 * Two drivers:
 *  - `deterministic`: fold the free-text query and return it alone. No model,
 *    no domain tools, no product facts.
 *  - `model`: call an injected model function under a hard timeout. The raw
 *    output is forced through `parseModelFilterOutput` so only allowlisted
 *    filter fields survive. On timeout, throw, or schema failure, fall back to
 *    the deterministic path — the customer still gets a useful search, and the
 *    system never invents product facts.
 *
 * The model function is injected so the adapter has zero domain tools and zero
 * network of its own; production wires a real LLM client, tests inject fakes.
 */

export type ModelFn = (rawUserText: string) => Promise<unknown>;

export interface SearchParserOptions {
  driver: "deterministic" | "model";
  /** Required when driver === "model". */
  model?: ModelFn;
  /** Hard timeout for the model call (ms). */
  timeoutMs: number;
}

function deterministicParse(rawUserText: string): SearchFilter {
  const query = foldText(rawUserText);
  return query.length > 0 ? { query } : {};
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("search-parser timeout")), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

export function createSearchParser(options: SearchParserOptions): SearchParser {
  return {
    async parse(rawUserText: string): Promise<SearchFilter> {
      if (options.driver === "deterministic" || !options.model) {
        return deterministicParse(rawUserText);
      }

      try {
        const raw = await withTimeout(options.model(rawUserText), options.timeoutMs);
        return parseModelFilterOutput(raw);
      } catch {
        // Timeout, throw, or schema failure → deterministic fallback.
        return deterministicParse(rawUserText);
      }
    },
  };
}
