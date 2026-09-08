/** Deterministic public rehearsal. No process environment, network, or funded key is used. */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { fixedClock, instant } from "@telt/core/domain";
import type { FixtureExchange } from "@telt/x402";
import { loadConfig } from "../apps/telt/src/infra/config.js";
import { createLogger } from "../apps/telt/src/infra/logger.js";
import { openStore } from "../apps/telt/src/infra/store.js";
import type { Store } from "../apps/telt/src/infra/store.js";
import { createRuntime } from "../apps/telt/src/runtime.js";
const NOW = instant(Date.parse("2026-09-07T12:00:00.000Z"));
const KEY = `0x${"a".repeat(64)}`;
const OWNER = "+12025550123";

function challenge(name: string): string {
  return readFileSync(
    fileURLToPath(
      new URL(`../fixtures/x402/live-quotes/${name}`, import.meta.url),
    ),
    "utf8",
  );
}

const BINANCE_BODY = JSON.stringify({
  symbol: "ETHUSDT",
  priceChangePercent: "0.503",
  lastPrice: "2505.65000000",
  bidPrice: "2505.65000000",
  askPrice: "2505.66000000",
  closeTime: 1788744167977,
});

function exchanges(
  overrides: Record<string, FixtureExchange> = {},
): Record<string, FixtureExchange> {
  return {
    "coingecko:simple/price": {
      probe: {
        status: 402,
        bodyText: challenge("coingecko-simple-price-402.json"),
      },
      paid: {
        status: 200,
        bodyText: JSON.stringify({ ethereum: { usd: 2505.66 } }),
      },
    },
    "nansen:smart-money/netflow": {
      probe: {
        status: 402,
        bodyText: challenge("nansen-smart-money-netflow.json"),
      },
      paid: {
        status: 200,
        bodyText: JSON.stringify({
          data: [
            {
              token_address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
              token_symbol: "WETH",
              chain: "ethereum",
              net_flow_24h_usd: 5400000.25,
              trader_count: 143,
            },
          ],
          pagination: {},
        }),
      },
    },
    ...overrides,
  };
}

const venueFetch = (async (url: string | URL) => {
  if (!String(url).startsWith("https://api.binance.com/")) {
    throw new Error(`unexpected url ${String(url)}`);
  }
  return new Response(BINANCE_BODY, { status: 200 });
}) as unknown as typeof globalThis.fetch;

function build(
  options: { store?: Store; exchanges?: Record<string, FixtureExchange> } = {},
) {
  let sequence = 0;
  const store = options.store ?? openStore(":memory:");
  const runtime = createRuntime({
    config: loadConfig({
      TELT_OWNER_WHATSAPP: OWNER,
      TELT_X402_PRIVATE_KEY: KEY,
    }),
    clock: fixedClock(NOW),
    newId: (prefix) => `${prefix}-fixture-${++sequence}`,
    store,
    log: createLogger({ level: "silent" }),
    exchanges: options.exchanges ?? exchanges(),
    fetchImpl: venueFetch,
  });
  return { runtime, store };
}
const results = [];
for (const goal of ["price_check", "trade_thesis"] as const) {
  const { runtime } = build();
  try {
    const research = await runtime.research({ symbol: "ETHUSDT", goal });
    if (!research.ok || !research.researchRunId) throw new Error(research.body);
    const run = runtime.store.research.find(research.researchRunId)!;
    const decision = runtime.decide({
      researchRunId: run.id,
      recommendation: "NO_TRADE",
      summary:
        "These recorded observations provide context, but contain no tested entry rule that justifies a trade.",
      supportingEvidence: run.evidenceIds,
      invalidatedBy: [
        "Fresh evidence plus an explicit entry rule would require a new decision.",
      ],
      modelId: "scripted-demo-not-an-LLM",
    });
    if (!decision.ok) throw new Error(decision.body);
    results.push({
      goal,
      mode: "fixture",
      spent: research.spent,
      research: research.body,
      decision: decision.body,
    });
  } finally {
    runtime.close();
  }
}
const path = new URL("../web/lib/demo.json", import.meta.url);
mkdirSync(new URL("../web/lib/", import.meta.url), { recursive: true });
writeFileSync(
  path,
  JSON.stringify(
    {
      generatedBy: "npm run prove",
      fixtureTime: "2026-09-07T12:00:00Z",
      results,
    },
    null,
    2,
  ) + "\n",
);
console.log(
  "Generated 2 fixture research runs and their stored NO_TRADE decisions. No live calls.",
);
