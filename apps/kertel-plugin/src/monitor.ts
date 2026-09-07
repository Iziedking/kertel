/**
 * The part that works while nobody is watching.
 *
 * A research tool answers when asked. A trader manages a position: it watches,
 * it trims into strength, it tightens the stop as a winner runs, and it gets out
 * when the thesis breaks — at four in the morning, without being prompted. That
 * is what this loop does, and it is the difference between an agent that is
 * impressive in a demo and one that is useful on a Tuesday.
 *
 * Every autonomous action here is one the human already authorised when they
 * confirmed the plan. The loop does not invent trades, does not size positions,
 * and cannot open one — it only ever *exits* what is already held, along rules
 * that were shown and agreed to with a one-use code.
 *
 * Three things it does that a naive trigger does not:
 *
 * - **It asks why before acting on a protective exit.** A stop hit by a 5%
 *   lurch between two checks is a different event from one reached by slow
 *   drift. When the move is abrupt, the loop buys the cheap evidence first and
 *   writes what it found into the journal next to the decision. It still exits —
 *   the stop is the stop — but the record says whether smart money was leaving
 *   or arriving, which is what tells you afterwards whether the rule was right.
 * - **It writes down the times it did nothing.** An agent that only journals its
 *   trades is indistinguishable from one that got lucky.
 * - **It stops itself.** Kill switch, unreconciled orders, an exchange that will
 *   not answer: all of them halt the loop rather than degrade it, because a
 *   monitor that half-works on a position is worse than one that is plainly off.
 */

import * as fp from "@kertel/core/money";
import type { Instant } from "@kertel/core/domain";
import { evaluateMandate, moveBps } from "@kertel/core/mandates";
import type { ExitMandate, MandateTrigger } from "@kertel/core/mandates";

import { clientOrderIdFrom } from "./infra/binance.js";
import type { BinanceClient } from "./infra/binance.js";
import type { Store } from "./infra/store.js";
import type { Logger } from "./infra/logger.js";
import { outcomeFrom } from "./review.js";

export type MonitorDeps = {
  readonly store: Store;
  readonly binance: BinanceClient;
  readonly log: Logger;
  readonly now: () => Instant;
  readonly hash: (input: string) => string;
  readonly mode: "fixture" | "live";
  readonly liveExecutionEnabled: boolean;
  /** Buy cheap evidence when a protective exit looks abrupt. */
  readonly research: (symbol: string) => Promise<{ readonly ok: boolean; readonly body: string }>;
  readonly newId: (prefix: string) => string;
};

export type SweepResult = {
  readonly checked: number;
  readonly fired: number;
  readonly halted: string | null;
  readonly lines: readonly string[];
};

/**
 * One pass over every active mandate.
 *
 * Separated from the timer so it can be driven directly by a test or by
 * `kertel_check_positions`, and so a demo can show a whole position lifecycle
 * without waiting for a market to move.
 */
export async function sweep(deps: MonitorDeps): Promise<SweepResult> {
  const now = deps.now();
  const lines: string[] = [];

  const safety = deps.store.safetyState();
  if (safety.killSwitchEngaged) {
    return {
      checked: 0,
      fired: 0,
      halted: `Kertel is stopped: ${safety.killSwitchReason ?? "no reason recorded"}.`,
      lines: [],
    };
  }
  if (safety.unreconciledOperations.length > 0) {
    // An order in flight means the position size is unknown, and a mandate
    // acting on an unknown position can sell what it does not have.
    return {
      checked: 0,
      fired: 0,
      halted: `An earlier order is unresolved (${safety.unreconciledOperations.join(", ")}). Reconcile before the monitor runs again.`,
      lines: [],
    };
  }

  // Answer the questions that could not be answered when they were asked.
  await settleOldVerdicts(deps, now);

  const mandates = deps.store.mandates.active();
  if (mandates.length === 0) {
    return { checked: 0, fired: 0, halted: null, lines: [] };
  }

  let fired = 0;
  for (const mandate of mandates) {
    const line = await visit(deps, mandate, now);
    lines.push(line.text);
    if (line.fired) {
      fired += 1;
    }
  }

  return { checked: mandates.length, fired, halted: null, lines };
}

/** A day. Long enough for a dip to resolve, short enough to still be about that exit. */
const VERDICT_AFTER_MS = 24 * 60 * 60 * 1000;

/**
 * Go back and judge exits that are now old enough to judge.
 *
 * "Was that stop right?" has no answer at the moment the stop fires. It has one
 * a day later: did the price climb back above where Kertel sold? If it did, the
 * stop cost money — it sold a dip that recovered without you. Four of those and
 * the stop is not protection, it is a leak.
 *
 * Without this pass the column stays null forever and the most useful line in
 * the review can never come from Kertel's own records. It is free: the venue
 * price costs nothing, and a handful of rows are settled per sweep.
 */
async function settleOldVerdicts(deps: MonitorDeps, now: Instant): Promise<void> {
  const due = deps.store.mandates.outcomesAwaitingVerdict((now - VERDICT_AFTER_MS) as Instant);
  if (due.length === 0) {
    return;
  }

  // One price read per symbol, however many exits are waiting on it.
  const prices = new Map<string, ReturnType<typeof fp.parse> | null>();
  for (const outcome of due) {
    if (!prices.has(outcome.symbol)) {
      const market = await deps.binance.market(outcome.symbol as never);
      prices.set(outcome.symbol, market.ok ? market.value.bestBid : null);
    }
    const price = prices.get(outcome.symbol) ?? null;
    if (price === null) {
      // Leave it unanswered rather than guess. An unjudged exit is honest; a
      // wrongly judged one poisons every lesson drawn from it.
      continue;
    }

    const recovered = fp.greaterThan(price, fp.parse(outcome.exitPrice));
    deps.store.mandates.settleVerdict(outcome.rowId, recovered);

    // Only worth a journal line when it says the exit was a mistake.
    if (recovered && outcome.reason !== "take_profit") {
      deps.store.mandates.journal({
        at: now,
        kind: "checked",
        symbol: outcome.symbol,
        mandateId: outcome.mandateId,
        headline: `The ${outcome.reason.replace(/_/g, " ")} on ${outcome.symbol} sold a dip that recovered`,
        detail: `Exited at ${outcome.exitPrice}; a day later it is ${fp.format(price)}. That stop cost money — worth a wider one, or a trailing stop that arms only after a real gain.`,
        evidence: null,
      });
    }
  }
}

type Visit = { readonly text: string; readonly fired: boolean };

async function visit(deps: MonitorDeps, mandate: ExitMandate, now: Instant): Promise<Visit> {
  const symbol = mandate.symbol;

  const [filtersResult, marketResult, accountResult] = await Promise.all([
    deps.binance.filters(symbol),
    deps.binance.market(symbol),
    deps.binance.account(),
  ]);

  if (!filtersResult.ok || !marketResult.ok || !accountResult.ok) {
    const problem = !filtersResult.ok
      ? filtersResult.error
      : !marketResult.ok
        ? marketResult.error
        : accountResult.ok
          ? null
          : accountResult.error;
    const detail = problem?.detail ?? "the exchange did not answer";
    // Not a reason to act. A monitor that exits because it could not read the
    // price is a monitor that sells on a network blip.
    deps.store.mandates.journal({
      at: now,
      kind: "checked",
      symbol,
      mandateId: mandate.id,
      headline: `Could not check ${symbol}`,
      detail,
      evidence: null,
    });
    return { text: `${symbol}: could not check — ${detail}`, fired: false };
  }

  const filters = filtersResult.value;
  const market = marketResult.value;
  const held =
    accountResult.value.balances.find((balance) => balance.asset === filters.baseAsset)?.free ??
    fp.parse("0");

  // How far it moved since the previous look. This is what separates a gap from
  // a drift, and it is the only reason the loop stores the last price.
  const previous = deps.store.mandates.lastSeen(mandate.id);
  const sinceLast =
    previous.price === null ? 0 : moveBps(fp.parse(previous.price), market.bestBid);

  const trigger = evaluateMandate({
    mandate,
    bidPrice: market.bestBid,
    heldQuantity: held,
    minQuantity: filters.minQuantity,
    minNotional: filters.minNotional,
    now,
    moveSinceLastCheckBps: sinceLast,
  });

  deps.store.mandates.recordCheck(mandate.id, fp.format(market.bestBid), now);
  if (trigger.kind === "idle") {
    deps.store.mandates.recordProgress(
      mandate.id,
      trigger.highWaterBps,
      mandate.soldBps,
      fp.format(mandate.soldQuantity),
    );
    deps.store.mandates.journal({
      at: now,
      kind: "checked",
      symbol,
      mandateId: mandate.id,
      headline: `Holding ${symbol}`,
      detail: trigger.because,
      evidence: null,
    });
    return { text: `${symbol}: ${trigger.because}`, fired: false };
  }

  if (trigger.kind === "expired" || trigger.kind === "unfulfillable") {
    deps.store.mandates.setStatus(mandate.id, trigger.kind === "expired" ? "expired" : "unfulfillable");
    deps.store.mandates.journal({
      at: now,
      kind: "mandate_cancelled",
      symbol,
      mandateId: mandate.id,
      headline: `Stopped watching ${symbol}`,
      detail: trigger.because,
      evidence: null,
    });
    return { text: `${symbol}: ${trigger.because}`, fired: false };
  }

  return fire(deps, mandate, trigger, now);
}

async function fire(
  deps: MonitorDeps,
  mandate: ExitMandate,
  trigger: Extract<MandateTrigger, { kind: "fire" }>,
  now: Instant,
): Promise<Visit> {
  const symbol = mandate.symbol;

  // The judgement call a trader makes and a trigger does not: an abrupt
  // protective exit is worth understanding. The exit still happens — the stop is
  // the stop — but the record says what was going on when it did.
  let evidence: string | null = null;
  if (trigger.worthChecking) {
    const research = await deps.research(symbol);
    evidence = research.body;
    deps.store.mandates.journal({
      at: now,
      kind: "evidence_taken",
      symbol,
      mandateId: mandate.id,
      headline: `Checked why ${symbol} moved before exiting`,
      detail:
        "The stop was reached by an abrupt move rather than a drift, so Kertel bought evidence before acting on it.",
      evidence: research.body,
    });
  }

  deps.store.mandates.recordProgress(
    mandate.id,
    trigger.highWaterBps,
    mandate.soldBps,
    fp.format(mandate.soldQuantity),
  );

  // The write gate applies to autonomous exits exactly as it does to a
  // confirmed order. A dry run must exercise this whole path and stop here.
  if (deps.mode !== "live" || !deps.liveExecutionEnabled) {
    deps.store.mandates.journal({
      at: now,
      kind: "exit_fired",
      symbol,
      mandateId: mandate.id,
      headline: `Would sell ${fp.format(trigger.sellQuantity)} ${symbol} (${trigger.reason})`,
      detail: `${trigger.because} Stopped at the live write gate; nothing was sent.`,
      evidence,
    });
    return {
      text: `${symbol}: ${trigger.because} [dry run — not sent]`,
      fired: false,
    };
  }

  // Derived, not random: the same mandate at the same peak having sold the same
  // amount produces the same id, so a retry after a crash cannot double-sell.
  const idempotencyKey = deps.hash(
    `kertel.mandate.v1\n${mandate.id}\n${String(trigger.highWaterBps)}\n${String(mandate.soldBps)}\n${String(trigger.sellFractionBps)}`,
  );
  const clientOrderId = clientOrderIdFrom(idempotencyKey);

  const placed = await deps.binance.placeMarketOrder({
    symbol,
    side: "SELL",
    quantity: trigger.sellQuantity,
    clientOrderId,
  });

  if (!placed.ok) {
    const unknown = placed.error.code === "EXECUTION_RESULT_UNKNOWN";
    if (unknown) {
      deps.store.engageKillSwitch(
        `an autonomous exit for ${symbol} was sent and never confirmed; reconcile before trading again`,
        now,
      );
    }
    deps.store.mandates.journal({
      at: now,
      kind: unknown ? "halted" : "exit_failed",
      symbol,
      mandateId: mandate.id,
      headline: unknown ? `Exit for ${symbol} unresolved — Kertel stopped` : `Exit for ${symbol} refused`,
      detail: placed.error.detail,
      evidence,
    });
    return { text: `${symbol}: exit failed — ${placed.error.detail}`, fired: false };
  }

  const order = placed.value;
  const soldBps = Math.min(10_000, mandate.soldBps + trigger.sellFractionBps);
  deps.store.mandates.recordProgress(
    mandate.id,
    trigger.highWaterBps,
    soldBps,
    fp.format(fp.add(mandate.soldQuantity, order.filledQuantity)),
  );
  if (soldBps >= 10_000 || trigger.reason !== "take_profit") {
    // A stop closes the position outright; a final rung finishes the ladder.
    deps.store.mandates.setStatus(mandate.id, "completed");
  }

  const realised =
    order.averagePrice === null
      ? null
      : fp.multiply(fp.subtract(order.averagePrice, mandate.entryPrice), order.filledQuantity);

  const headline = `Sold ${fp.format(order.filledQuantity)} ${symbol}${
    order.averagePrice === null ? "" : ` at ${fp.format(order.averagePrice)}`
  } (${trigger.reason.replace(/_/g, " ")})`;

  // Recorded now, not reconstructed from the journal later. This row is what
  // kertel_review is built on, and what a lesson is eventually derived from.
  if (order.averagePrice !== null) {
    deps.store.mandates.recordOutcome(
      outcomeFrom({
        at: now,
        symbol,
        mandateId: mandate.id,
        reason: trigger.reason,
        entryPrice: mandate.entryPrice,
        exitPrice: order.averagePrice,
        quantity: order.filledQuantity,
        peakBps: trigger.highWaterBps,
      }),
    );
  }

  deps.store.mandates.journal({
    at: now,
    kind: "exit_fired",
    symbol,
    mandateId: mandate.id,
    headline,
    detail: `${trigger.because}${
      realised === null ? "" : ` Realised ${fp.format(realised)} against entry ${fp.format(mandate.entryPrice)}.`
    } Order ${order.exchangeOrderRef}.`,
    evidence,
  });

  deps.log.info("autonomous exit", {
    symbol,
    mandateId: mandate.id,
    reason: trigger.reason,
    filled: fp.format(order.filledQuantity),
    ref: order.exchangeOrderRef,
  });

  return { text: `${symbol}: ${headline}. ${trigger.because}`, fired: true };
}

export type Monitor = {
  start(): void;
  stop(): void;
  readonly running: boolean;
};

/**
 * Run `sweep` on a timer.
 *
 * `unref` so a pending tick never holds the process open — an MCP server that
 * will not exit because a monitor is sleeping is a server the client reports as
 * hung.
 */
export function createMonitor(deps: MonitorDeps, intervalMs: number): Monitor {
  let timer: NodeJS.Timeout | null = null;
  let inFlight = false;

  async function tick(): Promise<void> {
    // Skip rather than queue. A sweep that overruns its interval must not have a
    // second copy of itself evaluating the same mandate.
    if (inFlight) {
      return;
    }
    inFlight = true;
    try {
      const result = await sweep(deps);
      if (result.halted !== null) {
        deps.log.warn("monitor halted", { reason: result.halted });
      } else if (result.checked > 0) {
        deps.log.debug("monitor swept", { checked: result.checked, fired: result.fired });
      }
    } catch (cause) {
      // A monitor that dies silently is worse than one that never ran.
      deps.log.error("monitor sweep failed", { cause });
    } finally {
      inFlight = false;
    }
  }

  return {
    start() {
      if (timer !== null) {
        return;
      }
      timer = setInterval(() => void tick(), intervalMs);
      timer.unref();
      deps.log.info("monitor started", { intervalMs });
    },
    stop() {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    },
    get running() {
      return timer !== null;
    },
  };
}
