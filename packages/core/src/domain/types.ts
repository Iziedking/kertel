/**
 * The entities Kertel reasons about.
 *
 * These mirror the SQLite schema in the plan, with one difference that matters:
 * every money value is a `FixedPoint`, never a string or a number. Strings are
 * the storage form; the domain works in fixed point so a rounding decision is
 * always explicit and always tested.
 */

import type { FixedPoint } from "../money/fixed-point.js";
import type { Instant, Seconds } from "./time.js";

/**
 * Fixture mode runs the whole product with no keys and no network. It is the
 * default, it is how the suite and the demo run, and keeping it working is a
 * build requirement rather than a convenience.
 */
export type RunMode = "fixture" | "live";

/** Opaque identifiers. Branded so a proposal id cannot be passed where a run id belongs. */
export type ResearchRunId = string & { readonly __brand: "ResearchRunId" };
export type EvidenceId = string & { readonly __brand: "EvidenceId" };
export type PaymentAttemptId = string & { readonly __brand: "PaymentAttemptId" };
export type ProposalId = string & { readonly __brand: "ProposalId" };
export type OperationId = string & { readonly __brand: "OperationId" };
export type ReceiptId = string & { readonly __brand: "ReceiptId" };

/**
 * A WhatsApp sender, already normalised to E.164 and then hashed for storage.
 *
 * The raw number is a personal identifier and a routing secret, so it lives in
 * config and in the OpenClaw allowlist, never in the audit trail. Comparisons
 * happen on the hash.
 */
export type SenderIdHash = string & { readonly __brand: "SenderIdHash" };

/** Where a message arrived from. A group is refused outright in this version. */
export type MessageOrigin = "direct" | "group" | "unknown";

// ---------------------------------------------------------------------------
// Market
// ---------------------------------------------------------------------------

/** An exchange Spot symbol, uppercase, for example `ETHUSDT`. */
export type Symbol_ = string & { readonly __brand: "Symbol" };

/**
 * The exchange's own constraints on an order.
 *
 * Read fresh before every proposal. These are the rules that reject an order
 * outright, so a stale copy turns into an avoidable failed order rather than a
 * refusal the user could have understood.
 */
export type SymbolFilters = {
  readonly symbol: Symbol_;
  readonly baseAsset: string;
  readonly quoteAsset: string;
  /** Price increment. A price that is not a multiple of this is rejected. */
  readonly tickSize: FixedPoint;
  /** Quantity increment. */
  readonly stepSize: FixedPoint;
  readonly minQuantity: FixedPoint;
  readonly maxQuantity: FixedPoint;
  /** Smallest permitted price times quantity. */
  readonly minNotional: FixedPoint;
  /**
   * A separate, lower quantity ceiling that applies to MARKET orders only.
   *
   * Binance publishes this as `MARKET_LOT_SIZE`, and on ETHUSDT it is 2192 ETH
   * against a LOT_SIZE ceiling of 9000. Checking only the general ceiling would
   * pass an order the exchange then rejects. Null where the venue publishes no
   * separate market limit.
   */
  readonly marketMaxQuantity: FixedPoint | null;
  /**
   * How many minutes of average price the venue checks `minNotional` against.
   *
   * Binance uses five, not the last trade. Recorded because the difference is
   * invisible until a fast market rejects an order that looked fine, and the
   * proposal gate has to size against the same number the exchange will use.
   */
  readonly notionalAveragePriceMinutes: number;
};

export type MarketSnapshot = {
  readonly symbol: Symbol_;
  readonly lastPrice: FixedPoint;
  readonly bestBid: FixedPoint;
  readonly bestAsk: FixedPoint;
  /**
   * The venue's own rolling average price, the figure its notional filter uses.
   *
   * Null when it has not been read. The proposal gate then falls back to the
   * last price and the receipt says so, because "checked against the last
   * price" and "checked against the number the exchange will actually use" are
   * different assurances and only one of them is the real one.
   */
  readonly averagePrice: FixedPoint | null;
  readonly observedAt: Instant;
  readonly source: string;
};

export type AssetBalance = {
  readonly asset: string;
  readonly free: FixedPoint;
  readonly locked: FixedPoint;
};

export type AccountSnapshot = {
  readonly accountRef: string;
  readonly balances: readonly AssetBalance[];
  readonly observedAt: Instant;
  readonly canTradeSpot: boolean;
};

// ---------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------

export type ProviderId = "nansen" | "coingecko" | "coinmarketcap" | "thegraph" | "binance";

/**
 * What an observation is worth.
 *
 * `unavailable` and `invalid` are not failures to hide. They travel all the way
 * to the user, because "two of three sources answered" is a materially
 * different situation from "three of three agreed" and the user is the one
 * carrying the risk.
 */
export type EvidenceStatus = "valid" | "stale" | "partial" | "invalid" | "unavailable";

export type EvidenceObservation = {
  readonly id: EvidenceId;
  readonly provider: ProviderId;
  /** Which recipe step produced this, for example `market.price` or `smart_money.netflow`. */
  readonly capability: string;
  /** The exact code-built endpoint template used. Never model-generated. */
  readonly endpointId: string;
  readonly status: EvidenceStatus;
  readonly observedAt: Instant;
  /** After this instant the observation is stale and cannot support a proposal. */
  readonly freshnessDeadline: Instant;
  /** Normalised, size-bounded facts. This is the only shape the model ever sees. */
  readonly normalized: Readonly<Record<string, unknown>>;
  /** Hash of the raw payload, so a receipt can be tied back to what arrived. */
  readonly rawPayloadHash: string | null;
  readonly sourceUrl: string;
  readonly costUsdc: FixedPoint;
  readonly paymentAttemptId: PaymentAttemptId | null;
};

/**
 * The model's output, after schema validation.
 *
 * The model may reason and write. It may not decide. `recommendation` is an
 * input to the policy engine, never a command: policy can turn a
 * `BUY_CANDIDATE` into a refusal, and can never turn a refusal into a trade.
 */
export type ThesisRecommendation = "BUY_CANDIDATE" | "NO_TRADE" | "INSUFFICIENT_EVIDENCE";

export type EvidenceConflict = {
  readonly left: EvidenceId;
  readonly right: EvidenceId;
  readonly describes: string;
};

export type Thesis = {
  readonly symbol: Symbol_;
  readonly recommendation: ThesisRecommendation;
  /** Plain language, for the user, not for a log. */
  readonly summary: string;
  /** Every claim must point at evidence that exists in the same run. */
  readonly supportingEvidence: readonly EvidenceId[];
  readonly conflicts: readonly EvidenceConflict[];
  /** What would have to be true for this thesis to be wrong. */
  readonly invalidatedBy: readonly string[];
  /** 0 to 100. Presented as the model's own uncertainty, never as a probability of profit. */
  readonly confidence: number;
  readonly modelId: string;
  readonly producedAt: Instant;
};

export type ResearchRunStatus = "running" | "complete" | "refused" | "failed";

export type ResearchRun = {
  readonly id: ResearchRunId;
  readonly senderIdHash: SenderIdHash;
  readonly symbol: Symbol_;
  readonly mode: RunMode;
  readonly status: ResearchRunStatus;
  readonly startedAt: Instant;
  readonly completedAt: Instant | null;
  readonly policyVersion: string;
  readonly totalCostUsdc: FixedPoint;
  readonly observations: readonly EvidenceObservation[];
  readonly thesis: Thesis | null;
  /** Set when the run ended in a refusal rather than a thesis. */
  readonly refusalCode: string | null;
};

// ---------------------------------------------------------------------------
// Trading
// ---------------------------------------------------------------------------

export type OrderSide = "BUY" | "SELL";
export type OrderType = "MARKET" | "LIMIT";

/**
 * An immutable trade proposal.
 *
 * Once hashed and shown to the user, nothing here may change. A proposal that
 * needs different numbers is a new proposal with a new token. That is what
 * makes "confirm KTL-4821" mean one specific thing.
 */
export type TradeProposal = {
  readonly id: ProposalId;
  readonly researchRunId: ResearchRunId | null;
  readonly senderIdHash: SenderIdHash;
  readonly symbol: Symbol_;
  readonly side: OrderSide;
  readonly orderType: OrderType;
  readonly quantity: FixedPoint;
  readonly limitPrice: FixedPoint | null;
  /** The price the estimates below were computed from. Part of the hash. */
  readonly referencePrice: FixedPoint;
  readonly estimatedNotional: FixedPoint;
  readonly estimatedFee: FixedPoint;
  readonly maxSlippageBps: number;
  /** Digest over the evidence ids and their payload hashes. */
  readonly evidenceDigest: string;
  readonly policyVersion: string;
  readonly mode: RunMode;
  readonly createdAt: Instant;
  readonly expiresAt: Instant;
};

export type ProposalStatus =
  | "prepared"
  | "confirmed"
  | "executing"
  | "executed"
  | "rejected"
  | "expired"
  | "cancelled";

/**
 * A one-use confirmation token.
 *
 * Stored hashed, bound to one sender and one proposal hash, and short-lived.
 * The plaintext form the user types (`KTL-4821`) exists only in the outbound
 * message and in the user's chat; Kertel keeps the hash.
 */
export type ConfirmationToken = {
  readonly tokenHash: string;
  readonly proposalId: ProposalId;
  readonly proposalHash: string;
  readonly senderIdHash: SenderIdHash;
  readonly issuedAt: Instant;
  readonly expiresAt: Instant;
  readonly consumedAt: Instant | null;
  readonly status: "active" | "consumed" | "expired" | "revoked";
};

/**
 * Order state, kept deliberately wide.
 *
 * `unknown` is the important one. A timeout is not a rejection and not a
 * success. Treating it as either is how a system places the same order twice or
 * tells a user nothing happened when their money already moved.
 */
export type ExecutionStatus =
  | "planned"
  | "submitted"
  | "accepted"
  | "partial"
  | "filled"
  | "canceled"
  | "rejected"
  | "unknown"
  | "reconciled";

export type ExecutionOperation = {
  readonly id: OperationId;
  readonly proposalId: ProposalId;
  /** Derived from the proposal hash. The same proposal can never be sent twice. */
  readonly idempotencyKey: string;
  readonly exchangeOrderRef: string | null;
  readonly status: ExecutionStatus;
  readonly requestHash: string;
  readonly responseHash: string | null;
  readonly filledQuantity: FixedPoint;
  readonly averagePrice: FixedPoint | null;
  readonly feePaid: FixedPoint | null;
  readonly submittedAt: Instant | null;
  readonly reconciledAt: Instant | null;
  readonly failureCode: string | null;
};

// ---------------------------------------------------------------------------
// Safety
// ---------------------------------------------------------------------------

/**
 * The state that can stop everything.
 *
 * This is read before every paid call, every proposal and every execution. It
 * survives a restart, because a kill switch that forgets it was pulled is not a
 * kill switch.
 */
export type SafetyState = {
  readonly killSwitchEngaged: boolean;
  readonly killSwitchReason: string | null;
  readonly killSwitchEngagedAt: Instant | null;
  /** Set after an unknown or rejected execution. Blocks new proposals until it passes. */
  readonly cooldownUntil: Instant | null;
  /** Operations that were submitted and never resolved. Blocks new execution. */
  readonly unreconciledOperations: readonly OperationId[];
};

export type SpendLedgerEntry = {
  readonly utcDay: string;
  readonly spentUsdc: FixedPoint;
};

export type RealisedPnlEntry = {
  readonly utcDay: string;
  readonly realised: FixedPoint;
};

// ---------------------------------------------------------------------------
// Receipts
// ---------------------------------------------------------------------------

export type ReceiptType = "research" | "refusal" | "trade" | "reconciliation" | "system";

export type Receipt = {
  readonly id: ReceiptId;
  readonly type: ReceiptType;
  readonly senderIdHash: SenderIdHash;
  readonly researchRunId: ResearchRunId | null;
  readonly proposalId: ProposalId | null;
  readonly operationId: OperationId | null;
  readonly createdAt: Instant;
  /** What the user is shown, already formatted for WhatsApp. */
  readonly body: string;
  /** Hash over the inputs that produced this receipt, so it can be re-derived. */
  readonly provenanceDigest: string;
};

/** How long a piece of evidence stays usable, per capability. */
export type FreshnessPolicy = Readonly<Record<string, Seconds>>;
