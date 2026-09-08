import { describe, expect, it } from "vitest";

import * as fp from "@telt/core/money";
import { instant, ok } from "@telt/core/domain";
import type { Instant, Symbol_ } from "@telt/core/domain";

import type { BinanceClient } from "../src/infra/binance.js";
import { loadConfig } from "../src/infra/config.js";
import { createLogger } from "../src/infra/logger.js";
import { openStore } from "../src/infra/store.js";
import { createRuntime } from "../src/runtime.js";
import type { Runtime } from "../src/runtime.js";

const START = Date.parse("2026-09-07T12:00:00.000Z");
const ETHUSDT = "ETHUSDT" as Symbol_;

const FILTERS = {
  symbol: ETHUSDT,
  baseAsset: "ETH",
  quoteAsset: "USDT",
  tickSize: fp.parse("0.01"),
  stepSize: fp.parse("0.00010000"),
  minQuantity: fp.parse("0.00010000"),
  maxQuantity: fp.parse("9000.00000000"),
  minNotional: fp.parse("5.00000000"),
  marketMaxQuantity: fp.parse("2192.93460666"),
  notionalAveragePriceMinutes: 5,
};

function exchangeHolding(held: string, bid = "2000.00") {
  let balance = fp.parse(held);
  let price = fp.parse(bid);
  const orders: { quantity: ReturnType<typeof fp.parse> }[] = [];
  const client = {
    credentialed: true,
    async filters() {
      return ok(FILTERS);
    },
    async market() {
      return ok({
        symbol: ETHUSDT,
        lastPrice: price,
        bestBid: price,
        bestAsk: price,
        averagePrice: price,
        observedAt: instant(START),
        source: "test",
      });
    },
    async account() {
      return ok({
        accountRef: "test",
        canTradeSpot: true,
        observedAt: instant(START),
        balances: [
          { asset: "ETH", free: balance, locked: fp.parse("0") },
          { asset: "USDT", free: fp.parse("500.00"), locked: fp.parse("0") },
        ],
      });
    },
    async placeMarketOrder(input: { quantity: ReturnType<typeof fp.parse> }) {
      balance = fp.subtract(balance, input.quantity);
      orders.push({ quantity: input.quantity });
      return ok({
        exchangeOrderRef: `ord-${String(orders.length)}`,
        clientOrderId: "telt-test",
        status: "filled" as const,
        filledQuantity: input.quantity,
        averagePrice: price,
        feePaid: fp.parse("0.01"),
        raw: {},
      });
    },
    async findOrder() {
      return ok(null);
    },
  };
  return {
    client: client as unknown as BinanceClient,
    orders,
    setBid: (value: string) => {
      price = fp.parse(value);
    },
    setHeld: (value: string) => {
      balance = fp.parse(value);
    },
  };
}

const venueFetch = (async () =>
  new Response(
    JSON.stringify({
      symbol: "ETHUSDT",
      lastPrice: "2000.00000000",
      bidPrice: "2000.00000000",
      askPrice: "2000.01000000",
      closeTime: START,
    }),
    { status: 200 },
  )) as unknown as typeof globalThis.fetch;

/** A separate machine: its own database, its own runtime, nothing shared. */
function machine(exchange: ReturnType<typeof exchangeHolding>, dataDir: string) {
  const store = openStore(":memory:");
  let now = START;
  const runtime = createRuntime({
    config: loadConfig({
      TELT_OWNER_WHATSAPP: "+2348067053854",
      // Live mode downgrades to fixture without a research wallet, and the
      // write gate would then block every exit. Omitting this made the whole
      // suite quietly test the dry-run path.
      TELT_X402_PRIVATE_KEY: `0x${"a".repeat(64)}`,
      TELT_BINANCE_API_KEY: "k",
      TELT_BINANCE_API_SECRET: "s",
      TELT_DATA_DIR: dataDir,
      TELT_MODE: "live",
      TELT_LIVE_EXECUTION: "true",
    }),
    clock: { now: () => now as Instant },
    store,
    log: createLogger({ level: "silent" }),
    binance: exchange.client,
    fetchImpl: venueFetch,
    random: (count: number) => new Uint8Array(count).fill(11),
    newId: (prefix: string) => `${prefix}-${dataDir}`,
  });
  return {
    runtime,
    store,
    advance: (seconds: number) => {
      now += seconds * 1000;
    },
  };
}

function codeFrom(body: string): string {
  const match = /KTL-[A-Z0-9]+/.exec(body);
  if (match === null) throw new Error(`no code in:\n${body}`);
  return match[0];
}

async function armLadder(runtime: Runtime) {
  const plan = await runtime.planExit({
    symbol: "ETHUSDT",
    ladder: [
      { atBps: 2500, fractionBps: 3333 },
      { atBps: 5000, fractionBps: 3333 },
      { atBps: 10_000, fractionBps: 3334 },
    ],
    stopLossBps: 1500,
    trailing: { activateAtBps: 3000, trailBps: 1000 },
    breakevenAtBps: 2000,
    quantity: null,
    entryPrice: "2000.00",
    holdDays: 30,
  });
  runtime.armPlan(codeFrom(plan.body));
}

describe("carrying a position to another machine", () => {
  it("resumes mid-flight, with the peak and the amount sold intact", async () => {
    const exchange = exchangeHolding("0.3000");
    const laptop = machine(exchange, "laptop");
    await armLadder(laptop.runtime);

    // Runs to +40%, taking the first tranche on the way.
    exchange.setBid("2500.00");
    laptop.advance(30);
    await laptop.runtime.checkPositions();
    exchange.setBid("2800.00");
    laptop.advance(30);
    await laptop.runtime.checkPositions();

    const carried = laptop.runtime.snapshot();
    expect(carried).toContain("TELT-STATE-1");
    // The ratchet is the thing that must survive the trip: without it a
    // trailing stop resets to its starting point and hands back the whole move.
    expect(carried).toContain("peak=4000");
    expect(carried).toContain("soldbps=3333");
    laptop.runtime.close();

    // A different machine, a blank database.
    const desktop = machine(exchange, "desktop");
    expect(desktop.runtime.positions()).toContain("No exit plans");

    const restored = await desktop.runtime.restore(carried);
    expect(restored.ok).toBe(true);
    expect(restored.body).toContain("Now managing again");

    const positions = desktop.runtime.positions();
    expect(positions).toContain("ETHUSDT");
    expect(positions).toContain("peak +40%");
    // And the trailing stop is still where the first machine left it.
    expect(positions).toContain("stop now at +30%");
    desktop.runtime.close();
  });

  it("picks up managing the position, not just describing it", async () => {
    const exchange = exchangeHolding("0.3000");
    const laptop = machine(exchange, "laptop");
    await armLadder(laptop.runtime);
    exchange.setBid("2500.00");
    laptop.advance(30);
    await laptop.runtime.checkPositions();
    const carried = laptop.runtime.snapshot();
    laptop.runtime.close();

    const desktop = machine(exchange, "desktop");
    await desktop.runtime.restore(carried);

    // The second rung comes due on the new machine and it acts.
    exchange.setBid("3000.00");
    desktop.advance(30);
    const sweep = await desktop.runtime.checkPositions();
    expect(sweep.fired).toBe(1);
    desktop.runtime.close();
  });

  it("carries past exits and lessons too", async () => {
    const exchange = exchangeHolding("0.3000");
    const laptop = machine(exchange, "laptop");
    laptop.store.mandates.learn({
      symbol: "ETHUSDT",
      text: "Stops tighter than 20% on ETH get hit by ordinary noise.",
      learnedAt: instant(START),
      source: "review",
    });
    await armLadder(laptop.runtime);
    exchange.setBid("2500.00");
    laptop.advance(30);
    await laptop.runtime.checkPositions();
    const carried = laptop.runtime.snapshot();
    laptop.runtime.close();

    const desktop = machine(exchange, "desktop");
    const restored = await desktop.runtime.restore(carried);

    expect(restored.body).toContain("past exit");
    expect(restored.body).toContain("lesson");
    expect(desktop.store.mandates.lessonsFor("ETHUSDT")).toHaveLength(1);
    desktop.runtime.close();
  });
});

describe("the snapshot is intent, the exchange is truth", () => {
  it("refuses to manage a position that has since been sold by hand", async () => {
    const exchange = exchangeHolding("0.3000");
    const laptop = machine(exchange, "laptop");
    await armLadder(laptop.runtime);
    const carried = laptop.runtime.snapshot();
    laptop.runtime.close();

    // Sold elsewhere between the snapshot and the restore.
    exchange.setHeld("0");

    const desktop = machine(exchange, "desktop");
    const restored = await desktop.runtime.restore(carried);

    expect(restored.body).toContain("Drifted since the snapshot");
    expect(restored.body).toContain("nothing left to manage");
    // And it will not go looking for something to sell.
    exchange.setBid("3000.00");
    desktop.advance(30);
    const sweep = await desktop.runtime.checkPositions();
    expect(sweep.fired).toBe(0);
    desktop.runtime.close();
  });

  it("reports a position that shrank, and sells only what is there", async () => {
    const exchange = exchangeHolding("0.3000");
    const laptop = machine(exchange, "laptop");
    await armLadder(laptop.runtime);
    const carried = laptop.runtime.snapshot();
    laptop.runtime.close();

    exchange.setHeld("0.1000");

    const desktop = machine(exchange, "desktop");
    const restored = await desktop.runtime.restore(carried);
    expect(restored.body).toContain("found 0.1000");

    exchange.setBid("1600.00"); // through the stop
    desktop.advance(30);
    await desktop.runtime.checkPositions();
    // Never more than the account actually holds.
    expect(fp.format(exchange.orders[0]?.quantity ?? fp.parse("0"))).toBe("0.1000");
    desktop.runtime.close();
  });

  it("does not resurrect a plan that expired while it was away", async () => {
    const exchange = exchangeHolding("0.3000");
    const laptop = machine(exchange, "laptop");
    await armLadder(laptop.runtime);
    const carried = laptop.runtime.snapshot();
    laptop.runtime.close();

    const desktop = machine(exchange, "desktop");
    desktop.advance(40 * 86_400); // well past the 30-day hold
    const restored = await desktop.runtime.restore(carried);

    expect(restored.body).toContain("already expired");
    desktop.runtime.close();
  });
});

describe("restoring safely", () => {
  it("never overwrites a plan this machine is already managing", async () => {
    const exchange = exchangeHolding("0.3000");
    const laptop = machine(exchange, "laptop");
    await armLadder(laptop.runtime);
    exchange.setBid("2800.00");
    laptop.advance(30);
    await laptop.runtime.checkPositions();
    const carried = laptop.runtime.snapshot();

    // Restoring its own snapshot onto itself must not reset the ratchet.
    const again = await laptop.runtime.restore(carried);
    expect(again.body).toContain("already managed here");
    expect(laptop.runtime.positions()).toContain("peak +40%");
    laptop.runtime.close();
  });

  it("does not carry the kill switch, because safety is per machine", async () => {
    const exchange = exchangeHolding("0.3000");
    const laptop = machine(exchange, "laptop");
    await armLadder(laptop.runtime);
    const carried = laptop.runtime.snapshot();
    laptop.runtime.close();

    const desktop = machine(exchange, "desktop");
    desktop.store.engageKillSwitch("stopped on this machine deliberately", instant(START));
    const restored = await desktop.runtime.restore(carried);

    // An old note must never quietly re-arm an agent somebody halted.
    expect(desktop.store.safetyState().killSwitchEngaged).toBe(true);
    expect(restored.body).toContain("never restored on");
    desktop.runtime.close();
  });

  it("warns when the snapshot came from a machine that may still be running", async () => {
    const exchange = exchangeHolding("0.3000");
    const laptop = machine(exchange, "laptop");
    await armLadder(laptop.runtime);
    const carried = laptop.runtime.snapshot();
    laptop.runtime.close();

    const desktop = machine(exchange, "desktop");
    const restored = await desktop.runtime.restore(carried);

    expect(restored.body).toContain("written by a different machine");
    expect(restored.body).toContain("Stop the other one");
    desktop.runtime.close();
  });

  it("rejects something that is not a snapshot", async () => {
    const exchange = exchangeHolding("0.3000");
    const desktop = machine(exchange, "desktop");
    const restored = await desktop.runtime.restore("here are some notes I took about ETH");

    expect(restored.ok).toBe(false);
    expect(restored.body).toContain("does not look like a Telt snapshot");
    desktop.runtime.close();
  });

  it("says plainly when there is nothing to carry", async () => {
    const exchange = exchangeHolding("0.3000");
    const laptop = machine(exchange, "laptop");
    const carried = laptop.runtime.snapshot();
    expect(carried).toContain("No positions are being managed");
    laptop.runtime.close();
  });
});
