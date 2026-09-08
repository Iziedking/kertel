/**
 * The adapter contract.
 *
 * An adapter does exactly two things: it builds the one request its recipe step
 * is allowed to make, and it turns the answer into the normalised shape the
 * planner and the model agree on. It does not decide whether to call, does not
 * hold a budget, does not retry, and never sees a private key.
 *
 * Keeping it that narrow is what makes a new provider a small, reviewable
 * change rather than a new place for money to leak out of.
 */

import type { Refusal, ProviderId, Result } from "@telt/core/domain";
import type { PaidRequest } from "@telt/x402";

import type { InstrumentIds } from "./symbols.js";

/**
 * Everything an adapter is allowed to vary its request by.
 *
 * One field, on purpose. If an adapter needs more than the instrument to build
 * its request, the extra input is coming from somewhere — a message, a model,
 * a config file — and that is the thing worth arguing about before it ships.
 */
export type AdapterContext = {
  readonly instrument: InstrumentIds;
};

/**
 * The size-bounded facts extracted from a provider's answer.
 *
 * This is the only shape the model is ever shown. Raw payloads stay out of the
 * prompt: they are large, they are attacker-influenced on some providers, and
 * the model has no business reading a field nobody normalised.
 *
 * Price observations must carry `priceUsd` as a plain decimal string, because
 * the planner compares prices across providers and cannot cope with each one
 * keeping its own field name and units.
 */
export type Normalized = Readonly<Record<string, unknown>>;

export type ProviderAdapter = {
  readonly provider: ProviderId;
  /** The recipe step this adapter serves, for example `coingecko.price`. */
  readonly stepId: string;
  readonly capability: string;
  readonly endpointId: string;
  /**
   * False for the free venue read, which never touches the payment client.
   * A free adapter that is quietly switched to paid is a budget change, so it
   * is stated here rather than inferred from a status code at runtime.
   */
  readonly paid: boolean;

  /** Builds the single request this step may make, from the closed id table. */
  buildRequest(context: AdapterContext): Result<PaidRequest, Refusal>;

  /**
   * Extracts the facts, or returns null.
   *
   * Null means "this answer is not something Telt can use" and becomes an
   * `invalid` observation. Adapters must not throw: a normaliser that throws
   * mid-run after a payment has settled turns a paid call into a crash.
   */
  normalize(body: unknown, context: AdapterContext): Normalized | null;
};
