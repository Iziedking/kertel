import { describe, expect, it } from "vitest";

import * as fp from "@telt/core/money";
import { instant, ok, refuse } from "@telt/core/domain";
import type { Symbol_ } from "@telt/core/domain";

import { describeHedge, proposeHedge } from "../src/hedge.js";
import type { HedgeDeps } from "../src/hedge.js";
import type { BinanceClient } from "../src/infra/binance.js";
import type {
  FuturesClient,
  FuturesPosition,
} from "../src/infra/futures.js";

const NOW = instant(Date.parse("2026-09-08T12:00:00.000Z"));

function fixture(symbolName: string, options?: { readonly futuresListed?: boolean; readonly available?: string }) {
  const symbol = symbolName as Symbol_;
  const asset = symbolName.slice(0, -4);
  let proposed:
    | {
        readonly symbol: string;
        readonly side: "BUY" | "SELL";
        readonly notional: string;
        readonly leverage: number;
      }
    | null = null;
  let position: FuturesPosition = {
    symbol,
    positionAmt: fp.parse("0.0"),
    entryPrice: fp.parse("0"),
    markPrice: fp.parse("0"),
    liquidationPrice: null,
    unrealisedPnl: fp.parse("0"),
    leverage: 2,
    isolated: true,
    notional: fp.parse("0"),
  };

  const spotRules = {
    symbol,
    baseAsset: asset,
    quoteAsset: "USDT",
    tickSize: fp.parse("0.01"),
    stepSize: fp.parse("0.1"),
    minQuantity: fp.parse("0.1"),
    maxQuantity: fp.parse("10000"),
    minNotional: fp.parse("5"),
    marketMaxQuantity: null,
    notionalAveragePriceMinutes: 5,
  };
  const futuresRules = {
    symbol,
    stepSize: fp.parse("0.1"),
    minQuantity: fp.parse("0.1"),
    maxQuantity: fp.parse("10000"),
    minNotional: fp.parse("20"),
    quantityPrecision: 1,
    tickSize: fp.parse("0.01"),
  };

  const binance: Pick<BinanceClient, "filters" | "market" | "account"> = {
    async filters() {
      return ok(spotRules);
    },
    async market() {
      return ok({
        symbol,
        lastPrice: fp.parse("100"),
        bestBid: fp.parse("99.9"),
        bestAsk: fp.parse("100.1"),
        averagePrice: fp.parse("100"),
        observedAt: NOW,
        source: "fixture",
      });
    },
    async account() {
      return ok({
        accountRef: "fixture",
        canTradeSpot: true,
        observedAt: NOW,
        balances: [
          {
            asset,
            free: fp.parse("0.2"),
            locked: fp.parse("0.1"),
          },
        ],
      });
    },
  };

  const futures = {
    async filters() {
      return options?.futuresListed === false
        ? refuse("SYMBOL_NOT_ALLOWED", `${symbol} is not listed on futures.`)
        : ok(futuresRules);
    },
    async position() {
      return ok(position);
    },
    async markPrice() {
      return ok(fp.parse("100"));
    },
    async balances() {
      return ok([
        {
          asset: "USDT",
          balance: fp.parse(options?.available ?? "25"),
          available: fp.parse(options?.available ?? "25"),
        },
      ]);
    },
    async setIsolated() {
      throw new Error("proposal must not change margin mode");
    },
    async setLeverage() {
      throw new Error("proposal must not change leverage");
    },
    async open() {
      throw new Error("proposal must not open a position");
    },
    async close() {
      throw new Error("proposal must not close a position");
    },
  } as FuturesClient;

  const deps: HedgeDeps = {
    binance,
    futures,
    maxLeverage: 5,
    maxNotional: fp.parse("50"),
    proposeFutures: async (input) => {
      proposed = input;
      return {
        ok: true,
        refusalCode: null,
        body: "Short proposal. To open it, confirm KTL-TEST.",
      };
    },
  };

  return {
    deps,
    proposed: () => proposed,
    setPosition(next: FuturesPosition) {
      position = next;
    },
  };
}

describe("one-symbol Spot hedges", () => {
  it.each(["BTCUSDT", "SOLUSDT", "BNBUSDT"])(
    "builds the same protected path for %s",
    async (symbol) => {
      const context = fixture(symbol);
      const result = await proposeHedge(context.deps, {
        symbol,
        coverageBps: 10_000,
        leverage: 2,
      });

      expect(result.ok).toBe(true);
      expect(context.proposed()).toEqual({
        symbol,
        side: "SELL",
        notional: "30.0",
        leverage: 2,
      });
      expect(result.body).toContain("Requested coverage: 100%");
      expect(result.body).toContain("confirm KTL-TEST");
    },
  );

  it("refuses a Spot-only asset before creating a proposal", async () => {
    const context = fixture("SPOTUSDT", { futuresListed: false });
    const result = await proposeHedge(context.deps, {
      symbol: "SPOTUSDT",
      coverageBps: 10_000,
      leverage: 2,
    });

    expect(result.refusalCode).toBe("SYMBOL_NOT_ALLOWED");
    expect(context.proposed()).toBeNull();
  });

  it("checks available Futures margin before issuing a code", async () => {
    const context = fixture("SOLUSDT", { available: "10" });
    const result = await proposeHedge(context.deps, {
      symbol: "SOLUSDT",
      coverageBps: 10_000,
      leverage: 2,
    });

    expect(result.refusalCode).toBe("INSUFFICIENT_BALANCE");
    expect(result.body).toContain("15.00 USDT");
    expect(context.proposed()).toBeNull();
  });

  it("reports the two account legs as one coverage state", async () => {
    const context = fixture("SOLUSDT");
    context.setPosition({
      symbol: "SOLUSDT" as Symbol_,
      positionAmt: fp.parse("-0.1"),
      entryPrice: fp.parse("100"),
      markPrice: fp.parse("105"),
      liquidationPrice: fp.parse("180"),
      unrealisedPnl: fp.parse("-0.5"),
      leverage: 2,
      isolated: true,
      notional: fp.parse("10.5"),
    });

    const result = await describeHedge(context.deps, "SOLUSDT");

    expect(result.ok).toBe(true);
    expect(result.body).toContain("PARTIALLY HEDGED");
    expect(result.body).toContain("Coverage:      33.33%");
    expect(result.body).toContain("Net exposure:  0.2 SOL");
  });
});
