import { describe, expect, it } from "vitest";

import * as fp from "../src/money/fixed-point.js";
import {
  effectiveStopBps,
  evaluateMandate,
  moveBps,
  priceAtBps,
  validateMandate,
} from "../src/mandates/rules.js";
import type { ExitMandate, MandateId } from "../src/mandates/rules.js";
import type { ProposalId, SenderIdHash } from "../src/domain/types.js";
import { ETHUSDT, T0, at } from "./builders.js";

/** A third at +25%, a third at +50%, the rest at +100%, stopped at -15%. */
function mandate(overrides: Partial<ExitMandate> = {}): ExitMandate {
  return {
    id: "m-1" as MandateId,
    senderIdHash: "sha256:owner" as SenderIdHash,
    symbol: ETHUSDT,
    entryPrice: fp.parse("2000.00"),
    quantity: fp.parse("0.3000"),
    ladder: [
      { atBps: 2500, fractionBps: 3333 },
      { atBps: 5000, fractionBps: 3333 },
      { atBps: 10_000, fractionBps: 3334 },
    ],
    stopLossBps: 1500,
    trailing: { activateAtBps: 3000, trailBps: 1000 },
    breakevenAtBps: 2000,
    highWaterBps: 0,
    soldBps: 0,
    soldQuantity: fp.parse("0.0000"),
    createdAt: T0,
    expiresAt: at(86_400),
    status: "active",
    sourceProposalId: null as ProposalId | null,
    ...overrides,
  };
}

function evaluate(
  bid: string,
  overrides: Partial<ExitMandate> = {},
  options: { held?: string; sinceLast?: number } = {},
) {
  return evaluateMandate({
    mandate: mandate(overrides),
    bidPrice: fp.parse(bid),
    heldQuantity: fp.parse(options.held ?? "0.3000"),
    minQuantity: fp.parse("0.0001"),
    minNotional: fp.parse("5.00"),
    now: at(60),
    ...(options.sinceLast === undefined ? {} : { moveSinceLastCheckBps: options.sinceLast }),
  });
}

describe("measuring the move", () => {
  it("measures against what was paid, not against the peak", () => {
    expect(moveBps(fp.parse("2000.00"), fp.parse("3000.00"))).toBe(5000);
    expect(moveBps(fp.parse("2000.00"), fp.parse("1700.00"))).toBe(-1500);
  });

  it("truncates toward zero, so a target does not fire early", () => {
    expect(moveBps(fp.parse("2000.00"), fp.parse("2999.99"))).toBe(4999);
    expect(moveBps(fp.parse("2000.00"), fp.parse("1700.01"))).toBe(-1499);
  });
});

describe("scaling out, the way a trader does", () => {
  it("takes the first third at the first target and lets the rest run", () => {
    const trigger = evaluate("2500.00"); // +25%
    expect(trigger.kind).toBe("fire");
    if (trigger.kind !== "fire") return;

    expect(trigger.reason).toBe("take_profit");
    expect(trigger.sellFractionBps).toBe(3333);
    expect(fp.format(trigger.sellQuantity)).toBe("0.0999");
    expect(trigger.because).toContain("letting the rest run");
  });

  it("does not sell the same rung twice", () => {
    // First third already taken; the price has not reached the next rung.
    const trigger = evaluate("2600.00", { soldBps: 3333, soldQuantity: fp.parse("0.0999") });
    expect(trigger.kind).toBe("idle");
    if (trigger.kind !== "idle") return;
    expect(trigger.because).toContain("waiting for +50%");
  });

  it("takes both rungs at once when the price gaps through them", () => {
    // Straight to +60%: two rungs are owed, and stranding one below the price
    // would leave value nobody collects.
    const trigger = evaluate("3200.00");
    expect(trigger.kind).toBe("fire");
    if (trigger.kind !== "fire") return;
    expect(trigger.sellFractionBps).toBe(6666);
  });

  it("closes out on the final rung rather than leaving a remainder", () => {
    const trigger = evaluate("4000.00", { soldBps: 6666, soldQuantity: fp.parse("0.1998") });
    expect(trigger.kind).toBe("fire");
    if (trigger.kind !== "fire") return;
    expect(trigger.because).toContain("closing out");
  });

  it("sells the whole remainder when a tranche would strand an unsellable scrap", () => {
    // A residue below the exchange minimum can never be sold on its own, so
    // leaving it behind is worse than not scaling out at all.
    const trigger = evaluateMandate({
      mandate: mandate({
        quantity: fp.parse("0.0040"),
        ladder: [{ atBps: 2500, fractionBps: 9000 }],
        trailing: null,
        breakevenAtBps: null,
      }),
      bidPrice: fp.parse("2500.00"),
      heldQuantity: fp.parse("0.0040"),
      minQuantity: fp.parse("0.0001"),
      // 10% of 0.004 is 0.0004, worth 1.00 at 2500 — under the 5.00 minimum.
      minNotional: fp.parse("5.00"),
      now: at(60),
    });

    expect(trigger.kind).toBe("fire");
    if (trigger.kind !== "fire") return;
    expect(fp.format(trigger.sellQuantity)).toBe("0.0040");
  });
});

describe("ratcheting the stop", () => {
  it("keeps the stop at entry-minus-15 before anything has been earned", () => {
    expect(effectiveStopBps(mandate())).toBe(-1500);
  });

  it("moves the stop to breakeven once the trade is up enough", () => {
    // Up 20% at some point: from here the trade must not be allowed to lose.
    expect(effectiveStopBps(mandate({ highWaterBps: 2000 }))).toBe(0);
  });

  it("trails the stop up behind the peak once trailing activates", () => {
    // Peak +40%, trailing 10% behind it.
    expect(effectiveStopBps(mandate({ highWaterBps: 4000 }))).toBe(3000);
  });

  it("takes the tightest floor when several apply", () => {
    // Breakeven says 0, trailing says +30. The tighter one protects sooner.
    expect(effectiveStopBps(mandate({ highWaterBps: 4000 }))).toBe(3000);
  });

  it("has no floor at all when nothing protects the position", () => {
    expect(
      effectiveStopBps(mandate({ stopLossBps: null, trailing: null, breakevenAtBps: null })),
    ).toBeNull();
  });

  it("ratchets on the way up and never on the way down", () => {
    const up = evaluate("2800.00", { highWaterBps: 0, ladder: [] });
    expect(up.kind).toBe("idle");
    if (up.kind !== "idle") return;
    expect(up.highWaterBps).toBe(4000);

    // Price pulls back to +35%, still above the trailing stop at +30%. The
    // position survives, and the recorded peak must not follow the price down.
    const down = evaluate("2700.00", { highWaterBps: 4000, ladder: [] });
    expect(down.kind).toBe("idle");
    if (down.kind !== "idle") return;
    expect(down.highWaterBps).toBe(4000);
  });

  it("fires the trailing stop on the way back down from a peak", () => {
    // Peaked at +40%, trailing stop sits at +30%. Price back to +29%.
    const trigger = evaluate("2580.00", { highWaterBps: 4000, ladder: [] });
    expect(trigger.kind).toBe("fire");
    if (trigger.kind !== "fire") return;
    expect(trigger.reason).toBe("trailing_stop");
    expect(trigger.because).toContain("Locking in the move");
    // A stop takes the whole remaining position, not a tranche.
    expect(trigger.sellFractionBps).toBe(10_000);
  });

  it("closes flat rather than giving back a gain, once breakeven is armed", () => {
    // Was up 20%, now back to entry exactly.
    const trigger = evaluate("2000.00", { highWaterBps: 2000, trailing: null, ladder: [] });
    expect(trigger.kind).toBe("fire");
    if (trigger.kind !== "fire") return;
    expect(trigger.reason).toBe("breakeven_stop");
    expect(trigger.because).toContain("rather than giving it back");
  });
});

describe("the protective side wins", () => {
  it("sells into a gap as a stop, never as profit-taking", () => {
    // One tick from +60% to -20%: both a rung and the stop are satisfied.
    const trigger = evaluate("1600.00", { highWaterBps: 6000 });
    expect(trigger.kind).toBe("fire");
    if (trigger.kind !== "fire") return;
    expect(trigger.reason).not.toBe("take_profit");
    expect(trigger.sellFractionBps).toBe(10_000);
  });

  it("flags an abrupt protective exit as worth understanding first", () => {
    // Down 5% between two checks is news, not drift.
    const trigger = evaluate("1700.00", { trailing: null, breakevenAtBps: null }, { sinceLast: -500 });
    expect(trigger.kind).toBe("fire");
    if (trigger.kind !== "fire") return;
    expect(trigger.worthChecking).toBe(true);
  });

  it("does not flag a target being hit, which needs no explanation", () => {
    const trigger = evaluate("2500.00", {}, { sinceLast: 900 });
    expect(trigger.kind).toBe("fire");
    if (trigger.kind !== "fire") return;
    expect(trigger.worthChecking).toBe(false);
  });

  it("does not flag a slow drift into the stop", () => {
    const trigger = evaluate("1700.00", { trailing: null, breakevenAtBps: null }, { sinceLast: -20 });
    expect(trigger.kind).toBe("fire");
    if (trigger.kind !== "fire") return;
    expect(trigger.worthChecking).toBe(false);
  });
});

describe("when a mandate must not fire", () => {
  it("does nothing once it is no longer active", () => {
    for (const status of ["completed", "cancelled", "expired", "unfulfillable"] as const) {
      expect(evaluate("3000.00", { status }).kind).toBe("idle");
    }
  });

  it("expires rather than acting on a stale rule", () => {
    const trigger = evaluateMandate({
      mandate: mandate(),
      bidPrice: fp.parse("3000.00"),
      heldQuantity: fp.parse("0.3000"),
      minQuantity: fp.parse("0.0001"),
      minNotional: fp.parse("5.00"),
      now: at(90_000),
    });
    expect(trigger.kind).toBe("expired");
  });

  it("refuses to sell a position that is gone", () => {
    const trigger = evaluate("3000.00", {}, { held: "0" });
    expect(trigger.kind).toBe("unfulfillable");
    expect(trigger.because).toContain("holds no");
  });

  it("stops doing anything once fully exited", () => {
    const trigger = evaluate("4000.00", { soldBps: 10_000, soldQuantity: fp.parse("0.3000") });
    expect(trigger.kind).toBe("idle");
    if (trigger.kind !== "idle") return;
    expect(trigger.because).toContain("fully exited");
  });

  it("never sells more than the account actually holds", () => {
    // Mandate covers 0.3 but only 0.05 is left after a manual sale elsewhere.
    const trigger = evaluate("3200.00", {}, { held: "0.0500" });
    expect(trigger.kind).toBe("fire");
    if (trigger.kind !== "fire") return;
    expect(fp.lessThan(trigger.sellQuantity, fp.parse("0.0501"))).toBe(true);
  });
});

describe("rejecting a plan that cannot mean what it says", () => {
  const base = {
    quantity: fp.parse("0.30"),
    entryPrice: fp.parse("2000.00"),
    maxBps: 100_000,
  };

  it("accepts a sane plan", () => {
    expect(
      validateMandate({
        ...base,
        ladder: [{ atBps: 5000, fractionBps: 10_000 }],
        stopLossBps: 1500,
        trailing: null,
        breakevenAtBps: null,
      }),
    ).toHaveLength(0);
  });

  it("refuses a plan with no exit at all", () => {
    const problems = validateMandate({
      ...base,
      ladder: [],
      stopLossBps: null,
      trailing: null,
      breakevenAtBps: null,
    });
    expect(problems.join(" ")).toContain("needs at least one exit");
  });

  it("refuses tranches that add up to more than the position", () => {
    const problems = validateMandate({
      ...base,
      ladder: [
        { atBps: 2500, fractionBps: 6000 },
        { atBps: 5000, fractionBps: 6000 },
      ],
      stopLossBps: null,
      trailing: null,
      breakevenAtBps: null,
    });
    expect(problems.join(" ")).toContain("more than there is");
  });

  it("refuses a stop that can never trigger", () => {
    const problems = validateMandate({
      ...base,
      ladder: [],
      stopLossBps: 10_000,
      trailing: null,
      breakevenAtBps: null,
    });
    expect(problems.join(" ")).toContain("can never trigger");
  });

  it("reports every problem at once", () => {
    const problems = validateMandate({
      quantity: fp.parse("0"),
      entryPrice: fp.parse("0"),
      maxBps: 10_000,
      ladder: [],
      stopLossBps: null,
      trailing: null,
      breakevenAtBps: null,
    });
    expect(problems.length).toBeGreaterThanOrEqual(3);
  });
});

describe("showing the user where it will fire", () => {
  it("computes the prices the legs advertise", () => {
    expect(fp.format(priceAtBps(fp.parse("2000.00"), 5000))).toBe("3000.00");
    expect(fp.format(priceAtBps(fp.parse("2000.00"), -1500))).toBe("1700.00");
  });

  it("agrees with the evaluator at the boundary it advertises", () => {
    // The number shown to the user must be the number that actually fires.
    const target = priceAtBps(fp.parse("2000.00"), 2500);
    expect(evaluate(fp.format(target)).kind).toBe("fire");
  });
});
