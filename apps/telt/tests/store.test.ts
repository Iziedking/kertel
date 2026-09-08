import { describe, expect, it } from "vitest";

import * as fp from "@telt/core/money";
import { instant } from "@telt/core/domain";

import { openStore } from "../src/infra/store.js";

const DAY_ONE = instant(Date.parse("2026-09-07T12:00:00.000Z"));
const LATER_SAME_DAY = instant(Date.parse("2026-09-07T23:59:59.000Z"));
const NEXT_DAY = instant(Date.parse("2026-09-08T00:00:01.000Z"));

describe("the spend ledger", () => {
  it("starts a day at zero", () => {
    const store = openStore(":memory:");
    expect(fp.format(store.spentOn(DAY_ONE))).toBe("0.000000");
    store.close();
  });

  it("accumulates within a UTC day and resets across the boundary", () => {
    const store = openStore(":memory:");
    store.recordSpend(DAY_ONE, fp.parse("0.01"));
    store.recordSpend(LATER_SAME_DAY, fp.parse("0.05"));

    expect(fp.equals(store.spentOn(DAY_ONE), fp.parse("0.06"))).toBe(true);
    // A cap is per UTC day, so the next day starts clean.
    expect(fp.isZero(store.spentOn(NEXT_DAY))).toBe(true);
    store.close();
  });

  it("adds in integers, so a hundred small spends do not drift", () => {
    // The regression this exists for: doing the running total in SQL with
    // CAST(... AS REAL) is float arithmetic, and 0.01 added a hundred times in
    // floating point is not 1.00. A daily cap built on that is not a cap.
    const store = openStore(":memory:");
    for (let index = 0; index < 100; index += 1) {
      store.recordSpend(DAY_ONE, fp.parse("0.01"));
    }
    expect(fp.equals(store.spentOn(DAY_ONE), fp.parse("1.00"))).toBe(true);
    expect(fp.format(fp.trim(store.spentOn(DAY_ONE), 2))).toBe("1.00");
    store.close();
  });

  it("handles the awkward thirds that float arithmetic cannot", () => {
    const store = openStore(":memory:");
    for (const amount of ["0.07", "0.07", "0.07", "0.05", "0.01"]) {
      store.recordSpend(DAY_ONE, fp.parse(amount));
    }
    expect(fp.equals(store.spentOn(DAY_ONE), fp.parse("0.27"))).toBe(true);
    store.close();
  });

  it("ignores a zero or negative spend rather than crediting the day", () => {
    const store = openStore(":memory:");
    store.recordSpend(DAY_ONE, fp.parse("0.05"));
    store.recordSpend(DAY_ONE, fp.parse("0.00"));
    expect(fp.equals(store.spentOn(DAY_ONE), fp.parse("0.05"))).toBe(true);
    store.close();
  });

  it("refuses an amount finer than the ledger can hold, rather than rounding it in", () => {
    const store = openStore(":memory:");
    expect(() => store.recordSpend(DAY_ONE, fp.parse("0.0000001"))).toThrow();
    store.close();
  });
});

describe("payment attempts", () => {
  const attempt = {
    attemptId: "pay-1",
    provider: "nansen",
    endpointId: "nansen:smart-money/netflow",
    chargedUsdc: "0.05",
    rail: "bsc-u",
    facilitator: "Binance B402",
    settlementTx: null,
    outcome: "unknown",
    refusalCode: "X402_PAYMENT_UNKNOWN",
    at: DAY_ONE,
  };

  it("keeps an unresolved payment findable, because it is money nobody can account for", () => {
    const store = openStore(":memory:");
    store.recordPaymentAttempt(attempt);

    const unresolved = store.unresolvedPayments();
    expect(unresolved).toHaveLength(1);
    expect(unresolved[0]?.attemptId).toBe("pay-1");
    expect(unresolved[0]?.chargedUsdc).toBe("0.05");
    store.close();
  });

  it("drops it from the unresolved list once reconciled", () => {
    const store = openStore(":memory:");
    store.recordPaymentAttempt(attempt);
    store.resolvePayment("pay-1", "0xsettled");
    expect(store.unresolvedPayments()).toHaveLength(0);
    store.close();
  });

  it("does not list a payment that simply succeeded", () => {
    const store = openStore(":memory:");
    store.recordPaymentAttempt({
      ...attempt,
      attemptId: "pay-2",
      outcome: "paid",
      refusalCode: null,
      settlementTx: "0xok",
    });
    expect(store.unresolvedPayments()).toHaveLength(0);
    store.close();
  });
});

describe("the kill switch", () => {
  it("is off on a fresh database", () => {
    const store = openStore(":memory:");
    expect(store.safetyState().killSwitchEngaged).toBe(false);
    store.close();
  });

  it("remembers that it was pulled, which is the entire point of it", () => {
    const store = openStore(":memory:");
    store.engageKillSwitch("owner asked to stop everything", DAY_ONE);

    const state = store.safetyState();
    expect(state.killSwitchEngaged).toBe(true);
    expect(state.killSwitchReason).toBe("owner asked to stop everything");
    expect(state.killSwitchEngagedAt).toBe(DAY_ONE);
    store.close();
  });

  it("releases only when asked", () => {
    const store = openStore(":memory:");
    store.engageKillSwitch("stop", DAY_ONE);
    store.releaseKillSwitch();

    const state = store.safetyState();
    expect(state.killSwitchEngaged).toBe(false);
    expect(state.killSwitchReason).toBeNull();
    store.close();
  });
});

describe("the monitor checkpoint", () => {
  it("persists the last daemon state", () => {
    const store = openStore(":memory:");
    store.setMonitorCheckpoint?.({ running: true, at: DAY_ONE, result: "checked:1 fired:0", halted: null });
    expect(store.monitorCheckpoint?.()).toEqual({ running: true, at: DAY_ONE, result: "checked:1 fired:0", halted: null });
    store.close();
  });
});
