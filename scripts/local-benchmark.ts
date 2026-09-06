import { performance } from "node:perf_hooks";
import { presentPayment } from "../src/modules/payments/vietqr.js";
import { presentPaymentScreen } from "../src/bot/presenters/payment.js";
import { createWorkerScheduler } from "../src/worker.js";

const ITERATIONS = Number(process.env.BENCHMARK_ITERATIONS ?? 100);
function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[
    Math.max(0, Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1))
  ]!;
}
function report(name: string, values: number[]): void {
  console.log(
    `${name}: n=${values.length} p50=${percentile(values, 50).toFixed(3)}ms p95=${percentile(values, 95).toFixed(3)}ms p99=${percentile(values, 99).toFixed(3)}ms`,
  );
}
const qr: number[] = [];
for (let i = 0; i < ITERATIONS; i += 1) {
  const started = performance.now();
  const presentation = presentPayment({
    bankBin: "970422",
    bankAlias: "MB",
    accountNumber: "0000000000",
    accountName: "SHOP DIGITAL",
    amountVnd: 150000,
    transferContent: `BENCH${i}`,
    orderNumber: `BENCH-${i}`,
    expiresAt: new Date("2030-01-01T00:00:00.000Z"),
  });
  await presentPaymentScreen(presentation);
  qr.push(performance.now() - started);
}
const scheduler: number[] = [];
for (let i = 0; i < ITERATIONS; i += 1) {
  const started = performance.now();
  const worker = createWorkerScheduler({
    lanes: { benchmark: async () => undefined },
    pollIntervalMs: 60_000,
    recoveryIntervalMs: 60_000,
    logger: { info: () => undefined, error: () => undefined },
    setInterval: () => ({}) as NodeJS.Timeout,
    clearInterval: () => undefined,
  });
  worker.start();
  scheduler.push(performance.now() - started);
  await worker.stop();
}
console.log(
  `Local benchmark (iterations=${ITERATIONS}; no PostgreSQL, Telegram, SePay, or supplier services)`,
);
report("local QR payload + PNG presentation", qr);
report("worker scheduler lane dispatch", scheduler);
console.log("Local CPU/runtime seams only; results are not DB, network, or end-to-end SLOs.");
