/**
 * The full proof-of-research loop, end to end.
 *
 * Runs a real price check, takes the signed attestation off the bottom of the
 * receipt, and verifies it as a stranger would — from the text alone.
 */
process.loadEnvFile?.(".env");
process.env["TELT_LIVE_EXECUTION"] = "false";

import { loadConfig } from "../apps/telt/src/infra/config.js";
import { createRuntime } from "../apps/telt/src/runtime.js";

async function main(): Promise<void> {
  const runtime = createRuntime({ config: loadConfig(process.env) });
  const symbol = process.argv[2] ?? "ETHUSDT";

  const research = await runtime.research({ symbol, goal: "price_check" });
  console.log(research.body);

  const start = research.body.indexOf("TELT-ATTESTATION-1");
  if (start === -1) {
    console.log("\n!! no attestation was emitted");
    runtime.close();
    return;
  }

  console.log("\n================ verifying, as a stranger would ================\n");
  console.log(await runtime.verify(research.body.slice(start)));

  console.log("\n================ and a tampered copy ================\n");
  const tampered = research.body.slice(start).replace("EVIDENCE_ONLY", "BUY_CANDIDATE");
  console.log(await runtime.verify(tampered));

  runtime.close();
}

void main().catch((cause: unknown) => { console.error(cause); process.exitCode = 1; });
