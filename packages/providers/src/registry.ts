/**
 * Recipe step to adapter.
 *
 * The planner decides *which* step to run; this decides *who* runs it. Keeping
 * the two apart means the escalation ladder stays a pure function over cost and
 * evidence, and adding a provider never touches the logic that decides how much
 * to spend.
 *
 * The startup check below is the useful part. A recipe step with no adapter is a
 * step the planner will happily select and then fail on, mid-run, after the
 * cheaper calls have already been paid for. Catching that at boot turns a
 * wasted spend into a build error.
 */

import { RECIPE_STEPS } from "@telt/core/research";

import { binancePriceAdapter } from "./binance.js";
import { coingeckoPriceAdapter } from "./coingecko.js";
import { coinmarketcapPriceAdapter } from "./coinmarketcap.js";
import { nansenNetflowAdapter } from "./nansen.js";
import {
  openpulseCandlesAdapter,
  openpulseSafetyAdapter,
  openpulseSentimentAdapter,
} from "./openpulse.js";
import { thegraphPoolAdapter } from "./thegraph.js";
import type { ProviderAdapter } from "./types.js";

export const ADAPTERS: readonly ProviderAdapter[] = Object.freeze([
  binancePriceAdapter,
  coingeckoPriceAdapter,
  coinmarketcapPriceAdapter,
  nansenNetflowAdapter,
  openpulseSafetyAdapter,
  openpulseSentimentAdapter,
  openpulseCandlesAdapter,
  thegraphPoolAdapter,
]);

export function adapterFor(stepId: string): ProviderAdapter | undefined {
  return ADAPTERS.find((adapter) => adapter.stepId === stepId);
}

/**
 * Every recipe step has an adapter, and every adapter matches its step.
 *
 * Called once at startup and asserted in the suite. It throws rather than
 * refusing because a mismatch here is a defect in Telt, not a condition a
 * user can do anything about.
 */
export function assertRegistryCoversRecipes(): void {
  for (const step of RECIPE_STEPS) {
    const adapter = adapterFor(step.id);
    if (adapter === undefined) {
      throw new Error(`recipe step ${step.id} has no provider adapter`);
    }
    if (adapter.provider !== step.provider) {
      throw new Error(
        `adapter for ${step.id} claims provider ${adapter.provider}, recipe says ${step.provider}`,
      );
    }
    if (adapter.endpointId !== step.endpointId) {
      throw new Error(
        `adapter for ${step.id} claims endpoint ${adapter.endpointId}, recipe says ${step.endpointId}`,
      );
    }
    if (adapter.capability !== step.capability) {
      throw new Error(
        `adapter for ${step.id} claims capability ${adapter.capability}, recipe says ${step.capability}`,
      );
    }
    if (adapter.paid !== (step.tier > 0)) {
      throw new Error(`adapter for ${step.id} disagrees with its tier about being paid`);
    }
  }
}
