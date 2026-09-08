/**
 * Deterministic position protection for an explicitly approved mandate.
 *
 * The model may explain a state, but it never decides whether a hedge is
 * needed. This module classifies quantities and applies a tolerance band so a
 * noisy account read cannot cause a stream of tiny orders.
 */
import * as fp from "@telt/core/money";
import type { FixedPoint } from "@telt/core/money";
import type { Instant } from "@telt/core/domain";

export type GuardState =
  | "protected"
  | "underhedged"
  | "overhedged"
  | "unprotected"
  | "unknown";

export type GuardObservation = {
  readonly spotQuantity: FixedPoint;
  readonly futuresShortQuantity: FixedPoint;
  readonly targetCoverageBps: number;
  readonly toleranceBps: number;
  readonly maxAgeMs: number;
  readonly observedAt: Instant;
  readonly now: Instant;
  readonly marketAvailable: boolean;
};

export type GuardDecision = {
  readonly state: GuardState;
  readonly coverageBps: number;
  readonly targetQuantity: FixedPoint | null;
  readonly adjustmentQuantity: FixedPoint | null;
  readonly because: string;
};

export function classifyGuard(input: GuardObservation): GuardDecision {
  if (!input.marketAvailable || input.now - input.observedAt > input.maxAgeMs) {
    return { state: "unknown", coverageBps: 0, targetQuantity: null, adjustmentQuantity: null, because: "Market or account data is stale; Telt is holding and will not guess." };
  }
  if (!fp.isPositive(input.spotQuantity)) {
    const targetQuantity = fp.zero(input.futuresShortQuantity.scale);
    if (fp.isPositive(input.futuresShortQuantity)) {
      return { state: "overhedged", coverageBps: 0, targetQuantity, adjustmentQuantity: fp.negate(input.futuresShortQuantity), because: "The Spot exposure is zero, so the remaining Futures short must be removed." };
    }
    return { state: "protected", coverageBps: 10000, targetQuantity, adjustmentQuantity: targetQuantity, because: "The account has no Spot exposure and no Futures hedge." };
  }
  const coverageBps = Number(fp.divide(fp.multiply(input.futuresShortQuantity, fp.parse("10000")), input.spotQuantity, 0, "floor").atoms);
  const quantityScale = Math.min(38, input.spotQuantity.scale + 4);
  const preciseSpotQuantity = fp.rescale(input.spotQuantity, quantityScale, "trunc");
  const targetQuantity = fp.applyBasisPoints(preciseSpotQuantity, input.targetCoverageBps, "floor");
  const delta = fp.subtract(targetQuantity, input.futuresShortQuantity);
  const tolerance = fp.applyBasisPoints(preciseSpotQuantity, input.toleranceBps, "floor");
  if (fp.isZero(input.futuresShortQuantity)) {
    return { state: "unprotected", coverageBps, targetQuantity, adjustmentQuantity: targetQuantity, because: "Spot exposure exists with no matching Futures short." };
  }
  if (fp.greaterThan(fp.abs(delta), tolerance)) {
    return { state: fp.isPositive(delta) ? "underhedged" : "overhedged", coverageBps, targetQuantity, adjustmentQuantity: delta, because: `Coverage is ${String(Math.floor(coverageBps / 100))}% against a ${String(Math.floor(input.targetCoverageBps / 100))}% mandate.` };
  }
  return { state: "protected", coverageBps, targetQuantity, adjustmentQuantity: fp.zero(targetQuantity.scale), because: `Coverage is within the ${String(Math.floor(input.toleranceBps / 100))}% tolerance band.` };
}
