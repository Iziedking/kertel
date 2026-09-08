/** What happens on a token nobody mapped. Spends nothing: the paid tiers refuse by name. */
process.loadEnvFile?.(".env");
process.env["TELT_LIVE_EXECUTION"] = "false";

import { loadConfig } from "../apps/telt/src/infra/config.js";
import { createRuntime } from "../apps/telt/src/runtime.js";

async function main(): Promise<void> {
  const runtime = createRuntime({ config: loadConfig(process.env) });
  const symbol = process.argv[2] ?? "SOLVUSDT";

  console.log("--- price, free venue tier ---");
  const market = await runtime.binance.market(symbol as never);
  console.log(market.ok ? `${symbol} bid ${market.value.bestBid.atoms}e-${String(market.value.bestBid.scale)}` : market.error.detail);

  console.log(`\n--- research ${symbol} ---`);
  const research = await runtime.research({ symbol, goal: "price_check" });
  console.log(research.body);

  runtime.close();
}

void main().catch((cause: unknown) => { console.error(cause); process.exitCode = 1; });
