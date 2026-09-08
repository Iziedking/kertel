/**
 * Times each read on the spot propose path, against the live exchange.
 *
 * `propose` prices an order and issues a confirmation code; it sends nothing.
 * This exists because a MARKET_DATA_STALE refusal names an age but not which
 * read was slow, and on the Agent OS rail every read is a network hop.
 *
 *   npm run probe:spot
 */

process.loadEnvFile?.(".env");
process.env["TELT_LIVE_EXECUTION"] = "false";

import * as fp from "@telt/core/money";
import { loadConfig } from "../apps/telt/src/infra/config.js";
import { createRuntime } from "../apps/telt/src/runtime.js";

async function timed<T>(label: string, run: () => Promise<T>): Promise<T> {
  const started = Date.now();
  const value = await run();
  console.log(`  ${label.padEnd(22)} ${String(Date.now() - started).padStart(6)} ms`);
  return value;
}

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const runtime = createRuntime({ config });
  console.log(`mode: ${config.mode} | rail: ${runtime.executionRail}`);
  console.log(`marketDataMaxAge: ${String(config.policy.trading.marketDataMaxAge)}s\n`);

  const symbol = "ETHUSDT" as never;

  console.log("individual reads:");
  const filters = await timed("filters", () => runtime.binance.filters(symbol));
  const market = await timed("market (ticker+avg)", () => runtime.binance.market(symbol));
  const account = await timed("account", () => runtime.binance.account());

  if (market.ok) {
    const age = (Date.now() - market.value.observedAt) / 1000;
    console.log(`\n  observedAt is ${age.toFixed(2)}s old right now`);
    console.log(`  bid ${fp.format(market.value.bestBid)} / ask ${fp.format(market.value.bestAsk)}`);
    console.log(`  avgPrice ${market.value.averagePrice === null ? "MISSING" : fp.format(market.value.averagePrice)}`);
  } else {
    console.log(`\n  market refused: ${market.error.code} ${market.error.detail}`);
  }
  if (!filters.ok) console.log(`  filters refused: ${filters.error.code} ${filters.error.detail}`);
  if (!account.ok) console.log(`  account refused: ${account.error.code} ${account.error.detail}`);

  console.log("\nfull propose (no order is sent):");
  const started = Date.now();
  const result = await runtime.propose({ symbol: "ETHUSDT", side: "BUY", notional: "6" });
  console.log(`  took ${String(Date.now() - started)} ms\n`);
  console.log(result.body);

  runtime.close();
}

void main().catch((cause: unknown) => {
  console.error(cause);
  process.exitCode = 1;
});
