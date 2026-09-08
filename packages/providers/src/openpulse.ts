/**
 * OpenPulse, tier 2. The half of a thesis that is not a price.
 *
 * Every other paid source Telt buys answers "what is it worth". None of them
 * answer "what is happening to it", and a trader who only ever reads price is
 * reading the one number that has already moved. These three endpoints are the
 * other half:
 *
 * - **Sentiment** — what is being said, aggregated. Cheap, and the fastest
 *   signal that something has changed about a token that the price has not
 *   caught up with yet.
 * - **Safety** — honeypot, mint authority, ownership. This one is not an edge,
 *   it is a floor: it exists to stop a trade rather than to justify one, which
 *   is why it is bought before conviction rather than after.
 * - **OHLCV** — the candles, so a technical read is measured rather than
 *   imagined. Telt does not draw trend lines; it reports range and where the
 *   current price sits in it, which is the part a model can actually reason
 *   over without inventing a pattern.
 *
 * Verified live on 2026-09-08. The catalogue at
 * `https://safety.openpulsechain.com/.well-known/x402` advertises 28 endpoints,
 * settling in USDC on Base through Coinbase's own CDP facilitator — the same
 * rail Telt already pays CoinGecko on — and every path below answered 402 with
 * a v2 challenge in the `payment-required` header, which is exactly the dialect
 * Telt's buyer speaks. No protocol work was needed, which is the only reason
 * this could be added safely in a day.
 *
 * **The shapes below are held loosely on purpose.** These endpoints were
 * confirmed to exist and to charge; their success payloads had not been paid
 * for when this was written. So every field is read defensively and anything
 * unrecognised returns null rather than a guess. The worst case is a wasted
 * cent and a receipt that says the source was unreadable — never a number
 * invented from a field that happened to parse. When the first paid call lands,
 * check it against this and tighten it to the shape that actually arrived.
 */

import { ok, refuse } from "@telt/core/domain";
import type { Refusal, Result } from "@telt/core/domain";
import type { PaidRequest } from "@telt/x402";

import type { AdapterContext, Normalized, ProviderAdapter } from "./types.js";
import { positiveDecimalFromJson } from "./decimal.js";

const BASE = "https://safety.openpulsechain.com";

/** Read a number from any of several plausible names, or null. */
function numberFrom(source: unknown, names: readonly string[]): number | null {
  if (typeof source !== "object" || source === null) return null;
  const record = source as Record<string, unknown>;
  for (const name of names) {
    const value = record[name];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && /^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  }
  return null;
}

function stringFrom(source: unknown, names: readonly string[]): string | null {
  if (typeof source !== "object" || source === null) return null;
  const record = source as Record<string, unknown>;
  for (const name of names) {
    const value = record[name];
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  return null;
}

/** The payload, whether it arrives bare or wrapped in `data`/`result`. */
function unwrap(body: unknown): Record<string, unknown> | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const record = body as Record<string, unknown>;
  for (const key of ["data", "result", "payload"]) {
    const inner = record[key];
    if (typeof inner === "object" && inner !== null && !Array.isArray(inner)) {
      return inner as Record<string, unknown>;
    }
  }
  return record;
}

/**
 * What is being said about a token.
 *
 * Asked by ticker, which is what this endpoint takes, and which is safe here in
 * a way it is not for a price: a sentiment reading attached to the wrong asset
 * of the same name is misleading, but it cannot size an order. The receipt names
 * the ticker asked for so a reader can judge that themselves.
 */
export const openpulseSentimentAdapter: ProviderAdapter = {
  provider: "openpulse",
  stepId: "openpulse.sentiment",
  capability: "market.sentiment",
  endpointId: "openpulse:sentiment",
  paid: true,

  buildRequest(context: AdapterContext): Result<PaidRequest, Refusal> {
    const ticker = context.instrument.baseAsset;
    if (ticker === "") {
      return refuse(
        "PROVIDER_UNAVAILABLE",
        `Telt has no base asset for ${context.instrument.symbol}, so it cannot ask about sentiment.`,
        { provider: "openpulse", symbol: context.instrument.symbol },
      );
    }
    return ok({
      providerId: "openpulse",
      endpointId: "openpulse:sentiment",
      url: `${BASE}/api/v1/sentiment/${encodeURIComponent(ticker)}`,
      method: "GET",
    });
  },

  normalize(body: unknown, context: AdapterContext): Normalized | null {
    const data = unwrap(body);
    if (data === null) return null;

    // A score under any of the names this kind of API tends to use. Without one
    // there is nothing here worth reporting, and a receipt saying "unreadable"
    // is more useful than a mood invented from a stray field.
    const score = numberFrom(data, ["score", "sentiment", "sentimentScore", "value", "net"]);
    const label = stringFrom(data, ["label", "sentiment_label", "classification", "mood"]);
    if (score === null && label === null) return null;

    const normalized: Record<string, unknown> = { ticker: context.instrument.baseAsset };
    if (score !== null) normalized["sentimentScore"] = score;
    if (label !== null) normalized["sentimentLabel"] = label;

    const mentions = numberFrom(data, ["mentions", "count", "volume", "posts"]);
    if (mentions !== null) normalized["mentions"] = mentions;

    const window = stringFrom(data, ["window", "period", "timeframe"]);
    if (window !== null) normalized["window"] = window;

    return Object.freeze(normalized);
  },
};

/**
 * Whether the token is safe to touch at all.
 *
 * Bought before conviction rather than after, because it can only ever stop a
 * trade. A honeypot with excellent sentiment is still a honeypot, and finding
 * that out after paying for the expensive flow data is the wrong order.
 *
 * Asked by contract address, never by ticker: a safety verdict is a statement
 * about one specific contract, and attaching it to the wrong one is the single
 * most dangerous mistake this whole module could make.
 */
export const openpulseSafetyAdapter: ProviderAdapter = {
  provider: "openpulse",
  stepId: "openpulse.safety",
  capability: "onchain.safety",
  endpointId: "openpulse:token/safety",
  paid: true,

  buildRequest(context: AdapterContext): Result<PaidRequest, Refusal> {
    const address = context.instrument.nansenTokenAddresses[0];
    if (address === undefined) {
      return refuse(
        "PROVIDER_UNAVAILABLE",
        `No verified contract address for ${context.instrument.symbol}, so Telt will not ask for a safety verdict on a contract it cannot name.`,
        { provider: "openpulse", symbol: context.instrument.symbol },
      );
    }
    return ok({
      providerId: "openpulse",
      endpointId: "openpulse:token/safety",
      url: `${BASE}/api/v1/token/${address}/safety`,
      method: "GET",
    });
  },

  normalize(body: unknown, context: AdapterContext): Normalized | null {
    const data = unwrap(body);
    if (data === null) return null;

    const address = context.instrument.nansenTokenAddresses[0];
    if (address === undefined) return null;

    const score = numberFrom(data, ["score", "safetyScore", "riskScore", "rating"]);
    const verdict = stringFrom(data, ["verdict", "status", "risk", "label", "result"]);
    if (score === null && verdict === null) return null;

    const normalized: Record<string, unknown> = { contract: address };
    if (score !== null) normalized["safetyScore"] = score;
    if (verdict !== null) normalized["verdict"] = verdict;

    // Booleans only when actually boolean. A missing honeypot flag must not
    // read as "not a honeypot"; it reads as "not stated".
    for (const [key, names] of [
      ["honeypot", ["honeypot", "is_honeypot", "isHoneypot"]],
      ["mintable", ["mintable", "can_mint", "canMint"]],
      ["ownershipRenounced", ["renounced", "ownership_renounced", "ownershipRenounced"]],
    ] as const) {
      for (const name of names) {
        const value = (data as Record<string, unknown>)[name];
        if (typeof value === "boolean") {
          normalized[key] = value;
          break;
        }
      }
    }

    return Object.freeze(normalized);
  },
};

/**
 * The candles, so a technical read is measured rather than imagined.
 *
 * Telt deliberately does not compute an opinion here. It reports the high, the
 * low, the last, and where the last sits between them as a percentage — facts a
 * model can reason over. Anything more (a trend line, a pattern name, a
 * "breakout") would be Telt inventing a view and passing it off as data, which
 * is precisely what every other line of this codebase refuses to do.
 */
export const openpulseCandlesAdapter: ProviderAdapter = {
  provider: "openpulse",
  stepId: "openpulse.candles",
  capability: "market.technical",
  endpointId: "openpulse:token/ohlcv",
  paid: true,

  buildRequest(context: AdapterContext): Result<PaidRequest, Refusal> {
    const address = context.instrument.nansenTokenAddresses[0];
    if (address === undefined) {
      return refuse(
        "PROVIDER_UNAVAILABLE",
        `No verified contract address for ${context.instrument.symbol}, so Telt cannot ask for its candles.`,
        { provider: "openpulse", symbol: context.instrument.symbol },
      );
    }
    return ok({
      providerId: "openpulse",
      endpointId: "openpulse:token/ohlcv",
      url: `${BASE}/api/v1/token/${address}/ohlcv`,
      method: "GET",
    });
  },

  normalize(body: unknown): Normalized | null {
    const data = unwrap(body);
    if (data === null) return null;

    // Either a bare array of candles or an object holding one.
    const candles = Array.isArray(body)
      ? body
      : Array.isArray(data["candles"])
        ? (data["candles"] as unknown[])
        : Array.isArray(data["ohlcv"])
          ? (data["ohlcv"] as unknown[])
          : null;

    if (candles === null || candles.length === 0) return null;

    let high: number | null = null;
    let low: number | null = null;
    let last: number | null = null;

    for (const candle of candles) {
      // Both shapes seen in the wild: an object, or [t, o, h, l, c, v].
      const h = Array.isArray(candle)
        ? typeof candle[2] === "number"
          ? candle[2]
          : null
        : numberFrom(candle, ["high", "h"]);
      const l = Array.isArray(candle)
        ? typeof candle[3] === "number"
          ? candle[3]
          : null
        : numberFrom(candle, ["low", "l"]);
      const c = Array.isArray(candle)
        ? typeof candle[4] === "number"
          ? candle[4]
          : null
        : numberFrom(candle, ["close", "c"]);

      if (h !== null && (high === null || h > high)) high = h;
      if (l !== null && (low === null || l < low)) low = l;
      if (c !== null) last = c;
    }

    if (high === null || low === null || last === null || !(high > 0) || !(low > 0)) {
      return null;
    }

    const normalized: Record<string, unknown> = {
      candles: candles.length,
      high: String(high),
      low: String(low),
      last: String(last),
    };

    // Where the last price sits in the range, 0 at the low and 10000 at the
    // high. A single honest number instead of a narrative.
    if (high > low) {
      normalized["positionInRangeBps"] = Math.round(((last - low) / (high - low)) * 10_000);
    }

    const price = positiveDecimalFromJson(String(last));
    if (price !== null) normalized["lastParsed"] = String(last);

    return Object.freeze(normalized);
  },
};
