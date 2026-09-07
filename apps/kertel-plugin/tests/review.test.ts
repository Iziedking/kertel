import { describe, expect, it } from "vitest";

import { instant } from "@kertel/core/domain";
import type { Instant } from "@kertel/core/domain";

import { deriveLessons, memoryDigest, summarise } from "../src/review.js";
import type { Outcome } from "../src/review.js";
import { openStore } from "../src/infra/store.js";

const NOW = instant(Date.parse("2026-09-07T12:00:00.000Z"));

function outcome(overrides: Partial<Outcome> = {}): Outcome {
  return {
    at: NOW,
    symbol: "ETHUSDT",
    mandateId: "plan-1",
    reason: "take_profit",
    entryPrice: "2000.00",
    exitPrice: "2500.00",
    quantity: "0.1000",
    moveBps: 2500,
    peakBps: 2500,
    recoveredWithin24h: null,
    ...overrides,
  };
}

describe("counting what actually happened", () => {
  it("reports nothing rather than inventing a record", () => {
    const stats = summarise([]);
    expect(stats.closed).toBe(0);
    expect(stats.averageMoveBps).toBe(0);
  });

  it("separates winners from losers and names the extremes", () => {
    const stats = summarise([
      outcome({ moveBps: 2500 }),
      outcome({ moveBps: -1500, reason: "stop_loss" }),
      outcome({ moveBps: 8000 }),
    ]);
    expect(stats.closed).toBe(3);
    expect(stats.winners).toBe(2);
    expect(stats.losers).toBe(1);
    expect(stats.bestBps).toBe(8000);
    expect(stats.worstBps).toBe(-1500);
  });

  it("measures how much was given back from the peak", () => {
    // Ran to +80%, exited at +25%. Fifty-five points handed back.
    const stats = summarise([outcome({ moveBps: 2500, peakBps: 8000 })]);
    expect(stats.averageGiveBackBps).toBe(5500);
  });

  it("never reports a negative give-back, because an exit cannot beat the peak", () => {
    const stats = summarise([outcome({ moveBps: 2500, peakBps: 1000 })]);
    expect(stats.averageGiveBackBps).toBe(0);
  });

  it("counts the expensive mistake specifically", () => {
    // A stop that was hit on something which then recovered.
    const stats = summarise([
      outcome({ reason: "stop_loss", moveBps: -1500, recoveredWithin24h: true }),
      outcome({ reason: "stop_loss", moveBps: -1500, recoveredWithin24h: false }),
      outcome({ reason: "take_profit", moveBps: 2500, recoveredWithin24h: true }),
    ]);
    // The take-profit that kept running is not a mistake, so it is not counted.
    expect(stats.stoppedThenRecovered).toBe(1);
  });
});

describe("turning the record into something to do differently", () => {
  it("says nothing on two data points, because two is not a pattern", () => {
    const lessons = deriveLessons(
      [
        outcome({ reason: "stop_loss", moveBps: -1500, recoveredWithin24h: true }),
        outcome({ reason: "stop_loss", moveBps: -1500, recoveredWithin24h: true }),
      ],
      NOW,
    );
    expect(lessons).toHaveLength(0);
  });

  it("flags stops that keep getting hit on things that recover", () => {
    const lessons = deriveLessons(
      [
        outcome({ reason: "stop_loss", moveBps: -1500, recoveredWithin24h: true }),
        outcome({ reason: "stop_loss", moveBps: -1500, recoveredWithin24h: true }),
        outcome({ reason: "stop_loss", moveBps: -1500, recoveredWithin24h: false }),
      ],
      NOW,
    );
    expect(lessons.map((lesson) => lesson.text).join(" ")).toContain("recovered above the exit");
    expect(lessons.map((lesson) => lesson.text).join(" ")).toContain("wider");
  });

  it("flags handing back most of a move", () => {
    const lessons = deriveLessons(
      [
        outcome({ moveBps: 1000, peakBps: 6000 }),
        outcome({ moveBps: 1000, peakBps: 5000 }),
        outcome({ moveBps: 1000, peakBps: 4000 }),
      ],
      NOW,
    );
    expect(lessons.map((lesson) => lesson.text).join(" ")).toContain("gave back");
  });

  it("says plainly when nothing is working", () => {
    const lessons = deriveLessons(
      [
        outcome({ moveBps: -500, reason: "stop_loss" }),
        outcome({ moveBps: -900, reason: "stop_loss" }),
        outcome({ moveBps: -1500, reason: "stop_loss" }),
        outcome({ moveBps: -200, reason: "breakeven_stop" }),
      ],
      NOW,
    );
    const text = lessons.map((lesson) => lesson.text).join(" ");
    expect(text).toContain("lost money");
    expect(text).toContain("stop trading it");
  });

  it("keeps lessons per symbol rather than blending unrelated pairs", () => {
    const lessons = deriveLessons(
      [
        outcome({ symbol: "ETHUSDT", reason: "stop_loss", moveBps: -1500, recoveredWithin24h: true }),
        outcome({ symbol: "ETHUSDT", reason: "stop_loss", moveBps: -1500, recoveredWithin24h: true }),
        outcome({ symbol: "ETHUSDT", reason: "stop_loss", moveBps: -1500, recoveredWithin24h: true }),
        outcome({ symbol: "BTCUSDT", moveBps: 5000 }),
      ],
      NOW,
    );
    expect(lessons.every((lesson) => lesson.symbol === "ETHUSDT")).toBe(true);
  });
});

describe("the note handed to the user's own memory", () => {
  const deps = { store: openStore(":memory:"), now: () => NOW as Instant };

  it("starts with the date and names concrete figures", () => {
    const digest = memoryDigest(deps, [
      outcome({ moveBps: 2500, peakBps: 4000 }),
      outcome({ moveBps: -1500, reason: "stop_loss", peakBps: 500 }),
    ]);

    expect(digest.startsWith("2026-09-07")).toBe(true);
    expect(digest).toContain("2 closed");
    expect(digest).toContain("ETHUSDT");
    // A stranger on another machine has to be able to act on it.
    expect(digest).toContain("Per symbol:");
  });

  it("carries the lessons, since those are the part worth remembering", () => {
    const digest = memoryDigest(deps, [
      outcome({ reason: "stop_loss", moveBps: -1500, recoveredWithin24h: true }),
      outcome({ reason: "stop_loss", moveBps: -1500, recoveredWithin24h: true }),
      outcome({ reason: "stop_loss", moveBps: -1500, recoveredWithin24h: false }),
    ]);
    expect(digest).toContain("LESSONS");
    expect(digest).toContain("before writing the next exit plan");
  });

  it("says there is nothing rather than padding an empty record", () => {
    const digest = memoryDigest(deps, []);
    expect(digest).toContain("No positions have closed yet");
    expect(digest).not.toContain("LESSONS");
  });
});

describe("lessons reaching the next decision", () => {
  it("stores a recalled lesson and offers it back for its symbol", () => {
    const store = openStore(":memory:");
    store.mandates.learn({
      symbol: "ETHUSDT",
      text: "Stops tighter than 20% on ETH get hit by ordinary noise.",
      learnedAt: NOW,
      source: "recalled",
    });

    const forEth = store.mandates.lessonsFor("ETHUSDT");
    expect(forEth).toHaveLength(1);
    expect(store.mandates.lessonsFor("BTCUSDT")).toHaveLength(0);
    store.close();
  });

  it("offers account-wide lessons for every symbol", () => {
    const store = openStore(":memory:");
    store.mandates.learn({
      symbol: "*",
      text: "This account consistently sizes too large on the first entry.",
      learnedAt: NOW,
      source: "recalled",
    });

    expect(store.mandates.lessonsFor("ETHUSDT")).toHaveLength(1);
    expect(store.mandates.lessonsFor("BTCUSDT")).toHaveLength(1);
    store.close();
  });

  it("does not pile up duplicates when the same memory is recalled again", () => {
    const store = openStore(":memory:");
    const lesson = {
      symbol: "ETHUSDT",
      text: "Stops tighter than 20% on ETH get hit by ordinary noise.",
      learnedAt: NOW,
      source: "recalled" as const,
    };
    store.mandates.learn(lesson);
    store.mandates.learn(lesson);
    store.mandates.learn({ ...lesson, source: "review" });

    expect(store.mandates.lessonsFor("ETHUSDT")).toHaveLength(1);
    store.close();
  });

  it("keeps the outcomes it recorded, newest first", () => {
    const store = openStore(":memory:");
    store.mandates.recordOutcome(outcome({ at: instant(NOW - 60_000), moveBps: 1000 }));
    store.mandates.recordOutcome(outcome({ moveBps: 2500 }));

    const rows = store.mandates.outcomes(10);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.moveBps).toBe(2500);
    store.close();
  });
});
