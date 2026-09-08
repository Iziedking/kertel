/**
 * The Graph, tier 3. Present, wired, and deliberately unable to fire.
 *
 * Pool-level liquidity and volume would be genuinely useful evidence, and the
 * payment side is ready: the pin is set, the rail is chosen, the live probe
 * prices it at a cent. What is missing is the part nobody can bluff — a
 * specific subgraph id for a specific pair, and a query written against that
 * subgraph's schema and checked against a real answer.
 *
 * Until somebody does that work, `SUBGRAPH_COVERAGE` in `packages/core` stays
 * empty, the planner never selects this step, and this adapter refuses if it is
 * called anyway. That is the honest state of the capability, and the receipt
 * says "no published subgraph covers this pair" rather than implying onchain
 * evidence that was never fetched.
 *
 * Wiring it up is a three-part edit with nothing hidden in it: add the pair to
 * `SUBGRAPH_COVERAGE`, put the subgraph id and its GraphQL query here, and add
 * a normaliser test against a saved response.
 */

import { refuse } from "@telt/core/domain";
import type { Refusal, Result } from "@telt/core/domain";
import type { PaidRequest } from "@telt/x402";

import type { AdapterContext, Normalized, ProviderAdapter } from "./types.js";

export const thegraphPoolAdapter: ProviderAdapter = {
  provider: "thegraph",
  stepId: "thegraph.pool",
  capability: "onchain.subgraph",
  endpointId: "thegraph:subgraph/pool",
  paid: true,

  buildRequest(context: AdapterContext): Result<PaidRequest, Refusal> {
    return refuse(
      "PROVIDER_UNAVAILABLE",
      `No published subgraph is configured for ${context.instrument.symbol}, so Telt has no onchain pool detail to buy.`,
      { provider: "thegraph", symbol: context.instrument.symbol },
    );
  },

  normalize(): Normalized | null {
    // Unreachable while `buildRequest` refuses. Returning null rather than
    // throwing keeps that true even if the refusal is ever lifted without a
    // normaliser being written to go with it.
    return null;
  },
};
