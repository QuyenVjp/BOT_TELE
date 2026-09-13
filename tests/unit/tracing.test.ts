import { describe, expect, it } from "vitest";
import { createLatencyMetrics } from "../../src/infrastructure/observability/tracing.js";

describe("latency metrics", () => {
  it("retains only the latest bounded sample window per metric", () => {
    const metrics = createLatencyMetrics();

    for (let durationMs = 0; durationMs < 266; durationMs += 1) {
      metrics.observe("worker.lane.recovery.duration_ms", durationMs, durationMs === 265);
    }

    const snapshot = metrics.snapshot()["worker.lane.recovery.duration_ms"]!;
    expect(snapshot.count).toBe(266);
    expect(snapshot.totalMs).toBe((265 * 266) / 2);
    expect(snapshot.errors).toBe(1);
    expect(snapshot.valuesMs).toHaveLength(256);
    expect(snapshot.valuesMs[0]).toBe(10);
    expect(snapshot.valuesMs.at(-1)).toBe(265);
  });
});
