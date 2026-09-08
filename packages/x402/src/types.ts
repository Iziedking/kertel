/**
 * The x402 seam.
 *
 * Everything above this interface works in quotes, approvals and receipts and
 * never touches a wallet, a header, or a chain. Swapping the live client for
 * the fixture one is the whole of what fixture mode does to the research path,
 * which is why the mock stays honest: it is the same interface, not a shortcut
 * around it.
 */

import type { FixedPoint } from "@telt/core/money";
import type { Refusal, Result } from "@telt/core/domain";

import type { RailId } from "./constants.js";

/**
 * How Telt hashes a raw payload.
 *
 * Injected rather than imported so the algorithm is chosen once, by the
 * composition root, and `packages/core` stays free of a crypto dependency.
 */
export type Hasher = (input: string) => string;

/** A code-built request. Never a model-supplied URL. */
export type PaidRequest = {
  /** Which provider this belongs to. Selects the pinned recipient. */
  readonly providerId: string;
  /** Stable identifier for the endpoint template, for example `coingecko:simple/price`. */
  readonly endpointId: string;
  readonly url: string;
  readonly method: "GET" | "POST";
  readonly body?: unknown;
  readonly timeoutMs?: number;
};

/**
 * What a provider says a call will cost, read from its live challenge.
 *
 * Quoting is free and unauthenticated, which is what makes "check the price
 * before you agree to it" a real step rather than a formality.
 */
export type X402Quote = {
  readonly providerId: string;
  readonly endpointId: string;
  readonly url: string;
  /** Which rail was chosen. Shown in the receipt so the user sees what moved. */
  readonly rail: RailId;
  readonly assetName: string;
  /** Who settles it on chain, for example "Binance B402". */
  readonly facilitator: string;
  readonly network: string;
  readonly asset: string;
  readonly amount: FixedPoint;
  readonly payTo: string;
  readonly maxTimeoutSeconds: number;
  /** Where the challenge was found. Recorded because both shapes are live. */
  readonly challengeSource: "header" | "body";
  /** How many options the provider offered, and how many Telt would accept. */
  readonly offeredOptions: number;
  readonly acceptableOptions: number;
};

/**
 * A quote the policy engine has approved.
 *
 * Carrying approval as a distinct type means a payment cannot be made from a
 * bare quote by accident: the function that spends money will not take one.
 */
export type ApprovedQuote = {
  readonly quote: X402Quote;
  /** The ceiling policy approved. The live challenge is re-checked against it. */
  readonly approvedAmount: FixedPoint;
  readonly approvedAt: number;
};

export type SettlementInfo = {
  readonly success: boolean;
  readonly transaction: string | null;
  readonly payer: string | null;
  readonly network: string | null;
};

export type PaidResponse = {
  readonly quote: X402Quote;
  readonly status: number;
  readonly body: unknown;
  /** Hash of the raw body, so a receipt can be tied back to exactly what arrived. */
  readonly bodyHash: string;
  readonly amountPaid: FixedPoint;
  /**
   * Null when the provider returned data without reporting settlement. The
   * payment still happened; only the confirmation is missing, and the receipt
   * says so rather than inventing a transaction hash.
   */
  readonly settlement: SettlementInfo | null;
};

/**
 * A free probe of a resource that turned out not to need payment.
 *
 * Worth its own state: a provider that stops charging is not the same event as
 * a provider that fails, and treating the two alike hides a real change.
 */
export type UnpaidResponse = {
  readonly status: number;
  readonly body: unknown;
  readonly bodyHash: string;
};

export type QuoteOutcome =
  | { readonly kind: "payment_required"; readonly quote: X402Quote }
  | { readonly kind: "free"; readonly response: UnpaidResponse };

export interface X402Client {
  /** Whether a wallet is present. False means every paid call refuses early. */
  readonly walletConfigured: boolean;
  /** The paying address, for the health report. Never a key. */
  readonly payerAddress: string | null;

  /** Free. Reads the live challenge and validates it against the pins. */
  quote(request: PaidRequest): Promise<Result<QuoteOutcome, Refusal>>;

  /** Signs and retries. Refuses if the live challenge no longer matches the approval. */
  pay(request: PaidRequest, approved: ApprovedQuote): Promise<Result<PaidResponse, Refusal>>;
}
