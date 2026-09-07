/**
 * The composition root.
 *
 * Every impure thing Kertel can do is constructed here and nowhere else: the
 * clock, the hasher, the database, the payment client, the provider executor.
 * `packages/core` receives all of them as arguments, which is what lets the
 * entire policy, sizing, proposal and confirmation logic be tested without a
 * network, a wallet, or a clock.
 *
 * The one decision this file makes on its own is fixture versus live, and it
 * makes it from configuration that has already been validated. Fixture mode is
 * not a different code path — it is the same executor holding a different
 * `X402Client`, which is why a fixture run exercises the pins, the rails and
 * the decimals rather than stepping around them.
 */

import * as fp from "@kertel/core/money";
import { systemClock, utcDay } from "@kertel/core/domain";
import type {
  Clock,
  EvidenceId,
  Instant,
  PaymentAttemptId,
  RunMode,
  SenderIdHash,
  Symbol_,
} from "@kertel/core/domain";
import { randomBytes, randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { runPlan } from "@kertel/core/research";
import type { PlannerState, ResearchGoal } from "@kertel/core/research";
import { renderRefusalReceipt, renderResearchReceipt } from "@kertel/core/receipts";
import type { ReceiptPayment } from "@kertel/core/receipts";
import { createFixtureX402Client, createLiveX402Client } from "@kertel/x402";
import type { FixtureExchange, X402Client } from "@kertel/x402";
import { assertRegistryCoversRecipes, instrumentFor, makeStepExecutor } from "@kertel/providers";

import { createBinanceClient } from "./infra/binance.js";
import { createAgentOsClient } from "./infra/agentos.js";
import { loadFixtureExchanges } from "./infra/fixtures.js";
import type { BinanceClient } from "./infra/binance.js";
import { cancel, confirm, propose, reconcile } from "./trading.js";
import type { TradeOutcome, TradingDeps } from "./trading.js";
import { armPlan, cancelPlan, describeJournal, describePositions, planExit } from "./plans.js";
import type { PlanDeps, PlanOutcome, PlanRequest } from "./plans.js";
import { createMonitor, sweep } from "./monitor.js";
import type { Monitor, MonitorDeps, SweepResult } from "./monitor.js";
import { watchHoldings } from "./watch.js";
import type { WatchDeps } from "./watch.js";
import { deriveLessons, memoryDigest, renderReview } from "./review.js";
import type { Lesson, ReviewDeps } from "./review.js";
import { restore, snapshot } from "./portable.js";
import type { PortableDeps } from "./portable.js";
import { railsFor } from "./infra/config.js";
import type { KertelConfig } from "./infra/config.js";
import { hashSender, sha256 } from "./infra/hash.js";
import { createLogger } from "./infra/logger.js";
import type { Logger } from "./infra/logger.js";
import { openStore } from "./infra/store.js";
import type { Store } from "./infra/store.js";

export type Runtime = {
  readonly config: KertelConfig;
  readonly clock: Clock;
  readonly store: Store;
  readonly log: Logger;
  readonly x402: X402Client;
  readonly mode: RunMode;
  /** Hash of the configured owner, the form used in every stored record. */
  readonly ownerHash: string | null;
  readonly binance: BinanceClient;
  /** Which rail orders go out on. Shown in the status report. */
  readonly executionRail: "agent-os" | "api-key" | "none";
  research(input: ResearchRequest): Promise<ResearchResult>;
  propose(input: {
    readonly symbol: string;
    readonly side: "BUY" | "SELL";
    readonly notional: string;
  }): Promise<TradeOutcome>;
  confirm(code: string): Promise<TradeOutcome>;
  cancel(): TradeOutcome;
  reconcile(): Promise<string>;
  planExit(request: PlanRequest): Promise<PlanOutcome>;
  armPlan(code: string): PlanOutcome;
  positions(): string;
  cancelPlan(id: string): PlanOutcome;
  journal(limit: number, withEvidence: boolean): string;
  watch(deep: boolean): Promise<string>;
  review(limit: number): string;
  /** The portable summary, shaped for the user's own memory service. */
  memoryDigest(limit: number): string;
  /** Take lessons recalled from memory and make them count at plan time. */
  learn(lessons: readonly { symbol: string; text: string }[]): string;
  /** The working state, as text to carry to another machine. */
  snapshot(): string;
  restore(text: string): Promise<{ readonly ok: boolean; readonly body: string }>;
  /** One pass over every armed plan, right now. */
  checkPositions(): Promise<SweepResult>;
  readonly monitor: Monitor;
  close(): void;
};

export type ResearchRequest = {
  readonly symbol: string;
  readonly goal: ResearchGoal;
};

export type ResearchResult = {
  readonly ok: boolean;
  readonly body: string;
  readonly spent: string;
  readonly refusalCode: string | null;
};

export type RuntimeOptions = {
  readonly config: KertelConfig;
  readonly clock?: Clock;
  readonly store?: Store;
  readonly log?: Logger;
  /** Fixture responses, when running without a wallet. */
  readonly exchanges?: Readonly<Record<string, FixtureExchange>>;
  readonly fetchImpl?: typeof globalThis.fetch;
  /** Injected in tests so no order ever leaves the machine. */
  readonly binance?: BinanceClient;
  readonly random?: (count: number) => Uint8Array;
  readonly newId?: (prefix: string) => string;
};

/**
 * How often the monitor looks.
 *
 * Thirty seconds is a compromise: fast enough that a stop is not badly slipped,
 * slow enough that Binance's free market-data limits are nowhere near touched
 * even with several positions open.
 */
const MONITOR_INTERVAL_MS = 30_000;

let evidenceCounter = 0;
let attemptCounter = 0;

function nextEvidenceId(): EvidenceId {
  evidenceCounter += 1;
  return `ev-${String(Date.now())}-${String(evidenceCounter)}` as EvidenceId;
}

function nextAttemptId(): PaymentAttemptId {
  attemptCounter += 1;
  return `pay-${String(Date.now())}-${String(attemptCounter)}` as PaymentAttemptId;
}

export function createRuntime(options: RuntimeOptions): Runtime {
  const { config } = options;
  const clock = options.clock ?? systemClock();
  const log =
    options.log ?? createLogger({ level: config.logLevel }).child({ component: "kertel" });
  const store = options.store ?? openStore(`${config.dataDir}/kertel.sqlite`);

  // A recipe step with no adapter is a step the planner will select and then
  // fail on, mid-run, after the cheaper calls have already been paid for.
  // Failing at construction turns a wasted spend into a startup error.
  assertRegistryCoversRecipes();

  const fixtures = options.exchanges === undefined ? loadFixtureExchanges() : { exchanges: {}, problem: null };
  if (fixtures.problem !== null && config.mode === "fixture") {
    log.warn("fixture data unavailable", { problem: fixtures.problem });
  }

  const x402: X402Client =
    config.mode === "live" && config.x402PrivateKey !== null
      ? createLiveX402Client({
          privateKey: config.x402PrivateKey,
          hash: sha256,
          ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
        })
      : createFixtureX402Client({
          // Without the saved challenges, fixture mode can read the free venue
          // price and nothing else — which makes the product's default mode a
          // demonstration of its own refusal path.
          exchanges: options.exchanges ?? fixtures.exchanges,
          hash: sha256,
          // With no key there is nothing to pay with, and the honest fixture is
          // the one that refuses paid calls the same way live mode would.
          walletConfigured: config.x402PrivateKey !== null,
        });

  const ownerHash =
    config.ownerWhatsApp === null ? null : hashSender(config.ownerWhatsApp, config.senderSalt);

  // Agent OS first. Its orders land in the Agentic sub-account, which has no
  // withdrawal scope to grant, and that is a stronger guarantee than an API key
  // with the withdrawal box unticked. The API key remains the fallback for when
  // the thirty-day token has lapsed and nobody has signed in again.
  const executionRail: "agent-os" | "api-key" | "none" =
    config.binanceMcpToken !== null ? "agent-os" : config.binanceApiKey !== null ? "api-key" : "none";

  const binance =
    options.binance ??
    (executionRail === "agent-os"
      ? createAgentOsClient({
          token: config.binanceMcpToken as string,
          url: config.binanceMcpUrl,
          ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
        })
      : createBinanceClient({
          apiKey: config.binanceApiKey ?? undefined,
          apiSecret: config.binanceApiSecret ?? undefined,
          ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
        }));

  const tradingDeps: TradingDeps = {
    policy: config.policy,
    mode: config.mode,
    store,
    binance,
    hash: sha256,
    random: options.random ?? ((count: number) => new Uint8Array(randomBytes(count))),
    now: () => clock.now(),
    newId: options.newId ?? ((prefix: string) => `${prefix}-${randomUUID()}`),
    ownerHash: ownerHash as SenderIdHash | null,
  };

  const planDeps: PlanDeps = {
    store,
    binance,
    hash: sha256,
    random: tradingDeps.random,
    now: () => clock.now(),
    ownerHash: ownerHash as SenderIdHash | null,
    mode: config.mode,
    // A leg above this is not a plan, it is a number that will never fire while
    // reading like protection.
    maxLegBps: 100_000,
    planTtlSeconds: 30 * 86_400,
  };

  const monitorDeps: MonitorDeps = {
    store,
    binance,
    log,
    now: () => clock.now(),
    hash: sha256,
    mode: config.mode,
    liveExecutionEnabled: config.policy.trading.liveExecutionEnabled,
    research: async (symbol: string) => {
      const result = await research({ symbol, goal: "trade_thesis" });
      return { ok: result.ok, body: result.body };
    },
    newId: tradingDeps.newId,
  };

  const monitor = createMonitor(monitorDeps, MONITOR_INTERVAL_MS);

  const watchDeps: WatchDeps = {
    store,
    binance,
    now: () => clock.now(),
    quoteAsset: "USDT",
    allowedSymbols: config.policy.trading.allowedSymbols,
    research: async (symbol, goal) => {
      const result = await research({ symbol, goal });
      return { ok: result.ok, body: result.body };
    },
  };

  const reviewDeps: ReviewDeps = { store, now: () => clock.now() };

  const portableDeps: PortableDeps = {
    store,
    binance,
    now: () => clock.now(),
    ownerHash,
    // Enough to tell "my own snapshot" from "another machine's", without
    // putting a hostname into something the user will paste into a chat.
    machineId: sha256(`${hostname()}:${config.dataDir}`).slice(0, 12),
  };

  log.info("kertel runtime ready", {
    mode: config.mode,
    rails: railsFor(config.railPreference).map((rail) => rail.id),
    walletConfigured: x402.walletConfigured,
    payer: x402.payerAddress,
    executionRail,
    degraded: config.degraded,
  });

  async function research(request: ResearchRequest): Promise<ResearchResult> {
    const now: Instant = clock.now();
    const symbol = request.symbol.trim().toUpperCase() as Symbol_;

    // Two independent checks, on purpose. The policy engine owns what Kertel is
    // allowed to trade; the instrument table owns what Kertel knows how to ask
    // about. A symbol has to clear both, and they can disagree — a symbol added
    // to the policy but not the table is a configuration mistake, not a
    // research failure, and the message says which.
    if (!config.policy.trading.allowedSymbols.includes(symbol)) {
      return refused(
        "SYMBOL_NOT_ALLOWED",
        `${symbol} is not on the allowed list. Kertel will research ${config.policy.trading.allowedSymbols.join(", ")}.`,
        symbol,
        now,
      );
    }
    const instrument = instrumentFor(symbol);
    if (instrument === undefined) {
      return refused(
        "SYMBOL_NOT_ALLOWED",
        `${symbol} is allowed by policy but Kertel has no verified provider ids for it, so it cannot research it without guessing.`,
        symbol,
        now,
      );
    }

    const safety = store.safetyState();
    if (safety.killSwitchEngaged) {
      return refused(
        "KILL_SWITCH_ENGAGED",
        `Kertel is stopped: ${safety.killSwitchReason ?? "no reason recorded"}. Nothing will run until it is released.`,
        symbol,
        now,
      );
    }

    const spentToday = store.spentOn(now);
    const executor = makeStepExecutor({
      policy: config.policy,
      x402,
      clock,
      hash: sha256,
      instrument,
      spentTodayBefore: spentToday,
      newEvidenceId: nextEvidenceId,
      newPaymentAttemptId: nextAttemptId,
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    });

    const state: PlannerState = {
      goal: request.goal,
      policy: config.policy,
      symbol,
      observations: [],
      attempted: [],
      spentThisRun: fp.parse("0.00"),
      spentToday,
      walletConfigured: x402.walletConfigured,
      unhealthyProviders: [],
      now,
    };

    const outcome = await runPlan(state, executor.execute);

    // Persist before rendering. If the process dies between the two, the money
    // is still accounted for and the user simply does not get their receipt —
    // which is recoverable, where a forgotten spend is not.
    if (fp.isPositive(outcome.spent)) {
      store.recordSpend(now, outcome.spent);
    }
    for (const payment of executor.payments()) {
      store.recordPaymentAttempt({
        attemptId: payment.attemptId,
        provider: payment.provider,
        endpointId: payment.endpointId,
        chargedUsdc: fp.format(payment.chargedUsdc),
        rail: payment.rail,
        facilitator: payment.facilitator,
        settlementTx: payment.settlementTx,
        outcome: payment.outcome,
        refusalCode: payment.refusalCode,
        at: payment.at,
      });
    }

    const unresolved = executor.unresolvedPayment();
    if (unresolved !== null) {
      // Money Kertel cannot account for. Stopping everything is the only honest
      // response: the alternative is trading on a budget nobody can compute.
      store.engageKillSwitch(
        `a payment was signed and never confirmed (${unresolved}); reconcile it before resuming`,
        now,
      );
      log.error("unresolved payment, kill switch engaged", { attemptId: unresolved });
    }

    const payments: ReceiptPayment[] = executor.payments().map((payment) => ({
      provider: payment.provider,
      chargedUsdc: payment.chargedUsdc,
      rail: payment.rail,
      facilitator: payment.facilitator,
      settlementTx: payment.settlementTx,
      outcome: payment.outcome,
    }));

    if (outcome.decision.kind === "insufficient") {
      log.info("research refused", {
        symbol,
        goal: request.goal,
        code: outcome.decision.refusal.code,
        spent: fp.format(outcome.spent),
      });
      return {
        ok: false,
        body: renderRefusalReceipt({
          refusal: outcome.decision.refusal,
          symbol,
          mode: config.mode,
          spent: outcome.spent,
          skipped: outcome.decision.skipped,
          now,
        }),
        spent: fp.format(outcome.spent),
        refusalCode: outcome.decision.refusal.code,
      };
    }

    const receipt = renderResearchReceipt(
      {
        symbol,
        goal: request.goal,
        mode: config.mode,
        observations: outcome.observations,
        spent: outcome.spent,
        skipped: outcome.decision.skipped,
        payments,
        because: outcome.decision.because,
        limitedByBudget: outcome.decision.limitedByBudget,
        // The model writes the thesis, and it is not wired yet. A run with no
        // thesis returns its evidence and says so, rather than inventing one.
        thesis: null,
        now,
      },
      sha256,
    );

    log.info("research complete", {
      symbol,
      goal: request.goal,
      spent: fp.format(outcome.spent),
      steps: outcome.steps.map((step) => step.id),
      provenance: receipt.provenanceDigest,
    });

    return { ok: true, body: receipt.body, spent: fp.format(outcome.spent), refusalCode: null };
  }

  function refused(
    code: Parameters<typeof renderRefusalReceipt>[0]["refusal"]["code"],
    detail: string,
    symbol: Symbol_,
    now: Instant,
  ): ResearchResult {
    return {
      ok: false,
      body: renderRefusalReceipt({
        refusal: { code, detail },
        symbol,
        mode: config.mode,
        spent: fp.parse("0.00"),
        skipped: [],
        now,
      }),
      spent: "0.00",
      refusalCode: code,
    };
  }

  return {
    config,
    clock,
    store,
    log,
    x402,
    binance,
    executionRail,
    mode: config.mode,
    ownerHash,
    research,
    propose: (input) => propose(tradingDeps, input),
    planExit: (request) => planExit(planDeps, request),
    armPlan: (code) => armPlan(planDeps, code),
    positions: () => describePositions(planDeps),
    cancelPlan: (id) => cancelPlan(planDeps, id),
    journal: (limit, withEvidence) => describeJournal(planDeps, limit, withEvidence),
    watch: (deep) => watchHoldings(watchDeps, { deep }),
    review: (limit) => renderReview(reviewDeps, store.mandates.outcomes(limit)),
    snapshot: () => snapshot(portableDeps),
    restore: (text) => restore(portableDeps, text),
    memoryDigest: (limit) => memoryDigest(reviewDeps, store.mandates.outcomes(limit)),
    learn: (lessons) => {
      const now = clock.now();
      let stored = 0;
      for (const lesson of lessons) {
        const symbol = lesson.symbol.trim().toUpperCase();
        const text = lesson.text.trim();
        if (text === "") {
          continue;
        }
        store.mandates.learn({
          // "*" is the catch-all: something true about how this account trades
          // rather than about one pair.
          symbol: symbol === "" ? "*" : symbol,
          text,
          learnedAt: now,
          source: "recalled",
        });
        stored += 1;
      }
      // Whatever Kertel has worked out for itself is folded in at the same
      // time, so both kinds of lesson reach the next plan together.
      const derived: readonly Lesson[] = deriveLessons(store.mandates.outcomes(200), now);
      for (const lesson of derived) {
        store.mandates.learn(lesson);
      }
      return [
        `Stored ${String(stored)} recalled lesson(s) and ${String(derived.length)} derived from Kertel's own record.`,
        "",
        "These now appear on any exit plan for the symbols they concern.",
      ].join("\n");
    },
    checkPositions: () => sweep(monitorDeps),
    monitor,
    confirm: (code) => confirm(tradingDeps, code),
    cancel: () => cancel(tradingDeps),
    reconcile: () => reconcile(tradingDeps),
    close: () => {
      monitor.stop();
      store.close();
    },
  };
}

/** Today's spend, for the health report. */
export function spentToday(runtime: Runtime): string {
  return fp.format(runtime.store.spentOn(runtime.clock.now()));
}

export function todayKey(runtime: Runtime): string {
  return utcDay(runtime.clock.now());
}
