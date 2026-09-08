/**
 * Deciding what to buy next, and when to stop buying.
 *
 * A research loop that calls every provider on every request is easy to write,
 * costs the same whatever the question was, and produces three sources that
 * agree about a price nobody disputed. This planner does the opposite: it
 * spends the least it can to answer the actual question, and stops the moment
 * the answer is settled.
 *
 * Four rules drive every decision below.
 *
 * 1. **Free first.** The venue Telt would actually trade on is free to read.
 *    If that fails, nothing else is worth buying, because a trade is already
 *    impossible.
 * 2. **Refuse cheaply.** Any refusal that is already certain is issued before
 *    the next paid call, never after. There is no point spending five cents on
 *    Smart Money flows for a symbol whose price sources cannot agree.
 * 3. **Escalate only on cause.** A second price is bought because Telt needs
 *    corroboration. A third is bought only if the first two disagree. Flows are
 *    bought only when the question is whether to trade, not merely what the
 *    price is.
 * 4. **The model never escalates.** Every branch here is deterministic code
 *    over observations and budget. The model writes the thesis afterwards, from
 *    whatever evidence this planner decided was worth having.
 *
 * The planner is pure. It reports what it skipped and why, so the receipt can
 * tell the user "this cost one cent because two sources already agreed" rather
 * than leaving them to wonder what was left out.
 */

import * as fp from "../money/fixed-point.js";
import type { FixedPoint } from "../money/fixed-point.js";
import type { Refusal } from "../domain/result.js";
import { refuse } from "../domain/result.js";
import type { Instant } from "../domain/time.js";
import type { EvidenceObservation, ProviderId, Symbol_ } from "../domain/types.js";
import { evaluatePaidCall } from "../policy/engine.js";
import type { Policy } from "../policy/limits.js";
import { RECIPE_STEPS, hasSubgraphCoverage } from "./recipes.js";
import type { EvidenceKind, RecipeStep } from "./recipes.js";

/**
 * What the user actually asked for.
 *
 * `price_check` answers "what is it doing". `trade_thesis` answers "should I
 * buy". The second costs five times the first, and conflating them is how a
 * research agent quietly runs up a bill answering questions nobody asked.
 */
export type ResearchGoal = "price_check" | "trade_thesis";

/**
 * How far two independent prices may drift and still count as agreement.
 *
 * 100 bps. Spot venues genuinely differ by tens of basis points on a liquid
 * pair, and aggregator prices lag by a few seconds, so a tighter threshold
 * would manufacture conflicts. Wider would let a real dislocation through, and
 * a dislocation is exactly when a market order goes badly.
 */
export const PRICE_AGREEMENT_BPS = 100;

export type SkippedStep = {
  readonly id: string;
  readonly reason: string;
  readonly savedCost: FixedPoint;
};

export type PlannerState = {
  readonly goal: ResearchGoal;
  readonly policy: Policy;
  readonly symbol: Symbol_;
  /** Everything gathered so far this run, including failures and cache hits. */
  readonly observations: readonly EvidenceObservation[];
  /** Step ids already attempted, successful or not. Prevents retry loops. */
  readonly attempted: readonly string[];
  readonly spentThisRun: FixedPoint;
  readonly spentToday: FixedPoint;
  readonly walletConfigured: boolean;
  /**
   * True when no paid provider has a verified id for this symbol.
   *
   * There is a difference between "Telt could not get a second price" and "no
   * second price exists to get". The first is a failure worth refusing over; the
   * second is a permanent property of the symbol, and refusing forever would
   * mean Telt can only ever trade the handful of pairs somebody wrote down.
   * The run proceeds on the venue's own price and the receipt says, loudly, that
   * nothing corroborates it.
   */
  readonly allowSingleSource?: boolean;
  /** Providers known to be down. Skipped without spending an attempt. */
  readonly unhealthyProviders: readonly ProviderId[];
  readonly now: Instant;
};

export type PlannerDecision =
  | { readonly kind: "call"; readonly step: RecipeStep; readonly because: string }
  | {
      readonly kind: "sufficient";
      readonly because: string;
      readonly skipped: readonly SkippedStep[];
      /** True when the plan stopped early on budget rather than on certainty. */
      readonly limitedByBudget: boolean;
    }
  | {
      readonly kind: "insufficient";
      readonly refusal: Refusal;
      readonly skipped: readonly SkippedStep[];
    };

/**
 * The agreed normalised shape for a price observation.
 *
 * Every provider adapter must produce `{ priceUsd: "<decimal string>" }`. The
 * planner compares prices across providers, so it cannot cope with each one
 * keeping its own field name and units.
 */
export function readPrice(observation: EvidenceObservation): FixedPoint | null {
  const raw = observation.normalized["priceUsd"];
  if (typeof raw !== "string") {
    return null;
  }
  try {
    return fp.parse(raw);
  } catch {
    return null;
  }
}

function isUsable(observation: EvidenceObservation, now: Instant): boolean {
  return observation.status === "valid" && now < observation.freshnessDeadline;
}

function kindOf(observation: EvidenceObservation): EvidenceKind | null {
  return RECIPE_STEPS.find((step) => step.endpointId === observation.endpointId)?.kind ?? null;
}

function usableProvidersOfKind(
  state: PlannerState,
  kind: EvidenceKind,
): ReadonlySet<ProviderId> {
  const providers = new Set<ProviderId>();
  for (const observation of state.observations) {
    if (isUsable(observation, state.now) && kindOf(observation) === kind) {
      providers.add(observation.provider);
    }
  }
  return providers;
}

export type PriceAgreement =
  | { readonly kind: "insufficient_prices" }
  | { readonly kind: "agree"; readonly spreadBps: number }
  | { readonly kind: "conflict"; readonly spreadBps: number };

/**
 * Do the prices Telt has bought so far tell the same story?
 *
 * Measured as the spread between the extremes over the lowest price, so adding
 * a third source that sits between two others does not flatter the result.
 */
export function assessPriceAgreement(state: PlannerState): PriceAgreement {
  const prices: FixedPoint[] = [];
  for (const observation of state.observations) {
    if (!isUsable(observation, state.now) || kindOf(observation) !== "price") {
      continue;
    }
    const price = readPrice(observation);
    if (price !== null && fp.isPositive(price)) {
      prices.push(price);
    }
  }
  if (prices.length < 2) {
    return { kind: "insufficient_prices" };
  }

  let lowest = prices[0] as FixedPoint;
  let highest = prices[0] as FixedPoint;
  for (const price of prices) {
    lowest = fp.min(lowest, price);
    highest = fp.max(highest, price);
  }

  // Basis points of the lower price, floored, so a borderline spread reads as
  // agreement only when it genuinely is one.
  const spread = fp.subtract(highest, lowest);
  const spreadBpsFixed = fp.divide(fp.multiply(spread, fp.parse("10000")), lowest, 0, "floor");
  const spreadBps = Number(spreadBpsFixed.atoms);

  return spreadBps > PRICE_AGREEMENT_BPS
    ? { kind: "conflict", spreadBps }
    : { kind: "agree", spreadBps };
}

function affordable(state: PlannerState, step: RecipeStep): boolean {
  if (fp.isZero(step.estimatedCost)) {
    return true;
  }
  return evaluatePaidCall({
    policy: state.policy,
    quotedUsdc: step.estimatedCost,
    alreadySpentThisRun: state.spentThisRun,
    alreadySpentToday: state.spentToday,
    walletConfigured: state.walletConfigured,
  }).ok;
}

function available(state: PlannerState, step: RecipeStep): boolean {
  return (
    !state.attempted.includes(step.id) && !state.unhealthyProviders.includes(step.provider)
  );
}

function skip(step: RecipeStep, reason: string): SkippedStep {
  return { id: step.id, reason, savedCost: step.estimatedCost };
}

/**
 * Why a paid step could not be taken, in the operator's terms.
 *
 * "The research budget would not cover it" and "there is no research wallet"
 * are the same refusal to `evaluatePaidCall` and completely different problems
 * to the person reading the receipt. Reporting the first when the second is
 * true sends someone to check spend caps that are untouched.
 */
function unaffordableReason(state: PlannerState): string {
  return state.walletConfigured
    ? "the research budget would not cover it"
    : "no research wallet is configured";
}

/**
 * Everything that was never called, with the reason.
 *
 * Built at the moment the plan stops so the receipt can show the road not
 * taken. "Nansen Smart Money, not needed: two sources already agreed, saved
 * $0.05" is the line that makes the cost of a run legible.
 */
function skippedFrom(state: PlannerState, reasons: ReadonlyMap<string, string>): SkippedStep[] {
  const skipped: SkippedStep[] = [];
  for (const step of RECIPE_STEPS) {
    if (state.attempted.includes(step.id)) {
      continue;
    }
    const reason =
      reasons.get(step.id) ??
      (state.unhealthyProviders.includes(step.provider)
        ? `${step.provider} is unavailable`
        : !affordable(state, step)
          ? unaffordableReason(state)
          : "not needed for this question");
    skipped.push(skip(step, reason));
  }
  return skipped;
}

const BINANCE_PRICE = "binance.price";
const TIER_ONE_PRICES = ["coingecko.price", "coinmarketcap.price"] as const;
const NANSEN_FLOW = "nansen.netflow";
const GRAPH_POOL = "thegraph.pool";

function requireStep(id: string): RecipeStep {
  const step = RECIPE_STEPS.find((candidate) => candidate.id === id);
  if (step === undefined) {
    throw new Error(`recipe step ${id} is missing`);
  }
  return step;
}

/**
 * The next thing to do.
 *
 * Called in a loop by the orchestrator: decide, execute, fold the result back
 * into the state, decide again. Each call is a pure function of the state, so
 * the whole escalation ladder is testable without a network.
 */
export function decideNextStep(state: PlannerState): PlannerDecision {
  const reasons = new Map<string, string>();

  // ---- Rule 1: the venue price is free, and nothing else matters without it.
  const binance = requireStep(BINANCE_PRICE);
  if (available(state, binance)) {
    return {
      kind: "call",
      step: binance,
      because: "Reading the venue price first. It is free, and it is the price any order would be sized from.",
    };
  }

  const usablePriceProviders = usableProvidersOfKind(state, "price");
  const haveVenuePrice = state.observations.some(
    (observation) => observation.provider === "binance" && isUsable(observation, state.now),
  );

  // ---- Rule 2: refuse cheaply. A trade is already impossible, so buy nothing.
  if (!haveVenuePrice) {
    return {
      kind: "insufficient",
      refusal: refuse(
        "PROVIDER_UNAVAILABLE",
        "Telt could not read a current price from the exchange, so it stopped before buying any paid research.",
        { symbol: state.symbol, spent: fp.format(state.spentThisRun) },
      ).error,
      skipped: skippedFrom(
        state,
        new Map(
          RECIPE_STEPS.map((step) => [
            step.id,
            "skipped: the exchange price was unavailable, so no trade was possible either way",
          ]),
        ),
      ),
    };
  }

  // ---- Rule 3: corroborate the price with one independent source.
  if (usablePriceProviders.size < 2) {
    for (const id of TIER_ONE_PRICES) {
      const step = requireStep(id);
      if (!available(state, step)) {
        continue;
      }
      if (!affordable(state, step)) {
        break;
      }
      return {
        kind: "call",
        step,
        because: "Buying one independent price so the number behind any order is not a single venue's opinion.",
      };
    }

    // No paid source can ever cover this symbol. Proceed, and say so.
    if (state.allowSingleSource === true) {
      for (const id of TIER_ONE_PRICES) {
        reasons.set(id, "no verified id for this symbol, so no independent price can be bought");
      }
      reasons.set(NANSEN_FLOW, "no verified contract for this symbol");
      reasons.set(GRAPH_POOL, "no published subgraph covers this symbol");
      return {
        kind: "sufficient",
        because:
          "UNCORROBORATED: only the exchange's own price is available for this symbol, and no independent source can be bought to check it.",
        skipped: skippedFrom(state, reasons),
        limitedByBudget: false,
      };
    }

    // Nothing left to try, or nothing affordable. Stop rather than escalate to
    // the dearer tiers: flows cannot fix a price Telt could not corroborate.
    const blocked = TIER_ONE_PRICES.some(
      (id) => available(state, requireStep(id)) && !affordable(state, requireStep(id)),
    );

    // Three different situations, three different things for the reader to do:
    // fund a wallet, raise a cap, or wait for a provider to come back.
    const [code, detail] = !blocked
      ? ([
          "INSUFFICIENT_EVIDENCE",
          "No independent price source was available, so Telt has only the exchange's own price and will not propose a trade on it.",
        ] as const)
      : !state.walletConfigured
        ? ([
            "X402_WALLET_NOT_CONFIGURED",
            "Telt has no research wallet, so it cannot buy a second price source and will not propose a trade on the exchange's own price alone.",
          ] as const)
        : ([
            "X402_RUN_BUDGET_EXHAUSTED",
            "The research budget ran out before a second price source could be bought, so Telt has only the exchange's own price.",
          ] as const);

    return {
      kind: "insufficient",
      refusal: refuse(code, detail, {
        sources: usablePriceProviders.size,
        required: 2,
        spent: fp.format(state.spentThisRun),
      }).error,
      skipped: skippedFrom(state, reasons),
    };
  }

  // ---- Rule 4: a disagreement is worth paying to resolve, once.
  const agreement = assessPriceAgreement(state);
  if (agreement.kind === "conflict") {
    for (const id of TIER_ONE_PRICES) {
      const step = requireStep(id);
      if (available(state, step) && affordable(state, step)) {
        return {
          kind: "call",
          step,
          because: `The two prices so far differ by ${String(agreement.spreadBps)} bps. Buying a third to see which is the outlier.`,
        };
      }
    }
    // Three sources and still no agreement, or no budget to ask a third. Either
    // way the price is genuinely unsettled and this is not a market to send a
    // market order into. Stop before buying flows.
    return {
      kind: "insufficient",
      refusal: refuse(
        "EVIDENCE_CONFLICT_UNRESOLVED",
        `The price sources disagree by ${String(agreement.spreadBps)} bps and Telt could not settle it, so it will not propose a trade.`,
        { spreadBps: agreement.spreadBps, toleranceBps: PRICE_AGREEMENT_BPS },
      ).error,
      skipped: skippedFrom(
        state,
        new Map([
          [NANSEN_FLOW, "not bought: the price sources disagreed, so flows could not have settled it"],
          [GRAPH_POOL, "not bought: the price sources disagreed"],
        ]),
      ),
    };
  }

  // ---- Rule 5: a price question is now answered. Stop.
  if (state.goal === "price_check") {
    for (const id of [NANSEN_FLOW, GRAPH_POOL]) {
      reasons.set(id, "not needed: you asked what the price is doing, not whether to trade");
    }
    return {
      kind: "sufficient",
      because:
        agreement.kind === "agree"
          ? `Two independent sources agree within ${String(agreement.spreadBps)} bps.`
          : "The price is corroborated.",
      skipped: skippedFrom(state, reasons),
      limitedByBudget: false,
    };
  }

  // ---- Rule 6: whether to trade needs evidence about conviction, not price.
  const haveFlow = usableProvidersOfKind(state, "flow").size > 0;
  const nansen = requireStep(NANSEN_FLOW);
  if (!haveFlow && available(state, nansen)) {
    if (affordable(state, nansen)) {
      return {
        kind: "call",
        step: nansen,
        because: "The price is settled, so the open question is conviction. Buying Smart Money flows, the dearest call, last.",
      };
    }
    reasons.set(NANSEN_FLOW, unaffordableReason(state));
    reasons.set(GRAPH_POOL, "not reached: the budget was already spent");
    return {
      kind: "sufficient",
      because:
        "The price is corroborated, but the budget would not cover Smart Money flows. Any thesis from this run rests on price alone and says so.",
      skipped: skippedFrom(state, reasons),
      limitedByBudget: true,
    };
  }

  // ---- Rule 7: pool detail, only where a subgraph actually covers the pair.
  const graph = requireStep(GRAPH_POOL);
  if (available(state, graph) && affordable(state, graph)) {
    if (hasSubgraphCoverage(state.symbol)) {
      return {
        kind: "call",
        step: graph,
        because: "A published subgraph covers this pair, so pool liquidity is worth one more cent.",
      };
    }
    reasons.set(GRAPH_POOL, `not bought: no published subgraph covers ${state.symbol}`);
  }

  return {
    kind: "sufficient",
    because: haveFlow
      ? `Price corroborated within ${String(agreement.kind === "agree" ? agreement.spreadBps : 0)} bps and flow evidence is in hand.`
      : "Every source worth buying for this question has been tried.",
    skipped: skippedFrom(state, reasons),
    limitedByBudget: false,
  };
}

/**
 * Run the ladder to completion against a caller-supplied executor.
 *
 * The executor is the only impure part. It performs one step and returns the
 * observation plus what it actually cost, and the loop folds that back in and
 * asks again. `maxSteps` is a hard stop so a misbehaving executor that never
 * marks a step attempted cannot spin.
 */
export type StepExecutor = (
  step: RecipeStep,
) => Promise<{ readonly observation: EvidenceObservation; readonly cost: FixedPoint }>;

export type PlanOutcome = {
  readonly observations: readonly EvidenceObservation[];
  readonly spent: FixedPoint;
  readonly steps: readonly { readonly id: string; readonly because: string }[];
  readonly decision: Extract<PlannerDecision, { kind: "sufficient" | "insufficient" }>;
};

export async function runPlan(
  initial: PlannerState,
  execute: StepExecutor,
  maxSteps = RECIPE_STEPS.length,
): Promise<PlanOutcome> {
  let state = initial;
  const taken: { id: string; because: string }[] = [];

  for (let iteration = 0; iteration < maxSteps; iteration += 1) {
    const decision = decideNextStep(state);
    if (decision.kind !== "call") {
      return {
        observations: state.observations,
        spent: state.spentThisRun,
        steps: taken,
        decision,
      };
    }

    taken.push({ id: decision.step.id, because: decision.because });
    const result = await execute(decision.step);

    state = {
      ...state,
      observations: [...state.observations, result.observation],
      attempted: [...state.attempted, decision.step.id],
      spentThisRun: fp.add(state.spentThisRun, result.cost),
      spentToday: fp.add(state.spentToday, result.cost),
    };
  }

  const final = decideNextStep(state);
  return {
    observations: state.observations,
    spent: state.spentThisRun,
    steps: taken,
    decision:
      final.kind === "call"
        ? {
            kind: "sufficient",
            because: "The step limit was reached.",
            skipped: [],
            limitedByBudget: false,
          }
        : final,
  };
}
