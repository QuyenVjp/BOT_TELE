import { newId } from "../../../shared/ids/index.js";
import type {
  AssetEnvelope,
  CreateOrderInput,
  CreateOrderResult,
  QueryOrderInput,
  QueryOrderResult,
  SupplierPort,
  AvailabilityResult,
} from "../port.js";
import { parseCreateOrderResult, parseQueryOrderResult } from "../port.js";

/**
 * Sandbox / primary supplier adapter (T068).
 *
 * Deterministic fixture-driven adapter for tests and local development. Modes
 * exercise the contract corners:
 *   - `fulfill`               — create returns FULFILLED with a vault-ref envelope
 *   - `reject`                — create returns REJECTED (non-retryable)
 *   - `timeout`               — create returns UNKNOWN (transport timeout)
 *   - `timeout-then-fulfill`  — first create is UNKNOWN; subsequent queryOrder
 *                               recovers a FULFILLED result (query-before-retry)
 *
 * The adapter enforces create idempotency on the idempotency key and always
 * routes responses through the Zod schemas so a malformed fixture cannot
 * leak past the port boundary.
 */

export type SandboxMode = "fulfill" | "reject" | "timeout" | "timeout-then-fulfill";

export interface SandboxOptions {
  mode: SandboxMode;
  /** Optional fixed vault ref for fulfilled envelopes (defaults to a fresh one). */
  vaultRef?: string;
}

interface Stored {
  externalOrderId: string;
  result: CreateOrderResult;
  queryKey: string;
  /** Original create input so a recovered FULFILLED envelope matches the order. */
  createInput: CreateOrderInput;
  /** For timeout-then-fulfill: after the first UNKNOWN, query returns FULFILLED. */
  recoverOnQuery: boolean;
}

function makeEnvelope(input: CreateOrderInput, vaultRef: string): AssetEnvelope {
  return {
    deliveryType: "CREDENTIAL",
    expectedSku: input.supplierSku,
    region: input.region ?? null,
    durationCode: "P1M",
    expiresAt: null,
    supplierAssetId: "sa-" + newId().slice(-10),
    fingerprint: "fp-" + newId().slice(-16),
    vaultRef,
  };
}

export function createSandboxSupplierAdapter(options: SandboxOptions): SupplierPort {
  const byIdempotency = new Map<string, Stored>();
  const byQueryKey = new Map<string, Stored>();
  const byExternal = new Map<string, Stored>();

  function store(idempotencyKey: string, entry: Stored): void {
    byIdempotency.set(idempotencyKey, entry);
    byQueryKey.set(entry.queryKey, entry);
    byExternal.set(entry.externalOrderId, entry);
  }

  return {
    getAvailability(): Promise<AvailabilityResult> {
      return Promise.resolve({
        status: options.mode === "reject" ? "OUT" : "AVAILABLE",
        observedAt: new Date().toISOString(),
      });
    },

    createOrder(input: CreateOrderInput): Promise<CreateOrderResult> {
      // Idempotency: return the original result for a repeated key.
      const existing = byIdempotency.get(input.idempotencyKey);
      if (existing) return Promise.resolve(existing.result);

      const externalOrderId = "ext-" + newId().slice(-12);
      const queryKey = "qk-" + input.idempotencyKey;
      const vaultRef = options.vaultRef ?? `vault:${newId()}`;

      let raw: CreateOrderResult;
      switch (options.mode) {
        case "reject":
          raw = { kind: "REJECTED", code: "OUT_OF_STOCK", retryable: false };
          break;
        case "timeout":
          raw = { kind: "UNKNOWN", queryKey, reason: "transport_timeout" };
          break;
        case "timeout-then-fulfill":
          raw = { kind: "UNKNOWN", queryKey, reason: "transport_timeout" };
          break;
        case "fulfill":
        default:
          raw = {
            kind: "FULFILLED",
            externalOrderId,
            assetEnvelope: makeEnvelope(input, vaultRef),
          };
          break;
      }

      // Schema-validate before returning (defense in depth; same path as a real adapter).
      const result = parseCreateOrderResult(raw);
      store(input.idempotencyKey, {
        externalOrderId,
        result,
        queryKey,
        createInput: input,
        recoverOnQuery: options.mode === "timeout-then-fulfill",
      });
      return Promise.resolve(result);
    },

    queryOrder(input: QueryOrderInput): Promise<QueryOrderResult> {
      const stored =
        (input.queryKey ? byQueryKey.get(input.queryKey) : undefined) ??
        (input.externalOrderId ? byExternal.get(input.externalOrderId) : undefined);

      if (!stored) {
        // Unknown key: return a rejected observation so the domain can stop retrying.
        return Promise.resolve(
          parseQueryOrderResult({
            status: "REJECTED",
            externalOrderId: input.externalOrderId ?? input.queryKey ?? "unknown",
          }),
        );
      }

      // timeout-then-fulfill: the create was UNKNOWN, but the upstream order
      // actually completed — query recovers a FULFILLED envelope matching the
      // original create input so domain validation accepts it.
      if (stored.recoverOnQuery) {
        const envelope =
          stored.result.kind === "FULFILLED"
            ? stored.result.assetEnvelope
            : makeEnvelope(stored.createInput, options.vaultRef ?? `vault:${newId()}`);
        return Promise.resolve(
          parseQueryOrderResult({
            status: "FULFILLED",
            externalOrderId: stored.externalOrderId,
            assetEnvelope: envelope,
          }),
        );
      }

      if (stored.result.kind === "FULFILLED") {
        return Promise.resolve(
          parseQueryOrderResult({
            status: "FULFILLED",
            externalOrderId: stored.externalOrderId,
            assetEnvelope: stored.result.assetEnvelope,
          }),
        );
      }
      if (stored.result.kind === "REJECTED") {
        return Promise.resolve(
          parseQueryOrderResult({
            status: "REJECTED",
            externalOrderId: stored.externalOrderId,
          }),
        );
      }
      // ACCEPTED / UNKNOWN without recovery → still pending.
      return Promise.resolve(
        parseQueryOrderResult({
          status: "PENDING",
          externalOrderId: stored.externalOrderId,
        }),
      );
    },

    cancelOrder() {
      return Promise.resolve({ status: "ACCEPTED" as const });
    },

    requestRefund() {
      return Promise.resolve({ status: "PENDING" as const });
    },

    reconcile() {
      return Promise.resolve({ observations: [], nextCursor: null });
    },
  };
}
