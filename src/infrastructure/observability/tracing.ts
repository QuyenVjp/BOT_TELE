import { context, trace, type Span, type Tracer } from "@opentelemetry/api";
import { newId } from "../../shared/ids/index.js";

/**
 * Tracing / correlation helpers.
 *
 * A single `correlationId` threads a Telegram update through order, payment,
 * supplier, delivery, and audit (contracts/application-commands.md). We expose
 * it both as an OpenTelemetry span attribute and as a plain value carried on the
 * command envelope, so correlation survives even where a tracer is not wired.
 *
 * This module intentionally does not start an SDK/exporter — the entrypoints own
 * that. Here we provide the no-op-safe API the domain code calls.
 */

const TRACER_NAME = "telegram-shop-mvp";
export const CORRELATION_ATTRIBUTE = "app.correlation_id";

export function getTracer(): Tracer {
  return trace.getTracer(TRACER_NAME);
}

/** Generate a fresh opaque correlation id (ULID). */
export function newCorrelationId(): string {
  return newId();
}

/**
 * Run `fn` inside a span named `name`, tagging it with the correlation id.
 * The span is ended automatically; errors are recorded and re-thrown so the
 * caller's control flow is unchanged.
 */
export async function withSpan<T>(
  name: string,
  correlationId: string,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  const tracer = getTracer();
  return tracer.startActiveSpan(name, async (span) => {
    span.setAttribute(CORRELATION_ATTRIBUTE, correlationId);
    try {
      return await fn(span);
    } catch (err) {
      span.recordException(err as Error);
      throw err;
    } finally {
      span.end();
    }
  });
}

/** Correlation id of the active span, if any (for log enrichment). */
export function activeCorrelationId(): string | undefined {
  const span = trace.getSpan(context.active());
  if (!span) return undefined;
  const ctx = span.spanContext();
  return ctx.traceId || undefined;
}
