/**
 * A read-only check of the futures path against the live exchange.
 *
 * The write gate is forced off before the config is read, so this script can
 * reach the real Binance account, read the real filters, the real position and
 * the real mark price, and render a real proposal — without any order leaving
 * the machine. A proposal stops at a confirmation code by design, and this
 * script never types one.
 *
 * It exists because the one bug that fixtures could not catch was in a value
 * only the exchange knows: `positionInformationV2` reports a mark price of
 * zero while the position is flat, which is exactly the state a first entry is
 * sized from.
 *
 *   npm run probe:futures
 */

process.loadEnvFile?.(".env");
// Before loadConfig reads it. Everything below is a read.
process.env["KERTEL_MODE"] = "fixture";
process.env["KERTEL_LIVE_EXECUTION"] = "false";

import * as fp from "@kertel/core/money";
import { loadConfig } from "../apps/kertel-plugin/src/infra/config.js";
import { createRuntime } from "../apps/kertel-plugin/src/runtime.js";

async function main(): Promise<void> {
  const runtime = createRuntime({ config: loadConfig(process.env) });

  console.log(`execution rail: ${runtime.executionRail} | futures client: ${runtime.futures !== null}`);
  if (runtime.futures === null) {
    console.log("\nNo futures client. Futures runs through Agent OS only; set KERTEL_BINANCE_MCP_TOKEN.");
    return;
  }

  console.log("\n--- positions ---");
  console.log(await runtime.describeFutures(["ETHUSDT"]));

  console.log("\n--- mark price, read independently of the position ---");
  const mark = await runtime.futures.markPrice("ETHUSDT" as never);
  console.log(mark.ok ? `ETHUSDT mark ${fp.format(mark.value)}` : `refused: ${mark.error.detail}`);

  console.log("\n--- propose 30 USDT long at 3x (live prices, no order) ---");
  const proposal = await runtime.proposeFutures({
    symbol: "ETHUSDT",
    side: "BUY",
    notional: "30",
    leverage: 3,
  });
  console.log(proposal.body);

  console.log("\n--- refuse 20x ---");
  const refused = await runtime.proposeFutures({
    symbol: "ETHUSDT",
    side: "BUY",
    notional: "30",
    leverage: 20,
  });
  console.log(refused.body);

  console.log("\nNo order was sent. Any code above expires unused.");
}

void main().catch((cause: unknown) => {
  console.error(cause);
  process.exitCode = 1;
});
