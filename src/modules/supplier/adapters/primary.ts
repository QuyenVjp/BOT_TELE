import { newId } from "../../../shared/ids/index.js";
import type { Vault } from "../../../infrastructure/vault/port.js";
import type {
  AssetEnvelope,
  CreateOrderInput,
  CreateOrderResult,
  QueryOrderInput,
  QueryOrderResult,
  SupplierPort,
  AvailabilityResult,
} from "../port.js";
import {
  parseAvailabilityResult,
  parseCreateOrderResult,
  parseQueryOrderResult,
  parseSupplierActionResult,
  SupplierPortError,
} from "../port.js";

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
  /** Real vault used to store fixture asset material. */
  vault: Vault;
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

async function makeEnvelope(
  input: CreateOrderInput,
  vault: Vault,
  externalOrderId: string,
): Promise<AssetEnvelope> {
  const supplierAssetId = "sa-" + newId().slice(-10);
  const vaultRef = await vault.write(`fixture-asset:${externalOrderId}:${supplierAssetId}`, {
    namespace: "asset",
    idempotencyKey: `supplier:${externalOrderId}:${supplierAssetId}`,
  });
  return {
    deliveryType: "CREDENTIAL",
    expectedSku: input.supplierSku,
    region: input.region ?? null,
    durationCode: "P1M",
    expiresAt: null,
    supplierAssetId,
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
      return Promise.resolve(
        parseAvailabilityResult({
          status: options.mode === "reject" ? "OUT" : "AVAILABLE",
          observedAt: new Date().toISOString(),
        }),
      );
    },

    async createOrder(input: CreateOrderInput): Promise<CreateOrderResult> {
      // Idempotency: return the original result for a repeated key.
      const existing = byIdempotency.get(input.idempotencyKey);
      if (existing) return existing.result;

      const externalOrderId = "ext-" + newId().slice(-12);
      const queryKey = "qk-" + input.idempotencyKey;

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
            assetEnvelope: await makeEnvelope(input, options.vault, externalOrderId),
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
      return result;
    },

    async queryOrder(input: QueryOrderInput): Promise<QueryOrderResult> {
      const stored =
        (input.queryKey ? byQueryKey.get(input.queryKey) : undefined) ??
        (input.externalOrderId ? byExternal.get(input.externalOrderId) : undefined);

      if (
        stored &&
        input.expectedSku !== undefined &&
        input.expectedSku !== stored.createInput.supplierSku
      ) {
        throw new SupplierPortError("IDENTITY_MISMATCH", "supplier order identity mismatch");
      }

      if (!stored) {
        // Unknown key: return a rejected observation so the domain can stop retrying.
        return parseQueryOrderResult({
          status: "REJECTED",
          externalOrderId: input.externalOrderId ?? input.queryKey ?? "unknown",
        });
      }

      // timeout-then-fulfill: the create was UNKNOWN, but the upstream order
      // actually completed — query recovers a FULFILLED envelope matching the
      // original create input so domain validation accepts it.
      if (stored.recoverOnQuery) {
        const envelope =
          stored.result.kind === "FULFILLED"
            ? stored.result.assetEnvelope
            : await makeEnvelope(stored.createInput, options.vault, stored.externalOrderId);
        if (stored.result.kind !== "FULFILLED") {
          stored.result = parseCreateOrderResult({
            kind: "FULFILLED",
            externalOrderId: stored.externalOrderId,
            assetEnvelope: envelope,
          });
        }
        return parseQueryOrderResult({
          status: "FULFILLED",
          externalOrderId: stored.externalOrderId,
          assetEnvelope: envelope,
        });
      }

      if (stored.result.kind === "FULFILLED") {
        return parseQueryOrderResult({
          status: "FULFILLED",
          externalOrderId: stored.externalOrderId,
          assetEnvelope: stored.result.assetEnvelope,
        });
      }
      if (stored.result.kind === "REJECTED") {
        return parseQueryOrderResult({
          status: "REJECTED",
          externalOrderId: stored.externalOrderId,
        });
      }
      // ACCEPTED / UNKNOWN without recovery → still pending.
      return parseQueryOrderResult({
        status: "PENDING",
        externalOrderId: stored.externalOrderId,
      });
    },

    cancelOrder() {
      return Promise.resolve(parseSupplierActionResult({ status: "ACCEPTED" }));
    },

    requestRefund() {
      return Promise.resolve(parseSupplierActionResult({ status: "PENDING" }));
    },

    reconcile() {
      return Promise.resolve({ observations: [], nextCursor: null });
    },
  };
}
