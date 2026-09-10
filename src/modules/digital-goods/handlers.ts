import type { Db } from "../../infrastructure/db/transaction.js";
import type { OutboxEvent } from "../../infrastructure/outbox/repository.js";
import {
  classifyFulfillmentOutcome,
  isKnownOutboxEventType,
  type DispatchDecision,
} from "../../infrastructure/outbox/dispatch-policy.js";
import type { Vault } from "../../infrastructure/vault/port.js";
import type { SupplierPort } from "../supplier/port.js";
import { fulfillPaidOrder, type FulfillmentDeps } from "./fulfillment.js";
import type { FulfillmentTelemetry } from "./telemetry.js";
import { createDeliveryNotificationHandoff } from "./delivery-notification.js";
import type { DeliverySessionCodecConfig } from "./delivery-session.js";
import {
  handleNotificationOutboxEvent,
  queueManualFulfillmentNotification,
} from "../notification/service.js";
import {
  processFileDelivery,
  queueFileDelivery,
  type TelegramDocumentSender,
} from "./file-delivery.js";

/**
 * Outbox handlers that connect payment settlement to fulfillment and delivery
 * notification (T076, FR-013, SR-006).
 *
 * `OrderPaid` → `fulfillPaidOrder` (local claim + Delivery Bundle). The handler
 * is idempotent: replaying the outbox event re-enters the orchestrator, which
 * reuses the held asset + active bundle. Delivery notification is a pure side
 * effect (Telegram send) driven by `DeliveryBundleCreated`; the actual send is
 * injected so tests can assert without a live bot.
 */

export interface DeliveryNotifier {
  /**
   * Notify the customer that a Delivery Bundle is ready. Must be safe to retry
   * (at-least-once). The plaintext token is only available on first issue; a
   * reuse may deliver a stable "already issued" message without a new token.
   */
  notifyBundleReady(input: {
    orderId: string;
    customerId: string;
    bundleId: string;
    deliveryUrl: string;
    correlationId: string;
  }): Promise<void>;
}

export interface FulfillmentHandlerDeps {
  db: Db;
  vault: Vault;
  supplier: SupplierPort | null;
  deliveryBaseUrl: string;
  bundleTtlSeconds: number;
  notifier?: DeliveryNotifier;
  deliverySession?: {
    config: DeliverySessionCodecConfig;
    ttlSeconds: number;
  };
  fileDelivery?: {
    storageRoots: readonly string[];
    sender: TelegramDocumentSender;
  };
  telemetry?: FulfillmentTelemetry;
}

function payloadOf(event: OutboxEvent): Record<string, unknown> {
  return event.payloadRedacted ?? {};
}

/**
 * Build the outbox handler that the worker drains. Returns a typed
 * {@link DispatchDecision} so the drainer never silently acks a recoverable
 * failure or an unknown event (T135).
 */
export function createFulfillmentOutboxHandler(
  deps: FulfillmentHandlerDeps,
): (event: OutboxEvent) => Promise<DispatchDecision> {
  const fulfillmentDeps: FulfillmentDeps = {
    vault: deps.vault,
    supplier: deps.supplier,
    deliveryBaseUrl: deps.deliveryBaseUrl,
    bundleTtlSeconds: deps.bundleTtlSeconds,
    ...(deps.deliverySession
      ? {
          deliveryTokenKeys: [
            deps.deliverySession.config.key,
            ...(deps.deliverySession.config.previousKey
              ? [deps.deliverySession.config.previousKey]
              : []),
          ],
        }
      : {}),
  };

  return async (event): Promise<DispatchDecision> => {
    // Defense in depth: the drainer already rejects unknown types, but a
    // miswired caller must not get a silent PUBLISHED.
    if (!isKnownOutboxEventType(event.eventType)) {
      return { kind: "UNKNOWN_EVENT", eventType: event.eventType };
    }

    if (
      event.eventType === "WalletTopupPresented" ||
      event.eventType === "WalletTopupCredited" ||
      event.eventType === "WalletRefunded" ||
      // Warranty customer notices (goal: warranty vertical). The admin alert for a new claim is
      // routed in the worker, where the owner's chat id is available.
      event.eventType === "WarrantyClaimNeedsInfo" ||
      event.eventType === "WarrantyClaimVerified" ||
      event.eventType === "WarrantyClaimRejected" ||
      event.eventType === "WarrantyReplacementApproved" ||
      event.eventType === "WarrantyRefundDue" ||
      event.eventType === "WarrantyRefundPaid" ||
      // Preorder notices: a deposit that was kept, or a reservation the shop had to cancel, is
      // money the customer must hear about.
      event.eventType === "PreorderDepositPaid" ||
      event.eventType === "PreorderHoldForfeited" ||
      event.eventType === "PreorderShopCancelled"
    ) {
      return handleNotificationOutboxEvent(deps.db, event);
    }

    if (event.eventType === "OrderPaid") {
      const p = payloadOf(event);
      const orderId = typeof p.orderId === "string" ? p.orderId : event.aggregateId;
      const correlationId =
        typeof p.correlationId === "string" ? p.correlationId : `outbox-${event.id}`;
      const started = Date.now();

      const queuedFile = await queueFileDelivery({ db: deps.db, orderId });
      if (queuedFile.ok) {
        if (!deps.fileDelivery) return { kind: "RETRY", errorCode: "FILE_DELIVERY_NOT_CONFIGURED" };
        const delivered = await processFileDelivery({
          db: deps.db,
          job: queuedFile.job,
          storageRoots: deps.fileDelivery.storageRoots,
          sender: deps.fileDelivery.sender,
        });
        return delivered.ok ? { kind: "PUBLISHED" } : { kind: "RETRY", errorCode: delivered.code };
      }
      if (queuedFile.code !== "NOT_DIGITAL_FILE") {
        return queuedFile.code === "ORDER_NOT_FOUND" || queuedFile.code === "ORDER_NOT_PAID"
          ? { kind: "TERMINAL_REVIEW", errorCode: queuedFile.code }
          : { kind: "RETRY", errorCode: queuedFile.code };
      }

      const result = await fulfillPaidOrder(deps.db, {
        orderId,
        correlationId,
        deps: fulfillmentDeps,
      });

      if (result.ok) {
        const lagSeconds = Math.floor((Date.now() - started) / 1000);
        deps.telemetry?.recordFulfillmentLag({ orderId, lagSeconds });

        if (result.kind === "DELIVERY_BUNDLE" && result.token && deps.deliverySession) {
          await createDeliveryNotificationHandoff(deps.db, {
            vault: deps.vault,
            bundleId: result.bundleId,
            customerId: result.customerId,
            deliveryUrl: result.deliveryUrl,
            sessionTtlSeconds: deps.deliverySession.ttlSeconds,
            sessionConfig: deps.deliverySession.config,
          });
        } else if (result.kind === "DELIVERY_BUNDLE" && deps.notifier && result.token) {
          // First-issue only: a reused bundle has an empty token and the
          // original notification already went out.
          await deps.notifier.notifyBundleReady({
            orderId: result.orderId,
            customerId: result.customerId,
            bundleId: result.bundleId,
            deliveryUrl: result.deliveryUrl,
            correlationId,
          });
        }
        return { kind: "PUBLISHED" };
      }

      // Explicit classification: OUT_OF_STOCK / NEEDS_REVIEW / ISSUE_FAILED
      // must RETRY (not ack), NOT_PAID / NOT_FOUND park as TERMINAL_REVIEW.
      // The previous code returned normally here, so the event was marked
      // published and the paid Order was never retried (T135 finding).
      const decision = classifyFulfillmentOutcome(result);
      if (decision.kind === "RETRY") {
        deps.telemetry?.recordSupplierFailure({ supplier: "fulfillment" });
      }
      return decision;
    }

    if (event.eventType === "DeliveryBundleCreated") {
      if (deps.deliverySession) {
        const p = payloadOf(event);
        const orderId = typeof p.orderId === "string" ? p.orderId : null;
        const correlationId =
          typeof p.correlationId === "string" ? p.correlationId : `outbox-${event.id}`;
        if (!orderId) return { kind: "RETRY", errorCode: "DELIVERY_HANDOFF_ORDER_MISSING" };
        const result = await fulfillPaidOrder(deps.db, {
          orderId,
          correlationId,
          deps: fulfillmentDeps,
        });
        if (!result.ok || result.kind !== "DELIVERY_BUNDLE" || !result.token) {
          return { kind: "RETRY", errorCode: "DELIVERY_HANDOFF_NOT_READY" };
        }
        await createDeliveryNotificationHandoff(deps.db, {
          vault: deps.vault,
          bundleId: result.bundleId,
          customerId: result.customerId,
          deliveryUrl: result.deliveryUrl,
          sessionTtlSeconds: deps.deliverySession.ttlSeconds,
          sessionConfig: deps.deliverySession.config,
        });
      }
      return { kind: "PUBLISHED" };
    }

    if (event.eventType === "ManualFulfillmentTaskCreated") {
      const p = payloadOf(event);
      const taskId = typeof p.taskId === "string" ? p.taskId : event.aggregateId;
      const customerId = typeof p.customerId === "string" ? p.customerId : null;
      const correlationId =
        typeof p.correlationId === "string" ? p.correlationId : `outbox-${event.id}`;
      if (!customerId) return { kind: "RETRY", errorCode: "MANUAL_TASK_CUSTOMER_MISSING" };
      await queueManualFulfillmentNotification(deps.db, {
        customerId,
        taskId,
        state: "WAITING",
        correlationId,
      });
      return { kind: "PUBLISHED" };
    }

    if (event.eventType === "ManualFulfillmentTaskCompleted") {
      const p = payloadOf(event);
      const taskId = typeof p.taskId === "string" ? p.taskId : event.aggregateId;
      const customerId = typeof p.customerId === "string" ? p.customerId : null;
      const correlationId =
        typeof p.correlationId === "string" ? p.correlationId : `outbox-${event.id}`;
      if (!customerId) return { kind: "RETRY", errorCode: "MANUAL_TASK_CUSTOMER_MISSING" };
      await queueManualFulfillmentNotification(deps.db, {
        customerId,
        taskId,
        state: "COMPLETED",
        correlationId,
      });
      return { kind: "PUBLISHED" };
    }

    if (event.eventType === "DigitalAssetDelivered") {
      const p = payloadOf(event);
      const bundleId = typeof p.bundleId === "string" ? p.bundleId : event.aggregateId;
      deps.telemetry?.recordDeliveryReveal({ bundleId });
      return { kind: "PUBLISHED" };
    }

    // Known but not handled by this fulfillment handler (e.g. PaymentSettled).
    // Ack so a shared outbox is not poisoned by events owned by other modules.
    return { kind: "PUBLISHED" };
  };
}
