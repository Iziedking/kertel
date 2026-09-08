/**
 * Futures positions managed by the monitor, not by hand.
 *
 * The spot path already proves the mandate engine: ladders trim, trailing stops
 * ratchet, breakeven protects. These tests prove the part that is genuinely
 * different — that the same engine reaches a *futures* position, reads it from
 * the position record rather than a balance, measures against the mark rather
 * than a bid, and exits reduce-only.
 *
 * They also pin the thing that was silently missing before: a leveraged
 * position with no exit plan is the single most important thing a holdings
 * sweep can report, because it is the only kind the exchange can close for you.
 */

import { describe, expect, it } from "vitest";

import * as fp from "@telt/core/money";
import { fixedClock, instant, ok } from "@telt/core/domain";
import type { Symbol_ } from "@telt/core/domain";

import type { BinanceClient } from "../src/infra/binance.js";
import type { FuturesClient, FuturesPosition } from "../src/infra/futures.js";
import { loadConfig } from "../src/infra/config.js";
import { createLogger } from "../src/infra/logger.js";
import { openStore } from "../src/infra/store.js";
import { createRuntime } from "../src/runtime.js";

const NOW = instant(Date.parse("2026-09-07T12:00:00.000Z"));
const OWNER = "+2348067053854";
const KEY = "0x" + "a".repeat(64);
const ETHUSDT = "ETHUSDT" as Symbol_;

/** The real ETHUSDT futures filters, read live on 2026-09-07. */
const FUTURES_FILTERS = {
  symbol: ETHUSDT,
  stepSize: fp.parse("0.001"),
  minQuantity: fp.parse("0.001"),
  maxQuantity: fp.parse("10000"),
  minNotional: fp.parse("20"),
  quantityPrecision: 3,
  tickSize: fp.parse("0.01"),
};

function position(overrides: Partial<FuturesPosition> = {}): FuturesPosition {
  return {
    symbol: ETHUSDT,
    positionAmt: fp.parse("0.020"),
    entryPrice: fp.parse("2500.00"),
    markPrice: fp.parse("2500.00"),
    liquidationPrice: fp.parse("1700.00"),
    unrealisedPnl: fp.parse("0"),
    leverage: 3,
    isolated: true,
    notional: fp.parse("50.00"),
    ...overrides,
  };
}

/** A futures client holding one position, whose mark the test moves. */
function fakeFutures(start: FuturesPosition = position()) {
  const closes: { quantity: string }[] = [];
  let current = start;

  const client = {
    async filters() {
      return ok(FUTURES_FILTERS);
    },
    async position(symbol: Symbol_) {
      // Per symbol, because the sweep checks a watchlist and a fake that
      // answers the same position for every symbol invents positions.
      return ok(
        symbol === ETHUSDT
          ? current
          : position({ symbol, positionAmt: fp.parse("0"), liquidationPrice: null }),
      );
    },
    async markPrice() {
      return ok(current.markPrice);
    },
    async balances() {
      return ok([{ asset: "USDT", balance: fp.parse("15.00"), available: fp.parse("6.75") }]);
    },
    async setIsolated() {
      return ok(true as const);
    },
    async setLeverage() {
      return ok(true as const);
    },
    async open() {
      throw new Error("the monitor must never open a position");
    },
    async close(input: { quantity: ReturnType<typeof fp.parse> }) {
      closes.push({ quantity: fp.format(input.quantity) });
      const left = fp.subtract(current.positionAmt, input.quantity);
      current = { ...current, positionAmt: left, notional: fp.multiply(left, current.markPrice) };
      return ok({
        orderRef: "f-" + String(closes.length),
        clientOrderId: "telt-fut-close",
        status: "FILLED",
        filledQuantity: input.quantity,
        averagePrice: current.markPrice,
      });
    },
  };

  return {
    client: client as unknown as FuturesClient,
    closes,
    moveTo(price: string) {
      current = { ...current, markPrice: fp.parse(price) };
    },
    position: () => current,
  };
}

/**
 * Spot, present but holding no ETH.
 *
 * `placeMarketOrder` throws on purpose: if the venue split were wrong, a
 * futures mandate reaching for a spot order would fail loudly here rather than
 * quietly selling something else.
 */
function emptySpot(): BinanceClient {
  return {
    credentialed: true,
    async filters() {
      return ok({
        symbol: ETHUSDT,
        baseAsset: "ETH",
        quoteAsset: "USDT",
        tickSize: fp.parse("0.01"),
        stepSize: fp.parse("0.0001"),
        minQuantity: fp.parse("0.0001"),
        maxQuantity: fp.parse("9000"),
        minNotional: fp.parse("5.00"),
        marketMaxQuantity: null,
        notionalAveragePriceMinutes: 5,
      });
    },
    async market() {
      return ok({
        symbol: ETHUSDT,
        lastPrice: fp.parse("2500.00"),
        bestBid: fp.parse("2500.00"),
        bestAsk: fp.parse("2500.00"),
        averagePrice: fp.parse("2500.00"),
        observedAt: NOW,
        source: "test",
      });
    },
    async account() {
      return ok({
        accountRef: "test",
        canTradeSpot: true,
        observedAt: NOW,
        balances: [{ asset: "USDT", free: fp.parse("15.00"), locked: fp.parse("0") }],
      });
    },
    async placeMarketOrder() {
      throw new Error("a futures mandate must never place a spot order");
    },
    async findOrder() {
      return ok(null);
    },
  } as unknown as BinanceClient;
}

function build(futures: FuturesClient) {
  const clock = fixedClock(NOW);
  const store = openStore(":memory:");
  const runtime = createRuntime({
    config: loadConfig({
      TELT_OWNER_WHATSAPP: OWNER,
      TELT_X402_PRIVATE_KEY: KEY,
      TELT_BINANCE_API_KEY: "k",
      TELT_BINANCE_API_SECRET: "s",
      TELT_MODE: "live",
      TELT_LIVE_EXECUTION: "true",
    }),
    clock,
    store,
    log: createLogger({ level: "silent" }),
    binance: emptySpot(),
    futures,
    random: (count: number) => new Uint8Array(count).fill(7),
    newId: (prefix: string) => prefix + "-test",
  });
  return { runtime, store, clock };
}

function codeFrom(body: string): string {
  const match = /KTL-[A-Z0-9]+/.exec(body);
  if (match === null) throw new Error("no code in:\n" + body);
  return match[0];
}

const LADDER_PLAN = {
  symbol: "ETHUSDT",
  ladder: [{ atBps: 3000, fractionBps: 5000 }],
  stopLossBps: 1000,
  trailing: null,
  breakevenAtBps: null,
  quantity: null,
  entryPrice: null,
  holdDays: 7,
};

describe("planning an exit for a futures position", () => {
  it("finds the position without being told which venue it is on", async () => {
    const fake = fakeFutures();
    const { runtime } = build(fake.client);

    const plan = await runtime.planExit(LADDER_PLAN);

    expect(plan.ok).toBe(true);
    // Spot holds no ETH at all, so a plan that found 0.010 found the futures
    // position — and took the exchange's own entry price with it.
    expect(plan.body).toContain("0.020");
    expect(plan.body).toContain("2500");
    runtime.close();
  });
});

describe("the monitor managing a futures position", () => {
  it("trims a leveraged winner reduce-only, without being asked", async () => {
    const fake = fakeFutures();
    const { runtime } = build(fake.client);

    const plan = await runtime.planExit(LADDER_PLAN);
    const armed = await runtime.armPlan(codeFrom(plan.body));
    expect(armed.ok).toBe(true);

    // Nothing has moved: the loop must look and do nothing.
    const quiet = await runtime.checkPositions();
    expect(quiet.fired).toBe(0);
    expect(fake.closes).toHaveLength(0);

    // +30%. The rung is reached, and nobody typed anything.
    fake.moveTo("3250.00");
    const acted = await runtime.checkPositions();

    expect(acted.fired).toBe(1);
    expect(fake.closes).toHaveLength(1);
    // Half of 0.020, floored to the 0.001 futures step.
    expect(fake.closes[0]?.quantity).toBe("0.010");
    // And the position shrank rather than being flipped onto the other side.
    expect(fp.format(fake.position().positionAmt)).toBe("0.010");
    runtime.close();
  });

  it("closes on a stop without reaching for a spot order", async () => {
    const fake = fakeFutures();
    const { runtime } = build(fake.client);

    const plan = await runtime.planExit({
      ...LADDER_PLAN,
      ladder: [],
      stopLossBps: 500,
    });
    await runtime.armPlan(codeFrom(plan.body));

    fake.moveTo("2300.00"); // straight through the stop
    const acted = await runtime.checkPositions();

    expect(acted.fired).toBe(1);
    expect(fake.closes).toHaveLength(1);
    runtime.close();
  });
});

describe("the holdings sweep", () => {
  it("shows a futures position and flags one with no exit plan", async () => {
    const fake = fakeFutures();
    const { runtime } = build(fake.client);

    const body = await runtime.watch(false);

    expect(body).toContain("Futures");
    expect(body).toContain("ETHUSDT futures LONG");
    expect(body).toContain("NO EXIT PLAN");
    // The number that matters on leverage: how far the exchange's own exit is.
    // Mark 2500 against a 1700 liquidation is 32% of room.
    expect(body).toContain("32.0% away");
    runtime.close();
  });

  it("stops flagging it once a plan is armed", async () => {
    const fake = fakeFutures();
    const { runtime } = build(fake.client);

    const plan = await runtime.planExit(LADDER_PLAN);
    await runtime.armPlan(codeFrom(plan.body));

    const body = await runtime.watch(false);
    expect(body).toContain("— managed");
    expect(body).not.toContain("NO EXIT PLAN");
    runtime.close();
  });

  it("flags a cross-margin position, whoever opened it", async () => {
    // Telt always opens isolated, so cross means the position came from
    // somewhere else or was changed afterwards. Either way the whole futures
    // wallet is backing it, and that is worth saying out loud.
    const fake = fakeFutures(position({ isolated: false }));
    const { runtime } = build(fake.client);

    const body = await runtime.watch(false);
    expect(body).toContain("cross margin");
    runtime.close();
  });
});
