import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import * as fp from "@telt/core/money";
import { fixedClock, instant } from "@telt/core/domain";
import type { EvidenceId, PaymentAttemptId, Symbol_ } from "@telt/core/domain";
import { defaultPolicy } from "@telt/core/policy";
import { RECIPE_STEPS, runPlan, stepById } from "@telt/core/research";
import type { PlannerState, RecipeStep } from "@telt/core/research";
import { createFixtureX402Client } from "@telt/x402";
import type { FixtureExchange } from "@telt/x402";

import { makeStepExecutor } from "../src/executor.js";
import { instrumentFor } from "../src/symbols.js";

const ETH = instrumentFor("ETHUSDT" as Symbol_);
if (ETH === undefined) {
  throw new Error("ETHUSDT is missing from the instrument table");
}

const NOW = instant(1_788_744_170_000);

/** Real challenges, captured free from the live providers on 2026-09-07. */
function challengeText(name: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../../../fixtures/x402/live-quotes/${name}`, import.meta.url)),
    "utf8",
  );
}

const sha256 = (input: string): string => createHash("sha256").update(input).digest("hex");

const BINANCE_BODY = JSON.stringify({
  symbol: "ETHUSDT",
  priceChangePercent: "0.503",
  lastPrice: "2505.65000000",
  bidPrice: "2505.65000000",
  askPrice: "2505.66000000",
  quoteVolume: "542236234.49768800",
  closeTime: 1788744167977,
});

const COINGECKO_BODY = JSON.stringify({
  ethereum: { usd: 2505.66, usd_24h_change: 0.503, last_updated_at: 1788744167 },
});

const COINMARKETCAP_BODY = JSON.stringify({
  status: { error_code: 0 },
  data: {
    "1027": {
      id: 1027,
      symbol: "ETH",
      quote: { USD: { price: 2504.9, last_updated: "2026-09-07T12:00:00.000Z" } },
    },
  },
});

const NANSEN_BODY = JSON.stringify({
  data: [
    {
      token_address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
      token_symbol: "WETH",
      chain: "ethereum",
      net_flow_1h_usd: -410000,
      net_flow_24h_usd: 5400000.25,
      net_flow_7d_usd: -1200000,
      trader_count: 143,
    },
  ],
  pagination: { page: 1, per_page: 100, is_last_page: false },
});

function paidExchange(challengeFile: string, successBody: string): FixtureExchange {
  return {
    probe: {
      status: 402,
      headers: { "content-type": "application/json" },
      bodyText: challengeText(challengeFile),
    },
    paid: { status: 200, bodyText: successBody },
  };
}

/** Every paid endpoint answering normally. */
function healthyExchanges(): Record<string, FixtureExchange> {
  return {
    "coingecko:simple/price": paidExchange("coingecko-simple-price-402.json", COINGECKO_BODY),
    "coinmarketcap:quotes/latest": paidExchange(
      "coinmarketcap-quotes-latest.json",
      COINMARKETCAP_BODY,
    ),
    "nansen:smart-money/netflow": paidExchange(
      "nansen-smart-money-netflow.json",
      NANSEN_BODY,
    ),
  };
}

/** A fetch that only ever answers the free venue read. */
function venueFetch(
  response: { status: number; body: string } | "unreachable",
): typeof globalThis.fetch {
  return (async (url: string | URL) => {
    if (!String(url).startsWith("https://api.binance.com/")) {
      throw new Error(`fixture fetch refused an unexpected url: ${String(url)}`);
    }
    if (response === "unreachable") {
      throw new Error("connection refused");
    }
    return new Response(response.body, { status: response.status });
  }) as unknown as typeof globalThis.fetch;
}

function buildExecutor(options: {
  readonly exchanges?: Record<string, FixtureExchange>;
  readonly venue?: { status: number; body: string } | "unreachable";
  readonly walletConfigured?: boolean;
  readonly spentTodayBefore?: string;
  readonly spentThisRunBefore?: string;
}) {
  let evidence = 0;
  let attempt = 0;
  return makeStepExecutor({
    policy: defaultPolicy(),
    x402: createFixtureX402Client({
      exchanges: options.exchanges ?? healthyExchanges(),
      hash: sha256,
      ...(options.walletConfigured === undefined
        ? {}
        : { walletConfigured: options.walletConfigured }),
    }),
    clock: fixedClock(NOW),
    hash: sha256,
    instrument: ETH,
    spentTodayBefore: fp.parse(options.spentTodayBefore ?? "0.00"),
    spentThisRunBefore: fp.parse(options.spentThisRunBefore ?? "0.00"),
    newEvidenceId: () => {
      evidence += 1;
      return `ev-${String(evidence)}` as EvidenceId;
    },
    newPaymentAttemptId: () => {
      attempt += 1;
      return `pay-${String(attempt)}` as PaymentAttemptId;
    },
    fetchImpl: venueFetch(options.venue ?? { status: 200, body: BINANCE_BODY }),
  });
}

function requireStep(id: string): RecipeStep {
  const step = stepById(id);
  if (step === undefined) {
    throw new Error(`missing recipe step ${id}`);
  }
  return step;
}

function plannerState(goal: "price_check" | "trade_thesis"): PlannerState {
  return {
    goal,
    policy: defaultPolicy(),
    symbol: ETH.symbol,
    observations: [],
    attempted: [],
    spentThisRun: fp.parse("0.00"),
    spentToday: fp.parse("0.00"),
    walletConfigured: true,
    unhealthyProviders: [],
    now: NOW,
  };
}

describe("the free venue read", () => {
  it("produces a valid observation and spends nothing", async () => {
    const executor = buildExecutor({});
    const result = await executor.execute(requireStep("binance.price"));

    expect(result.observation.status).toBe("valid");
    expect(result.observation.normalized["priceUsd"]).toBe("2505.65000000");
    expect(fp.format(result.cost)).toBe("0.00");
    expect(fp.format(executor.spentThisRun())).toBe("0.00");
    expect(executor.payments()).toHaveLength(0);
  });

  it("hashes what arrived, so a receipt can be tied back to it", async () => {
    const executor = buildExecutor({});
    const result = await executor.execute(requireStep("binance.price"));
    expect(result.observation.rawPayloadHash).toBe(sha256(BINANCE_BODY));
  });

  it("stamps the freshness deadline from the recipe, not from a guess", async () => {
    const executor = buildExecutor({});
    const result = await executor.execute(requireStep("binance.price"));
    // binance.price is fresh for 60 seconds.
    expect(result.observation.freshnessDeadline - result.observation.observedAt).toBe(60_000);
  });

  it("reports an unreachable venue as unavailable, not as a bad price", async () => {
    const executor = buildExecutor({ venue: "unreachable" });
    const result = await executor.execute(requireStep("binance.price"));

    expect(result.observation.status).toBe("unavailable");
    expect(result.observation.normalized["refusalCode"]).toBe("PROVIDER_UNAVAILABLE");
    expect(fp.format(result.cost)).toBe("0.00");
  });

  it("reports an unrecognised payload as invalid rather than reading past it", async () => {
    const executor = buildExecutor({
      venue: { status: 200, body: JSON.stringify({ symbol: "ETHUSDT", lastPrice: "oops" }) },
    });
    const result = await executor.execute(requireStep("binance.price"));
    expect(result.observation.status).toBe("invalid");
  });
});

describe("a paid call", () => {
  it("pays the live price, records the rail, and charges the run", async () => {
    const executor = buildExecutor({});
    const result = await executor.execute(requireStep("coingecko.price"));

    expect(result.observation.status).toBe("valid");
    expect(result.observation.normalized["priceUsd"]).toBe("2505.66");
    expect(fp.format(result.cost)).toBe("0.01");
    expect(fp.format(executor.spentThisRun())).toBe("0.01");

    const [payment] = executor.payments();
    expect(payment?.outcome).toBe("paid");
    expect(payment?.rail).toBe("base-usdc");
    expect(payment?.facilitator).toBe("Base x402");
    expect(result.observation.paymentAttemptId).toBe(payment?.attemptId);
  });

  it("reads an eighteen-decimal BSC amount as one cent, not as ten billion dollars", async () => {
    // CoinMarketCap's real challenge offers $U on BNB Smart Chain at 18 decimals
    // and permit2 first in its accepts list. Getting either wrong is the
    // difference between a cent and a catastrophe.
    const executor = buildExecutor({});
    const result = await executor.execute(requireStep("coinmarketcap.price"));

    expect(fp.format(result.cost)).toBe("0.01");
    const [payment] = executor.payments();
    expect(payment?.rail).toBe("bsc-u");
    expect(payment?.facilitator).toBe("Binance B402");
  });

  it("spends nothing when the budget will not cover the live price", async () => {
    // $1.98 already gone today leaves less than Nansen's five cents under the
    // $2.00 daily cap.
    const executor = buildExecutor({ spentTodayBefore: "1.98" });
    const result = await executor.execute(requireStep("nansen.netflow"));

    expect(result.observation.status).toBe("unavailable");
    expect(result.observation.normalized["refusalCode"]).toBe("X402_DAILY_BUDGET_EXHAUSTED");
    expect(fp.format(result.cost)).toBe("0.00");
    expect(fp.format(executor.spentThisRun())).toBe("0.00");
    expect(executor.payments()[0]?.outcome).toBe("refused");
  });

  it("spends nothing when no wallet is configured", async () => {
    const executor = buildExecutor({ walletConfigured: false });
    const result = await executor.execute(requireStep("coingecko.price"));

    expect(result.observation.status).toBe("unavailable");
    expect(result.observation.normalized["refusalCode"]).toBe("X402_WALLET_NOT_CONFIGURED");
    expect(fp.format(executor.spentThisRun())).toBe("0.00");
  });

  it("still charges the run when the answer is paid for and unusable", async () => {
    const exchanges = healthyExchanges();
    exchanges["coingecko:simple/price"] = paidExchange(
      "coingecko-simple-price-402.json",
      JSON.stringify({ bitcoin: { usd: 67187.34 } }),
    );
    const executor = buildExecutor({ exchanges });
    const result = await executor.execute(requireStep("coingecko.price"));

    expect(result.observation.status).toBe("invalid");
    expect(fp.format(result.cost)).toBe("0.01");
    expect(fp.format(executor.spentThisRun())).toBe("0.01");
    expect(String(result.observation.normalized["refusalDetail"])).toContain("was paid 0.01");
  });

  it("charges a signed payment that was never answered, because the money may have moved", async () => {
    const exchanges = healthyExchanges();
    // No `paid` response: signed, sent, silence.
    exchanges["nansen:smart-money/netflow"] = {
      probe: { status: 402, bodyText: challengeText("nansen-smart-money-netflow.json") },
    };
    const executor = buildExecutor({ exchanges });
    const result = await executor.execute(requireStep("nansen.netflow"));

    expect(result.observation.status).toBe("unavailable");
    expect(result.observation.normalized["refusalCode"]).toBe("X402_PAYMENT_UNKNOWN");
    expect(fp.format(result.cost)).toBe("0.05");
    expect(fp.format(executor.spentThisRun())).toBe("0.05");
    expect(executor.payments()[0]?.outcome).toBe("unknown");
    // The attempt is attached so a reconciliation pass can find it later.
    expect(result.observation.paymentAttemptId).not.toBeNull();
    expect(executor.unresolvedPayment()).toBe(result.observation.paymentAttemptId);
  });

  it("stops buying for the rest of the run once a payment is unresolved", async () => {
    const exchanges = healthyExchanges();
    exchanges["nansen:smart-money/netflow"] = {
      probe: { status: 402, bodyText: challengeText("nansen-smart-money-netflow.json") },
    };
    const executor = buildExecutor({ exchanges });

    await executor.execute(requireStep("nansen.netflow"));
    expect(fp.format(executor.spentThisRun())).toBe("0.05");

    // CoinGecko is healthy and affordable. It is refused anyway, because Telt
    // no longer knows what it has spent.
    const next = await executor.execute(requireStep("coingecko.price"));
    expect(next.observation.status).toBe("unavailable");
    expect(next.observation.normalized["refusalCode"]).toBe("X402_PAYMENT_UNRESOLVED");
    expect(fp.format(next.cost)).toBe("0.00");
    expect(fp.format(executor.spentThisRun())).toBe("0.05");
  });

  it("keeps free evidence flowing after an unresolved payment", async () => {
    const exchanges = healthyExchanges();
    exchanges["nansen:smart-money/netflow"] = {
      probe: { status: 402, bodyText: challengeText("nansen-smart-money-netflow.json") },
    };
    const executor = buildExecutor({ exchanges });

    await executor.execute(requireStep("nansen.netflow"));
    const venue = await executor.execute(requireStep("binance.price"));

    // Only the spending stops. The venue read costs nothing and still works.
    expect(venue.observation.status).toBe("valid");
    expect(venue.observation.normalized["priceUsd"]).toBe("2505.65000000");
  });

  it("reports no unresolved payment on a clean run", async () => {
    const executor = buildExecutor({});
    await executor.execute(requireStep("coingecko.price"));
    expect(executor.unresolvedPayment()).toBeNull();
  });

  it("counts spend carried in from a resumed run against the per-run cap", async () => {
    // $0.06 already spent on this run before the process restarted. The per-run
    // cap is $0.10, so Nansen at $0.05 no longer fits. Without the carried
    // figure the run would get its budget back on the way up.
    const executor = buildExecutor({ spentThisRunBefore: "0.06" });
    const result = await executor.execute(requireStep("nansen.netflow"));

    expect(result.observation.status).toBe("unavailable");
    expect(result.observation.normalized["refusalCode"]).toBe("X402_RUN_BUDGET_EXHAUSTED");
    expect(fp.format(executor.spentThisRun())).toBe("0.00");
  });

  it("takes a provider's free answer for free when it stops charging", async () => {
    const exchanges = healthyExchanges();
    exchanges["coingecko:simple/price"] = {
      probe: { status: 200, bodyText: COINGECKO_BODY },
    };
    const executor = buildExecutor({ exchanges });
    const result = await executor.execute(requireStep("coingecko.price"));

    expect(result.observation.status).toBe("valid");
    expect(fp.format(result.cost)).toBe("0.00");
    expect(executor.payments()[0]?.outcome).toBe("free");
  });

  it("refuses a step whose provider has no fixture, without inventing an outage", async () => {
    const executor = buildExecutor({ exchanges: {} });
    const result = await executor.execute(requireStep("coingecko.price"));
    expect(result.observation.status).toBe("unavailable");
    expect(String(result.observation.normalized["refusalDetail"])).toContain("Fixture mode");
  });

  it("refuses The Graph before any network call, since no subgraph is configured", async () => {
    const executor = buildExecutor({});
    const result = await executor.execute(requireStep("thegraph.pool"));

    expect(result.observation.status).toBe("unavailable");
    expect(fp.format(result.cost)).toBe("0.00");
    expect(executor.payments()).toHaveLength(0);
  });
});

describe("the ladder end to end, on real challenges", () => {
  it("answers a price check for one cent and never touches Nansen", async () => {
    const executor = buildExecutor({});
    const outcome = await runPlan(plannerState("price_check"), executor.execute);

    expect(outcome.decision.kind).toBe("sufficient");
    expect(fp.format(outcome.spent)).toBe("0.01");
    expect(fp.format(executor.spentThisRun())).toBe("0.01");
    expect(outcome.steps.map((step) => step.id)).toEqual(["binance.price", "coingecko.price"]);
    expect(executor.payments().some((payment) => payment.provider === "nansen")).toBe(false);
  });

  it("answers a trade thesis for six cents, buying the dearest call last", async () => {
    const executor = buildExecutor({});
    const outcome = await runPlan(plannerState("trade_thesis"), executor.execute);

    expect(outcome.decision.kind).toBe("sufficient");
    expect(fp.format(outcome.spent)).toBe("0.06");
    expect(outcome.steps.map((step) => step.id)).toEqual([
      "binance.price",
      "coingecko.price",
      "nansen.netflow",
    ]);

    const charged = executor
      .payments()
      .filter((payment) => payment.outcome === "paid")
      .map((payment) => `${payment.provider}:${fp.format(payment.chargedUsdc)}`);
    expect(charged).toEqual(["coingecko:0.01", "nansen:0.05"]);
  });

  it("spends nothing at all when the venue price cannot be read", async () => {
    const executor = buildExecutor({ venue: "unreachable" });
    const outcome = await runPlan(plannerState("trade_thesis"), executor.execute);

    expect(outcome.decision.kind).toBe("insufficient");
    if (outcome.decision.kind !== "insufficient") return;
    expect(outcome.decision.refusal.code).toBe("PROVIDER_UNAVAILABLE");
    expect(fp.format(outcome.spent)).toBe("0.00");
    expect(executor.payments()).toHaveLength(0);
  });

  it("buys a tiebreak when two prices disagree, then refuses without buying flows", async () => {
    const exchanges = healthyExchanges();
    // CoinGecko 300 bps above the venue: a genuine dislocation, not noise.
    exchanges["coingecko:simple/price"] = paidExchange(
      "coingecko-simple-price-402.json",
      JSON.stringify({ ethereum: { usd: 2580.0 } }),
    );
    // CoinMarketCap lands between them, so the extremes still disagree.
    exchanges["coinmarketcap:quotes/latest"] = paidExchange(
      "coinmarketcap-quotes-latest.json",
      JSON.stringify({
        status: { error_code: 0 },
        data: { "1027": { id: 1027, symbol: "ETH", quote: { USD: { price: 2540.0 } } } },
      }),
    );
    const executor = buildExecutor({ exchanges });
    const outcome = await runPlan(plannerState("trade_thesis"), executor.execute);

    expect(outcome.decision.kind).toBe("insufficient");
    if (outcome.decision.kind !== "insufficient") return;
    expect(outcome.decision.refusal.code).toBe("EVIDENCE_CONFLICT_UNRESOLVED");
    expect(fp.format(outcome.spent)).toBe("0.02");
    expect(executor.payments().some((payment) => payment.provider === "nansen")).toBe(false);
  });

  it("never spends more in one run than the per-run cap allows", async () => {
    const executor = buildExecutor({});
    await runPlan(plannerState("trade_thesis"), executor.execute);
    expect(fp.greaterThan(executor.spentThisRun(), defaultPolicy().x402.maxPerRunUsdc)).toBe(
      false,
    );
  });

  it("reports what it skipped, so a cheap run explains itself", async () => {
    const executor = buildExecutor({});
    const outcome = await runPlan(plannerState("price_check"), executor.execute);

    expect(outcome.decision.kind).toBe("sufficient");
    if (outcome.decision.kind !== "sufficient") return;
    const skippedIds = outcome.decision.skipped.map((entry) => entry.id);
    expect(skippedIds).toContain("nansen.netflow");

    const saved = outcome.decision.skipped.reduce(
      (total, entry) => fp.add(total, entry.savedCost),
      fp.parse("0.00"),
    );
    // Nansen at $0.05, CoinMarketCap and The Graph at $0.01 each.
    // Back to 0.07: Nansen 0.05, the second price 0.01, the subgraph 0.01.
    // The OpenPulse steps were removed after paying for them showed the
    // provider does not index the chains Telt trades on.
    expect(fp.format(saved)).toBe("0.07");
  });

  it("keeps every recipe step reachable by an adapter", async () => {
    const executor = buildExecutor({});
    for (const step of RECIPE_STEPS) {
      // No step may throw. Refusals are fine; a defect is not.
      await expect(executor.execute(step)).resolves.toBeDefined();
    }
  });
});
