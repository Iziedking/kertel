/**
 * Turning "buy 20 USDT of ETH" into an order the exchange will accept.
 *
 * Every rounding here goes down. A quantity rounded up spends more than the
 * user approved, and once the step size is applied that difference is not
 * recoverable. Rounding down can only ever under-spend, which the user can fix
 * by asking again.
 */

import * as fp from "../money/fixed-point.js";
import type { FixedPoint } from "../money/fixed-point.js";
import type { Refusal, Result } from "../domain/result.js";
import { ok, refuse } from "../domain/result.js";
import type { OrderSide, SymbolFilters } from "../domain/types.js";

/**
 * Taker fee in basis points.
 *
 * A conservative default, deliberately above Binance's standard 10 bps Spot
 * taker fee. The estimate exists to make sure the account can cover the order,
 * so overstating it refuses a marginal order and understating it lets one fail
 * at the exchange. Overstating is the safe error.
 */
export const DEFAULT_FEE_BPS = 15;

export type SizedOrder = {
  readonly quantity: FixedPoint;
  readonly estimatedNotional: FixedPoint;
  readonly estimatedFee: FixedPoint;
  /** What the user asked to spend, before step-size rounding took a bite. */
  readonly requestedNotional: FixedPoint;
};

/**
 * Size a buy from a quote-currency budget.
 *
 * The order is: divide, floor to the step, then recompute the notional from the
 * quantity that survived. Recomputing matters. Reporting the requested 20.00
 * when the order is really 19.93 would mean the number the user confirmed is
 * not the number that gets sent.
 */
export function sizeFromNotional(input: {
  readonly notional: FixedPoint;
  readonly price: FixedPoint;
  readonly filters: SymbolFilters;
  readonly feeBps?: number;
}): Result<SizedOrder, Refusal> {
  if (!fp.isPositive(input.notional)) {
    return refuse("AMOUNT_NOT_UNDERSTOOD", "The amount to spend must be greater than zero.");
  }
  if (!fp.isPositive(input.price)) {
    return refuse("MARKET_DATA_STALE", "Telt has no usable price to size this order from.");
  }

  const quantityScale = input.filters.stepSize.scale;
  const raw = fp.divide(input.notional, input.price, quantityScale, "floor");
  const quantity = fp.floorToStep(raw, input.filters.stepSize);

  if (!fp.isPositive(quantity)) {
    return refuse(
      "NOTIONAL_BELOW_EXCHANGE_MINIMUM",
      `${fp.format(input.notional)} ${input.filters.quoteAsset} is too small to buy even one step of ${input.filters.baseAsset}.`,
      {
        requested: fp.format(input.notional),
        stepSize: fp.format(input.filters.stepSize),
        price: fp.format(input.price),
      },
    );
  }

  const estimatedNotional = fp.rescale(
    fp.multiply(quantity, input.price),
    input.filters.tickSize.scale,
    "ceil",
  );
  const estimatedFee = fp.applyBasisPoints(
    estimatedNotional,
    input.feeBps ?? DEFAULT_FEE_BPS,
    "ceil",
  );

  return ok({
    quantity,
    estimatedNotional,
    estimatedFee,
    requestedNotional: input.notional,
  });
}

/**
 * Size a sell from a base-currency quantity the user already holds.
 *
 * Floored to the step for the same reason: an order for more than a whole
 * number of steps is rejected by the exchange, and rounding up could ask to
 * sell more than the account holds.
 */
export function sizeFromQuantity(input: {
  readonly quantity: FixedPoint;
  readonly price: FixedPoint;
  readonly filters: SymbolFilters;
  readonly feeBps?: number;
}): Result<SizedOrder, Refusal> {
  if (!fp.isPositive(input.quantity)) {
    return refuse("AMOUNT_NOT_UNDERSTOOD", "The quantity to sell must be greater than zero.");
  }
  if (!fp.isPositive(input.price)) {
    return refuse("MARKET_DATA_STALE", "Telt has no usable price to size this order from.");
  }

  const quantity = fp.floorToStep(input.quantity, input.filters.stepSize);
  if (!fp.isPositive(quantity)) {
    return refuse(
      "NOTIONAL_BELOW_EXCHANGE_MINIMUM",
      `${fp.format(input.quantity)} ${input.filters.baseAsset} is smaller than one exchange step.`,
      { requested: fp.format(input.quantity), stepSize: fp.format(input.filters.stepSize) },
    );
  }

  const estimatedNotional = fp.rescale(
    fp.multiply(quantity, input.price),
    input.filters.tickSize.scale,
    "floor",
  );
  const estimatedFee = fp.applyBasisPoints(
    estimatedNotional,
    input.feeBps ?? DEFAULT_FEE_BPS,
    "ceil",
  );

  return ok({ quantity, estimatedNotional, estimatedFee, requestedNotional: estimatedNotional });
}

/**
 * The worst price a market order may fill at and still be acceptable.
 *
 * A buy tolerates the price going up, a sell tolerates it going down. This is
 * what the execution adapter checks the fill against, and what the receipt
 * compares the average price to.
 */
export function slippageBound(input: {
  readonly referencePrice: FixedPoint;
  readonly side: OrderSide;
  readonly maxSlippageBps: number;
}): FixedPoint {
  const allowance = fp.applyBasisPoints(
    input.referencePrice,
    input.maxSlippageBps,
    input.side === "BUY" ? "ceil" : "floor",
  );
  return input.side === "BUY"
    ? fp.add(input.referencePrice, allowance)
    : fp.subtract(input.referencePrice, allowance);
}
