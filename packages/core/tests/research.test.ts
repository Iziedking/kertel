import { describe, expect, it } from "vitest";

import * as fp from "../src/money/fixed-point.js";
import type { EvidenceObservation, ProviderId } from "../src/domain/types.js";
import { defaultPolicy } from "../src/policy/limits.js";
import {
  assessPriceAgreement,
  decideNextStep,
  PRICE_AGREEMENT_BPS,
  readPrice,
  runPlan,
} from "../src/research/planner.js";
import type { PlannerState, ResearchGoal } from "../src/research/planner.js";
import { RECIPE_STEPS, stepById } from "../src/research/recipes.js";
import type { RecipeStep } from "../src/research/recipes.js";
import { at, ETHUSDT, observation, policy, T0 } from "./builders.js";

/** A price observation from a named provider, fresh unless a test says otherwise. */
function priceFrom(provider: ProviderId, priceUsd: string, overrides = {}): EvidenceObservation {
  const endpointId =
    provider === "binance"
      ? "binance:ticker"
      : provider === "coingecko"
        ? "coingecko:simple/price"
        : "coinmarketcap:quotes/latest";
  return observation({
    provider,
    endpointId,
    capability: "market.price",
    normalized: { priceUsd },
    freshnessDeadline: at(120),
    ...overrides,
  });
}

function flowFrom(provider: ProviderId = "nansen"): EvidenceObservation {
  return observation({
    provider,
    endpointId: "nansen:smart-money/netflow",
    capability: "smart_money.netflow",
    normalized: { netflowUsd: "1200000", window: "24h" },
    freshnessDeadline: at(900),
    costUsdc: fp.parse("0.05"),
  });
}

function state(overrides: Partial<PlannerState> = {}): PlannerState {
  return {
    goal: "trade_thesis",
    policy: policy(),
    symbol: ETHUSDT,
    observations: [],
    attempted: [],
    spentThisRun: fp.parse("0.00"),
    spentToday: fp.parse("0.00"),
    walletConfigured: true,
    unhealthyProviders: [],
    now: T0,
    ...overrides,
  };
}

/**
 * A fake executor that records what was called and charges the recipe price.
 * The whole point of the planner is which of these calls never happen.
 */
function executor(prices: Readonly<Record<string, string>>) {
  const called: string[] = [];
  const execute = async (step: RecipeStep) => {
    called.push(step.id);
    const price = prices[step.id];
    const obs =
      step.kind === "price"
        ? priceFrom(step.provider, price ?? "2431.17", { costUsdc: step.estimatedCost })
        : step.kind === "flow"
          ? flowFrom(step.provider)
          : observation({
              provider: step.provider,
              endpointId: step.endpointId,
              capability: step.capability,
              costUsdc: step.estimatedCost,
              freshnessDeadline: at(600),
            });
    return { observation: obs, cost: step.estimatedCost };
  };
  return { called, execute };
}

describe("the recipe catalogue", () => {
  it("has a price on every step and a reason a user could read", () => {
    for (const step of RECIPE_STEPS) {
      expect(step.rationale.length, step.id).toBeGreaterThan(20);
      expect(fp.isNegative(step.estimatedCost), step.id).toBe(false);
    }
  });

  it("keeps the venue price free and Smart Money the dearest call", () => {
    expect(fp.format(stepById("binance.price")?.estimatedCost ?? fp.parse("1"))).toBe("0.00");
    const nansen = stepById("nansen.netflow")?.estimatedCost;
    for (const step of RECIPE_STEPS) {
      if (step.id === "nansen.netflow") continue;
      expect(fp.compare(step.estimatedCost, nansen ?? fp.parse("0")), step.id).toBeLessThan(0);
    }
  });
});

describe("reading and comparing prices", () => {
  it("parses the agreed normalised field", () => {
    expect(fp.format(readPrice(priceFrom("binance", "2431.17")) ?? fp.parse("0"))).toBe("2431.17");
  });

  it("returns null rather than guessing at an unexpected shape", () => {
    expect(readPrice(observation({ normalized: { price: 2431.17 } }))).toBeNull();
    expect(readPrice(observation({ normalized: { priceUsd: "not a number" } }))).toBeNull();
  });

  it("needs two prices before it will call anything agreement", () => {
    expect(assessPriceAgreement(state({ observations: [priceFrom("binance", "2431.17")] })).kind).toBe(
      "insufficient_prices",
    );
  });

  it("measures the spread between the extremes, not between neighbours", () => {
    const assessment = assessPriceAgreement(
      state({
        observations: [
          priceFrom("binance", "2400.00"),
          priceFrom("coingecko", "2412.00"),
          priceFrom("coinmarketcap", "2406.00"),
        ],
      }),
    );
    // 2400 to 2412 is 50 bps of the lower price. A middle source must not
    // flatter that number.
    expect(assessment.kind).toBe("agree");
    if (assessment.kind !== "insufficient_prices") {
      expect(assessment.spreadBps).toBe(50);
    }
  });

  it("calls a spread past the tolerance a conflict", () => {
    const assessment = assessPriceAgreement(
      state({ observations: [priceFrom("binance", "2400.00"), priceFrom("coingecko", "2450.00")] }),
    );
    expect(assessment.kind).toBe("conflict");
    if (assessment.kind === "conflict") {
      expect(assessment.spreadBps).toBeGreaterThan(PRICE_AGREEMENT_BPS);
    }
  });

  it("ignores a stale price when judging agreement", () => {
    const assessment = assessPriceAgreement(
      state({
        now: at(200),
        observations: [priceFrom("binance", "2400.00", { freshnessDeadline: at(300) }), priceFrom("coingecko", "2450.00")],
      }),
    );
    expect(assessment.kind).toBe("insufficient_prices");
  });
});

describe("the escalation ladder", () => {
  it("always reads the free venue price first", () => {
    const decision = decideNextStep(state());
    expect(decision.kind).toBe("call");
    if (decision.kind === "call") {
      expect(decision.step.id).toBe("binance.price");
      expect(fp.format(decision.step.estimatedCost)).toBe("0.00");
    }
  });

  it("buys one independent price once the venue price is in", () => {
    const decision = decideNextStep(
      state({ attempted: ["binance.price"], observations: [priceFrom("binance", "2431.17")] }),
    );
    expect(decision.kind).toBe("call");
    if (decision.kind === "call") {
      expect(decision.step.id).toBe("coingecko.price");
    }
  });

  it("answers a price question for one cent and never touches Smart Money", async () => {
    const { called, execute } = await Promise.resolve(
      executor({ "coingecko.price": "2433.00" }),
    );
    const outcome = await runPlan(state({ goal: "price_check" }), execute);

    expect(called).toEqual(["binance.price", "coingecko.price"]);
    expect(fp.format(outcome.spent)).toBe("0.01");
    expect(outcome.decision.kind).toBe("sufficient");

    const nansenSkip = outcome.decision.kind === "sufficient"
      ? outcome.decision.skipped.find((s) => s.id === "nansen.netflow")
      : undefined;
    expect(nansenSkip?.reason).toContain("not whether to trade");
    expect(fp.format(nansenSkip?.savedCost ?? fp.parse("0"))).toBe("0.05");
  });

  it("escalates to Smart Money only when the question is whether to trade", async () => {
    const { called, execute } = executor({ "coingecko.price": "2433.00" });
    const outcome = await runPlan(state({ goal: "trade_thesis" }), execute);

    expect(called).toEqual(["binance.price", "coingecko.price", "nansen.netflow"]);
    expect(fp.format(outcome.spent)).toBe("0.06");
    expect(outcome.decision.kind).toBe("sufficient");
  });

  it("buys a third price only when the first two disagree", async () => {
    const { called, execute } = executor({ "coingecko.price": "2500.00", "coinmarketcap.price": "2432.00" });
    const outcome = await runPlan(state({ goal: "trade_thesis" }), execute);

    // 2431.17 against 2500.00 is about 283 bps, so the tiebreak is earned.
    expect(called).toContain("coinmarketcap.price");
    // CoinMarketCap lands next to Binance, so CoinGecko is the outlier and the
    // spread across all three still exceeds the tolerance: no trade, and no
    // five cents spent finding that out.
    expect(called).not.toContain("nansen.netflow");
    expect(outcome.decision.kind).toBe("insufficient");
    if (outcome.decision.kind === "insufficient") {
      expect(outcome.decision.refusal.code).toBe("EVIDENCE_CONFLICT_UNRESOLVED");
    }
    expect(fp.format(outcome.spent)).toBe("0.02");
  });

  it("does not buy a tiebreak when the first two already agree", async () => {
    const { called } = executor({});
    void called;
    const decision = decideNextStep(
      state({
        goal: "trade_thesis",
        attempted: ["binance.price", "coingecko.price"],
        observations: [priceFrom("binance", "2431.17"), priceFrom("coingecko", "2433.00")],
      }),
    );
    expect(decision.kind).toBe("call");
    if (decision.kind === "call") {
      expect(decision.step.id).toBe("nansen.netflow");
    }
  });
});

describe("refusing before spending", () => {
  it("spends nothing when the exchange price is unavailable", async () => {
    const execute = async (step: RecipeStep) => ({
      observation: observation({
        provider: step.provider,
        endpointId: step.endpointId,
        status: "unavailable" as const,
        costUsdc: fp.parse("0.00"),
      }),
      cost: fp.parse("0.00"),
    });
    const outcome = await runPlan(state({ goal: "trade_thesis" }), execute);

    expect(fp.format(outcome.spent)).toBe("0.00");
    expect(outcome.decision.kind).toBe("insufficient");
    if (outcome.decision.kind === "insufficient") {
      expect(outcome.decision.refusal.code).toBe("PROVIDER_UNAVAILABLE");
    }
    expect(outcome.steps.map((s) => s.id)).toEqual(["binance.price"]);
  });

  it("refuses without paying when no wallet is configured", () => {
    const decision = decideNextStep(
      state({
        walletConfigured: false,
        attempted: ["binance.price"],
        observations: [priceFrom("binance", "2431.17")],
      }),
    );
    expect(decision.kind).toBe("insufficient");
    if (decision.kind === "insufficient") {
      // Not a budget problem: the budget is untouched. Reporting one would send
      // the reader to check caps that are fine while a key is missing.
      expect(decision.refusal.code).toBe("X402_WALLET_NOT_CONFIGURED");
      expect(decision.skipped.every((entry) => !entry.reason.includes("budget"))).toBe(true);
    }
  });

  it("does call it a budget problem when there is a wallet and no room", () => {
    const decision = decideNextStep(
      state({
        walletConfigured: true,
        attempted: ["binance.price"],
        observations: [priceFrom("binance", "2431.17")],
        // Nothing left under the daily cap.
        spentToday: fp.parse("2.00"),
      }),
    );

    expect(decision.kind).toBe("insufficient");
    if (decision.kind === "insufficient") {
      expect(decision.refusal.code).toBe("X402_RUN_BUDGET_EXHAUSTED");
    }
  });

  it("stops on budget rather than half-buying the dearest call", () => {
    const decision = decideNextStep(
      state({
        goal: "trade_thesis",
        attempted: ["binance.price", "coingecko.price"],
        observations: [priceFrom("binance", "2431.17"), priceFrom("coingecko", "2433.00")],
        spentThisRun: fp.parse("0.09"),
        spentToday: fp.parse("0.09"),
      }),
    );
    expect(decision.kind).toBe("sufficient");
    if (decision.kind === "sufficient") {
      expect(decision.limitedByBudget).toBe(true);
      expect(decision.because).toContain("rests on price alone");
    }
  });

  it("stops when the day's budget is gone, whatever this run has spent", () => {
    const decision = decideNextStep(
      state({
        attempted: ["binance.price"],
        observations: [priceFrom("binance", "2431.17")],
        spentToday: fp.parse("2.00"),
      }),
    );
    expect(decision.kind).toBe("insufficient");
    if (decision.kind === "insufficient") {
      expect(decision.refusal.code).toBe("X402_RUN_BUDGET_EXHAUSTED");
    }
  });
});

describe("provider health and repetition", () => {
  it("routes around an unhealthy provider without spending an attempt on it", () => {
    const decision = decideNextStep(
      state({
        attempted: ["binance.price"],
        observations: [priceFrom("binance", "2431.17")],
        unhealthyProviders: ["coingecko"],
      }),
    );
    expect(decision.kind).toBe("call");
    if (decision.kind === "call") {
      expect(decision.step.id).toBe("coinmarketcap.price");
    }
  });

  it("never calls the same step twice", async () => {
    const { called, execute } = executor({ "coingecko.price": "2433.00" });
    await runPlan(state({ goal: "trade_thesis" }), execute);
    expect(new Set(called).size).toBe(called.length);
  });

  it("reuses evidence that is still fresh instead of buying it again", () => {
    // A second question about the same symbol inside the freshness window is
    // free: the planner sees usable observations and asks for the next thing.
    const decision = decideNextStep(
      state({
        goal: "trade_thesis",
        attempted: ["binance.price", "coingecko.price", "nansen.netflow"],
        observations: [priceFrom("binance", "2431.17"), priceFrom("coingecko", "2433.00"), flowFrom()],
      }),
    );
    expect(decision.kind).toBe("sufficient");
  });

  it("re-buys once the evidence has gone stale", () => {
    const decision = decideNextStep(
      state({
        goal: "trade_thesis",
        now: at(300),
        attempted: [],
        observations: [priceFrom("binance", "2431.17"), priceFrom("coingecko", "2433.00")],
      }),
    );
    expect(decision.kind).toBe("call");
    if (decision.kind === "call") {
      expect(decision.step.id).toBe("binance.price");
    }
  });

  it("skips The Graph when no subgraph covers the pair, and says so", async () => {
    const { execute } = executor({ "coingecko.price": "2433.00" });
    const outcome = await runPlan(state({ goal: "trade_thesis" }), execute);
    if (outcome.decision.kind !== "sufficient") {
      throw new Error("expected the plan to be sufficient");
    }
    const graph = outcome.decision.skipped.find((s) => s.id === "thegraph.pool");
    expect(graph?.reason).toContain("no published subgraph");
  });
});

describe("what the receipt can say", () => {
  it("reports every skipped step with a reason and the money it saved", async () => {
    const { execute } = executor({ "coingecko.price": "2433.00" });
    const outcome = await runPlan(state({ goal: "price_check" }), execute);
    if (outcome.decision.kind !== "sufficient") {
      throw new Error("expected the plan to be sufficient");
    }

    const saved = outcome.decision.skipped.reduce(
      (total, step) => fp.add(total, step.savedCost),
      fp.parse("0.00"),
    );
    // CoinMarketCap at a cent, Nansen at five, The Graph at a cent.
    // Back to 0.07: Nansen 0.05, the second price 0.01, the subgraph 0.01.
    // The OpenPulse steps were removed after paying for them showed the
    // provider does not index the chains Telt trades on.
    expect(fp.format(saved)).toBe("0.07");
    for (const step of outcome.decision.skipped) {
      expect(step.reason.length, step.id).toBeGreaterThan(10);
    }
  });

  it("records why each call was made, in order", async () => {
    const { execute } = executor({ "coingecko.price": "2433.00" });
    const outcome = await runPlan(state({ goal: "trade_thesis" }), execute);
    expect(outcome.steps.map((s) => s.id)).toEqual([
      "binance.price",
      "coingecko.price",
      "nansen.netflow",
    ]);
    expect(outcome.steps[0]?.because).toContain("free");
    expect(outcome.steps[2]?.because).toContain("last");
  });
});

const GOALS: readonly ResearchGoal[] = ["price_check", "trade_thesis"];

describe("cost ceiling", () => {
  it.each(GOALS)("never spends more than the run budget for goal %s", async (goal) => {
    const { execute } = executor({ "coingecko.price": "2600.00", "coinmarketcap.price": "2700.00" });
    const outcome = await runPlan(state({ goal }), execute);
    expect(fp.compare(outcome.spent, defaultPolicy().x402.maxPerRunUsdc)).toBeLessThanOrEqual(0);
  });
});
