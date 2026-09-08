/**
 * Finding something worth looking at, before there is anything to research.
 *
 * Every other capability in Kertel starts with a symbol you already have in
 * mind. This is the one that starts with "what is moving", which is where a
 * trading session actually begins — and it is the difference between an agent
 * you have to feed and one you can ask an open question.
 *
 * What it is honest about:
 *
 * - **A mover list is not a signal.** Twenty-four hour change is a fact about
 *   the past. Everything here is a candidate to research, never a
 *   recommendation, and the receipt says so in those words so that a model
 *   summarising it cannot quietly upgrade it into advice.
 * - **Illiquidity is the trap.** A tiny pair can print +400% on a few thousand
 *   dollars of volume, and it will be the top of any unfiltered list. A volume
 *   floor is applied before ranking rather than after, because a list that
 *   shows junk and then explains it has already put the junk in front of you.
 * - **A pump and a collapse are the same event.** Losers are returned
 *   alongside gainers. An agent that only ever surfaces things going up is a
 *   bull-market agent.
 *
 * It costs nothing. The 24-hour ticker is free and unauthenticated, so this
 * spends no research budget and can be run as often as you like.
 */

import * as fp from "../money/index.js";
import type { FixedPoint } from "../money/index.js";
import type { Symbol_ } from "../domain/index.js";

/** One pair's last twenty-four hours, as the venue reports it. */
export type Mover = {
  readonly symbol: Symbol_;
  readonly lastPrice: FixedPoint;
  /** Basis points, signed. Negative is a faller. */
  readonly changeBps: number;
  /** Traded value over the window, in the quote asset. The liquidity check. */
  readonly quoteVolume: FixedPoint;
  readonly high: FixedPoint;
  readonly low: FixedPoint;
};

export type ScanRequest = {
  /** Only pairs quoted in this asset. Mixing quote assets makes the ranking meaningless. */
  readonly quoteAsset: string;
  /** Minimum traded value over the window. Below this a percentage move is noise. */
  readonly minQuoteVolume: FixedPoint;
  /** How many to return from each end. */
  readonly limit: number;
};

export type ScanResult = {
  readonly gainers: readonly Mover[];
  readonly losers: readonly Mover[];
  /** How many pairs the venue returned before any filtering. */
  readonly considered: number;
  /** How many survived the liquidity floor. */
  readonly liquid: number;
};

/**
 * Pairs that are leveraged tokens rather than assets.
 *
 * `ETHUP` and `ETHDOWN` are derivative products that track a multiple of a
 * move, so they are always near the top of a mover list and are never what
 * somebody means by "what is moving". Excluded by name rather than by a
 * heuristic, because a heuristic here would eventually eat a real token.
 */
const LEVERAGED_SUFFIXES = ["UPUSDT", "DOWNUSDT", "BULLUSDT", "BEARUSDT"];

function isLeveragedToken(symbol: string): boolean {
  return LEVERAGED_SUFFIXES.some((suffix) => symbol.endsWith(suffix));
}

/**
 * Rank what the venue reported.
 *
 * Pure: the caller fetches, this decides. That keeps the liquidity floor and
 * the exclusions testable against fixed numbers rather than against whatever
 * the market happened to be doing.
 */
export function rankMovers(rows: readonly Mover[], request: ScanRequest): ScanResult {
  const eligible = rows.filter(
    (row) =>
      row.symbol.endsWith(request.quoteAsset) &&
      !isLeveragedToken(row.symbol) &&
      fp.isPositive(row.lastPrice) &&
      !fp.lessThan(row.quoteVolume, request.minQuoteVolume),
  );

  const byChange = [...eligible].sort((a, b) => b.changeBps - a.changeBps);
  const limit = Math.max(1, request.limit);

  // Only genuine movers in each direction. A "top loser" that is up 2% means
  // nothing is falling, and saying so is better than padding the list.
  const gainers = byChange.filter((row) => row.changeBps > 0).slice(0, limit);
  const losers = byChange
    .filter((row) => row.changeBps < 0)
    .slice(-limit)
    .reverse();

  return {
    gainers,
    losers,
    considered: rows.length,
    liquid: eligible.length,
  };
}

/** How the scan reads back. Deliberately flat: a table invites a false ranking. */
export function renderScan(result: ScanResult, request: ScanRequest): string {
  const lines: string[] = ["What is moving"];

  const show = (title: string, movers: readonly Mover[]): void => {
    lines.push("");
    lines.push(title);
    if (movers.length === 0) {
      lines.push("  nothing, at this liquidity floor");
      return;
    }
    for (const mover of movers) {
      const percent = (mover.changeBps / 100).toFixed(1);
      const sign = mover.changeBps > 0 ? "+" : "";
      lines.push(
        `  ${mover.symbol.padEnd(12)} ${(sign + percent + "%").padStart(8)}` +
          `  ${fp.format(fp.trim(mover.lastPrice, 2)).padStart(14)}` +
          `  vol ${fp.format(fp.trim(fp.divide(mover.quoteVolume, fp.parse("1000000"), 1, "floor"), 1))}M`,
      );
    }
  };

  show("Up over 24h", result.gainers);
  show("Down over 24h", result.losers);

  lines.push("");
  lines.push(
    `Read ${String(result.considered)} pairs, ${String(result.liquid)} of them above ` +
      `${fp.format(fp.trim(request.minQuoteVolume, 0))} ${request.quoteAsset} of 24h volume.`,
  );
  lines.push("");
  // Said plainly, because a model summarising this must not upgrade it.
  lines.push(
    "This is a momentum screen, not a signal. Twenty-four hour change is a fact about the past " +
      "and says nothing about what happens next. Nothing here has been researched: these are " +
      "candidates to look at, and Kertel has no opinion on any of them yet.",
  );
  lines.push("Cost: nothing. The venue's 24h ticker is free.");

  return lines.join("\n");
}
