import { describe, expect, it } from "vitest";

import { instant } from "@telt/core/domain";

import { checkProtection, memoryLane } from "../src/protection.js";
import { openStore } from "../src/infra/store.js";

const NOW = instant(Date.parse("2026-09-08T12:00:00.000Z"));

describe("Protection Watch", () => {
  it("checks the account without spending when investigation was not requested", async () => {
    const store = openStore(":memory:");
    let researchCalls = 0;

    const result = await checkProtection(
      {
        store,
        now: () => NOW,
        status: async () => ({
          ok: true,
          refusalCode: null,
          body: "SOLUSDT is FULLY HEDGED.",
        }),
        research: async () => {
          researchCalls += 1;
          return { ok: true, body: "unused", spent: "0.06", refusalCode: null };
        },
      },
      { symbol: "solusdt", investigate: false },
    );

    expect(result.ok).toBe(true);
    expect(result.body).toContain("Paid research: not used");
    expect(researchCalls).toBe(0);
    expect(store.mandates.recentJournal(10)[0]?.kind).toBe("hedge_checked");
    store.close();
  });

  it("buys one investigation only when requested and records its evidence", async () => {
    const store = openStore(":memory:");
    let researchCalls = 0;

    const result = await checkProtection(
      {
        store,
        now: () => NOW,
        status: async () => ({
          ok: true,
          refusalCode: null,
          body: "SOLUSDT protection: PARTIALLY HEDGED.",
        }),
        research: async (symbol) => {
          researchCalls += 1;
          expect(symbol).toBe("SOLUSDT");
          return {
            ok: true,
            body: "Smart Money flows weakened.",
            spent: "0.06",
            refusalCode: null,
          };
        },
      },
      { symbol: "SOLUSDT", investigate: true },
    );

    expect(result.ok).toBe(true);
    expect(result.body).toContain("Paid investigation");
    expect(result.body).toContain("did not open, resize, or close the hedge");
    expect(researchCalls).toBe(1);
    const entries = store.mandates.recentJournal(10);
    expect(entries.map((entry) => entry.kind)).toEqual([
      "hedge_researched",
      "hedge_checked",
    ]);
    expect(entries[0]?.evidence).toBe("Smart Money flows weakened.");
    store.close();
  });

  it("keeps the protection result usable when paid coverage is unavailable", async () => {
    const store = openStore(":memory:");
    const result = await checkProtection(
      {
        store,
        now: () => NOW,
        status: async () => ({
          ok: true,
          refusalCode: null,
          body: "KAITOUSDT protection: FULLY HEDGED.",
        }),
        research: async () => ({
          ok: false,
          body: "No verified provider mapping exists for KAITOUSDT.",
          spent: "0.00",
          refusalCode: "INSTRUMENT_UNMAPPED",
        }),
      },
      { symbol: "KAITOUSDT", investigate: true },
    );

    expect(result.ok).toBe(true);
    expect(result.body).toContain("KAITOUSDT protection: FULLY HEDGED");
    expect(result.body).toContain("No verified provider mapping");
    expect(store.mandates.recentJournal(10)[0]?.headline).toContain(
      "coverage for KAITOUSDT was limited",
    );
    store.close();
  });

  it("does not spend research points when there is no paired hedge", async () => {
    const store = openStore(":memory:");
    let researchCalls = 0;
    const result = await checkProtection(
      {
        store,
        now: () => NOW,
        status: async () => ({
          ok: true,
          refusalCode: null,
          body: "SOLUSDT protection: UNHEDGED.",
        }),
        research: async () => {
          researchCalls += 1;
          return { ok: true, body: "unused", spent: "0.06", refusalCode: null };
        },
      },
      { symbol: "SOLUSDT", investigate: true },
    );

    expect(result.ok).toBe(true);
    expect(result.body).toContain("does not currently have a paired Spot hedge");
    expect(researchCalls).toBe(0);
    store.close();
  });
});

describe("Protection Memory Lane", () => {
  it("renders one symbol's protection lifecycle from oldest to newest", () => {
    const store = openStore(":memory:");
    store.mandates.journal({
      at: NOW,
      kind: "hedge_proposed",
      symbol: "SOLUSDT",
      mandateId: null,
      headline: "Protection proposed for SOLUSDT",
      detail: "No order was placed.",
      evidence: null,
    });
    store.mandates.journal({
      at: instant(NOW + 1_000),
      kind: "hedge_opened",
      symbol: "SOLUSDT",
      mandateId: null,
      headline: "Protection opened for SOLUSDT",
      detail: "The short was filled.",
      evidence: null,
    });
    store.mandates.journal({
      at: instant(NOW + 2_000),
      kind: "hedge_checked",
      symbol: "BTCUSDT",
      mandateId: null,
      headline: "Checked BTCUSDT protection",
      detail: "Unrelated event.",
      evidence: null,
    });

    const lane = memoryLane(store, { symbol: "SOLUSDT", limit: 20 });
    expect(lane).toContain("SOLUSDT Memory Lane");
    expect(lane).not.toContain("BTCUSDT");
    expect(lane.indexOf("Protection proposed")).toBeLessThan(
      lane.indexOf("Protection opened"),
    );
    store.close();
  });

  it("persists and removes the record used to rediscover a hedge", () => {
    const store = openStore(":memory:");
    store.mandates.adopt({
      symbol: "SOLUSDT",
      entryPrice: "100",
      quantity: "0.1",
      source: "telt-hedge",
      at: NOW,
    });

    expect(store.mandates.allAdopted()).toEqual([
      {
        symbol: "SOLUSDT",
        entryPrice: "100",
        quantity: "0.1",
        source: "telt-hedge",
      },
    ]);
    store.mandates.forgetAdopted("SOLUSDT");
    expect(store.mandates.allAdopted()).toEqual([]);
    store.close();
  });
});
