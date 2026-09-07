/**
 * The saved provider answers fixture mode runs on.
 *
 * Without these, fixture mode can read the free venue price and nothing else —
 * every paid step refuses with "no saved answer", which makes the default mode
 * of the product a demo of its own refusal path. Loading the real captured 402
 * challenges makes fixture mode exercise the whole ladder: pins, rails,
 * decimals, budget, receipts, with no wallet and no network.
 *
 * The challenges are the real ones, captured free from the live providers. The
 * success bodies are the providers' own published examples, so a fixture run
 * produces a receipt shaped exactly like a live one.
 *
 * If the files are missing — someone copied the plugin directory out of the
 * repository — fixture mode degrades to the free venue price and says so,
 * rather than failing at boot. A missing demo fixture is not a reason to take
 * an operator's gateway down.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { FixtureExchange } from "@kertel/x402";

/** Repository root, relative to this module once compiled into `dist/infra`. */
function fixturePath(name: string): string {
  return fileURLToPath(new URL(`../../../../fixtures/x402/live-quotes/${name}`, import.meta.url));
}

const COINGECKO_BODY = JSON.stringify({
  ethereum: { usd: 2505.66, usd_24h_change: 0.503, last_updated_at: 1788744167 },
  bitcoin: { usd: 67187.34, usd_24h_change: 1.2, last_updated_at: 1788744167 },
});

const COINMARKETCAP_BODY = JSON.stringify({
  status: { error_code: 0, error_message: null },
  data: {
    "1027": { id: 1027, symbol: "ETH", quote: { USD: { price: 2504.9 } } },
    "1": { id: 1, symbol: "BTC", quote: { USD: { price: 67180.11 } } },
  },
});

const NANSEN_BODY = JSON.stringify({
  data: [
    {
      token_address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
      token_symbol: "WETH",
      chain: "ethereum",
      net_flow_1h_usd: -410000,
      net_flow_24h_usd: 5400000.25,
      net_flow_7d_usd: -1200000,
      trader_count: 143,
    },
    {
      token_address: "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599",
      token_symbol: "WBTC",
      chain: "ethereum",
      net_flow_1h_usd: 88000,
      net_flow_24h_usd: 2100000,
      net_flow_7d_usd: 9400000,
      trader_count: 61,
    },
  ],
  pagination: { page: 1, per_page: 100, is_last_page: false },
});

/**
 * Loads the saved exchanges, or returns an empty set with the reason.
 *
 * Returning the reason rather than throwing keeps the failure legible in
 * `kertel_status` instead of turning into a stack trace at gateway start.
 */
export function loadFixtureExchanges(): {
  readonly exchanges: Record<string, FixtureExchange>;
  readonly problem: string | null;
} {
  const wanted: readonly { endpointId: string; file: string; body: string }[] = [
    {
      endpointId: "coingecko:simple/price",
      file: "coingecko-simple-price-402.json",
      body: COINGECKO_BODY,
    },
    {
      endpointId: "coinmarketcap:quotes/latest",
      file: "coinmarketcap-quotes-latest.json",
      body: COINMARKETCAP_BODY,
    },
    {
      endpointId: "nansen:smart-money/netflow",
      file: "nansen-smart-money-netflow.json",
      body: NANSEN_BODY,
    },
  ];

  const exchanges: Record<string, FixtureExchange> = {};
  try {
    for (const entry of wanted) {
      exchanges[entry.endpointId] = {
        probe: { status: 402, bodyText: readFileSync(fixturePath(entry.file), "utf8") },
        paid: { status: 200, bodyText: entry.body },
      };
    }
    return { exchanges, problem: null };
  } catch (cause) {
    return {
      exchanges: {},
      problem: `Saved provider fixtures could not be read (${cause instanceof Error ? cause.message : "unknown"}), so fixture mode can only read the free venue price.`,
    };
  }
}
