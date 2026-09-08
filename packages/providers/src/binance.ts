/**
 * The venue read. Free, first, and the price an order is actually sized from.
 *
 * This is tier 0 of the research ladder and the only adapter that never touches
 * the payment client. It is also the one whose failure ends a run immediately:
 * if Telt cannot read the book on the exchange it would trade on, no amount
 * of bought evidence makes a trade possible, so the planner refuses before
 * spending a cent.
 *
 * `/api/v3/ticker/24hr` is used rather than `/ticker/price` because it returns
 * the last price, the top of book and the 24 hour move in one request at the
 * same rate-limit weight. Bid and ask matter: a market buy fills at the ask,
 * and sizing from the last trade instead is how an estimate quietly
 * under-states what an order costs.
 *
 * Response shape verified against the live endpoint on 2026-09-07. Every price
 * field arrives as a string — `"2505.66000000"` — which is the venue stating
 * its own precision, so the strings are carried through untouched rather than
 * round-tripped through a double.
 *
 * One assumption is worth saying out loud: this is a USDT pair, and the
 * normalised field is `priceUsd`. Telt treats one USDT as one dollar, exactly
 * as CoinGecko and CoinMarketCap do when they quote a USD price for an asset
 * that mostly trades against USDT. If USDT ever moved far off its peg, the
 * venue price and the two aggregator prices would diverge, the planner's 100 bps
 * agreement test would fail, and Telt would refuse to propose a trade. That is
 * the correct behaviour, and it falls out of the design rather than needing a
 * depeg check of its own.
 */

import { ok } from "@telt/core/domain";
import type { Refusal, Result } from "@telt/core/domain";
import type { PaidRequest } from "@telt/x402";

import type { AdapterContext, Normalized, ProviderAdapter } from "./types.js";
import { decimalFromJson, positiveDecimalFromJson } from "./decimal.js";

export const BINANCE_HOST = "api.binance.com";
const TICKER_24HR = `https://${BINANCE_HOST}/api/v3/ticker/24hr`;

/** Binance market data is quick or it is broken; a long wait helps nobody. */
const TIMEOUT_MS = 8_000;

type Ticker24hr = {
  readonly symbol?: unknown;
  readonly lastPrice?: unknown;
  readonly bidPrice?: unknown;
  readonly askPrice?: unknown;
  readonly priceChangePercent?: unknown;
  readonly quoteVolume?: unknown;
  readonly closeTime?: unknown;
};

export const binancePriceAdapter: ProviderAdapter = {
  provider: "binance",
  stepId: "binance.price",
  capability: "market.price",
  endpointId: "binance:ticker",
  paid: false,

  buildRequest(context: AdapterContext): Result<PaidRequest, Refusal> {
    const url = new URL(TICKER_24HR);
    url.searchParams.set("symbol", context.instrument.symbol);
    return ok({
      providerId: "binance",
      endpointId: "binance:ticker",
      url: url.toString(),
      method: "GET",
      timeoutMs: TIMEOUT_MS,
    });
  },

  normalize(body: unknown, context: AdapterContext): Normalized | null {
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return null;
    }
    const ticker = body as Ticker24hr;

    // The venue echoes the symbol back. If it is not the one that was asked
    // for, something upstream rewrote the request and no field below is
    // trustworthy.
    if (ticker.symbol !== context.instrument.symbol) {
      return null;
    }

    const price = positiveDecimalFromJson(ticker.lastPrice);
    const bid = positiveDecimalFromJson(ticker.bidPrice);
    const ask = positiveDecimalFromJson(ticker.askPrice);
    if (price === null || bid === null || ask === null) {
      return null;
    }

    const normalized: Record<string, unknown> = {
      priceUsd: price,
      bidUsd: bid,
      askUsd: ask,
      venue: "binance",
      pair: context.instrument.symbol,
    };

    // Context, not evidence. Missing fields are dropped rather than defaulted,
    // so a receipt never shows a zero that was really an absence.
    const change = decimalFromJson(ticker.priceChangePercent);
    if (change !== null) {
      normalized["change24hPct"] = change;
    }
    const volume = decimalFromJson(ticker.quoteVolume);
    if (volume !== null) {
      normalized["quoteVolume24hUsd"] = volume;
    }
    if (typeof ticker.closeTime === "number" && Number.isFinite(ticker.closeTime)) {
      normalized["venueTimeMs"] = ticker.closeTime;
    }

    return Object.freeze(normalized);
  },
};
