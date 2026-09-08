/**
 * The money Telt may commit to its own ideas.
 *
 * Everywhere else in Telt a human types a code before an order is sent, and
 * that is right for a trade the human asked for. It is useless for the thing a
 * trading agent is actually for: seeing something at four in the morning and
 * acting while it is still there. An agent that must wake you to act is a
 * notification with extra steps.
 *
 * So there is exactly one place where Telt may open a position nobody asked
 * for, and this is the accounting behind it. The shape of the permission
 * matters more than the code:
 *
 * - **The human still authorises, once, explicitly, with a code.** Arming a
 *   budget is itself a confirmed action. What changes is the granularity — you
 *   approve an amount and a set of rules, not each trade.
 * - **It is a budget, not a limit.** It depletes as it is used and does not
 *   refill on its own. Ten dollars means ten dollars in total, not ten dollars
 *   per trade and not ten dollars a day. When it is gone Telt goes back to
 *   asking, and says so.
 * - **It bounds the loss, not the position.** What is committed is what could
 *   be lost: for spot, the notional; for futures, the margin, because that is
 *   the number the exchange can take.
 * - **Nothing about it weakens any other control.** The per-trade cap, the
 *   symbol gate, the slippage cap, the exchange minimums, the kill switch and
 *   the reconciliation halt all apply exactly as before. This budget only ever
 *   subtracts permission from what those already allow.
 * - **It expires.** A permission granted on Tuesday should not still be live in
 *   March. Silence is not consent forever.
 *
 * The one rule that is not obvious, and matters most: **a position opened from
 * this budget must carry an exit plan from the moment it exists.** Autonomy
 * that can open and cannot close is not autonomy, it is an unattended position.
 */

import * as fp from "../money/index.js";
import type { FixedPoint } from "../money/index.js";
import type { Instant } from "../domain/index.js";

export type DiscretionaryBudget = {
  /** What the human authorised in total, in quote currency. */
  readonly granted: FixedPoint;
  /** What has been committed so far. Only ever grows. */
  readonly committed: FixedPoint;
  /** Most that may go into any single self-found idea. */
  readonly perTradeCap: FixedPoint;
  readonly armedAt: Instant;
  readonly expiresAt: Instant;
  /**
   * Whether the human paused it without spending the rest.
   *
   * Separate from a spent budget, because the two mean different things to
   * whoever reads the status: one is "you used it", the other is "you stopped
   * it", and conflating them hides which.
   */
  readonly paused: boolean;
};

export type BudgetVerdict =
  | { readonly kind: "allowed"; readonly amount: FixedPoint; readonly remainingAfter: FixedPoint }
  | { readonly kind: "refused"; readonly code: BudgetRefusal; readonly because: string };

export type BudgetRefusal =
  | "NOT_ARMED"
  | "PAUSED"
  | "EXPIRED"
  | "EXHAUSTED"
  | "ABOVE_PER_TRADE_CAP"
  | "NOT_POSITIVE";

/** What is left to commit. Never negative, even if accounting drifted. */
export function remaining(budget: DiscretionaryBudget): FixedPoint {
  const left = fp.subtract(budget.granted, budget.committed);
  return fp.isNegative(left) ? fp.parse("0.00") : left;
}

/**
 * May Telt commit this much to an idea of its own?
 *
 * Deliberately not a clamp. A request above what is left is refused rather than
 * quietly shrunk, because an agent that silently trades a smaller size than its
 * own analysis called for has abandoned the analysis without telling anyone —
 * and the receipt would show a position nobody, human or machine, actually
 * chose.
 */
export function evaluateSpend(
  budget: DiscretionaryBudget | null,
  amount: FixedPoint,
  now: Instant,
): BudgetVerdict {
  if (budget === null) {
    return {
      kind: "refused",
      code: "NOT_ARMED",
      because:
        "No discretionary budget is armed, so Telt will not open a position nobody asked for. Arm one with telt_autonomy_arm.",
    };
  }
  if (budget.paused) {
    return {
      kind: "refused",
      code: "PAUSED",
      because: "The discretionary budget is paused. Telt will still research and report, but will not act on its own.",
    };
  }
  if (now >= budget.expiresAt) {
    return {
      kind: "refused",
      code: "EXPIRED",
      because:
        "The discretionary budget has expired. Permission to act unattended is not something that should outlive the day it was given.",
    };
  }
  if (!fp.isPositive(amount)) {
    return { kind: "refused", code: "NOT_POSITIVE", because: "An idea worth nothing is not worth acting on." };
  }
  if (fp.greaterThan(amount, budget.perTradeCap)) {
    return {
      kind: "refused",
      code: "ABOVE_PER_TRADE_CAP",
      because: `${fp.format(amount)} is above the ${fp.format(budget.perTradeCap)} you set for any single idea of Telt's own.`,
    };
  }

  const left = remaining(budget);
  if (fp.greaterThan(amount, left)) {
    return {
      kind: "refused",
      code: "EXHAUSTED",
      because: `Only ${fp.format(left)} of the ${fp.format(budget.granted)} discretionary budget is left, and this idea needs ${fp.format(amount)}. Telt will ask before spending more.`,
    };
  }

  return { kind: "allowed", amount, remainingAfter: fp.subtract(left, amount) };
}

/**
 * What a self-found trade puts at risk.
 *
 * Spot risks what it spends. Futures risks the margin, not the position: a 50
 * position at 3x can lose the ~17 behind it, and charging the budget the full
 * notional would make the agent look four times more reckless than it is while
 * charging it the wrong number.
 *
 * Rounded up, so the budget is never flattered by a fraction of a cent.
 */
export function amountAtRisk(input: {
  readonly market: "spot" | "futures";
  readonly notional: FixedPoint;
  readonly leverage: number;
}): FixedPoint {
  if (input.market === "spot" || input.leverage <= 1) {
    return input.notional;
  }
  return fp.divide(input.notional, fp.parse(String(input.leverage)), 2, "ceil");
}

export function commit(budget: DiscretionaryBudget, amount: FixedPoint): DiscretionaryBudget {
  return { ...budget, committed: fp.add(budget.committed, amount) };
}

/** How the budget reads back. Written for someone deciding whether to trust it. */
export function describeBudget(budget: DiscretionaryBudget | null, now: Instant): string {
  if (budget === null) {
    return [
      "Discretionary budget: none",
      "  Telt will research and flag opportunities, but will not open a position",
      "  unless you confirm it. Arm a budget to let it act on what it finds.",
    ].join("\n");
  }

  const left = remaining(budget);
  const lines: string[] = ["Discretionary budget"];
  lines.push(`  Granted:    ${fp.format(budget.granted)}`);
  lines.push(`  Committed:  ${fp.format(budget.committed)}`);
  lines.push(`  Remaining:  ${fp.format(left)}`);
  lines.push(`  Per idea:   ${fp.format(budget.perTradeCap)} at most`);

  if (budget.paused) {
    lines.push("  PAUSED. Telt is researching but not acting.");
  } else if (now >= budget.expiresAt) {
    lines.push("  EXPIRED. Telt is back to asking before every trade.");
  } else if (!fp.isPositive(left)) {
    lines.push("  SPENT. Telt is back to asking before every trade.");
  } else {
    const hours = Math.max(0, Math.round((budget.expiresAt - now) / 3_600_000));
    lines.push(`  Active for another ${String(hours)}h.`);
  }

  lines.push("");
  lines.push("  Every other limit still applies: the per-trade cap, the slippage");
  lines.push("  cap, the daily loss ceiling and the kill switch. This budget only");
  lines.push("  ever subtracts permission. Anything Telt opens from it carries an");
  lines.push("  exit plan from the moment it exists.");

  return lines.join("\n");
}
