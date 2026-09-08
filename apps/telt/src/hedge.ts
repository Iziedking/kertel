/**
 * A one-symbol Spot hedge built from the account's actual holding.
 *
 * The calculation is deterministic. Exchange reads establish that the same
 * asset exists on Spot and USD-M Futures, then the existing futures proposal
 * path owns every write-related check and the one-use confirmation code.
 */

import * as fp from "@telt/core/money";
import type { FixedPoint } from "@telt/core/money";
import type { Symbol_ } from "@telt/core/domain";

import type { BinanceClient } from "./infra/binance.js";
import type {
  FuturesClient,
  FuturesFilters,
  FuturesPosition,
} from "./infra/futures.js";
import { isFlat, positionSide } from "./infra/futures.js";
import type { FuturesOutcome } from "./futures-trading.js";

export type HedgeDeps = {
  readonly binance: Pick<BinanceClient, "filters" | "market" | "account">;
  readonly futures: FuturesClient;
  readonly maxLeverage: number;
  readonly maxNotional: FixedPoint;
  readonly proposeFutures: (input: {
    readonly symbol: string;
    readonly side: "BUY" | "SELL";
    readonly notional: string;
    readonly leverage: number;
  }) => Promise<FuturesOutcome>;
};

export type HedgeRequest = {
  readonly symbol: string;
  /** 10,000 is full coverage, 5,000 is half. */
  readonly coverageBps: number;
  readonly leverage: number;
};

type HedgeCalculation = {
  readonly quantity: FixedPoint;
  readonly notional: FixedPoint;
  readonly netSpotQuantity: FixedPoint;
};

function failure(refusalCode: string, body: string): FuturesOutcome {
  return { ok: false, refusalCode, body };
}

function formatBps(bps: number): string {
  const whole = Math.floor(bps / 100);
  const fraction = Math.abs(bps % 100);
  return fraction === 0
    ? `${String(whole)}%`
    : `${String(whole)}.${String(fraction).padStart(2, "0")}%`;
}

/** Pure order sizing, exported so boundary cases can be proved with fixtures. */
export function calculateHedge(input: {
  readonly spotQuantity: FixedPoint;
  readonly coverageBps: number;
  readonly markPrice: FixedPoint;
  readonly filters: FuturesFilters;
}): HedgeCalculation | null {
  const quantity = fp.floorToStep(
    fp.applyBasisPoints(input.spotQuantity, input.coverageBps, "floor"),
    input.filters.stepSize,
  );
  if (!fp.isPositive(quantity)) return null;
  return {
    quantity,
    notional: fp.multiply(quantity, input.markPrice),
    netSpotQuantity: fp.subtract(input.spotQuantity, quantity),
  };
}

/**
 * Read the holding and prepare a matching short. This function never writes.
 * The returned code must still pass through the existing futures confirmation.
 */
export async function proposeHedge(
  deps: HedgeDeps,
  request: HedgeRequest,
): Promise<FuturesOutcome> {
  const symbol = request.symbol.trim().toUpperCase() as Symbol_;
  if (!symbol.endsWith("USDT") || symbol.length <= 4) {
    return failure(
      "SYMBOL_NOT_ALLOWED",
      "The first hedge version supports USDT pairs that trade on both Binance Spot and USD-M Futures, for example BTCUSDT or SOLUSDT.",
    );
  }
  if (
    !Number.isInteger(request.coverageBps) ||
    request.coverageBps < 1 ||
    request.coverageBps > 10_000
  ) {
    return failure(
      "AMOUNT_NOT_UNDERSTOOD",
      "Coverage must be a whole number from 1 to 10000 basis points. 10000 means all of the Spot holding.",
    );
  }
  if (
    !Number.isInteger(request.leverage) ||
    request.leverage < 1 ||
    request.leverage > deps.maxLeverage
  ) {
    return failure(
      "NOTIONAL_ABOVE_CAP",
      `Leverage must be a whole number from 1 to ${String(deps.maxLeverage)}.`,
    );
  }

  const [spotRules, futuresRules, account, market, mark, position, balances] =
    await Promise.all([
      deps.binance.filters(symbol),
      deps.futures.filters(symbol),
      deps.binance.account(),
      deps.binance.market(symbol),
      deps.futures.markPrice(symbol),
      deps.futures.position(symbol),
      deps.futures.balances(),
    ]);

  if (!spotRules.ok)
    return failure(spotRules.error.code, spotRules.error.detail);
  if (!futuresRules.ok)
    return failure(futuresRules.error.code, futuresRules.error.detail);
  if (!account.ok) return failure(account.error.code, account.error.detail);
  if (!market.ok) return failure(market.error.code, market.error.detail);
  if (!mark.ok) return failure(mark.error.code, mark.error.detail);
  if (!position.ok)
    return failure(position.error.code, position.error.detail);
  if (!balances.ok)
    return failure(balances.error.code, balances.error.detail);

  if (spotRules.value.quoteAsset !== "USDT") {
    return failure(
      "SYMBOL_NOT_ALLOWED",
      `${symbol} is not a USDT Spot pair, so it cannot be matched to this USD-M hedge.`,
    );
  }
  if (!isFlat(position.value)) {
    return failure(
      "OPEN_POSITION_EXISTS",
      `${symbol} already has a ${positionSide(position.value)} futures position. Telt will not mix a new hedge into an existing leveraged position.`,
    );
  }

  const asset = spotRules.value.baseAsset;
  const balance = account.value.balances.find((entry) => entry.asset === asset);
  const spotQuantity =
    balance === undefined
      ? fp.parse("0")
      : fp.add(balance.free, balance.locked);
  if (!fp.isPositive(spotQuantity)) {
    return failure(
      "INSUFFICIENT_BALANCE",
      `This account holds no ${asset} on Spot, so there is no ${symbol} exposure to hedge.`,
    );
  }

  const calculation = calculateHedge({
    spotQuantity,
    coverageBps: request.coverageBps,
    markPrice: mark.value,
    filters: futuresRules.value,
  });
  if (calculation === null) {
    return failure(
      "NOTIONAL_BELOW_EXCHANGE_MINIMUM",
      `${formatBps(request.coverageBps)} of ${fp.format(spotQuantity)} ${asset} is smaller than one ${symbol} futures lot.`,
    );
  }
  if (
    fp.lessThan(calculation.quantity, futuresRules.value.minQuantity) ||
    fp.lessThan(calculation.notional, futuresRules.value.minNotional)
  ) {
    return failure(
      "NOTIONAL_BELOW_EXCHANGE_MINIMUM",
      `The calculated hedge is ${fp.format(calculation.quantity)} ${asset}, worth about ${fp.format(fp.trim(calculation.notional, 2))} USDT. Binance requires at least ${fp.format(futuresRules.value.minNotional)} USDT on ${symbol} futures.`,
    );
  }
  if (fp.greaterThan(calculation.notional, deps.maxNotional)) {
    const maximumCoverage = Number(
      fp.divide(
        fp.multiply(deps.maxNotional, fp.parse("10000")),
        fp.multiply(spotQuantity, mark.value),
        0,
        "floor",
      ).atoms,
    );
    return failure(
      "NOTIONAL_ABOVE_CAP",
      `The requested hedge is about ${fp.format(fp.trim(calculation.notional, 2))} USDT, above Telt's ${fp.format(deps.maxNotional)} USDT futures cap. At this price the cap covers about ${formatBps(Math.max(0, Math.min(10_000, maximumCoverage)))} of the holding.`,
    );
  }

  const requiredMargin = fp.divide(
    calculation.notional,
    fp.parse(String(request.leverage)),
    2,
    "ceil",
  );
  const usdt = balances.value.find((entry) => entry.asset === "USDT");
  const available = usdt?.available ?? fp.parse("0");
  if (fp.lessThan(available, requiredMargin)) {
    return failure(
      "INSUFFICIENT_BALANCE",
      `The hedge needs about ${fp.format(requiredMargin)} USDT of Futures margin before fees, but only ${fp.format(fp.trim(available, 2))} USDT is available.`,
    );
  }

  const proposal = await deps.proposeFutures({
    symbol,
    side: "SELL",
    notional: fp.format(calculation.notional),
    leverage: request.leverage,
  });
  if (!proposal.ok) return proposal;

  const spotValue = fp.multiply(spotQuantity, market.value.lastPrice);
  return {
    ok: true,
    refusalCode: null,
    body: [
      `Protect ${asset} on ${symbol}`,
      "",
      `Spot holding:       ${fp.format(spotQuantity)} ${asset}, about ${fp.format(fp.trim(spotValue, 2))} USDT`,
      `Requested coverage: ${formatBps(request.coverageBps)}`,
      `Target short:       ${fp.format(calculation.quantity)} ${asset}`,
      `Net exposure:       about ${fp.format(calculation.netSpotQuantity)} ${asset} after the target hedge`,
      `Margin needed:      about ${fp.format(requiredMargin)} USDT before fees at ${String(request.leverage)}x isolated`,
      `Futures available:  ${fp.format(fp.trim(available, 2))} USDT`,
      "",
      "This protection remains open until you ask Telt to remove it. Automatic timed removal is not active yet.",
      "",
      proposal.body,
    ].join("\n"),
  };
}

/** Read the two legs together so the user sees protection, not two accounts. */
export async function describeHedge(
  deps: Pick<HedgeDeps, "binance" | "futures">,
  rawSymbol: string,
): Promise<FuturesOutcome> {
  const symbol = rawSymbol.trim().toUpperCase() as Symbol_;
  const [spotRules, account, market, futuresPosition] = await Promise.all([
    deps.binance.filters(symbol),
    deps.binance.account(),
    deps.binance.market(symbol),
    deps.futures.position(symbol),
  ]);
  if (!spotRules.ok)
    return failure(spotRules.error.code, spotRules.error.detail);
  if (!account.ok) return failure(account.error.code, account.error.detail);
  if (!market.ok) return failure(market.error.code, market.error.detail);
  if (!futuresPosition.ok)
    return failure(futuresPosition.error.code, futuresPosition.error.detail);

  const asset = spotRules.value.baseAsset;
  const balance = account.value.balances.find((entry) => entry.asset === asset);
  const spotQuantity =
    balance === undefined
      ? fp.parse("0")
      : fp.add(balance.free, balance.locked);
  const position: FuturesPosition = futuresPosition.value;
  const shortQuantity = fp.isNegative(position.positionAmt)
    ? fp.abs(position.positionAmt)
    : fp.parse("0");
  const coverageBps = fp.isPositive(spotQuantity)
    ? Number(
        fp.divide(
          fp.multiply(shortQuantity, fp.parse("10000")),
          spotQuantity,
          0,
          "floor",
        ).atoms,
      )
    : 0;
  const netQuantity = fp.add(spotQuantity, position.positionAmt);
  const spotValue = fp.multiply(spotQuantity, market.value.lastPrice);
  const netValue = fp.multiply(netQuantity, market.value.lastPrice);

  const state =
    fp.isPositive(spotQuantity) && fp.isPositive(shortQuantity)
      ? coverageBps === 10_000
        ? "FULLY HEDGED"
        : coverageBps < 10_000
          ? "PARTIALLY HEDGED"
          : "OVERHEDGED"
      : fp.isPositive(spotQuantity)
        ? "UNHEDGED"
        : fp.isPositive(shortQuantity)
          ? "UNPAIRED SHORT"
          : "NO EXPOSURE";

  return {
    ok: true,
    refusalCode: null,
    body: [
      `${symbol} protection: ${state}`,
      "",
      `Spot:          ${fp.format(spotQuantity)} ${asset}, about ${fp.format(fp.trim(spotValue, 2))} USDT`,
      `Futures short: ${fp.format(shortQuantity)} ${asset}`,
      `Coverage:      ${formatBps(coverageBps)}`,
      `Net exposure:  ${fp.format(netQuantity)} ${asset}, about ${fp.format(fp.trim(netValue, 2))} USDT`,
      `Futures side:  ${positionSide(position)}`,
      `Futures PnL:   ${fp.format(position.unrealisedPnl)} USDT`,
      "",
      "Coverage compares base-asset quantities. Prices, fees, funding, and Spot balances can change after this read.",
    ].join("\n"),
  };
}
