import { describe, expect, it } from "vitest";

import * as fp from "../src/money/fixed-point.js";
import type { Refusal, Result } from "../src/domain/result.js";
import {
  evaluateConfirmation,
  evaluateEvidence,
  evaluateExecution,
  evaluatePaidCall,
  evaluateProposal,
  evaluateSafety,
  evaluateSender,
  evaluateSymbol,
} from "../src/policy/engine.js";
import { defaultPolicy, validatePolicy } from "../src/policy/limits.js";
import type { OperationId } from "../src/domain/types.js";
import {
  at,
  account,
  candidate,
  ETHUSDT,
  filters,
  market,
  observation,
  OWNER,
  policy,
  proposal,
  safety,
  STRANGER,
  T0,
  thesis,
  token,
} from "./builders.js";

/** Assert a refusal and return its code, so each test reads as one line of intent. */
function refusalCode<T>(result: Result<T, Refusal>): string {
  if (result.ok) {
    throw new Error("expected a refusal, got a pass");
  }
  return result.error.code;
}

function expectPass<T>(result: Result<T, Refusal>): T {
  if (!result.ok) {
    throw new Error(`expected a pass, got ${result.error.code}: ${result.error.detail}`);
  }
  return result.value;
}

describe("policy validation", () => {
  it("accepts the shipped default", () => {
    expect(() => validatePolicy(defaultPolicy())).not.toThrow();
  });

  it("refuses a policy whose per-call cap exceeds the run budget", () => {
    const broken = policy({
      x402: { ...defaultPolicy().x402, maxPerCallUsdc: fp.parse("5.00") },
    });
    expect(() => validatePolicy(broken)).toThrow(/maxPerCallUsdc must not exceed maxPerRunUsdc/);
  });

  it("refuses an empty symbol list rather than allowing everything", () => {
    expect(() => validatePolicy(policy({ trading: { ...defaultPolicy().trading, allowedSymbols: [] } }))).toThrow(
      /at least one symbol/,
    );
  });

  it("refuses a proposal TTL that outlives its own price", () => {
    expect(() =>
      validatePolicy(policy({ trading: { ...defaultPolicy().trading, proposalTtl: 3600 as never } })),
    ).toThrow(/outlives the price/);
  });

  it("refuses a slippage cap so wide it is not a cap", () => {
    expect(() =>
      validatePolicy(policy({ trading: { ...defaultPolicy().trading, maxSlippageBps: 5000 } })),
    ).toThrow(/not a limit/);
  });
});

describe("sender gate", () => {
  it("admits the configured owner in a direct chat", () => {
    expectPass(evaluateSender({ senderIdHash: OWNER, ownerIdHash: OWNER, origin: "direct" }));
  });

  it("refuses a second sender", () => {
    expect(refusalCode(evaluateSender({ senderIdHash: STRANGER, ownerIdHash: OWNER, origin: "direct" }))).toBe(
      "SENDER_NOT_ALLOWED",
    );
  });

  it("refuses the owner's own message when it arrives from a group", () => {
    // The owner is still the owner. The channel is what is refused, because a
    // group can contain anyone and a forwarded instruction is not consent.
    expect(refusalCode(evaluateSender({ senderIdHash: OWNER, ownerIdHash: OWNER, origin: "group" }))).toBe(
      "GROUP_MESSAGE_REFUSED",
    );
  });

  it("refuses when the origin cannot be determined", () => {
    expect(refusalCode(evaluateSender({ senderIdHash: OWNER, ownerIdHash: OWNER, origin: "unknown" }))).toBe(
      "GROUP_MESSAGE_REFUSED",
    );
  });

  it("refuses everything when no owner is configured", () => {
    expect(refusalCode(evaluateSender({ senderIdHash: OWNER, ownerIdHash: null, origin: "direct" }))).toBe(
      "SENDER_NOT_ALLOWED",
    );
  });
});

describe("safety gate", () => {
  it("passes when nothing is wrong", () => {
    expectPass(evaluateSafety({ safety: safety(), now: T0, forExecution: true }));
  });

  it("refuses everything while the kill switch is engaged", () => {
    const engaged = safety({ killSwitchEngaged: true, killSwitchReason: "operator stop" });
    expect(refusalCode(evaluateSafety({ safety: engaged, now: T0, forExecution: false }))).toBe(
      "KILL_SWITCH_ENGAGED",
    );
    expect(refusalCode(evaluateSafety({ safety: engaged, now: T0, forExecution: true }))).toBe(
      "KILL_SWITCH_ENGAGED",
    );
  });

  it("refuses during a cooldown and passes once it lapses", () => {
    const cooling = safety({ cooldownUntil: at(60) });
    expect(refusalCode(evaluateSafety({ safety: cooling, now: at(59), forExecution: false }))).toBe(
      "COOLDOWN_ACTIVE",
    );
    expectPass(evaluateSafety({ safety: cooling, now: at(60), forExecution: false }));
  });

  it("blocks a new order while an earlier one is unreconciled, but not research", () => {
    const pending = safety({ unreconciledOperations: ["op-1" as OperationId] });
    expect(refusalCode(evaluateSafety({ safety: pending, now: T0, forExecution: true }))).toBe(
      "PENDING_OPERATION_UNRECONCILED",
    );
    expectPass(evaluateSafety({ safety: pending, now: T0, forExecution: false }));
  });
});

describe("symbol gate", () => {
  it("normalises case and whitespace", () => {
    expect(expectPass(evaluateSymbol({ policy: policy(), symbol: "  ethusdt " }))).toBe(ETHUSDT);
  });

  it("refuses a symbol that is not on the list", () => {
    expect(refusalCode(evaluateSymbol({ policy: policy(), symbol: "DOGEUSDT" }))).toBe("SYMBOL_NOT_ALLOWED");
  });

  it("refuses an empty symbol", () => {
    expect(refusalCode(evaluateSymbol({ policy: policy(), symbol: "   " }))).toBe("COMMAND_NOT_UNDERSTOOD");
  });
});

describe("paid call budget", () => {
  const zero = fp.parse("0.00");

  it("allows a call inside every ceiling", () => {
    expectPass(
      evaluatePaidCall({
        policy: policy(),
        quotedUsdc: fp.parse("0.05"),
        alreadySpentThisRun: zero,
        alreadySpentToday: zero,
        walletConfigured: true,
      }),
    );
  });

  it("refuses before signing when no wallet is configured", () => {
    expect(
      refusalCode(
        evaluatePaidCall({
          policy: policy(),
          quotedUsdc: fp.parse("0.01"),
          alreadySpentThisRun: zero,
          alreadySpentToday: zero,
          walletConfigured: false,
        }),
      ),
    ).toBe("X402_WALLET_NOT_CONFIGURED");
  });

  it("refuses a provider that raised its price past the per-call cap", () => {
    // Nansen quoted $0.05 on 2026-09-07. The cap sits at $0.06. A jump to $0.10
    // is refused rather than paid.
    expect(
      refusalCode(
        evaluatePaidCall({
          policy: policy(),
          quotedUsdc: fp.parse("0.10"),
          alreadySpentThisRun: zero,
          alreadySpentToday: zero,
          walletConfigured: true,
        }),
      ),
    ).toBe("X402_CALL_ABOVE_PER_CALL_CAP");
  });

  it("refuses the call that would push a single run over budget", () => {
    // 0.05 + 0.01 + 0.01 = 0.07 fits the 0.10 run cap. A fourth 0.05 call does not.
    expect(
      refusalCode(
        evaluatePaidCall({
          policy: policy(),
          quotedUsdc: fp.parse("0.05"),
          alreadySpentThisRun: fp.parse("0.07"),
          alreadySpentToday: fp.parse("0.07"),
          walletConfigured: true,
        }),
      ),
    ).toBe("X402_RUN_BUDGET_EXHAUSTED");
  });

  it("refuses once the UTC day is spent, even on a fresh run", () => {
    expect(
      refusalCode(
        evaluatePaidCall({
          policy: policy(),
          quotedUsdc: fp.parse("0.01"),
          alreadySpentThisRun: zero,
          alreadySpentToday: fp.parse("2.00"),
          walletConfigured: true,
        }),
      ),
    ).toBe("X402_DAILY_BUDGET_EXHAUSTED");
  });

  it("treats a cap as inclusive, so spending exactly to the ceiling is allowed", () => {
    expectPass(
      evaluatePaidCall({
        policy: policy(),
        quotedUsdc: fp.parse("0.03"),
        alreadySpentThisRun: fp.parse("0.07"),
        alreadySpentToday: fp.parse("1.97"),
        walletConfigured: true,
      }),
    );
  });
});

describe("evidence gate", () => {
  it("counts distinct providers, not observations", () => {
    // Three CoinGecko endpoints agreeing is one source agreeing with itself.
    const result = evaluateEvidence({
      policy: policy(),
      now: T0,
      observations: [
        observation({ provider: "coingecko", capability: "market.price" }),
        observation({ provider: "coingecko", capability: "market.metadata" }),
        observation({ provider: "coingecko", capability: "market.orderbook" }),
      ],
    });
    expect(refusalCode(result)).toBe("INSUFFICIENT_EVIDENCE");
  });

  it("passes when two independent providers answer", () => {
    const assessment = expectPass(
      evaluateEvidence({
        policy: policy(),
        now: T0,
        observations: [observation({ provider: "coingecko" }), observation({ provider: "nansen" })],
      }),
    );
    expect(assessment.validSources).toBe(2);
  });

  it("treats an observation past its freshness deadline as stale, not valid", () => {
    const result = evaluateEvidence({
      policy: policy(),
      now: at(61),
      observations: [
        observation({ provider: "coingecko", freshnessDeadline: at(60) }),
        observation({ provider: "nansen", freshnessDeadline: at(900) }),
      ],
    });
    expect(refusalCode(result)).toBe("INSUFFICIENT_EVIDENCE");
  });

  it("reports unavailable and stale counts so the user sees what was missing", () => {
    const result = evaluateEvidence({
      policy: policy({ trading: { ...defaultPolicy().trading, minValidSources: 3 } }),
      now: T0,
      observations: [
        observation({ provider: "coingecko" }),
        observation({ provider: "nansen", status: "unavailable" }),
        observation({ provider: "coinmarketcap", status: "stale" }),
      ],
    });
    if (result.ok) {
      throw new Error("expected a refusal");
    }
    expect(result.error.context).toMatchObject({ valid: 1, stale: 1, unavailable: 1, required: 3 });
  });
});

describe("proposal gate", () => {
  const base = {
    policy: policy(),
    filters: filters(),
    market: market(),
    account: account(),
    realisedLossToday: fp.parse("0.00"),
    openExposure: fp.parse("0.00"),
    now: T0,
  };

  it("passes an order that is inside every limit", () => {
    expectPass(evaluateProposal({ ...base, candidate: candidate(), thesis: thesis() }));
  });

  it("refuses when the research said not to trade", () => {
    expect(
      refusalCode(
        evaluateProposal({
          ...base,
          candidate: candidate(),
          thesis: thesis({ recommendation: "NO_TRADE" }),
        }),
      ),
    ).toBe("NO_TRADE_RECOMMENDED");
  });

  it("refuses when the model said the evidence was insufficient", () => {
    expect(
      refusalCode(
        evaluateProposal({
          ...base,
          candidate: candidate(),
          thesis: thesis({ recommendation: "INSUFFICIENT_EVIDENCE" }),
        }),
      ),
    ).toBe("NO_TRADE_RECOMMENDED");
  });

  it("refuses a price older than the freshness window", () => {
    expect(
      refusalCode(
        evaluateProposal({ ...base, now: at(61), candidate: candidate(), thesis: thesis() }),
      ),
    ).toBe("MARKET_DATA_STALE");
  });

  it("refuses a price stamped in the future", () => {
    // Clock skew between Kertel and the exchange must fail closed, not open.
    expect(
      refusalCode(
        evaluateProposal({
          ...base,
          market: market({ observedAt: at(30) }),
          candidate: candidate(),
          thesis: thesis(),
        }),
      ),
    ).toBe("MARKET_DATA_STALE");
  });

  it("refuses an order above the per-trade notional cap", () => {
    expect(
      refusalCode(
        evaluateProposal({
          ...base,
          candidate: candidate({
            quantity: fp.parse("0.0500"),
            estimatedNotional: fp.parse("121.55"),
          }),
          thesis: thesis(),
        }),
      ),
    ).toBe("NOTIONAL_ABOVE_CAP");
  });

  it("refuses a quantity that is not a multiple of the exchange step size", () => {
    expect(
      refusalCode(
        evaluateProposal({
          ...base,
          candidate: candidate({ quantity: fp.parse("0.00825") }),
          thesis: thesis(),
        }),
      ),
    ).toBe("NOTIONAL_BELOW_EXCHANGE_MINIMUM");
  });

  it("refuses an order below the exchange minimum notional", () => {
    expect(
      refusalCode(
        evaluateProposal({
          ...base,
          candidate: candidate({
            quantity: fp.parse("0.0010"),
            estimatedNotional: fp.parse("2.43"),
          }),
          thesis: thesis(),
        }),
      ),
    ).toBe("NOTIONAL_BELOW_EXCHANGE_MINIMUM");
  });

  /**
   * Both rules below come from the live ETHUSDT filters, read from the
   * authenticated Binance MCP on 2026-09-07 and saved to
   * `fixtures/binance/exchange-info-2026-09-07.json`. They are the two ways an
   * order can pass every obvious check and still be rejected by the venue.
   */
  it("checks the minimum notional against the venue average, not just the last price", () => {
    // Sized against a last price of 2431.17 this is 5.05 USDT and clears the
    // 5.00 minimum. The venue checks it against its own five-minute average,
    // which has fallen to 2380, making it 4.94 — and it would be rejected.
    const result = evaluateProposal({
      ...base,
      market: market({ averagePrice: fp.parse("2380.00") }),
      candidate: candidate({
        quantity: fp.parse("0.0021"),
        referencePrice: fp.parse("2431.17"),
        estimatedNotional: fp.parse("5.11"),
      }),
      thesis: thesis(),
    });
    expect(refusalCode(result)).toBe("NOTIONAL_BELOW_EXCHANGE_MINIMUM");
  });

  it("tells the user how much more to ask for", () => {
    const result = evaluateProposal({
      ...base,
      candidate: candidate({
        quantity: fp.parse("0.0010"),
        estimatedNotional: fp.parse("2.43"),
      }),
      thesis: thesis(),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // A refusal a user can act on names the gap, not just the rule.
    expect(result.error.detail).toContain("5.00");
    expect(result.error.context?.["shortfall"]).toBeDefined();
  });

  it("falls back to the last price when no venue average is available, and says so", () => {
    const result = evaluateProposal({
      ...base,
      market: market({ averagePrice: null }),
      candidate: candidate({
        quantity: fp.parse("0.0010"),
        estimatedNotional: fp.parse("2.43"),
      }),
      thesis: thesis(),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(String(result.error.context?.["pricedAgainst"])).toContain("no venue average");
  });

  it("still passes when the venue average is above the last price", () => {
    // A higher average only helps the notional clear, so it must not be treated
    // as a reason to refuse.
    expectPass(
      evaluateProposal({
        ...base,
        market: market({ averagePrice: fp.parse("2500.00") }),
        candidate: candidate(),
        thesis: thesis(),
      }),
    );
  });

  it("refuses a market order above the separate market lot ceiling", () => {
    // 3000 ETH is inside LOT_SIZE's 9000 and outside MARKET_LOT_SIZE's 2192.
    const result = evaluateProposal({
      ...base,
      policy: policy({ trading: { ...policy().trading, maxTradeNotional: fp.parse("99999999.00") } }),
      account: account({
        balances: [{ asset: "USDT", free: fp.parse("99999999.00"), locked: fp.parse("0.00") }],
      }),
      candidate: candidate({
        orderType: "MARKET",
        quantity: fp.parse("3000.0000"),
        estimatedNotional: fp.parse("7293510.00"),
      }),
      thesis: thesis(),
    });
    expect(refusalCode(result)).toBe("NOTIONAL_ABOVE_CAP");
    if (result.ok) return;
    expect(result.error.context?.["limit"]).toBe("MARKET_LOT_SIZE");
  });

  it("does not apply the market ceiling to a limit order", () => {
    // The same quantity as a LIMIT order is only bound by LOT_SIZE, so if it is
    // refused it must be for a different reason than the market ceiling.
    const result = evaluateProposal({
      ...base,
      candidate: candidate({
        orderType: "LIMIT",
        quantity: fp.parse("3000.0000"),
        estimatedNotional: fp.parse("7293510.00"),
      }),
      thesis: thesis(),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.context?.["limit"]).toBeUndefined();
  });

  it("refuses slippage above the configured cap", () => {
    expect(
      refusalCode(
        evaluateProposal({ ...base, candidate: candidate({ maxSlippageBps: 300 }), thesis: thesis() }),
      ),
    ).toBe("SLIPPAGE_ABOVE_CAP");
  });

  it("refuses once the daily loss cap is passed", () => {
    expect(
      refusalCode(
        evaluateProposal({
          ...base,
          realisedLossToday: fp.parse("50.01"),
          candidate: candidate(),
          thesis: thesis(),
        }),
      ),
    ).toBe("DAILY_LOSS_CAP_REACHED");
  });

  it("refuses when the order would push open exposure past its ceiling", () => {
    expect(
      refusalCode(
        evaluateProposal({
          ...base,
          openExposure: fp.parse("95.00"),
          candidate: candidate(),
          thesis: thesis(),
        }),
      ),
    ).toBe("OPEN_EXPOSURE_ABOVE_CAP");
  });

  it("refuses a buy the quote balance cannot cover, counting the fee", () => {
    expect(
      refusalCode(
        evaluateProposal({
          ...base,
          account: account({
            balances: [{ asset: "USDT", free: fp.parse("19.94"), locked: fp.parse("0.00") }],
          }),
          candidate: candidate(),
          thesis: thesis(),
        }),
      ),
    ).toBe("INSUFFICIENT_BALANCE");
  });

  it("checks the base asset balance for a sell, not the quote", () => {
    expect(
      refusalCode(
        evaluateProposal({
          ...base,
          account: account({
            balances: [
              { asset: "USDT", free: fp.parse("500.00"), locked: fp.parse("0.00") },
              { asset: "ETH", free: fp.parse("0.0001"), locked: fp.parse("0.0000") },
            ],
          }),
          candidate: candidate({ side: "SELL" }),
          thesis: thesis(),
        }),
      ),
    ).toBe("INSUFFICIENT_BALANCE");
  });

  it("refuses a symbol removed from the allowlist after research ran", () => {
    expect(
      refusalCode(
        evaluateProposal({
          ...base,
          policy: policy({ trading: { ...defaultPolicy().trading, allowedSymbols: ["BTCUSDT" as never] } }),
          candidate: candidate(),
          thesis: thesis(),
        }),
      ),
    ).toBe("SYMBOL_NOT_ALLOWED");
  });
});

describe("confirmation gate", () => {
  const base = {
    senderIdHash: OWNER,
    currentProposalHash: "sha256:proposal",
    proposalStatus: "prepared" as const,
    now: at(10),
  };

  it("accepts the right code, from the right sender, in time", () => {
    expectPass(evaluateConfirmation({ ...base, token: token(), proposal: proposal() }));
  });

  it("refuses a code nobody issued", () => {
    expect(refusalCode(evaluateConfirmation({ ...base, token: null, proposal: proposal() }))).toBe(
      "TOKEN_NOT_FOUND",
    );
  });

  it("refuses a replay of a code that already worked", () => {
    expect(
      refusalCode(
        evaluateConfirmation({
          ...base,
          token: token({ status: "consumed", consumedAt: at(5) }),
          proposal: proposal(),
        }),
      ),
    ).toBe("TOKEN_ALREADY_CONSUMED");
  });

  it("refuses a code sent by a different number", () => {
    expect(
      refusalCode(
        evaluateConfirmation({ ...base, senderIdHash: STRANGER, token: token(), proposal: proposal() }),
      ),
    ).toBe("TOKEN_SENDER_MISMATCH");
  });

  it("checks sender binding before it admits the code even exists", () => {
    // A stranger guessing codes learns the same thing whether or not the code is
    // real, which keeps token guessing from doubling as an oracle.
    const wrongSender = evaluateConfirmation({
      ...base,
      senderIdHash: STRANGER,
      token: token({ status: "consumed" }),
      proposal: proposal(),
    });
    expect(refusalCode(wrongSender)).toBe("TOKEN_SENDER_MISMATCH");
  });

  it("refuses a code past its expiry", () => {
    expect(
      refusalCode(
        evaluateConfirmation({ ...base, now: at(120), token: token(), proposal: proposal() }),
      ),
    ).toBe("TOKEN_EXPIRED");
  });

  it("refuses a revoked code, which is what `stop` produces", () => {
    expect(
      refusalCode(
        evaluateConfirmation({ ...base, token: token({ status: "revoked" }), proposal: proposal() }),
      ),
    ).toBe("TOKEN_REVOKED");
  });

  it("refuses when the proposal changed after the code was issued", () => {
    // This is the check that makes `confirm KTL-4821` mean one exact order. The
    // hash is recomputed from stored state, never taken from the request.
    expect(
      refusalCode(
        evaluateConfirmation({
          ...base,
          currentProposalHash: "sha256:proposal-with-a-bigger-amount",
          token: token(),
          proposal: proposal(),
        }),
      ),
    ).toBe("PROPOSAL_MUTATED_AFTER_ISSUE");
  });

  it("refuses a code aimed at a different proposal", () => {
    expect(
      refusalCode(
        evaluateConfirmation({
          ...base,
          token: token({ proposalId: "prop-2" as never }),
          proposal: proposal(),
        }),
      ),
    ).toBe("TOKEN_PROPOSAL_MISMATCH");
  });

  it("refuses a second confirmation of an executed trade", () => {
    expect(
      refusalCode(
        evaluateConfirmation({
          ...base,
          proposalStatus: "executed",
          token: token(),
          proposal: proposal(),
        }),
      ),
    ).toBe("PROPOSAL_ALREADY_EXECUTED");
  });

  it("refuses a live code whose proposal has expired underneath it", () => {
    expect(
      refusalCode(
        evaluateConfirmation({
          ...base,
          now: at(100),
          token: token({ expiresAt: at(300) }),
          proposal: proposal({ expiresAt: at(60) }),
        }),
      ),
    ).toBe("PROPOSAL_EXPIRED");
  });
});

describe("execution gate", () => {
  it("refuses with the write gate closed, after every other check passed", () => {
    // The refusal the fixture demo shows. Everything upstream really ran.
    expect(
      refusalCode(
        evaluateExecution({ policy: policy(), safety: safety(), existingOperation: null, now: T0 }),
      ),
    ).toBe("LIVE_EXECUTION_DISABLED");
  });

  it("passes when the operator has opened the write gate", () => {
    expectPass(
      evaluateExecution({
        policy: policy({ trading: { ...defaultPolicy().trading, liveExecutionEnabled: true } }),
        safety: safety(),
        existingOperation: null,
        now: T0,
      }),
    );
  });

  it("refuses a duplicate before it checks whether live trading is on", () => {
    // A restart between writing the operation and hearing back must not resend.
    // This refusal has to win even with the write gate open.
    const result = evaluateExecution({
      policy: policy({ trading: { ...defaultPolicy().trading, liveExecutionEnabled: true } }),
      safety: safety(),
      existingOperation: {
        id: "op-1" as OperationId,
        proposalId: "prop-1" as never,
        idempotencyKey: "sha256:proposal",
        exchangeOrderRef: null,
        status: "unknown",
        requestHash: "sha256:request",
        responseHash: null,
        filledQuantity: fp.parse("0.0000"),
        averagePrice: null,
        feePaid: null,
        submittedAt: T0,
        reconciledAt: null,
        failureCode: null,
      },
      now: T0,
    });
    expect(refusalCode(result)).toBe("DUPLICATE_IDEMPOTENCY_KEY");
  });

  it("refuses while an earlier operation is unreconciled", () => {
    expect(
      refusalCode(
        evaluateExecution({
          policy: policy({ trading: { ...defaultPolicy().trading, liveExecutionEnabled: true } }),
          safety: safety({ unreconciledOperations: ["op-9" as OperationId] }),
          existingOperation: null,
          now: T0,
        }),
      ),
    ).toBe("PENDING_OPERATION_UNRECONCILED");
  });

  it("refuses while the kill switch is engaged, whatever the write gate says", () => {
    expect(
      refusalCode(
        evaluateExecution({
          policy: policy({ trading: { ...defaultPolicy().trading, liveExecutionEnabled: true } }),
          safety: safety({ killSwitchEngaged: true, killSwitchReason: "operator stop" }),
          existingOperation: null,
          now: T0,
        }),
      ),
    ).toBe("KILL_SWITCH_ENGAGED");
  });
});
