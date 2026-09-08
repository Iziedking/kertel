/** Free, read-only. What is moving right now, through the live rail. */
process.loadEnvFile?.(".env");
process.env["TELT_LIVE_EXECUTION"] = "false";

import { loadConfig } from "../apps/telt/src/infra/config.js";
import { createRuntime } from "../apps/telt/src/runtime.js";

async function main(): Promise<void> {
  const runtime = createRuntime({ config: loadConfig(process.env) });
  const started = Date.now();
  const body = await runtime.scan("5000000", 6);
  console.log(body);
  console.log("\ntook " + String(Date.now() - started) + " ms");
  runtime.close();
}

void main().catch((cause: unknown) => {
  console.error(cause);
  process.exitCode = 1;
});
