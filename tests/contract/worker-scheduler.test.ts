import { describe, expect, it, vi } from "vitest";
import { createWorkerScheduler, type WorkerSchedulerTimer } from "../../src/worker.js";

const logger = { info: vi.fn(), error: vi.fn() };

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
};

describe("worker scheduler", () => {
  it("runs lanes independently when one lane is slow", async () => {
    const slow = deferred();
    const telegram = vi.fn(async () => undefined);
    const scheduler = createWorkerScheduler({
      lanes: { outbox: () => slow.promise, telegram },
      pollIntervalMs: 1_000,
      recoveryIntervalMs: 2_000,
      logger,
      setInterval: () => ({}) as WorkerSchedulerTimer,
      clearInterval: () => undefined,
    });

    scheduler.start();
    await Promise.resolve();
    expect(telegram).toHaveBeenCalledTimes(1);
    slow.resolve();
    await scheduler.stop();
  });

  it("isolates lane errors and prevents overlapping runs per lane", async () => {
    const release = deferred();
    const failing = vi.fn(async () => {
      await release.promise;
      throw new Error("boom");
    });
    const timers: Array<() => void> = [];
    const scheduler = createWorkerScheduler({
      lanes: { telegram: failing, sepay: vi.fn(async () => undefined) },
      pollIntervalMs: 1,
      recoveryIntervalMs: 2,
      logger,
      setInterval: (run: () => void) => {
        timers.push(run);
        return {} as WorkerSchedulerTimer;
      },
      clearInterval: () => undefined,
    });

    scheduler.start();
    timers[0]?.();
    expect(failing).toHaveBeenCalledTimes(1);
    expect(logger.error).not.toHaveBeenCalled();
    release.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(logger.error).toHaveBeenCalledWith(
      { lane: "telegram", err: "boom" },
      "telegram worker lane failed",
    );
    expect(logger.error).toHaveBeenCalledTimes(1);
    await scheduler.stop();
  });
});
