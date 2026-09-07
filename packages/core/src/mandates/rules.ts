/**
 * How Kertel manages a position once it holds one.
 *
 * This is the difference between a trigger and a trader. "Sell at fifty percent"
 * is one line of arithmetic; a person who trades for a living does four things
 * that line does not:
 *
 * 1. **Scales out.** They take a third at the first target and let the rest run,
 *    because being right about direction and wrong about magnitude should still
 *    pay. All-or-nothing turns every winner into a coin flip about the top.
 * 2. **Ratchets the stop.** As the position gains, the stop follows it up. A
 *    fixed stop set at entry gives back the entire move on the way down.
 * 3. **Gets to breakeven.** Once a trade is up enough, the stop moves to what
 *    they paid. From that point the position cannot lose money, which is what
 *    lets them hold it long enough to be worth holding.
 * 4. **Asks why before acting.** A stop hit on thin overnight volume and a stop
 *    hit on a real repricing are different events. The evaluator flags which
 *    kind it thinks this is; the caller decides whether to buy evidence before
 *    firing.
 *
 * All of it is pure. Whether a position is due to be trimmed is a function of
 * the mandate, a price and a clock, so every branch is tested without a network,
 * a wallet, or waiting for a market to move.
 *
 * The confirmation spine is not abandoned, it moves up a level: the human
 * approves the *plan* once with a one-use code, and every exit it produces is
 * something they already authorised. Evidence before execution still holds —
 * what changed is that the evidence is a rule rather than a price.
 */

import * as fp from "../money/fixed-point.js";
import type { FixedPoint } from "../money/fixed-point.js";
import type { Instant } from "../domain/time.js";
import type { ProposalId, SenderIdHash, Symbol_ } from "../domain/types.js";

export type MandateId = string & { readonly __brand: "MandateId" };

/**
 * `pending` is the state a plan sits in until the human approves it with a
 * one-use code. A plan that watched a position before it was agreed to would
 * make the approval decorative.
 */
export type MandateStatus =
  | "pending"
  | "active"
  | "completed"
  | "cancelled"
  | "expired"
  | "unfulfillable";

/**
 * One rung of a scale-out.
 *
 * `fraction` is of the *original* position, not of what remains, so a ladder's
 * rungs always sum to what the user was shown. Expressing it against the
 * remainder makes "a third, then a third" mean two different sizes and nobody
 * reading it back can tell what they agreed to.
 */
export type LadderRung = {
  /** Basis points above entry at which this rung sells. */
  readonly atBps: number;
  /** Share of the original quantity, 1 to 10000 in basis points. */
  readonly fractionBps: number;
};

/**
 * A stop that follows the price up but never back down.
 *
 * `activateAtBps` keeps it out of the way early, where normal noise would stop
 * out a position that had not yet done anything wrong.
 */
export type TrailingStop = {
  readonly activateAtBps: number;
  readonly trailBps: number;
};

export type ExitMandate = {
  readonly id: MandateId;
  readonly senderIdHash: SenderIdHash;
  readonly symbol: Symbol_;
  /**
   * Which venue holds the position.
   *
   * The triggers are identical either way — a target is a target — but what is
   * on the other side of them is not. A spot exit sells coins from a balance; a
   * futures exit sends an opposite-side reduce-only order against a position
   * that can be liquidated out from under the plan. The monitor reads this to
   * decide which venue to ask and which exit to send.
   *
   * Long-only for now, on both. Every trigger here measures a gain as price
   * rising above entry, so a short would invert all of them.
   */
  readonly market: "spot" | "futures";
  /** What the position actually cost. Every trigger measures from here. */
  readonly entryPrice: FixedPoint;
  /** The original size. Ladder fractions are shares of this. */
  readonly quantity: FixedPoint;
  /** Scale-out rungs, ascending by `atBps`. Empty means no profit-taking. */
  readonly ladder: readonly LadderRung[];
  /** The hard floor, in basis points below entry. Null disables it. */
  readonly stopLossBps: number | null;
  readonly trailing: TrailingStop | null;
  /** Once up this far, the stop moves to entry and the trade cannot lose. */
  readonly breakevenAtBps: number | null;
  /**
   * The best move seen since the mandate began, in basis points.
   *
   * State, not configuration: the monitor ratchets it. It is what makes a
   * trailing stop trail, and it must never move down.
   */
  readonly highWaterBps: number;
  /** How much of the original quantity has already been sold, in basis points. */
  readonly soldBps: number;
  /**
   * What has actually been sold, in base units.
   *
   * Tracked alongside the basis points because each tranche is floored to the
   * exchange step independently, so the floors do not sum back to the whole. A
   * ladder that reasons only in basis points strands a few ten-thousandths of a
   * coin it can never sell — dust that is worth nothing and never goes away.
   */
  readonly soldQuantity: FixedPoint;
  readonly createdAt: Instant;
  readonly expiresAt: Instant;
  readonly status: MandateStatus;
  readonly sourceProposalId: ProposalId | null;
};

export type ExitReason = "take_profit" | "stop_loss" | "trailing_stop" | "breakeven_stop";

export type MandateTrigger =
  | { readonly kind: "idle"; readonly because: string; readonly highWaterBps: number }
  | {
      readonly kind: "fire";
      readonly reason: ExitReason;
      readonly because: string;
      readonly moveBps: number;
      readonly highWaterBps: number;
      /** How much of the original position to sell now. */
      readonly sellQuantity: FixedPoint;
      readonly sellFractionBps: number;
      /**
       * True when the exit is protective and the move looks abrupt enough to be
       * worth understanding before acting. The caller decides whether to spend
       * on evidence; the rule never spends on its own.
       */
      readonly worthChecking: boolean;
    }
  | { readonly kind: "expired"; readonly because: string }
  | { readonly kind: "unfulfillable"; readonly because: string };

const FULL = 10_000;

/**
 * How far the price has moved from entry, in basis points.
 *
 * Truncated toward zero, so a borderline move reads as triggered only when it
 * genuinely is one: rounding 4999 up to 5000 fires a target the market has not
 * earned.
 */
export function moveBps(entryPrice: FixedPoint, currentPrice: FixedPoint): number {
  if (!fp.isPositive(entryPrice)) {
    return 0;
  }
  const difference = fp.subtract(currentPrice, entryPrice);
  const scaled = fp.divide(fp.multiply(difference, fp.parse("10000")), entryPrice, 0, "trunc");
  return Number(scaled.atoms);
}

/**
 * Where the stop actually sits right now, in basis points from entry.
 *
 * Three rules can each supply a floor and the tightest one wins, because every
 * one of them exists to stop a loss and the tightest is the one that does it
 * soonest. Returns null when nothing protects the position.
 */
export function effectiveStopBps(mandate: ExitMandate): number | null {
  const floors: number[] = [];

  if (mandate.stopLossBps !== null) {
    floors.push(-mandate.stopLossBps);
  }
  if (mandate.breakevenAtBps !== null && mandate.highWaterBps >= mandate.breakevenAtBps) {
    // Up enough that the trade should no longer be allowed to lose.
    floors.push(0);
  }
  if (mandate.trailing !== null && mandate.highWaterBps >= mandate.trailing.activateAtBps) {
    floors.push(mandate.highWaterBps - mandate.trailing.trailBps);
  }

  return floors.length === 0 ? null : Math.max(...floors);
}

/** Which stop is doing the work, for a message the user can act on. */
function stopReason(mandate: ExitMandate, stopBps: number): ExitReason {
  if (
    mandate.trailing !== null &&
    mandate.highWaterBps >= mandate.trailing.activateAtBps &&
    stopBps === mandate.highWaterBps - mandate.trailing.trailBps
  ) {
    return "trailing_stop";
  }
  if (stopBps === 0 && mandate.breakevenAtBps !== null) {
    return "breakeven_stop";
  }
  return "stop_loss";
}

/**
 * The next unsold rung that the current price has reached.
 *
 * Rungs are matched against how much has already been sold rather than by
 * marking them individually, so a gap straight through two rungs sells both
 * shares at once instead of leaving one stranded below the price.
 */
function dueLadderBps(mandate: ExitMandate, move: number): number {
  let owed = 0;
  for (const rung of [...mandate.ladder].sort((a, b) => a.atBps - b.atBps)) {
    if (move >= rung.atBps) {
      owed += rung.fractionBps;
    }
  }
  return Math.max(0, Math.min(FULL, owed) - mandate.soldBps);
}

export type EvaluateInput = {
  readonly mandate: ExitMandate;
  /** What the position can actually be sold into: the bid, never the last trade. */
  readonly bidPrice: FixedPoint;
  /** Free balance of the base asset. */
  readonly heldQuantity: FixedPoint;
  readonly minQuantity: FixedPoint;
  readonly minNotional: FixedPoint;
  readonly now: Instant;
  /**
   * How far the price moved since the previous check, in basis points.
   *
   * Used only to judge whether a protective exit is abrupt enough to be worth
   * understanding first. Zero when there is no previous observation.
   */
  readonly moveSinceLastCheckBps?: number;
};

/** A drop this fast between two checks is news, not drift, and worth a look. */
const ABRUPT_MOVE_BPS = 300;

/**
 * Has this mandate come due, and for how much?
 *
 * Ordered deliberately: status, expiry, and whether the position could be sold
 * at all, before any price comparison. Checking the price first reports a
 * trigger on a position that no longer exists.
 */
export function evaluateMandate(input: EvaluateInput): MandateTrigger {
  const { mandate } = input;

  if (mandate.status !== "active") {
    return { kind: "idle", because: `This mandate is ${mandate.status}.`, highWaterBps: mandate.highWaterBps };
  }
  if (input.now >= mandate.expiresAt) {
    return {
      kind: "expired",
      because:
        "The mandate expired. A rule written about a market weeks ago is not one anybody would write today.",
    };
  }

  const move = moveBps(mandate.entryPrice, input.bidPrice);
  // The ratchet. It only ever goes up; that is the whole point of it.
  const highWaterBps = Math.max(mandate.highWaterBps, move);
  const ratcheted: ExitMandate = { ...mandate, highWaterBps };

  const remainingBps = FULL - mandate.soldBps;
  if (remainingBps <= 0) {
    return { kind: "idle", because: "This position has been fully exited.", highWaterBps };
  }

  // The entitlement is what the mandate covers minus what it has actually sold,
  // never a fresh fraction of the original. Capped by the balance, so a mandate
  // can never reach coins the user acquired elsewhere.
  const entitlement = fp.subtract(mandate.quantity, mandate.soldQuantity);
  const remaining = fp.min(entitlement, input.heldQuantity);
  if (!fp.isPositive(remaining)) {
    return {
      kind: "unfulfillable",
      because: `The account holds no ${mandate.symbol} to sell, so this mandate cannot be honoured.`,
    };
  }

  const stopBps = effectiveStopBps(ratcheted);
  const ladderBps = dueLadderBps(ratcheted, move);

  // Protective side first. A move that satisfies a stop and a profit rung in the
  // same tick is a gap, and any other precedence sells into a collapse while
  // calling it profit-taking.
  const stopHit = stopBps !== null && move <= stopBps;
  const sellBps = stopHit ? remainingBps : ladderBps;

  if (sellBps <= 0) {
    const waiting: string[] = [];
    const nextRung = [...mandate.ladder]
      .sort((a, b) => a.atBps - b.atBps)
      .find((rung) => move < rung.atBps);
    if (nextRung !== undefined) {
      waiting.push(`+${String(nextRung.atBps / 100)}%`);
    }
    if (stopBps !== null) {
      waiting.push(`${stopBps >= 0 ? "+" : ""}${String(stopBps / 100)}%`);
    }
    return {
      kind: "idle",
      highWaterBps,
      because: `${move >= 0 ? "Up" : "Down"} ${String(Math.abs(move) / 100)}% from entry, peak +${String(highWaterBps / 100)}%${
        waiting.length === 0 ? "" : `; waiting for ${waiting.join(" or ")}`
      }.`,
    };
  }

  // What this rung is worth in base units, capped by what is left. A stop takes
  // the entire remaining entitlement, which is why it is not a fraction at all.
  let sellQuantity = stopHit
    ? remaining
    : fp.min(
        fp.divide(
          fp.multiply(mandate.quantity, fp.parse(String(sellBps))),
          fp.parse("10000"),
          mandate.quantity.scale,
          "floor",
        ),
        remaining,
      );

  // A residue too small to sell on its own is worse than no scale-out at all:
  // it strands value below the exchange minimum forever. Take the whole
  // remainder instead.
  const leftover = fp.subtract(remaining, sellQuantity);
  const strands =
    fp.isPositive(leftover) &&
    (fp.lessThan(leftover, input.minQuantity) ||
      fp.lessThan(fp.multiply(leftover, input.bidPrice), input.minNotional));
  if (strands) {
    sellQuantity = remaining;
  }

  if (fp.lessThan(sellQuantity, input.minQuantity)) {
    return {
      kind: "unfulfillable",
      because: `The tranche due (${fp.format(sellQuantity)}) is below the exchange minimum of ${fp.format(input.minQuantity)}.`,
    };
  }
  if (fp.lessThan(fp.multiply(sellQuantity, input.bidPrice), input.minNotional)) {
    return {
      kind: "unfulfillable",
      because: `The tranche due is worth less than the exchange minimum of ${fp.format(input.minNotional)}, so it cannot be sold.`,
    };
  }

  const reason: ExitReason = stopHit ? stopReason(ratcheted, stopBps) : "take_profit";
  const sold = strands ? FULL : mandate.soldBps + sellBps;

  const because = stopHit
    ? reason === "trailing_stop"
      ? `Down to ${String(move / 100)}% from a peak of +${String(highWaterBps / 100)}%, through the trailing stop. Locking in the move.`
      : reason === "breakeven_stop"
        ? `Back to entry after being up ${String(highWaterBps / 100)}%. Closing flat rather than giving it back.`
        : `Down ${String(Math.abs(move) / 100)}% from entry, past the ${String((mandate.stopLossBps ?? 0) / 100)}% stop.`
    : `Up ${String(move / 100)}% from entry. Taking ${String(sellBps / 100)}% of the position${
        sold >= FULL ? " and closing out" : ", letting the rest run"
      }.`;

  return {
    kind: "fire",
    reason,
    because,
    moveBps: move,
    highWaterBps,
    sellQuantity,
    sellFractionBps: sellBps,
    // Only protective exits are worth pausing over, and only abrupt ones. A
    // target being hit needs no explanation; a stop hit in seconds might.
    worthChecking:
      stopHit && Math.abs(input.moveSinceLastCheckBps ?? 0) >= ABRUPT_MOVE_BPS,
  };
}

export type MandateProblem = string;

/**
 * Reject a plan that cannot do what it appears to promise.
 *
 * Returned rather than thrown: every one of these is something the user can
 * restate, and all of them should be quotable back to them at once.
 */
export function validateMandate(input: {
  readonly ladder: readonly LadderRung[];
  readonly stopLossBps: number | null;
  readonly trailing: TrailingStop | null;
  readonly breakevenAtBps: number | null;
  readonly quantity: FixedPoint;
  readonly entryPrice: FixedPoint;
  readonly maxBps: number;
}): readonly MandateProblem[] {
  const problems: MandateProblem[] = [];

  if (input.ladder.length === 0 && input.stopLossBps === null && input.trailing === null) {
    problems.push("a plan needs at least one exit: a profit target, a stop, or a trailing stop");
  }

  let total = 0;
  for (const rung of input.ladder) {
    if (!Number.isInteger(rung.atBps) || rung.atBps <= 0) {
      problems.push("every profit target must be a positive whole number of basis points");
    } else if (rung.atBps > input.maxBps) {
      problems.push(
        `a target of ${String(rung.atBps / 100)}% is above the ${String(input.maxBps / 100)}% limit`,
      );
    }
    if (!Number.isInteger(rung.fractionBps) || rung.fractionBps <= 0) {
      problems.push("every tranche must be a positive share of the position");
    }
    total += rung.fractionBps;
  }
  if (total > FULL) {
    problems.push(
      `the tranches add up to ${String(total / 100)}% of the position, which is more than there is`,
    );
  }

  if (input.stopLossBps !== null) {
    if (!Number.isInteger(input.stopLossBps) || input.stopLossBps <= 0) {
      problems.push("the stop must be a positive whole number of basis points");
    } else if (input.stopLossBps >= FULL) {
      problems.push("a stop of 100% or more can never trigger, because the price cannot go below zero");
    }
  }

  if (input.trailing !== null) {
    if (!Number.isInteger(input.trailing.trailBps) || input.trailing.trailBps <= 0) {
      problems.push("the trailing distance must be a positive whole number of basis points");
    }
    if (!Number.isInteger(input.trailing.activateAtBps) || input.trailing.activateAtBps < 0) {
      problems.push("the trailing activation must be zero or a positive whole number of basis points");
    }
  }

  if (input.breakevenAtBps !== null && (!Number.isInteger(input.breakevenAtBps) || input.breakevenAtBps <= 0)) {
    problems.push("the breakeven trigger must be a positive whole number of basis points");
  }

  if (!fp.isPositive(input.quantity)) {
    problems.push("the quantity must be greater than zero");
  }
  if (!fp.isPositive(input.entryPrice)) {
    problems.push("the entry price must be greater than zero");
  }

  return problems;
}

/** The price a leg fires at, so the confirmation message shows real numbers. */
export function priceAtBps(entryPrice: FixedPoint, bps: number): FixedPoint {
  const magnitude = fp.applyBasisPoints(entryPrice, Math.abs(bps), bps >= 0 ? "ceil" : "floor");
  return bps >= 0 ? fp.add(entryPrice, magnitude) : fp.subtract(entryPrice, magnitude);
}
