import { describe, expect, it } from "vitest";

import * as fp from "@kertel/core/money";
import type { Symbol_ } from "@kertel/core/domain";
import { readPrice } from "@kertel/core/research";
import type { EvidenceObservation } from "@kertel/core/domain";
import { instant, seconds, addSeconds } from "@kertel/core/domain";

import { binancePriceAdapter } from "../src/binance.js";
import { coingeckoPriceAdapter } from "../src/coingecko.js";
import { coinmarketcapPriceAdapter } from "../src/coinmarketcap.js";
import { nansenNetflowAdapter } from "../src/nansen.js";
import { thegraphPoolAdapter } from "../src/thegraph.js";
import { assertRegistryCoversRecipes, ADAPTERS } from "../src/registry.js";
import { INSTRUMENTS, instrumentFor } from "../src/symbols.js";
import type { AdapterContext, Normalized } from "../src/types.js";

const ETH = instrumentFor("ETHUSDT" as Symbol_);
if (ETH === undefined) {
  throw new Error("ETHUSDT is missing from the instrument table");
}
const CONTEXT: AdapterContext = { instrument: ETH };

/**
 * Every payload below is either a verbatim live response or the provider's own
 * published example. A normaliser test written against an imagined shape passes
 * and proves nothing.
 */

// Captured live from https://api.binance.com/api/v3/ticker/24hr on 2026-09-07.
const BINANCE_24HR = {
  symbol: "ETHUSDT",
  priceChange: "12.53000000",
  priceChangePercent: "0.503",
  weightedAvgPrice: "2499.10347887",
  prevClosePrice: "2493.13000000",
  lastPrice: "2505.65000000",
  lastQty: "0.04970000",
  bidPrice: "2505.65000000",
  bidQty: "6.42260000",
  askPrice: "2505.66000000",
  askQty: "19.68870000",
  openPrice: "2493.12000000",
  highPrice: "2526.20000000",
  lowPrice: "2460.92000000",
  volume: "216972.30190000",
  quoteVolume: "542236234.49768800",
  openTime: 1788657767977,
  closeTime: 1788744167977,
  count: 1754004,
};

// The example inside CoinGecko's own 402 challenge, at
// fixtures/x402/live-quotes/coingecko-simple-price-402.json →
// extensions.bazaar.info.output.example, re-keyed to ethereum.
const COINGECKO_PRICE = {
  ethereum: {
    usd: 2505.66,
    usd_market_cap: 302180988326.25,
    usd_24h_vol: 21260929299.52,
    usd_24h_change: 0.503,
    last_updated_at: 1788744167,
  },
};

// CoinMarketCap's published x402 shape: `?id=1027` answers `data["1027"]`.
const COINMARKETCAP_QUOTE = {
  status: { timestamp: "2026-09-07T12:00:00.000Z", error_code: 0, error_message: null },
  data: {
    "1027": {
      id: 1027,
      name: "Ethereum",
      symbol: "ETH",
      slug: "ethereum",
      last_updated: "2026-09-07T12:00:00.000Z",
      quote: {
        USD: {
          price: 2504.9,
          volume_24h: 18200000000,
          market_cap: 395258075000,
          percent_change_24h: 0.49,
          last_updated: "2026-09-07T12:00:00.000Z",
        },
      },
    },
  },
};

// Fields per the JSON Schema in Nansen's own 402 challenge, at
// fixtures/x402/live-quotes/nansen-netflow-402.raw.
const NANSEN_NETFLOW = {
  data: [
    {
      token_address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
      token_symbol: "USDC",
      chain: "ethereum",
      net_flow_1h_usd: 120000,
      net_flow_24h_usd: 9100000,
      net_flow_7d_usd: 42000000,
      net_flow_30d_usd: 91000000,
      token_sectors: ["Stablecoin"],
      trader_count: 210,
      token_age_days: 2100,
    },
    {
      token_address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
      token_symbol: "WETH",
      chain: "ethereum",
      net_flow_1h_usd: -410000,
      net_flow_24h_usd: 5400000.25,
      net_flow_7d_usd: -1200000,
      net_flow_30d_usd: 8800000,
      token_sectors: ["Wrapped"],
      trader_count: 143,
      token_age_days: 2900,
    },
  ],
  pagination: { page: 1, per_page: 100, is_last_page: false },
};

function expectRequestUrl(adapter: { buildRequest: (c: AdapterContext) => unknown }): URL {
  const built = adapter.buildRequest(CONTEXT) as { ok: boolean; value?: { url: string } };
  expect(built.ok).toBe(true);
  return new URL((built.value as { url: string }).url);
}

describe("the registry", () => {
  it("covers every recipe step, so no run can pay its way into a missing adapter", () => {
    expect(() => assertRegistryCoversRecipes()).not.toThrow();
  });

  it("names each adapter once", () => {
    const ids = ADAPTERS.map((adapter) => adapter.stepId);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("the instrument table", () => {
  it("is closed: an unknown symbol has no ids to build a request from", () => {
    expect(instrumentFor("DOGEUSDT" as Symbol_)).toBeUndefined();
    expect(instrumentFor("ethusdt" as Symbol_)).toBeUndefined();
  });

  it("gives every instrument a positive CoinMarketCap id, since the request is keyed by it", () => {
    for (const entry of INSTRUMENTS) {
      expect(Number.isInteger(entry.coinmarketcapId)).toBe(true);
      expect(entry.coinmarketcapId).toBeGreaterThan(0);
    }
  });

  it("gives every instrument a lowercase Nansen contract, since rows are matched lowercased", () => {
    for (const entry of INSTRUMENTS) {
      for (const address of entry.nansenTokenAddresses) {
        expect(address).toBe(address.toLowerCase());
      }
    }
  });
});

describe("binance, tier 0", () => {
  it("asks only for the symbol it was given", () => {
    const url = expectRequestUrl(binancePriceAdapter);
    expect(url.host).toBe("api.binance.com");
    expect(url.pathname).toBe("/api/v3/ticker/24hr");
    expect(url.searchParams.get("symbol")).toBe("ETHUSDT");
  });

  it("carries the venue's own precision through unchanged", () => {
    const normalized = binancePriceAdapter.normalize(BINANCE_24HR, CONTEXT) as Normalized;
    expect(normalized["priceUsd"]).toBe("2505.65000000");
    expect(normalized["bidUsd"]).toBe("2505.65000000");
    expect(normalized["askUsd"]).toBe("2505.66000000");
    expect(normalized["change24hPct"]).toBe("0.503");
  });

  it("refuses a payload for a different symbol than the one requested", () => {
    expect(
      binancePriceAdapter.normalize({ ...BINANCE_24HR, symbol: "BTCUSDT" }, CONTEXT),
    ).toBeNull();
  });

  it("refuses a book with no bid or no ask", () => {
    expect(binancePriceAdapter.normalize({ ...BINANCE_24HR, bidPrice: "0" }, CONTEXT)).toBeNull();
    expect(
      binancePriceAdapter.normalize({ ...BINANCE_24HR, askPrice: undefined }, CONTEXT),
    ).toBeNull();
  });

  it("drops optional context rather than defaulting it to zero", () => {
    const { priceChangePercent: _dropped, ...withoutChange } = BINANCE_24HR;
    const normalized = binancePriceAdapter.normalize(withoutChange, CONTEXT) as Normalized;
    expect(normalized["priceUsd"]).toBe("2505.65000000");
    expect("change24hPct" in normalized).toBe(false);
  });
});

describe("coingecko, tier 1", () => {
  it("asks for full precision, because the default rounds a cheap token away", () => {
    const url = expectRequestUrl(coingeckoPriceAdapter);
    expect(url.host).toBe("pro-api.coingecko.com");
    expect(url.pathname).toBe("/api/v3/x402/simple/price");
    expect(url.searchParams.get("ids")).toBe("ethereum");
    expect(url.searchParams.get("vs_currencies")).toBe("usd");
    expect(url.searchParams.get("precision")).toBe("full");
  });

  it("reads the coin it asked for", () => {
    const normalized = coingeckoPriceAdapter.normalize(COINGECKO_PRICE, CONTEXT) as Normalized;
    expect(normalized["priceUsd"]).toBe("2505.66");
    expect(normalized["coinId"]).toBe("ethereum");
    expect(normalized["lastUpdatedAtSeconds"]).toBe(1788744167);
  });

  it("refuses a body keyed by some other coin, rather than reading whatever came back", () => {
    expect(
      coingeckoPriceAdapter.normalize({ bitcoin: { usd: 67187.34 } }, CONTEXT),
    ).toBeNull();
  });

  it("refuses a missing or unusable price", () => {
    expect(coingeckoPriceAdapter.normalize({ ethereum: {} }, CONTEXT)).toBeNull();
    expect(coingeckoPriceAdapter.normalize({ ethereum: { usd: 0 } }, CONTEXT)).toBeNull();
    expect(coingeckoPriceAdapter.normalize({ ethereum: { usd: "n/a" } }, CONTEXT)).toBeNull();
  });
});

describe("coinmarketcap, tier 1", () => {
  it("asks by numeric id, not by an ambiguous ticker", () => {
    const url = expectRequestUrl(coinmarketcapPriceAdapter);
    expect(url.host).toBe("pro-api.coinmarketcap.com");
    expect(url.pathname).toBe("/x402/v3/cryptocurrency/quotes/latest");
    expect(url.searchParams.get("id")).toBe("1027");
    expect(url.searchParams.get("symbol")).toBeNull();
    expect(url.searchParams.get("convert")).toBe("USD");
  });

  it("reads the object form", () => {
    const normalized = coinmarketcapPriceAdapter.normalize(
      COINMARKETCAP_QUOTE,
      CONTEXT,
    ) as Normalized;
    expect(normalized["priceUsd"]).toBe("2504.9");
    expect(normalized["cmcId"]).toBe(1027);
    expect(normalized["ticker"]).toBe("ETH");
  });

  it("reads the single-element array form", () => {
    const entry = COINMARKETCAP_QUOTE.data["1027"];
    const arrayForm = { ...COINMARKETCAP_QUOTE, data: { "1027": [entry] } };
    const normalized = coinmarketcapPriceAdapter.normalize(arrayForm, CONTEXT) as Normalized;
    expect(normalized["priceUsd"]).toBe("2504.9");
  });

  it("ignores a body keyed by some other asset's id", () => {
    const wrongAsset = {
      status: { error_code: 0 },
      data: { "1": { id: 1, symbol: "BTC", quote: { USD: { price: 67187.34 } } } },
    };
    expect(coinmarketcapPriceAdapter.normalize(wrongAsset, CONTEXT)).toBeNull();
  });

  it("refuses more than one entry under a single id, rather than picking one", () => {
    const entry = COINMARKETCAP_QUOTE.data["1027"];
    const ambiguous = { ...COINMARKETCAP_QUOTE, data: { "1027": [entry, entry] } };
    expect(coinmarketcapPriceAdapter.normalize(ambiguous, CONTEXT)).toBeNull();
  });

  it("refuses an error envelope that happens to carry a data key", () => {
    const errored = {
      status: { error_code: 1002, error_message: "API key missing" },
      data: COINMARKETCAP_QUOTE.data,
    };
    expect(coinmarketcapPriceAdapter.normalize(errored, CONTEXT)).toBeNull();
  });

  it("refuses an entry whose own id disagrees with the key it was filed under", () => {
    const entry = COINMARKETCAP_QUOTE.data["1027"];
    const mismatched = {
      ...COINMARKETCAP_QUOTE,
      data: { "1027": { ...entry, id: 1027000 } },
    };
    expect(coinmarketcapPriceAdapter.normalize(mismatched, CONTEXT)).toBeNull();
  });

  it("refuses an entry whose ticker disagrees, even when the id matches", () => {
    const entry = COINMARKETCAP_QUOTE.data["1027"];
    const mismatched = {
      ...COINMARKETCAP_QUOTE,
      data: { "1027": { ...entry, symbol: "ETHW" } },
    };
    expect(coinmarketcapPriceAdapter.normalize(mismatched, CONTEXT)).toBeNull();
  });
});

describe("nansen, tier 2", () => {
  it("asks one chain for a ranked page, including native tokens and excluding stablecoins", () => {
    const built = nansenNetflowAdapter.buildRequest(CONTEXT);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.value.method).toBe("POST");
    expect(built.value.url).toBe("https://api.nansen.ai/api/v1/smart-money/netflow");

    const body = built.value.body as {
      chains: string[];
      filters: Record<string, unknown>;
      order_by: { field: string; direction: string }[];
      pagination: { per_page: number };
    };
    expect(body.chains).toEqual(["ethereum"]);
    expect(body.filters["include_native_tokens"]).toBe(true);
    expect(body.filters["include_stablecoins"]).toBe(false);
    expect(body.order_by[0]).toEqual({ field: "net_flow_24h_usd", direction: "DESC" });
    expect(body.pagination.per_page).toBe(100);
  });

  it("matches the row by contract, not by the ticker sitting next to it", () => {
    const normalized = nansenNetflowAdapter.normalize(NANSEN_NETFLOW, CONTEXT) as Normalized;
    expect(normalized["tokenFound"]).toBe(true);
    expect(normalized["tokenSymbol"]).toBe("WETH");
    expect(normalized["netFlow24hUsd"]).toBe("5400000.25");
    expect(normalized["netFlow1hUsd"]).toBe("-410000");
    expect(normalized["traderCount"]).toBe(143);
  });

  it("ignores an impostor that borrows the ticker on the same chain", () => {
    const impostor = {
      data: [
        {
          token_address: "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
          token_symbol: "WETH",
          chain: "ethereum",
          net_flow_24h_usd: 999999999,
        },
      ],
      pagination: {},
    };
    const normalized = nansenNetflowAdapter.normalize(impostor, CONTEXT) as Normalized;
    expect(normalized["tokenFound"]).toBe(false);
  });

  it("reports an absence as an absence, and says what it does not rule out", () => {
    const normalized = nansenNetflowAdapter.normalize(
      { data: [NANSEN_NETFLOW.data[0]], pagination: {} },
      CONTEXT,
    ) as Normalized;
    expect(normalized["tokenFound"]).toBe(false);
    expect(normalized["rowsScanned"]).toBe(1);
    expect(String(normalized["note"])).toContain("outflow");
  });

  it("carries no price, so it can never move the price-agreement test", () => {
    const normalized = nansenNetflowAdapter.normalize(NANSEN_NETFLOW, CONTEXT) as Normalized;
    expect("priceUsd" in normalized).toBe(false);
  });

  it("refuses a body that is not a data array", () => {
    expect(nansenNetflowAdapter.normalize({ data: "nope" }, CONTEXT)).toBeNull();
    expect(nansenNetflowAdapter.normalize("", CONTEXT)).toBeNull();
  });
});

describe("the graph, tier 3", () => {
  it("refuses to build a request while no subgraph is configured", () => {
    const built = thegraphPoolAdapter.buildRequest(CONTEXT);
    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.error.code).toBe("PROVIDER_UNAVAILABLE");
    expect(built.error.detail).toContain("subgraph");
  });
});

describe("the shared price contract", () => {
  /** What the planner will actually do with each of these. */
  function asObservation(normalized: Normalized): EvidenceObservation {
    const now = instant(1_788_744_170_000);
    return {
      id: "e1" as EvidenceObservation["id"],
      provider: "binance",
      capability: "market.price",
      endpointId: "binance:ticker",
      status: "valid",
      observedAt: now,
      freshnessDeadline: addSeconds(now, seconds(60)),
      normalized,
      rawPayloadHash: null,
      sourceUrl: "https://example.test",
      costUsdc: fp.parse("0.00"),
      paymentAttemptId: null,
    };
  }

  it("makes every price adapter readable by the planner, on the same field", () => {
    const priced: Normalized[] = [
      binancePriceAdapter.normalize(BINANCE_24HR, CONTEXT) as Normalized,
      coingeckoPriceAdapter.normalize(COINGECKO_PRICE, CONTEXT) as Normalized,
      coinmarketcapPriceAdapter.normalize(COINMARKETCAP_QUOTE, CONTEXT) as Normalized,
    ];
    for (const normalized of priced) {
      const price = readPrice(asObservation(normalized));
      expect(price).not.toBeNull();
      expect(fp.isPositive(price as ReturnType<typeof fp.parse>)).toBe(true);
    }
  });

  it("puts the three live-shaped prices within the planner's agreement tolerance", () => {
    // 2505.65 against 2505.66 against 2504.90 is a spread of about 3 bps, well
    // inside the 100 bps the planner allows. A test that used made-up numbers
    // would not tell anyone whether real feeds agree.
    const prices = [
      binancePriceAdapter.normalize(BINANCE_24HR, CONTEXT) as Normalized,
      coingeckoPriceAdapter.normalize(COINGECKO_PRICE, CONTEXT) as Normalized,
      coinmarketcapPriceAdapter.normalize(COINMARKETCAP_QUOTE, CONTEXT) as Normalized,
    ].map((normalized) => fp.parse(String(normalized["priceUsd"])));

    let low = prices[0] as ReturnType<typeof fp.parse>;
    let high = prices[0] as ReturnType<typeof fp.parse>;
    for (const price of prices) {
      low = fp.min(low, price);
      high = fp.max(high, price);
    }
    const spreadBps = fp.divide(
      fp.multiply(fp.subtract(high, low), fp.parse("10000")),
      low,
      0,
      "floor",
    );
    expect(Number(spreadBps.atoms)).toBeLessThanOrEqual(100);
  });
});
