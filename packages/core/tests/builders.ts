/**
 * Test builders.
 *
 * Every builder returns a value that already passes policy, so a test changes
 * exactly the one field it is about. A test that has to set eight fields to
 * prove one thing is a test nobody trusts when it goes red.
 */

import * as fp from "../src/money/fixed-point.js";
import { instant, seconds } from "../src/domain/time.js";
import type { Instant } from "../src/domain/time.js";
import type {
  AccountSnapshot,
  ConfirmationToken,
  EvidenceObservation,
  MarketSnapshot,
  ProposalId,
  ResearchRunId,
  SafetyState,
  SenderIdHash,
  Symbol_,
  SymbolFilters,
  Thesis,
  TradeProposal,
} from "../src/domain/types.js";
import type { ProposalCandidate } from "../src/policy/engine.js";
import { defaultPolicy } from "../src/policy/limits.js";
import type { Policy } from "../src/policy/limits.js";

/** 2026-09-07T12:00:00.000Z. A fixed point so every expiry assertion is arithmetic. */
export const T0: Instant = instant(Date.parse("2026-09-07T12:00:00.000Z"));

export const OWNER = "sha256:owner" as SenderIdHash;
export const STRANGER = "sha256:stranger" as SenderIdHash;
export const ETHUSDT = "ETHUSDT" as Symbol_;

export function at(offsetSeconds: number): Instant {
  return instant(T0 + offsetSeconds * 1000);
}

export function policy(overrides: Partial<Policy> = {}): Policy {
  const base = defaultPolicy();
  return {
    ...base,
    ...overrides,
    trading: { ...base.trading, ...(overrides.trading ?? {}) },
    x402: { ...base.x402, ...(overrides.x402 ?? {}) },
  };
}

/** Binance ETHUSDT Spot filter shape, matching the real tick and lot sizes. */
export function filters(overrides: Partial<SymbolFilters> = {}): SymbolFilters {
  return {
    symbol: ETHUSDT,
    baseAsset: "ETH",
    quoteAsset: "USDT",
    tickSize: fp.parse("0.01"),
    stepSize: fp.parse("0.0001"),
    minQuantity: fp.parse("0.0001"),
    maxQuantity: fp.parse("9000.0000"),
    minNotional: fp.parse("5.00"),
    marketMaxQuantity: fp.parse("2192.93460666"),
    notionalAveragePriceMinutes: 5,
    ...overrides,
  };
}

export function market(overrides: Partial<MarketSnapshot> = {}): MarketSnapshot {
  return {
    symbol: ETHUSDT,
    lastPrice: fp.parse("2431.17"),
    bestBid: fp.parse("2431.10"),
    bestAsk: fp.parse("2431.24"),
    averagePrice: fp.parse("2431.05"),
    observedAt: T0,
    source: "binance:ticker",
    ...overrides,
  };
}

export function account(overrides: Partial<AccountSnapshot> = {}): AccountSnapshot {
  return {
    accountRef: "agentic-sub-1",
    balances: [
      { asset: "USDT", free: fp.parse("500.00"), locked: fp.parse("0.00") },
      { asset: "ETH", free: fp.parse("0.5000"), locked: fp.parse("0.0000") },
    ],
    observedAt: T0,
    canTradeSpot: true,
    ...overrides,
  };
}

export function safety(overrides: Partial<SafetyState> = {}): SafetyState {
  return {
    killSwitchEngaged: false,
    killSwitchReason: null,
    killSwitchEngagedAt: null,
    cooldownUntil: null,
    unreconciledOperations: [],
    ...overrides,
  };
}

/** A 20 USDT buy of ETH: 0.0082 ETH at 2431.17, inside every default limit. */
export function candidate(overrides: Partial<ProposalCandidate> = {}): ProposalCandidate {
  return {
    symbol: ETHUSDT,
    side: "BUY",
    orderType: "MARKET",
    quantity: fp.parse("0.0082"),
    referencePrice: fp.parse("2431.17"),
    estimatedNotional: fp.parse("19.93"),
    estimatedFee: fp.parse("0.02"),
    maxSlippageBps: 50,
    ...overrides,
  };
}

let evidenceCounter = 0;

export function observation(
  overrides: Partial<EvidenceObservation> = {},
): EvidenceObservation {
  evidenceCounter += 1;
  return {
    id: `ev-${String(evidenceCounter)}` as EvidenceObservation["id"],
    provider: "coingecko",
    capability: "market.price",
    endpointId: "coingecko:simple/price",
    status: "valid",
    observedAt: T0,
    freshnessDeadline: at(60),
    normalized: { priceUsd: "2431.17" },
    rawPayloadHash: "sha256:fixture",
    sourceUrl: "https://pro-api.coingecko.com/api/v3/x402/simple/price",
    costUsdc: fp.parse("0.01"),
    paymentAttemptId: null,
    ...overrides,
  };
}

export function thesis(overrides: Partial<Thesis> = {}): Thesis {
  return {
    symbol: ETHUSDT,
    recommendation: "BUY_CANDIDATE",
    summary: "Two independent sources agree on price and flows are positive.",
    supportingEvidence: [],
    conflicts: [],
    invalidatedBy: ["A daily close below the 2380 area."],
    confidence: 55,
    modelId: "fixture-model",
    producedAt: T0,
    ...overrides,
  };
}

export function proposal(overrides: Partial<TradeProposal> = {}): TradeProposal {
  return {
    id: "prop-1" as ProposalId,
    researchRunId: "run-1" as ResearchRunId,
    senderIdHash: OWNER,
    symbol: ETHUSDT,
    side: "BUY",
    orderType: "MARKET",
    quantity: fp.parse("0.0082"),
    limitPrice: null,
    referencePrice: fp.parse("2431.17"),
    estimatedNotional: fp.parse("19.93"),
    estimatedFee: fp.parse("0.02"),
    maxSlippageBps: 50,
    evidenceDigest: "sha256:evidence",
    policyVersion: "kertel-policy-1",
    mode: "fixture",
    createdAt: T0,
    expiresAt: at(120),
    ...overrides,
  };
}

export function token(overrides: Partial<ConfirmationToken> = {}): ConfirmationToken {
  return {
    tokenHash: "sha256:token",
    proposalId: "prop-1" as ProposalId,
    proposalHash: "sha256:proposal",
    senderIdHash: OWNER,
    issuedAt: T0,
    expiresAt: at(120),
    consumedAt: null,
    status: "active",
    ...overrides,
  };
}

export const TTL = seconds(120);
