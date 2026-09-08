/**
 * The safety verdict, read from a payload that was actually bought.
 *
 * The fixture below is verbatim from a real paid call on 2026-09-08 — one cent,
 * settled on Base as `0x485e5f70da64a77e58d55a7b2b853d51495e59279644953425d35b009ef34609`.
 * That matters because the first version of this adapter was written against a
 * guessed shape and got the important names wrong: the verdict is `grade`, not
 * `verdict`; mint authority is `has_mint`, not `mintable`.
 *
 * The case that matters most here is `is_honeypot: null`. This provider answers
 * null when its simulation could not run, and a null quietly read as `false` is
 * the difference between "we checked and it is safe" and "we could not check" —
 * on the one question where being wrong costs the whole position.
 */

import { describe, expect, it } from "vitest";

import { openpulseSafetyAdapter } from "../src/openpulse.js";
import { instrumentFor } from "../src/symbols.js";
import type { AdapterContext } from "../src/types.js";
import type { Symbol_ } from "@telt/core/domain";

/** WETH on Base, as returned. The address the adapter asked about. */
const WETH = "0x4200000000000000000000000000000000000006";

/** Verbatim from the paid response, trimmed to the fields the adapter reads. */
const PAID_RESPONSE = {
  data: {
    token_address: WETH,
    score: 10,
    grade: "F",
    risks: [
      "Honeypot check inconclusive",
      "Not a smart contract",
      "No liquidity pool found",
      "Very few holders: 0",
      "Token created less than 24h ago",
      "Very low activity: 0 transactions",
    ],
    honeypot_score: 10,
    is_honeypot: null,
    buy_tax_pct: null,
    sell_tax_pct: null,
    is_verified: false,
    is_proxy: false,
    ownership_renounced: null,
    has_mint: false,
    has_blacklist: false,
    has_lp: false,
    total_liquidity_usd: 0,
    pair_count: 0,
    holder_count: 0,
    top10_pct: 0,
    top1_pct: 0,
    age_days: 0,
  },
};

function contextFor(symbol: string): AdapterContext {
  const instrument = instrumentFor(symbol as Symbol_);
  if (instrument === undefined) throw new Error(`no instrument for ${symbol}`);
  return { instrument } as AdapterContext;
}

/** ETHUSDT's mapped contract, which is what the adapter will ask about. */
const ETH_CONTEXT = contextFor("ETHUSDT");
const ETH_ADDRESS = ETH_CONTEXT.instrument.nansenTokenAddresses[0]!;

describe("asking for a safety verdict", () => {
  it("asks by contract address, never by ticker", () => {
    // A safety verdict is a statement about one specific contract. Asking by
    // ticker would invite an answer about a different token of the same name.
    const request = openpulseSafetyAdapter.buildRequest(ETH_CONTEXT);
    expect(request.ok).toBe(true);
    if (request.ok) {
      expect(request.value.url).toContain(ETH_ADDRESS);
      expect(request.value.url).toContain("/safety");
    }
  });

  it("refuses rather than guessing a contract it cannot name", () => {
    const unmapped = {
      instrument: {
        ...ETH_CONTEXT.instrument,
        symbol: "MYSTERYUSDT" as Symbol_,
        nansenTokenAddresses: [],
      },
    } as AdapterContext;

    const request = openpulseSafetyAdapter.buildRequest(unmapped);
    expect(request.ok).toBe(false);
    if (!request.ok) {
      expect(request.error.detail).toContain("will not ask");
    }
  });
});

describe("reading the verdict that came back", () => {
  const answered = {
    data: { ...PAID_RESPONSE.data, token_address: ETH_ADDRESS },
  };

  it("reads the grade and the score the provider actually sends", () => {
    const result = openpulseSafetyAdapter.normalize(answered, ETH_CONTEXT);
    expect(result).not.toBeNull();
    expect(result?.["grade"]).toBe("F");
    expect(result?.["safetyScore"]).toBe(10);
  });

  it("carries the provider's own findings rather than reducing them to a number", () => {
    // Six plain sentences are more use to a reasoning layer than the number 10,
    // which nobody can interrogate.
    const result = openpulseSafetyAdapter.normalize(answered, ETH_CONTEXT);
    expect(result?.["risks"]).toContain("No liquidity pool found");
  });

  it("does not turn 'could not check' into 'safe'", () => {
    // The one that matters. is_honeypot is null here because the simulation
    // failed. Reporting false would be Telt asserting a check nobody ran.
    const result = openpulseSafetyAdapter.normalize(answered, ETH_CONTEXT);
    expect(result).not.toBeNull();
    expect(Object.keys(result!)).not.toContain("isHoneypot");
    expect(Object.keys(result!)).not.toContain("ownershipRenounced");
    // Real booleans do come through.
    expect(result?.["hasMint"]).toBe(false);
    expect(result?.["hasBlacklist"]).toBe(false);
  });

  it("carries the figures that decide whether it is tradeable at all", () => {
    const result = openpulseSafetyAdapter.normalize(answered, ETH_CONTEXT);
    expect(result?.["liquidityUsd"]).toBe(0);
    expect(result?.["holderCount"]).toBe(0);
    expect(result?.["ageDays"]).toBe(0);
  });

  it("rejects a verdict about a different contract", () => {
    // The worst mistake available to this module: reading a safety answer for
    // one token as though it described another.
    const wrongToken = { data: { ...PAID_RESPONSE.data, token_address: WETH } };
    expect(openpulseSafetyAdapter.normalize(wrongToken, ETH_CONTEXT)).toBeNull();
  });

  it("returns null on a shape it does not recognise", () => {
    expect(openpulseSafetyAdapter.normalize({ data: { unrelated: true } }, ETH_CONTEXT)).toBeNull();
    expect(openpulseSafetyAdapter.normalize("not json", ETH_CONTEXT)).toBeNull();
    expect(openpulseSafetyAdapter.normalize(null, ETH_CONTEXT)).toBeNull();
  });
});
