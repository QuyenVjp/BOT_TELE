import { newId } from "../ids/index.js";
import { nowUtc } from "../time/index.js";
import { errorEnvelope, isAppError, type ErrorEnvelope } from "../errors/index.js";

// Re-export the event envelope so ingress code can build commands and events
// from a single application-contract entrypoint.
export { makeEventEnvelope, EVENT_TYPES } from "../events/index.js";
export type { EventEnvelope, EventType } from "../events/index.js";

/**
 * Application command envelope + dispatcher
 * (contracts/application-commands.md "Envelope").
 *
 * Every command carries commandId, idempotencyKey, actor, correlationId,
 * occurredAt, and a typed payload validated at the ingress boundary. The
 * dispatcher routes by command type and returns either a typed success or ONE
 * stable error envelope — never a stack trace, secret, or raw provider body.
 */

export type ActorType = "customer" | "root_admin" | "system" | "provider" | "worker";

export interface Actor {
  type: ActorType;
  id: string;
}

export interface CommandEnvelope<TPayload = Record<string, unknown>> {
  commandId: string;
  type: string;
  idempotencyKey: string;
  actor: Actor;
  correlationId: string;
  occurredAt: string;
  payload: TPayload;
}

export interface MakeCommandOptions {
  actor: Actor;
  /** Stable per logical mutation; defaults to a fresh id (safe for reads). */
  idempotencyKey?: string;
  correlationId?: string;
  commandId?: string;
  occurredAt?: string;
}

export function makeCommandEnvelope<TPayload>(
  type: string,
  payload: TPayload,
  options: MakeCommandOptions,
): CommandEnvelope<TPayload> {
  const commandId = options.commandId ?? newId();
  return {
    commandId,
    type,
    idempotencyKey: options.idempotencyKey ?? commandId,
    actor: options.actor,
    correlationId: options.correlationId ?? newId(),
    occurredAt: options.occurredAt ?? nowUtc().toISOString(),
    payload,
  };
}

/** A command handler returns any typed success value. */
export type CommandHandler = (env: CommandEnvelope) => Promise<unknown>;

/** The dispatcher result is either the handler's success or a stable error. */
export interface CommandErrorResult {
  error: ErrorEnvelope & { correlationId: string };
}

export type Dispatch = (env: CommandEnvelope) => Promise<unknown | CommandErrorResult>;

/**
 * Build a dispatcher from a type→handler registry. Unknown command types and
 * handler throws both collapse into the stable error envelope, stamped with the
 * command's correlationId so the caller can surface a safe reference.
 */
export function createDispatcher(handlers: Record<string, CommandHandler>): Dispatch {
  return async function dispatch(env: CommandEnvelope): Promise<unknown | CommandErrorResult> {
    const handler = handlers[env.type];
    if (!handler) {
      return {
        error: {
          code: "VALIDATION",
          message: "Unknown command",
          correlationId: env.correlationId,
        },
      };
    }
    try {
      return await handler(env);
    } catch (err) {
      // AppError keeps its stable code; anything else collapses to INTERNAL.
      const base = isAppError(err)
        ? errorEnvelope(err)
        : { code: "INTERNAL" as const, message: "An internal error occurred" };
      return { error: { ...base, correlationId: env.correlationId } };
    }
  };
}
