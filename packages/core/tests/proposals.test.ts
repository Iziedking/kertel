import { describe, expect, it } from "vitest";

import * as fp from "../src/money/fixed-point.js";
import type { Refusal, Result } from "../src/domain/result.js";
import {
  canonicalProposalPayload,
  evidenceDigest,
  hashProposal,
  idempotencyKeyFor,
} from "../src/proposals/hash.js";
import { DEFAULT_FEE_BPS, sizeFromNotional, sizeFromQuantity, slippageBound } from "../src/proposals/size.js";
import { at, filters, observation, proposal, T0 } from "./builders.js";

/**
 * A readable stand-in for sha-256. The canonical string is the thing under
 * test; using a real digest here would only hide which bytes changed.
 */
const fakeHash = (input: string): string => `hash(${input.replace(/\n/g, "|")})`;

function expectOk<T>(result: Result<T, Refusal>): T {
  if (!result.ok) {
    throw new Error(`expected success, got ${result.error.code}: ${result.error.detail}`);
  }
  return result.value;
}

function expectRefusal<T>(result: Result<T, Refusal>): Refusal {
  if (result.ok) {
    throw new Error("expected a refusal");
  }
  return result.error;
}

describe("sizing a buy from a budget", () => {
  it("floors to the step size and recomputes the notional from what survived", () => {
    // 20 USDT at 2431.17 is 0.00822644... ETH. The 0.0001 step takes it to
    // 0.0082, which is really 19.9356 USDT, reported as 19.94 at tick scale.
    const sized = expectOk(
      sizeFromNotional({ notional: fp.parse("20.00"), price: fp.parse("2431.17"), filters: filters() }),
    );
    expect(fp.format(sized.quantity)).toBe("0.0082");
    expect(fp.format(sized.estimatedNotional)).toBe("19.94");
    expect(fp.format(sized.requestedNotional)).toBe("20.00");
  });

  it("never sizes above the budget the user gave", () => {
    // Property that matters more than any single example: the order actually
    // sent can under-spend, never over-spend.
    const price = fp.parse("2431.17");
    for (const budget of ["5.00", "12.34", "19.99", "20.00", "24.99", "25.00"]) {
      const sized = expectOk(
        sizeFromNotional({ notional: fp.parse(budget), price, filters: filters() }),
      );
      const trueCost = fp.multiply(sized.quantity, price);
      expect(
        fp.compare(trueCost, fp.parse(budget)),
        `${budget} produced ${fp.format(trueCost)}`,
      ).toBeLessThanOrEqual(0);
    }
  });

  it("estimates the fee upward so a marginal order is refused, not failed", () => {
    const sized = expectOk(
      sizeFromNotional({ notional: fp.parse("20.00"), price: fp.parse("2431.17"), filters: filters() }),
    );
    // 15 bps of 19.94 is 0.02991, rounded up to 0.03.
    expect(fp.format(sized.estimatedFee)).toBe("0.03");
    expect(DEFAULT_FEE_BPS).toBeGreaterThan(10);
  });

  it("refuses a budget too small to buy one step", () => {
    const refusal = expectRefusal(
      sizeFromNotional({ notional: fp.parse("0.10"), price: fp.parse("2431.17"), filters: filters() }),
    );
    expect(refusal.code).toBe("NOTIONAL_BELOW_EXCHANGE_MINIMUM");
  });

  it("refuses a zero or negative budget", () => {
    expect(
      expectRefusal(
        sizeFromNotional({ notional: fp.parse("0"), price: fp.parse("2431.17"), filters: filters() }),
      ).code,
    ).toBe("AMOUNT_NOT_UNDERSTOOD");
    expect(
      expectRefusal(
        sizeFromNotional({ notional: fp.parse("-5"), price: fp.parse("2431.17"), filters: filters() }),
      ).code,
    ).toBe("AMOUNT_NOT_UNDERSTOOD");
  });

  it("refuses to size from a zero price instead of dividing by it", () => {
    expect(
      expectRefusal(
        sizeFromNotional({ notional: fp.parse("20.00"), price: fp.parse("0"), filters: filters() }),
      ).code,
    ).toBe("MARKET_DATA_STALE");
  });
});

describe("sizing a sell from a holding", () => {
  it("floors to the step so the order cannot exceed the holding", () => {
    const sized = expectOk(
      sizeFromQuantity({
        quantity: fp.parse("0.12345"),
        price: fp.parse("2431.17"),
        filters: filters(),
      }),
    );
    expect(fp.format(sized.quantity)).toBe("0.12340");
    expect(fp.compare(sized.quantity, fp.parse("0.12345"))).toBe(-1);
  });

  it("floors the proceeds rather than flattering them", () => {
    const sized = expectOk(
      sizeFromQuantity({ quantity: fp.parse("0.0082"), price: fp.parse("2431.17"), filters: filters() }),
    );
    // 0.0082 * 2431.17 = 19.9355940, floored to 19.93 at tick scale. The buy
    // path rounds the same number up to 19.94, because a cost understated and a
    // proceed overstated are both errors in the user's disfavour.
    expect(fp.format(sized.estimatedNotional)).toBe("19.93");
  });

  it("refuses a holding smaller than one step", () => {
    expect(
      expectRefusal(
        sizeFromQuantity({
          quantity: fp.parse("0.00001"),
          price: fp.parse("2431.17"),
          filters: filters(),
        }),
      ).code,
    ).toBe("NOTIONAL_BELOW_EXCHANGE_MINIMUM");
  });
});

describe("slippage bound", () => {
  it("lets a buy fill higher and a sell fill lower", () => {
    const reference = fp.parse("2431.17");
    expect(fp.format(slippageBound({ referencePrice: reference, side: "BUY", maxSlippageBps: 50 }))).toBe(
      "2443.33",
    );
    expect(fp.format(slippageBound({ referencePrice: reference, side: "SELL", maxSlippageBps: 50 }))).toBe(
      "2419.02",
    );
  });

  it("collapses to the reference price at zero basis points", () => {
    const reference = fp.parse("2431.17");
    expect(fp.format(slippageBound({ referencePrice: reference, side: "BUY", maxSlippageBps: 0 }))).toBe(
      "2431.17",
    );
  });
});

describe("proposal hashing", () => {
  it("covers every field the user is shown", () => {
    const payload = canonicalProposalPayload(proposal());
    for (const field of [
      "symbol=ETHUSDT",
      "side=BUY",
      "type=MARKET",
      "quantity=0.0082",
      "notional=19.93",
      "fee=0.02",
      "slippageBps=50",
      "referencePrice=2431.17",
      "expiresAt=2026-09-07T12:02:00.000Z",
    ]) {
      expect(payload, field).toContain(field);
    }
  });

  it("changes when any number in the order changes", () => {
    const original = hashProposal(proposal(), fakeHash);
    const mutations = [
      proposal({ quantity: fp.parse("0.0083") }),
      proposal({ estimatedNotional: fp.parse("19.94") }),
      proposal({ estimatedFee: fp.parse("0.03") }),
      proposal({ referencePrice: fp.parse("2431.18") }),
      proposal({ maxSlippageBps: 51 }),
      proposal({ side: "SELL" }),
      proposal({ orderType: "LIMIT" }),
      proposal({ limitPrice: fp.parse("2400.00") }),
      proposal({ expiresAt: at(121) }),
      proposal({ evidenceDigest: "sha256:different" }),
      proposal({ policyVersion: "telt-policy-2" }),
    ];
    for (const mutated of mutations) {
      expect(hashProposal(mutated, fakeHash), JSON.stringify(mutated.id)).not.toBe(original);
    }
  });

  it("is stable across repeated calls and across differently built objects", () => {
    const built = { ...proposal() };
    expect(hashProposal(built, fakeHash)).toBe(hashProposal(proposal(), fakeHash));
    expect(hashProposal(proposal(), fakeHash)).toBe(hashProposal(proposal(), fakeHash));
  });

  it("distinguishes a null limit price from a zero one", () => {
    expect(hashProposal(proposal({ limitPrice: null }), fakeHash)).not.toBe(
      hashProposal(proposal({ limitPrice: fp.parse("0") }), fakeHash),
    );
  });

  it("derives the idempotency key from the proposal, not from chance", () => {
    // Two calls must agree, because a restart between writing the operation and
    // hearing back has to reproduce the same key or the exchange will fill twice.
    expect(idempotencyKeyFor(proposal(), fakeHash)).toBe(idempotencyKeyFor(proposal(), fakeHash));
    expect(idempotencyKeyFor(proposal({ quantity: fp.parse("0.0083") }), fakeHash)).not.toBe(
      idempotencyKeyFor(proposal(), fakeHash),
    );
  });

  it("keeps the idempotency key distinct from the proposal hash", () => {
    expect(idempotencyKeyFor(proposal(), fakeHash)).not.toBe(hashProposal(proposal(), fakeHash));
  });
});

describe("evidence digest", () => {
  it("does not depend on the order providers happened to answer in", () => {
    const a = observation({ provider: "coingecko" });
    const b = observation({ provider: "nansen" });
    expect(evidenceDigest([a, b], fakeHash)).toBe(evidenceDigest([b, a], fakeHash));
  });

  it("changes when a source flips from valid to stale", () => {
    // The number did not move, but what the proposal rests on did.
    const valid = observation({ provider: "nansen", status: "valid" });
    const stale = { ...valid, status: "stale" as const };
    expect(evidenceDigest([valid], fakeHash)).not.toBe(evidenceDigest([stale], fakeHash));
  });

  it("changes when the underlying payload changes", () => {
    const first = observation({ rawPayloadHash: "sha256:a" });
    const second = { ...first, rawPayloadHash: "sha256:b" };
    expect(evidenceDigest([first], fakeHash)).not.toBe(evidenceDigest([second], fakeHash));
  });

  it("distinguishes an empty evidence set from a missing one", () => {
    expect(evidenceDigest([], fakeHash)).toBe(evidenceDigest([], fakeHash));
    expect(evidenceDigest([], fakeHash)).not.toBe(evidenceDigest([observation()], fakeHash));
  });

  it("is computed over the observation's own timestamp, not the read time", () => {
    const early = observation({ observedAt: T0 });
    const late = { ...early, observedAt: at(30) };
    expect(evidenceDigest([early], fakeHash)).not.toBe(evidenceDigest([late], fakeHash));
  });
});
