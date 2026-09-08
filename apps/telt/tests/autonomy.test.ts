import { describe, expect, it } from "vitest";

import * as fp from "@telt/core/money";
import { instant, ok } from "@telt/core/domain";
import type { Instant, Symbol_ } from "@telt/core/domain";

import type { BinanceClient, PlacedOrder } from "../src/infra/binance.js";
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

/**
 * A market a test can move, and an account that actually shrinks when Telt
 * sells. Without the balance following the fills, a ladder would happily sell
 * the same coins three times and every test would pass.
 */
function fakeExchange(initialBid: string, initialHeld: string) {
  let bid = fp.parse(initialBid);
  let held = fp.parse(initialHeld);
  const orders: PlacedOrder[] = [];
  let failNext: "timeout" | null = null;

  const client = {
    credentialed: true,
    async filters() {
      return ok(FILTERS);
    },
    async market() {
      return ok({
        symbol: ETHUSDT,
        lastPrice: bid,
        bestBid: bid,
        bestAsk: bid,
        averagePrice: bid,
        observedAt: instant(Date.now()),
        source: "test",
      });
    },
    async account() {
      return ok({
        accountRef: "test",
        canTradeSpot: true,
        observedAt: instant(Date.now()),
        balances: [
          { asset: "ETH", free: held, locked: fp.parse("0") },
          { asset: "USDT", free: fp.parse("1000.00"), locked: fp.parse("0") },
        ],
      });
    },
    async placeMarketOrder(input: { quantity: ReturnType<typeof fp.parse> }) {
      if (failNext === "timeout") {
        failNext = null;
        return {
          ok: false as const,
          error: {
            code: "EXECUTION_RESULT_UNKNOWN" as const,
            detail: "Telt sent the order and did not get an answer.",
          },
        };
      }
      held = fp.subtract(held, input.quantity);
      const order: PlacedOrder = {
        exchangeOrderRef: `ord-${String(orders.length + 1)}`,
        clientOrderId: "telt-test",
        status: "filled",
        filledQuantity: input.quantity,
        averagePrice: bid,
        feePaid: fp.parse("0.01"),
        raw: {},
      };
      orders.push(order);
      return ok(order);
    },
    async findOrder() {
      return ok(null);
    },
  };

  return {
    client: client as unknown as BinanceClient,
    orders,
    setBid: (price: string) => {
      bid = fp.parse(price);
    },
    heldNow: () => fp.format(held),
    failNextOrder: () => {
      failNext = "timeout";
    },
  };
}

/** The free venue read the evidence path makes. Served locally, never over the wire. */
const venueFetch = (async (url: string | URL) => {
  if (!String(url).startsWith("https://api.binance.com/")) {
    throw new Error(`a test tried to reach ${String(url)}`);
  }
  return new Response(
    JSON.stringify({
      symbol: "ETHUSDT",
      lastPrice: "2000.00000000",
      bidPrice: "2000.00000000",
      askPrice: "2000.01000000",
      priceChangePercent: "-8.4",
      closeTime: START,
    }),
    { status: 200 },
  );
}) as unknown as typeof globalThis.fetch;

function build(exchange: ReturnType<typeof fakeExchange>, live = true) {
  const store = openStore(":memory:");
  let now = START;
  const runtime = createRuntime({
    config: loadConfig({
      TELT_OWNER_WHATSAPP: "+2348067053854",
      TELT_X402_PRIVATE_KEY: `0x${"a".repeat(64)}`,
      TELT_BINANCE_API_KEY: "k",
      TELT_BINANCE_API_SECRET: "s",
      ...(live ? { TELT_MODE: "live", TELT_LIVE_EXECUTION: "true" } : {}),
    }),
    clock: { now: () => now as Instant },
    store,
    log: createLogger({ level: "silent" }),
    binance: exchange.client,
    fetchImpl: venueFetch,
    random: (count: number) => new Uint8Array(count).fill(11),
    newId: (prefix: string) => `${prefix}-test`,
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

/** Draft and arm a standard scale-out plan on a fresh 0.3 ETH position at 2000. */
async function armed(runtime: Runtime) {
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
  const arm = runtime.armPlan(codeFrom(plan.body));
  return { plan, arm };
}

describe("handing Telt a position", () => {
  it("shows the real prices each leg fires at, not the percentages typed", async () => {
    const exchange = fakeExchange("2000.00", "0.3000");
    const { runtime } = build(exchange);
    const plan = await runtime.planExit({
      symbol: "ETHUSDT",
      ladder: [{ atBps: 5000, fractionBps: 10_000 }],
      stopLossBps: 1500,
      trailing: null,
      breakevenAtBps: null,
      quantity: null,
      entryPrice: "2000.00",
      holdDays: 30,
    });

    expect(plan.ok).toBe(true);
    // A percentage is a preference; a price is a commitment.
    expect(plan.body).toContain("at 3000.00");
    expect(plan.body).toContain("stop at 1700.00");
    expect(plan.body).toContain("arm KTL-");
    runtime.close();
  });

  it("watches nothing until the human arms it", async () => {
    const exchange = fakeExchange("2000.00", "0.3000");
    const { runtime } = build(exchange);
    await runtime.planExit({
      symbol: "ETHUSDT",
      ladder: [{ atBps: 100, fractionBps: 10_000 }],
      stopLossBps: null,
      trailing: null,
      breakevenAtBps: null,
      quantity: null,
      entryPrice: "2000.00",
      holdDays: 30,
    });

    // The target is already exceeded, but the plan was never armed.
    exchange.setBid("2500.00");
    const sweep = await runtime.checkPositions();
    expect(sweep.checked).toBe(0);
    expect(exchange.orders).toHaveLength(0);
    runtime.close();
  });

  it("refuses a plan that promises what the account cannot cover", async () => {
    const exchange = fakeExchange("2000.00", "0.0100");
    const { runtime } = build(exchange);
    const plan = await runtime.planExit({
      symbol: "ETHUSDT",
      ladder: [{ atBps: 5000, fractionBps: 10_000 }],
      stopLossBps: null,
      trailing: null,
      breakevenAtBps: null,
      quantity: "5.0000",
      entryPrice: "2000.00",
      holdDays: 30,
    });
    expect(plan.ok).toBe(false);
    expect(plan.refusalCode).toBe("INSUFFICIENT_BALANCE");
    runtime.close();
  });

  it("refuses a plan with no exit at all", async () => {
    const exchange = fakeExchange("2000.00", "0.3000");
    const { runtime } = build(exchange);
    const plan = await runtime.planExit({
      symbol: "ETHUSDT",
      ladder: [],
      stopLossBps: null,
      trailing: null,
      breakevenAtBps: null,
      quantity: null,
      entryPrice: "2000.00",
      holdDays: 30,
    });
    expect(plan.ok).toBe(false);
    expect(plan.body).toContain("needs at least one exit");
    runtime.close();
  });
});

describe("a whole position, managed", () => {
  it("scales out on the way up and closes on the trailing stop", async () => {
    const exchange = fakeExchange("2000.00", "0.3000");
    const { runtime, advance } = build(exchange);
    await armed(runtime);

    // Nothing yet.
    exchange.setBid("2200.00");
    advance(30);
    let sweep = await runtime.checkPositions();
    expect(sweep.fired).toBe(0);

    // +25%: take the first third, let the rest run.
    exchange.setBid("2500.00");
    advance(30);
    sweep = await runtime.checkPositions();
    expect(sweep.fired).toBe(1);
    expect(exchange.orders).toHaveLength(1);
    expect(fp.format(exchange.orders[0]!.filledQuantity)).toBe("0.0999");

    // +50%: the second third.
    exchange.setBid("3000.00");
    advance(30);
    sweep = await runtime.checkPositions();
    expect(exchange.orders).toHaveLength(2);

    // Runs to +80%, then falls back through the trailing stop at +70%.
    exchange.setBid("3600.00");
    advance(30);
    await runtime.checkPositions();

    exchange.setBid("3300.00");
    advance(30);
    sweep = await runtime.checkPositions();

    expect(exchange.orders).toHaveLength(3);
    expect(sweep.lines.join(" ")).toContain("trailing stop");
    // Everything has been sold.
    expect(fp.format(fp.parse(exchange.heldNow()))).toBe("0.0000");
    runtime.close();
  });

  it("never sells the same tranche twice", async () => {
    const exchange = fakeExchange("2000.00", "0.3000");
    const { runtime, advance } = build(exchange);
    await armed(runtime);

    exchange.setBid("2500.00");
    for (let index = 0; index < 4; index += 1) {
      advance(30);
      await runtime.checkPositions();
    }

    // One rung reached, one order placed, however many times it looked.
    expect(exchange.orders).toHaveLength(1);
    runtime.close();
  });

  it("gets out at breakeven rather than giving back a gain", async () => {
    const exchange = fakeExchange("2000.00", "0.3000");
    const { runtime, advance } = build(exchange);
    await runtime
      .planExit({
        symbol: "ETHUSDT",
        ladder: [],
        stopLossBps: 1500,
        trailing: null,
        breakevenAtBps: 2000,
        quantity: null,
        entryPrice: "2000.00",
        holdDays: 30,
      })
      .then((plan) => runtime.armPlan(codeFrom(plan.body)));

    // Up 20%: breakeven arms.
    exchange.setBid("2400.00");
    advance(30);
    expect((await runtime.checkPositions()).fired).toBe(0);

    // All the way back to entry. A plain stop would still be 15% below here.
    exchange.setBid("2000.00");
    advance(30);
    const sweep = await runtime.checkPositions();

    expect(sweep.fired).toBe(1);
    expect(sweep.lines.join(" ")).toContain("rather than giving it back");
    runtime.close();
  });

  it("takes the whole position out on a stop, not a tranche", async () => {
    const exchange = fakeExchange("2000.00", "0.3000");
    const { runtime, advance } = build(exchange);
    await armed(runtime);

    exchange.setBid("1600.00");
    advance(30);
    const sweep = await runtime.checkPositions();

    expect(sweep.fired).toBe(1);
    expect(fp.format(exchange.orders[0]!.filledQuantity)).toBe("0.3000");
    runtime.close();
  });
});

describe("the judgement a trigger does not make", () => {
  it("executes an abrupt protective stop without waiting or paying for research", async () => {
    const exchange = fakeExchange("2000.00", "0.3000");
    const { runtime, store, advance } = build(exchange);
    await armed(runtime);

    // A gentle first look, so there is a previous price to compare against.
    exchange.setBid("1990.00");
    advance(30);
    await runtime.checkPositions();

    // Then a lurch straight through the stop.
    exchange.setBid("1600.00");
    advance(30);
    await runtime.checkPositions();

    const journal = store.mandates.recentJournal(20);
    const checked = journal.find((entry) => entry.kind === "evidence_taken");
    expect(checked).toBeUndefined();
    expect(exchange.orders).toHaveLength(1);
    expect(journal.some((entry) => entry.kind === "exit_fired")).toBe(true);
    runtime.close();
  });

  it("does not pay for evidence on a slow drift into the stop", async () => {
    const exchange = fakeExchange("2000.00", "0.3000");
    const { runtime, store, advance } = build(exchange);
    await armed(runtime);

    exchange.setBid("1705.00");
    advance(30);
    await runtime.checkPositions();

    exchange.setBid("1700.00");
    advance(30);
    await runtime.checkPositions();

    const journal = store.mandates.recentJournal(20);
    expect(journal.some((entry) => entry.kind === "evidence_taken")).toBe(
      false,
    );
    runtime.close();
  });

  it("writes down the times it looked and did nothing", async () => {
    const exchange = fakeExchange("2000.00", "0.3000");
    const { runtime, store, advance } = build(exchange);
    await armed(runtime);

    exchange.setBid("2100.00");
    advance(30);
    await runtime.checkPositions();

    const journal = store.mandates.recentJournal(10);
    const holding = journal.find((entry) => entry.kind === "checked");
    expect(holding?.headline).toContain("Holding");
    expect(holding?.detail).toContain("Up 5%");
    runtime.close();
  });
});

describe("when the monitor must stop itself", () => {
  it("halts entirely while the kill switch is engaged", async () => {
    const exchange = fakeExchange("2000.00", "0.3000");
    const { runtime, store, advance } = build(exchange);
    await armed(runtime);

    store.engageKillSwitch("owner said stop", instant(START));
    exchange.setBid("3000.00");
    advance(30);

    const sweep = await runtime.checkPositions();
    expect(sweep.halted).toContain("owner said stop");
    expect(exchange.orders).toHaveLength(0);
    runtime.close();
  });

  it("stops itself when an exit is sent and never confirmed", async () => {
    const exchange = fakeExchange("2000.00", "0.3000");
    const { runtime, store, advance } = build(exchange);
    await armed(runtime);

    exchange.failNextOrder();
    exchange.setBid("2500.00");
    advance(30);
    await runtime.checkPositions();

    expect(store.safetyState().killSwitchEngaged).toBe(true);

    // And it does not keep trading on a position it cannot account for.
    exchange.setBid("3000.00");
    advance(30);
    const next = await runtime.checkPositions();
    expect(next.halted).not.toBeNull();
    runtime.close();
  });

  it("will not draft a plan from a price it could not read", async () => {
    // A monitor that acts when the exchange is unreachable is a monitor that
    // sells on a network blip. The refusal starts one step earlier: no price,
    // no plan.
    const offline = {
      credentialed: true,
      async filters() {
        return ok(FILTERS);
      },
      async market() {
        return {
          ok: false as const,
          error: {
            code: "PROVIDER_UNAVAILABLE" as const,
            detail: "Binance could not be reached.",
          },
        };
      },
      async account() {
        return ok({
          accountRef: "test",
          canTradeSpot: true,
          observedAt: instant(START),
          balances: [
            { asset: "ETH", free: fp.parse("0.3000"), locked: fp.parse("0") },
          ],
        });
      },
      async placeMarketOrder() {
        throw new Error("must not be reached");
      },
      async findOrder() {
        return ok(null);
      },
    } as unknown as BinanceClient;

    const store = openStore(":memory:");
    const runtime = createRuntime({
      config: loadConfig({
        TELT_OWNER_WHATSAPP: "+2348067053854",
        TELT_BINANCE_API_KEY: "k",
        TELT_BINANCE_API_SECRET: "s",
        TELT_MODE: "live",
        TELT_LIVE_EXECUTION: "true",
      }),
      clock: { now: () => START as Instant },
      store,
      log: createLogger({ level: "silent" }),
      binance: offline,
      fetchImpl: venueFetch,
      random: (count: number) => new Uint8Array(count).fill(11),
      newId: (prefix: string) => `${prefix}-test`,
    });

    const plan = await runtime.planExit({
      symbol: "ETHUSDT",
      ladder: [{ atBps: 2500, fractionBps: 10_000 }],
      stopLossBps: 1500,
      trailing: null,
      breakevenAtBps: null,
      quantity: null,
      entryPrice: "2000.00",
      holdDays: 30,
    });

    expect(plan.ok).toBe(false);
    expect(plan.refusalCode).toBe("PROVIDER_UNAVAILABLE");
    runtime.close();
  });

  it("stops at the write gate in fixture mode, and says what it would have done", async () => {
    const exchange = fakeExchange("2000.00", "0.3000");
    const { runtime, store, advance } = build(exchange, false);
    await armed(runtime);

    exchange.setBid("2500.00");
    advance(30);
    const sweep = await runtime.checkPositions();

    expect(exchange.orders).toHaveLength(0);
    expect(sweep.lines.join(" ")).toContain("dry run");
    const journal = store.mandates.recentJournal(10);
    expect(
      journal.some((entry) => entry.headline.startsWith("Would sell")),
    ).toBe(true);
    runtime.close();
  });
});

describe("the record a person reads", () => {
  it("shows where each position stands, including the ratcheted stop", async () => {
    const exchange = fakeExchange("2000.00", "0.3000");
    const { runtime, advance } = build(exchange);
    await armed(runtime);

    exchange.setBid("2800.00"); // +40%, trailing arms at +30%
    advance(30);
    await runtime.checkPositions();

    const positions = runtime.positions();
    expect(positions).toContain("ETHUSDT");
    expect(positions).toContain("peak +40%");
    // The trailing stop has moved up behind the peak.
    expect(positions).toContain("stop now at +30%");
    runtime.close();
  });

  it("reads back as a narrative of what it did", async () => {
    const exchange = fakeExchange("2000.00", "0.3000");
    const { runtime, advance } = build(exchange);
    await armed(runtime);

    exchange.setBid("2500.00");
    advance(30);
    await runtime.checkPositions();

    const journal = runtime.journal(10, false);
    expect(journal).toContain("Sold");
    expect(journal).toContain("take profit");
    expect(journal).toContain("letting the rest run");
    runtime.close();
  });
});

it("coalesces simultaneous manual and timer sweeps into one exit", async () => {
  const exchange = fakeExchange("2000.00", "0.3000");
  const { runtime, advance } = build(exchange);
  await armed(runtime);
  exchange.setBid("1600.00");
  advance(30);
  const [a, b] = await Promise.all([
    runtime.checkPositions(),
    runtime.checkPositions(),
  ]);
  expect(a).toEqual(b);
  expect(exchange.orders).toHaveLength(1);
  runtime.close();
});
it("does not mark a partially filled protective exit complete", async () => {
  const exchange = fakeExchange("2000.00", "0.3000");
  exchange.client.placeMarketOrder = async () =>
    ok({
      exchangeOrderRef: "partial-test",
      clientOrderId: "partial-test",
      status: "partially_filled",
      filledQuantity: fp.parse("0.01"),
      averagePrice: fp.parse("1600"),
      feePaid: null,
      raw: {},
    });
  const { runtime, store, advance } = build(exchange);
  await armed(runtime);
  exchange.setBid("1600.00");
  advance(30);
  await runtime.checkPositions();
  expect(store.safetyState().killSwitchEngaged).toBe(true);
  expect(store.mandates.active()).toHaveLength(1);
  runtime.close();
});
