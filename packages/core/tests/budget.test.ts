/**
 * The rules behind the only unattended spending Telt can do.
 *
 * Every other order in Telt waits for a human to type a code. This is the one
 * exception, so these tests are less about arithmetic than about the shape of
 * the permission: that it runs out, that it expires, that it cannot be talked
 * upward, and that refusing is always the default when anything is unclear.
 */

import { describe, expect, it } from "vitest";

import * as fp from "../src/money/index.js";
import { instant } from "../src/domain/index.js";
import {
  amountAtRisk,
  commit,
  describeBudget,
  evaluateSpend,
  remaining,
} from "../src/autonomy/budget.js";
import type { DiscretionaryBudget } from "../src/autonomy/budget.js";

const NOW = instant(Date.parse("2026-09-08T12:00:00.000Z"));
const HOUR = 3_600_000;

function budget(overrides: Partial<DiscretionaryBudget> = {}): DiscretionaryBudget {
  return {
    granted: fp.parse("10.00"),
    committed: fp.parse("0.00"),
    perTradeCap: fp.parse("4.00"),
    armedAt: NOW,
    expiresAt: instant(NOW + 24 * HOUR),
    paused: false,
    ...overrides,
  };
}

describe("spending on its own ideas", () => {
  it("refuses everything when no budget was ever armed", () => {
    // The default, and the important one: an agent that can act unattended
    // because nobody said it could not is not an agent anyone should run.
    const verdict = evaluateSpend(null, fp.parse("1.00"), NOW);
    expect(verdict.kind).toBe("refused");
    if (verdict.kind === "refused") {
      expect(verdict.code).toBe("NOT_ARMED");
      expect(verdict.because).toContain("nobody asked for");
    }
  });

  it("allows an idea inside the budget", () => {
    const verdict = evaluateSpend(budget(), fp.parse("3.00"), NOW);
    expect(verdict.kind).toBe("allowed");
    if (verdict.kind === "allowed") {
      expect(fp.format(verdict.remainingAfter)).toBe("7.00");
    }
  });

  it("refuses rather than quietly trading smaller", () => {
    // The subtle one. Shrinking a 3.00 idea into the 2.00 that is left would
    // put on a position that neither the human nor the analysis chose, and the
    // receipt would not show that anything had been overridden.
    //
    // 3.00 is deliberately inside the 4.00 per-idea cap, so this isolates
    // running out of budget from breaching the cap.
    const spent = budget({ committed: fp.parse("8.00") });
    const verdict = evaluateSpend(spent, fp.parse("3.00"), NOW);

    expect(verdict.kind).toBe("refused");
    if (verdict.kind === "refused") {
      expect(verdict.code).toBe("EXHAUSTED");
      expect(verdict.because).toContain("2.00");
      expect(verdict.because).toContain("ask");
    }
  });

  it("holds the per-idea cap even when plenty is left", () => {
    const verdict = evaluateSpend(budget(), fp.parse("9.00"), NOW);
    expect(verdict.kind).toBe("refused");
    if (verdict.kind === "refused") expect(verdict.code).toBe("ABOVE_PER_TRADE_CAP");
  });

  it("stops at expiry, because consent does not last forever", () => {
    const verdict = evaluateSpend(budget(), fp.parse("1.00"), instant(NOW + 25 * HOUR));
    expect(verdict.kind).toBe("refused");
    if (verdict.kind === "refused") expect(verdict.code).toBe("EXPIRED");
  });

  it("stops when paused, without spending the rest", () => {
    const verdict = evaluateSpend(budget({ paused: true }), fp.parse("1.00"), NOW);
    expect(verdict.kind).toBe("refused");
    if (verdict.kind === "refused") {
      expect(verdict.code).toBe("PAUSED");
      // Still researches. Pausing autonomy is not switching the agent off.
      expect(verdict.because).toContain("research");
    }
  });

  it("does not refill on its own", () => {
    // A budget that resets daily is a standing order, not a budget. Ten dollars
    // has to mean ten dollars.
    let live = budget();
    for (const amount of ["4.00", "4.00", "2.00"]) {
      const verdict = evaluateSpend(live, fp.parse(amount), NOW);
      expect(verdict.kind).toBe("allowed");
      live = commit(live, fp.parse(amount));
    }
    expect(fp.format(remaining(live))).toBe("0.00");

    // A day later it is still spent.
    const later = evaluateSpend(live, fp.parse("1.00"), instant(NOW + 12 * HOUR));
    expect(later.kind).toBe("refused");
    if (later.kind === "refused") expect(later.code).toBe("EXHAUSTED");
  });

  it("never reports a negative remainder", () => {
    // Defensive: if accounting ever drifted, "you have minus three dollars"
    // helps nobody and reads as a bug in the money.
    const over = budget({ committed: fp.parse("13.00") });
    expect(fp.format(remaining(over))).toBe("0.00");
  });
});

describe("what a self-found trade puts at risk", () => {
  it("charges spot the whole notional", () => {
    expect(fp.format(amountAtRisk({ market: "spot", notional: fp.parse("6.00"), leverage: 1 }))).toBe(
      "6.00",
    );
  });

  it("charges futures the margin, not the position", () => {
    // A 50 position at 3x can lose the ~17 behind it. Charging the budget the
    // full 50 would make the agent look three times more reckless than it is,
    // and would exhaust a real budget on one ordinary trade.
    expect(
      fp.format(amountAtRisk({ market: "futures", notional: fp.parse("50.00"), leverage: 3 })),
    ).toBe("16.67");
  });

  it("rounds the margin up, so the budget is never flattered", () => {
    expect(
      fp.format(amountAtRisk({ market: "futures", notional: fp.parse("10.00"), leverage: 3 })),
    ).toBe("3.34");
  });
});

describe("how it reads back", () => {
  it("says plainly when nothing is armed", () => {
    const body = describeBudget(null, NOW);
    expect(body).toContain("none");
    expect(body).toContain("will not open a position");
  });

  it("distinguishes spent from paused", () => {
    // Two different facts about why nothing is happening, and a status that
    // conflated them would hide which one the reader needs to act on.
    expect(describeBudget(budget({ committed: fp.parse("10.00") }), NOW)).toContain("SPENT");
    expect(describeBudget(budget({ paused: true }), NOW)).toContain("PAUSED");
  });

  it("repeats that the other limits still apply", () => {
    const body = describeBudget(budget(), NOW);
    expect(body).toContain("kill switch");
    expect(body).toContain("exit plan");
  });
});
