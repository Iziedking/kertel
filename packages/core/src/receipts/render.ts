/**
 * What the user actually reads.
 *
 * Everything else in Kertel exists to make this message honest. A research
 * agent that answers "ETH looks bullish" has told you nothing you can check; a
 * receipt says which sources were read, what they cost, which ones were *not*
 * read and why, and what would have to be true for the conclusion to be wrong.
 *
 * Three rules shape every line below.
 *
 * 1. **The road not taken is part of the answer.** "Nansen Smart Money, not
 *    needed: two sources already agreed, saved $0.05" is the line that makes a
 *    cheap run legible. Without it a one-cent run looks lazy rather than
 *    disciplined.
 * 2. **An absence is never rendered as a zero.** A source that did not answer
 *    says so. A figure Kertel does not have is left out, not defaulted.
 * 3. **It is written for a phone.** Short lines, no tables, no markdown that
 *    WhatsApp will render as literal asterisks in the middle of a number.
 *
 * The module is pure and has no clock and no hasher of its own; both are passed
 * in, so the same inputs always produce the same bytes and a receipt can be
 * re-derived from the audit trail and compared.
 */

import * as fp from "../money/fixed-point.js";
import type { FixedPoint } from "../money/fixed-point.js";
import { formatInstant } from "../domain/time.js";
import type { Instant } from "../domain/time.js";
import type {
  EvidenceObservation,
  RunMode,
  Symbol_,
  Thesis,
} from "../domain/types.js";
import type { Refusal } from "../domain/result.js";

/** Injected so the hashing choice stays in one place across the product. */
export type Hasher = (input: string) => string;

/**
 * One payment attempt, flattened.
 *
 * Deliberately a plain shape rather than the executor's `PaymentRecord`:
 * `packages/core` has no dependencies and is not going to acquire one to print
 * a line of text.
 */
export type ReceiptPayment = {
  readonly provider: string;
  readonly chargedUsdc: FixedPoint;
  readonly rail: string | null;
  readonly facilitator: string | null;
  readonly settlementTx: string | null;
  readonly outcome: "paid" | "free" | "refused" | "unknown";
};

export type ReceiptSkipped = {
  readonly id: string;
  readonly reason: string;
  readonly savedCost: FixedPoint;
};

export type ResearchReceiptInput = {
  readonly symbol: Symbol_;
  readonly goal: "price_check" | "trade_thesis";
  readonly mode: RunMode;
  readonly observations: readonly EvidenceObservation[];
  readonly spent: FixedPoint;
  readonly skipped: readonly ReceiptSkipped[];
  readonly payments: readonly ReceiptPayment[];
  readonly because: string;
  readonly limitedByBudget: boolean;
  readonly thesis: Thesis | null;
  readonly now: Instant;
};

export type RenderedReceipt = {
  readonly body: string;
  /** Hash over the inputs that produced this, so it can be re-derived. */
  readonly provenanceDigest: string;
};

/** Provider names as a person would write them, not as an endpoint id. */
const PROVIDER_LABELS: Readonly<Record<string, string>> = Object.freeze({
  binance: "Binance",
  coingecko: "CoinGecko",
  coinmarketcap: "CoinMarketCap",
  nansen: "Nansen Smart Money",
  thegraph: "The Graph",
});

function label(provider: string): string {
  return PROVIDER_LABELS[provider] ?? provider;
}

/** `coingecko.price` reads as CoinGecko in a skipped line too. */
function labelStep(stepId: string): string {
  const provider = stepId.split(".")[0] ?? stepId;
  return label(provider);
}

function money(value: FixedPoint): string {
  return `$${fp.format(value)}`;
}

/**
 * A source line: what answered, what it said, what it cost.
 *
 * The price is shown because it is the number the whole run turns on. Anything
 * else the adapter normalised stays out: a receipt that prints every field is
 * one nobody reads.
 */
function observationLine(observation: EvidenceObservation): string {
  const name = label(observation.provider);
  const cost = fp.isZero(observation.costUsdc) ? "free" : money(observation.costUsdc);

  if (observation.status !== "valid") {
    const detail = observation.normalized["refusalDetail"];
    const why = typeof detail === "string" && detail !== "" ? ` - ${detail}` : "";
    return `  ${name}: ${observation.status}${why}`;
  }

  const price = observation.normalized["priceUsd"];
  if (typeof price === "string") {
    return `  ${name}: ${price} (${cost})`;
  }

  // A flow observation. The netflow figure is the point of having bought it.
  const netFlow = observation.normalized["netFlow24hUsd"];
  if (typeof netFlow === "string") {
    const traders = observation.normalized["traderCount"];
    const who = typeof traders === "number" ? `, ${String(traders)} wallets` : "";
    return `  ${name}: 24h net flow ${netFlow} USD${who} (${cost})`;
  }
  if (observation.normalized["tokenFound"] === false) {
    return `  ${name}: no notable inflow found (${cost})`;
  }

  return `  ${name}: answered (${cost})`;
}

/**
 * The provenance digest.
 *
 * Over the evidence ids, their payload hashes and statuses, plus the amount
 * spent — not over the rendered text, so rewording a line does not invalidate
 * the trail, while swapping the evidence under it does.
 */
function digestOf(input: ResearchReceiptInput, hash: Hasher): string {
  const parts = [
    `symbol=${input.symbol}`,
    `goal=${input.goal}`,
    `mode=${input.mode}`,
    `spent=${fp.format(input.spent)}`,
    ...[...input.observations]
      .map(
        (observation) =>
          `${observation.id}:${observation.status}:${observation.rawPayloadHash ?? "none"}:${fp.format(observation.costUsdc)}`,
      )
      .sort(),
    `thesis=${input.thesis === null ? "none" : input.thesis.recommendation}`,
  ];
  return hash(parts.join("\n"));
}

export function renderResearchReceipt(
  input: ResearchReceiptInput,
  hash: Hasher,
): RenderedReceipt {
  const lines: string[] = [];

  const heading =
    input.goal === "price_check"
      ? `Price check: ${input.symbol}`
      : `Research: ${input.symbol}`;
  lines.push(heading);

  if (input.mode === "fixture") {
    // Never let a demo be mistaken for the real thing.
    lines.push("FIXTURE MODE - saved data, no payments, no orders.");
  }
  lines.push("");

  lines.push("Sources read:");
  if (input.observations.length === 0) {
    lines.push("  none");
  } else {
    for (const observation of input.observations) {
      lines.push(observationLine(observation));
    }
  }
  lines.push("");

  const notRead = input.skipped.filter((entry) => entry.reason !== "");
  if (notRead.length > 0) {
    lines.push("Not read:");
    for (const entry of notRead) {
      const saved = fp.isZero(entry.savedCost) ? "" : `, saved ${money(entry.savedCost)}`;
      lines.push(`  ${labelStep(entry.id)}: ${entry.reason}${saved}`);
    }
    lines.push("");
  }

  if (input.thesis !== null) {
    lines.push(`Conclusion: ${input.thesis.recommendation.replace(/_/g, " ").toLowerCase()}`);
    lines.push(input.thesis.summary);
    if (input.thesis.invalidatedBy.length > 0) {
      lines.push("");
      lines.push("This would be wrong if:");
      for (const condition of input.thesis.invalidatedBy) {
        lines.push(`  - ${condition}`);
      }
    }
    lines.push("");
  }

  // A price nothing corroborates is the single most important thing on this
  // receipt, and it was previously only in a field nobody printed.
  if (input.because.startsWith("UNCORROBORATED")) {
    lines.push("WARNING: only the exchange's own price is available for this");
    lines.push("symbol. No independent source exists to check it against, so");
    lines.push("nothing here rules out a bad print or a thin market.");
    lines.push("");
  }

  if (input.limitedByBudget) {
    lines.push("Note: the research budget stopped this run early, so the");
    lines.push("conclusion rests on price alone.");
    lines.push("");
  }

  lines.push(`Cost: ${money(input.spent)}`);
  for (const payment of input.payments) {
    if (payment.outcome === "paid" && payment.rail !== null) {
      const via = payment.facilitator === null ? payment.rail : payment.facilitator;
      lines.push(`  ${label(payment.provider)} ${money(payment.chargedUsdc)} via ${via}`);
    } else if (payment.outcome === "unknown") {
      lines.push(
        `  ${label(payment.provider)} ${money(payment.chargedUsdc)} - payment sent, no confirmation`,
      );
    }
  }

  const totalSaved = input.skipped.reduce(
    (total, entry) => fp.add(total, entry.savedCost),
    fp.parse("0.00"),
  );
  if (fp.isPositive(totalSaved)) {
    lines.push(`Not spent: ${money(totalSaved)}`);
  }

  lines.push("");
  lines.push(formatInstant(input.now));

  return {
    body: lines.join("\n").trimEnd(),
    provenanceDigest: digestOf(input, hash),
  };
}

/**
 * A refusal, written so the person holding the phone knows what to do next.
 *
 * The code is included because it is stable and searchable, and because a user
 * quoting `EVIDENCE_CONFLICT_UNRESOLVED` in a bug report is worth more than one
 * paraphrasing what the bot said. The spend is always shown, including when it
 * is zero: refusing without spending is the product working, and it should be
 * visible.
 */
export function renderRefusalReceipt(input: {
  readonly refusal: Refusal;
  readonly symbol: Symbol_ | null;
  readonly mode: RunMode;
  readonly spent: FixedPoint;
  readonly skipped: readonly ReceiptSkipped[];
  readonly now: Instant;
}): string {
  const lines: string[] = [];

  lines.push(input.symbol === null ? "Refused" : `Refused: ${input.symbol}`);
  if (input.mode === "fixture") {
    lines.push("FIXTURE MODE - saved data, no payments, no orders.");
  }
  lines.push("");
  lines.push(input.refusal.detail);
  lines.push("");

  const notRead = input.skipped.filter((entry) => entry.reason !== "");
  if (notRead.length > 0) {
    lines.push("Not read:");
    for (const entry of notRead) {
      const saved = fp.isZero(entry.savedCost) ? "" : `, saved ${money(entry.savedCost)}`;
      lines.push(`  ${labelStep(entry.id)}: ${entry.reason}${saved}`);
    }
    lines.push("");
  }

  lines.push(`Spent: ${money(input.spent)}`);
  lines.push(`Code: ${input.refusal.code}`);
  lines.push("");
  lines.push(formatInstant(input.now));

  return lines.join("\n").trimEnd();
}

/**
 * The message a user says yes to.
 *
 * This is the most consequential string in the product: everything above it is
 * research, everything after it is money. Four rules shape it.
 *
 * 1. **The numbers shown are the numbers that will be sent.** Not the amount
 *    the user asked for. Step-size rounding means "buy 20 of ETH" becomes an
 *    order for 19.93, and showing 20.00 would mean the figure confirmed is not
 *    the figure executed.
 * 2. **The cost of being wrong is stated, not implied.** The worst fill the
 *    slippage allowance permits appears next to the estimate.
 * 3. **The code is bound to this proposal and expires.** Both facts are on
 *    screen, because a user who does not know a code expires will try it later
 *    and be confused by the refusal.
 * 4. **Cancelling is as easy as confirming.** A confirmation flow that only
 *    documents the yes is a flow designed to collect yeses.
 */
export type ProposalReceiptInput = {
  readonly symbol: Symbol_;
  readonly side: "BUY" | "SELL";
  readonly orderType: "MARKET" | "LIMIT";
  readonly mode: RunMode;
  readonly quantity: FixedPoint;
  readonly baseAsset: string;
  readonly quoteAsset: string;
  readonly referencePrice: FixedPoint;
  readonly estimatedNotional: FixedPoint;
  readonly estimatedFee: FixedPoint;
  /** What the user asked to spend, before step-size rounding took a bite. */
  readonly requestedNotional: FixedPoint;
  readonly worstPrice: FixedPoint;
  readonly maxSlippageBps: number;
  readonly code: string;
  readonly expiresAt: Instant;
  readonly evidenceSummary: readonly string[];
  readonly now: Instant;
};

export function renderProposal(input: ProposalReceiptInput): string {
  const lines: string[] = [];
  const ttlSeconds = Math.max(0, Math.round((input.expiresAt - input.now) / 1000));

  lines.push(`${input.side} ${input.symbol}`);
  if (input.mode === "fixture") {
    lines.push("FIXTURE MODE - nothing will be sent to the exchange.");
  }
  lines.push("");

  // Binance carries eight decimals on everything. Past the cents those are the
  // exchange's storage precision rather than money, and printing them reads as
  // false precision on a number someone is about to agree to. The base amount
  // keeps whatever the lot step needs; the quote amounts keep at least cents.
  lines.push(`Quantity:   ${fp.format(fp.trim(input.quantity))} ${input.baseAsset}`);
  lines.push(`Price now:  ${fp.format(fp.trim(input.referencePrice, 2))} ${input.quoteAsset}`);
  lines.push(`Cost:       ${fp.format(fp.trim(input.estimatedNotional, 2))} ${input.quoteAsset}`);
  lines.push(`Fee (est):  ${fp.format(fp.trim(input.estimatedFee, 2))} ${input.quoteAsset}`);

  // Rounding down to the exchange step is invisible unless it is said.
  if (fp.greaterThan(input.requestedNotional, input.estimatedNotional)) {
    const shortfall = fp.subtract(input.requestedNotional, input.estimatedNotional);
    lines.push(
      `            (you asked for ${fp.format(fp.trim(input.requestedNotional, 2))}; the exchange step size leaves ${fp.format(fp.trim(shortfall, 2))} unspent)`,
    );
  }
  lines.push("");

  lines.push(
    `Worst fill Kertel will accept: ${fp.format(fp.trim(input.worstPrice, 2))} (${String(input.maxSlippageBps)} bps)`,
  );
  lines.push("");

  if (input.evidenceSummary.length > 0) {
    lines.push("Based on:");
    for (const line of input.evidenceSummary) {
      lines.push(`  ${line}`);
    }
    lines.push("");
  }

  lines.push(`Reply  confirm ${input.code}  to place this order.`);
  lines.push(`Reply  cancel  to drop it.`);
  lines.push(`The code works once, for this order only, for ${String(ttlSeconds)} seconds.`);
  lines.push("");
  lines.push(formatInstant(input.now));

  return lines.join("\n").trimEnd();
}
