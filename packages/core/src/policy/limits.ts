/**
 * The limits Telt enforces, and the version stamp that goes on every decision.
 *
 * These values arrive from configuration. They never arrive from a WhatsApp
 * message, a model output, or a provider response. That is the whole point: the
 * user sets the fence once, deliberately, and everything downstream lives
 * inside it.
 *
 * Every proposal, receipt and audit row records `version`. When a limit changes,
 * the version changes with it, so a stored decision can always be read back
 * against the rules that were actually in force when it was made.
 */

import type { FixedPoint } from "../money/fixed-point.js";
import * as fp from "../money/fixed-point.js";
import { TeltDefect } from "../domain/result.js";
import type { Seconds } from "../domain/time.js";
import { seconds } from "../domain/time.js";
import type { Symbol_ } from "../domain/types.js";

export type X402Budget = {
  /** Refuse any single paid call quoted above this. */
  readonly maxPerCallUsdc: FixedPoint;
  /** Refuse the call that would push one research run past this. */
  readonly maxPerRunUsdc: FixedPoint;
  /** Refuse the call that would push the UTC day past this. */
  readonly maxPerDayUsdc: FixedPoint;
};

export type TradingLimits = {
  /** Nothing outside this list is ever proposed, priced, or researched for a trade. */
  readonly allowedSymbols: readonly Symbol_[];
  /** Hard ceiling on one order, in quote currency. Above it is a refusal, not a clamp. */
  readonly maxTradeNotional: FixedPoint;
  /** Realised loss ceiling per UTC day, in quote currency. */
  readonly maxDailyLoss: FixedPoint;
  /** Ceiling on total position value held at once, in quote currency. */
  readonly maxOpenExposure: FixedPoint;
  readonly maxSlippageBps: number;
  /** How long a proposal and its token stay valid. Seconds, not hours. */
  readonly proposalTtl: Seconds;
  /** A market snapshot older than this cannot support a proposal. */
  readonly marketDataMaxAge: Seconds;
  /**
   * How many independent providers must return usable evidence before a trade
   * may be proposed. One source agreeing with itself is not agreement.
   */
  readonly minValidSources: number;
  /**
   * The live write gate. False means every execution is refused after full
   * policy evaluation, so the refusal path stays exercised without risking
   * funds.
   */
  readonly liveExecutionEnabled: boolean;
};

export type Policy = {
  readonly version: string;
  readonly trading: TradingLimits;
  readonly x402: X402Budget;
  /** Per-capability freshness windows, for example `market.price` at 60 seconds. */
  readonly freshness: Readonly<Record<string, Seconds>>;
};

/**
 * Freshness windows, chosen from what the number is used for rather than from
 * how often the provider updates it.
 *
 * A price that decides an order size has to be seconds old. A Smart Money flow
 * figure describes the last day and is still meaningful minutes later. Treating
 * both the same either rejects good evidence or accepts a stale price.
 */
export const DEFAULT_FRESHNESS: Readonly<Record<string, Seconds>> = Object.freeze({
  "market.price": seconds(60),
  "market.orderbook": seconds(30),
  "market.metadata": seconds(3600),
  "smart_money.netflow": seconds(900),
  "onchain.subgraph": seconds(600),
});

/**
 * The starting fence.
 *
 * Small on purpose. These numbers exist to be tightened by the operator before
 * live mode, not to be a recommendation about how much anyone should trade.
 */
export function defaultPolicy(): Policy {
  return {
    version: "telt-policy-1",
    trading: {
      allowedSymbols: ["ETHUSDT", "BTCUSDT"] as readonly string[] as readonly Symbol_[],
      maxTradeNotional: fp.parse("25.00"),
      maxDailyLoss: fp.parse("50.00"),
      maxOpenExposure: fp.parse("100.00"),
      maxSlippageBps: 50,
      proposalTtl: seconds(120),
      marketDataMaxAge: seconds(60),
      minValidSources: 2,
      liveExecutionEnabled: false,
    },
    x402: {
      // A three-source run costs $0.07 against the prices observed on
      // 2026-09-07: Nansen $0.05, CoinGecko $0.01, CoinMarketCap $0.01.
      // The per-call cap sits just above the dearest single call so a provider
      // that quietly raises its price is refused rather than paid.
      maxPerCallUsdc: fp.parse("0.06"),
      maxPerRunUsdc: fp.parse("0.10"),
      maxPerDayUsdc: fp.parse("2.00"),
    },
    freshness: DEFAULT_FRESHNESS,
  };
}

/**
 * Reject a policy that cannot be enforced.
 *
 * This runs at boot. A policy with a negative cap or an empty symbol list is a
 * configuration mistake that would otherwise show up as a confusing refusal
 * much later, or worse, as a limit that never fires.
 */
export function validatePolicy(policy: Policy): void {
  const problems: string[] = [];

  if (policy.version.trim() === "") {
    problems.push("version must not be empty");
  }
  if (policy.trading.allowedSymbols.length === 0) {
    problems.push("allowedSymbols must list at least one symbol");
  }
  for (const symbol of policy.trading.allowedSymbols) {
    if (symbol !== symbol.toUpperCase() || symbol.trim() === "") {
      problems.push(`symbol ${JSON.stringify(symbol)} must be non-empty and uppercase`);
    }
  }
  if (!fp.isPositive(policy.trading.maxTradeNotional)) {
    problems.push("maxTradeNotional must be positive");
  }
  if (fp.isNegative(policy.trading.maxDailyLoss)) {
    problems.push("maxDailyLoss must not be negative");
  }
  if (!fp.isPositive(policy.trading.maxOpenExposure)) {
    problems.push("maxOpenExposure must be positive");
  }
  if (!Number.isInteger(policy.trading.maxSlippageBps) || policy.trading.maxSlippageBps < 0) {
    problems.push("maxSlippageBps must be a non-negative integer");
  }
  if (policy.trading.maxSlippageBps > 1000) {
    // 10 percent. Above this the user is not setting a slippage limit, they are
    // removing one, and it should be a deliberate edit to this file.
    problems.push("maxSlippageBps above 1000 is not a limit; set it deliberately in code");
  }
  if (policy.trading.proposalTtl <= 0) {
    problems.push("proposalTtl must be positive");
  }
  if (policy.trading.proposalTtl > 900) {
    problems.push("proposalTtl above 900 seconds outlives the price it was built from");
  }
  if (policy.trading.minValidSources < 1) {
    problems.push("minValidSources must be at least 1");
  }
  if (!fp.isPositive(policy.x402.maxPerCallUsdc)) {
    problems.push("x402.maxPerCallUsdc must be positive");
  }
  if (fp.greaterThan(policy.x402.maxPerCallUsdc, policy.x402.maxPerRunUsdc)) {
    problems.push("x402.maxPerCallUsdc must not exceed maxPerRunUsdc");
  }
  if (fp.greaterThan(policy.x402.maxPerRunUsdc, policy.x402.maxPerDayUsdc)) {
    problems.push("x402.maxPerRunUsdc must not exceed maxPerDayUsdc");
  }

  if (problems.length > 0) {
    throw new TeltDefect(`policy is not enforceable:\n  - ${problems.join("\n  - ")}`);
  }
}
