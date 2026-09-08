/**
 * The deterministic gates. Nothing here calls out, reads a clock, or asks a
 * model. Every decision is a pure function of a policy and a snapshot, which is
 * why `scripts/prove.ts` can run the exact functions the live plugin runs.
 *
 * Two rules hold across every function in this file:
 *
 * 1. Policy can turn a recommendation into a refusal. It can never turn a
 *    refusal into a trade.
 * 2. A gate that cannot evaluate its inputs refuses. There is no "assume fine"
 *    branch anywhere below.
 */

import type { FixedPoint } from "../money/fixed-point.js";
import * as fp from "../money/fixed-point.js";
import type { Refusal, Result } from "../domain/result.js";
import { ok, refuse } from "../domain/result.js";
import type { Instant } from "../domain/time.js";
import { secondsBetween } from "../domain/time.js";
import type {
  AccountSnapshot,
  ConfirmationToken,
  EvidenceObservation,
  ExecutionOperation,
  MarketSnapshot,
  MessageOrigin,
  OrderSide,
  OrderType,
  SafetyState,
  SenderIdHash,
  Symbol_,
  SymbolFilters,
  Thesis,
  TradeProposal,
} from "../domain/types.js";
import type { Policy } from "./limits.js";

/** Nothing to hand back; the gate either passes or refuses. */
export type Passed = { readonly passed: true };
const PASSED: Passed = Object.freeze({ passed: true });

// ---------------------------------------------------------------------------
// Gate 1: who is asking
// ---------------------------------------------------------------------------

/**
 * The first gate every message meets, before the model, before any provider,
 * before a single paid call.
 *
 * OpenClaw's own channel allowlist runs before this. Telt checks again anyway.
 * A channel allowlist is routing configuration that an operator can widen by
 * accident; this is the check that decides whether money can move.
 */
export function evaluateSender(input: {
  readonly senderIdHash: SenderIdHash;
  readonly ownerIdHash: SenderIdHash | null;
  readonly origin: MessageOrigin;
}): Result<Passed, Refusal> {
  if (input.origin === "group") {
    return refuse(
      "GROUP_MESSAGE_REFUSED",
      "Telt only takes instructions in a direct chat, never in a group.",
    );
  }
  if (input.origin === "unknown") {
    return refuse(
      "GROUP_MESSAGE_REFUSED",
      "Telt could not tell whether this message came from a direct chat, so it refused it.",
    );
  }
  if (input.ownerIdHash === null) {
    return refuse(
      "SENDER_NOT_ALLOWED",
      "No owner is configured, so Telt has nobody to take instructions from.",
    );
  }
  if (input.senderIdHash !== input.ownerIdHash) {
    return refuse("SENDER_NOT_ALLOWED", "This number is not the configured owner.");
  }
  return ok(PASSED);
}

// ---------------------------------------------------------------------------
// Gate 2: is the system allowed to act at all
// ---------------------------------------------------------------------------

/**
 * Global safety state.
 *
 * `unreconciledOperations` blocks new execution rather than new research: an
 * order whose outcome is unknown must be resolved before another one is sent,
 * but the user can still ask questions while that is happening.
 */
export function evaluateSafety(input: {
  readonly safety: SafetyState;
  readonly now: Instant;
  readonly forExecution: boolean;
}): Result<Passed, Refusal> {
  if (input.safety.killSwitchEngaged) {
    return refuse("KILL_SWITCH_ENGAGED", "Trading is stopped. Send `resume` to re-enable it.", {
      reason: input.safety.killSwitchReason ?? "not recorded",
    });
  }
  if (input.safety.cooldownUntil !== null && input.now < input.safety.cooldownUntil) {
    return refuse(
      "COOLDOWN_ACTIVE",
      "Telt is in a cooldown after an unresolved operation and will not start a new one yet.",
      { secondsRemaining: Math.ceil(secondsBetween(input.now, input.safety.cooldownUntil)) },
    );
  }
  if (input.forExecution && input.safety.unreconciledOperations.length > 0) {
    return refuse(
      "PENDING_OPERATION_UNRECONCILED",
      "An earlier order has not been reconciled yet. Telt will not send another until it knows what happened to that one.",
      { pending: input.safety.unreconciledOperations.length },
    );
  }
  return ok(PASSED);
}

// ---------------------------------------------------------------------------
// Gate 3: is this a symbol we are allowed to touch
// ---------------------------------------------------------------------------

export function evaluateSymbol(input: {
  readonly policy: Policy;
  readonly symbol: string;
}): Result<Symbol_, Refusal> {
  const normalized = input.symbol.trim().toUpperCase();
  if (normalized === "") {
    return refuse("COMMAND_NOT_UNDERSTOOD", "No symbol was given.");
  }
  // `*` opens the gate to anything the exchange lists. That is not a loosening
  // of safety: Binance's own exchangeInfo is checked before any order is sized,
  // and it is authoritative in a way a hand-written list can never be. What the
  // list is genuinely for is *narrowing* — an operator who wants this account to
  // touch two pairs and nothing else.
  //
  // The caps do not move either way. An unknown symbol is still bounded by the
  // per-trade notional, the balance check and the exchange's own filters.
  if (input.policy.trading.allowedSymbols.includes("*" as Symbol_)) {
    if (!/^[A-Z0-9]{5,20}$/.test(normalized)) {
      return refuse(
        "SYMBOL_NOT_ALLOWED",
        `${JSON.stringify(input.symbol)} is not shaped like a Binance symbol.`,
        { requested: normalized },
      );
    }
    return ok(normalized as Symbol_);
  }

  const allowed = input.policy.trading.allowedSymbols.find((candidate) => candidate === normalized);
  if (allowed === undefined) {
    return refuse("SYMBOL_NOT_ALLOWED", `${normalized} is not on your allowed list.`, {
      requested: normalized,
      allowed: input.policy.trading.allowedSymbols.join(", "),
    });
  }
  return ok(allowed);
}

// ---------------------------------------------------------------------------
// Gate 4: may this paid call go out
// ---------------------------------------------------------------------------

/**
 * Budget, checked before signing anything.
 *
 * The three ceilings answer three different failure modes. Per-call catches a
 * provider that raised its price. Per-run catches a recipe that fans out wider
 * than intended. Per-day catches a loop nobody noticed. All three are checked
 * against a durable ledger, so a restart cannot reset a spend.
 */
export function evaluatePaidCall(input: {
  readonly policy: Policy;
  readonly quotedUsdc: FixedPoint;
  readonly alreadySpentThisRun: FixedPoint;
  readonly alreadySpentToday: FixedPoint;
  readonly walletConfigured: boolean;
}): Result<Passed, Refusal> {
  if (!input.walletConfigured) {
    return refuse(
      "X402_WALLET_NOT_CONFIGURED",
      "No research wallet is configured, so Telt cannot buy paid evidence.",
    );
  }
  if (fp.isNegative(input.quotedUsdc)) {
    return refuse("X402_NO_ACCEPTABLE_OPTION", "The provider quoted a negative price.");
  }
  if (fp.greaterThan(input.quotedUsdc, input.policy.x402.maxPerCallUsdc)) {
    return refuse(
      "X402_CALL_ABOVE_PER_CALL_CAP",
      `That call costs ${fp.format(input.quotedUsdc)} USDC, above your ${fp.format(input.policy.x402.maxPerCallUsdc)} per-call cap.`,
      { quoted: fp.format(input.quotedUsdc), cap: fp.format(input.policy.x402.maxPerCallUsdc) },
    );
  }

  const runTotal = fp.add(input.alreadySpentThisRun, input.quotedUsdc);
  if (fp.greaterThan(runTotal, input.policy.x402.maxPerRunUsdc)) {
    return refuse(
      "X402_RUN_BUDGET_EXHAUSTED",
      `This research run has reached its ${fp.format(input.policy.x402.maxPerRunUsdc)} USDC budget.`,
      { wouldTotal: fp.format(runTotal), cap: fp.format(input.policy.x402.maxPerRunUsdc) },
    );
  }

  const dayTotal = fp.add(input.alreadySpentToday, input.quotedUsdc);
  if (fp.greaterThan(dayTotal, input.policy.x402.maxPerDayUsdc)) {
    return refuse(
      "X402_DAILY_BUDGET_EXHAUSTED",
      `Today's research budget of ${fp.format(input.policy.x402.maxPerDayUsdc)} USDC is spent. It resets at 00:00 UTC.`,
      { wouldTotal: fp.format(dayTotal), cap: fp.format(input.policy.x402.maxPerDayUsdc) },
    );
  }

  return ok(PASSED);
}

// ---------------------------------------------------------------------------
// Gate 5: is the evidence good enough to reason from
// ---------------------------------------------------------------------------

export type EvidenceAssessment = {
  readonly validSources: number;
  readonly staleSources: number;
  readonly unavailableSources: number;
};

/**
 * Judge the evidence set before a thesis is written.
 *
 * Counting distinct providers, not observations, is deliberate. Three
 * CoinGecko endpoints agreeing is one source agreeing with itself, and reading
 * that as corroboration is exactly the mistake this product exists to avoid.
 */
export function evaluateEvidence(input: {
  readonly policy: Policy;
  readonly observations: readonly EvidenceObservation[];
  readonly now: Instant;
}): Result<EvidenceAssessment, Refusal> {
  const validProviders = new Set<string>();
  let stale = 0;
  let unavailable = 0;

  for (const observation of input.observations) {
    const expired = input.now >= observation.freshnessDeadline;
    if (observation.status === "unavailable" || observation.status === "invalid") {
      unavailable += 1;
      continue;
    }
    if (observation.status === "stale" || expired) {
      stale += 1;
      continue;
    }
    validProviders.add(observation.provider);
  }

  const assessment: EvidenceAssessment = {
    validSources: validProviders.size,
    staleSources: stale,
    unavailableSources: unavailable,
  };

  if (validProviders.size < input.policy.trading.minValidSources) {
    return refuse(
      "INSUFFICIENT_EVIDENCE",
      `Only ${String(validProviders.size)} independent source(s) returned usable data, and Telt needs ${String(input.policy.trading.minValidSources)} before it will propose a trade.`,
      {
        valid: assessment.validSources,
        stale: assessment.staleSources,
        unavailable: assessment.unavailableSources,
        required: input.policy.trading.minValidSources,
      },
    );
  }

  return ok(assessment);
}

// ---------------------------------------------------------------------------
// Gate 6: is this specific order inside the fence
// ---------------------------------------------------------------------------

/** The shape a proposal takes before policy has looked at it. */
export type ProposalCandidate = {
  readonly symbol: Symbol_;
  readonly side: OrderSide;
  readonly orderType: OrderType;
  readonly quantity: FixedPoint;
  readonly referencePrice: FixedPoint;
  readonly estimatedNotional: FixedPoint;
  readonly estimatedFee: FixedPoint;
  readonly maxSlippageBps: number;
};

/**
 * The last gate before a user is shown a number and asked to confirm it.
 *
 * Order matters here. The cheap, certain checks run first so the user gets the
 * most useful refusal: being told "that symbol is not allowed" beats being told
 * "your balance is short" when both are true.
 */
export function evaluateProposal(input: {
  readonly policy: Policy;
  readonly candidate: ProposalCandidate;
  readonly thesis: Thesis | null;
  readonly filters: SymbolFilters;
  readonly market: MarketSnapshot;
  readonly account: AccountSnapshot;
  readonly realisedLossToday: FixedPoint | null;
  readonly openExposure: FixedPoint | null;
  readonly now: Instant;
}): Result<Passed, Refusal> {
  const { policy, candidate, filters, market, now } = input;

  const symbolCheck = evaluateSymbol({ policy, symbol: candidate.symbol });
  if (!symbolCheck.ok) {
    return symbolCheck;
  }

  if (input.thesis !== null && input.thesis.recommendation !== "BUY_CANDIDATE") {
    return refuse(
      "NO_TRADE_RECOMMENDED",
      input.thesis.recommendation === "INSUFFICIENT_EVIDENCE"
        ? "The evidence was not strong enough to support a trade."
        : "The research concluded that no trade is warranted right now.",
      { recommendation: input.thesis.recommendation },
    );
  }

  const marketAge = secondsBetween(market.observedAt, now);
  if (marketAge > policy.trading.marketDataMaxAge || marketAge < 0) {
    return refuse(
      "MARKET_DATA_STALE",
      "The price Telt would size this order from is too old to trust. Ask again.",
      { ageSeconds: Math.round(marketAge), maxAgeSeconds: policy.trading.marketDataMaxAge },
    );
  }

  if (candidate.maxSlippageBps > policy.trading.maxSlippageBps) {
    return refuse(
      "SLIPPAGE_ABOVE_CAP",
      `That order allows ${String(candidate.maxSlippageBps)} bps of slippage, above your ${String(policy.trading.maxSlippageBps)} bps limit.`,
      { requested: candidate.maxSlippageBps, cap: policy.trading.maxSlippageBps },
    );
  }

  if (!fp.isPositive(candidate.quantity)) {
    return refuse(
      "NOTIONAL_BELOW_EXCHANGE_MINIMUM",
      "After applying the exchange step size, the order rounds down to nothing.",
    );
  }
  if (fp.lessThan(candidate.quantity, filters.minQuantity)) {
    return refuse(
      "NOTIONAL_BELOW_EXCHANGE_MINIMUM",
      `The exchange will not accept less than ${fp.format(filters.minQuantity)} ${filters.baseAsset}.`,
      { quantity: fp.format(candidate.quantity), minimum: fp.format(filters.minQuantity) },
    );
  }
  if (fp.greaterThan(candidate.quantity, filters.maxQuantity)) {
    return refuse(
      "NOTIONAL_ABOVE_CAP",
      `The exchange will not accept more than ${fp.format(filters.maxQuantity)} ${filters.baseAsset} in one order.`,
      { quantity: fp.format(candidate.quantity), maximum: fp.format(filters.maxQuantity) },
    );
  }
  // A market order has a second, lower ceiling of its own. On ETHUSDT that is
  // 2192 ETH against a general limit of 9000, so checking only the general one
  // passes an order the exchange then rejects.
  if (
    candidate.orderType === "MARKET" &&
    filters.marketMaxQuantity !== null &&
    fp.isPositive(filters.marketMaxQuantity) &&
    fp.greaterThan(candidate.quantity, filters.marketMaxQuantity)
  ) {
    return refuse(
      "NOTIONAL_ABOVE_CAP",
      `The exchange will not accept more than ${fp.format(filters.marketMaxQuantity)} ${filters.baseAsset} in a single market order.`,
      {
        quantity: fp.format(candidate.quantity),
        maximum: fp.format(filters.marketMaxQuantity),
        limit: "MARKET_LOT_SIZE",
      },
    );
  }
  if (!fp.equals(fp.floorToStep(candidate.quantity, filters.stepSize), candidate.quantity)) {
    return refuse(
      "NOTIONAL_BELOW_EXCHANGE_MINIMUM",
      `The quantity is not a whole multiple of the exchange step size ${fp.format(filters.stepSize)}.`,
      { quantity: fp.format(candidate.quantity), stepSize: fp.format(filters.stepSize) },
    );
  }
  // The venue checks the minimum against its own rolling average price, not
  // against the last trade Telt sized from. In a fast market those differ,
  // and an order that clears the minimum on the last price can still be
  // rejected on the average. So it is checked against whichever of the two is
  // less favourable: clearing that clears the exchange either way.
  //
  // With no average price in hand there is nothing to be conservative with, and
  // the fallback is the last price — which is the weaker assurance, and is why
  // the snapshot carries the average as a real field rather than an assumption.
  const notionalPrice =
    market.averagePrice === null || !fp.isPositive(market.averagePrice)
      ? candidate.referencePrice
      : fp.min(candidate.referencePrice, market.averagePrice);
  const worstCaseNotional = fp.multiply(candidate.quantity, notionalPrice);

  if (fp.lessThan(worstCaseNotional, filters.minNotional)) {
    const shortfall = fp.subtract(filters.minNotional, worstCaseNotional);
    return refuse(
      "NOTIONAL_BELOW_EXCHANGE_MINIMUM",
      `The exchange requires at least ${fp.format(filters.minNotional)} ${filters.quoteAsset} per order and this one is worth ${fp.format(worstCaseNotional)}. Ask for about ${fp.format(shortfall)} ${filters.quoteAsset} more.`,
      {
        notional: fp.format(worstCaseNotional),
        minimum: fp.format(filters.minNotional),
        shortfall: fp.format(shortfall),
        pricedAgainst:
          market.averagePrice === null
            ? "last price, no venue average available"
            : `the lower of the last price and the venue's ${String(filters.notionalAveragePriceMinutes)}-minute average`,
      },
    );
  }

  if (fp.greaterThan(candidate.estimatedNotional, policy.trading.maxTradeNotional)) {
    return refuse(
      "NOTIONAL_ABOVE_CAP",
      `That order is ${fp.format(candidate.estimatedNotional)} ${filters.quoteAsset}, above your ${fp.format(policy.trading.maxTradeNotional)} per-trade cap.`,
      {
        notional: fp.format(candidate.estimatedNotional),
        cap: fp.format(policy.trading.maxTradeNotional),
      },
    );
  }

  if (input.realisedLossToday !== null && candidate.side === "BUY" && fp.greaterThan(input.realisedLossToday, policy.trading.maxDailyLoss)) {
    return refuse(
      "DAILY_LOSS_CAP_REACHED",
      `Today's realised loss has passed your ${fp.format(policy.trading.maxDailyLoss)} ${filters.quoteAsset} limit. No new trades until 00:00 UTC.`,
      {
        realisedLoss: fp.format(input.realisedLossToday),
        cap: fp.format(policy.trading.maxDailyLoss),
      },
    );
  }

  const exposureAfter = input.openExposure === null ? null : fp.add(input.openExposure, candidate.estimatedNotional);
  if (exposureAfter !== null && candidate.side === "BUY" && fp.greaterThan(exposureAfter, policy.trading.maxOpenExposure)) {
    return refuse(
      "OPEN_EXPOSURE_ABOVE_CAP",
      `This would take your open exposure to ${fp.format(exposureAfter)} ${filters.quoteAsset}, above your ${fp.format(policy.trading.maxOpenExposure)} limit.`,
      {
        exposureAfter: fp.format(exposureAfter),
        cap: fp.format(policy.trading.maxOpenExposure),
      },
    );
  }

  // Balance last, because it is the check most likely to change between now and
  // the user confirming, and it is re-run at execution time anyway.
  const requiredAsset = candidate.side === "BUY" ? filters.quoteAsset : filters.baseAsset;
  const required =
    candidate.side === "BUY"
      ? fp.add(candidate.estimatedNotional, candidate.estimatedFee)
      : candidate.quantity;
  const held = input.account.balances.find((balance) => balance.asset === requiredAsset);
  if (held === undefined) {
    return refuse(
      "INSUFFICIENT_BALANCE",
      `The trading account holds no ${requiredAsset}.`,
      { asset: requiredAsset, required: fp.format(required) },
    );
  }
  if (fp.lessThan(held.free, required)) {
    return refuse(
      "INSUFFICIENT_BALANCE",
      `That order needs ${fp.format(required)} ${requiredAsset} and the account has ${fp.format(held.free)} free.`,
      { asset: requiredAsset, required: fp.format(required), available: fp.format(held.free) },
    );
  }

  return ok(PASSED);
}

// ---------------------------------------------------------------------------
// Gate 7: is this confirmation the real thing
// ---------------------------------------------------------------------------

/**
 * Every branch below is an adversarial test in the suite.
 *
 * The checks are ordered so that a wrong guess reveals as little as possible:
 * a token that does not exist and a token belonging to someone else both look
 * the same to an attacker until sender binding has already passed.
 */
export function evaluateConfirmation(input: {
  readonly token: ConfirmationToken | null;
  readonly proposal: TradeProposal | null;
  readonly proposalStatus: "prepared" | "confirmed" | "executing" | "executed" | "rejected" | "expired" | "cancelled";
  readonly senderIdHash: SenderIdHash;
  /** Recomputed from the stored proposal at confirmation time, never trusted from input. */
  readonly currentProposalHash: string;
  readonly now: Instant;
}): Result<Passed, Refusal> {
  if (input.token === null) {
    return refuse("TOKEN_NOT_FOUND", "That confirmation code does not match anything Telt issued.");
  }
  const token = input.token;

  if (token.senderIdHash !== input.senderIdHash) {
    return refuse("TOKEN_SENDER_MISMATCH", "That confirmation code was not issued to this number.");
  }
  if (token.status === "revoked") {
    return refuse("TOKEN_REVOKED", "That confirmation code was cancelled.");
  }
  if (token.status === "consumed" || token.consumedAt !== null) {
    return refuse(
      "TOKEN_ALREADY_CONSUMED",
      "That confirmation code has already been used. Codes work once.",
    );
  }
  if (token.status === "expired" || input.now >= token.expiresAt) {
    return refuse(
      "TOKEN_EXPIRED",
      "That confirmation code has expired. Ask for a fresh proposal.",
      { expiredSecondsAgo: Math.max(0, Math.round(secondsBetween(token.expiresAt, input.now))) },
    );
  }

  if (input.proposal === null) {
    return refuse("TOKEN_PROPOSAL_MISMATCH", "The trade behind that code no longer exists.");
  }
  if (input.proposal.id !== token.proposalId) {
    return refuse("TOKEN_PROPOSAL_MISMATCH", "That code belongs to a different trade.");
  }

  // The hash comparison is what makes the code mean one exact order. If any
  // number in the proposal changed after the code was issued, the code is dead.
  if (input.currentProposalHash !== token.proposalHash) {
    return refuse(
      "PROPOSAL_MUTATED_AFTER_ISSUE",
      "The trade changed after that code was issued, so the code no longer applies. Ask for a fresh proposal.",
    );
  }

  if (input.proposalStatus === "executed") {
    return refuse("PROPOSAL_ALREADY_EXECUTED", "That trade has already been placed.");
  }
  if (input.proposalStatus === "executing") {
    return refuse("PROPOSAL_ALREADY_EXECUTED", "That trade is already being placed.");
  }
  if (input.proposalStatus === "cancelled" || input.proposalStatus === "rejected") {
    return refuse("TOKEN_REVOKED", "That trade was cancelled.");
  }
  if (input.proposalStatus === "expired" || input.now >= input.proposal.expiresAt) {
    return refuse(
      "PROPOSAL_EXPIRED",
      "That trade proposal expired. The price behind it is no longer current.",
    );
  }

  return ok(PASSED);
}

// ---------------------------------------------------------------------------
// Gate 8: may this order actually be sent
// ---------------------------------------------------------------------------

/**
 * The last thing between a confirmed proposal and a real order.
 *
 * `liveExecutionEnabled` is checked here rather than earlier on purpose. Every
 * gate above runs first even when the write gate is closed, so the fixture demo
 * exercises the complete decision path and the refusal it produces is the real
 * one, not a short circuit.
 */
export function evaluateExecution(input: {
  readonly policy: Policy;
  readonly safety: SafetyState;
  readonly existingOperation: ExecutionOperation | null;
  readonly now: Instant;
}): Result<Passed, Refusal> {
  const safety = evaluateSafety({ safety: input.safety, now: input.now, forExecution: true });
  if (!safety.ok) {
    return safety;
  }

  if (input.existingOperation !== null) {
    // The idempotency key is derived from the proposal hash, so reaching here
    // means this exact order was already sent once. Never send it again; report
    // what is known about the first attempt instead.
    return refuse(
      "DUPLICATE_IDEMPOTENCY_KEY",
      "This exact order was already submitted. Telt will report on that one rather than send it twice.",
      { status: input.existingOperation.status },
    );
  }

  if (!input.policy.trading.liveExecutionEnabled) {
    return refuse(
      "LIVE_EXECUTION_DISABLED",
      "Live trading is switched off. Everything up to this point passed, and no order was sent.",
    );
  }

  return ok(PASSED);
}
