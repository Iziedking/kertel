/**
 * The confirmation spine: propose, confirm, cancel, reconcile.
 *
 * Everything here exists to make one sentence true — *no order is placed that
 * the owner did not agree to, in exactly the form they saw it.* The mechanics
 * that enforce it:
 *
 * - the proposal is **hashed when it is shown**, and re-hashed when it is
 *   confirmed. If any number moved in between, the code no longer matches and
 *   the confirmation is refused rather than executed against different figures;
 * - the confirmation code is **bound to that hash**, so a code cannot be
 *   replayed onto a different proposal;
 * - consuming the code is a **conditional UPDATE**, so two confirmations racing
 *   produce exactly one execution and one "already used";
 * - the operation row is **unique on an idempotency key derived from the
 *   proposal hash**, so even a duplicate that survived all of the above cannot
 *   reach the exchange twice;
 * - and the live write gate is checked **after full policy evaluation but before
 *   the code is spent**, so a dry run exercises every other gate and still
 *   leaves the code usable. A rehearsal that costs more than the real thing is
 *   a rehearsal nobody does.
 */

import * as fp from "@telt/core/money";
import type { FixedPoint } from "@telt/core/money";
import { addSeconds, instant, ok, refuse } from "@telt/core/domain";
import type {
  AccountSnapshot,
  ConfirmationToken,
  ExecutionOperation,
  Instant,
  MarketSnapshot,
  OperationId,
  ProposalId,
  Refusal,
  Result,
  SenderIdHash,
  SymbolFilters,
  Symbol_,
  TradeProposal,
} from "@telt/core/domain";
import { evaluateConfirmation, evaluateExecution, evaluateProposal } from "@telt/core/policy";
import type { Policy } from "@telt/core/policy";
import {
  hashConfirmationCode,
  issueConfirmationToken,
  normalizeConfirmationCode,
} from "@telt/core/confirmation";
import { hashProposal, idempotencyKeyFor } from "@telt/core/proposals";
import { DEFAULT_FEE_BPS, sizeFromNotional, slippageBound } from "@telt/core/proposals";
import { renderProposal, renderRefusalReceipt } from "@telt/core/receipts";

import { clientOrderIdFrom } from "./infra/binance.js";
import type { BinanceClient } from "./infra/binance.js";
import type { Store } from "./infra/store.js";
import type { OperationRow, ProposalRow } from "./infra/trade-store.js";

export type TradingDeps = {
  readonly policy: Policy;
  readonly mode: "fixture" | "live";
  readonly store: Store;
  readonly binance: BinanceClient;
  readonly hash: (input: string) => string;
  readonly random: (count: number) => Uint8Array;
  readonly now: () => Instant;
  readonly newId: (prefix: string) => string;
  readonly ownerHash: SenderIdHash | null;
};

export type TradeOutcome = {
  readonly ok: boolean;
  readonly body: string;
  readonly refusalCode: string | null;
};

function refusalOf(deps: TradingDeps, refusal: Refusal, symbol: Symbol_ | null): TradeOutcome {
  return {
    ok: false,
    refusalCode: refusal.code,
    body: renderRefusalReceipt({
      refusal,
      symbol,
      mode: deps.mode,
      spent: fp.parse("0.00"),
      skipped: [],
      now: deps.now(),
    }),
  };
}

function proposalFromRow(row: ProposalRow): TradeProposal {
  return {
    id: row.id as ProposalId,
    researchRunId: null,
    senderIdHash: row.senderHash as SenderIdHash,
    symbol: row.symbol as Symbol_,
    side: row.side as TradeProposal["side"],
    orderType: row.orderType as TradeProposal["orderType"],
    quantity: fp.parse(row.quantity),
    limitPrice: null,
    referencePrice: fp.parse(row.referencePrice),
    estimatedNotional: fp.parse(row.estimatedNotional),
    estimatedFee: fp.parse(row.estimatedFee),
    maxSlippageBps: row.maxSlippageBps,
    evidenceDigest: row.evidenceDigest,
    policyVersion: row.policyVersion,
    mode: row.mode as TradeProposal["mode"],
    createdAt: row.createdAt as Instant,
    expiresAt: row.expiresAt as Instant,
  };
}

function operationFromRow(row: OperationRow): ExecutionOperation {
  return {
    id: row.id as OperationId,
    proposalId: row.proposalId as ProposalId,
    idempotencyKey: row.idempotencyKey,
    exchangeOrderRef: row.exchangeOrderRef,
    status: row.status as ExecutionOperation["status"],
    requestHash: row.idempotencyKey,
    responseHash: null,
    filledQuantity: fp.parse(row.filledQuantity),
    averagePrice: row.averagePrice === null ? null : fp.parse(row.averagePrice),
    feePaid: row.feePaid === null ? null : fp.parse(row.feePaid),
    submittedAt: row.submittedAt as Instant | null,
    reconciledAt: row.reconciledAt as Instant | null,
    failureCode: row.failureCode,
  };
}

/**
 * Everything the proposal gate needs from the outside world, gathered at once.
 *
 * Deliberately fetched together and timestamped, so the price the order is
 * sized from, the rules it is checked against and the balance it is paid from
 * all describe the same moment. Gathering them one at a time invites a proposal
 * built from a price that was true and a balance that no longer is.
 */
async function marketContext(
  deps: TradingDeps,
  symbol: Symbol_,
): Promise<
  Result<
    {
      readonly filters: SymbolFilters;
      readonly market: MarketSnapshot;
      readonly account: AccountSnapshot;
    },
    Refusal
  >
> {
  const [filters, market] = await Promise.all([
    deps.binance.filters(symbol),
    deps.binance.market(symbol),
  ]);
  if (!filters.ok) return filters;
  if (!market.ok) return market;

  if (!deps.binance.credentialed) {
    return refuse(
      "EXECUTION_ADAPTER_UNAVAILABLE",
      "Telt has no exchange credentials, so it cannot read your balance and will not propose an order it cannot check you can afford.",
    );
  }
  const account = await deps.binance.account();
  if (!account.ok) return account;

  return ok({ filters: filters.value, market: market.value, account: account.value });
}

export async function propose(
  deps: TradingDeps,
  input: { readonly symbol: string; readonly side: "BUY" | "SELL"; readonly notional: string },
): Promise<TradeOutcome> {
  const symbol = input.symbol.trim().toUpperCase() as Symbol_;

  if (deps.ownerHash === null) {
    return refusalOf(
      deps,
      refuse("SENDER_NOT_ALLOWED", "Telt has no configured owner, so it will not prepare an order.")
        .error,
      symbol,
    );
  }

  const safety = deps.store.safetyState();
  if (safety.killSwitchEngaged) {
    return refusalOf(
      deps,
      refuse(
        "KILL_SWITCH_ENGAGED",
        `Telt is stopped: ${safety.killSwitchReason ?? "no reason recorded"}.`,
      ).error,
      symbol,
    );
  }
  if (safety.unreconciledOperations.length > 0) {
    // Open exposure Telt cannot see is exposure it cannot cap.
    return refusalOf(
      deps,
      refuse(
        "PENDING_OPERATION_UNRECONCILED",
        `An earlier order has not been resolved yet (${safety.unreconciledOperations.join(", ")}). Reconcile it before starting another.`,
      ).error,
      symbol,
    );
  }

  if (!/^\d+(\.\d+)?$/.test(input.notional.trim())) {
    return refusalOf(
      deps,
      refuse("AMOUNT_NOT_UNDERSTOOD", `Telt could not read ${JSON.stringify(input.notional)} as an amount.`)
        .error,
      symbol,
    );
  }
  const requested = fp.parse(input.notional.trim());

  const context = await marketContext(deps, symbol);
  if (!context.ok) return refusalOf(deps, context.error, symbol);
  const { filters, market, account } = context.value;

  // Read the clock after the exchange, never before.
  //
  // The freshness rule compares the snapshot's `observedAt` against this, and
  // refuses a negative age as firmly as an old one, because a price stamped in
  // the future means something is wrong with the clock or the feed. On the
  // Agent OS rail each read is a network hop — filters alone measured 3.1s
  // against the live server — so a `now` taken at the top of this function is
  // several seconds older than the snapshot it is about to judge, and every
  // proposal refuses as stale. A frozen test clock hides this completely:
  // fixture reads cost no time, so the two stamps come out equal.
  //
  // This is also the honest stamp for the proposal itself: it was made now,
  // not when the request arrived.
  const now = deps.now();

  // A buy fills at the ask, so that is the price it is sized from.
  const sized = sizeFromNotional({
    notional: requested,
    price: market.bestAsk,
    filters,
    feeBps: DEFAULT_FEE_BPS,
  });
  if (!sized.ok) return refusalOf(deps, sized.error, symbol);

  const candidate = {
    symbol,
    side: input.side,
    orderType: "MARKET" as const,
    quantity: sized.value.quantity,
    referencePrice: market.bestAsk,
    estimatedNotional: sized.value.estimatedNotional,
    estimatedFee: sized.value.estimatedFee,
    maxSlippageBps: deps.policy.trading.maxSlippageBps,
  };

  const verdict = evaluateProposal({
    policy: deps.policy,
    candidate,
    thesis: null,
    filters,
    market,
    account,
    realisedLossToday: fp.parse("0.00"),
    openExposure: fp.parse("0.00"),
    now,
  });
  if (!verdict.ok) return refusalOf(deps, verdict.error, symbol);

  const proposalId = deps.newId("prop") as ProposalId;
  const proposal: TradeProposal = {
    id: proposalId,
    researchRunId: null,
    senderIdHash: deps.ownerHash,
    symbol,
    side: input.side,
    orderType: "MARKET",
    quantity: candidate.quantity,
    limitPrice: null,
    referencePrice: candidate.referencePrice,
    estimatedNotional: candidate.estimatedNotional,
    estimatedFee: candidate.estimatedFee,
    maxSlippageBps: candidate.maxSlippageBps,
    evidenceDigest: "none",
    policyVersion: deps.policy.version,
    mode: deps.mode,
    createdAt: now,
    expiresAt: addSeconds(now, deps.policy.trading.proposalTtl),
  };

  const proposalHash = hashProposal(proposal, deps.hash);
  const issued = issueConfirmationToken({
    proposalId,
    proposalHash,
    senderIdHash: deps.ownerHash,
    now,
    ttl: deps.policy.trading.proposalTtl,
    random: deps.random,
    hash: deps.hash,
  });

  deps.store.trades.saveProposal({
    id: proposalId,
    senderHash: deps.ownerHash,
    symbol,
    side: proposal.side,
    orderType: proposal.orderType,
    quantity: fp.format(proposal.quantity),
    referencePrice: fp.format(proposal.referencePrice),
    estimatedNotional: fp.format(proposal.estimatedNotional),
    estimatedFee: fp.format(proposal.estimatedFee),
    maxSlippageBps: proposal.maxSlippageBps,
    evidenceDigest: proposal.evidenceDigest,
    policyVersion: proposal.policyVersion,
    mode: proposal.mode,
    proposalHash,
    createdAt: proposal.createdAt,
    expiresAt: proposal.expiresAt,
    status: "prepared",
  });
  deps.store.trades.saveToken({
    tokenHash: issued.token.tokenHash,
    proposalId,
    proposalHash,
    senderHash: deps.ownerHash,
    issuedAt: issued.token.issuedAt,
    expiresAt: issued.token.expiresAt,
    consumedAt: null,
    status: "active",
  });

  const worst = slippageBound({
    referencePrice: proposal.referencePrice,
    side: proposal.side,
    maxSlippageBps: proposal.maxSlippageBps,
  });

  return {
    ok: true,
    refusalCode: null,
    body: renderProposal({
      symbol,
      side: proposal.side,
      orderType: proposal.orderType,
      mode: deps.mode,
      quantity: proposal.quantity,
      baseAsset: filters.baseAsset,
      quoteAsset: filters.quoteAsset,
      referencePrice: proposal.referencePrice,
      estimatedNotional: proposal.estimatedNotional,
      estimatedFee: proposal.estimatedFee,
      requestedNotional: sized.value.requestedNotional,
      worstPrice: worst,
      maxSlippageBps: proposal.maxSlippageBps,
      code: issued.code,
      expiresAt: proposal.expiresAt,
      evidenceSummary: [
        `Binance book: bid ${fp.format(fp.trim(market.bestBid, 2))} / ask ${fp.format(fp.trim(market.bestAsk, 2))}`,
        market.averagePrice === null
          ? `No venue average available; the exchange minimum was checked against the last price only.`
          : `Venue ${String(filters.notionalAveragePriceMinutes)}-minute average: ${fp.format(fp.trim(market.averagePrice, 2))}`,
      ],
      now,
    }),
  };
}

export async function confirm(deps: TradingDeps, code: string): Promise<TradeOutcome> {
  const now = deps.now();

  if (deps.ownerHash === null) {
    return refusalOf(
      deps,
      refuse("SENDER_NOT_ALLOWED", "Telt has no configured owner, so it will not execute.").error,
      null,
    );
  }

  const normalized = normalizeConfirmationCode(code);
  if (normalized === null) {
    return refusalOf(
      deps,
      refuse("TOKEN_NOT_FOUND", `${JSON.stringify(code)} is not a Telt confirmation code.`).error,
      null,
    );
  }

  const row = deps.store.trades.latestPreparedProposal(deps.ownerHash);
  if (row === null) {
    return refusalOf(
      deps,
      refuse("TOKEN_NOT_FOUND", "There is no order waiting for confirmation.").error,
      null,
    );
  }

  const proposal = proposalFromRow(row);
  const symbol = proposal.symbol;

  // Recomputed from the stored proposal, never trusted from the row. If any
  // stored number was altered, the hash moves and the code stops matching.
  const currentHash = hashProposal(proposal, deps.hash);
  const tokenHash = hashConfirmationCode({
    code: normalized,
    proposalHash: currentHash,
    hash: deps.hash,
  });

  const tokenRow = deps.store.trades.findToken(tokenHash);
  const token: ConfirmationToken | null =
    tokenRow === null
      ? null
      : {
          tokenHash: tokenRow.tokenHash,
          proposalId: tokenRow.proposalId as ProposalId,
          proposalHash: tokenRow.proposalHash,
          senderIdHash: tokenRow.senderHash as SenderIdHash,
          issuedAt: tokenRow.issuedAt as Instant,
          expiresAt: tokenRow.expiresAt as Instant,
          consumedAt: tokenRow.consumedAt as Instant | null,
          status: tokenRow.status as ConfirmationToken["status"],
        };

  const verdict = evaluateConfirmation({
    token,
    proposal,
    proposalStatus: row.status as "prepared",
    senderIdHash: deps.ownerHash,
    currentProposalHash: currentHash,
    now,
  });
  if (!verdict.ok) return refusalOf(deps, verdict.error, symbol);

  const idempotencyKey = idempotencyKeyFor(proposal, deps.hash);
  const existing = deps.store.trades.findOperationByKey(idempotencyKey);
  const executionVerdict = evaluateExecution({
    policy: deps.policy,
    safety: deps.store.safetyState(),
    existingOperation: existing === null ? null : operationFromRow(existing),
    now,
  });
  if (!executionVerdict.ok) {
    // `evaluateExecution` owns the policy flag. This adds the mode: an operator
    // who set TELT_LIVE_EXECUTION=true while still in fixture mode has the
    // flag on and no live rail behind it, and the refusal should say which.
    return refusalOf(deps, executionVerdict.error, symbol);
  }
  if (deps.mode !== "live") {
    // Deliberately before the code is consumed. A dry run that burned the code
    // would make the safe rehearsal more expensive than the real thing.
    return refusalOf(
      deps,
      refuse(
        "LIVE_EXECUTION_DISABLED",
        `Everything checked out and Telt stopped because it is in fixture mode. It would have ${proposal.side === "BUY" ? "bought" : "sold"} ${fp.format(proposal.quantity)} ${symbol} for about ${fp.format(proposal.estimatedNotional)}. Set TELT_MODE=live to allow it. The code is still valid.`,
      ).error,
      symbol,
    );
  }

  // The code is spent here, before anything is sent. A code that survives a
  // failed send is a code somebody can use again on a changed market.
  if (!deps.store.trades.consumeToken(tokenHash, now)) {
    return refusalOf(
      deps,
      refuse("TOKEN_ALREADY_CONSUMED", "That code has already been used.").error,
      symbol,
    );
  }

  const operationId = deps.newId("op") as OperationId;
  const clientOrderId = clientOrderIdFrom(idempotencyKey);
  const claimed = deps.store.trades.claimOperation({
    id: operationId,
    proposalId: proposal.id,
    idempotencyKey,
    clientOrderId,
    exchangeOrderRef: null,
    status: "planned",
    filledQuantity: "0",
    averagePrice: null,
    feePaid: null,
    submittedAt: null,
    reconciledAt: null,
    failureCode: null,
  });
  if (!claimed) {
    return refusalOf(
      deps,
      refuse("DUPLICATE_IDEMPOTENCY_KEY", "That order has already been submitted once.").error,
      symbol,
    );
  }

  deps.store.trades.setProposalStatus(proposal.id, "executing");

  const placed = await deps.binance.placeMarketOrder({
    symbol,
    side: proposal.side,
    quantity: proposal.quantity,
    clientOrderId,
  });

  if (!placed.ok) {
    const unknown = placed.error.code === "EXECUTION_RESULT_UNKNOWN";
    deps.store.trades.updateOperation({
      id: operationId,
      proposalId: proposal.id,
      idempotencyKey,
      clientOrderId,
      exchangeOrderRef: null,
      status: unknown ? "unknown" : "rejected",
      filledQuantity: "0",
      averagePrice: null,
      feePaid: null,
      submittedAt: now,
      reconciledAt: unknown ? null : now,
      failureCode: placed.error.code,
    });
    deps.store.trades.setProposalStatus(proposal.id, unknown ? "executing" : "rejected");

    if (unknown) {
      deps.store.engageKillSwitch(
        `an order was sent and never confirmed (${operationId}); reconcile it before trading again`,
        now,
      );
    }
    return refusalOf(deps, placed.error, symbol);
  }

  const order = placed.value;
  deps.store.trades.updateOperation({
    id: operationId,
    proposalId: proposal.id,
    idempotencyKey,
    clientOrderId,
    exchangeOrderRef: order.exchangeOrderRef,
    status: order.status,
    filledQuantity: fp.format(order.filledQuantity),
    averagePrice: order.averagePrice === null ? null : fp.format(order.averagePrice),
    feePaid: order.feePaid === null ? null : fp.format(order.feePaid),
    submittedAt: now,
    reconciledAt: order.status === "filled" ? now : null,
    failureCode: null,
  });
  deps.store.trades.setProposalStatus(
    proposal.id,
    order.status === "filled" ? "executed" : "executing",
  );

  const lines: string[] = [];
  lines.push(`${proposal.side} ${symbol}: ${order.status}`);
  lines.push("");
  lines.push(`Filled:      ${fp.format(order.filledQuantity)} ${symbol.replace("USDT", "")}`);
  if (order.averagePrice !== null) {
    lines.push(`Avg price:   ${fp.format(order.averagePrice)}`);
    const slipped = fp.subtract(order.averagePrice, proposal.referencePrice);
    lines.push(`vs proposal: ${fp.format(slipped)}`);
  }
  if (order.feePaid !== null) {
    lines.push(`Fee:         ${fp.format(order.feePaid)}`);
  }
  lines.push(`Order ref:   ${order.exchangeOrderRef}`);
  lines.push("");
  lines.push(`Telt ref:  ${operationId}`);

  return { ok: true, refusalCode: null, body: lines.join("\n") };
}

export function cancel(deps: TradingDeps): TradeOutcome {
  const now = deps.now();
  if (deps.ownerHash === null) {
    return refusalOf(
      deps,
      refuse("SENDER_NOT_ALLOWED", "Telt has no configured owner.").error,
      null,
    );
  }

  const row = deps.store.trades.latestPreparedProposal(deps.ownerHash);
  if (row === null) {
    return { ok: true, refusalCode: null, body: "There is no order waiting. Nothing to cancel." };
  }

  deps.store.trades.revokeTokensFor(row.id);
  deps.store.trades.setProposalStatus(row.id, "cancelled");

  return {
    ok: true,
    refusalCode: null,
    body: [
      `Cancelled: ${row.side} ${row.symbol} for ${row.estimatedNotional}.`,
      "The confirmation code for it will no longer work.",
      "",
      String(new Date(now).toISOString()),
    ].join("\n"),
  };
}

/**
 * Ask the exchange what actually happened to the orders Telt lost track of.
 *
 * This is the other half of never reporting a timeout as a failure. An order
 * whose result is unknown is looked up by the client order id Telt chose for
 * it, which is exactly why that id is derived from the proposal rather than
 * generated: it survives the process that created it.
 *
 * An operation the exchange has never heard of was never placed, and can be
 * closed. One it has heard of is recorded as it actually stands.
 */
export async function reconcile(deps: TradingDeps): Promise<string> {
  const now = deps.now();
  const pending = deps.store.trades.unreconciledOperations();
  const unresolvedPayments = deps.store.unresolvedPayments();

  if (pending.length === 0 && unresolvedPayments.length === 0) {
    return "Nothing to reconcile. No orders in flight and no unconfirmed payments.";
  }

  const lines: string[] = ["Reconciliation", ""];

  for (const operation of pending) {
    const proposal = deps.store.trades.findProposal(operation.proposalId);
    if (proposal === null) {
      lines.push(`  ${operation.id}: no proposal on record. Left open for a human.`);
      continue;
    }
    if (!deps.binance.credentialed) {
      lines.push(`  ${operation.id}: cannot check, no exchange credentials configured.`);
      continue;
    }

    const found = await deps.binance.findOrder(proposal.symbol as Symbol_, operation.clientOrderId);
    if (!found.ok) {
      lines.push(`  ${operation.id}: could not reach the exchange (${found.error.code}).`);
      continue;
    }

    if (found.value === null) {
      // The exchange never saw it. It was not placed, so the money never moved.
      deps.store.trades.updateOperation({
        ...operation,
        status: "rejected",
        reconciledAt: now,
        failureCode: "NEVER_REACHED_EXCHANGE",
      });
      deps.store.trades.setProposalStatus(operation.proposalId, "rejected");
      lines.push(`  ${operation.id}: never reached the exchange. Closed, nothing was spent.`);
      continue;
    }

    const order = found.value;
    deps.store.trades.updateOperation({
      ...operation,
      exchangeOrderRef: order.exchangeOrderRef,
      status: order.status,
      filledQuantity: fp.format(order.filledQuantity),
      averagePrice: order.averagePrice === null ? null : fp.format(order.averagePrice),
      feePaid: order.feePaid === null ? null : fp.format(order.feePaid),
      reconciledAt: order.status === "filled" || order.status === "canceled" ? now : null,
    });
    deps.store.trades.setProposalStatus(
      operation.proposalId,
      order.status === "filled" ? "executed" : "executing",
    );
    lines.push(
      `  ${operation.id}: ${order.status}, filled ${fp.format(order.filledQuantity)}${
        order.averagePrice === null ? "" : ` at ${fp.format(order.averagePrice)}`
      }.`,
    );
  }

  for (const payment of unresolvedPayments) {
    lines.push(
      `  payment ${payment.attemptId}: ${payment.provider} $${payment.chargedUsdc} on ${payment.rail ?? "unknown rail"}, signed and never confirmed.`,
    );
    lines.push(
      `    Check the payer address on the chain explorer for a transfer of that amount, then resolve it.`,
    );
  }

  const stillOpen =
    deps.store.trades.unreconciledOperations().length > 0 ||
    deps.store.unresolvedPayments().length > 0;
  lines.push("");
  lines.push(
    stillOpen
      ? "Some items are still open. Telt stays stopped until they are resolved."
      : "Everything resolved. Telt can be resumed.",
  );

  return lines.join("\n");
}

export function nowInstant(): Instant {
  return instant(Date.now());
}

export type { FixedPoint };
