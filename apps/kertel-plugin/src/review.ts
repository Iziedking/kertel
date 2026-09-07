/**
 * What Kertel planned, what actually happened, and what to do differently.
 *
 * An agent that cannot be held to its own record is one you have to take on
 * faith every single time. This module closes that loop, and it does it with a
 * strict division of labour that is worth stating plainly:
 *
 * **Kertel owns the facts.** Every plan it drafted, every exit it fired, every
 * fill price, every basis point of slippage against what it promised. These are
 * recorded at the moment they happen, in the same database as the money, and
 * they are not a model's recollection of events — they are the events.
 *
 * **Agent Memory owns the portability.** The user's own memory service carries
 * a digest across machines and across agents, so a lesson learned on Monday is
 * available to a fresh session on Friday. Kertel does not talk to it directly
 * and deliberately holds no credential for it: the connector keeps the
 * passphrase in the OS keychain precisely so no secret sits in a config file,
 * and Kertel duplicating that would break the one property it exists to
 * provide.
 *
 * **The client model is the bridge.** It recalls, hands what it found to
 * `kertel_learn`, and stores the digest `kertel_review` produces. That is the
 * same division as everywhere else in this product: Kertel is deterministic and
 * auditable, the model reasons and carries.
 *
 * The effect is an agent that gets better in a way you can check. Not "it has
 * learned" — a specific line saying a −15% stop on ETH was hit three times and
 * recovered within a day twice, next to the plan where you are about to set one
 * again.
 */

import * as fp from "@kertel/core/money";
import type { FixedPoint } from "@kertel/core/money";
import { formatInstant, utcDay } from "@kertel/core/domain";
import type { Instant, Symbol_ } from "@kertel/core/domain";
import { moveBps } from "@kertel/core/mandates";

import type { Store } from "./infra/store.js";

export type ReviewDeps = {
  readonly store: Store;
  readonly now: () => Instant;
};

/**
 * One completed decision, as it actually turned out.
 *
 * Recorded when an exit fires, not reconstructed later from a journal, because
 * a reconstruction is only ever as good as the parser that reads it.
 */
export type Outcome = {
  readonly at: Instant;
  readonly symbol: string;
  readonly mandateId: string;
  readonly reason: string;
  readonly entryPrice: string;
  readonly exitPrice: string;
  readonly quantity: string;
  /** Signed basis points against entry. */
  readonly moveBps: number;
  /** What the position had been worth at its best, in basis points. */
  readonly peakBps: number;
  /** Whether the price recovered above the exit within the following day. */
  readonly recoveredWithin24h: boolean | null;
};

export type Lesson = {
  readonly symbol: string;
  readonly text: string;
  readonly learnedAt: Instant;
  /** Where it came from: Kertel's own review, or recalled from memory. */
  readonly source: "review" | "recalled";
};

/**
 * Statistics a person can argue with.
 *
 * Deliberately plain counts and averages over the real record. A confidence
 * interval on eleven trades would be theatre.
 */
export type Performance = {
  readonly closed: number;
  readonly winners: number;
  readonly losers: number;
  readonly stoppedOut: number;
  readonly takeProfits: number;
  readonly trailingStops: number;
  readonly averageMoveBps: number;
  readonly bestBps: number;
  readonly worstBps: number;
  /** Stops that would have been better left alone. The expensive kind of mistake. */
  readonly stoppedThenRecovered: number;
  /** How much profit was given back between the peak and the exit. */
  readonly averageGiveBackBps: number;
};

export function summarise(outcomes: readonly Outcome[]): Performance {
  if (outcomes.length === 0) {
    return {
      closed: 0,
      winners: 0,
      losers: 0,
      stoppedOut: 0,
      takeProfits: 0,
      trailingStops: 0,
      averageMoveBps: 0,
      bestBps: 0,
      worstBps: 0,
      stoppedThenRecovered: 0,
      averageGiveBackBps: 0,
    };
  }

  let total = 0;
  let best = outcomes[0]?.moveBps ?? 0;
  let worst = outcomes[0]?.moveBps ?? 0;
  let giveBack = 0;
  let winners = 0;
  let stoppedOut = 0;
  let takeProfits = 0;
  let trailingStops = 0;
  let stoppedThenRecovered = 0;

  for (const outcome of outcomes) {
    total += outcome.moveBps;
    best = Math.max(best, outcome.moveBps);
    worst = Math.min(worst, outcome.moveBps);
    // Only ever positive: the exit cannot be above the peak.
    giveBack += Math.max(0, outcome.peakBps - outcome.moveBps);
    if (outcome.moveBps > 0) winners += 1;
    if (outcome.reason === "stop_loss" || outcome.reason === "breakeven_stop") stoppedOut += 1;
    if (outcome.reason === "take_profit") takeProfits += 1;
    if (outcome.reason === "trailing_stop") trailingStops += 1;
    if (outcome.recoveredWithin24h === true && outcome.reason !== "take_profit") {
      stoppedThenRecovered += 1;
    }
  }

  return {
    closed: outcomes.length,
    winners,
    losers: outcomes.length - winners,
    stoppedOut,
    takeProfits,
    trailingStops,
    averageMoveBps: Math.round(total / outcomes.length),
    bestBps: best,
    worstBps: worst,
    stoppedThenRecovered,
    averageGiveBackBps: Math.round(giveBack / outcomes.length),
  };
}

/**
 * Turn the record into things to do differently.
 *
 * Each rule needs enough evidence to be worth stating, and says what it saw
 * rather than issuing an instruction. "Three of your four stops recovered
 * within a day" is a fact the user can act on; "widen your stops" is advice
 * dressed up as a finding.
 */
export function deriveLessons(
  outcomes: readonly Outcome[],
  now: Instant,
): readonly Lesson[] {
  const lessons: Lesson[] = [];
  const bySymbol = new Map<string, Outcome[]>();
  for (const outcome of outcomes) {
    const list = bySymbol.get(outcome.symbol) ?? [];
    list.push(outcome);
    bySymbol.set(outcome.symbol, list);
  }

  for (const [symbol, list] of bySymbol) {
    // Two is not a pattern. Three is worth writing down.
    if (list.length < 3) {
      continue;
    }
    const stats = summarise(list);

    if (stats.stoppedOut >= 2 && stats.stoppedThenRecovered >= Math.ceil(stats.stoppedOut / 2)) {
      lessons.push({
        symbol,
        source: "review",
        learnedAt: now,
        text: `${String(stats.stoppedThenRecovered)} of ${String(stats.stoppedOut)} stops on ${symbol} recovered above the exit within a day. The stop may be inside normal noise for this pair — consider a wider one, or a trailing stop that only arms after a real gain.`,
      });
    }

    if (stats.averageGiveBackBps >= 1000 && stats.takeProfits >= 2) {
      lessons.push({
        symbol,
        source: "review",
        learnedAt: now,
        text: `On ${symbol} the average exit gave back ${String(Math.round(stats.averageGiveBackBps / 100))}% from the peak. A trailing stop, or an earlier first rung, would have kept more of it.`,
      });
    }

    if (stats.takeProfits >= 3 && stats.averageMoveBps > 0 && stats.bestBps >= stats.averageMoveBps * 2) {
      lessons.push({
        symbol,
        source: "review",
        learnedAt: now,
        text: `${symbol} has run to +${String(Math.round(stats.bestBps / 100))}% at least once while the average exit was +${String(Math.round(stats.averageMoveBps / 100))}%. Leaving a final tranche without a target has paid here.`,
      });
    }

    if (stats.closed >= 4 && stats.winners === 0) {
      lessons.push({
        symbol,
        source: "review",
        learnedAt: now,
        text: `Every one of the last ${String(stats.closed)} closed positions in ${symbol} lost money. Whatever is being used to pick entries here is not working; stop trading it until something changes.`,
      });
    }
  }

  return lessons;
}

/** The performance report a person reads. */
export function renderReview(deps: ReviewDeps, outcomes: readonly Outcome[]): string {
  const now = deps.now();
  const stats = summarise(outcomes);

  if (stats.closed === 0) {
    return [
      "No closed positions yet, so there is nothing to review.",
      "",
      "Kertel records every exit as it happens — the fill price, the move against entry,",
      "and how much was given back from the peak. Once a few have closed, this becomes",
      "a record you can hold it to.",
    ].join("\n");
  }

  const lines: string[] = ["How Kertel has actually done", ""];
  lines.push(`Closed positions:  ${String(stats.closed)}`);
  lines.push(`Winners / losers:  ${String(stats.winners)} / ${String(stats.losers)}`);
  lines.push(
    `Average outcome:   ${stats.averageMoveBps >= 0 ? "+" : ""}${String(stats.averageMoveBps / 100)}%`,
  );
  lines.push(`Best / worst:      +${String(stats.bestBps / 100)}% / ${String(stats.worstBps / 100)}%`);
  lines.push("");
  lines.push(`Exits by kind:     ${String(stats.takeProfits)} target, ${String(stats.trailingStops)} trailing, ${String(stats.stoppedOut)} stopped`);
  lines.push(`Given back from peak: ${String(stats.averageGiveBackBps / 100)}% on average`);
  if (stats.stoppedThenRecovered > 0) {
    lines.push(
      `Stops that recovered within a day: ${String(stats.stoppedThenRecovered)} — the expensive kind of mistake`,
    );
  }
  lines.push("");

  lines.push("Recent exits");
  for (const outcome of outcomes.slice(0, 10)) {
    lines.push(
      `  ${formatInstant(outcome.at)}  ${outcome.symbol}  ${outcome.reason.replace(/_/g, " ")}  ${
        outcome.moveBps >= 0 ? "+" : ""
      }${String(outcome.moveBps / 100)}%  (peak +${String(outcome.peakBps / 100)}%)`,
    );
  }
  lines.push("");

  const lessons = deriveLessons(outcomes, now);
  if (lessons.length === 0) {
    lines.push("No patterns worth acting on yet. Three closed positions in one symbol is the threshold.");
  } else {
    lines.push("What to do differently");
    for (const lesson of lessons) {
      lines.push(`  - ${lesson.text}`);
    }
  }

  return lines.join("\n");
}

/**
 * A note shaped for the user's own memory service.
 *
 * Written to the contract Agent Memory asks for: today's date first, concrete
 * things named, and the reason rather than only the fact — so a fresh session
 * on another machine can act on it without any of this context.
 */
export function memoryDigest(deps: ReviewDeps, outcomes: readonly Outcome[]): string {
  const now = deps.now();
  const stats = summarise(outcomes);
  const lessons = deriveLessons(outcomes, now);

  const lines: string[] = [];
  lines.push(`${utcDay(now)} — Kertel trading record.`);
  lines.push("");

  if (stats.closed === 0) {
    lines.push("No positions have closed yet. Nothing to carry forward.");
    return lines.join("\n");
  }

  lines.push(
    `${String(stats.closed)} closed: ${String(stats.winners)} up, ${String(stats.losers)} down, average ${
      stats.averageMoveBps >= 0 ? "+" : ""
    }${String(stats.averageMoveBps / 100)}%. Best +${String(stats.bestBps / 100)}%, worst ${String(stats.worstBps / 100)}%.`,
  );
  lines.push(
    `Exits: ${String(stats.takeProfits)} hit a target, ${String(stats.trailingStops)} trailed out, ${String(stats.stoppedOut)} stopped. Average give-back from peak ${String(stats.averageGiveBackBps / 100)}%.`,
  );
  lines.push("");

  if (lessons.length > 0) {
    lines.push("LESSONS, to apply before writing the next exit plan:");
    for (const lesson of lessons) {
      lines.push(`- ${lesson.text}`);
    }
    lines.push("");
  }

  lines.push("Per symbol:");
  const bySymbol = new Map<string, Outcome[]>();
  for (const outcome of outcomes) {
    const list = bySymbol.get(outcome.symbol) ?? [];
    list.push(outcome);
    bySymbol.set(outcome.symbol, list);
  }
  for (const [symbol, list] of bySymbol) {
    const symbolStats = summarise(list);
    lines.push(
      `- ${symbol}: ${String(symbolStats.closed)} closed, ${String(symbolStats.winners)} up, average ${
        symbolStats.averageMoveBps >= 0 ? "+" : ""
      }${String(symbolStats.averageMoveBps / 100)}%, ${String(symbolStats.stoppedOut)} stopped (${String(symbolStats.stoppedThenRecovered)} of those recovered within a day).`,
    );
  }

  lines.push("");
  lines.push(
    "Kertel keeps the underlying records locally in its own database; this is the portable summary.",
  );
  return lines.join("\n");
}

/** What a recorded exit means against the plan it came from. */
export function outcomeFrom(input: {
  readonly at: Instant;
  readonly symbol: Symbol_;
  readonly mandateId: string;
  readonly reason: string;
  readonly entryPrice: FixedPoint;
  readonly exitPrice: FixedPoint;
  readonly quantity: FixedPoint;
  readonly peakBps: number;
}): Outcome {
  return {
    at: input.at,
    symbol: input.symbol,
    mandateId: input.mandateId,
    reason: input.reason,
    entryPrice: fp.format(input.entryPrice),
    exitPrice: fp.format(input.exitPrice),
    quantity: fp.format(input.quantity),
    moveBps: moveBps(input.entryPrice, input.exitPrice),
    peakBps: input.peakBps,
    recoveredWithin24h: null,
  };
}
