/** Read-only. Runs the holdings sweep against the live account. Buys nothing. */
process.loadEnvFile?.(".env");
process.env["TELT_LIVE_EXECUTION"] = "false";

import { loadConfig } from "../apps/telt/src/infra/config.js";
import { createRuntime } from "../apps/telt/src/runtime.js";

async function main(): Promise<void> {
  const runtime = createRuntime({ config: loadConfig(process.env) });
  console.log(await runtime.watch(false));
  runtime.close();
}

void main().catch((cause: unknown) => {
  console.error(cause);
  process.exitCode = 1;
});
