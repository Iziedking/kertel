import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import * as fp from "../src/money/fixed-point.js";
import { renderRefusalReceipt, renderResearchReceipt } from "../src/receipts/render.js";
import type { ReceiptPayment, ResearchReceiptInput } from "../src/receipts/render.js";
import { refuse } from "../src/domain/result.js";
import { ETHUSDT, T0, observation, thesis } from "./builders.js";

const hash = (input: string): string => createHash("sha256").update(input).digest("hex");

function priceObservation(provider: "binance" | "coingecko", price: string, cost: string) {
  return observation({
    provider,
    capability: "market.price",
    endpointId: provider === "binance" ? "binance:ticker" : "coingecko:simple/price",
    status: "valid",
    normalized: { priceUsd: price },
    costUsdc: fp.parse(cost),
    rawPayloadHash: `sha256:${provider}`,
  });
}

function input(overrides: Partial<ResearchReceiptInput> = {}): ResearchReceiptInput {
  return {
    symbol: ETHUSDT,
    goal: "price_check",
    mode: "live",
    observations: [
      priceObservation("binance", "2505.65000000", "0.00"),
      priceObservation("coingecko", "2505.66", "0.01"),
    ],
    spent: fp.parse("0.01"),
    skipped: [
      {
        id: "nansen.netflow",
        reason: "not needed: you asked what the price is doing, not whether to trade",
        savedCost: fp.parse("0.05"),
      },
      { id: "thegraph.pool", reason: "no published subgraph covers ETHUSDT", savedCost: fp.parse("0.01") },
    ],
    payments: [
      {
        provider: "coingecko",
        chargedUsdc: fp.parse("0.01"),
        rail: "base-usdc",
        facilitator: "Base x402",
        settlementTx: "0xabc",
        outcome: "paid",
      },
    ],
    because: "Two independent sources agree within 0 bps.",
    limitedByBudget: false,
    thesis: null,
    now: T0,
    ...overrides,
  };
}

describe("the research receipt", () => {
  it("shows what was read, at what price, for what", () => {
    const { body } = renderResearchReceipt(input(), hash);
    expect(body).toContain("Binance: 2505.65000000 (free)");
    expect(body).toContain("CoinGecko: 2505.66 ($0.01)");
    expect(body).toContain("Cost: $0.01");
  });

  it("shows the road not taken, which is what makes a cheap run legible", () => {
    const { body } = renderResearchReceipt(input(), hash);
    expect(body).toContain("Not read:");
    expect(body).toContain("Nansen Smart Money");
    expect(body).toContain("saved $0.05");
    expect(body).toContain("Not spent: $0.06");
  });

  it("names the rail that moved the money", () => {
    const { body } = renderResearchReceipt(input(), hash);
    expect(body).toContain("CoinGecko $0.01 via Base x402");
  });

  it("marks fixture mode so a demo cannot be mistaken for the real thing", () => {
    const { body } = renderResearchReceipt(input({ mode: "fixture" }), hash);
    expect(body).toContain("FIXTURE MODE");
  });

  it("reports a source that did not answer, rather than leaving it out", () => {
    const { body } = renderResearchReceipt(
      input({
        observations: [
          priceObservation("binance", "2505.65000000", "0.00"),
          observation({
            provider: "coingecko",
            status: "unavailable",
            normalized: {
              refusalCode: "PROVIDER_UNAVAILABLE",
              refusalDetail: "coingecko could not be reached.",
            },
            costUsdc: fp.parse("0.00"),
          }),
        ],
      }),
      hash,
    );
    expect(body).toContain("CoinGecko: unavailable - coingecko could not be reached.");
  });

  it("says when a payment went out without a confirmation", () => {
    const unknown: ReceiptPayment = {
      provider: "nansen",
      chargedUsdc: fp.parse("0.05"),
      rail: "bsc-u",
      facilitator: "Binance B402",
      settlementTx: null,
      outcome: "unknown",
    };
    const { body } = renderResearchReceipt(input({ payments: [unknown] }), hash);
    expect(body).toContain("payment sent, no confirmation");
  });

  it("says when the budget, not the evidence, ended the run", () => {
    const { body } = renderResearchReceipt(input({ limitedByBudget: true }), hash);
    expect(body).toContain("rests on price alone");
  });

  it("carries the thesis and what would falsify it", () => {
    const { body } = renderResearchReceipt(
      input({
        goal: "trade_thesis",
        thesis: thesis({
          summary: "Two sources agree and tracked wallets are net buyers.",
          invalidatedBy: ["Smart Money net flow turns negative over 24h"],
        }),
      }),
      hash,
    );
    expect(body).toContain("This would be wrong if:");
    expect(body).toContain("Smart Money net flow turns negative over 24h");
  });

  it("digests the evidence, not the wording", () => {
    // Held constant on purpose: the builder mints a fresh evidence id per call,
    // so re-building the observations would change the digest for a real
    // reason and prove nothing about the wording.
    const evidence = [
      priceObservation("binance", "2505.65000000", "0.00"),
      priceObservation("coingecko", "2505.66", "0.01"),
    ];

    const first = renderResearchReceipt(input({ observations: evidence }), hash);
    const reworded = renderResearchReceipt(
      input({ observations: evidence, because: "Totally different wording." }),
      hash,
    );
    expect(reworded.provenanceDigest).toBe(first.provenanceDigest);

    // Same ids, a different payload hash underneath them. The trail must move.
    const tampered = evidence.map((entry) => ({ ...entry, rawPayloadHash: "sha256:swapped" }));
    const swapped = renderResearchReceipt(input({ observations: tampered }), hash);
    expect(swapped.provenanceDigest).not.toBe(first.provenanceDigest);
  });

  it("never renders an absence as a zero", () => {
    const { body } = renderResearchReceipt(input({ observations: [], spent: fp.parse("0.00") }), hash);
    expect(body).toContain("Sources read:\n  none");
    expect(body).not.toContain("0.00000000");
  });
});

describe("the refusal receipt", () => {
  it("says what happened, what it cost, and gives a code to quote", () => {
    const body = renderRefusalReceipt({
      refusal: refuse(
        "EVIDENCE_CONFLICT_UNRESOLVED",
        "The price sources disagree by 300 bps and Kertel could not settle it.",
      ).error,
      symbol: ETHUSDT,
      mode: "live",
      spent: fp.parse("0.02"),
      skipped: [
        {
          id: "nansen.netflow",
          reason: "not bought: the price sources disagreed, so flows could not have settled it",
          savedCost: fp.parse("0.05"),
        },
      ],
      now: T0,
    });

    expect(body).toContain("Refused: ETHUSDT");
    expect(body).toContain("disagree by 300 bps");
    expect(body).toContain("Spent: $0.02");
    expect(body).toContain("Code: EVIDENCE_CONFLICT_UNRESOLVED");
    expect(body).toContain("Nansen Smart Money");
  });

  it("shows a zero spend, because refusing without spending is the product working", () => {
    const body = renderRefusalReceipt({
      refusal: refuse("PROVIDER_UNAVAILABLE", "Kertel could not read a current price.").error,
      symbol: ETHUSDT,
      mode: "live",
      spent: fp.parse("0.00"),
      skipped: [],
      now: T0,
    });
    expect(body).toContain("Spent: $0.00");
  });
});
