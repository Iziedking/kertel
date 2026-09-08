/**
 * The complete catalogue of calls Telt can make.
 *
 * This list is the entire attack surface of the research loop. There is no code
 * path anywhere that turns a WhatsApp message or a model output into a URL, so
 * a prompt injection cannot make Telt pay an endpoint that is not written
 * here. Adding a step is a deliberate edit with a price next to it.
 *
 * Steps are grouped into tiers by what they cost and what they are worth:
 *
 *   Tier 0  free      Binance public market data, and the operator's own
 *                     Binance Agentic Wallet signals. Always tried first.
 *   Tier 1  $0.01     One independent market cross-check. Proves the price
 *                     Telt is about to size an order from is not one
 *                     venue's opinion.
 *   Tier 2  $0.05     Nansen Smart Money flows. The only evidence that speaks
 *                     to conviction rather than price, and the dearest call in
 *                     the system, so it is bought last and only when the
 *                     cheaper tiers have not already settled the question.
 *   Tier 3  $0.01     Pool-level onchain detail. Opt-in, and only for symbols
 *                     with a known subgraph.
 *
 * Prices were read from live 402 challenges on 2026-09-07 and re-verified by
 * `npm run probe:providers`. They are estimates for planning; the amount
 * actually approved always comes from the live challenge.
 */

import * as fp from "../money/fixed-point.js";
import type { FixedPoint } from "../money/fixed-point.js";
import { seconds } from "../domain/time.js";
import type { Seconds } from "../domain/time.js";
import type { ProviderId, Symbol_ } from "../domain/types.js";

export type Tier = 0 | 1 | 2 | 3;

/**
 * What a step contributes.
 *
 * The planner counts these, not raw observations. Two prices from two
 * providers corroborate each other; a price and a market-cap figure from the
 * same provider do not.
 */
export type EvidenceKind = "price" | "flow" | "context" | "onchain" | "sentiment" | "technical";

export type RecipeStep = {
  readonly id: string;
  readonly provider: ProviderId;
  readonly capability: string;
  readonly endpointId: string;
  readonly kind: EvidenceKind;
  readonly tier: Tier;
  /** Planning estimate. The live challenge decides what is actually approved. */
  readonly estimatedCost: FixedPoint;
  readonly freshness: Seconds;
  /** Written into the receipt so the user can see why a call was made. */
  readonly rationale: string;
};

const FREE = fp.parse("0.00");
const CHEAP = fp.parse("0.01");
const NANSEN = fp.parse("0.05");

/*
 * All three OpenPulse steps were written and then removed before shipping, and
 * the reasons are worth keeping because each was found by paying:
 *
 * - The sentiment endpoint charges, takes the money, and answers 401. Verified
 *   on 2026-09-08 with a real payment. An endpoint that does that is not merely
 *   useless here, it is dangerous: Telt treats a signed-but-unconfirmed payment
 *   as X402_PAYMENT_UNKNOWN and engages the kill switch, so leaving it in the
 *   recipe would have stopped the agent on every full research run.
 * - The OHLCV candles endpoint was never paid for, and after the sentiment result
 *   an unverified endpoint from the same provider is not something to put in
 *   the path of a live trade on the strength of a catalogue entry.
 *
 * - The safety endpoint answers, and answers wrongly for anything Telt trades.
 *   Asked about WETH on Base it returned grade F, "Not a smart contract", "No
 *   liquidity pool found", "0 holders" and "created less than 24h ago" — for
 *   one of the most liquid contracts in existence. Its catalogue declares Base
 *   only as the network it is PAID on and never says which chain it indexes,
 *   and the domain is openpulsechain. A Base-indexing API does not describe
 *   WETH that way. Wired into the recipe it would have graded every
 *   Binance-listed token F with zero liquidity, and the reasoning layer would
 *   then have correctly refused every trade for ever — a failure that would
 *   have looked like caution rather than like a bug.
 *
 * The three adapters remain in @telt/providers, unwired, because the code is
 * correct and only the provider is wrong. If a paid source is added here again,
 * the bar is the one this episode set: pay for it, and check the answer against
 * something already known to be true. A 402 proves an endpoint will take your
 * money; a well-formed payload proves nothing about whether it is about the
 * asset you asked for.
 */

/**
 * Every step, in the order the planner prefers within a tier.
 *
 * Within tier 1 the two market cross-checks are interchangeable, so the
 * planner takes whichever is healthy and has not already been tried. Using
 * both is only worth it as a tiebreak when the first one disagrees with
 * Binance, and the planner treats that as a separate, earned escalation.
 */
export const RECIPE_STEPS: readonly RecipeStep[] = Object.freeze([
  {
    id: "binance.price",
    provider: "binance",
    capability: "market.price",
    endpointId: "binance:ticker",
    kind: "price",
    tier: 0,
    estimatedCost: FREE,
    freshness: seconds(60),
    rationale: "The venue the order would actually be placed on. Free, and the price the proposal is sized from.",
  },
  {
    id: "coingecko.price",
    provider: "coingecko",
    capability: "market.price",
    endpointId: "coingecko:simple/price",
    kind: "price",
    tier: 1,
    estimatedCost: CHEAP,
    freshness: seconds(120),
    rationale: "An independent price, so the number behind the order is not one venue's opinion.",
  },
  {
    id: "coinmarketcap.price",
    provider: "coinmarketcap",
    capability: "market.price",
    endpointId: "coinmarketcap:quotes/latest",
    kind: "price",
    tier: 1,
    estimatedCost: CHEAP,
    freshness: seconds(120),
    rationale: "A second independent price. Bought only to break a disagreement between the first two.",
  },
  {
    id: "nansen.netflow",
    provider: "nansen",
    capability: "smart_money.netflow",
    endpointId: "nansen:smart-money/netflow",
    kind: "flow",
    tier: 2,
    estimatedCost: NANSEN,
    freshness: seconds(900),
    rationale: "Where tracked wallets moved money recently. The only evidence here that speaks to conviction rather than price.",
  },
  {
    id: "thegraph.pool",
    provider: "thegraph",
    capability: "onchain.subgraph",
    endpointId: "thegraph:subgraph/pool",
    kind: "onchain",
    tier: 3,
    estimatedCost: CHEAP,
    freshness: seconds(600),
    rationale: "Pool-level liquidity and volume for the pair, when a published subgraph covers it.",
  },
]);

export function stepById(id: string): RecipeStep | undefined {
  return RECIPE_STEPS.find((step) => step.id === id);
}

/**
 * Symbols with a subgraph worth querying.
 *
 * Empty until a specific subgraph has been chosen and its query template
 * written and tested. An empty map is the honest state: tier 3 simply never
 * runs, and the receipt says the source is unavailable rather than implying
 * onchain evidence that was never fetched.
 */
export const SUBGRAPH_COVERAGE: Readonly<Record<string, string>> = Object.freeze({});

export function hasSubgraphCoverage(symbol: Symbol_): boolean {
  return Object.prototype.hasOwnProperty.call(SUBGRAPH_COVERAGE, symbol);
}

/** Cheapest possible full escalation, for the budget message shown before spending. */
export function estimatedCostThrough(tier: Tier): FixedPoint {
  return RECIPE_STEPS.filter((step) => step.tier <= tier && step.id !== "coinmarketcap.price")
    .reduce((total, step) => fp.add(total, step.estimatedCost), FREE);
}
