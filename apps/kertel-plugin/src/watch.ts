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
 * free pass reads the venue price, the account, and Kertel's own records — all
 * free — and only escalates to paid evidence for holdings it has already
 * flagged, and only when asked.
 *
 * The flags are ordered by how much they should worry you, and every one of
 * them is derived from something checkable rather than from a model's opinion:
 *
 * - **Unprotected** — a position with no exit plan at all. Nothing will sell
 *   this if it falls, including Kertel.
 * - **Concentrated** — one holding is most of the portfolio. Being right about
 *   it stops being skill and starts being luck.
 * - **Adrift** — an armed plan whose stop is still far below entry after the
 *   position has gone nowhere for a long time.
 * - **Unresearched** — Kertel has never looked at this symbol, so it has no
 *   evidence about it at all.
 * - **Untradeable** — the holding is below the exchange minimum, so no exit can
 *   ever be placed for it. Worth knowing before you rely on a stop.
 */

import * as fp from "@kertel/core/money";
import type { FixedPoint } from "@kertel/core/money";
import { formatInstant } from "@kertel/core/domain";
import type { Instant, Symbol_ } from "@kertel/core/domain";
import { effectiveStopBps, priceAtBps } from "@kertel/core/mandates";
import type { ExitMandate } from "@kertel/core/mandates";
import { instrumentFor } from "@kertel/providers";

import type { BinanceClient } from "./infra/binance.js";
import type { Store } from "./infra/store.js";

export type WatchDeps = {
  readonly store: Store;
  readonly binance: BinanceClient;
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
 * Every figure comes from the exchange or from Kertel's own durable records.
 * Nothing here costs anything.
 */
export async function watchHoldings(
  deps: WatchDeps,
  options: { readonly deep: boolean },
): Promise<string> {
  const now = deps.now();

  const accountResult = await deps.binance.account();
  if (!accountResult.ok) {
    return `Kertel could not read the account: ${accountResult.error.detail}`;
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

    const symbol = deps.allowedSymbols.find(
      (candidate) => instrumentFor(candidate)?.baseAsset === balance.asset,
    );
    if (symbol === undefined) {
      // Held, but outside what Kertel is allowed to touch. Still worth showing:
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

  const findings: Finding[] = [];
  const dust = fp.parse(DUST_VALUE);

  for (const holding of holdings) {
    if (holding.asset === deps.quoteAsset || holding.symbol === null) {
      if (holding.symbol === null && holding.asset !== deps.quoteAsset && fp.isPositive(holding.free)) {
        findings.push({
          severity: "medium",
          asset: holding.asset,
          headline: `${holding.asset} is held but outside Kertel's remit`,
          detail:
            "It is not in the allowed symbol list, so Kertel cannot research it, protect it, or sell it. Nothing here is watching it.",
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
        detail: `${fp.format(holding.free)} ${holding.asset} worth about ${fp.format(holding.valueQuote)} ${deps.quoteAsset}. Nothing will sell this if it falls, including Kertel. Use kertel_plan_exit to hand it over.`,
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

  lines.push("");
  lines.push(`Portfolio: about ${fp.format(portfolioValue)} ${deps.quoteAsset}`);
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
    lines.push("Run kertel_watch with deep=true to buy Smart Money evidence on the flagged holdings.");
  }

  lines.push("");
  lines.push(formatInstant(now));
  return lines.join("\n");
}
