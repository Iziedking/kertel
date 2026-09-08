import * as fp from "@telt/core/money";
import type { FixedPoint } from "@telt/core/money";

export type RiskPosition = {
  readonly symbol: string;
  readonly spotNotional: FixedPoint;
  readonly hedgeNotional: FixedPoint;
};

export type AggregateRisk = {
  readonly totalExposure: FixedPoint;
  readonly totalHedgeNotional: FixedPoint;
  readonly complete: boolean;
  readonly allowed: boolean;
  readonly reason: string;
};

/** Deterministic ceiling across active Guard symbols. No model input is involved. */
export function aggregateRisk(input: {
  readonly positions: readonly RiskPosition[];
  readonly maxTotalExposure: FixedPoint;
  readonly maxTotalHedgeNotional: FixedPoint;
  readonly complete?: boolean;
}): AggregateRisk {
  let exposure = fp.zero(input.maxTotalExposure.scale);
  let hedge = fp.zero(input.maxTotalHedgeNotional.scale);
  for (const position of input.positions) {
    exposure = fp.add(exposure, position.spotNotional);
    hedge = fp.add(hedge, position.hedgeNotional);
  }
  const complete = input.complete ?? true;
  if (!complete) {
    return { totalExposure: exposure, totalHedgeNotional: hedge, complete, allowed: false, reason: "Aggregate exposure is unknown because at least one account, market, or position read failed." };
  }
  if (fp.greaterThan(exposure, input.maxTotalExposure)) {
    return { totalExposure: exposure, totalHedgeNotional: hedge, complete, allowed: false, reason: `Aggregate Spot exposure ${fp.format(exposure)} exceeds the ${fp.format(input.maxTotalExposure)} USDT Guard portfolio ceiling.` };
  }
  if (fp.greaterThan(hedge, input.maxTotalHedgeNotional)) {
    return { totalExposure: exposure, totalHedgeNotional: hedge, complete, allowed: false, reason: `Aggregate Futures hedge notional ${fp.format(hedge)} exceeds the ${fp.format(input.maxTotalHedgeNotional)} USDT Guard portfolio ceiling.` };
  }
  return { totalExposure: exposure, totalHedgeNotional: hedge, complete, allowed: true, reason: "Aggregate exposure is within the configured account ceilings." };
}
