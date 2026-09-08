/**
 * A free, unsigned check that the research loop can actually run.
 *
 * `probe:providers` proves the payment side: that every merchant still answers
 * with a 402 Telt can read, on a rail it will pay, at the price it expects.
 * This proves the other half — that the free venue read works against the live
 * exchange, that every recipe step has an adapter behind it, and that the whole
 * ladder walks end to end and stops where it should.
 *
 * It costs nothing and signs nothing. The paid tiers run against the saved live
 * challenges through the fixture client, which still enforces the pins, the
 * rails and the decimals, so a run here exercises every branch the live client
 * takes except the signature itself.
 *
 *   npm run probe:adapters
 */

import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

import * as fp from "@telt/core/money";
import { systemClock } from "@telt/core/domain";
import type { EvidenceId, PaymentAttemptId, Symbol_ } from "@telt/core/domain";
import { defaultPolicy } from "@telt/core/policy";
import { runPlan, stepById } from "@telt/core/research";
import type { PlannerState, ResearchGoal } from "@telt/core/research";
import { createFixtureX402Client } from "@telt/x402";
import type { FixtureExchange } from "@telt/x402";
import {
  assertRegistryCoversRecipes,
  instrumentFor,
  makeStepExecutor,
} from "@telt/providers";

const SYMBOL = "ETHUSDT" as Symbol_;
const hash = (input: string): string => createHash("sha256").update(input).digest("hex");

const instrument = instrumentFor(SYMBOL);
if (instrument === undefined) {
  throw new Error(`${SYMBOL} is not in the instrument table`);
}

function fixtureFile(name: string): string {
  // `.pathname` yields `/C:/...` on Windows, which `fs` cannot open.
  return fileURLToPath(new URL(`../fixtures/x402/live-quotes/${name}`, import.meta.url));
}

async function readChallengeFile(name: string): Promise<string> {
  const { readFile } = await import("node:fs/promises");
  return readFile(fixtureFile(name), "utf8");
}

async function exchanges(): Promise<Record<string, FixtureExchange>> {
  const paid = (bodyText: string) => ({ status: 200, bodyText });
  return {
    "coingecko:simple/price": {
      probe: { status: 402, bodyText: await readChallengeFile("coingecko-simple-price-402.json") },
      paid: paid(JSON.stringify({ ethereum: { usd: 2505.66, last_updated_at: 1788744167 } })),
    },
    "coinmarketcap:quotes/latest": {
      probe: {
        status: 402,
        bodyText: await readChallengeFile("coinmarketcap-quotes-latest.json"),
      },
      paid: paid(
        JSON.stringify({
          status: { error_code: 0 },
          data: { "1027": { id: 1027, symbol: "ETH", quote: { USD: { price: 2504.9 } } } },
        }),
      ),
    },
    "nansen:smart-money/netflow": {
      probe: {
        status: 402,
        bodyText: await readChallengeFile("nansen-smart-money-netflow.json"),
      },
      paid: paid(
        JSON.stringify({
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
        }),
      ),
    },
  };
}

function newExecutor(saved: Record<string, FixtureExchange>) {
  let evidence = 0;
  let attempt = 0;
  return makeStepExecutor({
    policy: defaultPolicy(),
    x402: createFixtureX402Client({ exchanges: saved, hash }),
    clock: systemClock(),
    hash,
    instrument: instrument as NonNullable<typeof instrument>,
    spentTodayBefore: fp.parse("0.00"),
    newEvidenceId: () => {
      evidence += 1;
      return `ev-${String(evidence)}` as EvidenceId;
    },
    newPaymentAttemptId: () => {
      attempt += 1;
      return `pay-${String(attempt)}` as PaymentAttemptId;
    },
  });
}

function stateFor(goal: ResearchGoal): PlannerState {
  return {
    goal,
    policy: defaultPolicy(),
    symbol: SYMBOL,
    observations: [],
    attempted: [],
    spentThisRun: fp.parse("0.00"),
    spentToday: fp.parse("0.00"),
    walletConfigured: true,
    unhealthyProviders: [],
    now: systemClock().now(),
  };
}

async function main(): Promise<void> {
  console.log("Telt adapter probe. Free, and nothing is signed.\n");

  assertRegistryCoversRecipes();
  console.log("registry      every recipe step has an adapter behind it");

  // The one genuinely live call. Everything else runs off saved challenges.
  const venueStep = stepById("binance.price");
  if (venueStep === undefined) {
    throw new Error("binance.price is missing from the recipe catalogue");
  }
  const saved = await exchanges();
  const venue = await newExecutor(saved).execute(venueStep);
  const priceUsd = venue.observation.normalized["priceUsd"];

  console.log(
    `venue         ${venue.observation.status.toUpperCase()} ${SYMBOL} ${
      typeof priceUsd === "string" ? priceUsd : "no price"
    } (bid ${String(venue.observation.normalized["bidUsd"])} / ask ${String(
      venue.observation.normalized["askUsd"],
    )}) live from api.binance.com, cost ${fp.format(venue.cost)}`,
  );

  if (venue.observation.status !== "valid") {
    console.log(`              ${String(venue.observation.normalized["refusalDetail"])}`);
  }

  for (const goal of ["price_check", "trade_thesis"] as const) {
    const executor = newExecutor(saved);
    const outcome = await runPlan(stateFor(goal), executor.execute);
    const taken = outcome.steps.map((step) => step.id).join(" -> ");

    console.log(`\n${goal}`);
    console.log(`  ladder      ${taken}`);
    console.log(`  outcome     ${outcome.decision.kind}`);
    console.log(`  spent       ${fp.format(outcome.spent)}`);

    if (outcome.decision.kind === "sufficient") {
      const saved_ = outcome.decision.skipped.reduce(
        (total, entry) => fp.add(total, entry.savedCost),
        fp.parse("0.00"),
      );
      console.log(`  not spent   ${fp.format(saved_)}`);
      for (const skipped of outcome.decision.skipped) {
        console.log(`    - ${skipped.id}: ${skipped.reason} (${fp.format(skipped.savedCost)})`);
      }
    } else {
      console.log(`  refusal     ${outcome.decision.refusal.code}`);
      console.log(`              ${outcome.decision.refusal.detail}`);
    }

    for (const payment of executor.payments()) {
      console.log(
        `  paid        ${payment.provider} ${fp.format(payment.chargedUsdc)} via ${
          payment.facilitator ?? "n/a"
        } (${payment.outcome})`,
      );
    }
  }

  console.log("\nNo wallet was used and no payment was signed.");
}

void main().catch((cause: unknown) => {
  console.error(cause);
  process.exitCode = 1;
});
