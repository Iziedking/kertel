/**
 * The one place that knows how spot and futures differ.
 *
 * An exit plan is the same idea on both: a target is a target, a stop is a
 * stop, and a ladder trims into strength either way. What differs is only where
 * the position is read from and what "sell some of it" means — so that is all
 * this module abstracts, and the mandate engine, the monitor's reasoning, its
 * journalling and its idempotency stay single copies that serve both.
 *
 * Three differences it hides:
 *
 * - **Where the size comes from.** Spot reads a balance and cannot tell you what
 *   it cost; futures reads a position that knows its own entry price. That is
 *   why `entryPrice` here is nullable: on spot the caller must supply one.
 * - **Which price the triggers measure.** Spot uses the best bid, because that
 *   is what a market sell actually gets. Futures uses the mark, because that is
 *   what the exchange liquidates against — a stop measured off anything else is
 *   measuring the wrong number.
 * - **What an exit is.** Spot sells coins it holds, capped naturally by the
 *   balance. Futures sends an opposite-side *reduce-only* order, so a close that
 *   arrives twice cannot flip the position onto the other side.
 *
 * Long-only, deliberately. Every trigger in the mandate engine reads a gain as
 * price rising above entry, so a short inverts all of them; a short venue would
 * need the engine to be sign-aware first.
 */

import * as fp from "@kertel/core/money";
import type { FixedPoint } from "@kertel/core/money";
import { ok, refuse } from "@kertel/core/domain";
import type { Refusal, Result, Symbol_ } from "@kertel/core/domain";

import type { BinanceClient } from "./infra/binance.js";
import type { FuturesClient } from "./infra/futures.js";
import { isFlat, liquidationDistanceBps } from "./infra/futures.js";

/** Everything a plan or a sweep needs to know about a position, either venue. */
export type VenueReading = {
  /** What the triggers measure against: the bid on spot, the mark on futures. */
  readonly price: FixedPoint;
  /** Position size in base units. Zero means nothing is held. */
  readonly held: FixedPoint;
  readonly minQuantity: FixedPoint;
  readonly minNotional: FixedPoint;
  readonly baseAsset: string;
  /** Futures knows what the position cost. Spot does not, and answers null. */
  readonly entryPrice: FixedPoint | null;
  /** Futures only. How far the exchange's own exit sits, in basis points. */
  readonly liquidationDistanceBps: number | null;
};

export type VenueFill = {
  readonly filledQuantity: FixedPoint;
  readonly averagePrice: FixedPoint | null;
  /** The exchange's own id for the fill, for the journal and reconciliation. */
  readonly exchangeOrderRef: string;
};

export type Venue = {
  readonly market: "spot" | "futures";
  read(symbol: Symbol_): Promise<Result<VenueReading, Refusal>>;
  exit(input: {
    readonly symbol: Symbol_;
    readonly quantity: FixedPoint;
    readonly clientOrderId: string;
  }): Promise<Result<VenueFill, Refusal>>;
};

export function spotVenue(binance: BinanceClient): Venue {
  return {
    market: "spot",

    async read(symbol: Symbol_): Promise<Result<VenueReading, Refusal>> {
      const [filters, market, account] = await Promise.all([
        binance.filters(symbol),
        binance.market(symbol),
        binance.account(),
      ]);
      if (!filters.ok) return filters;
      if (!market.ok) return market;
      if (!account.ok) return account;

      const held =
        account.value.balances.find((balance) => balance.asset === filters.value.baseAsset)?.free ??
        fp.parse("0");

      return ok({
        // A market sell fills at the bid. Measuring a stop off the ask would
        // trigger it late, at a price nobody could have got.
        price: market.value.bestBid,
        held,
        minQuantity: filters.value.minQuantity,
        minNotional: filters.value.minNotional,
        baseAsset: filters.value.baseAsset,
        entryPrice: null,
        liquidationDistanceBps: null,
      });
    },

    async exit(input): Promise<Result<VenueFill, Refusal>> {
      const placed = await binance.placeMarketOrder({
        symbol: input.symbol,
        side: "SELL",
        quantity: input.quantity,
        clientOrderId: input.clientOrderId,
      });
      if (!placed.ok) return placed;
      return ok({
        filledQuantity: placed.value.filledQuantity,
        averagePrice: placed.value.averagePrice,
        exchangeOrderRef: placed.value.exchangeOrderRef,
      });
    },
  };
}

export function futuresVenue(futures: FuturesClient): Venue {
  return {
    market: "futures",

    async read(symbol: Symbol_): Promise<Result<VenueReading, Refusal>> {
      const [filters, position] = await Promise.all([
        futures.filters(symbol),
        futures.position(symbol),
      ]);
      if (!filters.ok) return filters;
      if (!position.ok) return position;

      // A flat position reports a mark of zero, so the price has to come from
      // the ticker whenever there is nothing open to read it from.
      let price = position.value.markPrice;
      if (!fp.isPositive(price)) {
        const mark = await futures.markPrice(symbol);
        if (!mark.ok) return mark;
        price = mark.value;
      }

      const held = isFlat(position.value) ? fp.parse("0") : fp.abs(position.value.positionAmt);

      return ok({
        price,
        held,
        minQuantity: filters.value.minQuantity,
        minNotional: filters.value.minNotional,
        baseAsset: symbol.replace(/USDT$/, ""),
        // The exchange records what the position cost, so nobody has to guess.
        entryPrice: fp.isPositive(position.value.entryPrice) ? position.value.entryPrice : null,
        liquidationDistanceBps: liquidationDistanceBps(position.value),
      });
    },

    async exit(input): Promise<Result<VenueFill, Refusal>> {
      // Read the position again rather than trusting one from a previous tick:
      // it may have been closed by hand, or reduced by liquidation, between the
      // decision and the order.
      const position = await futures.position(input.symbol);
      if (!position.ok) return position;
      if (isFlat(position.value)) {
        return refuse(
          "EXCHANGE_REJECTED",
          `The ${input.symbol} futures position is already closed, so there is nothing to exit.`,
        );
      }

      // Never send more than is actually open. A reduce-only order for more
      // than the position is rejected outright, which would turn a partial
      // take-profit into no exit at all.
      const open = fp.abs(position.value.positionAmt);
      const quantity = fp.greaterThan(input.quantity, open) ? open : input.quantity;

      const closed = await futures.close({
        symbol: input.symbol,
        position: position.value,
        quantity,
        clientOrderId: input.clientOrderId,
      });
      if (!closed.ok) return closed;
      return ok({
        filledQuantity: closed.value.filledQuantity,
        averagePrice: closed.value.averagePrice,
        exchangeOrderRef: closed.value.orderRef,
      });
    },
  };
}

/** The venue a mandate belongs to, or a refusal when futures is not available. */
export function venueFor(
  market: "spot" | "futures",
  binance: BinanceClient,
  futures: FuturesClient | null,
): Result<Venue, Refusal> {
  if (market === "spot") return ok(spotVenue(binance));
  if (futures === null) {
    return refuse(
      "EXECUTION_ADAPTER_UNAVAILABLE",
      "Futures runs on the Binance Agent OS rail only, and Kertel is not on it.",
    );
  }
  return ok(futuresVenue(futures));
}
