import { describe, expect, it, beforeEach } from "vitest";

import * as fp from "@telt/core/money";
import { instant, ok, refuse } from "@telt/core/domain";
import type { Instant, SenderIdHash, Symbol_ } from "@telt/core/domain";

import type { FuturesClient, FuturesPosition } from "../src/infra/futures.js";
import { liquidationDistanceBps, positionSide } from "../src/infra/futures.js";
import {
  clearPending,
  closeFutures,
  confirmFutures,
  describeFutures,
  proposeFutures,
} from "../src/futures-trading.js";
import type { FuturesDeps } from "../src/futures-trading.js";
import { openStore } from "../src/infra/store.js";
import { sha256 } from "../src/infra/hash.js";

const NOW = instant(Date.parse("2026-09-07T12:00:00.000Z"));
const ETHUSDT = "ETHUSDT" as Symbol_;

/** The live ETHUSDT futures filters, read from Binance on 2026-09-07. */
const FILTERS = {
  symbol: ETHUSDT,
  stepSize: fp.parse("0.001"),
  minQuantity: fp.parse("0.001"),
  maxQuantity: fp.parse("10000"),
  minNotional: fp.parse("20"),
  quantityPrecision: 3,
  tickSize: fp.parse("0.01"),
};

function flat(overrides: Partial<FuturesPosition> = {}): FuturesPosition {
  return {
    symbol: ETHUSDT,
    positionAmt: fp.parse("0.000"),
    entryPrice: fp.parse("0.0"),
    // Binance reports a zero mark on a flat position, and a flat position is
    // what every first entry is sized from. The fake says zero so it cannot
    // hide that.
    markPrice: fp.parse("0.00000000"),
    liquidationPrice: null,
    unrealisedPnl: fp.parse("0"),
    leverage: 3,
    isolated: true,
    notional: fp.parse("0"),
    ...overrides,
  };
}

function long(overrides: Partial<FuturesPosition> = {}): FuturesPosition {
  return flat({
    positionAmt: fp.parse("0.012"),
    entryPrice: fp.parse("2500.00"),
    markPrice: fp.parse("2500.00"),
    liquidationPrice: fp.parse("1700.00"),
    notional: fp.parse("30.00"),
    ...overrides,
  });
}

type FakeOptions = {
  readonly position?: FuturesPosition;
  /** What the price ticker answers, independently of the position. */
  readonly ticker?: ReturnType<typeof fp.parse> | null;
  readonly isolatedFails?: boolean;
  readonly openFails?: "unknown" | "rejected";
};

function fakeFutures(options: FakeOptions = {}) {
  const calls: string[] = [];
  let current = options.position ?? flat();

  const client = {
    async filters() {
      return ok(FILTERS);
    },
    async position() {
      return ok(current);
    },
    async markPrice() {
      const ticker =
        options.ticker === undefined ? fp.parse("2500.00") : options.ticker;
      return ticker === null
        ? refuse(
            "MARKET_DATA_STALE",
            "Binance returned no usable futures price for ETHUSDT.",
          )
        : ok(ticker);
    },
    async balances() {
      return ok([
        {
          asset: "USDT",
          balance: fp.parse("25.00"),
          available: fp.parse("25.00"),
        },
      ]);
    },
    async setIsolated() {
      calls.push("setIsolated");
      return options.isolatedFails === true
        ? refuse("EXCHANGE_REJECTED", "could not switch to isolated margin")
        : ok(true as const);
    },
    async setLeverage(_symbol: Symbol_, leverage: number) {
      calls.push(`setLeverage:${String(leverage)}`);
      return ok(true as const);
    },
    async open(input: { quantity: ReturnType<typeof fp.parse> }) {
      calls.push("open");
      if (options.openFails === "unknown") {
        return refuse("EXECUTION_RESULT_UNKNOWN", "sent and never answered");
      }
      if (options.openFails === "rejected") {
        return refuse("EXCHANGE_REJECTED", "margin is insufficient");
      }
      current = long({ positionAmt: input.quantity });
      return ok({
        orderRef: "f-1",
        clientOrderId: "telt-fut",
        status: "FILLED",
        filledQuantity: input.quantity,
        averagePrice: fp.parse("2500.00"),
      });
    },
    async close(input: { quantity: ReturnType<typeof fp.parse> }) {
      calls.push(`close:${fp.format(input.quantity)}`);
      current = flat();
      return ok({
        orderRef: "f-2",
        clientOrderId: "telt-fut-close",
        status: "FILLED",
        filledQuantity: input.quantity,
        averagePrice: fp.parse("2550.00"),
      });
    },
  };
  return {
    client: client as unknown as FuturesClient,
    calls,
    position: () => current,
  };
}

function deps(
  client: FuturesClient,
  overrides: Partial<FuturesDeps> = {},
): FuturesDeps {
  return {
    futures: client,
    store: openStore(":memory:"),
    hash: sha256,
    random: (count: number) => new Uint8Array(count).fill(9),
    now: () => NOW,
    ownerHash: "sha256:owner" as SenderIdHash,
    mode: "live",
    liveExecutionEnabled: true,
    maxLeverage: 5,
    maxNotional: fp.parse("50.00"),
    newId: (prefix: string) => `${prefix}-test`,
    ...overrides,
  };
}

function codeFrom(body: string): string {
  const match = /KTL-[A-Z0-9]+/.exec(body);
  if (match === null) throw new Error(`no code in:\n${body}`);
  return match[0];
}

beforeEach(() => {
  clearPending();
});

describe("reading a futures position", () => {
  it("measures how far the price is from liquidation", () => {
    // Mark 2500, liquidation 1700: 32% of room.
    expect(liquidationDistanceBps(long())).toBe(3200);
  });

  it("reports no distance for a flat position rather than pretending it is at zero", () => {
    // The exchange returns liquidationPrice "0" when flat. Carrying that as a
    // real price would put liquidation at zero and look infinitely safe.
    expect(liquidationDistanceBps(flat())).toBeNull();
  });

  it("knows which way a position points", () => {
    expect(positionSide(long())).toBe("LONG");
    expect(positionSide(long({ positionAmt: fp.parse("-0.012") }))).toBe(
      "SHORT",
    );
    expect(positionSide(flat())).toBe("FLAT");
  });
});

describe("opening a position", () => {
  it("does not mutate margin or leverage when issuing a proposal", async () => {
    const fake = fakeFutures();
    const result = await proposeFutures(deps(fake.client), {
      symbol: "ETHUSDT",
      side: "BUY",
      notional: "30",
      leverage: 3,
    });

    expect(result.ok).toBe(true);
    expect(fake.calls).not.toContain("setIsolated");
    expect(fake.calls).not.toContain("setLeverage:3");
    expect(fake.calls).not.toContain("open");
    expect(result.body).toContain("isolated margin");
    expect(result.body).toContain("confirm KTL-");
  });

  it("sizes a first entry from the ticker, not from the flat position's zero mark", async () => {
    // Regression. `positionInformationV2` reports markPrice "0.00000000" while
    // flat, and flat is the state every first entry starts from. Sizing off the
    // position's own mark meant no futures position could ever be opened.
    const fake = fakeFutures({ position: flat() });
    expect(fp.isZero(fake.position().markPrice)).toBe(true);

    const result = await proposeFutures(deps(fake.client), {
      symbol: "ETHUSDT",
      side: "BUY",
      notional: "30",
      leverage: 3,
    });

    expect(result.ok).toBe(true);
    // 30 at the ticker's 2500 is 0.012, floored to the 0.001 step.
    expect(result.body).toContain("0.012");
    expect(result.body).toContain("2500");
  });

  it("allows a size that still clears the minimum after flooring", async () => {
    // The companion to the test below. 21 at 2600 floors to 0.008 ETH, a 20.80
    // position, which clears the 20.00 minimum. Same request, different price,
    // opposite answer — so the refusal below is about the arithmetic and not
    // about the number 21.
    const fake = fakeFutures({ ticker: fp.parse("2600.00") });
    const result = await proposeFutures(deps(fake.client), {
      symbol: "ETHUSDT",
      side: "BUY",
      notional: "21",
      leverage: 3,
    });

    expect(result.ok).toBe(true);
  });

  it("refuses when flooring drops the position under Binance's minimum", async () => {
    // 21 at 2496.72 floors to 0.008 ETH, a 19.97 position, against a 20.00
    // minimum. The exchange answers -4164, and it would arrive after the code
    // was typed. Telt refuses before issuing one.
    const fake = fakeFutures({ ticker: fp.parse("2496.72") });
    const result = await proposeFutures(deps(fake.client), {
      symbol: "ETHUSDT",
      side: "BUY",
      notional: "21",
      leverage: 3,
    });

    expect(result.refusalCode).toBe("NOTIONAL_BELOW_EXCHANGE_MINIMUM");
    expect(result.body).toContain("19.97");
    // And it names a size that would work rather than leaving you guessing.
    expect(result.body).toContain("0.009");
    expect(result.body).toContain("22.47");
    expect(fake.calls).not.toContain("open");
  });

  it("refuses when the ticker has no price, rather than sizing off a zero", async () => {
    const fake = fakeFutures({ ticker: null });
    const result = await proposeFutures(deps(fake.client), {
      symbol: "ETHUSDT",
      side: "BUY",
      notional: "30",
      leverage: 3,
    });
    expect(result.refusalCode).toBe("MARKET_DATA_STALE");
    expect(fake.calls).not.toContain("open");
  });

  it("refuses when isolated margin could not be set, rather than opening into cross", async () => {
    const fake = fakeFutures({ isolatedFails: true });
    const context = deps(fake.client);
    const result = await proposeFutures(context, {
      symbol: "ETHUSDT",
      side: "BUY",
      notional: "30",
      leverage: 3,
    });
    expect(result.ok).toBe(true);
    const confirmed = await confirmFutures(
      context,
      result.body.match(/KTL-[A-Z0-9]+/)![0],
    );
    expect(confirmed.ok).toBe(false);
    expect(fake.calls).not.toContain("open");
  });

  it("refuses leverage above the ceiling", async () => {
    const fake = fakeFutures();
    const result = await proposeFutures(deps(fake.client), {
      symbol: "ETHUSDT",
      side: "BUY",
      notional: "30",
      leverage: 20,
    });
    expect(result.refusalCode).toBe("NOTIONAL_ABOVE_CAP");
    expect(result.body).toContain("whole margin");
  });

  it("caps the position, not the margin", async () => {
    // 200 at 2x is only 100 of margin, but it is still a 200 position and the
    // spot per-trade cap would never have caught it.
    const fake = fakeFutures();
    const result = await proposeFutures(deps(fake.client), {
      symbol: "ETHUSDT",
      side: "BUY",
      notional: "200",
      leverage: 2,
    });
    expect(result.refusalCode).toBe("NOTIONAL_ABOVE_CAP");
    expect(result.body).toContain("on the position, not what you put up");
  });

  it("refuses below Binance's futures minimum and says what margin it needs", async () => {
    const fake = fakeFutures();
    const result = await proposeFutures(deps(fake.client), {
      symbol: "ETHUSDT",
      side: "BUY",
      notional: "10",
      leverage: 3,
    });
    expect(result.refusalCode).toBe("NOTIONAL_BELOW_EXCHANGE_MINIMUM");
    expect(result.body).toContain("20");
    expect(result.body).toContain("margin");
  });

  it("will not average into a position that already exists", async () => {
    const fake = fakeFutures({ position: long() });
    const result = await proposeFutures(deps(fake.client), {
      symbol: "ETHUSDT",
      side: "BUY",
      notional: "30",
      leverage: 3,
    });
    expect(result.ok).toBe(false);
    expect(result.body).toContain("already a LONG position");
  });

  it("shows what a move against the position costs at this leverage", async () => {
    const fake = fakeFutures();
    const result = await proposeFutures(deps(fake.client), {
      symbol: "ETHUSDT",
      side: "BUY",
      notional: "30",
      leverage: 5,
    });
    // At 5x, 20% against is the whole margin.
    expect(result.body).toContain("20% move against you is the entire margin");
  });
});

describe("confirming a position", () => {
  it("opens it and reports the liquidation price the exchange gave", async () => {
    const fake = fakeFutures();
    const d = deps(fake.client);
    const proposal = await proposeFutures(d, {
      symbol: "ETHUSDT",
      side: "BUY",
      notional: "30",
      leverage: 3,
    });
    const result = await confirmFutures(d, codeFrom(proposal.body));

    expect(result.ok).toBe(true);
    expect(fake.calls).toContain("open");
    expect(result.body).toContain("Opened LONG");
    expect(result.body).toContain("liquidation");
  });

  it("burns the code, so the same message twice opens one position", async () => {
    const fake = fakeFutures();
    const d = deps(fake.client);
    const proposal = await proposeFutures(d, {
      symbol: "ETHUSDT",
      side: "BUY",
      notional: "30",
      leverage: 3,
    });
    const code = codeFrom(proposal.body);

    await confirmFutures(d, code);
    const second = await confirmFutures(d, code);

    expect(second.ok).toBe(false);
    expect(fake.calls.filter((call) => call === "open")).toHaveLength(1);
  });

  it("stops at the write gate and says what it would have done", async () => {
    const fake = fakeFutures();
    const d = deps(fake.client, { liveExecutionEnabled: false });
    const proposal = await proposeFutures(d, {
      symbol: "ETHUSDT",
      side: "BUY",
      notional: "30",
      leverage: 3,
    });
    const result = await confirmFutures(d, codeFrom(proposal.body));

    expect(result.refusalCode).toBe("LIVE_EXECUTION_DISABLED");
    expect(result.body).toContain("would have opened a long");
    expect(fake.calls).not.toContain("open");
  });

  it("stops everything when an open is sent and never confirmed", async () => {
    const fake = fakeFutures({ openFails: "unknown" });
    const store = openStore(":memory:");
    const d = deps(fake.client, { store });
    const proposal = await proposeFutures(d, {
      symbol: "ETHUSDT",
      side: "BUY",
      notional: "30",
      leverage: 3,
    });
    const result = await confirmFutures(d, codeFrom(proposal.body));

    expect(result.refusalCode).toBe("EXECUTION_RESULT_UNKNOWN");
    expect(store.safetyState().killSwitchEngaged).toBe(true);
    store.close();
  });

  it("refuses a code nobody issued", async () => {
    const fake = fakeFutures();
    const d = deps(fake.client);
    await proposeFutures(d, {
      symbol: "ETHUSDT",
      side: "BUY",
      notional: "30",
      leverage: 3,
    });
    const result = await confirmFutures(d, "KTL-ZZZZZZ");
    expect(result.refusalCode).toBe("TOKEN_NOT_FOUND");
    expect(fake.calls).not.toContain("open");
  });
});

describe("closing a position", () => {
  it("needs no code, because getting out is the safe direction", async () => {
    const fake = fakeFutures({ position: long() });
    const result = await closeFutures(deps(fake.client), {
      symbol: "ETHUSDT",
      fractionBps: 10_000,
    });

    expect(result.ok).toBe(true);
    expect(fake.calls.some((call) => call.startsWith("close:"))).toBe(true);
    expect(result.body).toContain("Closed");
  });

  it("closes part of it when asked", async () => {
    const fake = fakeFutures({
      position: long({ positionAmt: fp.parse("0.100") }),
    });
    await closeFutures(deps(fake.client), {
      symbol: "ETHUSDT",
      fractionBps: 5000,
    });
    expect(fake.calls).toContain("close:0.050");
  });

  it("closes the lot rather than stranding a remainder too small to close later", async () => {
    // 90% of 0.0025 is 0.00225, floored to 0.002, leaving 0.0005 — below the
    // 0.001 minimum, so the rest could never be closed on its own.
    const fake = fakeFutures({
      position: long({ positionAmt: fp.parse("0.0025") }),
    });
    await closeFutures(deps(fake.client), {
      symbol: "ETHUSDT",
      fractionBps: 9000,
    });
    expect(fake.calls).toContain("close:0.0025");
  });

  it("closes a minimum-size position in full, and says a partial was impossible", async () => {
    // Half of the minimum lot is not an order the exchange will take. Refusing
    // would leave a position nobody can exit.
    const fake = fakeFutures({
      position: long({ positionAmt: fp.parse("0.001") }),
    });
    const result = await closeFutures(deps(fake.client), {
      symbol: "ETHUSDT",
      fractionBps: 5000,
    });

    expect(fake.calls).toContain("close:0.001");
    expect(result.body).toContain("a partial close was not possible");
  });

  it("says so plainly when there is nothing open", async () => {
    const fake = fakeFutures();
    const result = await closeFutures(deps(fake.client), {
      symbol: "ETHUSDT",
      fractionBps: 10_000,
    });
    expect(result.ok).toBe(true);
    expect(result.body).toContain("no open");
  });
});

describe("what a person sees", () => {
  it("warns when liquidation is inside an ordinary day's range", async () => {
    // Mark 2500, liquidation 2400: 4% away.
    const fake = fakeFutures({
      position: long({ liquidationPrice: fp.parse("2400.00") }),
    });
    const body = await describeFutures(deps(fake.client), ["ETHUSDT"]);
    expect(body).toContain("WARNING: liquidation is 4% away");
  });

  it("warns loudly about cross margin", async () => {
    const fake = fakeFutures({ position: long({ isolated: false }) });
    const body = await describeFutures(deps(fake.client), ["ETHUSDT"]);
    expect(body).toContain("CROSS margin");
    expect(body).toContain("whole wallet backs it");
  });

  it("says nothing is open rather than printing an empty table", async () => {
    const fake = fakeFutures();
    const body = await describeFutures(deps(fake.client), ["ETHUSDT"]);
    expect(body).toContain("No open positions");
  });
});

describe("futures confirmation isolation", () => {
  it("rejects another runtime's code without mutating account settings", async () => {
    const fake = fakeFutures();
    const owner = deps(fake.client);
    const other = deps(fake.client);
    const proposal = await proposeFutures(owner, {
      symbol: "ETHUSDT",
      side: "BUY",
      notional: "30",
      leverage: 3,
    });
    expect((await confirmFutures(other, codeFrom(proposal.body))).ok).toBe(
      false,
    );
    expect(fake.calls).not.toContain("setIsolated");
    expect(fake.calls).not.toContain("open");
  });
  it("rechecks the kill switch after a proposal", async () => {
    const fake = fakeFutures();
    const context = deps(fake.client);
    const proposal = await proposeFutures(context, {
      symbol: "ETHUSDT",
      side: "BUY",
      notional: "30",
      leverage: 3,
    });
    context.store.engageKillSwitch("test stop", NOW);
    expect((await confirmFutures(context, codeFrom(proposal.body))).ok).toBe(
      false,
    );
    expect(fake.calls).not.toContain("setIsolated");
    expect(fake.calls).not.toContain("open");
  });
});
