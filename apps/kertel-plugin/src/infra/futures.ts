/**
 * USDⓈ-M futures, through Binance Agent OS.
 *
 * Futures is not spot with a multiplier. Three differences drive everything in
 * this file:
 *
 * 1. **There is no balance to sell.** A spot exit sells coins you hold, and the
 *    amount is naturally capped by the balance. A futures position is closed by
 *    an opposite-side *reduce-only* order. Without `reduceOnly`, a "close" that
 *    arrives twice does not close the position twice — it opens a new one on
 *    the other side.
 * 2. **The position can lose more than it cost.** At 20x, a 5% move against you
 *    is the whole margin. The exchange closes it for you and keeps the margin,
 *    which is why `liquidationPrice` is the number this module cares about most.
 * 3. **The defaults are the dangerous ones.** Binance ships ETHUSDT at 20x on
 *    *cross* margin, and cross means the entire futures wallet backs the
 *    position. Kertel sets isolated margin and a low leverage before it opens
 *    anything, and refuses if either could not be set.
 *
 * Read from the live exchange on 2026-09-07: ETHUSDT futures has a MIN_NOTIONAL
 * of 20 USDT on the *position*, a 0.001 lot step, and three decimals of
 * quantity precision. A position is therefore never small; only the margin
 * behind it is.
 */

import * as fp from "@kertel/core/money";
import type { FixedPoint } from "@kertel/core/money";
import { ok, refuse } from "@kertel/core/domain";
import type { Refusal, Result, Symbol_ } from "@kertel/core/domain";

/** What the exchange will accept for one futures symbol. */
export type FuturesFilters = {
  readonly symbol: Symbol_;
  readonly stepSize: FixedPoint;
  readonly minQuantity: FixedPoint;
  readonly maxQuantity: FixedPoint;
  /** On the position's notional, not on the margin. 20 USDT for ETHUSDT. */
  readonly minNotional: FixedPoint;
  readonly quantityPrecision: number;
  readonly tickSize: FixedPoint;
};

/**
 * An open position, as the exchange sees it.
 *
 * `liquidationPrice` is the field that matters. A take-profit that never fires
 * is a missed gain; a stop that fires after liquidation is not a stop.
 */
export type FuturesPosition = {
  readonly symbol: Symbol_;
  /** Signed: positive is long, negative is short, zero is flat. */
  readonly positionAmt: FixedPoint;
  readonly entryPrice: FixedPoint;
  readonly markPrice: FixedPoint;
  readonly liquidationPrice: FixedPoint | null;
  readonly unrealisedPnl: FixedPoint;
  readonly leverage: number;
  readonly isolated: boolean;
  /** Notional value of the position, always positive. */
  readonly notional: FixedPoint;
};

export type FuturesBalance = {
  readonly asset: string;
  readonly balance: FixedPoint;
  readonly available: FixedPoint;
};

export type FuturesClient = {
  filters(symbol: Symbol_): Promise<Result<FuturesFilters, Refusal>>;
  position(symbol: Symbol_): Promise<Result<FuturesPosition, Refusal>>;
  /**
   * The mark price, read independently of any position.
   *
   * `positionInformationV2` reports a mark of zero when the position is flat,
   * which is exactly the moment a new position needs to be sized. Sizing from
   * the position's own mark therefore fails on every first entry.
   */
  markPrice(symbol: Symbol_): Promise<Result<FixedPoint, Refusal>>;
  balances(): Promise<Result<readonly FuturesBalance[], Refusal>>;
  /** Isolated margin, always. Idempotent: already-isolated is a success. */
  setIsolated(symbol: Symbol_): Promise<Result<true, Refusal>>;
  setLeverage(symbol: Symbol_, leverage: number): Promise<Result<true, Refusal>>;
  open(input: {
    readonly symbol: Symbol_;
    readonly side: "BUY" | "SELL";
    readonly quantity: FixedPoint;
    readonly clientOrderId: string;
  }): Promise<Result<FuturesFill, Refusal>>;
  /** Reduce-only, so a repeat cannot flip the position instead of closing it. */
  close(input: {
    readonly symbol: Symbol_;
    readonly position: FuturesPosition;
    readonly quantity: FixedPoint;
    readonly clientOrderId: string;
  }): Promise<Result<FuturesFill, Refusal>>;
};

export type FuturesFill = {
  readonly orderRef: string;
  readonly clientOrderId: string;
  readonly status: string;
  readonly filledQuantity: FixedPoint;
  readonly averagePrice: FixedPoint | null;
};

/** A tool caller shared with the Agent OS spot client. */
export type ToolCaller = (
  toolName: string,
  args: Record<string, unknown>,
  options?: { readonly unknownOnFailure?: boolean },
) => Promise<Result<unknown, Refusal>>;

function decimal(value: unknown): FixedPoint | null {
  if (typeof value !== "string" || !/^-?\d+(\.\d+)?$/.test(value)) {
    return null;
  }
  return fp.parse(value);
}

/**
 * How close the mark price is to liquidation, in basis points.
 *
 * Returns null when the exchange reports no liquidation price, which is what it
 * does for a flat position. Positive means there is room; the number shrinking
 * is the position getting dangerous.
 */
export function liquidationDistanceBps(position: FuturesPosition): number | null {
  if (position.liquidationPrice === null || !fp.isPositive(position.liquidationPrice)) {
    return null;
  }
  if (!fp.isPositive(position.markPrice)) {
    return null;
  }
  const gap = fp.abs(fp.subtract(position.markPrice, position.liquidationPrice));
  const scaled = fp.divide(fp.multiply(gap, fp.parse("10000")), position.markPrice, 0, "floor");
  return Number(scaled.atoms);
}

export function isFlat(position: FuturesPosition): boolean {
  return fp.isZero(position.positionAmt);
}

export function positionSide(position: FuturesPosition): "LONG" | "SHORT" | "FLAT" {
  if (fp.isZero(position.positionAmt)) return "FLAT";
  return fp.isNegative(position.positionAmt) ? "SHORT" : "LONG";
}

export function createFuturesClient(call: ToolCaller): FuturesClient {
  return {
    async filters(symbol: Symbol_): Promise<Result<FuturesFilters, Refusal>> {
      const result = await call("futures_usds.exchangeInformation", {});
      if (!result.ok) return result;

      const symbols = (result.value as { symbols?: unknown }).symbols;
      const entry = Array.isArray(symbols)
        ? (symbols.find(
            (candidate) =>
              typeof candidate === "object" &&
              candidate !== null &&
              (candidate as Record<string, unknown>)["symbol"] === symbol,
          ) as Record<string, unknown> | undefined)
        : undefined;

      if (entry === undefined) {
        return refuse("SYMBOL_NOT_ALLOWED", `${symbol} is not listed on USDⓈ-M futures.`);
      }
      if (entry["status"] !== "TRADING") {
        return refuse(
          "SYMBOL_NOT_ALLOWED",
          `${symbol} futures is not trading (status ${String(entry["status"])}).`,
        );
      }

      const list = Array.isArray(entry["filters"]) ? (entry["filters"] as Record<string, unknown>[]) : [];
      const lot = list.find((f) => f["filterType"] === "LOT_SIZE");
      const notional = list.find((f) => f["filterType"] === "MIN_NOTIONAL");
      const price = list.find((f) => f["filterType"] === "PRICE_FILTER");

      const stepSize = decimal(lot?.["stepSize"]);
      const minQuantity = decimal(lot?.["minQty"]);
      const maxQuantity = decimal(lot?.["maxQty"]);
      const tickSize = decimal(price?.["tickSize"]);
      // Futures reports this as `notional`, not `minNotional`. Reading the spot
      // field name here silently yields no minimum at all.
      const minNotional = decimal(notional?.["notional"]);

      if (
        stepSize === null ||
        minQuantity === null ||
        maxQuantity === null ||
        minNotional === null ||
        tickSize === null
      ) {
        return refuse(
          "PROVIDER_UNAVAILABLE",
          `Binance's futures rules for ${symbol} are missing a field Kertel needs to size a position safely.`,
        );
      }

      return ok({
        symbol,
        stepSize,
        minQuantity,
        maxQuantity,
        minNotional,
        tickSize,
        quantityPrecision:
          typeof entry["quantityPrecision"] === "number" ? entry["quantityPrecision"] : stepSize.scale,
      });
    },

    async position(symbol: Symbol_): Promise<Result<FuturesPosition, Refusal>> {
      const result = await call("futures_usds.positionInformationV2", { symbol });
      if (!result.ok) return result;

      const rows = result.value;
      const row = Array.isArray(rows) ? (rows[0] as Record<string, unknown> | undefined) : undefined;
      if (row === undefined) {
        return refuse("PROVIDER_UNAVAILABLE", `Binance reported no futures position for ${symbol}.`);
      }

      const positionAmt = decimal(row["positionAmt"]) ?? fp.parse("0");
      const liquidation = decimal(row["liquidationPrice"]);
      return ok({
        symbol,
        positionAmt,
        entryPrice: decimal(row["entryPrice"]) ?? fp.parse("0"),
        markPrice: decimal(row["markPrice"]) ?? fp.parse("0"),
        // Zero means "no liquidation price", which is what a flat position
        // reports. Carrying it as a real price would put liquidation at zero.
        liquidationPrice: liquidation !== null && fp.isPositive(liquidation) ? liquidation : null,
        unrealisedPnl: decimal(row["unRealizedProfit"]) ?? fp.parse("0"),
        leverage: Number(row["leverage"] ?? 0),
        isolated: row["isolated"] === true || row["marginType"] === "isolated",
        notional: fp.abs(decimal(row["notional"]) ?? fp.parse("0")),
      });
    },

    async markPrice(symbol: Symbol_): Promise<Result<FixedPoint, Refusal>> {
      const result = await call("futures_usds.symbolPriceTicker", { symbol });
      if (!result.ok) return result;
      // The ticker answers with an object for one symbol and an array for all.
      const row = Array.isArray(result.value)
        ? (result.value[0] as Record<string, unknown> | undefined)
        : (result.value as Record<string, unknown>);
      const price = decimal(row?.["price"]);
      if (price === null || !fp.isPositive(price)) {
        return refuse("MARKET_DATA_STALE", `Binance returned no usable futures price for ${symbol}.`);
      }
      return ok(price);
    },

    async balances(): Promise<Result<readonly FuturesBalance[], Refusal>> {
      const result = await call("futures_usds.futuresAccountBalanceV3", {});
      if (!result.ok) return result;
      const rows = Array.isArray(result.value) ? result.value : [];
      return ok(
        rows.flatMap((entry) => {
          if (typeof entry !== "object" || entry === null) return [];
          const row = entry as Record<string, unknown>;
          const balance = decimal(row["balance"]);
          const available = decimal(row["availableBalance"]);
          if (typeof row["asset"] !== "string" || balance === null) return [];
          return [
            { asset: row["asset"], balance, available: available ?? fp.parse("0") },
          ];
        }),
      );
    },

    async setIsolated(symbol: Symbol_): Promise<Result<true, Refusal>> {
      const result = await call("futures_usds.changeMarginType", {
        symbol,
        marginType: "ISOLATED",
      });
      if (result.ok) {
        return ok(true);
      }
      // -4046 is "no need to change margin type": already isolated. That is the
      // desired state, so treating it as a failure would block every order
      // after the first.
      if (result.error.context?.["code"] === -4046) {
        return ok(true);
      }
      return result;
    },

    async setLeverage(symbol: Symbol_, leverage: number): Promise<Result<true, Refusal>> {
      const result = await call("futures_usds.changeInitialLeverage", { symbol, leverage });
      if (!result.ok) return result;
      return ok(true);
    },

    async open(input): Promise<Result<FuturesFill, Refusal>> {
      const result = await call(
        "futures_usds.newOrder",
        {
          symbol: input.symbol,
          side: input.side,
          type: "MARKET",
          quantity: fp.format(input.quantity),
          newClientOrderId: input.clientOrderId,
          newOrderRespType: "RESULT",
        },
        { unknownOnFailure: true },
      );
      if (!result.ok) return result;
      return ok(parseFill(result.value));
    },

    async close(input): Promise<Result<FuturesFill, Refusal>> {
      const side = positionSide(input.position);
      if (side === "FLAT") {
        return refuse("EXCHANGE_REJECTED", `There is no open ${input.symbol} position to close.`);
      }

      const result = await call(
        "futures_usds.newOrder",
        {
          symbol: input.symbol,
          // The opposite side of what is held.
          side: side === "LONG" ? "SELL" : "BUY",
          type: "MARKET",
          quantity: fp.format(fp.abs(input.quantity)),
          // Without this a repeated close opens a position on the other side
          // rather than closing anything.
          reduceOnly: "true",
          newClientOrderId: input.clientOrderId,
          newOrderRespType: "RESULT",
        },
        { unknownOnFailure: true },
      );
      if (!result.ok) return result;
      return ok(parseFill(result.value));
    },
  };
}

function parseFill(body: unknown): FuturesFill {
  const row = body as Record<string, unknown>;
  const executed = decimal(row["executedQty"]) ?? fp.parse("0");
  const quote = decimal(row["cumQuote"]);
  return {
    orderRef: String(row["orderId"] ?? ""),
    clientOrderId: String(row["clientOrderId"] ?? ""),
    status: String(row["status"] ?? "unknown"),
    filledQuantity: executed,
    // Derived from what was actually spent, like the spot client. `avgPrice` is
    // reported too, but deriving it keeps one definition of "what it cost".
    averagePrice:
      quote !== null && fp.isPositive(executed) ? fp.divide(quote, executed, 8, "floor") : decimal(row["avgPrice"]),
  };
}

/** For the receipt: what a position is worth and how close it is to being closed for you. */
export function describePosition(position: FuturesPosition): string {
  const side = positionSide(position);
  if (side === "FLAT") {
    return `${position.symbol} futures: flat`;
  }
  const distance = liquidationDistanceBps(position);
  const lines = [
    `${position.symbol} futures: ${side} ${fp.format(fp.abs(position.positionAmt))}`,
    `  entry ${fp.format(position.entryPrice)}  mark ${fp.format(position.markPrice)}  ${String(position.leverage)}x ${position.isolated ? "isolated" : "CROSS"}`,
    `  unrealised ${fp.format(position.unrealisedPnl)}  notional ${fp.format(position.notional)}`,
  ];
  lines.push(
    position.liquidationPrice === null || distance === null
      ? "  liquidation: not reported"
      : `  liquidation ${fp.format(position.liquidationPrice)}, ${String(distance / 100)}% away`,
  );
  return lines.join("\n");
}
