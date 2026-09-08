/**
 * Ranking what the venue reported.
 *
 * The fetch is somebody else's problem; this is the judgement. Every case here
 * is a way a mover list misleads someone if nobody thought about it: the
 * illiquid pair that prints a huge percentage on nothing, the leveraged token
 * that is always at the top by construction, and the list padded out with
 * "fallers" that are actually up.
 */

import { describe, expect, it } from "vitest";

import * as fp from "../src/money/index.js";
import { rankMovers, renderScan } from "../src/research/scan.js";
import type { Mover, ScanRequest } from "../src/research/scan.js";
import type { Symbol_ } from "../src/domain/index.js";

function mover(symbol: string, changeBps: number, quoteVolume: string): Mover {
  return {
    symbol: symbol as Symbol_,
    lastPrice: fp.parse("1.00"),
    changeBps,
    quoteVolume: fp.parse(quoteVolume),
    high: fp.parse("1.10"),
    low: fp.parse("0.90"),
  };
}

const REQUEST: ScanRequest = {
  quoteAsset: "USDT",
  minQuoteVolume: fp.parse("5000000"),
  limit: 3,
};

describe("ranking movers", () => {
  it("drops a huge move that happened on no volume", () => {
    // The trap the whole liquidity floor exists for: +400% on 12k of volume is
    // a handful of trades, and it would top any unfiltered list.
    const result = rankMovers(
      [mover("SCAMUSDT", 40_000, "12000"), mover("SOLUSDT", 800, "90000000")],
      REQUEST,
    );

    expect(result.gainers.map((row) => row.symbol)).toEqual(["SOLUSDT"]);
    expect(result.considered).toBe(2);
    expect(result.liquid).toBe(1);
  });

  it("excludes leveraged tokens, which track a multiple by construction", () => {
    const result = rankMovers(
      [
        mover("ETHUPUSDT", 3000, "50000000"),
        mover("ETHDOWNUSDT", -3000, "50000000"),
        mover("ETHUSDT", 1000, "50000000"),
      ],
      REQUEST,
    );

    expect(result.gainers.map((row) => row.symbol)).toEqual(["ETHUSDT"]);
    expect(result.losers).toHaveLength(0);
  });

  it("ignores pairs quoted in something else", () => {
    // Mixing quote assets makes the ranking meaningless: a percentage against
    // BTC and one against USDT are not the same number.
    const result = rankMovers(
      [mover("ETHBTC", 2000, "50000000"), mover("ETHUSDT", 500, "50000000")],
      REQUEST,
    );
    expect(result.gainers.map((row) => row.symbol)).toEqual(["ETHUSDT"]);
  });

  it("returns fallers as well as risers", () => {
    const result = rankMovers(
      [
        mover("AUSDT", 2000, "50000000"),
        mover("BUSDT", 1000, "50000000"),
        mover("CUSDT", -1500, "50000000"),
        mover("DUSDT", -3000, "50000000"),
      ],
      REQUEST,
    );

    expect(result.gainers.map((row) => row.symbol)).toEqual(["AUSDT", "BUSDT"]);
    // Biggest faller first.
    expect(result.losers.map((row) => row.symbol)).toEqual(["DUSDT", "CUSDT"]);
  });

  it("does not pad the losers with things that are up", () => {
    // A "top loser" that gained 2% means nothing is falling. Saying so beats
    // filling the list.
    const result = rankMovers(
      [mover("AUSDT", 2000, "50000000"), mover("BUSDT", 200, "50000000")],
      REQUEST,
    );
    expect(result.losers).toHaveLength(0);
  });

  it("keeps each side to the limit", () => {
    const rows = [1, 2, 3, 4, 5].map((n) => mover(`G${String(n)}USDT`, n * 100, "50000000"));
    const result = rankMovers(rows, { ...REQUEST, limit: 2 });
    expect(result.gainers).toHaveLength(2);
    expect(result.gainers[0]?.symbol).toBe("G5USDT");
  });
});

describe("how a scan reads back", () => {
  it("says it is not a signal, in words a summary cannot drop", () => {
    // A model reading this must not be able to turn it into advice without
    // contradicting the text in front of it.
    const body = renderScan(rankMovers([mover("SOLUSDT", 800, "90000000")], REQUEST), REQUEST);

    expect(body).toContain("not a signal");
    expect(body).toContain("has been researched");
    expect(body).toContain("Cost: nothing");
  });

  it("says plainly when the floor left nothing", () => {
    const body = renderScan(rankMovers([mover("SCAMUSDT", 40_000, "1000")], REQUEST), REQUEST);
    expect(body).toContain("nothing, at this liquidity floor");
  });
});
