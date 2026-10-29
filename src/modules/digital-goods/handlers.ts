import type { Db } from "../../infrastructure/db/transaction.js";
import type { OutboxEvent } from "../../infrastructure/outbox/repository.js";
import {
  classifyFulfillmentOutcome,
  isKnownOutboxEventType,
  type DispatchDecision,
} from "../../infrastructure/outbox/dispatch-policy.js";
import type { Vault } from "../../infrastructure/vault/port.js";
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
  type ProcessFileDeliveryResult,
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
  resolveSupplier: FulfillmentDeps["resolveSupplier"];
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

function classifyFileDeliveryRetryResult(result: ProcessFileDeliveryResult): DispatchDecision {
  if (result.ok) return { kind: "PUBLISHED" };
  if (
    result.code === "JOB_NOT_FOUND" ||
    result.code === "ORDER_NOT_PAID" ||
    result.code === "SEND_UNCERTAIN"
  ) {
    return { kind: "TERMINAL_REVIEW", errorCode: result.code };
  }
  return { kind: "RETRY", errorCode: result.code };
}

async function handleFileDeliveryRetry(
  deps: FulfillmentHandlerDeps,
  event: OutboxEvent,
): Promise<DispatchDecision> {
  if (!deps.fileDelivery) return { kind: "RETRY", errorCode: "FILE_DELIVERY_NOT_CONFIGURED" };
  const payload = payloadOf(event);
  const orderId = typeof payload.orderId === "string" ? payload.orderId : null;
  const jobId = typeof payload.jobId === "string" ? payload.jobId : null;
  const artifactId = typeof payload.artifactId === "string" ? payload.artifactId : null;
  const artifactVersion =
    typeof payload.artifactVersion === "number" ? payload.artifactVersion : null;
  const artifactSha256 = typeof payload.artifactSha256 === "string" ? payload.artifactSha256 : null;
  const claimGeneration =
    typeof payload.claimGeneration === "number" ? payload.claimGeneration : null;
  // Older durable retry events predate the chat snapshot; the job row remains authoritative.
  let telegramChatId: string | null | undefined = null;
  if (payload.telegramChatId !== undefined) {
    if (
      typeof payload.telegramChatId === "string" &&
      /^[1-9][0-9]{0,19}$/u.test(payload.telegramChatId)
    ) {
      telegramChatId = payload.telegramChatId;
    } else {
      telegramChatId = undefined;
    }
  }
  if (
    typeof orderId !== "string" ||
    orderId.length === 0 ||
    typeof jobId !== "string" ||
    jobId.length === 0 ||
    typeof artifactId !== "string" ||
    artifactId.length === 0 ||
    typeof artifactVersion !== "number" ||
    !Number.isInteger(artifactVersion) ||
    artifactVersion < 1 ||
    typeof artifactSha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(artifactSha256) ||
    typeof claimGeneration !== "number" ||
    !Number.isInteger(claimGeneration) ||
    claimGeneration < 0 ||
    telegramChatId === undefined
  ) {
    return { kind: "TERMINAL_REVIEW", errorCode: "INVALID_FILE_DELIVERY_RETRY" };
  }
  if (event.aggregateType !== "FileDeliveryJob" || event.aggregateId !== orderId) {
    return { kind: "TERMINAL_REVIEW", errorCode: "STALE_JOB" };
  }

  const queued = await queueFileDelivery({
    db: deps.db,
    orderId,
    createIfMissing: false,
  });
  if (!queued.ok) {
    if (
      queued.code === "JOB_NOT_FOUND" ||
      queued.code === "ORDER_NOT_FOUND" ||
      queued.code === "ORDER_NOT_PAID" ||
      queued.code === "NOT_DIGITAL_FILE"
    ) {
      return { kind: "TERMINAL_REVIEW", errorCode: queued.code };
    }
    return { kind: "RETRY", errorCode: queued.code };
  }
  if (
    queued.inserted ||
    queued.job.orderId !== orderId ||
    queued.job.orderId !== jobId ||
    queued.job.artifactId !== artifactId ||
    queued.job.artifactVersion !== artifactVersion ||
    queued.job.artifactSha256 !== artifactSha256 ||
    (telegramChatId !== null && queued.job.telegramChatId !== telegramChatId)
  ) {
    return { kind: "TERMINAL_REVIEW", errorCode: "STALE_JOB" };
  }
  if (queued.job.status === "SENT") return { kind: "PUBLISHED" };
  if (queued.job.status === "FAILED" && queued.job.lastError === "SEND_UNCERTAIN") {
    return { kind: "TERMINAL_REVIEW", errorCode: "SEND_UNCERTAIN" };
  }
  if (queued.job.status === "PROCESSING") {
    const probed = await processFileDelivery({
      db: deps.db,
      job: queued.job,
      storageRoots: deps.fileDelivery.storageRoots,
      sender: deps.fileDelivery.sender,
    });
    if (!probed.ok && probed.code === "STALE_JOB") {
      return { kind: "RETRY", errorCode: "FILE_DELIVERY_PROCESSING" };
    }
    return classifyFileDeliveryRetryResult(probed);
  }
  // A proven Telegram rejection is safe to retry; the job claim generation
  // advances for every send while the durable event payload stays unchanged.
  const provenFailureReplay =
    queued.job.status === "FAILED" &&
    queued.job.lastError === "SEND_FAILED" &&
    queued.job.claimGeneration > claimGeneration;
  if (queued.job.claimGeneration !== claimGeneration && !provenFailureReplay) {
    return { kind: "TERMINAL_REVIEW", errorCode: "STALE_JOB" };
  }
  if (queued.job.status === "FAILED" && !provenFailureReplay) {
    return { kind: "TERMINAL_REVIEW", errorCode: "SEND_UNCERTAIN" };
  }
  if (queued.job.status !== "QUEUED" && !provenFailureReplay) {
    return { kind: "TERMINAL_REVIEW", errorCode: "FILE_DELIVERY_NOT_QUEUED" };
  }

  const delivered = await processFileDelivery({
    db: deps.db,
    job: queued.job,
    storageRoots: deps.fileDelivery.storageRoots,
    sender: deps.fileDelivery.sender,
  });
  return classifyFileDeliveryRetryResult(delivered);
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
    resolveSupplier: deps.resolveSupplier,
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
      event.eventType === "PreorderStockAllocated" ||
      event.eventType === "PreorderHoldForfeited" ||
      event.eventType === "PreorderShopCancelled" ||
      event.eventType === "TicketOpened" ||
      event.eventType === "TicketStatusChanged"
    ) {
      return handleNotificationOutboxEvent(deps.db, event);
    }

    if (event.eventType === "FileDeliveryRetryRequested") {
      return handleFileDeliveryRetry(deps, event);
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
        if (delivered.ok) return { kind: "PUBLISHED" };
        if (delivered.code === "ORDER_NOT_PAID" || delivered.code === "SEND_UNCERTAIN") {
          return { kind: "TERMINAL_REVIEW", errorCode: delivered.code };
        }
        return { kind: "RETRY", errorCode: delivered.code };
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
        if (!orderId) {
          // The payload carries no order reference and the aggregate id is the
          // bundle, not the order: no retry can recover it. Park it visibly.
          return classifyFulfillmentOutcome({ ok: false, code: "DELIVERY_HANDOFF_ORDER_MISSING" });
        }
        const result = await fulfillPaidOrder(deps.db, {
          orderId,
          correlationId,
          deps: fulfillmentDeps,
        });
        // Transient outcomes (OUT_OF_STOCK / NEEDS_REVIEW / ISSUE_FAILED) keep
        // retrying; a missing or unpayable order parks as terminal review.
        if (!result.ok) return classifyFulfillmentOutcome(result);
        if (result.kind !== "DELIVERY_BUNDLE" || result.token === "") {
          // Paid order, but this event can never mint a handoff: no bundle came
          // back, or the bundle's reveal token is not recoverable. Retrying
          // reproduces exactly this outcome and burns the attempt budget, so it
          // becomes operator review — the row and its evidence stay inspectable.
          return classifyFulfillmentOutcome({ ok: false, code: "DELIVERY_HANDOFF_NOT_READY" });
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
