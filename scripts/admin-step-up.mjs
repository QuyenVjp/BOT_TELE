import { main } from "../dist/operations/admin-step-up.js";

try {
  await main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : "operator MFA failed"}\n`);
  process.exitCode = 1;
}
