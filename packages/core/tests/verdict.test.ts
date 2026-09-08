/**
 * What a model has to say before Telt will spend money on it unattended.
 *
 * These are the tests for the moment Telt is most likely to do something
 * stupid: no human present, a model that will always produce something that
 * sounds reasonable, and a wallet. Every case here is a way an agent talks
 * itself into a trade.
 */

import { describe, expect, it } from "vitest";

import { actionable, CONFIDENCE_FLOOR, parseVerdict, verdictInstruction } from "../src/autonomy/verdict.js";

const GOOD = {
  action: "BUY_CANDIDATE",
  confidence: 82,
  because:
    "Binance bid 2469.21 against a CoinGecko 2470.55, inside 6bps, and Smart Money netflow is +5.4M over 24h across 143 wallets.",
  risks: ["Netflow is a 24h figure and can reverse", "Sentiment was unreadable, so this rests on flow alone"],
};

describe("reading a model's answer", () => {
  it("accepts a well-formed verdict", () => {
    const { verdict, problems } = parseVerdict(GOOD);
    expect(problems).toEqual([]);
    expect(verdict?.action).toBe("BUY_CANDIDATE");
    expect(verdict?.risks).toHaveLength(2);
  });

  it("rejects prose, however convincing", () => {
    // The failure this whole module exists to prevent: an answer that has to be
    // interpreted, because interpreting is where the talking-into happens.
    const { verdict, problems } = parseVerdict(
      "I think this looks like a strong buy given the momentum and the flows.",
    );
    expect(verdict).toBeNull();
    expect(problems[0]).toContain("did not answer with an object");
  });

  it("rejects a buy with no stated risks", () => {
    // Everything worth buying has something wrong with it. An empty risks array
    // is the signature of a model that has not looked.
    const { verdict, problems } = parseVerdict({ ...GOOD, risks: [] });
    expect(verdict).toBeNull();
    expect(problems.join(" ")).toContain("has not looked");
  });

  it("rejects a reason too short to have come from the evidence", () => {
    const { verdict, problems } = parseVerdict({ ...GOOD, because: "Looks good." });
    expect(verdict).toBeNull();
    expect(problems.join(" ")).toContain("without reading the research");
  });

  it("rejects an invented action", () => {
    const { verdict } = parseVerdict({ ...GOOD, action: "STRONG_BUY" });
    expect(verdict).toBeNull();
  });

  it("rejects confidence that is not a number in range", () => {
    expect(parseVerdict({ ...GOOD, confidence: "very high" }).verdict).toBeNull();
    expect(parseVerdict({ ...GOOD, confidence: 140 }).verdict).toBeNull();
  });

  it("allows a no-trade with no risks, because there is no trade to have risks", () => {
    const { verdict } = parseVerdict({
      action: "NO_TRADE",
      confidence: 90,
      because: "Both prices agree but netflow is negative and the safety check reported a mint authority.",
      risks: [],
    });
    expect(verdict?.action).toBe("NO_TRADE");
  });
});

describe("whether it may move money", () => {
  it("acts on a confident buy with stated risks", () => {
    const { verdict } = parseVerdict(GOOD);
    expect(actionable(verdict!).act).toBe(true);
  });

  it("does not act below the confidence floor", () => {
    const { verdict } = parseVerdict({ ...GOOD, confidence: CONFIDENCE_FLOOR - 1 });
    const decision = actionable(verdict!);
    expect(decision.act).toBe(false);
    // Still worth surfacing. Not acting is not the same as not noticing.
    expect(decision.because).toContain("Worth telling you about");
  });

  it("does not act on insufficient evidence", () => {
    const { verdict } = parseVerdict({
      action: "INSUFFICIENT_EVIDENCE",
      confidence: 95,
      because: "CoinGecko refused and the venue price alone cannot corroborate anything here.",
      risks: [],
    });
    // High confidence in not knowing is still not knowing.
    expect(actionable(verdict!).act).toBe(false);
  });
});

describe("the instruction the model is given", () => {
  it("makes declining easy rather than inviting a yes", () => {
    // A prompt that asks "is this a good trade" gets a yes. This one has to put
    // the burden on the evidence, or the agent finds a reason every time.
    const instruction = verdictInstruction();
    expect(instruction).toContain("NO_TRADE is a good answer");
    expect(instruction).toContain("not being graded on");
    expect(instruction).toContain("Do not fill the");
  });
});
