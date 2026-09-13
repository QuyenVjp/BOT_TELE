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

/** Minimal in-process latency/error metrics; intentionally no exporter or labels with secrets. */
export interface LatencyMetricSnapshot {
  count: number;
  totalMs: number;
  valuesMs: number[];
  errors: number;
}

export interface LatencyMetrics {
  observe(name: string, durationMs: number, error?: boolean): void;
  snapshot(): Record<string, LatencyMetricSnapshot>;
  reset(): void;
}

const MAX_LATENCY_SAMPLES_PER_METRIC = 256;

export function createLatencyMetrics(): LatencyMetrics {
  const metrics = new Map<string, LatencyMetricSnapshot>();
  return {
    observe(name, durationMs, error = false) {
      if (!Number.isFinite(durationMs) || durationMs < 0) return;
      const current = metrics.get(name) ?? { count: 0, totalMs: 0, valuesMs: [], errors: 0 };
      current.count += 1;
      current.totalMs += durationMs;
      if (current.valuesMs.length >= MAX_LATENCY_SAMPLES_PER_METRIC) {
        current.valuesMs.shift();
      }
      current.valuesMs.push(durationMs);
      if (error) current.errors += 1;
      metrics.set(name, current);
    },
    snapshot() {
      return Object.fromEntries(
        [...metrics.entries()].map(([name, value]) => [
          name,
          { ...value, valuesMs: [...value.valuesMs] },
        ]),
      );
    },
    reset() {
      metrics.clear();
    },
  };
}
