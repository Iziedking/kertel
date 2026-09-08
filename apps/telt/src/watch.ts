/**
 * Looking at what you already hold, rather than what you asked about.
 *
 * Most of the risk in a portfolio is not in the trade you are considering. It
 * is in the position you opened three weeks ago, stopped thinking about, and
 * never put an exit on. This is the sweep that finds those.
 *
 * It is deliberately cheap by default. A portfolio check that costs six cents
 * per holding is one nobody runs twice, and an agent that quietly spends a
 * dollar because you said "how am I doing" is an agent you stop trusting. The
 * free pass reads the venue price, the account, and Telt's own records — all
 * free — and only escalates to paid evidence for holdings it has already
 * flagged, and only when asked.
 *
 * The flags are ordered by how much they should worry you, and every one of
 * them is derived from something checkable rather than from a model's opinion:
 *
 * - **Unprotected** — a position with no exit plan at all. Nothing will sell
 *   this if it falls, including Telt.
 * - **Concentrated** — one holding is most of the portfolio. Being right about
 *   it stops being skill and starts being luck.
 * - **Adrift** — an armed plan whose stop is still far below entry after the
 *   position has gone nowhere for a long time.
 * - **Unresearched** — Telt has never looked at this symbol, so it has no
 *   evidence about it at all.
 * - **Untradeable** — the holding is below the exchange minimum, so no exit can
 *   ever be placed for it. Worth knowing before you rely on a stop.
 */

import * as fp from "@telt/core/money";
import type { FixedPoint } from "@telt/core/money";
import { formatInstant } from "@telt/core/domain";
import type { Instant, Symbol_ } from "@telt/core/domain";
import { effectiveStopBps, priceAtBps } from "@telt/core/mandates";
import type { ExitMandate } from "@telt/core/mandates";
import { instrumentFor } from "@telt/providers";

import type { BinanceClient } from "./infra/binance.js";
import type { FuturesClient } from "./infra/futures.js";
import { isFlat, liquidationDistanceBps, positionSide } from "./infra/futures.js";
import type { Store } from "./infra/store.js";

export type WatchDeps = {
  readonly store: Store;
  readonly binance: BinanceClient;
  /** Null off the Agent OS rail. Then there are no futures positions to miss. */
  readonly futures: FuturesClient | null;
  /** Which futures symbols to check. Futures has no cheap list-all. */
  readonly futuresSymbols: readonly Symbol_[];
  readonly now: () => Instant;
  readonly quoteAsset: string;
  readonly allowedSymbols: readonly Symbol_[];
  readonly research: (
    symbol: string,
    goal: "price_check" | "trade_thesis",
  ) => Promise<{ readonly ok: boolean; readonly body: string }>;
};

export type Severity = "high" | "medium" | "low";

export type Finding = {
  readonly severity: Severity;
  readonly asset: string;
  readonly headline: string;
  readonly detail: string;
};

/** One holding is this share of the portfolio or more, in basis points. */
const CONCENTRATION_BPS = 6000;
/** Dust: below this in quote currency, a holding is not worth a line. */
const DUST_VALUE = "1.00";

type Holding = {
  readonly asset: string;
  readonly symbol: Symbol_ | null;
  readonly free: FixedPoint;
  readonly valueQuote: FixedPoint;
  readonly mandate: ExitMandate | null;
  readonly minQuantity: FixedPoint | null;
};

function severityRank(severity: Severity): number {
  return severity === "high" ? 0 : severity === "medium" ? 1 : 2;
}

/**
 * The free pass: what you hold, what it is worth, and what is unguarded.
 *
 * Every figure comes from the exchange or from Telt's own durable records.
 * Nothing here costs anything.
 */
export async function watchHoldings(
  deps: WatchDeps,
  options: { readonly deep: boolean },
): Promise<string> {
  const now = deps.now();

  const accountResult = await deps.binance.account();
  if (!accountResult.ok) {
    return `Telt could not read the account: ${accountResult.error.detail}`;
  }

  const mandates = deps.store.mandates.all();
  const holdings: Holding[] = [];
  let portfolioValue = fp.parse("0.00");

  for (const balance of accountResult.value.balances) {
    const total = fp.add(balance.free, balance.locked);
    if (!fp.isPositive(total)) {
      continue;
    }

    // The quote asset is cash, not a position. It has no price and no exit.
    if (balance.asset === deps.quoteAsset) {
      portfolioValue = fp.add(portfolioValue, total);
      holdings.push({
        asset: balance.asset,
        symbol: null,
        free: balance.free,
        valueQuote: total,
        mandate: null,
        minQuantity: null,
      });
      continue;
    }

    // A mapped instrument answers first, because it carries the exact pair.
    // Failing that, the conventional pair against the quote asset — since the
    // symbol gate now accepts "*", a holding is no longer outside Telt's
    // remit merely because nobody wrote a provider mapping for it.
    const mapped = deps.allowedSymbols.find(
      (candidate) => instrumentFor(candidate)?.baseAsset === balance.asset,
    );
    const wildcard = deps.allowedSymbols.includes("*" as Symbol_);
    const symbol =
      mapped ??
      (wildcard ? (`${balance.asset}${deps.quoteAsset}` as Symbol_) : undefined);
    if (symbol === undefined) {
      // Held, but outside what Telt is allowed to touch. Still worth showing:
      // an unmanaged position is exactly what this sweep is looking for.
      holdings.push({
        asset: balance.asset,
        symbol: null,
        free: balance.free,
        valueQuote: fp.parse("0.00"),
        mandate: null,
        minQuantity: null,
      });
      continue;
    }

    const [marketResult, filtersResult] = await Promise.all([
      deps.binance.market(symbol),
      deps.binance.filters(symbol),
    ]);
    const value = marketResult.ok ? fp.multiply(total, marketResult.value.bestBid) : fp.parse("0.00");
    portfolioValue = fp.add(portfolioValue, value);

    holdings.push({
      asset: balance.asset,
      symbol,
      free: balance.free,
      valueQuote: value,
      mandate:
        mandates.find(
          (candidate) => candidate.symbol === symbol && candidate.status === "active",
        ) ?? null,
      minQuantity: filtersResult.ok ? filtersResult.value.minQuantity : null,
    });
  }

  // Futures, which a spot balance sweep cannot see at all.
  //
  // A leveraged position is the one most worth surfacing here: it is the only
  // kind that can be closed by the exchange rather than by you, so "nothing is
  // watching this" is a materially worse sentence about a futures position than
  // about a spot bag.
  const futuresFindings: Finding[] = [];
  const futuresLines: string[] = [];
  if (deps.futures !== null) {
    for (const symbol of deps.futuresSymbols) {
      const position = await deps.futures.position(symbol);
      if (!position.ok || isFlat(position.value)) {
        continue;
      }
      const open = position.value;
      const side = positionSide(open);
      const distance = liquidationDistanceBps(open);
      const size = fp.abs(open.positionAmt);
      const mandate =
        mandates.find(
          (candidate) =>
            candidate.symbol === symbol &&
            candidate.market === "futures" &&
            candidate.status === "active",
        ) ?? null;

      futuresLines.push(
        `  ${symbol} futures ${side} ${fp.format(size)} at ${fp.format(fp.trim(open.entryPrice, 2))}` +
          `, mark ${fp.format(fp.trim(open.markPrice, 2))}` +
          (distance === null ? "" : `, liquidation ${(distance / 100).toFixed(1)}% away`) +
          (mandate === null ? " — NO EXIT PLAN" : " — managed"),
      );

      if (mandate === null) {
        futuresFindings.push({
          severity: "high",
          asset: symbol,
          headline: `${symbol} futures ${side} has no exit plan`,
          detail:
            `${fp.format(size)} at ${String(open.leverage)}x${open.isolated ? " isolated" : " CROSS"}. ` +
            (distance === null
              ? "Nothing will close this but you."
              : `Liquidation is ${(distance / 100).toFixed(1)}% away, and nothing will close this before then but you.`) +
            " Use telt_plan_exit to hand it over.",
        });
      } else if (effectiveStopBps(mandate) === null) {
        futuresFindings.push({
          severity: "high",
          asset: symbol,
          headline: `${symbol} futures has a plan with no downside protection`,
          detail:
            "The plan takes profit but has no stop, no trailing stop and no breakeven. On leverage " +
            "that means the only floor under it is the exchange's own liquidation.",
        });
      }

      if (!open.isolated) {
        futuresFindings.push({
          severity: "high",
          asset: symbol,
          headline: `${symbol} futures is on cross margin`,
          detail:
            "The whole futures wallet backs this position, not just its margin. Telt opens isolated; " +
            "this one was not opened by Telt, or was changed afterwards.",
        });
      }
    }
  }

  const findings: Finding[] = [...futuresFindings];
  const dust = fp.parse(DUST_VALUE);

  for (const holding of holdings) {
    if (holding.asset === deps.quoteAsset || holding.symbol === null) {
      if (holding.symbol === null && holding.asset !== deps.quoteAsset && fp.isPositive(holding.free)) {
        findings.push({
          severity: "medium",
          asset: holding.asset,
          headline: `${holding.asset} is held but outside Telt's remit`,
          detail:
            "It is not in the allowed symbol list, so Telt cannot research it, protect it, or sell it. Nothing here is watching it.",
        });
      }
      continue;
    }

    if (fp.lessThan(holding.valueQuote, dust)) {
      continue;
    }

    if (holding.mandate === null) {
      findings.push({
        severity: "high",
        asset: holding.asset,
        headline: `${holding.asset} has no exit plan`,
        detail: `${fp.format(holding.free)} ${holding.asset} worth about ${fp.format(holding.valueQuote)} ${deps.quoteAsset}. Nothing will sell this if it falls, including Telt. Use telt_plan_exit to hand it over.`,
      });
    } else {
      const stop = effectiveStopBps(holding.mandate);
      if (stop === null) {
        findings.push({
          severity: "high",
          asset: holding.asset,
          headline: `${holding.asset} has a plan with no downside protection`,
          detail: "The plan takes profit but has no stop, no trailing stop and no breakeven.",
        });
      }
    }

    if (holding.minQuantity !== null && fp.lessThan(holding.free, holding.minQuantity)) {
      findings.push({
        severity: "medium",
        asset: holding.asset,
        headline: `${holding.asset} is below the exchange minimum`,
        detail: `The exchange will not accept an order smaller than ${fp.format(holding.minQuantity)}, so no exit can ever be placed for this holding.`,
      });
    }

    if (fp.isPositive(portfolioValue)) {
      const shareBps = Number(
        fp.divide(
          fp.multiply(holding.valueQuote, fp.parse("10000")),
          portfolioValue,
          0,
          "floor",
        ).atoms,
      );
      if (shareBps >= CONCENTRATION_BPS) {
        findings.push({
          severity: "medium",
          asset: holding.asset,
          headline: `${holding.asset} is ${String(Math.floor(shareBps / 100))}% of the portfolio`,
          detail:
            "Being right about it stops being skill and starts being luck. Consider trimming or tightening its stop.",
        });
      }
    }
  }

  findings.sort((left, right) => severityRank(left.severity) - severityRank(right.severity));

  const lines: string[] = ["What you are holding", ""];

  for (const holding of holdings) {
    if (!fp.isPositive(holding.free)) {
      continue;
    }
    if (holding.asset === deps.quoteAsset) {
      lines.push(`  ${holding.asset.padEnd(6)} ${fp.format(holding.free)}  (cash)`);
      continue;
    }
    const worth =
      holding.symbol === null ? "not priced" : `~${fp.format(holding.valueQuote)} ${deps.quoteAsset}`;
    const guard =
      holding.mandate === null
        ? "no plan"
        : (() => {
            const stop = effectiveStopBps(holding.mandate);
            return stop === null
              ? "plan, no stop"
              : `stop ${fp.format(priceAtBps(holding.mandate.entryPrice, stop))}`;
          })();
    lines.push(`  ${holding.asset.padEnd(6)} ${fp.format(holding.free)}  ${worth}  [${guard}]`);
  }

  if (futuresLines.length > 0) {
    lines.push("");
    lines.push("Futures");
    for (const line of futuresLines) {
      lines.push(line);
    }
  }

  lines.push("");
  lines.push(`Portfolio: about ${fp.format(portfolioValue)} ${deps.quoteAsset}`);
  if (futuresLines.length > 0) {
    // Deliberately not added together. Spot value is what you own; a futures
    // position is exposure backed by margin, and summing the two would overstate
    // what is actually at risk in one direction and understate it in the other.
    lines.push("  (futures positions are listed separately; margin is not spot value)");
  }
  lines.push("");

  if (findings.length === 0) {
    lines.push("Nothing flagged. Every position above the dust threshold has an exit plan with a stop.");
  } else {
    lines.push("Flagged");
    for (const finding of findings) {
      lines.push(`  [${finding.severity}] ${finding.headline}`);
      lines.push(`      ${finding.detail}`);
    }
  }

  // Paid evidence only on request, and only where it would tell you something.
  if (options.deep) {
    const worthResearching = holdings.filter(
      (holding) =>
        holding.symbol !== null &&
        fp.greaterThan(holding.valueQuote, dust) &&
        findings.some((finding) => finding.asset === holding.asset),
    );

    if (worthResearching.length === 0) {
      lines.push("");
      lines.push("Nothing flagged was worth paying to research.");
    } else {
      lines.push("");
      lines.push("Research on the flagged holdings");
      for (const holding of worthResearching) {
        const result = await deps.research(holding.symbol as string, "trade_thesis");
        lines.push("");
        for (const line of result.body.split("\n")) {
          lines.push(`  ${line}`);
        }
      }
    }
  } else if (findings.length > 0) {
    lines.push("");
    lines.push("Run telt_watch with deep=true to buy Smart Money evidence on the flagged holdings.");
  }

  lines.push("");
  lines.push(formatInstant(now));
  return lines.join("\n");
}
